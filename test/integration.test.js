'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {createApp}=require('../src/server');
const {ConfigStore}=require('../src/config');
const {ensureService}=require('../src/desktop');
const {sleep,SSEParser}=require('../src/util');

const tmpRoot=path.resolve(__dirname,'..','.tmp');fs.mkdirSync(tmpRoot,{recursive:true});
function removeFixture(dir){if(!path.resolve(dir).startsWith(tmpRoot+path.sep))throw new Error('Unsafe test cleanup target');fs.rmSync(dir,{recursive:true,force:true});}
async function waitUntil(predicate,timeout=2500){const start=Date.now();while(!predicate()){if(Date.now()-start>timeout)assert.fail('等待状态超时');await sleep(15);}}
function reply(res,status,data,headers={}){res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(data));}
function complete(res,body,text='你好 🌍',wait=90){
  const usage={prompt_tokens:12,completion_tokens:4,total_tokens:16,prompt_tokens_details:{cached_tokens:3}};
  if(body.stream){res.writeHead(200,{'content-type':'text/event-stream'});const first=Buffer.from(`data: ${JSON.stringify({choices:[{index:0,delta:{content:text},finish_reason:null}]})}\r\n\r\n`);const split=first.indexOf(Buffer.from('你'))+1;res.write(first.subarray(0,split));res.write(first.subarray(split));const timer=setTimeout(()=>res.end(`data: ${JSON.stringify({choices:[],usage})}\n\ndata: [DONE]\n\n`),wait);res.once('close',()=>clearTimeout(timer));}
  else reply(res,200,{id:'chat_mock',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],usage});
}
async function fixture(handler){
  const received=[];
  const upstream=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;let body={};try{body=JSON.parse(raw||'{}');}catch{}const record={url:req.url,key:req.headers.authorization,body};received.push(record);if(req.url==='/v1/models')return reply(res,200,{data:[{id:'a'},{id:'b'}]});try{if(handler)await handler(req,res,record);else complete(res,body,`answer:${body.model}`);}catch{res.destroy();}});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const dir=fs.mkdtempSync(path.join(tmpRoot,'test-'));
  fs.writeFileSync(path.join(dir,'admin.secret'),'legacy-unused-management-key');
  const app=createApp({dataDir:dir,port:0});
  app.store.update({settings:{...app.store.config.settings,max_attempts:1,retry_interval_ms:100},channels:[{name:'mock',base_url:`http://127.0.0.1:${upstream.address().port}/v1`,models:['a','b'],groups:['default'],keys:['mock-key-A','mock-key-B']}],tokens:[{name:'client',value:'test-client-token',group:'default'}]});
  await app.listen();
  const base=`http://127.0.0.1:${app.port}`;
  const session=await fetch(base+'/api/session');
  assert.equal(session.status,200);assert.equal(session.headers.get('set-cookie'),null);const {csrf}=await session.json();const cookie='';
  async function admin(url,body,method=body==null?'GET':'POST'){const response=await fetch(base+url,{method,headers:{cookie,'x-csrf-token':csrf,'content-type':'application/json'},body:body==null?undefined:JSON.stringify(body)});return {response,data:await response.json()};}
  async function api(body,endpoint='chat/completions',extra={}){return fetch(base+'/v1/'+endpoint,{method:'POST',headers:{authorization:'Bearer test-client-token','content-type':'application/json',...extra},body:JSON.stringify(body)});}
  async function cleanup(){await app.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));removeFixture(dir);}
  return {app,base,dir,upstream,received,admin,api,cookie,csrf,cleanup};
}
async function sse(response){const raw=await response.text();const events=[];const parser=new SSEParser(e=>events.push(e));parser.push(Buffer.from(raw));parser.end();return events;}

