#!/usr/bin/env node
/**
 * 赚取Token计划 - 影子请求代理
 *
 * 客户端(Hermes/VS Code Copilot/opencode 等)把 baseURL 指向本服务:
 *   http://127.0.0.1:8788/v1
 *
 * 行为:
 *   1. 正常转发: 所有请求透传到 new-api (默认 http://127.0.0.1:3001)，体验完全不变
 *   2. 影子请求: 当「赚取Token计划」开关开启时，每次 /v1/responses 或
 *      /v1/chat/completions 请求都会把相同的对话内容复制一份发给 New API 的
 *      sensenova-6.8-flash-lite 模型（商汤 Key 在 New API 渠道中统一管理），
 *      响应直接丢弃（不采纳、不影响主流程），仅用于产生调用量。
 *
 * 控制界面: http://127.0.0.1:8788/  (开关 + 统计 + 日志)
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function pickTransport(urlStr) {
  const u = new URL(urlStr);
  return u.protocol === 'https:' ? https : http;
}

// ---------------- 配置 ----------------
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
let config = {
  listen_port: parseInt(process.env.LISTEN_PORT || '8788', 10),
  upstream_base: process.env.UPSTREAM_BASE || 'http://127.0.0.1:3001', // new-api 地址
  plan_enabled: process.env.PLAN_ENABLED === 'true',                   // 赚取Token计划开关
  shadow_via: 'new-api',                     // 影子请求走 new-api，不在代理保存商汤 Key
  sensenova_model: process.env.SENSENOVA_MODEL || 'sensenova-6.8-flash-lite',  // 影子模型
  shadow_max_tokens: parseInt(process.env.SHADOW_MAX_TOKENS || '1024', 10),
  shadow_timeout_ms: parseInt(process.env.SHADOW_TIMEOUT_MS || '30000', 10),
};

// 统计信息
const stats = {
  total_shadow: 0,       // 影子请求总数
  success_shadow: 0,     // 成功的影子请求
  fail_shadow: 0,        // 失败的影子请求
  last_time: 0,          // 最近一次影子请求时间
  last_model: '',        // 最近一次影子请求模型
  last_status: '',       // 最近一次影子请求结果
  daily: {},             // 按日期统计 {"2026-09-24": {total, success, fail}}
  logs: [],              // 最近日志
};
const MAX_LOGS = 100;

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      config = { ...config, ...saved };
      console.log('[config] 已加载:', CONFIG_PATH);
    }
  } catch (e) {
    console.error('[config] 加载失败, 使用默认配置:', e.message);
  }
  // 环境变量优先级最高（容器场景）
  if (process.env.LISTEN_PORT) config.listen_port = parseInt(process.env.LISTEN_PORT, 10);
  if (process.env.UPSTREAM_BASE) config.upstream_base = process.env.UPSTREAM_BASE;
  if (process.env.PLAN_ENABLED) config.plan_enabled = process.env.PLAN_ENABLED === 'true';
  if (process.env.SENSENOVA_MODEL) config.sensenova_model = process.env.SENSENOVA_MODEL;
  if (process.env.SHADOW_MAX_TOKENS) config.shadow_max_tokens = parseInt(process.env.SHADOW_MAX_TOKENS, 10);
}
function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) {
    console.error('[config] 保存失败:', e.message);
  }
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayStat() {
  const t = todayStr();
  if (!stats.daily[t]) stats.daily[t] = { total: 0, success: 0, fail: 0 };
  return stats.daily[t];
}
function addLog(type, msg) {
  const entry = { t: new Date().toISOString(), type, msg };
  stats.logs.unshift(entry);
  if (stats.logs.length > MAX_LOGS) stats.logs.length = MAX_LOGS;
  console.log(`[${entry.t}] [${type}] ${msg}`);
}

function maskKey(k) {
  if (!k || k.length < 12) return k || '';
  return k.slice(0, 8) + '...' + k.slice(-4);
}

function normalizeShadowRole(role) {
  if (role === 'developer') return 'system';
  if (role === 'system' || role === 'user' || role === 'assistant') return role;
  return 'user';
}

function normalizeShadowMessages(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.messages) && data.messages.length > 0) {
    return data.messages.map(item => {
      if (item && typeof item === 'object') return { ...item, role: normalizeShadowRole(item.role) };
      return item;
    });
  }

  const input = data.input;
  if (typeof input === 'string') {
    return input.trim() ? [{ role: 'user', content: input }] : [];
  }
  if (!Array.isArray(input)) return [];

  const messages = [];
  for (const item of input) {
    if (typeof item === 'string') {
      if (item.trim()) messages.push({ role: 'user', content: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue;

    const role = normalizeShadowRole(item.role || 'user');
    let content = '';
    if (typeof item.content === 'string') {
      content = item.content;
    } else if (Array.isArray(item.content)) {
      content = item.content
        .map(part => {
          if (typeof part === 'string') return part;
          if (part && typeof part.text === 'string') return part.text;
          if (part && typeof part.content === 'string') return part.content;
          return '';
        })
        .filter(Boolean)
        .join('\n');
    } else if (typeof item.text === 'string') {
      content = item.text;
    }
    if (content.trim()) messages.push({ role, content });
  }
  return messages;
}

// ---------------- 影子请求 ----------------
function sendShadowRequest(messages, modelHint, authHeader) {
  if (!config.plan_enabled) return;
  const key = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!key) {
    addLog('WARN', '赚取Token计划已开启但请求未携带 Authorization，影子请求跳过');
    return;
  }

  const payload = JSON.stringify({
    model: config.sensenova_model,
    messages: messages,
    max_tokens: config.shadow_max_tokens,
    stream: false,
  });

  const url = new URL(config.upstream_base + '/v1/chat/completions');
  const transport = pickTransport(url.toString());
  const req = transport.request({
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
      'Content-Length': Buffer.byteLength(payload),
    },
    timeout: config.shadow_timeout_ms,
  }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      const t = todayStat();
      t.total++; stats.total_shadow++;
      stats.last_time = Date.now();
      stats.last_model = config.sensenova_model;
      if (res.statusCode >= 200 && res.statusCode < 300) {
        t.success++; stats.success_shadow++;
        stats.last_status = 'OK';
        let usage = '';
        try { usage = JSON.parse(body).usage; } catch (e) {}
        addLog('SHADOW', `✓ 影子请求成功(${res.statusCode}) via new-api key=${maskKey(key)} 模型=${config.sensenova_model} 用量=${usage ? JSON.stringify(usage) : 'n/a'}`);
      } else {
        t.fail++; stats.fail_shadow++;
        stats.last_status = 'HTTP ' + res.statusCode;
        addLog('SHADOW', `✗ 影子请求失败(${res.statusCode}) via new-api key=${maskKey(key)} ${body.slice(0, 200)}`);
      }
    });
  });
  req.on('timeout', () => {
    req.destroy(new Error('shadow timeout'));
  });
  req.on('error', (err) => {
    const t = todayStat();
    t.total++; t.fail++; stats.total_shadow++; stats.fail_shadow++;
    stats.last_time = Date.now();
    stats.last_model = config.sensenova_model;
    stats.last_status = 'ERR';
    addLog('SHADOW', `✗ 影子请求异常 via new-api key=${maskKey(key)} ${err.message}`);
  });
  req.write(payload);
  req.end();
}

// ---------------- 上游转发 ----------------
function forwardRequest(req, res, body) {
  const target = new URL(config.upstream_base + req.url);
  const headers = { ...req.headers, host: target.host, 'content-length': Buffer.byteLength(body || '') };
  const transport = pickTransport(target.toString());
  const upstreamReq = transport.request({
    hostname: target.hostname,
    port: target.port || 80,
    path: target.pathname + target.search,
    method: req.method,
    headers,
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstreamReq.on('error', (err) => {
    try {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream error: ' + err.message, type: 'proxy_error' } }));
    } catch (e) {}
    addLog('ERR', `上游转发失败: ${err.message}`);
  });
  upstreamReq.write(body || '');
  upstreamReq.end();
}

// ---------------- HTTP 服务 ----------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // 控制界面
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = path.join(__dirname, 'public', 'index.html');
    fs.readFile(html, (err, data) => {
      if (err) { res.writeHead(500); res.end('index.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // API: 状态
  if (req.method === 'GET' && url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      plan_enabled: config.plan_enabled,
      model: config.sensenova_model,
      shadow_via: config.shadow_via || 'new-api',
      shadow_target: config.upstream_base + '/v1/chat/completions',
      upstream_base: config.upstream_base,
      stats,
      today: todayStat(),
    }));
    return;
  }

  // API: 开关
  if (req.method === 'POST' && url.pathname === '/api/plan') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (typeof data.enabled === 'boolean') {
          config.plan_enabled = data.enabled;
          saveConfig();
          addLog('PLAN', `赚取Token计划已${data.enabled ? '开启' : '关闭'}`);
        }
        if (data.model) {
          config.sensenova_model = data.model;
          saveConfig();
          addLog('PLAN', `影子模型改为: ${data.model}`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, config: { plan_enabled: config.plan_enabled, model: config.sensenova_model } }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
    });
    return;
  }

  // API: 日志/统计清零
  if (req.method === 'POST' && url.pathname === '/api/reset') {
    stats.total_shadow = 0; stats.success_shadow = 0; stats.fail_shadow = 0;
    stats.last_time = 0; stats.last_model = ''; stats.last_status = '';
    stats.daily = {}; stats.logs = [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // 其余: 透传 API（/v1/... 等）
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    // chat/completions 与 responses 都会触发影子请求（不等待，不影响主流程）
    if (config.plan_enabled && req.method === 'POST' && (/\/v1\/chat\/completions$/.test(url.pathname) || /\/v1\/responses$/.test(url.pathname))) {
      try {
        const data = JSON.parse(body || '{}');
        const messages = normalizeShadowMessages(data);
        if (messages.length > 0) sendShadowRequest(messages, data.model, req.headers.authorization || '');
      } catch (e) {
        addLog('WARN', '无法解析请求体，跳过影子请求: ' + e.message);
      }
    }
    forwardRequest(req, res, body);
  });
});

loadConfig();
server.listen(config.listen_port, () => {
  console.log('==============================================');
  console.log('  赚取Token计划 - 影子请求代理 已启动');
  console.log(`  控制界面: http://127.0.0.1:${config.listen_port}/`);
  console.log(`  客户端接入: http://127.0.0.1:${config.listen_port}/v1`);
  console.log(`  上游: ${config.upstream_base}`);
  console.log(`  计划开关: ${config.plan_enabled ? 'ON ✔ 影子请求已启用' : 'OFF'}`);
  console.log(`  影子请求: 通过 ${config.upstream_base} 调用 ${config.sensenova_model}`);
  console.log('==============================================');
});
