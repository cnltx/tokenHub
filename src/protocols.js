'use strict';
const { HttpError, id } = require('./util');

function textContent(content) {
  if (typeof content==='string') return content;
  if (!Array.isArray(content)) throw new HttpError(400,'Chat 转换仅支持文本 input','unsupported_conversion');
  return content.map(part=>{
    if (!['input_text','output_text','text'].includes(part.type) || typeof part.text!=='string') throw new HttpError(400,'图片、文件或工具结果请使用原生 Responses 渠道','unsupported_conversion');
    return part.text;
  }).join('');
}
function responsesToChat(body) {
  for (const field of ['tools','tool_choice','previous_response_id','include','conversation','background','text','truncation']) if (body[field]!=null && body[field]!==false) throw new HttpError(400,`${field} 不在纯文本 Chat 转换范围；请选择原生 Responses 渠道`,'unsupported_conversion');
  if (body.store===true || body.reasoning?.summary) throw new HttpError(400,'Chat 转换不支持响应存储或 reasoning.summary','unsupported_conversion');
  const messages=[];
  if (body.instructions) messages.push({role:'system',content:textContent(body.instructions)});
  if (typeof body.input==='string') messages.push({role:'user',content:body.input});
  else if (Array.isArray(body.input)) for (const item of body.input) {
    if (item.type && item.type!=='message') throw new HttpError(400,'工具调用与工具结果需使用原生 Responses 渠道','unsupported_conversion');
    if (!['user','assistant','system','developer'].includes(item.role)) throw new HttpError(400,'不支持的 input 角色','unsupported_conversion');
    messages.push({role:item.role,content:textContent(item.content)});
  }
  if (!messages.length) throw new HttpError(400,'input 不能为空','invalid_request');
  const result={ model:body.model, messages, stream:body.stream===true };
  for (const field of ['temperature','top_p']) if (body[field]!=null) result[field]=body[field];
  if (body.max_output_tokens!=null) result.max_completion_tokens=body.max_output_tokens;
  if (body.reasoning?.effort) result.reasoning_effort=body.reasoning.effort;
  return result;
}
function chatToResponse(data, model, responseId=id('resp')) {
  const content=data?.choices?.[0]?.message?.content;
  if (typeof content!=='string') throw new HttpError(502,'上游未返回可转换的文本消息','invalid_upstream_response');
  const usage=data.usage;
  return { id:responseId, object:'response', created_at:Math.floor(Date.now()/1000), status:'completed', model, output:[{id:id('msg'),type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:content,annotations:[]}]}], output_text:content, error:null, incomplete_details:null, usage:usage?{input_tokens:usage.prompt_tokens,output_tokens:usage.completion_tokens,total_tokens:usage.total_tokens ?? usage.prompt_tokens+usage.completion_tokens,input_tokens_details:{cached_tokens:usage.prompt_tokens_details?.cached_tokens||0}}:null };
}
class ResponsesBridge {
  constructor(model, emit) { this.model=model; this.emit=emit; this.responseId=id('resp'); this.itemId=id('msg'); this.text=''; this.seq=0; this.started=false; }
  send(type, extra={}) { this.emit(type,{ type, sequence_number:this.seq++, ...extra }); }
  start() {
    if (this.started) return; this.started=true;
    const response={id:this.responseId,object:'response',created_at:Math.floor(Date.now()/1000),status:'in_progress',model:this.model,output:[],error:null};
    this.send('response.created',{response}); this.send('response.in_progress',{response});
    this.send('response.output_item.added',{output_index:0,item:{id:this.itemId,type:'message',role:'assistant',status:'in_progress',content:[]}});
    this.send('response.content_part.added',{item_id:this.itemId,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
  }
  consume(data) {
    this.start(); const delta=data?.choices?.[0]?.delta;
    if (delta?.tool_calls) throw new HttpError(502,'纯文本转换收到工具调用，请改用原生 Responses','unsupported_conversion');
    if (typeof delta?.content==='string') { this.text+=delta.content; this.send('response.output_text.delta',{item_id:this.itemId,output_index:0,content_index:0,delta:delta.content}); }
  }
  end(usage) {
    this.start(); const part={type:'output_text',text:this.text,annotations:[]};
    this.send('response.output_text.done',{item_id:this.itemId,output_index:0,content_index:0,text:this.text});
    this.send('response.content_part.done',{item_id:this.itemId,output_index:0,content_index:0,part});
    const item={id:this.itemId,type:'message',role:'assistant',status:'completed',content:[part]};
    this.send('response.output_item.done',{output_index:0,item});
    const response=chatToResponse({choices:[{message:{content:this.text}}],usage:usage?{prompt_tokens:usage.input,completion_tokens:usage.output,total_tokens:usage.input+usage.output,prompt_tokens_details:{cached_tokens:usage.cached}}:undefined},this.model,this.responseId);
    response.output=[item]; this.send('response.completed',{response});
    return response;
  }
}
module.exports={ responsesToChat, chatToResponse, ResponsesBridge };
