import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import net from 'node:net'; import path from 'node:path';
const REPO_ROOT='/Volumes/dev/wwwroot/moo-git-fleet';
const ROOT='/tmp/moo-fleet-dirsel'; const PROJECTS=path.join(ROOT,'projects');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise((res,rej)=>{const s=net.createServer();s.once('error',rej);s.listen(0,'127.0.0.1',()=>{const{port}=s.address();s.close(()=>res(port));});});
fs.rmSync(ROOT,{recursive:true,force:true}); fs.mkdirSync(path.join(ROOT,'fleet','config'),{recursive:true}); fs.mkdirSync(PROJECTS,{recursive:true});
const repo=path.join(PROJECTS,'dirsel'); fs.mkdirSync(repo,{recursive:true});
const g=(...a)=>execFileSync('git',['-C',repo,...a]);
execFileSync('git',['init','-q','-b','main',repo]); g('config','user.name','P'); g('config','user.email','p@e'); g('config','commit.gpgsign','false');
const files=['engine/css/a.css','engine/css/b.css','engine/img/c.png','engine/img/d.png','top.txt'];
for(const p of files){const fp=path.join(repo,p);fs.mkdirSync(path.dirname(fp),{recursive:true});fs.writeFileSync(fp,'base\n');}
g('add','-A'); g('commit','-qm','base');
for(const p of files) fs.appendFileSync(path.join(repo,p),'change\n');
const PORT=await freePort();
const server=spawn(process.execPath,[path.join(REPO_ROOT,'dist/server/index.js')],{cwd:REPO_ROOT,env:{...process.env,GIT_FLEET_HOME:path.join(ROOT,'fleet'),GIT_FLEET_CLAUDE_HOME:path.join(ROOT,'c'),GIT_FLEET_CODEX_HOME:path.join(ROOT,'x'),GIT_FLEET_PORT:String(PORT),GIT_FLEET_DEVICE_NAME:'dirsel',NODE_OPTIONS:''},stdio:['ignore','pipe','pipe']});
const log=[];server.stdout.on('data',d=>log.push(String(d)));server.stderr.on('data',d=>log.push(String(d)));
let chrome=null;const cleanup=()=>{try{if(chrome)process.kill(-chrome.pid,'SIGKILL')}catch{};try{server.kill('SIGTERM')}catch{}};process.on('exit',cleanup);
const base=`http://127.0.0.1:${PORT}`;let ok=false;for(let i=0;i<60&&!ok;i++){try{ok=(await fetch(`${base}/api/health`)).ok}catch{};if(!ok)await sleep(500)}
if(!ok){console.error('server no',log.join(''));process.exit(1)}
const token=(await (await fetch(`${base}/api/session`)).json()).token;const H={'content-type':'application/json','x-git-fleet-token':token};
await fetch(`${base}/api/repository-roots`,{method:'POST',headers:H,body:JSON.stringify({path:PROJECTS})});
const roots=await (await fetch(`${base}/api/repository-roots`,{headers:H})).json();const rootId=Object.keys(roots)[0];
await fetch(`${base}/api/repositories`,{method:'POST',headers:H,body:JSON.stringify({rootId,relativePath:'dirsel'})});
await fetch(`${base}/api/repositories/refresh`,{method:'POST',headers:H});
const dp=await freePort();const prof=path.join(ROOT,'chrome');fs.mkdirSync(prof,{recursive:true});
chrome=spawn(CHROME,['--headless=new',`--remote-debugging-port=${dp}`,`--user-data-dir=${prof}`,'--no-first-run','--no-sandbox','--disable-gpu','--no-proxy-server','--hide-scrollbars','about:blank'],{stdio:'ignore',detached:true});chrome.unref();
let ver=null;for(let i=0;i<40&&!ver;i++){try{ver=await (await fetch(`http://127.0.0.1:${dp}/json/version`)).json()}catch{await sleep(500)}}
const list=await (await fetch(`http://127.0.0.1:${dp}/json/list`)).json();const tgt=list.find(e=>e.type==='page');const ws=new WebSocket(tgt.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
let seq=0;const pend=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const{resolve,reject}=pend.get(m.id);pend.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result)}};
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pend.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
const ev=async x=>{const{result,exceptionDetails}=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});if(exceptionDetails)throw new Error(String(exceptionDetails.exception?.description??exceptionDetails.text));return result.value};
const waitFor=async(fn,to=15000)=>{const end=Date.now()+to;while(Date.now()<end){if(await fn())return true;await sleep(300)}return false};
await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:2,mobile:false});
await send('Page.navigate',{url:base});await sleep(3200);
await waitFor(async()=>(await ev(`document.querySelectorAll('.repo-table tbody tr').length`))>=1);
await ev(`(()=>{const r=document.querySelector('.repo-table tbody tr');r&&r.click()})()`);
await waitFor(async()=>(await ev(`document.querySelectorAll('.repo-workspace-shell .workspace-file-row, .repo-workspace-shell .file-tree-directory-row').length`))>0);
const res=[];
// 目录勾选框应存在（根 engine 下 css/img 子目录）
const dirRows=await ev(`document.querySelectorAll('.repo-workspace-shell .file-tree-directory-row .file-tree-directory-select').length`);
res.push({name:'目录行有勾选框',ok:dirRows>=2,extra:{dirRows}});
// 初始无勾选：不应出现「还原 N 个」
const noBtn=await ev(`!!([...document.querySelectorAll('.repo-workspace-shell button')].find(x=>{const t=(x.textContent||'').trim();return t.startsWith('还原')&&t.includes('个')}))`);
res.push({name:'未勾选时不显示还原按钮',ok:noBtn===false});
// 勾选单个文件 top.txt
await ev(`(()=>{const row=[...document.querySelectorAll('.repo-workspace-shell .workspace-file-row')].find(r=>(r.dataset.path||'')==='top.txt');const cb=row&&row.querySelector('input[type=checkbox]');cb&&cb.click()})()`);
await waitFor(async()=>(await ev(`(()=>{const t=document.querySelector('.repo-workspace-shell')?.innerText||'';const m=/已勾选\\s*(\\d+)/.exec(t);return !!(m&&+m[1]>=1)})()`)),8000); await sleep(600);
const btn1=await ev(`(()=>{const b=[...document.querySelectorAll('.repo-workspace-shell button')].find(x=>{const t=(x.textContent||'').trim();return t.startsWith('还原')&&t.includes('个')});return b?b.textContent.replace(/\s+/g,' ').trim():null})()`);
res.push({name:'勾选1个 → 还原按钮显示 1 个（不是全部）',ok:!!btn1&&/还原\s*1\s*个/.test(btn1),extra:btn1});
// 点 engine/img 目录勾选框 → 该目录下 2 个图片文件应被勾选
const dirToggle=await ev(`(()=>{const rows=[...document.querySelectorAll('.repo-workspace-shell .file-tree-directory-row')];const row=rows.find(r=>{const t=(r.querySelector('.file-tree-directory')||{}).getAttribute&&r.querySelector('.file-tree-directory').getAttribute('title');return t==='engine/img';});if(!row)return 'no-row';const cb=row.querySelector('.file-tree-directory-select');cb.click();return 'clicked'})()`);
await sleep(1800);
const checkedImg=await ev(`(()=>{const t=document.querySelector('.repo-workspace-shell')?.innerText||'';const m=/已勾选\\s*(\\d+)/.exec(t);return m?+m[1]:null})()`);
// top.txt(1) + engine/img 下 c,d(2) = 3
res.push({name:'点 engine/img 目录勾选 → 目录下文件全被选（勾选数=3）',ok:checkedImg===3,extra:{checkedImg,dirToggle}});
// 按钮数应变 3
const btn3=await ev(`(()=>{const b=[...document.querySelectorAll('.repo-workspace-shell button')].find(x=>{const t=(x.textContent||'').trim();return t.startsWith('还原')&&t.includes('个')});return b?b.textContent.replace(/\s+/g,' ').trim():null})()`);
res.push({name:'还原按钮数量随目录勾选更新为 3',ok:!!btn3&&/还原\s*3\s*个/.test(btn3),extra:btn3});
const shotDir=path.join(ROOT,'shots');fs.mkdirSync(shotDir,{recursive:true});
const sh=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(shotDir,'dir-select.png'),Buffer.from(sh.data,'base64'));
const failed=res.filter(r=>!r.ok);
for(const r of res)console.log(`${r.ok?'PASS':'FAIL'}  ${r.name}  ${JSON.stringify(r.extra??'')}`);
console.log(`\n${res.length-failed.length}/${res.length} 通过\n截图 ${shotDir}`);
cleanup();process.exit(failed.length?1:0);
