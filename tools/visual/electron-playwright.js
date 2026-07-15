'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const { _electron: electron } = require('playwright');
const { start } = require('./harness.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MOTION_TARGET = { minFps: 95, maxP95Ms: 18, maxFrameMs: 50, maxOver34Ms: 1 };
const readyHome = () => document.body.dataset.crmModule === 'home'
  && !document.querySelector('.crm-home-surface')?.hidden
  && document.querySelectorAll('.crm-home-grid > .crm-home-bucket').length === 6
  && window.crmHome?.motionStatus?.().ready
  && [...document.querySelectorAll('.crm-home-grid .crm-home-preview')].every((host) => {
    const image = host.querySelector(':scope > .crm-home-preview-foreground');
    const sharp = host.querySelector(':scope > .crm-home-preview-sharp');
    return host.children.length <= 2 && (!sharp || sharp.complete) && image?.complete && image.naturalWidth > 0;
  });

async function frameRate(page, duration = 1200) {
  return page.evaluate((ms) => new Promise((resolve) => {
    const started = performance.now(); let frames = 0;
    const tick = (now) => { frames += 1; if (now - started >= ms) resolve(frames * 1000 / (now - started)); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }), duration);
}

async function startMotionProbe(page, label, duration = 560) {
  await page.evaluate(({ probeLabel, durationMs }) => {
    window.__crmMotionProbes ||= {};
    const probe = { label: probeLabel, durationMs, startedAt: performance.now(), deltas: [], done: false };
    probe.promise = new Promise((resolve) => {
      let previous = probe.startedAt;
      const tick = (now) => {
        probe.deltas.push(now - previous);
        previous = now;
        if (now - probe.startedAt < durationMs) requestAnimationFrame(tick);
        else {
          const sorted = [...probe.deltas].sort((a, b) => a - b);
          const percentile = (value) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value) - 1))] || 0;
          probe.result = {
            label: probeLabel,
            durationMs: now - probe.startedAt,
            frames: probe.deltas.length,
            fps: probe.deltas.length * 1000 / (now - probe.startedAt),
            p95Ms: percentile(.95),
            p99Ms: percentile(.99),
            maxMs: sorted.at(-1) || 0,
            over25Ms: probe.deltas.filter((delta) => delta > 25).length,
            over34Ms: probe.deltas.filter((delta) => delta > 34).length,
          };
          probe.done = true;
          resolve(probe.result);
        }
      };
      requestAnimationFrame(tick);
    });
    window.__crmMotionProbes[probeLabel] = probe;
  }, { probeLabel: label, durationMs: duration });
}

async function finishMotionProbe(page, label) {
  return page.evaluate((probeLabel) => window.__crmMotionProbes?.[probeLabel]?.promise, label);
}

function assertMotion(label, probe) {
  if (!probe || probe.fps < MOTION_TARGET.minFps || probe.p95Ms > MOTION_TARGET.maxP95Ms
    || probe.maxMs > MOTION_TARGET.maxFrameMs || probe.over34Ms > MOTION_TARGET.maxOver34Ms) {
    throw new Error(`${label} missed motion budget ${JSON.stringify({ target: MOTION_TARGET, probe })}`);
  }
}

function imageDifference(exactBuffer, liveBuffer, region) {
  const exact = PNG.sync.read(exactBuffer); const live = PNG.sync.read(liveBuffer);
  if (exact.width !== live.width || exact.height !== live.height) return Infinity;
  let sum = 0, count = 0;
  for (let y = region.top; y < region.bottom; y += 2) for (let x = region.left; x < region.right; x += 2) {
    const index = (y * exact.width + x) * 4;
    for (let channel = 0; channel < 3; channel += 1) { sum += Math.abs(exact.data[index + channel] - live.data[index + channel]); count += 1; }
  }
  return count ? sum / count : Infinity;
}

