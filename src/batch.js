'use strict';
const {HttpError,id,sleep,number}=require('./util');

class Batch {
  constructor(store,gateway) { this.store=store; this.gateway=gateway; this.current=null; this.controller=null; this.finished=Promise.resolve(); }
  start(body) {
    if (this.current?.running) throw new HttpError(409,'已有批量测试正在运行','batch_busy');
    const rounds=number(body.rounds,1,1,100), workers=number(body.workers,1,1,4), delay=number(body.delay_ms,500,100,60000), maxTokens=number(body.max_tokens,128,1,4096);
    const identity={id:'admin',group:body.group||'*',models:[],admin:true};
    const channels=this.gateway.channels(identity,body.model,'chat/completions');
    if (!channels.length) throw new HttpError(404,'未找到可用模型','model_not_found');
    const keys=channels.flatMap(ch=>ch.keys.filter(k=>k.status==='enabled' && (!body.key_ids?.length||body.key_ids.includes(k.id))).map(k=>k.id));
    if (!keys.length || keys.length*rounds>100) throw new HttpError(400,'批量测试需 1–100 个请求；请减少 Key 或轮次','batch_limit');
    const controller=new AbortController(); this.controller=controller;
    this.current={id:id('batch'),running:true,started_at:Date.now(),requests:keys.length*rounds,completed:0,ok:0,failed:0,usage:{input:0,output:0},reported:0,unknown:0,model:body.model,errors:[]};
    const current=this.current; const jobs=Array.from({length:rounds},()=>keys).flat(); let cursor=0;
    const timer=setTimeout(()=>controller.abort(new HttpError(499,'批量测试达到 5 分钟上限','batch_timeout')),300000);
    const worker=async()=>{
      while (!controller.signal.aborted && cursor<jobs.length) {
        const keyId=jobs[cursor++];
        try { const result=await this.gateway.execute({body:{model:body.model,messages:[{role:'user',content:String(body.prompt||'Reply with OK.').slice(0,8000)}],max_tokens:maxTokens,stream:false},identity,signal:controller.signal,forcedKeyId:keyId,source:'batch'}); current.ok++; if (result.usage) { current.reported++; current.usage.input+=result.usage.input; current.usage.output+=result.usage.output; } else current.unknown++; }
        catch(error) { current.failed++; if (current.errors.length<10) current.errors.push(this.store.redact(error.message)); }
        current.completed++;
        try { await sleep(delay,controller.signal); } catch { break; }
      }
    };
    this.finished=Promise.all(Array.from({length:Math.min(workers,jobs.length)},worker)).finally(()=>{clearTimeout(timer); current.running=false; current.ended_at=Date.now();});
    return this.current;
  }
  stop() { this.controller?.abort(new HttpError(499,'已停止批量测试','cancelled')); return this.current; }
}
module.exports={Batch};
