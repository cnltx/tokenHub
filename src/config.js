'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { HttpError, id, mask, readJson, atomicJson, number, list } = require('./util');

const DEFAULT_SETTINGS = Object.freeze({ port: 3000, paused: false, max_attempts: 10, retry_interval_ms: 1000, request_timeout_ms: 120000, idle_timeout_ms: 30000, cooldown_ms: 10000, max_concurrency: 16, log_max_mb: 5, log_retention_days: 7, debug_max_tokens: 2048 });
function settings(input = {}) {
  const out = { ...DEFAULT_SETTINGS };
  for (const [field, min, max] of [['port',1,65535],['max_attempts',1,20],['retry_interval_ms',100,60000],['request_timeout_ms',1000,600000],['idle_timeout_ms',1000,120000],['cooldown_ms',1000,3600000],['max_concurrency',1,128],['log_max_mb',1,50],['log_retention_days',1,90],['debug_max_tokens',1,8192]]) out[field] = number(input[field], out[field], min, max);
  out.paused = input.paused === true;
  return out;
}
function requireName(value, label) {
  const result = String(value || '').trim();
  if (!result || result.length > 160) throw new HttpError(400, `${label}不能为空且最多 160 字符`, 'invalid_config');
  return result;
}
function baseUrl(value) {
  let u;
  try { u = new URL(value); } catch { throw new HttpError(400, 'Base URL 无效', 'invalid_config'); }
  if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new HttpError(400, 'Base URL 须为无凭据和查询参数的 HTTP(S) 地址', 'invalid_config');
  return u.href.replace(/\/+$/, '');
}
function credential(value, previous, prefix) {
  const supplied = typeof value === 'string' ? value.trim() : String(value.value ?? value.key ?? '').trim();
  const old = previous?.find(x => x.id === value.id);
  const actual = supplied || old?.value;
  if (!actual || actual.length > 4096 || /[\r\n]/.test(actual)) throw new HttpError(400, '密钥不能为空、超过 4096 字符或包含换行', 'invalid_config');
  // A changed secret gets a fresh reference, so the two-file commit never rebinds a live reference.
  return { id: old && actual === old.value ? old.id : id(prefix), value: actual, status: value.status === 'disabled' ? 'disabled' : 'enabled' };
}
function normalize(input, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '配置必须是对象', 'invalid_config');
  const config = { schema_version: 2, settings: settings(input.settings), channels: [], tokens: [], forwarding: null };
  for (const item of input.channels || []) {
    const old = previous.channels?.find(x => x.id === item.id);
    const mapping = item.model_mapping || {};
    if (typeof mapping !== 'object' || Array.isArray(mapping) || Object.entries(mapping).some(([k,v]) => !k || typeof v !== 'string' || !v)) throw new HttpError(400, '模型映射必须为 别名:上游模型 的对象', 'invalid_config');
    const keys = (item.keys || []).map(k => credential(k, old?.keys, 'key'));
    if (new Set(keys.map(k => k.value)).size !== keys.length) throw new HttpError(400, '同一渠道中存在重复 Key', 'duplicate_key');
    const protocols = list(item.protocols || ['chat','responses']);
    if (!protocols.length || protocols.some(x => !['chat','responses'].includes(x))) throw new HttpError(400, '至少启用一种接口协议', 'invalid_config');
    config.channels.push({ id: old?.id || id('ch'), name: requireName(item.name,'渠道名称'), base_url: baseUrl(item.base_url), status: item.status === 'disabled' ? 'disabled' : 'enabled', key_mode: item.key_mode === 'random' ? 'random' : 'polling', priority: number(item.priority,1,1,999), weight: number(item.weight,1,1,100), groups: list(item.groups?.length ? item.groups : ['default']), models: list(item.models), model_mapping: { ...mapping }, protocols, responses_mode: item.responses_mode === 'chat_bridge' ? 'chat_bridge' : 'native', keys });
  }
  for (const item of input.tokens || []) {
    const old = previous.tokens?.find(x => x.id === item.id);
    const cred = credential(item, old ? [old] : [], 'tok');
    config.tokens.push({ ...cred, name: requireName(item.name,'令牌名称'), group: requireName(item.group || 'default','分组'), models: list(item.models) });
  }
  if (new Set(config.tokens.map(t => t.value)).size !== config.tokens.length) throw new HttpError(400, '客户端令牌重复', 'duplicate_token');
  const rule=input.forwarding || {};
  const target=String(rule.target_model || '').trim();
  const available=new Set(config.channels.flatMap(ch=>[...ch.models,...Object.keys(ch.model_mapping)]));
  const sources=list(rule.source_models);
  if (rule.enabled===true && (!target || !available.has(target))) throw new HttpError(400,'请先选择渠道中已配置的转发目标模型','invalid_forwarding');
  if (sources.some(model=>!available.has(model))) throw new HttpError(400,'源模型须来自已配置模型目录','invalid_forwarding');
  config.forwarding={enabled:rule.enabled===true,target_model:target,source_models:sources,max_output_tokens:number(rule.max_output_tokens,2048,1,8192),max_concurrency:number(rule.max_concurrency,2,1,16)};
  for (const field of ['channels','tokens']) if (new Set(config[field].map(x => x.name)).size !== config[field].length) throw new HttpError(400, `${field} 名称重复`, 'invalid_config');
  return config;
}
function sanitized(config) {
  const out = structuredClone(config);
  for (const ch of out.channels) for (const key of ch.keys) { key.masked = mask(key.value); delete key.value; }
  for (const token of out.tokens) { token.masked = mask(token.value); delete token.value; }
  return out;
}
class ConfigStore {
  constructor(dir) {
    this.dir = path.resolve(dir); fs.mkdirSync(this.dir, { recursive:true });
    this.file = path.join(this.dir,'config.json'); this.secretFile = path.join(this.dir,'secrets.json');
    const meta = readJson(this.file, null); const secrets = readJson(this.secretFile,{ credentials:{} });
    if (meta) {
      for (const ch of meta.channels || []) for (const key of ch.keys || []) key.value = secrets.credentials[key.id];
      for (const token of meta.tokens || []) token.value = secrets.credentials[token.id];
      // Hydration is trusted only after schema validation, but preserve existing stable IDs.
      this.config = normalize(meta, meta);
      if(meta.schema_version!==2)this.save(this.config);
    } else { this.config = normalize({}); this.save(this.config); }
    const legacyAdminFile = path.join(this.dir,'admin.secret');
    if (fs.existsSync(legacyAdminFile)) fs.unlinkSync(legacyAdminFile);
  }
  save(config) {
    const meta = structuredClone(config); const secrets = readJson(this.secretFile,{ credentials:{} });
    for (const ch of meta.channels) for (const key of ch.keys) { secrets.credentials[key.id] = key.value; delete key.value; }
    for (const token of meta.tokens) { secrets.credentials[token.id] = token.value; delete token.value; }
    atomicJson(this.secretFile,secrets); atomicJson(this.file,meta,true);
    this.config = config;
    // Keep only references used by the current config and its single metadata backup.
    const retained=new Set();
    for (const version of [meta,readJson(`${this.file}.bak`,{})]) {
      for (const ch of version.channels || []) for (const key of ch.keys || []) retained.add(key.id);
      for (const token of version.tokens || []) retained.add(token.id);
    }
    if (Object.keys(secrets.credentials).some(key=>!retained.has(key))) {
      for (const key of Object.keys(secrets.credentials)) if (!retained.has(key)) delete secrets.credentials[key];
      atomicJson(this.secretFile,secrets);
    }
  }
  update(config) { const next = normalize(config,this.config); this.save(next); return this.public(); }
  public() { return sanitized(this.config); }
  redact(value) {
    let text = String(value || '');
    for (const secret of [...this.config.tokens.map(t=>t.value), ...this.config.channels.flatMap(ch=>ch.keys.map(k=>k.value))]) if (secret) text = text.split(secret).join('[redacted]');
    return text;
  }
  export(includeSecrets = false) { return includeSecrets ? structuredClone(this.config) : this.public(); }
}
module.exports = { ConfigStore, DEFAULT_SETTINGS, normalize, settings, sanitized };
