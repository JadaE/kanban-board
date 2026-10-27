/* v0.02 end-to-end tests against a simulated Pi (the real server.js on this machine).
   Two separate browser contexts = two devices (phone A, TV B).  Run: node test/sync.test.js */
const {chromium}=require(process.env.PW||'playwright-core');
const {spawn}=require('child_process');const fs=require('fs');const path=require('path');const http=require('http');
const ROOT=path.resolve(__dirname,'..');const PORT=process.env.TEST_PORT||'8099';const BASE=`http://localhost:${PORT}/`;
const DATA=fs.mkdtempSync('/tmp/kanban-test-');const SHOTS=path.join(ROOT,'screenshots');fs.mkdirSync(SHOTS,{recursive:true});
let srv=null;const results=[];const consoleErrors=[];const expectedNetErrors=[];let phase='normal';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function startServer(){return new Promise((res,rej)=>{srv=spawn(process.execPath,['--no-expose-wasm','--lite-mode','--max-old-space-size=32','--max-semi-space-size=1',path.join(ROOT,'server.js')],{env:{...process.env,PORT,DATA_DIR:DATA,PING_S:'5',BACKUP_MIN_INTERVAL_S:'0',BACKUPS:'5'},stdio:['ignore','pipe','pipe']});
  srv.stdout.on('data',d=>{if(/on http/.test(d))res();});srv.stderr.on('data',d=>process.stderr.write('[server] '+d));srv.on('exit',c=>{if(c&&c!==0)rej(new Error('server exit '+c));});});}
