'use strict';
const http = require('node:http');
const https = require('node:https');
const { once } = require('node:events');
const { HttpError, id, equal, SSEParser, abortError } = require('./util');
const { usageFrom } = require('./telemetry');
const { responsesToChat, chatToResponse, ResponsesBridge } = require('./protocols');

function openRequest(channel, key, endpoint, body, signal, timeout, method='POST') {
  return new Promise((resolve,reject)=>{
    const target=new URL(`${channel.base_url}/${endpoint}`);
    const payload=method==='GET'?null:Buffer.from(JSON.stringify(body));
    const request=(target.protocol==='https:'?https:http).request(target,{
      method, signal, headers:{authorization:`Bearer ${key.value}`,accept:body?.stream?'text/event-stream':'application/json','user-agent':'tokenHub/0.1',...(payload?{'content-type':'application/json','content-length':payload.length}:{})}
    },resolve);
    request.setTimeout(timeout,()=>request.destroy(new HttpError(504,'上游连接或数据空闲超时','upstream_timeout')));
    request.once('error',error=>reject(signal.aborted?abortError(signal):error));
    request.end(payload);
  });
}
async function readLimited(response, max=32*1024*1024) {
  const chunks=[]; let size=0;
  for await (const chunk of response) { size+=chunk.length; if (size>max) { response.destroy(); throw new HttpError(502,'上游响应超过大小限制','upstream_too_large'); } chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
function cooldownMs(header,fallback) {
  if (!header) return fallback;
  const ms=Number.isFinite(Number(header))?Number(header)*1000:Date.parse(header)-Date.now();
  return Number.isFinite(ms)?Math.min(3600000,Math.max(1000,ms)):fallback;
}
class Gateway {
  constructor(store,telemetry) { this.store=store; this.telemetry=telemetry; this.active=0; this.primaryActive=0; this.controllers=new Set(); this.idleWaiters=[]; this.activeKeys=new Map(); }
  keyActivity(keyId) {
    const calls=[...this.activeKeys.values()].filter(call=>call.key_id===keyId);
    return {active:calls.length,primary_active:calls.filter(call=>call.source!=='forward'&&call.source!=='probe').length,forward_active:calls.filter(call=>call.source==='forward').length,probe_active:calls.filter(call=>call.source==='probe').length};
  }
  authenticate(header) {
    const match=/^Bearer\s+(.+)$/i.exec(header||'');
    const token=match && this.store.config.tokens.find(t=>t.status==='enabled' && equal(t.value,match[1]));
    if (!token) throw new HttpError(401,'客户端令牌无效或已停用','invalid_api_key');
    this.telemetry.runtime.tokenLastUsed[token.id]=Date.now(); this.telemetry.dirty=true;
    return { id:token.id, name:token.name, group:token.group, models:token.models };
  }
  allowed(identity,model) { return !identity.models?.length || identity.models.includes(model); }
  channels(identity,model,endpoint) {
    if (!this.allowed(identity,model)) throw new HttpError(403,'令牌无权使用该模型','model_forbidden');
    return this.store.config.channels.filter(ch=>ch.status==='enabled' && ((identity.admin && identity.group==='*') || ch.groups.includes(identity.group)) && (ch.models.includes(model) || Object.hasOwn(ch.model_mapping,model)) && (endpoint==='chat/completions'?ch.protocols.includes('chat'):ch.protocols.includes('responses') || (ch.responses_mode==='chat_bridge' && ch.protocols.includes('chat')))).sort((a,b)=>a.priority-b.priority);
  }
  models(identity) {
    const all=new Set();
    for (const ch of this.store.config.channels) if (ch.status==='enabled' && ((identity.admin&&identity.group==='*')||ch.groups.includes(identity.group))) for (const model of [...ch.models,...Object.keys(ch.model_mapping)]) if (this.allowed(identity,model)) all.add(model);
    return [...all].sort().map(model=>({id:model,object:'model',created:0,owned_by:'tokenHub'}));
  }
  choose(ch,tried,forcedKeyId,scope='') {
    const keys=ch.keys.filter(k=>k.status==='enabled' && (!forcedKeyId || k.id===forcedKeyId) && !tried.has(k.id) && !this.telemetry.key(scope+k.id).auth_error && this.telemetry.key(scope+k.id).cooldown_until<=Date.now());
    if (!keys.length) return null;
    if (ch.key_mode==='random') return keys[Math.floor(Math.random()*keys.length)];
    const start=this.telemetry.runtime.cursors[ch.id] || 0;
    for (let n=0;n<ch.keys.length;n++) { const index=(start+n)%ch.keys.length; if (keys.includes(ch.keys[index])) { this.telemetry.runtime.cursors[ch.id]=(index+1)%ch.keys.length; this.telemetry.dirty=true; return ch.keys[index]; } }
    return null;
  }
  async execute({body,endpoint='chat/completions',identity,signal, onOpen,onChunk,onEvent, forcedKeyId, source='api', forwardingId, requestId}) {
    const config=this.store.config; const settings=config.settings;
    const healthScope=source==='forward'?`forward:${body?.model}:`:'';
    if (settings.paused) throw new HttpError(503,'网关已暂停接收新请求','gateway_paused');
    if (source!=='forward' && this.primaryActive>=settings.max_concurrency) throw new HttpError(429,'网关主请求并发已满，请稍后重试','concurrency_limit',{'retry-after':'1'});
    if (!body || typeof body.model!=='string' || !body.model.trim()) throw new HttpError(400,'model 不能为空','invalid_request');
    if (endpoint==='chat/completions' && (!Array.isArray(body.messages)||!body.messages.length)) throw new HttpError(400,'messages 不能为空','invalid_request');
    const routes=this.channels(identity,body.model,endpoint);
    if (!routes.length) throw new HttpError(404,'当前分组没有支持该模型与接口的启用渠道','model_not_found');
    // Weighted ordering only within a priority; lower priorities remain fallbacks.
    const weighted=routes.map(ch=>({ch,rank:-Math.log(Math.max(Number.MIN_VALUE,Math.random()))/ch.weight})).sort((a,b)=>a.ch.priority-b.ch.priority || a.rank-b.rank).map(x=>x.ch);
    const controller=new AbortController(); this.controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(new HttpError(504,'请求超过整体时间限制','request_timeout')),settings.request_timeout_ms);
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    this.active++;if(source!=='forward')this.primaryActive++;
    const started=Date.now(); const trace=id('req'); let attempts=0, selectedChannel,selectedKey,usage=null, status=503,ok=false, failure;
    const tried=new Set();
    try {
      for (const ch of weighted) {
        const bridge=endpoint==='responses' && ch.responses_mode==='chat_bridge';
        const upstreamEndpoint=bridge?'chat/completions':endpoint;
        const template=bridge?responsesToChat(body):{...body};
        let key;
        while (attempts<settings.max_attempts && (key=this.choose(ch,tried,forcedKeyId,healthScope))) {
          if (combined.aborted) throw abortError(combined);
          tried.add(key.id); attempts++; selectedChannel=ch; selectedKey=key;
          this.telemetry.attempt(ch,key,attempts>1,healthScope);
          const attemptStarted=Date.now();let recorded=false;
          this.activeKeys.set(trace,{key_id:key.id,source});
          const recordResult=(code,cooldown=0)=>{if(recorded)return;recorded=true;this.telemetry.keyResult(key,code,Date.now()-attemptStarted,cooldown,healthScope);};
          try {
            const requestBody={...template,model:ch.model_mapping[body.model] || body.model};
            if (requestBody.stream && upstreamEndpoint==='chat/completions') requestBody.stream_options={...requestBody.stream_options,include_usage:true};
            let upstream;
            try { upstream=await openRequest(ch,key,upstreamEndpoint,requestBody,combined,settings.idle_timeout_ms); }
            catch (error) {
              if (combined.aborted) throw abortError(combined);
              recordResult(error.status||0,Date.now()+settings.cooldown_ms);
              failure=new HttpError(error.status||502,error.status===504?'上游连接超时':'连接上游失败','upstream_connection_error');
              continue;
            }
            status=upstream.statusCode;
            if (status<200 || status>=300) {
              // Drain without logging or exposing request/credential-bearing provider bodies.
              try { await readLimited(upstream,1024*1024); } catch (error) { if (combined.aborted) throw abortError(combined); }
              const until=status===429?Date.now()+cooldownMs(upstream.headers['retry-after'],settings.cooldown_ms):status>=500?Date.now()+settings.cooldown_ms:0;
              recordResult(status,until);
              const retryAfter=status===429?{'retry-after':String(Math.max(1,Math.ceil((until-Date.now())/1000)))}:{};
              failure=new HttpError(status,`上游返回 HTTP ${status}${status===401?'，此 Key 已标为鉴权异常':status===429?'，此 Key 正在冷却':''}`,'upstream_error',retryAfter);
              if (status===401 || status===408 || status===429 || status>=500) continue;
              throw failure;
            }
            // Once a successful upstream response is accepted, no replay occurs after a stream/body failure.
            let data;
            if (body.stream===true) {
              if (!String(upstream.headers['content-type']||'').includes('text/event-stream')) { upstream.destroy(); throw new HttpError(502,'上游没有返回 SSE，请检查渠道协议能力','invalid_stream'); }
              let terminal=false, streamError=null, bytes=0;
              const bridgeStream=bridge?new ResponsesBridge(body.model,(type,data)=>onEvent?.({type,data,converted:true})):null;
              const parser=new SSEParser(record=>{
                if (record.type==='done' || record.type==='response.completed' || record.type==='response.incomplete') terminal=true;
                if (record.data?.error || ['error','response.failed'].includes(record.type)) streamError=new HttpError(502,'上游流返回错误','upstream_stream_error');
                const reported=usageFrom(record.data); if (reported) usage=reported;
                if (bridgeStream) { if (record.data) bridgeStream.consume(record.data); }
                else onEvent?.(record);
              });
              onOpen?.({status,channel:ch.name,key_id:key.id,model:body.model,converted:bridge});
              for await (const chunk of upstream) {
                if (combined.aborted) throw abortError(combined);
                bytes+=chunk.length; if (bytes>32*1024*1024) { upstream.destroy(); throw new HttpError(502,'上游流超过 32MB','upstream_too_large'); }
                parser.push(chunk);
                if (!bridge && onChunk) await onChunk(chunk);
                if (streamError) { upstream.destroy(); throw streamError; }
              }
              parser.end();
              if (streamError) throw streamError;
              if (!terminal) throw new HttpError(502,'上游流提前结束，未收到完成标记','incomplete_stream');
              if (bridgeStream) data=bridgeStream.end(usage);
            } else {
              const raw=await readLimited(upstream);
              try { data=JSON.parse(raw); } catch { throw new HttpError(502,'上游未返回有效 JSON','invalid_upstream_response'); }
              if (data.error || data.status==='failed') throw new HttpError(502,'上游返回生成错误','upstream_error');
              usage=usageFrom(data);
              if (bridge) data=chatToResponse(data,body.model);
            }
            recordResult(status);
            ok=true;
            return { data,usage,channel:ch.name,channel_id:ch.id,key_id:key.id,attempts,ms:Date.now()-started,trace };
          } catch(error) {
            const code=(combined.aborted?abortError(combined):error).status||502;
            recordResult(code,code===499?0:Date.now()+settings.cooldown_ms);
            throw error;
          } finally { this.activeKeys.delete(trace); }
        }
        if (attempts>=settings.max_attempts) break;
      }
      if (failure) throw failure;
      const cooldowns=routes.flatMap(ch=>ch.keys.filter(k=>k.status==='enabled').map(k=>this.telemetry.key(healthScope+k.id).cooldown_until)).filter(t=>t>Date.now());
      throw new HttpError(503,'没有可用 Key；请检查启停、鉴权状态与冷却时间','no_available_key',cooldowns.length?{'retry-after':String(Math.max(1,Math.ceil((Math.min(...cooldowns)-Date.now())/1000)))}:{});
    } catch (error) {
      failure=combined.aborted?abortError(combined):error;
      status=failure.status || 502;
      throw failure;
    } finally {
      clearTimeout(timer); this.controllers.delete(controller); this.active--;if(source!=='forward')this.primaryActive--;
      try { this.telemetry.finish({id:trace,ts:Date.now(),model:body.model,channel_id:selectedChannel?.id,channel:selectedChannel?.name,key_id:selectedKey?.id,token_id:identity.id,source,forwarding_id:forwardingId,request_id:requestId,attempts,status,ok,ms:Date.now()-started,usage,error:ok?undefined:this.store.redact(failure?.message||'请求失败')}); }
      finally { if(this.active===0)for(const resolve of this.idleWaiters.splice(0))resolve(); }
    }
  }
  async probe(channelId,keyId,signal) {
    const ch=this.store.config.channels.find(c=>c.id===channelId); const key=ch?.keys.find(k=>k.id===keyId);
    if (!key) throw new HttpError(404,'Key 不存在','not_found');
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(new HttpError(504,'连通性测试超时','upstream_timeout')),15000);
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const started=Date.now(),activityId=id('probe');
    this.activeKeys.set(activityId,{key_id:key.id,source:'probe'});
    try {
      const res=await openRequest(ch,key,'models',null,combined,15000,'GET');
      const raw=await readLimited(res,4*1024*1024);
      this.telemetry.keyResult(key,res.statusCode,Date.now()-started,res.statusCode===429?Date.now()+cooldownMs(res.headers['retry-after'],this.store.config.settings.cooldown_ms):0);
      let models=[]; try { models=JSON.parse(raw).data?.map(m=>m.id).filter(x=>typeof x==='string')||[]; } catch { /* status remains visible; an empty list is not claimed as model support */ }
      return {ok:res.statusCode>=200&&res.statusCode<300,status:res.statusCode,ms:Date.now()-started,models};
    } catch(error) { this.telemetry.keyResult(key,error.status||0,Date.now()-started); throw combined.aborted?abortError(combined):new HttpError(502,'无法连接上游模型接口','upstream_connection_error'); }
    finally { clearTimeout(timer); this.activeKeys.delete(activityId); }
  }
  close() { for (const controller of this.controllers) controller.abort(new HttpError(503,'服务正在停止','server_shutdown')); }
  whenIdle() { return this.active===0?Promise.resolve():new Promise(resolve=>this.idleWaiters.push(resolve)); }
}
async function writeChunk(res,chunk,signal) {
  if (res.destroyed || res.writableEnded) throw new HttpError(499,'客户端已断开','cancelled');
  if (!res.write(chunk)) await once(res,'drain',{signal});
}
module.exports={ Gateway, readLimited, cooldownMs, writeChunk };
