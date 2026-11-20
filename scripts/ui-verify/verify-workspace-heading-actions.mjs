import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import net from 'node:net'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = process.env.MOO_FLEET_HEADING_UI_ROOT ?? '/tmp/moo-fleet-opt'; const PROJECTS=path.join(ROOT,'projects');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SERVER_ENTRY = path.join(REPO_ROOT, 'dist/server/index.js');
const chromeFlags = (process.env.MOO_FLEET_UI_CHROME_FLAGS ?? '--no-proxy-server --no-sandbox --disable-gpu').split(/\s+/).filter(Boolean);
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); const freePort=()=>new Promise((res,rej)=>{const s=net.createServer();s.once('error',rej);s.listen(0,'127.0.0.1',()=>{const{port}=s.address();s.close(()=>res(port));});});
if (!fs.existsSync(CHROME)) { console.error('找不到 Chrome：' + CHROME); process.exit(2); }
if (!fs.existsSync(SERVER_ENTRY)) { console.error('缺少 dist/server/index.js，请先 npm run build'); process.exit(2); }
const allowedRoots = [path.resolve(os.tmpdir()), path.resolve('/tmp'), path.resolve('/private/tmp')];
if (!allowedRoots.some((root) => path.resolve(ROOT).startsWith(root + path.sep))) { console.error('MOO_FLEET_HEADING_UI_ROOT 必须位于临时目录下，拒绝清理：' + ROOT); process.exit(2); }
fs.rmSync(ROOT,{recursive:true,force:true}); fs.mkdirSync(path.join(ROOT,'fleet','config'),{recursive:true}); fs.mkdirSync(PROJECTS,{recursive:true});
const repo=path.join(PROJECTS,'opt'); fs.mkdirSync(repo,{recursive:true});
const g=(...a)=>execFileSync('git',['-C',repo,...a]); execFileSync('git',['init','-q','-b','main',repo]); g('config','user.name','P'); g('config','user.email','p@e'); g('config','commit.gpgsign','false');
const files=['engine/css/a.css','engine/css/b.css','engine/img/c.png','engine/img/d.png','top.txt'];
for(const p of files){const fp=path.join(repo,p);fs.mkdirSync(path.dirname(fp),{recursive:true});fs.writeFileSync(fp,'base\n');}
g('add','-A'); g('commit','-qm','base'); for(const p of files) fs.appendFileSync(path.join(repo,p),'change\n');
const PORT=await freePort();
const server=spawn(process.execPath,[SERVER_ENTRY],{cwd:REPO_ROOT,env:{...process.env,GIT_FLEET_HOME:path.join(ROOT,'fleet'),GIT_FLEET_CLAUDE_HOME:path.join(ROOT,'c'),GIT_FLEET_CODEX_HOME:path.join(ROOT,'x'),GIT_FLEET_PORT:String(PORT),GIT_FLEET_DEVICE_NAME:'opt',NODE_OPTIONS:''},stdio:['ignore','pipe','pipe']});
const log=[];server.stdout.on('data',d=>log.push(String(d)));server.stderr.on('data',d=>log.push(String(d)));let chrome=null;const cleanup=()=>{try{if(chrome)process.kill(-chrome.pid,'SIGKILL')}catch { /* ignore */ };try{server.kill('SIGTERM')}catch { /* ignore */ }};process.on('exit',cleanup);
const base=`http://127.0.0.1:${PORT}`;let ok=false;for(let i=0;i<60&&!ok;i++){try{ok=(await fetch(`${base}/api/health`)).ok}catch { /* ignore */ };if(!ok)await sleep(500)} if(!ok){console.error(log.join(''));process.exit(1)}
const token=(await (await fetch(`${base}/api/session`)).json()).token;const H={'content-type':'application/json','x-git-fleet-token':token};
await fetch(`${base}/api/repository-roots`,{method:'POST',headers:H,body:JSON.stringify({path:PROJECTS})});
const roots=await (await fetch(`${base}/api/repository-roots`,{headers:H})).json();const rootId=Object.keys(roots)[0];
await fetch(`${base}/api/repositories`,{method:'POST',headers:H,body:JSON.stringify({rootId,relativePath:'opt'})}); await fetch(`${base}/api/repositories/refresh`,{method:'POST',headers:H});
const dp=await freePort();const prof=path.join(ROOT,'chrome');fs.mkdirSync(prof,{recursive:true});
chrome=spawn(CHROME,['--headless=new',`--remote-debugging-port=${dp}`,`--user-data-dir=${prof}`,'--no-first-run','--hide-scrollbars',...chromeFlags,'about:blank'],{stdio:'ignore',detached:true});chrome.unref();
let ver=null;for(let i=0;i<40&&!ver;i++){try{ver=await (await fetch(`http://127.0.0.1:${dp}/json/version`)).json()}catch{await sleep(500)}}
const list=await (await fetch(`http://127.0.0.1:${dp}/json/list`)).json();const tgt=list.find(e=>e.type==='page');const ws=new WebSocket(tgt.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
let seq=0;const pend=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const{resolve,reject}=pend.get(m.id);pend.delete(m.id);if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result)}};
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pend.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
const ev=async x=>{const{result,exceptionDetails}=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});if(exceptionDetails)throw new Error(String(exceptionDetails.exception?.description??exceptionDetails.text));return result.value};
const waitFor=async(fn,to=15000)=>{const end=Date.now()+to;while(Date.now()<end){if(await fn())return true;await sleep(300)}return false};
await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:2,mobile:false});
await send('Page.navigate',{url:base});await sleep(3200);
await waitFor(async()=>(await ev(`document.querySelectorAll('.repo-table tbody tr').length`))>=1);
await ev(`(()=>{const r=document.querySelector('.repo-table tbody tr');r&&r.click()})()`);
await waitFor(async()=>(await ev(`document.querySelectorAll('.repo-workspace-shell .file-tree-directory-row').length`))>0);
const res=[];
// ① 收起/展开全部：2026-11-20 起是图标按钮，语义在 aria-label/title，而不是按钮文字。
const expandLabel = () => ev(`(()=>{const b=document.querySelector('.workspace-heading-icon');return b?(b.getAttribute('aria-label')||b.getAttribute('title')||''):null})()`);
const expandBtn = await expandLabel();
res.push({name:'有“收起全部目录”图标按钮（默认展开）',ok:!!expandBtn&&expandBtn.includes('收起全部'),extra:expandBtn});
const dirsBefore=await ev(`document.querySelectorAll('.repo-workspace-shell .file-tree-directory-row').length`);
await ev(`(()=>{const b=document.querySelector('.workspace-heading-icon');b&&b.click()})()`);
await sleep(600);
const dirsAfter=await ev(`document.querySelectorAll('.repo-workspace-shell .file-tree-directory-row').length`);
const labelAfter=await expandLabel();
res.push({name:'点“收起全部目录”后仅剩顶层目录 + 按钮变“展开全部”',ok:dirsAfter<dirsBefore&&!!labelAfter&&labelAfter.includes('展开全部'),extra:{dirsBefore,dirsAfter,labelAfter}});
await ev(`(()=>{const b=document.querySelector('.workspace-heading-icon');b&&b.click()})()`); await sleep(600);
const dirsBack=await ev(`document.querySelectorAll('.repo-workspace-shell .file-tree-directory-row').length`);
res.push({name:'再点“展开全部目录”恢复',ok:dirsBack===dirsBefore,extra:{dirsBack}});
// ② 标题栏仍保留「全部丢弃」唯一批量入口（旧的「还原已跟踪」批量按钮已移除）。
const discardAll=await ev(`(()=>{const b=document.querySelector('.workspace-group-discard-all');return b?(b.textContent||'').trim():null})()`);
res.push({name:'标题栏保留「全部丢弃」唯一批量入口',ok:/全部丢弃/.test(discardAll||''),extra:discardAll});
// ③ 点目录勾选框后短暂 disabled
const dirClick=await ev(`(()=>{const rows=[...document.querySelectorAll('.repo-workspace-shell .file-tree-directory-row')];const row=rows.find(r=>{const b=r.querySelector('.file-tree-directory');return b&&b.getAttribute('title')==='engine/css'});if(!row)return 'no';row.querySelector('.file-tree-directory-select').click();return 'clicked'})()`);
const immediatelyDisabled=await ev(`(()=>{const rows=[...document.querySelectorAll('.repo-workspace-shell .file-tree-directory-row')];const row=rows.find(r=>{const b=r.querySelector('.file-tree-directory');return b&&b.getAttribute('title')==='engine/css'});const cb=row&&row.querySelector('.file-tree-directory-select');return cb?cb.disabled:null})()`);
res.push({name:'点目录勾选框后短暂 disabled（防重复点）',ok:dirClick==='clicked'&&immediatelyDisabled===true,extra:{dirClick,immediatelyDisabled}});
await sleep(1200);
const reenabled=await ev(`(()=>{const rows=[...document.querySelectorAll('.repo-workspace-shell .file-tree-directory-row')];const row=rows.find(r=>{const b=r.querySelector('.file-tree-directory');return b&&b.getAttribute('title')==='engine/css'});const cb=row&&row.querySelector('.file-tree-directory-select');return cb?cb.disabled:null})()`);
res.push({name:'一拍后目录勾选框恢复可点',ok:reenabled===false,extra:{reenabled}});
const failed=res.filter(r=>!r.ok);
const sd=path.join(ROOT,'shots');fs.mkdirSync(sd,{recursive:true});const sh=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(sd,'opt.png'),Buffer.from(sh.data,'base64'));
for(const r of res)console.log(`${r.ok?'PASS':'FAIL'}  ${r.name}  ${JSON.stringify(r.extra??'')}`);
console.log(`\n${res.length-failed.length}/${res.length} 通过`);
cleanup();process.exit(failed.length?1:0);
