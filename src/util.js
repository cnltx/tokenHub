'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

class HttpError extends Error {
  constructor(status, message, code = 'request_error', headers = {}) {
    super(message); this.status = status; this.code = code; this.headers = headers;
  }
}
const id = (prefix) => `${prefix}_${crypto.randomBytes(10).toString('hex')}`;
const mask = (value) => value ? `••••${String(value).slice(-4)}` : '';
function equal(a, b) {
  const aa = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback);
    throw new Error(`无法读取 ${path.basename(file)}：${error instanceof SyntaxError?'JSON 格式无效，请检查或从备份恢复':'请检查文件读取权限'}`);
  }
}
function atomicJson(file, value, backup = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    if (backup && fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
async function jsonBody(req, max = 4 * 1024 * 1024) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > max) throw new HttpError(413, '请求体超过限制', 'body_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new HttpError(400, '请求体必须是有效 JSON', 'invalid_json'); }
}
function json(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
function sseHeaders(res) {
  if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.flushHeaders();
}
function event(res, type, data) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}
// An SSE record can span UTF-8 buffers, CRLF pairs, and multiple data lines.
class SSEParser {
  constructor(callback) { this.callback = callback; this.decoder = new StringDecoder('utf8'); this.buffer = ''; }
  push(chunk) { this.buffer += this.decoder.write(chunk); this.drain(false); }
  end() { this.buffer += this.decoder.end(); this.drain(true); }
  drain(final) {
    let match;
    while ((match = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer))) {
      const record = this.buffer.slice(0, match.index); this.buffer = this.buffer.slice(match.index + match[0].length); this.record(record);
    }
    if (this.buffer.length > 2 * 1024 * 1024) throw new HttpError(502, '上游流事件超过 2MB', 'upstream_event_too_large');
    if (final && this.buffer.trim()) { this.record(this.buffer); this.buffer = ''; }
  }
  record(record) {
    let type = 'message'; const data = [];
    for (const line of record.split(/\r\n|\n|\r/)) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return;
    const value = data.join('\n');
    if (value === '[DONE]') return this.callback({ type: 'done', data: null });
    try { const parsed = JSON.parse(value); this.callback({ type: parsed.type || type, data: parsed }); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
}
function number(value, fallback, min, max) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `数值必须在 ${min}–${max} 之间`, 'invalid_config');
  return Math.floor(n);
}
function list(value) {
  if (typeof value === 'string') return [...new Set(value.split(/[\n,，]/).map(x => x.trim()).filter(Boolean))];
  return [...new Set((Array.isArray(value) ? value : []).map(String).map(x => x.trim()).filter(Boolean))];
}
function abortError(signal) { return signal?.reason instanceof Error ? signal.reason : new HttpError(499, '请求已取消', 'cancelled'); }
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const stop = () => { clearTimeout(timer); reject(abortError(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}
module.exports = { HttpError, id, mask, equal, readJson, atomicJson, jsonBody, json, sseHeaders, event, SSEParser, number, list, abortError, sleep };
