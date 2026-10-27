/* Pi 3 memory check: runs the TV page in Chromium with the same low-memory flags kiosk.sh uses, at 1920x1080,
   with ~60 cards and a live edit every second for 60 s. Meant to run inside a memory-capped cgroup
   (see test/run-memory-capped.sh) so an over-budget page would be OOM-killed. Prints a JSON summary. */
const {chromium}=require(process.env.PW||'playwright-core');
const {spawn,execSync}=require('child_process');const fs=require('fs');const path=require('path');const http=require('http');
const ROOT=path.resolve(__dirname,'..');const PORT='8097';const DATA=fs.mkdtempSync('/tmp/kanban-mem-');const DUR=+(process.env.DUR||60);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const api=(m,p,b)=>new Promise((res,rej)=>{const d=b?JSON.stringify(b):'';const r=http.request(`http://localhost:${PORT}${p}`,{method:m,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(d)}},s=>{let x='';s.on('data',c=>x+=c);s.on('end',()=>res(x));});r.on('error',rej);r.end(d);});
const kb=pid=>{try{return +fs.readFileSync(`/proc/${pid}/status`,'utf8').match(/VmRSS:\s+(\d+)/)[1];}catch(_){return 0;}};
const tree=pid=>{try{return execSync(`ps -o pid= --ppid ${pid}`).toString().trim().split(/\s+/).filter(Boolean).flatMap(c=>[c,...tree(c)]);}catch(_){return [];}};
(async()=>{
  const srv=spawn(process.execPath,['--no-expose-wasm','--lite-mode','--max-old-space-size=32','--max-semi-space-size=1',path.join(ROOT,'server.js')],{env:{...process.env,PORT,DATA_DIR:DATA}});
  await new Promise(r=>srv.stdout.on('data',d=>/on http/.test(d)&&r()));
  const cols=['ideas','todo','doing','done'];
  for(let i=0;i<60;i++)await api('PUT','/api/card/m'+i,{id:'m'+i,title:'Card number '+i,notes:i%3?'Some notes for this card, two lines long maybe.':'',column:cols[i%4],priority:['low','med','high'][i%3],tags:['home','side project'].slice(0,1+i%2),checklist:i%5?[]:[{id:'a',text:'x',done:true},{id:'b',text:'y',done:false}],owner:['persona','personb','both'][i%3],order:i*1024,createdAt:Date.now(),updatedAt:Date.now()});
  const flags=['--no-sandbox','--enable-low-end-device-mode','--disable-extensions','--disable-background-networking','--disable-sync','--disable-default-apps','--disable-component-update','--disable-breakpad','--renderer-process-limit=1','--process-per-site','--disk-cache-size=16777216','--media-cache-size=1','--js-flags=--max-old-space-size=128','--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication'];
  const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:flags});
  const ctx=await b.newContext({viewport:{width:1920,height:1080}});const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(String(e)));
  await p.goto(`http://localhost:${PORT}/?tv=1`);await p.waitForFunction(()=>window.__kanban&&window.__kanban.store.debug().status==='live');
  const bpid=b.process?b.process().pid:null;let peakChrome=0,peakSrv=0,edits=0;
  const t0=Date.now();
  while(Date.now()-t0<DUR*1000){
    const i=edits%60;await api('PUT','/api/card/m'+i,{id:'m'+i,title:'Card number '+i+' (edit '+edits+')',column:cols[(i+edits)%4],priority:'med',tags:['home'],checklist:[],owner:'persona',order:i*1024,createdAt:1,updatedAt:Date.now()});edits++;
    if(bpid){const all=[bpid,...tree(bpid)];peakChrome=Math.max(peakChrome,all.reduce((a,x)=>a+kb(x),0));}
    peakSrv=Math.max(peakSrv,kb(srv.pid));await sleep(1000);
  }
  const ok=await p.evaluate(n=>window.__kanban.state.cards.some(c=>c.title.endsWith('(edit '+(n-1)+')')),edits);
  const cdp=await ctx.newCDPSession(p);await cdp.send('Performance.enable');const m=Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]));
  const procs=bpid?1+tree(bpid).length:null;
  await b.close();srv.kill();
  let cg={};try{const self=fs.readFileSync('/proc/self/cgroup','utf8').trim().split('::')[1];const d='/sys/fs/cgroup'+self;
    cg={cgroup:self,limitMB:Math.round(+fs.readFileSync(d+'/memory.max','utf8')/1048576)||'max',peakMB:fs.existsSync(d+'/memory.peak')?Math.round(+fs.readFileSync(d+'/memory.peak','utf8')/1048576):'n/a',
      oomKills:+((fs.readFileSync(d+'/memory.events','utf8').match(/oom_kill (\d+)/)||[])[1]||0)};}catch(_){}
  const out={durationS:DUR,liveEdits:edits,lastEditShownOnTv:ok,pageErrors:errs.length,
    serverPeakRssMB:+(peakSrv/1024).toFixed(1),tvJsHeapUsedMB:+(m.JSHeapUsedSize/1048576).toFixed(1),tvJsHeapTotalMB:+(m.JSHeapTotalSize/1048576).toFixed(1),tvDomNodes:m.Nodes,...cg};
  console.log(JSON.stringify(out,null,2));fs.writeFileSync(path.join(ROOT,'test','memory-results.json'),JSON.stringify(out,null,2));
  process.exit(ok&&!errs.length&&!(cg.oomKills>0)?0:1);
})().catch(e=>{console.error(e);process.exit(2);});
