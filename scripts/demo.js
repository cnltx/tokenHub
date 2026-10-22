'use strict';
// Isolated, local mock upstream for UI verification. Never reads the user's data directory.
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {createApp}=require('../src/server');
const {sleep}=require('../src/util');
const dataDir=path.join(__dirname,'..','.tmp','browser-demo');
const chunkDelay=Math.min(1000,Math.max(1,Number(process.env.TOKENHUB_DEMO_CHUNK_MS)||65));
let app;
const provider=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  if(req.url==='/v1/models'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({data:[{id:'demo-fast'},{id:'demo-think'}]}));}
  const body=JSON.parse(raw||'{}');
  const text=body.model==='demo-fast'?'这是来自快速模型的本地演示回复。\n\n客户端收到的是它请求的模型结果。所有请求仅发送到本机模拟服务。':'这是后台转发目标的模拟回复。\n\n1. 统一管理渠道与 Key。\n2. 按优先级自动路由。\n3. 根据配置额外转发到目标模型。\n\n演示使用模拟用量，不消耗真实模型额度。';
  const usage={prompt_tokens:48+body.messages.length*5,completion_tokens:Math.ceil(text.length/2),total_tokens:150,prompt_tokens_details:{cached_tokens:12}};
  if(!body.stream){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({choices:[{message:{role:'assistant',content:text},finish_reason:'stop'}],usage}));}
  res.writeHead(200,{'content-type':'text/event-stream'});const controller=new AbortController();res.on('close',()=>controller.abort());
  try{for(let i=0;i<text.length;i+=6){res.write(`data: ${JSON.stringify({choices:[{delta:{content:text.slice(i,i+6)},finish_reason:null}]})}\n\n`);await sleep(chunkDelay,controller.signal);}res.end(`data: ${JSON.stringify({choices:[],usage})}\n\ndata: [DONE]\n\n`);}catch{res.end();}
});
(async()=>{
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  app=createApp({dataDir,port:Number(process.env.TOKENHUB_DEMO_PORT)||8901,onShutdown:shutdown});
  if(!app.store.config.channels.length)app.store.update({settings:app.store.config.settings,channels:[{name:'本地演示 · 模拟上游',base_url:`http://127.0.0.1:${provider.address().port}/v1`,keys:['demo-only-key-1','demo-only-key-2'],models:['demo-fast','demo-think'],groups:['default']}],tokens:[{name:'演示客户端',value:'demo-client-only',group:'default'}],forwarding:{enabled:true,source_models:['demo-fast'],target_model:'demo-think',max_output_tokens:128,max_concurrency:2}});
  else {const next=structuredClone(app.store.config);next.forwarding={enabled:true,source_models:['demo-fast'],target_model:'demo-think',max_output_tokens:128,max_concurrency:2};next.channels[0].base_url=`http://127.0.0.1:${provider.address().port}/v1`;app.store.update(next);}
  await app.listen();console.log('演示后台免登录');
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
})().catch(async error=>{console.error(error.message);if(app)await app.close();provider.close();process.exitCode=1;});
async function shutdown(){if(app)await app.close();provider.closeAllConnections();provider.close();}
