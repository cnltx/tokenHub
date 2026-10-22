'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {readJson,sleep}=require('./util');
const root=path.join(__dirname,'..');const data=path.join(root,'data');
async function running(){
  const lock=readJson(path.join(data,'service.json'),null);if(!lock)return null;
  try{const response=await fetch(`http://127.0.0.1:${lock.port}/health`,{signal:AbortSignal.timeout(1200)});const status=await response.json();return status.name==='tokenHub'&&status.instance===lock.instance?lock:null;}catch{return null;}
}
function launch(command,args,wait=false){
  const out=fs.openSync(path.join(data,'desktop.log'),'a'),err=fs.openSync(path.join(data,'desktop-error.log'),'a');
  const child=spawn(command,args,{cwd:root,windowsHide:true,detached:!wait,stdio:['ignore',out,err]});fs.closeSync(out);fs.closeSync(err);
  if(wait)return new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(command==='docker'?'Docker 命令失败，请确认 Docker Desktop 已运行并查看本地日志。':'本地服务命令失败，请查看本地日志。')));});
  child.once('error',error=>fs.appendFileSync(path.join(data,'desktop-error.log'),`${error.code||'START_FAILED'}\n`));child.unref();
}
async function waitIdle(service){
  for(let count=0;count<240;count++){
    const response=await fetch(`http://127.0.0.1:${service.port}/api/status`,{signal:AbortSignal.timeout(2000)});
    if(!response.ok)throw new Error('无法确认本地服务状态，未切换运行方式。');
    if((await response.json()).active===0)return;
    await sleep(500);
  }
  throw new Error('本地服务仍有请求进行中，已保留当前服务；请稍后重试 Docker 启动。');
}
async function ensureService({docker=false,getRunning=running,run=launch,delay=sleep,beforeStop=waitIdle}={}){
  let service=await getRunning();
  if(service&&(!docker||service.mode==='docker'))return service;
  const waitFor=async predicate=>{
    for(let count=0;count<60;count++){const current=await getRunning();if(predicate(current))return current;await delay(500);}
    throw new Error('服务未能在 30 秒内完成切换，请查看本地启动日志。');
  };
  if(!docker){run(process.execPath,[path.join(__dirname,'cli.js'),'start']);return waitFor(Boolean);}
  // Check Docker before stopping a healthy local instance.
  await run('docker',['info','--format','{{.ServerVersion}}'],true);
  const previous=service;
  if(previous){
    await beforeStop(previous);
    await run(process.execPath,[path.join(__dirname,'cli.js'),'stop'],true);
    await waitFor(current=>!current);
  }
  try{
    await run('docker',['compose','up','-d','--build'],true);
    return await waitFor(current=>current?.mode==='docker');
  }catch(error){
    if(previous){
      // A partial Compose start must be stopped before the same data is opened locally.
      try{
        await run('docker',['compose','stop'],true);
        run(process.execPath,[path.join(__dirname,'cli.js'),'start','--port',String(previous.port)]);
        await waitFor(current=>current&&current.mode!=='docker');
      }catch{throw new Error('Docker 启动失败，恢复本地服务未完成；请查看日志，避免两个实例共用数据。');}
      throw new Error(`${error.message} 已恢复原本地服务。`);
    }
    throw error;
  }
}
async function main(){
  fs.mkdirSync(data,{recursive:true});const service=await ensureService({docker:process.argv.includes('--docker')});
  if(process.argv.includes('--no-open'))return;
  const url=`http://127.0.0.1:${service.port}/`;
  const browser=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,detached:true,stdio:'ignore'});browser.on('error',()=>{});browser.unref();
}
if(require.main===module)main().catch(error=>{fs.mkdirSync(data,{recursive:true});fs.appendFileSync(path.join(data,'desktop-error.log'),`${new Date().toISOString()} ${error.message}\n`);process.exitCode=1;});
module.exports={main,running,ensureService};
