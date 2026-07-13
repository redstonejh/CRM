// crm-home.js — six inert screenshot LODs hosted by the original camera.
(() => {
  if (typeof window.createFractalCamera !== "function") return;

  const MODULES = [
    { key: "desk", label: "Desk" }, { key: "people", label: "People" },
    { key: "pipeline", label: "Pipeline" }, { key: "jobs", label: "Jobs" },
    { key: "money", label: "Money" }, { key: "calendar", label: "Calendar" },
  ];
  const RETRY_MS = [0, 120, 320, 700, 1400, 2800, 5000];
  const previews = new Map();
  let camera = null;
  let subscribed = false;
  let retryTimer = 0;
  let retryAttempt = 0;

  const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[char]));

  const ensureStyles = () => {
    if (document.getElementById("crm-home-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-home-styles";
    style.textContent = `
      .crm-home-surface{position:fixed;inset:0;z-index:820;pointer-events:none;overflow:hidden}
      .crm-home-surface[hidden]{display:none}.crm-home-level{position:absolute;inset:0;transform-origin:0 0}
      .crm-home-grid{position:absolute;display:grid;pointer-events:auto;
        grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:16px}
      .crm-home-bucket{position:relative;box-sizing:border-box;display:block;min-height:0;overflow:hidden;color:#fff;
        cursor:pointer;border:0;container-type:size;border-radius:var(--home-r,16px);padding:0;
        background:linear-gradient(180deg,rgba(22,26,36,.34),rgba(12,16,24,.28));
        -webkit-backdrop-filter:blur(28px) saturate(140%);backdrop-filter:blur(28px) saturate(140%);
        box-shadow:inset 0 0 0 1px rgba(255,255,255,.14),inset 0 1px 0 rgba(255,255,255,.18),0 18px 42px rgba(0,0,0,.28);
        transition:box-shadow .18s ease,background .18s ease}
      .crm-home-bucket:hover{background:linear-gradient(180deg,rgba(70,110,190,.34),rgba(40,70,130,.26));
        box-shadow:inset 0 0 0 1px rgba(125,180,255,.5),0 0 30px rgba(90,150,255,.42)}
      .crm-home-title-glass{position:absolute;z-index:4;left:50%;top:50%;transform:translate(-50%,-50%);width:max-content;
        max-width:80%;text-align:center;pointer-events:none;transition:opacity .18s ease}
      .crm-home-title{font:600 clamp(11px,3.2cqh,15px)/1.05 system-ui;letter-spacing:.14em;text-transform:uppercase;
        color:rgba(226,234,246,.72);text-shadow:0 1px 0 rgba(255,255,255,.19),0 -1px 0 rgba(0,0,0,.78),0 2px 8px rgba(0,0,0,.24)}
      .crm-home-bucket:hover .crm-home-title-glass{opacity:.72}
      .crm-home-preview{position:absolute;inset:0;z-index:1;overflow:hidden;border-radius:inherit;color:rgba(255,255,255,.62)}
      .crm-home-preview-state{position:absolute;inset:0;display:grid;place-items:center;font-size:.68rem;font-weight:760;
        letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.38)}
      .crm-home-preview-image{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:cover;pointer-events:none;
        user-select:none;transform:translateY(var(--far-shift-y,0%));transform-origin:center}
      /* The transition lid is full-viewport. It must stay neutral in Electron's
         native app-region map or its temporary rectangle can cancel (and on
         Windows, outlive) the persistent title-bar drag strip. */
      .crm-home-expander{position:absolute;z-index:5;pointer-events:none;transform-origin:0 0;
        background:transparent!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;box-shadow:none!important}
      .crm-home-expander .crm-home-title-glass{display:none}.crm-home-expander .crm-home-preview{opacity:1}
      .crm-home-preview-exact{opacity:0;transform:none}
      .crm-home-expander .crm-home-preview-foreground{transition:transform 460ms cubic-bezier(.22,1,.26,1),opacity 120ms ease 330ms}
      .crm-home-expander .crm-home-preview-exact{transition:opacity 120ms ease 330ms}
      .crm-home-expander.is-unwrapping .crm-home-preview-foreground{transform:none;opacity:0}
      .crm-home-expander.is-unwrapping .crm-home-preview-exact{opacity:1}
      .crm-home-warm,.crm-home-warm *{pointer-events:none!important}
    `;
    document.head.appendChild(style);
  };

  const bucketHTML = (module) => `
    <div class="crm-home-preview" data-preview-key="${esc(module.key)}" data-preview-state="waiting" aria-hidden="true">
      <span class="crm-home-preview-state">Preparing</span>
    </div>
    <div class="crm-home-title-glass"><div class="crm-home-title">${esc(module.label)}</div></div>`;

  const farShift = (preview) => {
    const bounds = preview?.foregroundBounds;
    if (!bounds || !preview.height) return 0;
    const contentCenter = bounds.y + bounds.height / 2;
    return Math.max(-6, Math.min(6, (preview.height / 2 - contentCenter) / preview.height * 100));
  };
  const imageNode = (className, src) => {
    const image = document.createElement("img");
    image.className = `crm-home-preview-image ${className}`;
    image.src = src; image.alt = ""; image.draggable = false; image.decoding = "async";
    return image;
  };
  const mountHost = (host, preview, exact = false) => {
    if (!host || !preview?.foregroundSrc) return false;
    host.style.setProperty("--far-shift-y", `${farShift(preview).toFixed(3)}%`);
    let foreground = host.querySelector(":scope > .crm-home-preview-foreground");
    if (!foreground) {
      foreground = imageNode("crm-home-preview-foreground", preview.foregroundSrc);
      host.replaceChildren(foreground);
    } else if (foreground.src !== preview.foregroundSrc) foreground.src = preview.foregroundSrc;
    if (exact) {
      let full = host.querySelector(":scope > .crm-home-preview-exact");
      if (!full) { full = imageNode("crm-home-preview-exact", preview.exactSrc); host.appendChild(full); }
      else if (full.src !== preview.exactSrc) full.src = preview.exactSrc;
    }
    host.dataset.previewState = "ready";
    host.dataset.capturedAt = String(preview.capturedAt || 0);
    host.closest(".crm-home-bucket")?.setAttribute("data-preview-ready", "true");
    return true;
  };
  const mountPreview = (key) => {
    const host = camera?.layers?.()[0]?.querySelector(`.crm-home-bucket[data-module="${key}"] .crm-home-preview`);
    return mountHost(host, previews.get(key), false);
  };
  const mountAll = () => MODULES.forEach(({ key }) => mountPreview(key));
  const acceptPreview = (preview) => {
    if (!preview?.foregroundSrc || !preview?.exactSrc || !MODULES.some(({ key }) => key === preview.key)) return false;
    previews.set(preview.key, preview);
    if (camera?.isActive?.() && camera.level() === 0) mountPreview(preview.key);
    return true;
  };
  const requestPreviews = async (reset = false) => {
    clearTimeout(retryTimer);
    if (window.crmHomePreviews?.isCaptureWorker) return;
    if (reset) retryAttempt = 0;
    try { (await window.crmHomePreviews?.list?.())?.previews?.forEach(acceptPreview); } catch {}
    if (previews.size === MODULES.length) return;
    retryTimer = setTimeout(() => requestPreviews(false), RETRY_MS[Math.min(retryAttempt++, RETRY_MS.length - 1)]);
  };
  const subscribe = () => {
    if (subscribed || window.crmHomePreviews?.isCaptureWorker) return;
    subscribed = true;
    try { window.crmHomePreviews?.onChanged?.(acceptPreview); } catch {}
    requestPreviews(true);
  };

  const buildRoot = () => {
    const root = document.createElement("div"); root.className = "crm-home-level";
    const grid = document.createElement("div"); grid.className = "crm-home-grid";
    MODULES.forEach((module) => {
      const bucket = document.createElement("button"); bucket.type = "button"; bucket.className = "crm-home-bucket";
      bucket.dataset.module = module.key; bucket.dataset.enabled = "true"; bucket.innerHTML = bucketHTML(module); grid.appendChild(bucket);
    });
    root.appendChild(grid); requestAnimationFrame(mountAll); return root;
  };
  const layout = ({ expRect }) => {
    const surface = camera?.surface?.(); const grid = surface?.querySelector(".crm-home-grid"); if (!grid) return;
    const GAP = 16, OUTER = 16, full = expRect(); let controlsBottom = 42;
    document.querySelectorAll(".window-control-cluster").forEach((node) => { controlsBottom = Math.max(controlsBottom, node.getBoundingClientRect().bottom); });
    const top = Math.round(controlsBottom + 12); const area = { x: OUTER, y: top, w: full.w - 2 * OUTER, h: full.h - top - OUTER };
    const aspect = innerWidth / innerHeight; let cellW = (area.w - 32) / 3; let cellH = cellW / aspect;
    if (2 * cellH + GAP > area.h) { cellH = (area.h - GAP) / 2; cellW = cellH * aspect; }
    const gridW = 3 * cellW + 32, gridH = 2 * cellH + GAP;
    Object.assign(grid.style, { left:`${area.x + (area.w-gridW)/2}px`, top:`${area.y + (area.h-gridH)/2}px`, width:`${gridW}px`, height:`${gridH}px` });
    surface.style.setProperty("--home-r", `${Math.min(64,Math.max(2,16/245*Math.min(cellW,cellH)*2)).toFixed(1)}px`);
  };
  const targetAtPoint = (x, y, context) => context.level > 0 ? null
    : [...(context.layers[0]?.querySelectorAll('.crm-home-bucket[data-enabled="true"]') || [])].find((bucket) => {
      const rect = bucket.getBoundingClientRect(); return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }) || null;
  const targetFromEvent = (event, context) => {
    if (context.level > 0) return null;
    const target = event.target.closest?.('.crm-home-bucket[data-enabled="true"]');
    return target && context.layers[0]?.contains(target) ? target : null;
  };
  const buildExpander = (target) => {
    const module = MODULES.find(({ key }) => key === target?.dataset?.module) || MODULES[0];
    const bucket = document.createElement("div"); bucket.className = "crm-home-bucket crm-home-expander";
    bucket.dataset.module = module.key; bucket.innerHTML = bucketHTML(module);
    mountHost(bucket.querySelector(".crm-home-preview"), previews.get(module.key), true);
    return bucket;
  };

  camera = window.createFractalCamera({
    apiName:"crmHomeCamera",theater:"home",surfaceClass:"crm-home-surface",layerClass:"crm-home-level",
    warmClass:"crm-home-warm",contractingClass:"crm-home-contracting",active:false,maxLevel:1,margin:0,
    expandFadeMs:70,belowFadeMs:70,contractFadeMs:70,measureTop:()=>0,ensureStyles,buildRoot,layout,targetFromEvent,targetAtPoint,buildExpander,
    keyOf:(target)=>target.dataset.module||"",sourceSelector:(target)=>`.crm-home-bucket[data-module="${target.dataset.module}"]`,
    prepareJump:(expander)=>expander.classList.add("is-unwrapping"),
    onTransitionStart:(direction,context)=>{
      const expander=[...(context.surface?.querySelectorAll(".crm-home-expander:not(.crm-home-warm)")||[])].pop();
      if(expander)requestAnimationFrame(()=>expander.classList.toggle("is-unwrapping",direction==="expand"));
    },
    onLevelChange:(context)=>{if(context.active&&context.level===0)mountAll()},
  });

  document.addEventListener("click", (event) => {
    if (!camera?.isActive?.()) return;
    const target = event.target?.closest?.(".crm-home-bucket[data-module]");
    if (!target || !camera.surface()?.contains(target)) return;
    const key = target.dataset.module;
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    if (!camera.isTransitioning()) camera.expand(target);
    if (window.crmDeskTransit?.adoptDive) window.crmDeskTransit.adoptDive(key);
    else window.crmWorkspaces?.setActive?.(key);
  }, true);

  const setActive = (on) => { subscribe(); camera.setActive(on); if (on) { mountAll(); requestPreviews(false); } return window.crmHome; };
  const waitForModuleSettled = (key, timeoutMs = 1800) => new Promise((resolve) => {
    const started = performance.now(); const theater = key === "people" ? "relationships" : key;
    const selector = {desk:".crm-desk-frame",people:".crm-people-frame,.crm-company-list",pipeline:".tk-zone,.tk-deck",jobs:".tk-zone,.tk-deck",money:".tk-zone,.tk-deck",calendar:".fc-grid"}[key]||"*";
    let stable=0,last=""; const tick=()=>{const source=[...document.querySelectorAll(`[data-crm-theater="${theater}"]`)].find((node)=>!node.hidden);
      const next=source?.querySelector?.(selector)?`${source.childElementCount}:${source.querySelectorAll("*").length}`:"";
      stable=next&&next===last?stable+1:0;last=next;if(stable>=2||performance.now()-started>=timeoutMs)resolve();else requestAnimationFrame(tick)};requestAnimationFrame(tick);
  });
  const captureBaseline = async (key) => {
    if (window.crmHomePreviews?.isCaptureWorker) return previews.get(key)||null;
    try { const result=await window.crmHomePreviews?.capture?.(key); if(result?.preview)acceptPreview(result.preview); } catch {}
    return previews.get(key)||null;
  };
  window.addEventListener("resize",()=>camera?.layout?.());
  window.crmHome={setActive,isActive:()=>camera.isActive(),refresh:()=>{camera.layout();mountAll();requestPreviews(false)},captureBaseline,waitForModuleSettled,
    previewStatus:()=>MODULES.map(({key})=>({key,state:previews.has(key)?"ready":"waiting",capturedAt:previews.get(key)?.capturedAt||0,layoutSignature:previews.get(key)?.layoutSignature||null}))};
})();
