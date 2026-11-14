import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import net from 'node:net'; import path from 'node:path';
const REPO_ROOT='/Volumes/dev/wwwroot/moo-git-fleet'; const ROOT='/tmp/moo-fleet-cfui'; const PROJECTS=path.join(ROOT,'projects');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); const freePort=()=>new Promise((res,rej)=>{const s=net.createServer();s.once('error',rej);s.listen(0,'127.0.0.1',()=>{const{port}=s.address();s.close(()=>res(port));});});
fs.rmSync(ROOT,{recursive:true,force:true}); fs.mkdirSync(path.join(ROOT,'fleet','config'),{recursive:true}); fs.mkdirSync(PROJECTS,{recursive:true});
const repo=path.join(PROJECTS,'cf'); fs.mkdirSync(repo,{recursive:true}); const g=(...a)=>execFileSync('git',['-C',repo,...a],{stdio:'pipe'});
execFileSync('git',['init','-q','-b','main',repo]); g('config','user.name','P'); g('config','user.email','p@e'); g('config','commit.gpgsign','false');
fs.writeFileSync(path.join(repo,'app.txt'),'base\n'); g('add','.'); g('commit','-qm','base');
g('switch','-qc','side'); fs.writeFileSync(path.join(repo,'app.txt'),'theirs\n'); g('add','.'); g('commit','-qm','side');
g('switch','-q','main'); fs.writeFileSync(path.join(repo,'app.txt'),'ours\n'); g('add','.'); g('commit','-qm','ours'); try{g('merge','side')}catch{}
const PORT=await freePort();
const server=spawn(process.execPath,[path.join(REPO_ROOT,'dist/server/index.js')],{cwd:REPO_ROOT,env:{...process.env,GIT_FLEET_HOME:path.join(ROOT,'fleet'),GIT_FLEET_CLAUDE_HOME:path.join(ROOT,'c'),GIT_FLEET_CODEX_HOME:path.join(ROOT,'x'),GIT_FLEET_PORT:String(PORT),GIT_FLEET_DEVICE_NAME:'cfui',NODE_OPTIONS:''},stdio:['ignore','pipe','pipe']});
const log=[];server.stdout.on('data',d=>log.push(String(d)));server.stderr.on('data',d=>log.push(String(d)));let chrome=null;const cleanup=()=>{try{if(chrome)process.kill(-chrome.pid,'SIGKILL')}catch{};try{server.kill('SIGTERM')}catch{}};process.on('exit',cleanup);
const base=`http://127.0.0.1:${PORT}`;let ok=false;for(let i=0;i<60&&!ok;i++){try{ok=(await fetch(`${base}/api/health`)).ok}catch{};if(!ok)await sleep(500)} if(!ok){console.error(log.join(''));process.exit(1)}
const token=(await (await fetch(`${base}/api/session`)).json()).token;const H={'content-type':'application/json','x-git-fleet-token':token};
await fetch(`${base}/api/repository-roots`,{method:'POST',headers:H,body:JSON.stringify({path:PROJECTS})});
const rootId=Object.keys(await (await fetch(`${base}/api/repository-roots`,{headers:H})).json())[0];
await fetch(`${base}/api/repositories`,{method:'POST',headers:H,body:JSON.stringify({rootId,relativePath:'cf'})}); await fetch(`${base}/api/repositories/refresh`,{method:'POST',headers:H});
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
await waitFor(async()=>(await ev(`!!document.querySelector('.operation-section')`))); // 冲突操作条
const before=await ev(`(()=>{const s=document.querySelector('.operation-summary');return s?s.textContent.replace(/\\s+/g,' ').trim():null})()`);
console.log('冲突时操作条文案:',before);
console.log('继续按钮disabled:',await ev(`(()=>{const b=document.querySelector('.operation-continue');return b?b.disabled:null})()`));
// 取 ours 解决
const resolveClicked=await ev(`(()=>{const tabs=[...document.querySelectorAll('.inspection-tabs button')];const theirsTab=tabs.find(b=>/当前一侧|ours|基线/.test(b.textContent||'')); /* 先点冲突文件 */ const row=document.querySelector('.workspace-file-row.conflict .workspace-file-select'); if(row) row.click(); return !!row})()`);
await sleep(800);
const takeBtn=await ev(`(()=>{const b=[...document.querySelectorAll('.compact-button')].find(x=>/取此版本/.test(x.textContent||''));return b?'found':document.querySelector('.repo-workspace-shell')?.innerText.slice(0,200)})()`);
console.log('取此版本按钮:',takeBtn);
// 点第二个 tab(ours=当前一侧) 再取
await ev(`(()=>{const tabs=[...document.querySelectorAll('.inspection-tabs button')];if(tabs[1])tabs[1].click()})()`); await sleep(400);
await ev(`(()=>{const b=[...document.querySelectorAll('.compact-button')].find(x=>/取此版本/.test(x.textContent||''));b&&b.click()})()`); await sleep(600);
// 确认框
const conf=await ev(`(()=>{const m=document.querySelector('.confirmation-modal');if(!m)return 'no-modal';const b=m.querySelector('.confirmation-confirm');b&&b.click();return 'confirmed'})()`); await sleep(2500);
const after=await ev(`(()=>{const s=document.querySelector('.operation-summary');return s?s.textContent.replace(/\\s+/g,' ').trim():null})()`);
const contDisabled=await ev(`(()=>{const b=document.querySelector('.operation-continue');return b?b.disabled:null})()`);
console.log('解决后操作条文案:',after);
console.log('解决后继续按钮disabled:',contDisabled);
const sd=path.join(ROOT,'shots');fs.mkdirSync(sd,{recursive:true});const sh=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(sd,'after-resolve.png'),Buffer.from(sh.data,'base64'));
cleanup();process.exit(0);