async function main() {
  const out = path.join(__dirname, 'electron-actual');
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  const { apiUrl } = await start();
  const app = await electron.launch({ args: ['.'], cwd: path.resolve(__dirname, '..', '..'), env: { ...process.env, CRM_API_URL: apiUrl, CRM_API_PORT: '3899' }, timeout: 30000 });
  const page = await app.firstWindow(); const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForLoadState('load');
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dashboard-booting') && window.crmWorkspaces, null, { timeout: 30000 });
  await page.evaluate(() => window.crmWorkspaces.setActive('home'));
  await page.waitForFunction(readyHome, null, { timeout: 60000 });
  await sleep(150);

  const startup = await page.evaluate(() => ({
    buckets: [...document.querySelectorAll('.crm-home-grid > .crm-home-bucket')].map((bucket) => {
      const host = bucket.querySelector('.crm-home-preview'); const image = host.querySelector(':scope > img');
      const style = getComputedStyle(bucket);
      return { key: bucket.dataset.module, version: host.dataset.previewVersion, children: host.children.length, tag: image?.tagName, width: image?.naturalWidth, height: image?.naturalHeight,
        shift: getComputedStyle(host).getPropertyValue('--far-shift-y').trim(), liveTrees: host.querySelectorAll('.crm-home-lod-scene,.crm-home-lod-root,[data-crm-theater]').length,
        glass: { backdrop: style.webkitBackdropFilter || style.backdropFilter, background: style.backgroundImage } };
    }),
    controls: document.querySelectorAll('.window-control-cluster .window-glass-control').length,
    drag: (() => { const node = document.querySelector('.app-window-drag-region'); const style = getComputedStyle(node); return { region: style.webkitAppRegion, top: document.elementsFromPoint(520,20)[0] === node }; })(),
  }));
  if (startup.buckets.length !== 6 || startup.buckets.some((item) => item.version !== 'preblurred-home-v23' || item.children !== 1 || item.tag !== 'IMG' || item.width < 880 || item.height < 600 || item.liveTrees)) {
    throw new Error(`Home is not six inert native captures: ${JSON.stringify(startup)}`);
  }
  if (startup.buckets.some((item) => !item.glass.backdrop.includes('blur(26px)')
    || !item.glass.background.includes('rgba(22, 26, 36, 0.62)')
    || !item.glass.background.includes('rgba(12, 16, 24, 0.55)'))) {
    throw new Error(`Home tiles do not use the exact account/background menu glass: ${JSON.stringify(startup.buckets)}`);
  }
  if (startup.controls < 3 || startup.drag.region !== 'drag' || !startup.drag.top) throw new Error(`Original window chrome contract changed: ${JSON.stringify(startup)}`);
  const dragStart = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.isVisible())?.getPosition());
  await page.mouse.move(520, 20); await page.mouse.down(); await page.mouse.move(640, 90, { steps: 12 }); await page.mouse.up(); await sleep(200);
  const dragEnd = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.isVisible())?.getPosition());
  const nativeDrag = { dx: dragEnd[0] - dragStart[0], dy: dragEnd[1] - dragStart[1] };
  const syntheticDragMoved = Math.abs(nativeDrag.dx) >= 60 && Math.abs(nativeDrag.dy) >= 30;
  if (!syntheticDragMoved && process.env.CRM_ALLOW_SYNTHETIC_DRAG_MISS !== '1') throw new Error(`Native window drag did not move BrowserWindow: ${JSON.stringify({ dragStart, dragEnd, nativeDrag })}`);
  nativeDrag.syntheticMissAllowed = !syntheticDragMoved;
  await app.evaluate(({ BrowserWindow }, position) => BrowserWindow.getAllWindows().find((win) => win.isVisible())?.setPosition(position[0], position[1]), dragStart);
  const sameNodes = await page.evaluate(() => { const selector='.crm-home-grid > .crm-home-bucket .crm-home-preview > .crm-home-preview-foreground'; const before=[...document.querySelectorAll(selector)]; for(let i=0;i<20;i+=1)window.crmHome.refresh(); const after=[...document.querySelectorAll(selector)]; return before.length===6&&after.length===6&&before.every((node,index)=>node===after[index]); });
  if (!sameNodes) throw new Error('Home refresh recreated screenshot objects');
  const homeFps = await frameRate(page); if (homeFps < 45) throw new Error(`Home FPS ${homeFps}`);
  await page.screenshot({ path: path.join(out, '01-home.png') });

  const instantControls = await page.evaluate(() => {
    const measure = (activate, reacted) => {
      const started = performance.now(); activate();
      return { elapsedMs: performance.now() - started, reacted: !!reacted() };
    };
    const background = document.querySelector('.background-tone-menu');
    background.open = false;
    const backgroundMenu = measure(() => background.querySelector('summary').click(), () => background.open);
    background.open = false;
    const profile = document.querySelector('.auth-profile-cluster');
    profile?.classList.remove('open');
    const accountMenu = measure(() => profile?.querySelector('.auth-profile-button')?.click(), () => profile?.classList.contains('open'));
    profile?.classList.remove('open');
    window.crmSearchDeck?.close?.();
    const search = measure(() => document.querySelector('.control-bar-search')?.click(), () => window.crmSearchDeck?.isOpen?.());
    window.crmSearchDeck?.close?.();
    return { backgroundMenu, accountMenu, search };
  });
  if (Object.values(instantControls).some((control) => !control.reacted || control.elapsedMs > 32)) {
    throw new Error(`A top-level control did not react in the originating frame: ${JSON.stringify(instantControls)}`);
  }

  const domainProbe = await page.evaluate(async () => { try { await window.crmDomain.list('commitments', { limit:1 }); return true; } catch { return false; } });
  if (!domainProbe) throw new Error('domain:list is not handled');

  for (let index=0; index<2; index+=1) {
    await page.reload({ waitUntil:'load' });
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dashboard-booting') && window.crmWorkspaces, null, { timeout:30000 });
    await page.evaluate(() => window.crmWorkspaces.setActive('home'));
    await page.waitForFunction(readyHome, null, { timeout:30000 });
    const chrome = await page.evaluate(() => { const drag=document.querySelector('.app-window-drag-region'); return { drag:getComputedStyle(drag).webkitAppRegion, top:document.elementsFromPoint(520,20)[0]===drag, controls:document.querySelectorAll('.window-control-cluster .window-glass-control').length }; });
    if (chrome.drag !== 'drag' || !chrome.top || chrome.controls < 3) throw new Error(`Chrome stale after reload ${index+1}: ${JSON.stringify(chrome)}`);
  }

  const rooms = [
    {key:'desk',theater:'desk',content:'.crm-overview-panel',expected:3}, {key:'people',theater:'people',content:'.tk-zone',expected:8},
    {key:'cases',theater:'tickets',content:'.tk-zone',expected:3}, {key:'bills',theater:'bills',content:'.tk-zone',expected:3},
    {key:'invoices',theater:'money',content:'.tk-zone',expected:3}, {key:'assignments',theater:'assignments',content:'.crm-assignment-bucket',expected:4},
  ];
  const transitions=[];
  for (const room of rooms) {
    const before = await page.evaluate((key)=>window.crmHome.previewStatus().find((item)=>item.key===key)?.capturedAt||0,room.key);
    const selector=`.crm-home-grid > .crm-home-bucket[data-module="${room.key}"]`;
    await page.hover(selector); await sleep(160);
    await page.evaluate(() => { const p=window.__fps={start:performance.now(),frames:0,fps:0}; const tick=(now)=>{p.frames+=1;if(now-p.start<1100)requestAnimationFrame(tick);else p.fps=p.frames*1000/(now-p.start)};requestAnimationFrame(tick); });
    await startMotionProbe(page, `in-${room.key}`);
    const inboundReaction=await page.$eval(selector,(bucket)=>{const started=performance.now();bucket.click();return{elapsedMs:performance.now()-started,busy:window.crmDeskTransit?.isBusy?.(),transitioning:window.crmHomeCamera?.isTransitioning?.()}});
    if(!inboundReaction.busy||!inboundReaction.transitioning||inboundReaction.elapsedMs>50)throw new Error(`${room.key} click did not start its camera move immediately: ${JSON.stringify(inboundReaction)}`);
    await sleep(100);
    const mid=await page.evaluate(()=>{const e=document.querySelector('.crm-home-expander:not(.crm-home-warm)');const r=e?.getBoundingClientRect();const root=window.crmHomeCamera?.layers?.()[0];const surface=window.crmHomeCamera?.surface?.();const drag=document.querySelector('.app-window-drag-region');const titles=[...(surface?.querySelectorAll('.crm-home-title-glass')||[])];const snapshot=root?.querySelector(':scope>.crm-home-motion-snapshot');return{module:document.body.dataset.crmModule,transitioning:window.crmHomeCamera?.isTransitioning?.(),images:e?.querySelectorAll('img').length||0,rect:r?{width:r.width,height:r.height}:null,neighborOpacity:root?Number(getComputedStyle(root).opacity):0,titlesHidden:surface?.classList.contains('crm-home-camera-moving')&&titles.length>0&&titles.every((title)=>getComputedStyle(title).visibility==='hidden'),snapshotActive:!!snapshot&&getComputedStyle(snapshot).display!=='none'&&getComputedStyle(root.querySelector(':scope>.crm-home-grid')).visibility==='hidden',rootComposited:root?getComputedStyle(root).willChange.includes('transform'):false,dragTop:document.elementsFromPoint(520,20)[0]===drag,controlsTop:[...document.querySelectorAll('.window-control-cluster .window-glass-control')].every((n)=>{const b=n.getBoundingClientRect(),h=document.elementsFromPoint(b.left+b.width/2,b.top+b.height/2)[0];return h===n||n.contains(h)})}});
    const inFlight=mid.module==='home'&&mid.transitioning&&mid.images===1&&mid.rect&&mid.rect.width>=300;
    const alreadyLanded=mid.module===room.key&&!mid.transitioning;
    if((!inFlight&&!alreadyLanded)||(inFlight&&(mid.neighborOpacity<.99||!mid.titlesHidden||!mid.snapshotActive||!mid.rootComposited))||!mid.dragTop||!mid.controlsTop)throw new Error(`${room.key} camera mid-state broken: ${JSON.stringify(mid)}`);
    await page.screenshot({path:path.join(out,`transition-${room.key}.png`)});
    await page.waitForFunction((key)=>document.body.dataset.crmModule===key,room.key,{timeout:10000}); await sleep(650);
    await page.mouse.move(1,1); await sleep(80);
    const state=await page.evaluate(async(config)=>{
      const theater=document.querySelector(`[data-crm-theater="${config.theater}"]`);
      const preview=(await window.crmHomePreviews.list()).previews.find((item)=>item.key===config.key);
      const signature={module:document.body.dataset.crmModule||'',text:String(theater?.innerText||'').replace(/\s+/g,' ').trim(),elements:theater?.querySelectorAll('*').length||0,calendarYear:window.fractalCalendar?.year?.()||null};
      const bucketGeometry=[...(theater?.querySelectorAll('.tk-zone')||[])].map((bucket)=>{const rect=bucket.getBoundingClientRect();return{width:rect.width,height:rect.height,ratio:rect.width/rect.height}});
      return{visible:!!theater&&!theater.hidden,count:theater?.querySelectorAll(config.content).length||0,arrows:theater?.querySelectorAll('svg.tk-flow,.tk-flow-shaft,.tk-flow-head').length||0,bucketGeometry,signature,previewSignature:preview?.layoutSignature||null,exactSrc:preview?.exactSrc||'',veil:document.querySelectorAll('.crm-transit-veil').length,invalid:[...(theater?.querySelectorAll('*')||[])].filter((n)=>/NaN|Infinity/.test(getComputedStyle(n).transform)).length};
    },room);
    const liveBuffer=await page.screenshot({path:path.join(out,`room-${room.key}.png`)});
    const exactBuffer=Buffer.from(state.exactSrc.split(',')[1]||'','base64');
    const pixelMae=imageDifference(exactBuffer,liveBuffer,{left:50,right:1230,top:105,bottom:755});
    const probe={settled:await page.evaluate(()=>window.__fps),transition:await finishMotionProbe(page,`in-${room.key}`)};
    assertMotion(`${room.key} inbound`,probe.transition);
    const badBucket=state.bucketGeometry.some((bucket)=>bucket.width<180||bucket.width>270||bucket.height<300||bucket.height>410||bucket.ratio<.55||bucket.ratio>.85);
    if(!state.visible||state.count!==room.expected||state.arrows||badBucket||state.veil||state.invalid||JSON.stringify(state.signature)!==JSON.stringify(state.previewSignature)||pixelMae>12||probe.settled.fps<40||probe.transition.fps<45)throw new Error(`${room.key} capture/live mismatch: ${JSON.stringify({state:{...state,exactSrc:undefined},pixelMae,probe})}`);
    await startMotionProbe(page,`out-${room.key}`);
    const outboundReaction=await page.evaluate(()=>{const started=performance.now();window.__homeDrive=window.crmDeskTransit.driveTo('home');return{elapsedMs:performance.now()-started,busy:window.crmDeskTransit?.isBusy?.(),level:window.crmHomeCamera?.level?.(),module:document.body.dataset.crmModule}});
    if(!outboundReaction.busy||outboundReaction.level!==1||outboundReaction.module!=='home'||outboundReaction.elapsedMs>50)throw new Error(`${room.key} Home click did not start its camera move immediately: ${JSON.stringify(outboundReaction)}`);
    await page.evaluate(()=>window.__homeDrive); await page.waitForFunction(readyHome,null,{timeout:15000});
    const outbound=await finishMotionProbe(page,`out-${room.key}`);
    assertMotion(`${room.key} outbound`,outbound);
    await page.waitForFunction(({key,before})=>(window.crmHome.previewStatus().find((item)=>item.key===key)?.capturedAt||0)>before,{key:room.key,before},{timeout:30000});
    transitions.push({key:room.key,mid,pixelMae,fps:probe.settled.fps,inbound:probe.transition,outbound,inboundReaction,outboundReaction,signatureMatches:true});
  }
  const transitTimings=await page.evaluate(()=>window.crmDeskTransit?.performanceTimings?.()||[]);
  await page.evaluate(()=>window.crmWorkspaces.setActive('people'));
  await page.waitForFunction(()=>!!document.querySelector('[data-crm-theater="people"] .tk-zcard[data-id="ct_marta"]'),null,{timeout:10000});
  await page.$eval('[data-crm-theater="people"] .tk-zcard[data-id="ct_marta"]',(card)=>{const r=card.getBoundingClientRect();card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+20,clientY:r.top+20,button:2}))});
  await page.click('.tk-menu .tk-menu-item[data-act^="custom-"]');
  await page.waitForSelector('.crm-person-history-shell:not([hidden]) .crm-person-history',{timeout:10000});await sleep(250);
  const personHistory=await page.evaluate(()=>{const shell=document.querySelector('.crm-person-history-shell:not([hidden])');const panel=shell?.querySelector('.crm-person-history');const body=panel?.querySelector('.crm-person-history-body');const thread=panel?.querySelector('.crm-person-history-thread');const composer=panel?.querySelector('.crm-person-history-composer');const rect=panel?.getBoundingClientRect();const composerRect=composer?.getBoundingClientRect();const tint=getComputedStyle(document.querySelector('.crm-module-switch'),'::after');return{title:panel?.querySelector('.crm-person-history-title')?.textContent.trim(),events:panel?.querySelectorAll('.crm-person-history-event').length||0,filters:panel?.querySelectorAll('[data-history-filter]').length||0,composer:!!composer,canonical:panel?.classList.contains('crm-menu-surface')||false,inBounds:!!rect&&rect.left>=0&&rect.top>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight,composerInBounds:!!composerRect&&composerRect.bottom<=rect.bottom+1,noHorizontalOverflow:!!body&&!!thread&&body.scrollWidth<=body.clientWidth+1&&thread.scrollWidth<=thread.clientWidth+1,tinted:tint.backgroundImage.includes('rgba(13, 35, 72')&&tint.boxShadow!=='none'}});
  if(personHistory.title!=='Marta Reyes'||personHistory.events<6||personHistory.filters!==5||!personHistory.composer||!personHistory.canonical||!personHistory.inBounds||!personHistory.composerInBounds||!personHistory.noHorizontalOverflow||!personHistory.tinted)throw new Error(`Person history native layout broken: ${JSON.stringify(personHistory)}`);
  await page.screenshot({path:path.join(out,'person-history.png')});
  await page.click('[data-person-history-close]');
  await page.evaluate(()=>window.crmWorkspaces.setActive('home'));await page.waitForFunction(readyHome,null,{timeout:15000});
  const settledFps=await frameRate(page); if(settledFps<45)throw new Error(`Settled Home FPS ${settledFps}`);
  await sleep(100); const windows=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter((win)=>!win.isDestroyed()).length); if(windows!==1)throw new Error(`${windows} BrowserWindows remain`);
  const finalChrome=await page.evaluate(()=>{const drag=document.querySelector('.app-window-drag-region');return{drag:getComputedStyle(drag).webkitAppRegion,top:document.elementsFromPoint(520,20)[0]===drag,controls:document.querySelectorAll('.window-control-cluster .window-glass-control').length}});
  if(finalChrome.drag!=='drag'||!finalChrome.top||finalChrome.controls<3)throw new Error(`Chrome stale after camera cycles: ${JSON.stringify(finalChrome)}`);
  await page.click('.window-minimize-control'); await sleep(350);
  const minimized=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find((win)=>!win.isDestroyed())?.isMinimized()||false);
  if(!minimized)throw new Error('Minimize control did not minimize the window');
  await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find((item)=>!item.isDestroyed());win?.restore();win?.show()});await sleep(250);
  await page.click('.window-close-control');await sleep(250);
  const hidden=await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find((item)=>!item.isDestroyed());return!!win&&!win.isVisible()});
  if(!hidden)throw new Error('Close control did not hide the window');
  await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find((item)=>!item.isDestroyed());win?.show();win?.focus()});await sleep(250);
  await Promise.all([page.waitForEvent('load',{timeout:10000}),page.click('.window-refresh-control')]);
  await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-dashboard-booting')&&window.crmWorkspaces,null,{timeout:30000});
  await page.evaluate(()=>window.crmWorkspaces.setActive('home'));await page.waitForFunction(readyHome,null,{timeout:30000});
  await page.screenshot({path:path.join(out,'02-home-after-cycles.png')});
  const evidence={startup,nativeDrag,sameNodes,homeFps,settledFps,instantControls,domainProbe,transitions,transitTimings,personHistory,windows,finalChrome,windowControls:{refresh:true,minimized,hidden},errors};
  fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2)); console.log('[electron-playwright]',evidence);
  if(errors.length)throw new Error(errors.join(' | ')); await app.close(); process.exit(0);
}
main().catch((error)=>{console.error(error);process.exit(1)});
