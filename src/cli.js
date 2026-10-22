'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {createApp}=require('./server');
const {readJson,atomicJson}=require('./util');

const args=process.argv.slice(2),command=args[0]||'start';
const option=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
const dataDir=path.resolve(option('--data')||process.env.TOKENHUB_DATA_DIR||path.join(__dirname,'..','data'));
const lockFile=path.join(dataDir,'service.json');
function openBrowser(url){if(process.platform==='win32'){const child=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{stdio:'ignore',windowsHide:true,detached:true});child.on('error',()=>console.error('无法自动打开浏览器，请运行 node src/cli.js ui。'));child.unref();}else{const child=spawn(process.platform==='darwin'?'open':'xdg-open',[url],{stdio:'ignore',detached:true});child.on('error',()=>console.error('请使用终端显示的本地地址打开浏览器。'));child.unref();}}
async function running(){const lock=readJson(lockFile,null);if(!lock)return null;try{const response=await fetch(`http://127.0.0.1:${lock.port}/health`,{signal:AbortSignal.timeout(2000)});const health=await response.json();return health.name==='tokenHub'&&health.instance===lock.instance?lock:null;}catch{return null;}}
async function main(){
  if(command==='status'){const lock=await running();console.log(lock?`tokenHub 运行中：http://127.0.0.1:${lock.port}`:'tokenHub 未运行');return;}
  if(command==='stop'){
    const lock=await running();if(!lock){console.log('没有找到本目录所属的 tokenHub 服务。');return;}
    if(lock.mode==='docker')throw new Error('此实例由 Docker 管理，请使用 docker compose stop 停止。');
    const base=`http://127.0.0.1:${lock.port}`;
    const session=await fetch(base+'/api/session',{signal:AbortSignal.timeout(3000)});
    if(!session.ok)throw new Error('无法连接管理接口，未停止任何进程。');
    const {csrf}=await session.json();
    const response=await fetch(base+'/api/shutdown',{method:'POST',headers:{'x-csrf-token':csrf},signal:AbortSignal.timeout(3000)});
    if(!response.ok)throw new Error('服务拒绝停止。');console.log('已通知本目录的 tokenHub 正常停止。');return;
  }
  if(command==='ui'){
    const lock=await running();if(!lock)throw new Error('请先启动 tokenHub。');
    openBrowser(`http://127.0.0.1:${lock.port}/`);console.log(`已打开本地面板：http://127.0.0.1:${lock.port}`);return;
  }
  if(command!=='start')throw new Error('命令：start [--open] [--port 3000]、stop、status、ui');
  const existing=await running();
  if(existing){console.log(`tokenHub 已运行：http://127.0.0.1:${existing.port}`);if(args.includes('--open')){openBrowser(`http://127.0.0.1:${existing.port}/`);}return;}
  const requestedPort=option('--port')||process.env.TOKENHUB_PORT;
  if(requestedPort&&(!/^\d+$/.test(requestedPort)||Number(requestedPort)<1||Number(requestedPort)>65535))throw new Error('端口须为 1–65535。');
  let app;
  let stopping=false;
  const shutdown=async()=>{if(stopping)return;stopping=true;await app.close();const lock=readJson(lockFile,null);if(lock?.instance===app.instance&&fs.existsSync(lockFile))fs.unlinkSync(lockFile);console.log('tokenHub 已停止，统计已保存。');};
  app=createApp({dataDir,...(requestedPort?{port:Number(requestedPort)}:{}),onShutdown:shutdown});
  try{await app.listen();}catch(error){app.telemetry.close();if(error.code==='EADDRINUSE')throw new Error(`端口 ${requestedPort||app.store.config.settings.port} 已被占用。请用 --port 指定其它端口；现有服务未被终止。`);throw error;}
  atomicJson(lockFile,{pid:process.pid,port:app.port,instance:app.instance,mode:process.env.TOKENHUB_CONTAINER==='1'?'docker':'local',started_at:Date.now()});
  console.log(`tokenHub v0.2.0 · http://127.0.0.1:${app.port}`);console.log(`API 地址：http://127.0.0.1:${app.port}/v1`);console.log(`监听 ${process.env.TOKENHUB_HOST||'127.0.0.1'}；后台免登录。`);
  if(args.includes('--open'))openBrowser(`http://127.0.0.1:${app.port}/`);
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
if(require.main===module)main().catch(error=>{console.error(`tokenHub：${error.message}`);process.exitCode=1;});
module.exports={main};
