import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import net from 'node:net'; import path from 'node:path';
const REPO_ROOT='/Volumes/dev/wwwroot/moo-git-fleet'; const ROOT='/tmp/fleet-round3-space'; const PROJECTS=path.join(ROOT,'projects');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const results=[];
function check(name, ok, detail){ results.push({name,ok,detail}); console.log((ok?'PASS':'FAIL')+'  '+name+'  '+JSON.stringify(detail ?? '')); } const freePort=()=>new Promise((res,rej)=>{const s=net.createServer();s.once('error',rej);s.listen(0,'127.0.0.1',()=>{const{port}=s.address();s.close(()=>res(port));});});
const git=(cwd,...a)=>execFileSync('git',['-C',cwd,...a],{encoding:'utf8'}).trim();
fs.rmSync(ROOT,{recursive:true,force:true}); fs.mkdirSync(path.join(ROOT,'fleet','config'),{recursive:true}); fs.mkdirSync(PROJECTS,{recursive:true});
const work=path.join(PROJECTS,'flow-repo'); fs.mkdirSync(work,{recursive:true});
git(work,'init','-q','-b','main'); git(work,'config','user.name','Probe'); git(work,'config','user.email','probe@x'); git(work,'config','commit.gpgsign','false');
fs.writeFileSync(path.join(work,'a.txt'),'base\n'); git(work,'add','-A'); git(work,'commit','-qm','base'); git(work,'branch','dev');
fs.writeFileSync(path.join(work,'a.txt'),'changed\n');
const PORT=await freePort();
const server=spawn(process.execPath,[path.join(REPO_ROOT,'dist/server/index.js')],{cwd:REPO_ROOT,env:{...process.env,GIT_FLEET_HOME:path.join(ROOT,'fleet'),GIT_FLEET_CLAUDE_HOME:path.join(ROOT,'c'),GIT_FLEET_CODEX_HOME:path.join(ROOT,'x'),GIT_FLEET_PORT:String(PORT),GIT_FLEET_DEVICE_NAME:'round3',NODE_OPTIONS:''},stdio:['ignore','pipe','pipe']});
let log=''; server.stdout.on('data',d=>log+=String(d)); server.stderr.on('data',d=>log+=String(d));
let chrome=null; const cleanup=()=>{try{if(chrome)process.kill(-chrome.pid,'SIGKILL')}catch{/* ignore */};try{server.kill('SIGTERM')}catch{/* ignore */}}; process.on('exit',cleanup);
const base='http://127.0.0.1:'+PORT; let ok=false; for(let i=0;i<80&&!ok;i++){try{ok=(await fetch(base+'/api/health')).ok}catch{/* not ready */} if(!ok)await sleep(300)} if(!ok){console.error('server no',log);process.exit(1)}
const token=(await (await fetch(base+'/api/session')).json()).token; const H={'content-type':'application/json','x-git-fleet-token':token};
const {rootId}=await (await fetch(base+'/api/repository-roots',{method:'POST',headers:H,body:JSON.stringify({path:PROJECTS})})).json();
await fetch(base+'/api/repositories',{method:'POST',headers:H,body:JSON.stringify({rootId,relativePath:'flow-repo',name:'flow-repo',group:'probe',tags:[]})});
const dp=await freePort(); const prof=path.join(ROOT,'chrome'); fs.mkdirSync(prof,{recursive:true});
chrome=spawn(CHROME,['--headless=new',`--remote-debugging-port=${dp}`,`--user-data-dir=${prof}`,'--no-first-run','--no-default-browser-check','--hide-scrollbars','--force-device-scale-factor=1','--no-proxy-server','--no-sandbox','--disable-gpu','--window-size=1440,950','about:blank'],{stdio:'ignore',detached:true}); chrome.unref();
let ver=null; for(let i=0;i<40&&!ver;i++){try{ver=await(await fetch(`http://127.0.0.1:${dp}/json/version`)).json();}catch{await sleep(400);}}
const list=await(await fetch(`http://127.0.0.1:${dp}/json/list`)).json(); const t=list.find(e=>e.type==='page'); const ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let seq=0; const pend=new Map(); ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);if(m.error)p.reject(new Error(JSON.stringify(m.error)));else p.resolve(m.result);}};
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pend.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text||'eval');return r.result.value};
await send('Page.enable'); await send('Runtime.enable'); await send('Emulation.setDeviceMetricsOverride',{width:1440,height:950,deviceScaleFactor:2,mobile:false});
await send('Page.navigate',{url:base}); await sleep(3000);
const wait=async(fn,to=12000)=>{const end=Date.now()+to;while(Date.now()<end){if(await fn())return true;await sleep(250)}return false};
console.log('rows',await ev('document.querySelectorAll(".repo-table tbody tr").length'));
await ev('(function(){var r=document.querySelector(".repo-table tbody tr"); if(r) r.querySelector(".repo-name").click(); return !!r;})()');
await wait(async()=>(await ev('!!document.querySelector(".repo-workspace-shell")')));
await sleep(800);
// stage file1 by row checkbox
console.log('files',await ev('[...document.querySelectorAll(".workspace-file-row")].map(r=>r.dataset.path||r.innerText.slice(0,30))'));
console.log('stage',await ev('(function(){var row=[...document.querySelectorAll(".workspace-file-row")].find(r=>(r.dataset.path||"").includes("a.txt")); if(!row)return false; var cb=row.querySelector("input[type=checkbox]"); if(!cb)return false; cb.click(); return true;})()'));
await sleep(1200);
console.log('composer',await ev('!!document.querySelector(".workspace-composer")'));
console.log('set title',await ev('(function(){var el=document.querySelector(".workspace-composer input"); if(!el)return false; var d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value"); d.set.call(el,"test commit"); el.dispatchEvent(new Event("input",{bubbles:true})); return true;})()'));
await sleep(300);
console.log('submit click',await ev('(function(){var b=document.querySelector(".workspace-composer-submit"); if(!b||b.disabled)return "disabled"; b.click(); return true;})()'));
await sleep(2500);
console.log('git log',git(work,'log','--oneline','-2'));
// branch switch
console.log('branch trigger',await ev('document.querySelector(".branch-trigger")?.outerHTML?.slice(0,150)||"none"'));
console.log('click branch',await ev('(function(){var b=document.querySelector(".branch-trigger"); if(!b)return false;b.click();return true})()'));
await sleep(1000);
console.log('branch options',await ev('[...document.querySelectorAll(".branch-option")].map(x=>({t:x.innerText.replace(/\\s+/g," ").trim(),cls:x.className}))'));
console.log('switch dev',await ev('(function(){var b=[...document.querySelectorAll(".branch-option")].find(x=>x.innerText.includes("dev")); if(!b)return false;b.click();return true})()'));
await sleep(1500);
console.log('head after switch',git(work,'rev-parse','--abbrev-ref','HEAD'));

