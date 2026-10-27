/* Clean screenshots for the README: fresh board, a couple of example cards. node test/shots.js */
const {chromium}=require(process.env.PW||'playwright-core');const {spawn}=require('child_process');const fs=require('fs');const path=require('path');
const ROOT=path.resolve(__dirname,'..');const PORT='8095';const DATA=fs.mkdtempSync('/tmp/kanban-shots-');const BASE=`http://localhost:${PORT}/`;const S=f=>path.join(ROOT,'screenshots',f);
(async()=>{const srv=spawn(process.execPath,[path.join(ROOT,'server.js')],{env:{...process.env,PORT,DATA_DIR:DATA}});await new Promise(r=>srv.stdout.on('data',d=>/on http/.test(d)&&r()));
const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
const live=p=>p.waitForFunction(()=>window.__kanban&&window.__kanban.store.debug().status==='live');
const who=async(ctx,w)=>ctx.addInitScript(`localStorage.setItem('kanban-me','${w}')`);
const pc=await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,colorScheme:'light'});await who(pc,'persona');const P=await pc.newPage();await P.goto(BASE);await live(P);await P.waitForTimeout(500);
const lc=await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,colorScheme:'light'});await who(lc,'personb');const L=await lc.newPage();await L.goto(BASE);await live(L);
await L.fill('[data-quick="todo"] input','Buy cat food');await L.press('[data-quick="todo"] input','Enter');
await P.fill('[data-quick="todo"] input','Vet appointment for Mochi');await P.press('[data-quick="todo"] input','Enter');
await L.tap('.card:has-text("Buy cat food") .menu-btn');await L.tap('.menu button:has-text("Doing")');
await P.waitForTimeout(500);await P.screenshot({path:S('phone-390x844.png')});
const fc=await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,colorScheme:'light'});const F=await fc.newPage();await F.goto(BASE);await live(F);await F.waitForTimeout(300);await F.screenshot({path:S('phone-who-are-you.png')});
const d=await b.newContext({viewport:{width:1280,height:800},colorScheme:'light'});await who(d,'persona');const D=await d.newPage();await D.goto(BASE);await live(D);await D.waitForTimeout(300);await D.screenshot({path:S('desktop-1280.png')});
const t=await b.newContext({viewport:{width:1920,height:1080}});const T=await t.newPage();await T.goto(BASE+'?tv=1&theme=light');await live(T);await T.waitForTimeout(300);await T.screenshot({path:S('tv-1080p.png')});
const t2=await b.newContext({viewport:{width:1920,height:1080}});const T2=await t2.newPage();await T2.goto(BASE+'?tv=1&theme=dark');await live(T2);await T2.waitForTimeout(300);await T2.screenshot({path:S('tv-1080p-dark.png')});
await b.close();srv.kill();console.log('shots ok');})().catch(e=>{console.error(e);process.exit(1);});
