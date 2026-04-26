import { sanitizeText } from './src/sanitize.js';

console.log(sanitizeText('cd D:\\projects\\github\\WindsurfAPI && ls -la'));
console.log(sanitizeText('cd /D:/projects/github/WindsurfAPI && ls -la'));