// tag creation
console.log('nav buttons', await ev('[...document.querySelectorAll(".workspace-nav button")].map(b=>b.textContent.trim().replace(/\\s+/g," "))'));
console.log('click tags', await ev('(function(){var b=[...document.querySelectorAll(".workspace-nav button")].find(x=>x.textContent.trim().startsWith("标签"));if(!b)return false;b.click();return true})()'));
await sleep(700);
console.log('tag input', await ev('!!document.querySelector(".tag-create-panel input")'));
console.log('set tag', await ev('(function(){var el=document.querySelector(".tag-create-panel input");if(!el)return false;var d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value");d.set.call(el,"v-flow-test");el.dispatchEvent(new Event("input",{bubbles:true}));return true})()'));
console.log('click create tag', await ev('(function(){var b=[...document.querySelectorAll("button")].find(x=>x.textContent.trim()==="创建标签");if(!b||b.disabled)return b?"disabled":"missing";b.click();return true})()'));
await sleep(500);
console.log('confirm tag', await ev('(function(){var b=document.querySelector(".confirmation-modal .confirmation-confirm");if(!b)return "no-modal";b.click();return true})()'));
await sleep(1800);
console.log('git tag', git(work,'tag','-l'));


// stash creation
fs.writeFileSync(path.join(work,'a.txt'),'stash change\n');
console.log('refresh', await ev('(function(){var b=[...document.querySelectorAll(".repository-workspace button")].find(x=>(x.getAttribute("title")||"").includes("立即重读"));if(!b)return false;b.click();return true})()'));
await sleep(1200);
console.log('click stash', await ev('(function(){var b=[...document.querySelectorAll(".workspace-nav button")].find(x=>x.textContent.trim().startsWith("Stash"));if(!b)return false;b.click();return true})()'));
await sleep(600);
console.log('stash input', await ev('!!document.querySelector(".stash-create-panel input")'));
console.log('click create stash', await ev('(function(){var b=[...document.querySelectorAll("button")].find(x=>x.textContent.trim()==="创建备份");if(!b||b.disabled)return b?"disabled":"missing";b.click();return true})()'));
await sleep(500);
console.log('confirm stash', await ev('(function(){var b=document.querySelector(".confirmation-modal .confirmation-confirm");if(!b)return "no-modal";b.click();return true})()'));
await sleep(1800);
console.log('git stash', git(work,'stash','list'));

const commitLog=git(work,'log','--all','--oneline','-5');
const headAfter=git(work,'rev-parse','--abbrev-ref','HEAD');
const tags=git(work,'tag','-l');
const stashes=git(work,'stash','list');
check('暂存并提交后生成提交', commitLog.includes('test commit'), commitLog.split('\n')[0]);
check('分支切换到 dev', headAfter === 'dev', headAfter);
check('创建 Tag v-flow-test', tags === 'v-flow-test', tags);
check('创建 Stash 备份', stashes.includes('Moo Fleet backup'), stashes);
const failed=results.filter(r=>!r.ok);
console.log((results.length-failed.length)+'/'+results.length+' 通过');
cleanup(); process.exit(failed.length?1:0);