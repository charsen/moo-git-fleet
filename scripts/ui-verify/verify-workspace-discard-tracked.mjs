import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import net from 'node:net'; import path from 'node:path';
const REPO_ROOT='/Volumes/dev/wwwroot/moo-git-fleet';
const ROOT='/tmp/moo-fleet-restore'; const PROJECTS=path.join(ROOT,'projects');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise((res,rej)=>{const s=net.createServer();s.once('error',rej);s.listen(0,'127.0.0.1',()=>{const{port}=s.address();s.close(()=>res(port));});});
fs.rmSync(ROOT,{recursive:true,force:true}); fs.mkdirSync(path.join(ROOT,'fleet','config'),{recursive:true}); fs.mkdirSync(PROJECTS,{recursive:true});
const repo=path.join(PROJECTS,'restore-repo'); fs.mkdirSync(repo,{recursive:true});
const g=(...a)=>execFileSync('git',['-C',repo,...a]);
execFileSync('git',['init','-q','-b','main',repo]); g('config','user.name','P'); g('config','user.email','p@e'); g('config','commit.gpgsign','false');
for(const p of ['src/a.ts','src/b.ts','lib/c.ts']){const fp=path.join(repo,p);fs.mkdirSync(path.dirname(fp),{recursive:true});fs.writeFileSync(fp,'base\n');}
g('add','-A'); g('commit','-qm','base');
for(const p of ['src/a.ts','src/b.ts','lib/c.ts']) fs.appendFileSync(path.join(repo,p),'change\n');
const PORT=await freePort();
const server=spawn(process.execPath,[path.join(REPO_ROOT,'dist/server/index.js')],{cwd:REPO_ROOT,env:{...process.env,GIT_FLEET_HOME:path.join(ROOT,'fleet'),GIT_FLEET_CLAUDE_HOME:path.join(ROOT,'c'),GIT_FLEET_CODEX_HOME:path.join(ROOT,'x'),GIT_FLEET_PORT:String(PORT),GIT_FLEET_DEVICE_NAME:'restore-probe',NODE_OPTIONS:''},stdio:['ignore','pipe','pipe']});
const log=[];server.stdout.on('data',d=>log.push(String(d)));server.stderr.on('data',d=>log.push(String(d)));
let chrome=null;const cleanup=()=>{try{if(chrome)process.kill(-chrome.pid,'SIGKILL')}catch{};try{server.kill('SIGTERM')}catch{}};process.on('exit',cleanup);
const base=`http://127.0.0.1:${PORT}`;let ok=false;for(let i=0;i<60&&!ok;i++){try{ok=(await fetch(`${base}/api/health`)).ok}catch{};if(!ok)await sleep(500)}
if(!ok){console.error('server no',log.join(''));process.exit(1)}
const token=(await (await fetch(`${base}/api/session`)).json()).token;const H={'content-type':'application/json','x-git-fleet-token':token};
await fetch(`${base}/api/repository-roots`,{method:'POST',headers:H,body:JSON.stringify({path:PROJECTS})});
const roots=await (await fetch(`${base}/api/repository-roots`,{headers:H})).json();const rootId=Object.keys(roots)[0];
await fetch(`${base}/api/repositories`,{method:'POST',headers:H,body:JSON.stringify({rootId,relativePath:'restore-repo'})});
await fetch(`${base}/api/repositories/refresh`,{method:'POST',headers:H});
const dp=await freePort();const prof=path.join(ROOT,'chrome');fs.mkdirSync(prof,{recursive:true});
chrome=spawn(CHROME,['--headless=new',`--remote-debugging-port=${dp}`,`--user-data-dir=${prof}`,'--no-first-run','--no-sandbox','--disable-gpu','--no-proxy-server','--hide-scrollbars','about:blank'],{stdio:'ignore',detached:true});chrome.unref();
let ver=null;for(let i=0;i<40&&!ver;i++){try{ver=await (await fetch(`http://127.0.0.1:${dp}/json/version`)).json()}catch{await sleep(500)}}
const list=await (await fetch(`http://127.0.0.1:${dp}/json/list`)).json();const tgt=list.find(e=>e.type==='page');const ws=new WebSocket(tgt.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
let seq=0;const pend=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const{resolve,reject}=pend.get(m.id);pend.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result)}};
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pend.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
const ev=async x=>{const{result,exceptionDetails}=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});if(exceptionDetails)throw new Error(String(exceptionDetails.exception?.description??exceptionDetails.text));return result.value};
const waitFor=async(fn,to=15000)=>{const end=Date.now()+to;while(Date.now()<end){if(await fn())return true;await sleep(300)}return false};
await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:950,deviceScaleFactor:2,mobile:false});
await send('Page.navigate',{url:base});await sleep(3200);
const res=[];
await waitFor(async()=>(await ev(`document.querySelectorAll('.repo-table tbody tr').length`))>=1);
await ev(`(()=>{const r=document.querySelector('.repo-table tbody tr');r&&r.click()})()`);
await waitFor(async()=>(await ev(`document.querySelectorAll('.repo-workspace-shell .workspace-file-row, .repo-workspace-shell .file-tree-directory').length`))>0);
// 勾选全部（全选 = stage）
await ev(`(()=>{const cb=document.querySelector('.repo-workspace-shell .workspace-group-select input[type=checkbox]');if(cb&&!cb.checked)cb.click();return !!cb})()`);
await sleep(1500); // 等 stage 完成
const checkedN=await ev(`(()=>{const t=document.querySelector('.repo-workspace-shell')?.innerText||'';const m=/已勾选\\s*(\\d+)\\s*\\/\\s*(\\d+)/.exec(t);return m?{checked:+m[1],total:+m[2]}:null})()`);
res.push({name:'勾选后可还原数',ok:checkedN&&checkedN.checked===3,extra:checkedN});
// 出现「还原 N 个」按钮
const hasBtn=await ev(`(()=>{const b=[...document.querySelectorAll('.repo-workspace-shell button')].find(x=>/还原\\s*\\d+\\s*个/.test(x.textContent||''));return b?b.textContent.trim():null})()`);
res.push({name:'出现“还原 N 个”按钮',ok:!!hasBtn,extra:hasBtn});
// 点还原
await ev(`(()=>{const b=[...document.querySelectorAll('.repo-workspace-shell button')].find(x=>/还原\\s*\\d+\\s*个/.test(x.textContent||''));b&&b.click()})()`);
await sleep(1200);
// 确认框点「还原 N 个文件」
const conf=await ev(`(()=>{const m=document.querySelector('.confirmation-modal');if(!m)return 'no-modal';const b=m.querySelector('.confirmation-confirm');if(!b)return 'no-confirm-btn';b.click();return 'confirmed:'+(b.textContent||'').trim()})()`);
res.push({name:'确认框弹出并可点“还原”',ok:typeof conf==='string'&&conf.startsWith('confirmed'),extra:conf});
await sleep(4000);
// 断言：工作区变化文件 0（回干净）
const summary=await ev(`(()=>{const t=document.querySelector('.repo-workspace-shell')?.innerText||'';const m=/(\\d+)\\s*个变化文件/.exec(t);const rows=document.querySelectorAll('.repo-workspace-shell .workspace-file-row').length;const clean=/工作区干净|没有.*变化|无改动/.test(t);return {m:m?m[1]:null,rows,clean,head:t.slice(0,120)}})()`);
res.push({name:'还原后工作区无变化文件',ok:(summary.m==='0'||summary.rows===0||summary.clean),extra:summary});
// 磁盘校验：文件回到 base
const fsRead=execFileSync('git',['-C',repo,'status','--porcelain']).toString().trim();
res.push({name:'git 状态干净（无未提交改动）',ok:fsRead==='',extra:{porcelain:fsRead}});
// —— 追加：单文件行内「还原到上次提交」（已暂存文件）——
// 重新弄脏一个文件：改 a 并勾选(暂存)，再点该行的小还原按钮
execFileSync('bash',['-c',`printf 'change2\n' >> ${JSON.stringify(path.join(repo,'src/a.ts'))}`]);
await ev(`window.location.reload()`); await sleep(3500);
await waitFor(async()=>(await ev(`document.querySelectorAll('.repo-table tbody tr').length`))>=1);
await ev(`(()=>{const r=document.querySelector('.repo-table tbody tr');r&&r.click()})()`);
await waitFor(async()=>(await ev(`document.querySelectorAll('.repo-workspace-shell .workspace-file-row').length`))>0);
// 勾选 a.ts 使其暂存（点该行的选择框）
const rowClicked=await ev(`(()=>{const row=[...document.querySelectorAll('.repo-workspace-shell .workspace-file-row')].find(r=>(r.dataset.path||'')==='src/a.ts');if(!row)return false;const cb=row.querySelector('input[type=checkbox]');if(cb){cb.click();return true}return false})()`);
// 等 stage 真正完成：顶部“已勾选 N / M”的 N 增加
await waitFor(async()=>(await ev(`(()=>{const t=document.querySelector('.repo-workspace-shell')?.innerText||'';const m=/已勾选\\s*(\\d+)/.exec(t);return !!(m&&+m[1]>=1)})()`)),8000);
await sleep(800);
// 该行小还原按钮应出现且 title 为「还原到上次提交」
const singleBtn=await ev(`(()=>{const row=[...document.querySelectorAll('.repo-workspace-shell .workspace-file-row')].find(r=>(r.innerText||'').includes('a.ts'));if(!row)return null;const b=row.querySelector('.file-discard');return b?{title:b.getAttribute('title'),aria:b.getAttribute('aria-label')}:null})()`);
res.push({name:'单文件已暂存显示“还原到上次提交”按钮',ok:!!singleBtn&&/还原到上次提交/.test(singleBtn.title||''),extra:singleBtn});
await ev(`(()=>{const row=[...document.querySelectorAll('.repo-workspace-shell .workspace-file-row')].find(r=>(r.innerText||'').includes('a.ts'));const b=row&&row.querySelector('.file-discard');b&&b.click()})()`);
await sleep(1200);
const c2=await ev(`(()=>{const m=document.querySelector('.confirmation-modal');if(!m)return 'no-modal';const b=m.querySelector('.confirmation-confirm');if(!b)return 'no-btn';b.click();return 'confirmed:'+(b.textContent||'').trim()})()`);
res.push({name:'单文件还原确认框可点',ok:typeof c2==='string'&&c2.startsWith('confirmed'),extra:c2});
await sleep(4000);
const afterSingle=execFileSync('git',['-C',repo,'status','--porcelain']).toString().trim();
res.push({name:'单文件还原后该文件回到 HEAD（git 干净）',ok:afterSingle==='',extra:{porcelain:afterSingle}});

const failed=res.filter(r=>!r.ok);
for(const r of res)console.log(`${r.ok?'PASS':'FAIL'}  ${r.name}  ${JSON.stringify(r.extra??'')}`);
console.log(`\n${res.length-failed.length}/${res.length} 通过`);
cleanup();process.exit(failed.length?1:0);
