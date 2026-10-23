'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readJson, atomicJson } = require('./util');

function usageFrom(data) {
  const usage = data?.usage || data?.response?.usage;
  if (!usage) return null;
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { input: Math.max(0,input), output:Math.max(0,output), cached:Math.max(0,usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0), exact:true };
}
function empty() { return { requests:0, ok:0, failed:0, attempts:0, retries:0, input:0, output:0, cached:0, reported:0, unknown:0, cancelled:0, total_ms:0 }; }
function add(row, update) { for (const [k,v] of Object.entries(update)) if (typeof v === 'number') row[k] = (row[k] || 0) + v; }
class Telemetry {
  constructor(dir, getSettings) {
    this.dir = dir; this.getSettings = getSettings;
    this.file = path.join(dir,'stats.json'); this.runtimeFile = path.join(dir,'runtime.json'); this.logDir = path.join(dir,'logs');
    fs.mkdirSync(this.logDir,{ recursive:true });
    this.stats = readJson(this.file,{ total:empty(), dimensions:{ date:{}, model:{}, channel:{}, key:{}, token:{} }, recent:[], buckets:[] });
    delete this.stats.comparisons;
    this.runtime = readJson(this.runtimeFile,{ keys:{}, cursors:{}, tokenLastUsed:{} });
    this.dirty = false;
    this.errors={log:null,snapshot:null};
    this.timer = setInterval(()=>{try{this.flush();}catch{this.errors.snapshot='统计快照写入失败，请检查 data 目录的空间与写权限。';}},1000); this.timer.unref();
    this.cleanLogs();
  }
  key(id) { return this.runtime.keys[id] ||= { ok:0, fail:0, attempts:0, last_status:0, last_ms:0, cooldown_until:0, auth_error:false, last_at:null }; }
  keyMetrics(id) {
    const rows=Object.entries(this.runtime.keys).filter(([label])=>label===id||label.endsWith(':'+id)).map(([,row])=>row);
    const sum=field=>rows.reduce((n,row)=>n+(Number(row[field])||0),0);
    const ok=sum('ok'),fail=sum('fail');
    return {ok,fail,attempts:sum('attempts'),completed:ok+fail,success_rate:ok+fail?ok/(ok+fail):null,last_used_at:Math.max(0,...rows.map(row=>row.last_at||0))||null};
  }
  attempt(ch, key, retry = false, scope = '') {
    this.key(scope+key.id).attempts++;
    for (const [dim,label] of [['channel',ch.id],['key',key.id]]) {
      if (!Object.hasOwn(this.stats.dimensions[dim],label)) Object.defineProperty(this.stats.dimensions[dim],label,{value:empty(),enumerable:true,writable:true,configurable:true});
      add(this.stats.dimensions[dim][label],{attempts:1,retries:retry?1:0});
    }
    this.dirty=true;
  }
  keyResult(key, status, ms, cooldown = 0, scope = '') {
    const row=this.key(scope+key.id); row.last_status=status; row.last_ms=ms; row.last_at=Date.now();
    if (status>=200 && status<300) { row.ok++; row.auth_error=false; row.cooldown_until=0; }
    else { row.fail++; row.auth_error=status===401; row.cooldown_until=cooldown; }
    this.dirty=true;
  }
  resetKey(id) { this.key(id);for(const [label,row]of Object.entries(this.runtime.keys))if(label===id||label.endsWith(':'+id)){row.auth_error=false;row.cooldown_until=0;}this.dirty=true; }
  finish(entry) {
    const date = new Intl.DateTimeFormat('en-CA',{ timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date(entry.ts));
    const value = { requests:1, ok:entry.ok?1:0, failed:entry.ok?0:1, cancelled:entry.status===499?1:0, attempts:entry.attempts, retries:Math.max(0,entry.attempts-1), total_ms:entry.ms, forwarded:entry.source==='forward'?1:0, input:entry.usage?.input || 0, output:entry.usage?.output || 0, cached:entry.usage?.cached || 0, reported:entry.usage?1:0, unknown:entry.usage?0:1 };
    add(this.stats.total,value);
    for (const [dim,label] of Object.entries({date,model:entry.model,channel:entry.channel_id || 'unrouted',key:entry.key_id || 'unrouted',token:entry.token_id || 'admin'})) {
      if (!Object.hasOwn(this.stats.dimensions[dim],label)) Object.defineProperty(this.stats.dimensions[dim],label,{value:empty(),enumerable:true,writable:true,configurable:true});
      add(this.stats.dimensions[dim][label],dim==='channel'||dim==='key'?{...value,attempts:0,retries:0}:value);
    }
    const bucketTs = Math.floor(entry.ts/30000)*30000;
    let bucket=this.stats.buckets.find(b=>b.ts===bucketTs);
    if (!bucket) this.stats.buckets.push(bucket={ts:bucketTs,...empty()});
    add(bucket,value); this.stats.buckets=this.stats.buckets.filter(b=>b.ts>Date.now()-1800000);
    this.stats.recent.unshift(entry); this.stats.recent.length=Math.min(200,this.stats.recent.length);
    try { this.appendLog(entry); this.errors.log=null; }
    catch { this.errors.log='请求日志写入失败，请检查 data/logs 目录的空间与写权限。'; }
    this.prune(); this.dirty=true;
  }
  prune() {
    const cutoff=new Date(Date.now()-this.getSettings().log_retention_days*86400000).toISOString().slice(0,10);
    for (const date of Object.keys(this.stats.dimensions.date)) if (date<cutoff) delete this.stats.dimensions.date[date];
  }
  appendLog(entry) {
    const file=path.join(this.logDir,'requests.jsonl');
    if (fs.existsSync(file) && fs.statSync(file).size>this.getSettings().log_max_mb*1024*1024) {
      const oldest=path.join(this.logDir,'requests.3.jsonl'); if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
      for (let n=2;n>=1;n--) { const from=path.join(this.logDir,`requests.${n}.jsonl`); if (fs.existsSync(from)) fs.renameSync(from,path.join(this.logDir,`requests.${n+1}.jsonl`)); }
      fs.renameSync(file,path.join(this.logDir,'requests.1.jsonl'));
    }
    fs.appendFileSync(file,`${JSON.stringify(entry)}\n`,{ mode:0o600 });
    if (Date.now()-(this.cleanedAt||0)>3600000) this.cleanLogs();
  }
  cleanLogs() { this.cleanedAt=Date.now(); for (const name of fs.readdirSync(this.logDir)) if (/^requests(?:\.\d)?\.jsonl$/.test(name)) { const file=path.join(this.logDir,name); if (fs.statSync(file).mtimeMs<Date.now()-this.getSettings().log_retention_days*86400000) fs.unlinkSync(file); } }
  snapshot() {
    const now=Date.now(); const buckets=[];
    for (let i=59;i>=0;i--) { const ts=Math.floor(now/30000)*30000-i*30000; buckets.push(this.stats.buckets.find(b=>b.ts===ts)||{ts,...empty()}); }
    return { ...structuredClone(this.stats), buckets };
  }
  csv(dimension='model') {
    if (!this.stats.dimensions[dimension]) dimension='model';
    const esc=value=>`"${String(value).replace(/^[=+@-]/,"'$&").replace(/"/g,'""')}"`;
    const fields=['requests','ok','failed','attempts','retries','input','output','cached','reported','unknown','total_ms'];
    return '\uFEFF'+[ [dimension,...fields].join(','),...Object.entries(this.stats.dimensions[dimension]).map(([label,v])=>[esc(label),...fields.map(k=>v[k]||0)].join(',')) ].join('\r\n');
  }
  flush() { if (!this.dirty) return; atomicJson(this.file,this.stats); atomicJson(this.runtimeFile,this.runtime); this.dirty=false; this.errors.snapshot=null; }
  close() { clearInterval(this.timer); this.flush(); }
}
module.exports={ Telemetry, usageFrom };
