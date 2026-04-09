/**
 * POST /v1/chat/completions — OpenAI-compatible chat completions.
 * Routes to RawGetChatMessage (legacy) or Cascade (premium) based on model type.
 */

import { randomUUID } from 'crypto';
import { WindsurfClient } from '../client.js';
import { getApiKey, reportError, reportSuccess } from '../auth.js';
import { resolveModel, getModelInfo } from '../models.js';
import { getLsPort, getCsrfToken } from '../langserver.js';
import { config, log } from '../config.js';
import { recordRequest } from '../dashboard/stats.js';

function genId() {
  return 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 29);
}

export async function handleChatCompletions(body) {
  const {
    model: reqModel,
    messages,
    stream = false,
    max_tokens,
    tools,
    tool_choice,
  } = body;

  const modelKey = resolveModel(reqModel || config.defaultModel);
  const modelInfo = getModelInfo(modelKey);
  const displayModel = modelInfo?.name || reqModel || config.defaultModel;
  const modelEnum = modelInfo?.enumValue || 0;
  const modelUid = modelInfo?.modelUid || null;
  // Cascade flow disabled — crashes language server with "untrusted workspace".
  // All models use RawGetChatMessage; unavailable models return proper errors.
  const useCascade = false;

  // Get API key from pool
  const acct = getApiKey();
  if (!acct) {
    return { status: 503, body: { error: { message: 'No active accounts available', type: 'pool_exhausted' } } };
  }

  log.info(`Chat: model=${displayModel} enum=${modelEnum} uid=${modelUid || 'none'} flow=${useCascade ? 'cascade' : 'legacy'} stream=${stream}`);

  const port = getLsPort();
  const csrf = getCsrfToken();
  const client = new WindsurfClient(acct.apiKey, port, csrf);
  const chatId = genId();
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    return streamResponse(client, chatId, created, displayModel, messages, modelEnum, modelUid, useCascade, acct.apiKey);
  }
  return nonStreamResponse(client, chatId, created, displayModel, messages, modelEnum, modelUid, useCascade, acct.apiKey);
}

async function nonStreamResponse(client, id, created, model, messages, modelEnum, modelUid, useCascade, apiKey) {
  const startTime = Date.now();
  try {
    let allText = '';
    let allThinking = '';

    if (useCascade) {
      try {
        const chunks = await client.cascadeChat(messages, modelEnum, modelUid);
        for (const c of chunks) {
          if (c.text) allText += c.text;
          if (c.thinking) allThinking += c.thinking;
        }
      } catch (cascadeErr) {
        // Fallback: try RawGetChatMessage with enum value
        log.warn(`Cascade failed (${cascadeErr.message}), falling back to RawGetChatMessage`);
        const chunks = await client.rawGetChatMessage(messages, modelEnum, modelUid);
        for (const c of chunks) {
          if (c.text) allText += c.text;
        }
      }
    } else {
      const chunks = await client.rawGetChatMessage(messages, modelEnum, modelUid);
      for (const c of chunks) {
        if (c.text) allText += c.text;
      }
    }

    reportSuccess(apiKey);
    recordRequest(model, true, Date.now() - startTime, apiKey);

    const message = { role: 'assistant', content: allText || null };
    if (allThinking) message.reasoning_content = allThinking;

    return {
      status: 200,
      body: {
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
    };
  } catch (err) {
    // Don't count connection/protocol errors against the account
    const isTransient = /ECONNREFUSED|ECONNRESET|EPIPE|invalid_argument|unmarshal|wire-format/.test(err.message);
    if (!err.isModelError && !isTransient) reportError(apiKey);
    recordRequest(model, false, Date.now() - startTime, apiKey);
    log.error('Chat error:', err.message);
    return {
      status: err.isModelError ? 403 : 502,
      body: { error: { message: err.message, type: err.isModelError ? 'model_not_available' : 'upstream_error' } },
    };
  }
}

function streamResponse(client, id, created, model, messages, modelEnum, modelUid, useCascade, apiKey) {
  return {
    status: 200,
    stream: true,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
    async handler(res) {
      const send = (data) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      // Initial chunk with role
      send({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      });

      let hadSuccess = false;

      const onChunk = (chunk) => {
        hadSuccess = true;
        if (chunk.text) {
          send({
            id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }],
          });
        }
        if (chunk.thinking) {
          send({
            id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { reasoning_content: chunk.thinking }, finish_reason: null }],
          });
        }
      };

      const finish = () => {
        if (hadSuccess) reportSuccess(apiKey);
        send({
          id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
        if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
      };

      const onError = (err) => {
        const isTransient = /ECONNREFUSED|ECONNRESET|EPIPE|invalid_argument|unmarshal|wire-format/.test(err.message);
        if (!err.isModelError && !isTransient) reportError(apiKey);
        log.error('Stream error:', err.message);
        try {
          send({
            id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { content: `\n[Error: ${err.message}]` }, finish_reason: 'stop' }],
          });
          res.write('data: [DONE]\n\n');
        } catch {}
        if (!res.writableEnded) res.end();
      };

      try {
        if (useCascade) {
          try {
            await client.cascadeChat(messages, modelEnum, modelUid, { onChunk, onEnd: finish, onError });
          } catch (cascadeErr) {
            log.warn(`Cascade stream failed (${cascadeErr.message}), falling back to RawGetChatMessage`);
            hadSuccess = false;
            await client.rawGetChatMessage(messages, modelEnum, modelUid, { onChunk, onEnd: finish, onError });
          }
        } else {
          await client.rawGetChatMessage(messages, modelEnum, modelUid, { onChunk, onEnd: finish, onError });
        }
      } catch (err) {
        onError(err);
      }
    },
  };
}
