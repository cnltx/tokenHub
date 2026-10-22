'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {Script}=require('node:vm');
const root=path.join(__dirname,'..');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):[path.join(dir,entry.name)]);}
let failed=false;
for(const dir of ['src','public','scripts','test'])if(fs.existsSync(path.join(root,dir)))for(const file of walk(path.join(root,dir)).filter(f=>f.endsWith('.js'))){try{new Script(fs.readFileSync(file,'utf8'),{filename:file});}catch(error){failed=true;console.error(error.message);}}
if(failed)process.exitCode=1;else console.log('所有 JavaScript 文件语法检查通过。');
