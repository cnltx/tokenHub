'use strict';
const {HttpError,id}=require('./util');

// Mirrored calls never re-enter this service: they go directly to Gateway.execute.
class Forwarding {
  constructor(store,gateway){this.store=store;this.gateway=gateway;this.jobs=new Set();this.controllers=new Set();this.stopping=false;this.status={submitted:0,completed:0,failed:0,skipped:0,last:null};}
  dispatch({body,endpoint='chat/completions',identity,signal,requestId}){
    const rule=this.store.config.forwarding;
    if(this.stopping||!rule.enabled||!rule.target_model||body.model===rule.target_model||rule.source_models.length&&!rule.source_models.includes(body.model))return;
    // Mirror only requests the client was authorized to issue, including their target.
    try{
      if(!this.gateway.channels(identity,body.model,endpoint).length)return;
      if(!this.gateway.channels(identity,rule.target_model,endpoint).length)throw new HttpError(403,'转发目标不在此令牌的分组/模型权限内','forward_forbidden');
      if(this.jobs.size>=rule.max_concurrency)throw new HttpError(429,'后台转发并发已满','forward_busy');
    }catch(error){this.status.skipped++;this.status.last={source_model:body.model,target_model:rule.target_model,status:'skipped',error:this.store.redact(error.message),ts:Date.now()};return;}
    const controller=new AbortController();this.controllers.add(controller);
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const forwarded=structuredClone(body);forwarded.model=rule.target_model;forwarded.stream=true;
    if(endpoint==='responses')forwarded.max_output_tokens=Math.min(Number(body.max_output_tokens)||rule.max_output_tokens,rule.max_output_tokens);
    else if(body.max_completion_tokens!=null)forwarded.max_completion_tokens=Math.min(Number(body.max_completion_tokens)||rule.max_output_tokens,rule.max_output_tokens);
    else forwarded.max_tokens=Math.min(Number(body.max_tokens)||rule.max_output_tokens,rule.max_output_tokens);
    const forwardingId=id('fwd');this.status.submitted++;
    // Let the primary request acquire its slot before a background call competes for capacity.
    const job=Promise.resolve().then(()=>this.gateway.execute({body:forwarded,endpoint,identity,signal:combined,source:'forward',forwardingId,requestId})).then(result=>{
      this.status.completed++;this.status.last={source_model:body.model,target_model:rule.target_model,status:'ok',usage:result.usage,ms:result.ms,ts:Date.now()};
    },error=>{this.status.failed++;this.status.last={source_model:body.model,target_model:rule.target_model,status:'error',error:this.store.redact(error.message),ts:Date.now()};}).finally(()=>{this.jobs.delete(job);this.controllers.delete(controller);});
    this.jobs.add(job);
  }
  snapshot(){return {...this.status,active:this.jobs.size};}
  async close(){this.stopping=true;for(const controller of this.controllers)controller.abort(new HttpError(503,'服务正在停止','server_shutdown'));await Promise.allSettled([...this.jobs]);}
}
module.exports={Forwarding};
