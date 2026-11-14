import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import net from 'node:net'; import path from 'node:path';
const REPO_ROOT='/Volumes/dev/wwwroot/moo-git-fleet'; const ROOT='/tmp/moo-fleet-tgt2'; const PROJECTS=path.join(ROOT,'projects');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); const freePort=()=>new Promise((res,rej)=>{const s=net.createServer();s.once('error',rej);s.listen(0,'127.0.0.1',()=>{const{port}=s.address();s.close(()=>res(port));});});
fs.rmSync(ROOT,{recursive:true,force:true}); fs.mkdirSync(path.join(ROOT,'fleet','config'),{recursive:true}); fs.mkdirSync(PROJECTS,{recursive:true});
const g=(repo,...a)=>execFileSync('git',['-C',repo,...a],{stdio:'pipe'});
function mk(name,{withStaging=false}={}){ const repo=path.join(PROJECTS,name); fs.mkdirSync(repo,{recursive:true}); execFileSync('git',['init','-q','-b','main',repo]); g(repo,'config','user.name','P'); g(repo,'config','user.email','p@e'); g(repo,'config','commit.gpgsign','false'); fs.writeFileSync(path.join(repo,'a.txt'),'b\n'); g(repo,'add','.'); g(repo,'commit','-qm','base'); g(repo,'branch','dev'); if(withStaging)g(repo,'branch','staging'); g(repo,'checkout','-q','-b','feature-x'); fs.writeFileSync(path.join(repo,'f.txt'),'x\n'); g(repo,'add','.'); g(repo,'commit','-qm','fx'); return repo; }
mk('repo-a',{withStaging:true}); mk('repo-b');
const PORT=await freePort();
const server=spawn(process.execPath,[path.join(REPO_ROOT,'dist/server/index.js')],{cwd:REPO_ROOT,env:{...process.env,GIT_FLEET_HOME:path.join(ROOT,'fleet'),GIT_FLEET_CLAUDE_HOME:path.join(ROOT,'c'),GIT_FLEET_CODEX_HOME:path.join(ROOT,'x'),GIT_FLEET_PORT:String(PORT),GIT_FLEET_DEVICE_NAME:'tgt2',NODE_OPTIONS:''},stdio:['ignore','pipe','pipe']});
const log=[];server.stdout.on('data',d=>log.push(String(d)));server.stderr.on('data',d=>log.push(String(d)));let chrome=null;const cleanup=()=>{try{if(chrome)process.kill(-chrome.pid,'SIGKILL')}catch{};try{server.kill('SIGTERM')}catch{}};process.on('exit',cleanup);
const base=`http://127.0.0.1:${PORT}`;let ok=false;for(let i=0;i<60&&!ok;i++){try{ok=(await fetch(`${base}/api/health`)).ok}catch{};if(!ok)await sleep(500)} if(!ok){console.error(log.join(''));process.exit(1)}
const token=(await (await fetch(`${base}/api/session`)).json()).token;const H={'content-type':'application/json','x-git-fleet-token':token};
await fetch(`${base}/api/repository-roots`,{method:'POST',headers:H,body:JSON.stringify({path:PROJECTS})});
const rootId=Object.keys(await (await fetch(`${base}/api/repository-roots`,{headers:H})).json())[0];
for(const n of ['repo-a','repo-b']) await fetch(`${base}/api/repositories`,{method:'POST',headers:H,body:JSON.stringify({rootId,relativePath:n})});
await fetch(`${base}/api/repositories/refresh`,{method:'POST',headers:H});
const dp=await freePort();const prof=path.join(ROOT,'chrome');fs.mkdirSync(prof,{recursive:true});
chrome=spawn(CHROME,['--headless=new',`--remote-debugging-port=${dp}`,`--user-data-dir=${prof}`,'--no-first-run','--no-sandbox','--disable-gpu','--no-proxy-server','--hide-scrollbars','--window-size=1440,1000'],{stdio:'ignore',detached:true});chrome.unref();
let ver=null;for(let i=0;i<40&&!ver;i++){try{ver=await (await fetch(`http://127.0.0.1:${dp}/json/version`)).json()}catch{await sleep(500)}}
const list=await (await fetch(`http://127.0.0.1:${dp}/json/list`)).json();const tgt=list.find(e=>e.type==='page');const ws=new WebSocket(tgt.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
let seq=0;const pend=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const{resolve,reject}=pend.get(m.id);pend.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result)}};
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pend.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
const ev=async x=>{const{result,exceptionDetails}=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});if(exceptionDetails)throw new Error(String(exceptionDetails.exception?.description??exceptionDetails.text));return result.value};
const waitFor=async(fn,to=15000)=>{const end=Date.now()+to;while(Date.now()<end){if(await fn())return true;await sleep(300)}return false};
await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:2,mobile:false});
await send('Page.navigate',{url:base});await sleep(3200);
// 打开批量合并（工作台顶部合并按钮）
await waitFor(async()=>(await ev(`document.querySelectorAll('.repo-table tbody tr').length`))>=2);
const openBatch=await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/双线合并/.test(x.getAttribute('aria-label')||'')||/双线合并/.test(x.getAttribute('title')||''));if(b){b.click();return 'aria'}const b2=[...document.querySelectorAll('button')].find(x=>/合并/.test(x.textContent||'')&&!x.disabled);if(b2){b2.click();return 'text'}return 'none'})()`);
console.log('openBatch:',openBatch);
await waitFor(async()=>(await ev(`!!document.querySelector('.batch-merge-targets')`)),8000);
const res=[];
// ① 候选含 staging（repo-a 独有非线分支）
const chips1=await ev(`JSON.stringify([...document.querySelectorAll('.batch-merge-targets label')].map(l=>l.textContent.trim()))`);
res.push({name:'①候选含 repo-a 独有的 staging（非线本地分支）',ok:chips1.includes('staging'),extra:chips1});
// ③ 取消勾选 repo-b，再改目标分支，repo-b 应仍取消
const ids=await ev(`JSON.stringify([...document.querySelectorAll('.batch-push-list li input[type=checkbox]')].map((c,i)=>i))`);
// 取消第2个仓（repo-b）
await ev(`(()=>{const cs=[...document.querySelectorAll('.batch-push-list li input[type=checkbox]')];if(cs[1]&&cs[1].checked){cs[1].click();return true}return false})()`);
await sleep(500);
const uncheckedBefore=await ev(`(()=>{const cs=[...document.querySelectorAll('.batch-push-list li input[type=checkbox]')];return cs.map(c=>c.checked)})()`);
// 改目标分支（点 staging）
await ev(`(()=>{const l=[...document.querySelectorAll('.batch-merge-targets label')].find(x=>/staging/.test(x.textContent));if(l){l.querySelector('input').click();return true}return false})()`);
await sleep(3000);
const uncheckedAfter=await ev(`(()=>{const cs=[...document.querySelectorAll('.batch-push-list li input[type=checkbox]')];return cs.map(c=>c.checked)})()`);
// repo-b 没有 staging：应保持取消勾选（若之前取消的是它）——这里断言“改目标后 repo-b 勾选态不被重置”
res.push({name:'③改目标分支重算后，之前取消勾选的仓仍保持取消',ok:JSON.stringify(uncheckedAfter)===JSON.stringify(uncheckedBefore),extra:{uncheckedBefore,uncheckedAfter}});
// ⑤ repo-b 缺 staging → 行内提示“本机无 staging”
const missingHint=await ev(`/本机无 staging/.test(document.body.innerText)`);
res.push({name:'⑤某仓缺选中分支时行内提示“本机无 X，已跳过”',ok:missingHint,extra:{missingHint}});
const sd=path.join(ROOT,'shots');fs.mkdirSync(sd,{recursive:true});const sh=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(sd,'opt2.png'),Buffer.from(sh.data,'base64'));
const failed=res.filter(r=>!r.ok);
for(const r of res)console.log(`${r.ok?'PASS':'FAIL'}  ${r.name}  ${JSON.stringify(r.extra??'')}`);
console.log(`\n${res.length-failed.length}/${res.length} 通过`);
cleanup();process.exit(failed.length?1:0);