test('tokenHub integration',{timeout:30000},async t=>{
  await t.test('management without login, CSRF, same-origin, secret masking and model permissions',async()=>{
    const f=await fixture();try{
      assert.equal((await fetch(f.base+'/api/status')).status,200);
      assert.equal(fs.existsSync(path.join(f.dir,'admin.secret')),false);
      assert.equal(f.app.store.adminKey,undefined);
      for(const route of ['/api/login','/api/logout'])assert.equal((await f.admin(route,{})).response.status,404);
      assert.ok(!(await (await fetch(f.base+'/')).text()).includes('login-form'));
      assert.equal((await fetch(f.base+'/api/settings',{method:'PUT',headers:{cookie:f.cookie,'content-type':'application/json'},body:'{}'})).status,403);
      assert.equal((await fetch(f.base+'/api/status',{headers:{cookie:f.cookie,origin:'https://other.example'}})).status,403);
      const status=await f.admin('/api/status');const text=JSON.stringify(status.data);assert.ok(!text.includes('mock-key-A'));assert.ok(!text.includes('test-client-token'));
      assert.equal((await fetch(f.base+'/v1/models')).status,401);
      const token=f.app.store.config.tokens[0];await f.admin('/api/tokens/'+token.id,{models:['a']},'PUT');
      assert.equal((await f.api({model:'b',messages:[{role:'user',content:'hi'}]})).status,403);
      const models=await fetch(f.base+'/v1/models',{headers:{authorization:'Bearer test-client-token'}});assert.deepEqual((await models.json()).data.map(m=>m.id),['a']);
      await f.admin('/api/tokens/'+token.id,{group:'unauthorized',models:[]},'PUT');assert.equal((await f.api({model:'a',messages:[{role:'user',content:'hi'}]})).status,404);assert.equal(f.received.length,0);
      await f.admin('/api/tokens/'+token.id,{group:'*'},'PUT');assert.equal((await f.api({model:'a',messages:[{role:'user',content:'hi'}]})).status,404);assert.equal(f.received.length,0);
      await f.admin('/api/tokens/'+token.id,{status:'disabled'},'PUT');assert.equal((await f.api({model:'a',messages:[{role:'user',content:'hi'}]})).status,401);
    }finally{await f.cleanup();}
  });
  await t.test('a key receives its complete ten-attempt budget before falling back to the next key',async()=>{
    const f=await fixture((req,res,r)=>r.key.endsWith('A')?reply(res,429,{error:'rate'}):complete(res,r.body));
    try{await f.admin('/api/settings',{max_attempts:10,retry_interval_ms:100},'PUT');const response=await f.api({model:'a',messages:[{role:'user',content:'hi'}]});assert.equal(response.status,200);await response.json();assert.deepEqual(f.received.map(r=>r.key),[...Array(10).fill('Bearer mock-key-A'),'Bearer mock-key-B']);const [a,b]=f.app.store.config.channels[0].keys;assert.equal(f.app.telemetry.keyMetrics(a.id).fail,10);assert.equal(f.app.telemetry.keyMetrics(b.id).ok,1);assert.ok(f.app.telemetry.key(a.id).cooldown_until>Date.now());assert.equal(f.app.store.config.channels[0].keys[0].status,'enabled');assert.equal(f.app.telemetry.stats.total.requests,1);assert.equal(f.app.telemetry.stats.total.attempts,11);assert.equal(f.app.telemetry.stats.total.retries,10);}finally{await f.cleanup();}
  });
  await t.test('each key has an independent retry budget and all exhausted keys cool down',async()=>{
    const f=await fixture((req,res)=>reply(res,429,{error:'rate'}));
    try{await f.admin('/api/settings',{max_attempts:3,retry_interval_ms:100},'PUT');const response=await f.api({model:'a',messages:[{role:'user',content:'hi'}]});assert.equal(response.status,429);await response.json();assert.deepEqual(f.received.map(r=>r.key),[...Array(3).fill('Bearer mock-key-A'),...Array(3).fill('Bearer mock-key-B')]);assert.ok(f.app.store.config.channels[0].keys.every(k=>f.app.telemetry.key(k.id).cooldown_until>Date.now()));const count=f.received.length;const next=await f.api({model:'a',messages:[{role:'user',content:'hi'}]});assert.equal(next.status,503);assert.equal(f.received.length,count);}finally{await f.cleanup();}
  });
  await t.test('Retry-After holds the same key, clears failures on success, and reports a waiting request',async()=>{
    const times=[];const f=await fixture((req,res,r)=>{times.push(Date.now());if(times.length===1)return reply(res,429,{error:'rate'},{'retry-after':'1'});complete(res,r.body);});
    try{await f.admin('/api/settings',{max_attempts:3,retry_interval_ms:100},'PUT');const pending=f.api({model:'a',messages:[{role:'user',content:'hi'}]});await waitUntil(()=>f.received.length===1);const key=f.app.store.config.channels[0].keys[0];await waitUntil(()=>f.app.gateway.keyActivity(key.id).retrying===1);assert.equal(f.app.gateway.keyActivity(key.id).active,1);const response=await pending;assert.equal(response.status,200);await response.json();assert.deepEqual(f.received.map(r=>r.key),['Bearer mock-key-A','Bearer mock-key-A']);assert.ok(times[1]-times[0]>=950);assert.equal(f.app.telemetry.key(key.id).cooldown_until,0);assert.equal(f.app.telemetry.keyMetrics(key.id).fail,1);assert.equal(f.app.telemetry.keyMetrics(key.id).ok,1);}finally{await f.cleanup();}
  });
  await t.test('cancel and overall deadline interrupt retry waits without trying another key',async()=>{
    const f=await fixture((req,res)=>reply(res,429,{error:'rate'},{'retry-after':'60'}));
    try{await f.admin('/api/settings',{max_attempts:10,retry_interval_ms:100},'PUT');const controller=new AbortController();const pending=fetch(f.base+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer test-client-token','content-type':'application/json'},body:JSON.stringify({model:'a',messages:[{role:'user',content:'hi'}]}),signal:controller.signal}).catch(()=>{});await waitUntil(()=>f.received.length===1);controller.abort();await pending;await waitUntil(()=>f.app.gateway.active===0);assert.equal(f.received.length,1);assert.equal(f.app.gateway.activeKeys.size,0);for(const key of f.app.store.config.channels[0].keys)f.app.telemetry.resetKey(key.id);await f.admin('/api/settings',{request_timeout_ms:1000},'PUT');const start=Date.now();const response=await f.api({model:'a',messages:[{role:'user',content:'timeout'}]});assert.equal(response.status,504);await response.json();assert.ok(Date.now()-start<2000);assert.equal(f.received.length,2);assert.equal(f.app.gateway.activeKeys.size,0);}finally{await f.cleanup();}
  });
  await t.test('connections, credentials and parameters all use the configured per-key budget',async()=>{
    for(const mode of ['network','server','auth','parameter']){
      let calls=0;const f=await fixture((req,res,r)=>{calls++;if(mode==='auth'&&r.key.endsWith('A'))return reply(res,401,{error:'invalid'});if(mode==='parameter')return reply(res,400,{error:'invalid parameter'});if(calls===1){if(mode==='network')return res.destroy();if(mode==='server')return reply(res,503,{error:'temporary'});}complete(res,r.body);});
      try{await f.admin('/api/settings',{max_attempts:3,retry_interval_ms:100},'PUT');const response=await f.api({model:'a',messages:[{role:'user',content:'hi'}]});assert.equal(response.status,mode==='parameter'?400:200);await response.json();assert.deepEqual(f.received.map(r=>r.key),mode==='parameter'?[...Array(3).fill('Bearer mock-key-A'),...Array(3).fill('Bearer mock-key-B')]:mode==='auth'?[...Array(3).fill('Bearer mock-key-A'),'Bearer mock-key-B']:['Bearer mock-key-A','Bearer mock-key-A']);}finally{await f.cleanup();}
    }
  });
  await t.test('key polling, native Chat fields, model alias and exact usage',async()=>{
    const f=await fixture();try{
      const ch=f.app.store.config.channels[0];await f.admin('/api/channels/'+ch.id,{model_mapping:{alias:'a'}},'PUT');
      for(let n=0;n<3;n++){const r=await f.api({model:'alias',messages:[{role:'user',content:'hi'}],tools:[{type:'function',function:{name:'demo',parameters:{type:'object'}}}],reasoning_effort:'low'});assert.equal(r.status,200);await r.json();}
      assert.deepEqual(f.received.map(r=>r.key),['Bearer mock-key-A','Bearer mock-key-B','Bearer mock-key-A']);assert.ok(f.received.every(r=>r.body.model==='a'&&r.body.tools[0].function.name==='demo'&&r.body.reasoning_effort==='low'));
      const stats=f.app.telemetry.stats.total;assert.equal(stats.requests,3);assert.equal(stats.attempts,3);assert.equal(stats.input,36);assert.equal(stats.output,12);assert.equal(stats.cached,9);assert.equal(stats.reported,3);
    }finally{await f.cleanup();}
  });
  await t.test('401 cooldown expires automatically, 429 cools keys, and an exhausted pool fails immediately',async()=>{
    let phase='auth';const f=await fixture((req,res,r)=>{if(phase==='auth'&&r.key.endsWith('A'))return reply(res,401,{error:'invalid'});if(phase==='rate')return reply(res,429,{error:'rate'},{'retry-after':'60'});complete(res,r.body);});
    try{
      let response=await f.api({model:'a',messages:[{role:'user',content:'hi'}]});assert.equal(response.status,200);await response.json();
      const [a,b]=f.app.store.config.channels[0].keys;assert.equal(f.app.telemetry.key(a.id).auth_error,true);assert.equal(f.received.length,2);
      response=await f.api({model:'a',messages:[{role:'user',content:'hi'}]});await response.json();assert.equal(f.received.at(-1).key,'Bearer mock-key-B');
      phase='ok';f.app.telemetry.key(a.id).cooldown_until=Date.now()-1;response=await f.api({model:'a',messages:[{role:'user',content:'recovered'}]});assert.equal(response.status,200);await response.json();assert.equal(f.received.at(-1).key,'Bearer mock-key-A');assert.equal(f.app.telemetry.key(a.id).auth_error,false);
      phase='rate';f.app.telemetry.resetKey(a.id);response=await f.api({model:'a',messages:[{role:'user',content:'hi'}]});assert.equal(response.status,429);assert.ok(Number(response.headers.get('retry-after'))>=59);await response.json();assert.ok(f.app.telemetry.key(b.id).cooldown_until>Date.now()+55000);
      const count=f.received.length;response=await f.api({model:'a',messages:[{role:'user',content:'hi'}]});assert.equal(response.status,503);assert.equal(f.received.length,count);
    }finally{await f.cleanup();}
  });
  await t.test('400 exhausts keys; priority failover attributes every upstream attempt',async()=>{
    let phase='bad';const f=await fixture((req,res,r)=>{if(phase==='bad')return reply(res,400,{error:'bad parameter'});if(r.key.endsWith('A')||r.key.endsWith('B'))return reply(res,503,{error:'unavailable'});complete(res,r.body);});
    try{let response=await f.api({model:'a',messages:[{role:'user',content:'hi'}]});assert.equal(response.status,400);await response.json();assert.equal(f.received.length,2);phase='fallback';for(const key of f.app.store.config.channels[0].keys)f.app.telemetry.resetKey(key.id);await f.admin('/api/channels',{name:'fallback',base_url:f.app.store.config.channels[0].base_url,priority:2,models:['a'],keys:['mock-key-C'],groups:['default']});response=await f.api({model:'a',messages:[{role:'user',content:'hi'}]});assert.equal(response.status,200);await response.json();assert.deepEqual(f.received.slice(2).map(r=>r.key),['Bearer mock-key-A','Bearer mock-key-B','Bearer mock-key-C']);assert.equal(f.app.telemetry.stats.total.requests,2);assert.equal(f.app.telemetry.stats.total.attempts,5);const channels=f.app.store.config.channels;assert.equal(f.app.telemetry.stats.dimensions.channel[channels[0].id].attempts,4);assert.equal(f.app.telemetry.stats.dimensions.channel[channels[1].id].attempts,1);}finally{await f.cleanup();}
  });
  await t.test('all upstream HTTP error classes retry before key failover, including redirects and vendor codes',async()=>{
    for(const status of [300,302,304,400,401,402,403,404,408,409,422,429,500,502,503,504,529,599]){
      const f=await fixture((req,res,r)=>r.key.endsWith('A')?reply(res,status,{error:'mock upstream error'}):complete(res,r.body));
      try{
        await f.admin('/api/settings',{max_attempts:2,retry_interval_ms:100},'PUT');
        const response=await f.api({model:'a',messages:[{role:'user',content:'hi'}]});assert.equal(response.status,200,`upstream ${status}`);await response.json();
        assert.deepEqual(f.received.map(r=>r.key),['Bearer mock-key-A','Bearer mock-key-A','Bearer mock-key-B'],`upstream ${status}`);
        const [a,b]=f.app.store.config.channels[0].keys;assert.equal(f.app.telemetry.keyMetrics(a.id).fail,2);assert.equal(f.app.telemetry.keyMetrics(b.id).ok,1);assert.ok(f.app.telemetry.key(a.id).cooldown_until>Date.now());assert.equal(f.app.telemetry.stats.total.attempts,3);
      }finally{await f.cleanup();}
    }
  });
  await t.test('real Chat stream arrives before completion and UTF-8 usage parsing survives split buffers',async()=>{
    const f=await fixture((req,res,r)=>complete(res,r.body,'你好 🌍',180));try{const response=await f.api({model:'a',messages:[{role:'user',content:'hi'}],stream:true});const reader=response.body.getReader();const first=await reader.read();assert.ok(Buffer.from(first.value).toString().includes('data:'));assert.equal(f.app.gateway.active,1);const chunks=[Buffer.from(first.value)];while(true){const item=await reader.read();if(item.done)break;chunks.push(Buffer.from(item.value));}assert.ok(Buffer.concat(chunks).toString('utf8').includes('你好 🌍'));assert.equal(f.app.telemetry.stats.total.output,4);assert.equal(f.app.telemetry.stats.total.reported,1);}finally{await f.cleanup();}
  });
  await t.test('native Responses preserves tools, previous_response_id and emits actual increments',async()=>{
    const f=await fixture((req,res,r)=>{assert.equal(r.url,'/v1/responses');assert.equal(r.body.previous_response_id,'resp_previous');assert.equal(r.body.tools[0].type,'function');res.writeHead(200,{'content-type':'text/event-stream'});res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({type:'response.output_text.delta',delta:'hello'})}\n\n`);setTimeout(()=>res.end(`event: response.completed\ndata: ${JSON.stringify({type:'response.completed',response:{status:'completed',usage:{input_tokens:7,output_tokens:2,total_tokens:9}}})}\n\n`),100);});try{const response=await f.api({model:'a',input:'hi',stream:true,previous_response_id:'resp_previous',tools:[{type:'function',name:'demo',parameters:{type:'object'}}]},'responses');const reader=response.body.getReader();const first=await reader.read();assert.ok(Buffer.from(first.value).toString().includes('hello'));assert.equal(f.app.gateway.active,1);while(!(await reader.read()).done){}assert.equal(f.app.telemetry.stats.total.input,7);}finally{await f.cleanup();}
  });
  await t.test('explicit text bridge is incremental and rejects unsupported input without upstream call',async()=>{
    const f=await fixture();try{const ch=f.app.store.config.channels[0];await f.admin('/api/channels/'+ch.id,{protocols:['chat'],responses_mode:'chat_bridge'},'PUT');let response=await f.api({model:'a',input:'hi',stream:true,max_output_tokens:60},'responses');assert.equal(response.status,200);const events=await sse(response);assert.ok(events.some(e=>e.type==='response.output_text.delta'));assert.equal(events.at(-1).type,'response.completed');assert.equal(events.at(-1).data.response.output_text,'answer:a');assert.equal(f.received[0].body.max_completion_tokens,60);const count=f.received.length;response=await f.api({model:'a',input:[{role:'user',content:[{type:'input_image',image_url:'https://example.com/image.png'}]}]},'responses');assert.equal(response.status,400);assert.equal(f.received.length,count);}finally{await f.cleanup();}
  });
  await t.test('client cancel aborts upstream; successful-header stream failure is never replayed',async()=>{
    let closed=false,phase='slow';const f=await fixture((req,res,r)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');res.on('close',()=>closed=true);if(phase==='broken')setTimeout(()=>res.end(),30);});
    try{const controller=new AbortController();const response=await fetch(f.base+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer test-client-token','content-type':'application/json'},body:JSON.stringify({model:'a',messages:[{role:'user',content:'hi'}],stream:true}),signal:controller.signal});await response.body.getReader().read();controller.abort();await waitUntil(()=>closed&&f.app.gateway.active===0);assert.equal(f.app.telemetry.stats.recent[0].status,499);phase='broken';for(const key of f.app.store.config.channels[0].keys)f.app.telemetry.resetKey(key.id);const broken=await f.api({model:'a',messages:[{role:'user',content:'hi'}],stream:true});const raw=await broken.text();assert.ok(raw.includes('incomplete_stream'));assert.equal(f.received.length,2);}finally{await f.cleanup();}
  });
  await t.test('request timeout is bounded and pause retains management access',async()=>{
    const f=await fixture(()=>{});try{await f.admin('/api/settings',{request_timeout_ms:1000},'PUT');const started=Date.now();const response=await f.api({model:'a',messages:[{role:'user',content:'hi'}]});assert.equal(response.status,504);assert.ok(Date.now()-started<2200);await f.admin('/api/settings',{paused:true},'PUT');assert.equal((await f.api({model:'a',messages:[{role:'user',content:'hi'}]})).status,503);assert.equal((await f.admin('/api/status')).response.status,200);}finally{await f.cleanup();}
  });



  await t.test('usage missing stays unknown; stats, stable IDs and round-robin cursor survive restart',async()=>{
    const f=await fixture((req,res,r)=>reply(res,200,{choices:[{message:{role:'assistant',content:'without usage'}}]}));let restored;
    try{const response=await f.api({model:'a',messages:[{role:'user',content:'hi'}]});await response.json();const keyId=f.app.store.config.channels[0].keys[0].id;assert.equal(f.app.telemetry.stats.total.unknown,1);assert.equal(f.app.telemetry.stats.total.reported,0);await f.app.close();restored=createApp({dataDir:f.dir,port:0});assert.equal(restored.telemetry.stats.total.requests,1);assert.equal(restored.telemetry.stats.total.unknown,1);assert.equal(restored.store.config.channels[0].keys[0].id,keyId);assert.equal(restored.telemetry.runtime.cursors[restored.store.config.channels[0].id],1);await restored.close();}finally{if(restored)await restored.close();await f.cleanup();}
  });
  await t.test('finite batch rejects unbounded work and stops; discovery is an explicit models request',async()=>{
    const f=await fixture();try{assert.equal((await f.admin('/api/batch/start',{model:'a',rounds:0})).response.status,400);assert.equal((await f.admin('/api/batch/start',{model:'a',rounds:100})).response.status,400);const ch=f.app.store.config.channels[0];const discovered=await f.admin(`/api/channels/${ch.id}/discover`,{});assert.deepEqual(discovered.data.models,['a','b']);assert.equal(f.received[0].url,'/v1/models');const started=await f.admin('/api/batch/start',{model:'a',rounds:1,delay_ms:100});assert.equal(started.response.status,200);await waitUntil(()=>!f.app.batch.current.running);assert.equal(f.app.batch.current.completed,2);assert.equal(f.app.batch.current.ok,2);}finally{await f.cleanup();}
  });
  await t.test('graceful shutdown waits for background cancellation before saving final statistics',async()=>{
    const f=await fixture(()=>{});try{await f.admin('/api/batch/start',{model:'a',rounds:1});await waitUntil(()=>f.app.gateway.active===1);await f.app.close();const disk=JSON.parse(fs.readFileSync(path.join(f.dir,'stats.json'),'utf8'));assert.equal(disk.total.requests,1);assert.equal(disk.total.cancelled,1);assert.equal(f.app.batch.current.running,false);}finally{await f.cleanup();}
  });
  await t.test('model labels cannot pollute statistics maps and bounded log rotation retains totals',async()=>{
    const f=await fixture();try{const ch=f.app.store.config.channels[0];await f.admin('/api/channels/'+ch.id,{models:['a','__proto__']},'PUT');const response=await f.api({model:'__proto__',messages:[{role:'user',content:'hi'}]});assert.equal(response.status,200);await response.json();assert.ok(Object.hasOwn(f.app.telemetry.stats.dimensions.model,'__proto__'));assert.equal(f.app.telemetry.stats.dimensions.model.__proto__.requests,1);await f.admin('/api/settings',{log_max_mb:1},'PUT');const log=path.join(f.dir,'logs','requests.jsonl');fs.writeFileSync(log,'x'.repeat(1024*1024+1));const again=await f.api({model:'a',messages:[{role:'user',content:'hi'}]});await again.json();assert.ok(fs.existsSync(path.join(f.dir,'logs','requests.1.jsonl')));assert.equal(f.app.telemetry.stats.total.requests,2);}finally{await f.cleanup();}
  });
  await t.test('changing credentials is atomic by reference; only current and previous credentials remain',async()=>{
    const f=await fixture();try{const ch=f.app.store.config.channels[0],oldId=ch.keys[0].id;await f.admin('/api/channels/'+ch.id,{keys:[{id:oldId,value:'replacement-secret'}]},'PUT');const nextId=f.app.store.config.channels[0].keys[0].id;assert.notEqual(nextId,oldId);let secrets=JSON.parse(fs.readFileSync(path.join(f.dir,'secrets.json'),'utf8')).credentials;assert.ok(secrets[oldId]);assert.equal(secrets[nextId],'replacement-secret');await f.admin('/api/settings',{max_attempts:4},'PUT');secrets=JSON.parse(fs.readFileSync(path.join(f.dir,'secrets.json'),'utf8')).credentials;assert.ok(!Object.hasOwn(secrets,oldId));assert.equal(new ConfigStore(f.dir).config.channels[0].keys[0].value,'replacement-secret');}finally{await f.cleanup();}
  });
  await t.test('configured forwarding preserves full payload and returns only the original model without waiting',async()=>{
    const f=await fixture((req,res,r)=>complete(res,r.body,`answer:${r.body.model}`,r.body.model==='b'?450:50));
    try{
      await f.admin('/api/forwarding',{enabled:true,source_models:['a'],target_model:'b',max_output_tokens:8},'PUT');
      const messages=[{role:'system',content:'system'},{role:'user',content:'old'},{role:'assistant',content:'original'},{role:'user',content:'new'}];
      const response=await f.api({model:'a',messages,max_tokens:20,tools:[{type:'function',function:{name:'demo'}}],reasoning_effort:'low'});
      assert.equal(response.status,200);assert.equal((await response.json()).choices[0].message.content,'answer:a');
      await waitUntil(()=>f.received.some(r=>r.body.model==='b'));
      assert.equal(f.app.forwarding.snapshot().active,1);
      const mirror=f.received.find(r=>r.body.model==='b');assert.deepEqual(mirror.body.messages,messages);assert.equal(mirror.body.tools[0].function.name,'demo');assert.equal(mirror.body.reasoning_effort,'low');assert.equal(mirror.body.max_tokens,8);
      await waitUntil(()=>f.app.forwarding.snapshot().active===0);
      assert.equal(f.app.forwarding.snapshot().completed,1);assert.equal(f.app.telemetry.stats.total.forwarded,1);assert.equal(f.app.telemetry.stats.total.requests,2);
      assert.equal(f.app.telemetry.stats.recent.find(e=>e.source==='forward').request_id,f.app.telemetry.stats.recent.find(e=>e.source==='api').request_id);
    }finally{await f.cleanup();}
  });
  await t.test('disabled or unmatched forwarding stays single-model and target never forwards to itself',async()=>{
    const f=await fixture();try{
      await f.admin('/api/forwarding',{enabled:false,target_model:'b'},'PUT');let response=await f.api({model:'a',messages:[{role:'user',content:'hi'}]});await response.json();assert.equal(f.received.length,1);
      await f.admin('/api/forwarding',{enabled:true,source_models:['b']},'PUT');response=await f.api({model:'a',messages:[{role:'user',content:'hi'}]});await response.json();response=await f.api({model:'b',messages:[{role:'user',content:'hi'}]});await response.json();assert.equal(f.received.length,3);assert.equal(f.app.forwarding.snapshot().submitted,0);
    }finally{await f.cleanup();}
  });
  await t.test('forward failure and target permission denial cannot change the primary response',async()=>{
    const f=await fixture((req,res,r)=>r.body.model==='b'?reply(res,503,{error:'target failure'}):complete(res,r.body));try{
      await f.admin('/api/forwarding',{enabled:true,target_model:'b'},'PUT');const response=await f.api({model:'a',messages:[{role:'user',content:'hi'}]});assert.equal(response.status,200);await response.json();await waitUntil(()=>f.app.forwarding.snapshot().active===0);assert.equal(f.app.forwarding.snapshot().failed,1);
      const token=f.app.store.config.tokens[0];await f.admin('/api/tokens/'+token.id,{models:['a']},'PUT');const count=f.received.length;const next=await f.api({model:'a',messages:[{role:'user',content:'hi'}]});assert.equal(next.status,200);await next.json();assert.equal(f.received.length,count+1);assert.equal(f.app.forwarding.snapshot().skipped,1);
    }finally{await f.cleanup();}
  });
  await t.test('streaming forwards independently, preserves original chunks and cancels both on disconnect',async()=>{
    let closed=0;const f=await fixture((req,res,r)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({choices:[{delta:{content:r.body.model==='a'?'source-only':'target-hidden'}}]})}\n\n`);res.on('close',()=>closed++);});
    try{await f.admin('/api/forwarding',{enabled:true,target_model:'b'},'PUT');const controller=new AbortController();const response=await fetch(f.base+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer test-client-token','content-type':'application/json'},body:JSON.stringify({model:'a',messages:[{role:'user',content:'hi'}],stream:true}),signal:controller.signal});const first=await response.body.getReader().read();assert.ok(Buffer.from(first.value).toString().includes('source-only'));assert.ok(!Buffer.from(first.value).toString().includes('target-hidden'));await waitUntil(()=>f.received.length===2);controller.abort();await waitUntil(()=>closed===2&&f.app.gateway.active===0&&f.app.forwarding.snapshot().active===0);}finally{await f.cleanup();}
  });
  await t.test('Responses forwarding keeps endpoint, tools and input while returning source JSON',async()=>{
    const f=await fixture((req,res,r)=>{
      if(r.body.stream){res.writeHead(200,{'content-type':'text/event-stream'});return res.end(`data: ${JSON.stringify({type:'response.completed',response:{status:'completed',usage:{input_tokens:10,output_tokens:2}}})}\n\n`);}
      reply(res,200,{object:'response',model:r.body.model,output_text:'source response',usage:{input_tokens:5,output_tokens:1}});
    });try{await f.admin('/api/forwarding',{enabled:true,target_model:'b'},'PUT');const input=[{role:'user',content:[{type:'input_text',text:'hello'}]}],tools=[{type:'function',name:'demo',parameters:{type:'object'}}];const response=await f.api({model:'a',input,tools,max_output_tokens:10},'responses');assert.equal((await response.json()).model,'a');await waitUntil(()=>f.app.forwarding.snapshot().active===0);const mirror=f.received.find(r=>r.body.model==='b');assert.equal(mirror.url,'/v1/responses');assert.deepEqual(mirror.body.input,input);assert.deepEqual(mirror.body.tools,tools);}finally{await f.cleanup();}
  });
  await t.test('exports only own config; old import, comparison and acceptance endpoints are absent',async()=>{
    const f=await fixture();try{
      const safe=await f.admin('/api/export',{});assert.equal(safe.data.schema_version,2);assert.ok(!JSON.stringify(safe.data).includes('mock-key-A'));assert.ok(!Object.hasOwn(safe.data,'fanout_groups'));
      const full=await f.admin('/api/export',{include_api_keys:true});assert.equal(full.data.channels[0].keys[0].value,'mock-key-A');assert.equal(full.data.tokens[0].value,'test-client-token');
      for(const url of ['/api/import/preview','/api/import/local-preview','/api/import/apply','/api/fanout_groups','/api/sessions'])assert.equal((await f.admin(url,{})).response.status,404);
      assert.equal((await f.api({models:['a','b'],messages:[{role:'user',content:'hi'}]},'compare')).status,404);
      const html=await(await fetch(f.base+'/')).text();assert.ok(!/OVERVIEW|一眼了解你的网关|采纳|uni-gateway|配置与迁移/.test(html));
      assert.equal(f.app.store.config.settings.port,3000);
    }finally{await f.cleanup();}
  });
  await t.test('a running background call cannot occupy the primary request capacity',async()=>{
    const f=await fixture((req,res,r)=>complete(res,r.body,`answer:${r.body.model}`,r.body.model==='b'?500:10));
    try{await f.admin('/api/settings',{max_concurrency:1},'PUT');await f.admin('/api/forwarding',{enabled:true,target_model:'b'},'PUT');const first=await f.api({model:'a',messages:[{role:'user',content:'first'}]});await first.json();await waitUntil(()=>f.app.forwarding.snapshot().active===1);const second=await f.api({model:'a',messages:[{role:'user',content:'second'}]});assert.equal(second.status,200);assert.equal((await second.json()).choices[0].message.content,'answer:a');}finally{await f.cleanup();}
  });
  await t.test('live key activity counts concurrent primary and forwarded calls without persisting active state',async()=>{
    const f=await fixture((req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"started"}}]}\n\n');});let restored;
    try{
      const ch=f.app.store.config.channels[0],key=ch.keys[0];await f.admin('/api/channels/'+ch.id,{keys:[{id:key.id}]},'PUT');await f.admin('/api/forwarding',{enabled:true,target_model:'b'},'PUT');
      const controller=new AbortController();const response=await fetch(f.base+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer test-client-token','content-type':'application/json'},body:JSON.stringify({model:'a',messages:[{role:'user',content:'hi'}],stream:true}),signal:controller.signal});await response.body.getReader().read();await waitUntil(()=>f.received.length===2);
      const state=()=>f.admin('/api/status');let current=(await state()).data.config.channels[0].keys[0].runtime;
      assert.equal(current.active,2);assert.equal(current.primary_active,1);assert.equal(current.forward_active,1);assert.equal(current.metrics.completed,0);assert.equal(current.metrics.success_rate,null);
      controller.abort();await waitUntil(()=>f.app.gateway.active===0&&f.app.forwarding.snapshot().active===0);
      current=(await state()).data.config.channels[0].keys[0].runtime;assert.equal(current.active,0);assert.equal(current.metrics.fail,2);assert.equal(current.metrics.completed,2);assert.equal(current.metrics.success_rate,0);
      await f.app.close();restored=createApp({dataDir:f.dir,port:0});assert.equal(restored.gateway.keyActivity(key.id).active,0);assert.equal(restored.telemetry.keyMetrics(key.id).fail,2);
    }finally{if(restored)await restored.close();await f.cleanup();}
  });
  await t.test('retry moves active highlight between keys and successful completions determine success rate',async()=>{
    const f=await fixture((req,res,r)=>r.key.endsWith('A')?reply(res,429,{error:'rate'}):complete(res,r.body,'retry success',200));
    try{const [a,b]=f.app.store.config.channels[0].keys;const response=await f.api({model:'a',messages:[{role:'user',content:'hi'}],stream:true});
      const during=(await f.admin('/api/status')).data.config.channels[0].keys;
      assert.equal(during[0].runtime.active,0);assert.equal(during[0].runtime.metrics.fail,1);assert.equal(during[0].runtime.metrics.success_rate,0);assert.equal(during[1].runtime.active,1);assert.equal(during[1].runtime.metrics.success_rate,null);
      await response.text();assert.equal(f.app.gateway.keyActivity(b.id).active,0);assert.equal(f.app.telemetry.keyMetrics(b.id).success_rate,1);assert.equal(f.app.telemetry.keyMetrics(a.id).completed,1);
    }finally{await f.cleanup();}
  });
  await t.test('cancellation before upstream headers records one finished attempt and releases key activity',async()=>{
    const f=await fixture(()=>{});try{const controller=new AbortController();const pending=fetch(f.base+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer test-client-token','content-type':'application/json'},body:JSON.stringify({model:'a',messages:[{role:'user',content:'hi'}]}),signal:controller.signal}).catch(()=>{});await waitUntil(()=>f.received.length===1);const key=f.app.store.config.channels[0].keys[0];assert.equal(f.app.gateway.keyActivity(key.id).active,1);controller.abort();await pending;await waitUntil(()=>f.app.gateway.active===0);const metrics=f.app.telemetry.keyMetrics(key.id);assert.equal(metrics.attempts,1);assert.equal(metrics.fail,1);assert.equal(metrics.completed,1);assert.equal(f.app.gateway.keyActivity(key.id).active,0);}finally{await f.cleanup();}
  });

  await t.test('Docker launcher switches a local instance and reuses only an actual Docker instance',async()=>{
    let service={mode:'local',port:3000};const actions=[];
    const run=async(command,args)=>{actions.push(args.join(' '));if(args.includes('stop'))service=null;if(args.includes('up'))service={mode:'docker',port:3000};};
    const result=await ensureService({docker:true,getRunning:async()=>service,run,delay:async()=>{},beforeStop:async()=>{actions.push('idle');}});
    assert.equal(result.mode,'docker');assert.ok(actions.findIndex(x=>x.startsWith('info '))<actions.findIndex(x=>x.endsWith(' stop')));assert.ok(actions.findIndex(x=>x.endsWith(' stop'))<actions.findIndex(x=>x.startsWith('compose up')));
    await ensureService({docker:true,getRunning:async()=>service,run:async()=>assert.fail('A running Docker instance should be reused')});
  });
  await t.test('unavailable Docker preserves the local service and partial startup failure rolls back safely',async()=>{
    const original={mode:'local',port:3000};let service=original;
    await assert.rejects(ensureService({docker:true,getRunning:async()=>service,run:async(command,args)=>{assert.equal(args[0],'info');throw new Error('daemon unavailable');}}),/daemon unavailable/);assert.equal(service,original);
    const actions=[];const run=async(command,args)=>{actions.push(args.join(' '));if(args.includes('up')){service={mode:'docker',port:3000};throw new Error('build failed');}if(args.includes('stop'))service=null;if(args.includes('start'))service=original;};
    await assert.rejects(ensureService({docker:true,getRunning:async()=>service,run,delay:async()=>{},beforeStop:async()=>{}}),/已恢复原本地服务/);
    assert.equal(service,original);assert.ok(actions.indexOf('compose stop')<actions.findIndex(x=>x.includes('start --port 3000')));
  });

});
