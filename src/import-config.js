'use strict';
const crypto=require('node:crypto');
const {normalize}=require('./config');
const {HttpError}=require('./util');

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const invalid=message=>{throw new HttpError(400,message,'invalid_import');};
const revision=store=>crypto.createHash('sha256').update(JSON.stringify(store.config)).digest('hex');
function validate(input){
  if(!object(input)||input.schema_version!==2||!Array.isArray(input.channels)||!Array.isArray(input.tokens))invalid('请选择 tokenHub 导出的 schema 2 JSON 配置文件');
  const stringList=(value,label)=>{if(value!==undefined&&(!Array.isArray(value)||value.some(v=>typeof v!=='string')))invalid(label+'须为字符串数组');};
  const secret=value=>{if(!object(value)&&typeof value!=='string')invalid('Key 格式无效');if(object(value)&&value.value!==undefined&&typeof value.value!=='string')invalid('Key 须为文本');};
  for(const ch of input.channels){
    if(!object(ch)||typeof ch.name!=='string'||typeof ch.base_url!=='string'||!Array.isArray(ch.keys))invalid('渠道须包含名称、地址和 Key 列表');
    for(const field of ['models','groups','protocols'])stringList(ch[field],'渠道 '+field);
    if(ch.model_mapping!==undefined&&!object(ch.model_mapping))invalid('模型映射须为对象');
    ch.keys.forEach(secret);
    const values=ch.keys.map(valueOf).filter(Boolean);if(new Set(values).size!==values.length)invalid('文件的渠道中存在重复 Key');
    const ids=ch.keys.filter(object).map(key=>key.id).filter(Boolean);if(new Set(ids).size!==ids.length)invalid('文件的渠道中存在重复 Key ID');
  }
  for(const token of input.tokens){if(!object(token)||typeof token.name!=='string')invalid('客户端令牌格式无效');secret(token);stringList(token.models,'令牌模型');}
  if(input.settings!==undefined&&!object(input.settings))invalid('运行设置须为对象');
  if(input.forwarding!==undefined){if(!object(input.forwarding))invalid('转发规则须为对象');stringList(input.forwarding.source_models,'转发源模型');}
  for(const field of ['channels','tokens']){
    if(new Set(input[field].map(item=>item.name.trim())).size!==input[field].length)invalid('文件中存在重复'+(field==='channels'?'渠道':'令牌')+'名称');
    const ids=input[field].map(item=>item.id).filter(Boolean);if(new Set(ids).size!==ids.length)invalid('文件中存在重复 ID');
  }
}
function match(item,rows){
  const byId=rows.find(row=>item.id&&row.id===item.id),byName=rows.find(row=>row.name===item.name.trim());
  if(byId&&byName&&byId!==byName)invalid('文件的 ID 与名称匹配到不同项目，请先调整名称');
  return byId||byName;
}
function valueOf(item){return typeof item==='string'?item.trim():String(item.value||'').trim();}
function prepareImport(store,options={}){
  if(!object(options))invalid('导入参数须为对象');
  const {config:input,mode='merge',include_settings=false}=options;
  if(typeof include_settings!=='boolean')invalid('导入运行设置须为布尔值');
  validate(input);if(!['merge','replace'].includes(mode))invalid('请选择合并或替换');
  const current=store.config,warnings=[];
  const changes={channels:{added:0,updated:0,removed:0},tokens:{added:0,updated:0,removed:0},supplied_keys:0,retained_keys:0,skipped_tokens:0};
  const channels=mode==='merge'?structuredClone(current.channels):[],tokens=mode==='merge'?structuredClone(current.tokens):[];
  const seenChannels=new Set(),seenTokens=new Set();
  const put=(rows,old,item)=>{const index=old?rows.findIndex(row=>row.id===old.id):-1;if(index<0)rows.push(item);else rows[index]=item;};
  for(const item of input.channels){
    const old=match(item,current.channels);
    if(old&&seenChannels.has(old.id))invalid('多个渠道匹配到同一个现有渠道');
    if(old)seenChannels.add(old.id);
    const sameAddress=old&&old.base_url.replace(/\/+$/,'')===item.base_url.trim().replace(/\/+$/,'');
    const keys=mode==='merge'&&sameAddress?structuredClone(old.keys):[];
    const hasSecrets=item.keys.some(key=>valueOf(key));
    if(!hasSecrets&&sameAddress&&mode==='replace')keys.push(...structuredClone(old.keys));
    let missing=0;
    for(const entry of item.keys){
      const key=typeof entry==='string'?{value:entry}:entry,value=valueOf(key);
      const previous=sameAddress&&(old.keys.find(k=>key.id&&k.id===key.id)||old.keys.find(k=>value&&k.value===value));
      if(value){put(keys,previous,{id:previous?.id,value,status:key.status});changes.supplied_keys++;}
      else if(previous){put(keys,previous,{...previous,status:key.status});}
      else missing++;
    }
    if(missing)warnings.push(`渠道「${item.name.trim()}」有 ${missing} 个 Key 占位项不含凭据，已跳过；原有 Key 按所选方式保留。`);
    changes.retained_keys+=keys.filter(key=>!item.keys.some(k=>valueOf(k)&&valueOf(k)===key.value)).length;
    if(!keys.length)warnings.push(`渠道「${item.name.trim()}」没有可用 Key，导入后需手动添加。`);
    if(!sameAddress&&!hasSecrets&&old?.keys.length)warnings.push(`渠道「${item.name.trim()}」地址已变化，未将原有 Key 复制到新地址。`);
    put(channels,old,{...item,id:old?.id,keys});changes.channels[old?'updated':'added']++;
  }
  for(const item of input.tokens){
    const old=match(item,current.tokens),value=valueOf(item)||old?.value;
    if(old&&seenTokens.has(old.id))invalid('多个令牌匹配到同一个现有令牌');
    if(!value){changes.skipped_tokens++;warnings.push(`令牌「${item.name.trim()}」不含凭据且本机没有同名令牌，已跳过。`);continue;}
    if(old)seenTokens.add(old.id);
    put(tokens,old,{...item,id:old?.id,value});changes.tokens[old?'updated':'added']++;
  }
  if(mode==='replace'){
    changes.channels.removed=current.channels.filter(ch=>!seenChannels.has(ch.id)).length;
    changes.tokens.removed=current.tokens.filter(token=>!seenTokens.has(token.id)).length;
  }
  const next=normalize({settings:include_settings?{...current.settings,...input.settings}:current.settings,channels,tokens,forwarding:input.forwarding??current.forwarding},current);
  const summary={channels:next.channels.length,models:new Set(next.channels.flatMap(ch=>[...ch.models,...Object.keys(ch.model_mapping)])).size,keys:next.channels.reduce((n,ch)=>n+ch.keys.length,0),tokens:next.tokens.length};
  return {next,preview:{revision:revision(store),mode,include_settings:include_settings===true,summary,changes,warnings}};
}
function importConfig(store,options){
  const prepared=prepareImport(store,options);
  if(!options.revision||options.revision!==prepared.preview.revision)throw new HttpError(409,'当前配置已变化，请重新预览后导入','import_conflict');
  store.save(prepared.next);
  return prepared.preview;
}
module.exports={prepareImport,importConfig};