function stopServer(sig){return new Promise(r=>{if(!srv)return r();srv.once('exit',()=>{srv=null;r();});srv.kill(sig||'SIGTERM');});}
function api(method,p,body){const data=body?JSON.stringify(body):'';return new Promise((res,rej)=>{const r=http.request(BASE+p.replace(/^\//,''),{method,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},s=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>{try{res({status:s.statusCode,json:JSON.parse(d)});}catch(_){res({status:s.statusCode,text:d});}});});r.on('error',rej);if(data)r.write(data);r.end();});}
async function check(name,fn){const t=Date.now();try{const info=await fn();results.push({name,ok:true,info,ms:Date.now()-t});console.log('PASS',name,info||'');}
  catch(e){results.push({name,ok:false,info:e.message,ms:Date.now()-t});console.log('FAIL',name,'-',e.message);}}
const assert=(c,m)=>{if(!c)throw new Error(m);};
async function waitFor(page,fn,arg,timeout=8000){const t=Date.now();await page.waitForFunction(fn,arg,{timeout,polling:50});return Date.now()-t;}
const cardsOn=(page)=>page.evaluate(()=>window.__kanban.state.cards.map(c=>({id:c.id,title:c.title,column:c.column,owner:c.owner})));
const findCard=(page,title)=>page.evaluate(t=>window.__kanban.state.cards.find(c=>c.title===t)||null,title);
const statusOf=page=>page.evaluate(()=>window.__kanban.store.debug());

function watch(page,label){
  page.on('console',m=>{if(m.type()!=='error')return;const txt=`${label}: ${m.text()}`;
    if(phase!=='normal'&&/Failed to load resource|ERR_CONNECTION_REFUSED|ERR_INTERNET_DISCONNECTED|net::ERR_/.test(m.text()))expectedNetErrors.push(`[${phase}] `+txt);else consoleErrors.push(txt);});
  page.on('pageerror',e=>consoleErrors.push(`${label} pageerror: ${e}`));page.on('dialog',d=>d.accept());}

(async()=>{
  await startServer();
  const browser=await chromium.launch({executablePath:process.env.CHROME||'/usr/bin/google-chrome',args:['--no-sandbox']});
  const ctxA=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,acceptDownloads:true});   // phone
  const ctxB=await browser.newContext({viewport:{width:1920,height:1080}});                                                  // TV
  const asWho=who=>`if(!localStorage.getItem('kanban-me'))localStorage.setItem('kanban-me','${who}')`;
  await ctxA.addInitScript(asWho('persona'));
  const A=await ctxA.newPage();watch(A,'A');const B=await ctxB.newPage();watch(B,'B');
  const live=p=>waitFor(p,()=>window.__kanban&&window.__kanban.store.debug().status==='live');

  await check('first open seeds the shared board once (fresh Pi)',async()=>{
    await A.goto(BASE);await live(A);await waitFor(A,()=>window.__kanban.state.cards.length===9);
    await B.goto(BASE+'?tv=1');await live(B);await waitFor(B,()=>window.__kanban.state.cards.length===9);
    const r=await api('GET','/api/board');assert(r.json.cards.length===9,'server has '+r.json.cards.length);
    return 'server cards=9, A=9, B=9';});

  await check('add on A appears on B live (no reload)',async()=>{
    await B.evaluate(()=>window.__noReload=1);
    await A.fill('[data-quick="todo"] input','Buy cat food');await A.press('[data-quick="todo"] input','Enter');
    const ms=await waitFor(B,()=>[...document.querySelectorAll('.card .title')].some(e=>e.textContent==='Buy cat food'));
    assert(await B.evaluate(()=>window.__noReload===1),'B reloaded');return `visible on B after ${ms} ms`;});

  await check('edit on A propagates to B',async()=>{
    await A.click('.card:has-text("Buy cat food")');await A.fill('#fTitle','Buy cat food (salmon)');await A.selectOption('#fOwner','personb');await A.selectOption('#fPri','high');await A.click('#fSave');
    const ms=await waitFor(B,()=>{const c=window.__kanban.state.cards.find(c=>c.title==='Buy cat food (salmon)');return c&&c.owner==='personb'&&c.priority==='high';});
    const badge=await B.locator('.card:has-text("Buy cat food (salmon)") .badge:has-text("Person B")').count();assert(badge===1,'Person B badge missing on B');
    return `title/owner/priority on B after ${ms} ms`;});

  await check('move on A propagates to B',async()=>{
    await A.tap('.card:has-text("Buy cat food (salmon)") .menu-btn');await A.tap('.menu button:has-text("Doing")');
    const ms=await waitFor(B,()=>!!document.querySelector('.column[data-col="doing"] .card[data-id] .title')&&[...document.querySelectorAll('.column[data-col="doing"] .card .title')].some(e=>e.textContent==='Buy cat food (salmon)'));
    return `in Doing on B after ${ms} ms`;});

  await check('reorder (move up) propagates and is stable',async()=>{
    await A.fill('[data-quick="doing"] input','Second doing card');await A.press('[data-quick="doing"] input','Enter');
    await waitFor(B,()=>window.__kanban.state.cards.some(c=>c.title==='Second doing card'));
    await A.tap('.card:has-text("Second doing card") .menu-btn');await A.tap('.menu button:has-text("Move up")');
    const order=p=>p.evaluate(()=>[...document.querySelectorAll('.column[data-col="doing"] .card .title')].map(e=>e.textContent));
    await waitFor(B,()=>{const t=[...document.querySelectorAll('.column[data-col="doing"] .card .title')].map(e=>e.textContent);return t.indexOf('Second doing card')>=0&&t.indexOf('Second doing card')<t.indexOf('Buy cat food (salmon)');});
    const oa=await order(A),ob=await order(B);assert(JSON.stringify(oa)===JSON.stringify(ob),'orders differ '+oa+' / '+ob);return ob.join(' | ');});

  await check('delete on A propagates to B',async()=>{
    await A.click('.card:has-text("Second doing card") .title');await A.click('#fDelete');
    const ms=await waitFor(B,()=>!window.__kanban.state.cards.some(c=>c.title==='Second doing card'));
    const r=await api('GET','/api/board');const t=r.json.cards.find(c=>c.deleted);assert(t&&t.updatedAt,'no tombstone on server');
    return `gone on B after ${ms} ms; server keeps tombstone`;});

  await check('conflict: two offline edits, newest updatedAt wins (older one replays last)',async()=>{
    const id=(await findCard(A,'Game website')).id;
    await ctxA.setOffline(true);await ctxB.setOffline(true);phase='offline-emulation';await sleep(300);
    await A.evaluate(id=>{const s=window.__kanban.state;});
    // A edits first (older), B edits ~200 ms later (newer)
    await A.click(`.card[data-id="${id}"] .title`);await A.fill('#fTitle','Game website (A, older)');await A.click('#fSave');
    await sleep(250);
    await B.evaluate(id=>{/* TV is read-only in the UI; edit through the same app code path a phone would use */},id);
    const ctxB2Page=B; // B is in tv mode, so drive the edit via its app state + Store.save (same path as the editor)
    await ctxB2Page.evaluate(id=>{const st=window.__kanban.state;const c=st.cards.find(c=>c.id===id);c.title='Game website (B, newer)';c.updatedAt=window.__kanban.store.now();window.__kanban.store.save(st);},id);
    const pa=(await statusOf(A)).pending,pb=(await statusOf(B)).pending;assert(pa>=1&&pb>=1,`expected queued edits, got A=${pa} B=${pb}`);
    await ctxB.setOffline(false);await waitFor(B,()=>window.__kanban.store.debug().pending===0,null,20000);
    await ctxA.setOffline(false);await waitFor(A,()=>window.__kanban.store.debug().pending===0,null,20000);phase='normal';
    await waitFor(A,id=>window.__kanban.state.cards.find(c=>c.id===id).title==='Game website (B, newer)',id,10000);
    const tb=(await B.evaluate(id=>window.__kanban.state.cards.find(c=>c.id===id).title,id));const ts=(await api('GET','/api/board')).json.cards.find(c=>c.id===id).title;
    assert(tb==='Game website (B, newer)'&&ts===tb,`B=${tb} server=${ts}`);return `A, B and server all show "${ts}" (A queued ${pa}, B queued ${pb})`;});

  await check('tombstone: old offline edit cannot resurrect a deleted card',async()=>{
    const id=(await findCard(A,'News bias radar')).id;
    await ctxA.setOffline(true);phase='offline-emulation';await sleep(200);
    await A.click(`.card[data-id="${id}"] .title`);await A.fill('#fNotes','edited while offline');await A.click('#fSave');
    await sleep(150);const del=await api('DELETE','/api/card/'+id,{updatedAt:Date.now()});assert(del.json.applied,'delete not applied');
    await waitFor(B,id=>!window.__kanban.state.cards.some(c=>c.id===id),id);
    await ctxA.setOffline(false);await waitFor(A,()=>window.__kanban.store.debug().pending===0&&window.__kanban.store.debug().status==='live',null,20000);phase='normal';
    await waitFor(A,id=>!window.__kanban.state.cards.some(c=>c.id===id),id);
    const s=(await api('GET','/api/board')).json.cards.find(c=>c.id===id);assert(s.deleted,'card came back on server');
    assert(!(await B.evaluate(id=>window.__kanban.state.cards.some(c=>c.id===id),id)),'came back on B');return 'stays deleted on A, B and server';});

  await check('data persists across a server restart',async()=>{
    const before=(await api('GET','/api/board')).json;await stopServer();await startServer();
    const after=(await api('GET','/api/board')).json;
    assert(JSON.stringify(before.cards)===JSON.stringify(after.cards),'cards differ after restart');
    assert(fs.existsSync(path.join(DATA,'board.json')),'no board.json');const bk=fs.readdirSync(path.join(DATA,'backups')).length;
    assert(bk>0&&bk<=5,'backups='+bk);
    await live(A);await live(B);return `${after.cards.filter(c=>!c.deleted).length} cards identical; ${bk} rolling backups (cap 5 in test)`;});

  await check('server killed: A queues an offline edit, server restarts, edit reaches B',async()=>{
    phase='server-down';await stopServer('SIGKILL');try{
    await waitFor(A,()=>['reconnecting','offline'].includes(window.__kanban.store.debug().status),null,10000);
    const dot=await A.textContent('#conn');
    await A.fill('[data-quick="ideas"] input','Added while Pi was down');await A.press('[data-quick="ideas"] input','Enter');
    const pend=(await statusOf(A)).pending;assert(pend>=1,'nothing queued');const dot2=await A.textContent('#conn');
    await A.screenshot({path:path.join(SHOTS,'phone-offline-queued.png')});
    // also prove the queue survives a reload of the phone page while the Pi is still down
    await A.reload();await waitFor(A,()=>window.__kanban&&window.__kanban.state.cards.some(c=>c.title==='Added while Pi was down'));
    assert((await statusOf(A)).pending>=1,'queue lost on reload');
    await sleep(1000);await startServer();
    const ms=await waitFor(B,()=>window.__kanban.state.cards.some(c=>c.title==='Added while Pi was down'),null,30000);
    await live(A);phase='normal';const srvHas=(await api('GET','/api/board')).json.cards.some(c=>c.title==='Added while Pi was down');assert(srvHas,'not on server');
    return `dot showed "${dot.trim()}" then "${dot2.trim()}"; queue survived a reload; on B ${ms} ms after restart`;
    }finally{if(!srv)await startServer();phase='normal';}});

  await check('export → import round-trips through the server',async()=>{
    const [dl]=await Promise.all([A.waitForEvent('download'),A.click('#exportBtn')]);const file=path.join(DATA,'export.json');await dl.saveAs(file);
    const exported=JSON.parse(fs.readFileSync(file,'utf8'));
    await A.fill('[data-quick="todo"] input','Temp card after export');await A.press('[data-quick="todo"] input','Enter');
    await waitFor(B,()=>window.__kanban.state.cards.some(c=>c.title==='Temp card after export'));
    await A.setInputFiles('#importFile',file);
    await waitFor(B,()=>!window.__kanban.state.cards.some(c=>c.title==='Temp card after export'));
    const sig=cs=>cs.map(c=>c.id+'|'+c.title+'|'+c.column+'|'+c.owner).sort().join('\n');
    const a=await cardsOn(A),b=await cardsOn(B),s=(await api('GET','/api/board')).json.cards.filter(c=>!c.deleted);
    assert(sig(a)===sig(exported.cards)&&sig(b)===sig(exported.cards)&&sig(s)===sig(exported.cards),'mismatch after import');
    return `${exported.cards.length} cards identical on A, B and server`;});

  await check("owner rename: v0.01 'husband' data migrates to 'personb'",async()=>{
    const file=path.join(DATA,'v001.json');
    fs.writeFileSync(file,JSON.stringify({version:1,cards:[{id:'old1',title:'Old husband card',column:'todo',priority:'low',owner:'husband',created:1,updated:2},{id:'old2',title:'Old caps card',column:'ideas',owner:'Husband'}]}));
    await A.setInputFiles('#importFile',file);await waitFor(B,()=>window.__kanban.state.cards.length===2);
    const b=await cardsOn(B);assert(b.every(c=>c.owner==='personb'),'B owners '+b.map(c=>c.owner));
    // server-side migration of a stored board.json on startup
    await stopServer();const bf=path.join(DATA,'board.json');const j=JSON.parse(fs.readFileSync(bf,'utf8'));j.cards.push({id:'old3',title:'Stored husband',column:'todo',owner:'husband',updatedAt:Date.now()});fs.writeFileSync(bf,JSON.stringify(j));
    await startServer();const s=(await api('GET','/api/board')).json.cards.find(c=>c.id==='old3');assert(s.owner==='personb','server owner '+s.owner);
    const opts=await A.$$eval('#fOwner option, #ownerFilter option',o=>o.map(x=>x.textContent));assert(opts.some(t=>t.includes('Person B'))&&!opts.some(t=>/husband/i.test(t)),'options '+opts);
    await live(A);await live(B);
    // restore the exported board for screenshots
    await A.setInputFiles('#importFile',path.join(DATA,'export.json'));await waitFor(B,()=>window.__kanban.state.cards.length>5);
    return 'import + server load both map husband→personb; menus show "🧢 Person B"';});

  await check("'Who are you?' picker: per-device, sets default owner, records lastEditedBy",async()=>{
    const ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const P=await ctx.newPage();watch(P,'P');
    await P.goto(BASE);await live(P);
    assert(await P.evaluate(()=>document.querySelector('#whoDlg').open),'picker not shown on a new device');
    assert(!(await B.evaluate(()=>document.querySelector('#whoDlg').open)),'picker shown on TV');
    await P.tap('#whoDlg [data-who="personb"]');assert((await P.textContent('#meBtn')).includes('Person B'),'chip not Person B');
    await P.fill('[data-quick="todo"] input','Fix the porch light');await P.press('[data-quick="todo"] input','Enter');
    await waitFor(B,()=>window.__kanban.state.cards.some(c=>c.title==='Fix the porch light'));
    const c1=await findCard(B,'Fix the porch light');assert(c1.owner==='personb'&&c1.lastEditedBy==='personb',JSON.stringify(c1));
    const tvLabel=(await B.textContent(`.card[data-id="${c1.id}"] .edited`)).trim();
    // switch to Person A with the chip and edit: lastEditedBy follows, owner stays personb
    await P.tap('#meBtn');await P.tap('#whoDlg [data-who="persona"]');assert((await P.textContent('#meBtn')).includes('Person A'),'chip not Person A');
    await P.tap(`.card[data-id="${c1.id}"] .title`);const edLine=await P.textContent('#fEdited');await P.fill('#fNotes','bulb is LED');await P.tap('#fSave');
    await waitFor(B,id=>{const c=window.__kanban.state.cards.find(c=>c.id===id);return c&&c.lastEditedBy==='persona'&&c.notes==='bulb is LED';},c1.id);
    const sv=(await api('GET','/api/board')).json;const sc=sv.cards.find(c=>c.id===c1.id);
    assert(sc.owner==='personb'&&sc.lastEditedBy==='persona','server '+JSON.stringify(sc));
    const allowed=['serverTime','schema','rev','fresh','cards','tagColors','metaUpdatedAt'];const extra=Object.keys(sv).filter(k=>!allowed.includes(k));
    assert(!extra.length&&!/"(me|who|identity|device)"/.test(JSON.stringify(sv)),'identity leaked into board data: '+extra);
    const ls=await P.evaluate(()=>localStorage.getItem('kanban-me'));assert(ls==='persona','localStorage '+ls);
    await P.reload();await live(P);assert(!(await P.evaluate(()=>document.querySelector('#whoDlg').open)),'picker shown again after reload');
    await ctx.close();return `TV shows "${tvLabel}"; editor showed "${edLine.trim()}"; owner stays personb, lastEditedBy→persona; identity only in localStorage`;});

  await check('TV mode (?tv=1): big text, read-only, no cursor',async()=>{
    const info=await B.evaluate(()=>({anim:getComputedStyle(document.querySelector('.conn i')).animationName,me:getComputedStyle(document.querySelector('#meBtn')).display,tv:document.documentElement.classList.contains('tv'),fs:getComputedStyle(document.body).fontSize,cursor:getComputedStyle(document.querySelector('.card')).cursor,
      quick:getComputedStyle(document.querySelector('.quick')).display,clock:document.querySelector('#clock').textContent}));
    await B.click('.card .title');assert(!(await B.evaluate(()=>document.querySelector('#dlg').open)),'editor opened on TV');
    assert(info.anim==='none'&&info.me==='none'&&info.tv&&info.cursor==='none'&&info.quick==='none'&&parseFloat(info.fs)>=22,JSON.stringify(info));return JSON.stringify(info);});

  await check('file:// with no server falls back to v0.01 localStorage behaviour',async()=>{
    const ctx=await browser.newContext();const p=await ctx.newPage();watch(p,'file');await p.goto('file://'+path.join(ROOT,'public/index.html'));
    await p.click('#whoDlg [data-who="persona"]');
    const r=await p.evaluate(()=>({kind:window.__kanban.store.kind,n:window.__kanban.state.cards.length,conn:getComputedStyle(document.querySelector('#conn')).display}));
    await p.fill('[data-quick="todo"] input','Local only');await p.press('[data-quick="todo"] input','Enter');await p.reload();
    const kept=await p.evaluate(()=>window.__kanban.state.cards.some(c=>c.title==='Local only'));await ctx.close();
    assert(r.kind==='localStorage'&&r.n===9&&kept&&r.conn==='none',JSON.stringify(r));return 'localStorage mode, seeded, persists on reload, status dot hidden';});

  // screenshots
  await A.goto(BASE);await live(A);await sleep(300);await A.screenshot({path:path.join(SHOTS,'phone-390x844.png')});
  await B.reload();await live(B);await sleep(300);await B.screenshot({path:path.join(SHOTS,'tv-1080p.png')});
  const D=await (await browser.newContext({viewport:{width:1920,height:1080}})).newPage();watch(D,'D');await D.goto(BASE+'?tv=1&theme=dark');await live(D);await sleep(300);await D.screenshot({path:path.join(SHOTS,'tv-1080p-dark.png')});
  const L=await (await browser.newContext({viewport:{width:1280,height:800}})).newPage();watch(L,'L');await L.goto(BASE);await live(L);await sleep(300);await L.screenshot({path:path.join(SHOTS,'desktop-1280.png')});

  await check('memory budget (Pi 3, 1 GB): server RSS and TV page size',async()=>{
    const rss=pid=>{const m=fs.readFileSync(`/proc/${pid}/status`,'utf8').match(/VmRSS:\s+(\d+)/);return +m[1]/1024;};
    const idle=rss(srv.pid);
    // load: 300 extra cards and 20 extra live SSE clients
    for(let i=0;i<300;i++)await api('PUT','/api/card/load'+i,{id:'load'+i,title:'Load test card '+i,notes:'x'.repeat(120),column:['ideas','todo','doing','done'][i%4],priority:'med',tags:['load'],checklist:[],owner:'persona',order:i,createdAt:Date.now(),updatedAt:Date.now()});
    const es=[];for(let i=0;i<20;i++)es.push(http.get(BASE+'api/events',r=>r.resume()));
    await sleep(1500);const loaded=rss(srv.pid);es.forEach(r=>r.destroy());
    // TV page metrics with the bigger board, via Chrome DevTools
    await B.reload();await live(B);await waitFor(B,()=>window.__kanban.state.cards.length>300);await sleep(500);
    const cdp=await ctxB.newCDPSession(B);await cdp.send('Performance.enable');await cdp.send('HeapProfiler.collectGarbage');
    const m=Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]));
    for(let i=0;i<300;i++)await api('DELETE','/api/card/load'+i,{updatedAt:Date.now()});
    const out={serverIdleMB:+idle.toFixed(1),serverLoadedMB:+loaded.toFixed(1),tvJsHeapMB:+(m.JSHeapUsedSize/1048576).toFixed(1),tvDomNodes:m.Nodes,cards:310};
    const bare=+require('child_process').execSync(`${process.execPath} -e "setTimeout(()=>console.log(process.memoryUsage().rss),300)"`).toString()/1048576;
    out.bareNodeMB=+bare.toFixed(1);out.serverOverheadMB=+(loaded-bare).toFixed(1);
    global.MEM=out;assert(loaded-bare<10&&loaded<56,'server RSS '+loaded.toFixed(1)+' MB (bare node '+bare.toFixed(1)+')');return JSON.stringify(out);});

  await check('no console errors (outside deliberate outages)',async()=>{assert(consoleErrors.length===0,consoleErrors.join('\n'));
    return `0 errors; ${expectedNetErrors.length} expected network errors logged by Chrome only while the server was killed / device offline`;});
  await browser.close();await stopServer();
  const pass=results.filter(r=>r.ok).length;console.log(`\n${pass}/${results.length} passed`);
  fs.writeFileSync(path.join(ROOT,'test','results.json'),JSON.stringify({when:new Date().toISOString(),results,memory:global.MEM,expectedNetErrors},null,2));
  process.exit(pass===results.length?0:1);
})().catch(async e=>{console.error(e);try{await stopServer('SIGKILL');}catch(_){}process.exit(2);});
