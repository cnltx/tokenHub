'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {ConfigStore}=require('./config');
const {Telemetry}=require('./telemetry');
const {Gateway,writeChunk}=require('./gateway');
const {Batch}=require('./batch');
const {Forwarding}=require('./forwarding');
const {HttpError,id,equal,jsonBody,json,sseHeaders,event}=require('./util');

function createApp({dataDir=path.join(__dirname,'..','data'),port,host=process.env.TOKENHUB_HOST||'127.0.0.1',publicUrl=process.env.TOKENHUB_PUBLIC_URL,onShutdown}={}) {
  const store=new ConfigStore(dataDir); const telemetry=new Telemetry(store.dir,()=>store.config.settings);
  const gateway=new Gateway(store,telemetry); const forwarding=new Forwarding(store,gateway); const batch=new Batch(store,gateway);
  const csrf=crypto.randomBytes(24).toString('hex');
  const instance=id('instance'); const startedAt=Date.now(); let closing=false;
  const publicDir=path.join(__dirname,'..','public');
  let actualPort=port ?? store.config.settings.port;
  if(!['127.0.0.1','0.0.0.0'].includes(host))throw new Error('TOKENHUB_HOST must be 127.0.0.1 or 0.0.0.0');
  const publicOrigin=publicUrl?new URL(publicUrl).origin:null;
  function guard(req) {
    const allowed=new Set([`127.0.0.1:${actualPort}`,`localhost:${actualPort}`,...(publicOrigin?[new URL(publicOrigin).host]:[])]);
    if (!allowed.has(req.headers.host)) throw new HttpError(403,'仅允许通过本机地址访问','invalid_host');
    if (req.headers.origin && ![`http://127.0.0.1:${actualPort}`,`http://localhost:${actualPort}`,publicOrigin].includes(req.headers.origin)) throw new HttpError(403,'不允许跨站访问','invalid_origin');
    if (req.headers['sec-fetch-site']==='cross-site') throw new HttpError(403,'不允许跨站访问','invalid_origin');
  }
  function management(req,mutation=false) {
    if (mutation && !equal(req.headers['x-csrf-token'],csrf)) throw new HttpError(403,'管理请求校验失败，请刷新页面','csrf_required');
  }
  function connected(req,res) {
    const controller=new AbortController();
    const abort=()=>controller.abort(new HttpError(499,'客户端已断开','cancelled'));
    const close=()=>{if(!res.writableEnded)abort();};
    req.once('aborted',abort); res.once('close',close);
    res.once('finish',()=>{req.removeListener('aborted',abort);res.removeListener('close',close);});
    return controller.signal;
  }
  function update(field,itemId,method,body) {
    const next=structuredClone(store.config);
    if (method==='POST') next[field].push(body);
    else {
      const index=next[field].findIndex(x=>x.id===itemId);
      if (index<0) throw new HttpError(404,'对象不存在','not_found');
      if (method==='DELETE') next[field].splice(index,1);
      else next[field][index]={...next[field][index],...body,id:itemId};
    }
    return store.update(next);
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('x-content-type-options','nosniff'); res.setHeader('referrer-policy','no-referrer'); res.setHeader('x-frame-options','DENY');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const signal=connected(req,res);
    try {
      guard(req);
      const url=new URL(req.url,'http://localhost'); const p=url.pathname; const method=req.method;
      if (p==='/health' && method==='GET') return json(res,200,{name:'tokenHub',version:'0.2.0',instance,paused:store.config.settings.paused});
      if(p.startsWith('/v1/')) {
        const identity=gateway.authenticate(req.headers.authorization);
        if(p==='/v1/models' && method==='GET')return json(res,200,{object:'list',data:gateway.models(identity)});
        if(method!=='POST')throw new HttpError(405,'不支持此方法','method_not_allowed');
        const body=await jsonBody(req);
        const endpoint=p==='/v1/chat/completions'?'chat/completions':p==='/v1/responses'?'responses':null;
        if(!endpoint)throw new HttpError(404,'接口不存在','not_found');
        const requestId=id('call');
        const primary=gateway.execute({body,endpoint,identity,signal,requestId,onOpen:()=>sseHeaders(res),onChunk:chunk=>writeChunk(res,chunk,signal),onEvent:record=>{if(record.converted)event(res,record.type,record.data);}});
        if(typeof body.model==='string'&&(endpoint!=='chat/completions'||Array.isArray(body.messages)&&body.messages.length))forwarding.dispatch({body,endpoint,identity,signal,requestId});
        const result=await primary;
        if(body.stream===true)return res.end();
        return json(res,200,result.data);
      }
      if(p.startsWith('/api/')) {
        management(req,!['GET','HEAD'].includes(method));
        if(p==='/api/session' && method==='GET')return json(res,200,{csrf});
        if(p==='/api/status' && method==='GET') {
          const config=store.public();
          for(const ch of config.channels) for(const key of ch.keys)key.runtime={...telemetry.key(key.id),metrics:telemetry.keyMetrics(key.id),...gateway.keyActivity(key.id)};
          for(const token of config.tokens)token.last_used=telemetry.runtime.tokenLastUsed[token.id]||null;
          return json(res,200,{version:'0.2.0',instance,started_at:startedAt,port:actualPort,base_url:`${publicOrigin||`http://127.0.0.1:${actualPort}`}/v1`,active:gateway.active,memory_bytes:process.memoryUsage().rss,storage_errors:Object.values(telemetry.errors).filter(Boolean),config,stats:telemetry.snapshot(),forwarding:forwarding.snapshot(),batch:batch.current});
        }
        if(p==='/api/config' && method==='GET')return json(res,200,store.public());
        if(p==='/api/stats' && method==='GET')return json(res,200,telemetry.snapshot());
        if(p==='/api/stats.csv' && method==='GET') {res.writeHead(200,{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename=tokenhub-usage.csv','cache-control':'no-store'});return res.end(telemetry.csv(url.searchParams.get('dimension')||'model'));}
        if(p==='/api/settings' && method==='PUT') {const body=await jsonBody(req);const next=structuredClone(store.config);next.settings={...next.settings,...body};store.update(next);return json(res,200,{settings:store.config.settings,restart_required:store.config.settings.port!==actualPort});}
        if(p==='/api/export' && method==='POST'){const body=await jsonBody(req);return json(res,200,store.export(body.include_api_keys===true));}
        if(p==='/api/forwarding' && method==='PUT'){const next=structuredClone(store.config);next.forwarding={...next.forwarding,...await jsonBody(req)};store.update(next);return json(res,200,store.config.forwarding);}
        if(p==='/api/debug/run' && method==='POST'){
          const body=await jsonBody(req);const identity={id:'admin',admin:true,group:body.group||'*',models:[]};
          const prompt=String(body.prompt||'').trim();if(!prompt||prompt.length>100000)throw new HttpError(400,'请输入最多 100000 字符的测试消息','invalid_request');
          const payload={model:body.model,messages:[{role:'user',content:prompt}],stream:true,max_tokens:Math.min(Number(body.max_tokens)||1024,store.config.settings.debug_max_tokens)};
          let content='',reasoning='';const requestId=id('call');
          const primary=gateway.execute({body:payload,identity,signal,requestId,source:'playground',onOpen:()=>sseHeaders(res),onEvent:record=>{const delta=record.data?.choices?.[0]?.delta;if(typeof delta?.content==='string'){content+=delta.content;event(res,'delta',{text:delta.content});}if(typeof delta?.reasoning_content==='string'){reasoning+=delta.reasoning_content;event(res,'reasoning',{text:delta.reasoning_content});}}});
          forwarding.dispatch({body:payload,identity,signal,requestId});
          const result=await primary;event(res,'complete',{model:body.model,content,reasoning,usage:result.usage,ms:result.ms});return res.end();
        }
        let match;
        if(p==='/api/batch/start' && method==='POST')return json(res,200,batch.start(await jsonBody(req)));
        if(p==='/api/batch/stop' && method==='POST')return json(res,200,batch.stop());
        if((match=/^\/api\/channels\/([^/]+)\/(discover|keys\/([^/]+)\/(test|reveal|recover))$/.exec(p)) && method==='POST') {
          const [,channelId,action,keyId,keyAction]=match;
          const ch=store.config.channels.find(c=>c.id===channelId);if(!ch)throw new HttpError(404,'渠道不存在','not_found');
          const key=ch.keys.find(k=>k.id===keyId) || (action==='discover'?ch.keys.find(k=>k.status==='enabled'):null);
          if(!key)throw new HttpError(404,'Key 不存在','not_found');
          if(keyAction==='reveal')return json(res,200,{value:key.value});
          if(keyAction==='recover'){telemetry.resetKey(key.id);return json(res,200,{ok:true});}
          return json(res,200,await gateway.probe(channelId,key.id,signal));
        }
        if((match=/^\/api\/tokens\/([^/]+)\/reveal$/.exec(p)) && method==='POST'){const token=store.config.tokens.find(t=>t.id===match[1]);if(!token)throw new HttpError(404,'令牌不存在','not_found');return json(res,200,{value:token.value});}
        if((match=/^\/api\/(channels|tokens)(?:\/([^/]+))?$/.exec(p)) && ['POST','PUT','DELETE'].includes(method)) {
          const [,field,itemId]=match;
          if(method!=='POST'&&!itemId)throw new HttpError(400,'缺少对象 ID','invalid_request');
          const body=method==='DELETE'?{}:await jsonBody(req);
          if(field==='tokens' && method==='POST' && !body.value && !body.key)body.value=`th_${crypto.randomBytes(24).toString('hex')}`;
          const result=update(field,itemId,method,body);return json(res,method==='POST'?201:200,result);
        }
        if(p==='/api/shutdown' && method==='POST'){json(res,200,{ok:true});setTimeout(()=>{if(onShutdown)onShutdown();else app.close();},50);return;}
        throw new HttpError(404,'管理接口不存在','not_found');
      }
      if(method!=='GET'&&method!=='HEAD')throw new HttpError(405,'不支持此方法','method_not_allowed');
      const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css','/favicon.svg':'favicon.svg'};
      const file=files[p];if(!file)throw new HttpError(404,'页面不存在','not_found');
      const content=fs.readFileSync(path.join(publicDir,file));
      res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8','cache-control':'no-store'});res.end(method==='HEAD'?undefined:content);
    } catch(error) {
      if(res.destroyed||res.writableEnded)return;
      const status=error.status||500;
      const message=store.redact(status===500?'本地服务处理失败，请查看终端或检查数据文件':error.message);
      if(res.headersSent){event(res,'error',{error:{message,type:error.code||'server_error'}});res.end();}
      else json(res,status,{error:{message,type:error.code||'server_error',code:error.code||'server_error'}},error.headers);
    }
  });
  server.requestTimeout=30000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
  const app={store,telemetry,gateway,forwarding,batch,server,instance,startedAt,
    get port(){return actualPort;},
    async listen() {await new Promise((resolve,reject)=>{const error=e=>{server.removeListener('listening',ready);reject(e);};const ready=()=>{server.removeListener('error',error);actualPort=server.address().port;resolve();};server.once('error',error);server.once('listening',ready);server.listen(actualPort,host);});return app;},
    async close() {if(closing)return;closing=true;batch.stop();const mirrored=forwarding.close();gateway.close();await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();setTimeout(()=>server.closeAllConnections(),1500).unref();});await mirrored;await gateway.whenIdle();await batch.finished;telemetry.close();}
  };
  return app;
}
module.exports={createApp};
