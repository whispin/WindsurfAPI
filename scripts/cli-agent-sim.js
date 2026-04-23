#!/usr/bin/env node
/**
 * CLI Agent Simulator — mimics Claude Code behavior against WindsurfAPI.
 *
 * Sends multi-turn conversations with tool calls through the proxy,
 * verifying streaming, tool emulation, context retention, and response quality.
 * Generates structured JSONL logs for demonstration.
 *
 * Usage:
 *   node scripts/cli-agent-sim.js [--base-url http://localhost:3003] [--api-key sk-xxx] [--model claude-4.5-sonnet]
 */

import https from 'https';
import http from 'http';
import { writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, '..', 'logs', 'agent-sim');
mkdirSync(LOG_DIR, { recursive: true });

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const BASE_URL = getArg('base-url', 'http://localhost:3003');
const API_KEY = getArg('api-key', 'sk-test-local-dev');
const MODEL = getArg('model', 'gpt-4o-mini');
const LOG_FILE = join(LOG_DIR, `sim-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

function logEntry(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  appendFileSync(LOG_FILE, line + '\n');
  const icon = entry.type === 'error' ? '✗' : entry.type === 'response' ? '✓' : '→';
  console.log(`  ${icon} [${entry.type}] ${entry.summary || ''}`);
}

async function chatCompletion(messages, opts = {}) {
  const body = {
    model: MODEL,
    messages,
    stream: opts.stream ?? true,
    ...(opts.tools ? { tools: opts.tools } : {}),
  };

  const url = new URL('/v1/chat/completions', BASE_URL);
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
    }, (res) => {
      if (!opts.stream) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            resolve({ status: res.statusCode, data, headers: res.headers });
          } catch (e) { reject(e); }
        });
        return;
      }

      let text = '';
      let thinking = '';
      let toolCalls = [];
      let usage = null;
      let finishReason = null;
      let lineBuf = '';

      function processLine(line) {
        if (!line.startsWith('data: ')) return;
        const payload = line.slice(6);
        if (payload === '[DONE]') return;
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) text += delta.content;
          if (delta?.reasoning_content) thinking += delta.reasoning_content;
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!toolCalls[tc.index]) toolCalls[tc.index] = { id: '', name: '', arguments: '' };
              if (tc.id) toolCalls[tc.index].id = tc.id;
              if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
              if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments;
            }
          }
          if (parsed.choices?.[0]?.finish_reason) finishReason = parsed.choices[0].finish_reason;
          if (parsed.usage) usage = parsed.usage;
        } catch {}
      }

      res.on('data', (chunk) => {
        lineBuf += chunk.toString();
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) processLine(trimmed);
        }
      });

      res.on('end', () => {
        for (const line of lineBuf.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) processLine(trimmed);
        }
        resolve({
          status: res.statusCode,
          text,
          thinking: thinking || null,
          toolCalls: toolCalls.filter(Boolean),
          finishReason,
          usage,
          headers: res.headers,
        });
      });

      res.on('error', (e) => {
        reject(Object.assign(e, { _source: 'res.error' }));
      });
    });
    req.on('error', (e) => {
      reject(Object.assign(e, { _source: 'req.error' }));
    });
    req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Test Scenarios ──────────────────────────────────

async function testBasicChat() {
  logEntry({ type: 'test', summary: 'Basic chat — single turn' });
  const start = Date.now();
  const resp = await chatCompletion([
    { role: 'user', content: 'Reply with exactly: "Hello from WindsurfAPI". Nothing else.' },
  ], { stream: false });
  const elapsed = Date.now() - start;
  const text = resp.data?.choices?.[0]?.message?.content || resp.text || '';
  logEntry({
    type: 'response', summary: `${text.slice(0, 80)} (${elapsed}ms)`,
    model: MODEL, elapsed, textLen: text.length,
    usage: resp.data?.usage || resp.usage,
  });
  return { ...resp, text };
}

async function testMultiTurn() {
  logEntry({ type: 'test', summary: 'Multi-turn context retention' });

  const messages = [
    { role: 'user', content: 'My name is TestUser42. Remember this.' },
  ];

  const r1 = await chatCompletion(messages, { stream: false });
  const r1text = r1.data?.choices?.[0]?.message?.content || '';
  logEntry({ type: 'response', summary: `Turn 1: ${r1text.slice(0, 60)}` });

  messages.push({ role: 'assistant', content: r1text });
  messages.push({ role: 'user', content: 'What is my name? Reply with just the name.' });

  const r2 = await chatCompletion(messages, { stream: false });
  const r2text = r2.data?.choices?.[0]?.message?.content || '';
  const remembered = r2text.includes('TestUser42');
  logEntry({
    type: 'response',
    summary: `Turn 2: ${r2text.slice(0, 60)} — context ${remembered ? 'RETAINED' : 'LOST'}`,
    contextRetained: remembered,
  });
  return remembered;
}

async function testToolCalls() {
  logEntry({ type: 'test', summary: 'Tool call emulation' });

  const tools = [{
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file at the given path',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read' },
        },
        required: ['path'],
      },
    },
  }];

  const resp = await chatCompletion([
    { role: 'user', content: 'Read the file at ./package.json using the read_file tool.' },
  ], { tools, stream: false });

  const msg = resp.data?.choices?.[0]?.message;
  const tcs = msg?.tool_calls || [];
  const hasToolCall = tcs.length > 0 || resp.data?.choices?.[0]?.finish_reason === 'tool_calls';
  logEntry({
    type: 'response',
    summary: `Tool calls: ${tcs.length}, finish=${resp.data?.choices?.[0]?.finish_reason}`,
    toolCalls: tcs.map(tc => ({ name: tc.function?.name, args: tc.function?.arguments?.slice(0, 100) })),
    hasToolCall,
  });
  return hasToolCall;
}

async function testNonStream() {
  logEntry({ type: 'test', summary: 'Non-streaming response' });
  const start = Date.now();
  const resp = await chatCompletion([
    { role: 'user', content: 'Say "non-stream OK" in 3 words or less.' },
  ], { stream: false });
  const elapsed = Date.now() - start;
  const text = resp.data?.choices?.[0]?.message?.content || '';
  logEntry({
    type: 'response', summary: `${text.slice(0, 60)} (${elapsed}ms)`,
    elapsed, status: resp.status,
  });
  return resp.status === 200;
}

async function testAnthropicProtocol() {
  logEntry({ type: 'test', summary: 'Anthropic /v1/messages protocol' });

  const url = new URL('/v1/messages', BASE_URL);
  const mod = url.protocol === 'https:' ? https : http;

  const body = {
    model: MODEL,
    max_tokens: 100,
    messages: [{ role: 'user', content: 'Say "anthropic OK".' }],
  };

  return new Promise((resolve) => {
    const req = mod.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          const text = data.content?.[0]?.text || data.error?.message || '';
          logEntry({
            type: 'response',
            summary: `Anthropic: ${text.slice(0, 60)} (status=${res.statusCode})`,
            status: res.statusCode,
          });
          resolve(res.statusCode === 200);
        } catch (e) {
          logEntry({ type: 'error', summary: `Anthropic parse error: ${e.message}` });
          resolve(false);
        }
      });
    });
    req.on('error', (e) => {
      logEntry({ type: 'error', summary: `Anthropic: ${e.message}` });
      resolve(false);
    });
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function testProjectWriting() {
  logEntry({ type: 'test', summary: 'Project writing simulation — ask model to write a Python script' });

  const resp = await chatCompletion([
    { role: 'system', content: 'You are a senior Python developer. Write clean, production-ready code.' },
    { role: 'user', content: 'Write a Python function called `fibonacci(n)` that returns the nth Fibonacci number using memoization. Include type hints and a docstring. Output ONLY the code, no explanation.' },
  ], { stream: false });

  const text = resp.data?.choices?.[0]?.message?.content || '';
  const hasPython = text.includes('def fibonacci') || text.includes('fibonacci');
  logEntry({
    type: 'response',
    summary: `Code gen: ${text.length} chars, has_fibonacci=${hasPython}`,
    textLen: text.length,
    hasPython,
    codePreview: text.slice(0, 200),
  });
  return hasPython;
}

// ── Main ──────────────────────────────────

async function main() {
  console.log(`\n  WindsurfAPI CLI Agent Simulator`);
  console.log(`  Base URL:  ${BASE_URL}`);
  console.log(`  Model:     ${MODEL}`);
  console.log(`  Log file:  ${LOG_FILE}\n`);

  // Preflight: check server health
  try {
    const healthResp = await new Promise((resolve, reject) => {
      const url = new URL('/health', BASE_URL);
      const mod = url.protocol === 'https:' ? https : http;
      mod.get(url, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
      }).on('error', reject);
    });
    console.log(`  Server: v${healthResp.version} accounts=${healthResp.accounts?.active || 0}`);
    if (!healthResp.accounts?.active) {
      console.log('  ✗ No active accounts — add accounts first via /auth/login or /dashboard');
      process.exit(1);
    }
  } catch (e) {
    console.log(`  ✗ Cannot reach server: ${e.message}`);
    process.exit(1);
  }

  logEntry({ type: 'start', summary: `Simulation start — model=${MODEL} base=${BASE_URL}` });

  const results = {};
  const tests = [
    ['basic_chat', testBasicChat],
    ['multi_turn', testMultiTurn],
    ['tool_calls', testToolCalls],
    ['non_stream', testNonStream],
    ['anthropic', testAnthropicProtocol],
    ['project_writing', testProjectWriting],
  ];

  for (const [name, fn] of tests) {
    try {
      const result = await fn();
      results[name] = result ? 'PASS' : 'FAIL';
    } catch (err) {
      logEntry({ type: 'error', summary: `${name}: ${err.message}` });
      results[name] = 'ERROR';
    }
  }

  console.log('\n  ── Results ──');
  for (const [name, status] of Object.entries(results)) {
    const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '!';
    console.log(`  ${icon} ${name}: ${status}`);
  }

  logEntry({ type: 'end', summary: 'Simulation complete', results });
  console.log(`\n  Full log: ${LOG_FILE}\n`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
