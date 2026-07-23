// crm-planner.js — nested Projects world with persistent, user-defined pipelines.
(() => {
  const SELECTED_KEY = "crm-planner-selected-v2";
  const LEGACY_KEY = "crm-planner-projects-v1";
  const MIGRATED_KEY = "crm-planner-projects-migrated-v2";
  const EXPANDED_KEY = "crm-planner-stack-expansion-v1";
  const PROJECT_PREVIEW_VERSION = "project-tile-v1";
  const listeners = new Set();
  const rows = (result) => result?.records || [];
  const clone = (value) => typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
  const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[character]));
  const cssValue = (value) => window.CSS?.escape?.(String(value ?? "")) || String(value ?? "").replace(/["\\]/g, "\\$&");
  const uid = (prefix) => `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  const nowIso = () => new Date().toISOString();
  const first = (...values) => values.map((value) => String(value ?? "").trim()).find(Boolean) || "";
  const DEFAULT_STAGES = [
    { id:"backlog", title:"Backlog", kind:"queue" },
    { id:"active", title:"In progress", kind:"active" },
    { id:"done", title:"Done", kind:"done" },
  ];
  const PIPELINE_PRESETS = [
    { id:"simple", label:"Simple", stages:["Backlog", "In progress", "Done"] },
    { id:"review", label:"Review", stages:["Backlog", "In progress", "Review", "Done"] },
    { id:"custom", label:"Custom", stages:[] },
  ];

  let root = null;
  let camera = null;
  let wired = false;
  let active = false;
  let dirty = true;
  let refreshTimer = 0;
  let refreshPromise = null;
  let refreshTail = Promise.resolve();
  let floating = null;
  let selectedId = localStorage.getItem(SELECTED_KEY) || "";
  let dragItemId = "";
  let plannerResizeObserver = null;
  let projectGalleryResizeObserver = null;
  let plannerDetail = null;
  let detailSaveTimer = 0;
  let detailSaveTail = Promise.resolve();
  const plannerScrollPositions = new Map();
  let galleryScrollLeft = 0;
  let projectPreviewSubscribed = false;
  let projectPreviewTimer = 0;
  let projectEnvironmentObserver = null;
  const projectPreviews = new Map();
  const pendingProjectPreviews = new Map();
  const pendingDetailFields = new Map();
  let model = { projects:[], items:[], flows:[], commitments:[], contacts:[], tasks:[], tickets:[] };
  let expandedStacks = (() => { try { const value = JSON.parse(localStorage.getItem(EXPANDED_KEY) || "[]"); return new Set(Array.isArray(value) ? value.map(String) : []); } catch { return new Set(); } })();

  const normalizeStage = (stage = {}, index = 0) => ({
    id:String(stage.id || uid("stage")), title:first(stage.title, stage.label, `Stage ${index + 1}`),
    kind:String(stage.kind || (index === 0 ? "queue" : "active")), rank:Number.isFinite(Number(stage.rank)) ? Number(stage.rank) : index,
  });
  const stagesOf = (project) => {
    const raw = Array.isArray(project?.stages) && project.stages.length ? project.stages : DEFAULT_STAGES;
    return raw.map(normalizeStage).sort((a, b) => a.rank - b.rank).map((stage, index) => ({ ...stage, rank:index }));
  };
  const normalizeProject = (project = {}) => ({ ...project, id:String(project.id || ""), title:first(project.title, "Untitled project"), note:String(project.note || ""), stages:stagesOf(project) });
  const normalizeItem = (item = {}) => ({ ...item, id:String(item.id || ""), projectId:String(item.projectId || ""), stageId:String(item.stageId || ""), title:first(item.title, "Untitled card"), note:String(item.note || ""), priority:String(item.priority || "normal"), status:String(item.status || "open"), rank:Number(item.rank) || 0 });
  const projectById = (id) => model.projects.find((project) => project.id === String(id));
  const itemById = (id) => model.items.find((item) => item.id === String(id));
  const selectedProject = () => projectById(selectedId) || model.projects[0] || null;
  const stageById = (project, stageId) => stagesOf(project).find((stage) => stage.id === String(stageId));
  const commitmentFor = (item) => model.commitments.find((commitment) => commitment.id === item?.commitmentId)
    || model.commitments.find((commitment) => commitment.links?.some((link) => link.entityType === "workItems" && String(link.recordId) === String(item?.id)));
  const flowFor = (item) => model.flows.find((flow) => flow.entityType === "workItems" && String(flow.recordId) === String(item?.id));
  const contactName = (contact) => first(contact?.name, contact?.title, contact?.id, "Person");
  const recordName = (record) => first(record?.title, record?.name, record?.companyLabel, record?.description, record?.id, "Untitled");
  const expansionKey = (projectId, stageId) => `${projectId}:${stageId}`;
  const stageExpanded = (projectId, stageId) => expandedStacks.has(expansionKey(projectId, stageId));
  const setStageExpanded = (projectId, stageId, open = !stageExpanded(projectId, stageId)) => {
    const key = expansionKey(projectId, stageId); if (open) expandedStacks.add(key); else expandedStacks.delete(key);
    if (!window.crmHomePreviews?.isCaptureWorker) localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expandedStacks]));
    render(); return expandedStacks.has(key);
  };

  const writeSelected = () => {
    if (!window.crmHomePreviews?.isCaptureWorker) localStorage.setItem(SELECTED_KEY, selectedId);
  };
  const announce = (reason = "changed") => {
    const detail = { reason, selectedId, projects:projectsSnapshot() };
    listeners.forEach((listener) => { try { listener(detail); } catch {} });
    document.dispatchEvent(new CustomEvent("crm:planner-change", { detail }));
  };
  const publish = (reason = "changed") => {
    writeSelected(); render(); announce(reason);
  };
  const projectsSnapshot = () => clone(model.projects.map((project) => ({
    ...project,
    buckets:stagesOf(project).map((stage) => ({ ...stage, cards:model.items.filter((item) => item.projectId === project.id && item.stageId === stage.id) })),
  })));

  function ensureStyles() {
    if (document.getElementById("crm-planner-styles")) return;
    const style = document.createElement("style"); style.id = "crm-planner-styles"; style.textContent = `
      .crm-planner-surface{position:fixed;inset:0;z-index:836;color:#fff;overflow:hidden}.crm-planner-surface[hidden]{display:none}
      .crm-planner-level{position:absolute;inset:0;transform-origin:0 0}.crm-planner-warm,.crm-planner-warm *{pointer-events:none!important}.crm-planner-contracting{pointer-events:none!important}
      .crm-project-gallery-level{pointer-events:auto;-webkit-app-region:no-drag}.crm-project-gallery-shell{--crm-project-shadow-left:0;--crm-project-shadow-right:0;--crm-project-rail-inset:clamp(18px,2vw,28px);position:absolute;inset:var(--crm-canvas-top,78px) var(--crm-canvas-x,64px) var(--crm-canvas-bottom,78px);max-width:1480px;margin:auto;min-width:0;min-height:0;overflow:hidden;-webkit-app-region:no-drag}.crm-project-gallery-shell:before,.crm-project-gallery-shell:after{content:"";position:absolute;z-index:5;top:0;bottom:20px;width:clamp(34px,4.5vw,68px);pointer-events:none;transition:opacity .12s linear}.crm-project-gallery-shell:before{left:0;opacity:var(--crm-project-shadow-left);background:linear-gradient(90deg,rgba(1,9,14,.46) 0,rgba(1,9,14,.14) 40%,rgba(1,9,14,0) 100%)}.crm-project-gallery-shell:after{right:0;opacity:var(--crm-project-shadow-right);background:linear-gradient(270deg,rgba(1,9,14,.46) 0,rgba(1,9,14,.14) 40%,rgba(1,9,14,0) 100%)}.crm-project-gallery-scroll{position:absolute;inset:0 0 20px;min-width:0;min-height:0;overflow-x:auto;overflow-y:hidden;padding:0;box-sizing:border-box;scrollbar-width:none;overscroll-behavior-inline:contain;outline:0}.crm-project-gallery-scroll::-webkit-scrollbar{display:none}.crm-project-gallery-scroll:focus-visible{box-shadow:inset 0 -1px rgba(190,220,255,.22)}.crm-project-gallery-canvas{position:relative;height:100%;min-width:100%}
      .crm-project-tile-grid,.crm-project-title-grid{position:absolute;display:grid;grid-auto-flow:column;gap:var(--crm-object-gap,18px);contain:layout style}.crm-project-tile-grid{z-index:1;pointer-events:auto;will-change:transform}.crm-project-title-grid{z-index:4;pointer-events:none}.crm-project-bucket{content-visibility:auto;contain-intrinsic-size:auto 320px}.crm-project-bucket>.crm-home-preview{border-radius:inherit}.crm-project-create>.crm-home-preview{display:grid;place-items:center}.crm-project-create-glyph{font:200 clamp(28px,3vw,42px)/1 "Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;color:rgba(238,245,254,.38);transform:translateY(-2px)}.crm-project-gallery-hsb{position:absolute;z-index:6;left:var(--crm-project-rail-inset);right:var(--crm-project-rail-inset);bottom:4px;height:8px;border-radius:999px;background:rgba(255,255,255,.16);box-shadow:inset 0 0 0 1px rgba(255,255,255,.06);opacity:0;transition:opacity .2s ease;pointer-events:none;-webkit-app-region:no-drag}.crm-project-gallery-hsb.is-on{opacity:1;pointer-events:auto}.crm-project-gallery-hth{position:absolute;top:0;height:8px;border-radius:999px;background:rgba(255,255,255,.66);box-shadow:0 1px 4px rgba(0,0,0,.4);cursor:grab;touch-action:none;transition:background .15s ease}.crm-project-gallery-hth:hover{background:rgba(255,255,255,.88)}.crm-project-gallery-hth:active{cursor:grabbing;background:#fff}
      .crm-planner-project-live{position:absolute;inset:0;z-index:1}
      .crm-project-transition-preview{position:absolute;inset:0;z-index:20;display:block;width:100%;height:100%;object-fit:cover;pointer-events:none;user-select:none;backface-visibility:hidden;opacity:1}
      .crm-project-transition-acrylic{position:absolute;inset:0;z-index:0;box-sizing:border-box;pointer-events:none;opacity:0;border-radius:var(--fractal-source-radius-x,28px) / var(--fractal-source-radius-y,28px);background:var(--crm-menu-background,linear-gradient(180deg,rgba(22,26,36,.62),rgba(12,16,24,.55)));-webkit-backdrop-filter:blur(24px) saturate(140%);backdrop-filter:blur(24px) saturate(140%);transform:translateZ(0);will-change:opacity,transform}
      .crm-project-transition-acrylic:after{content:"";position:absolute;inset:0;border:1px solid var(--crm-menu-border,rgba(255,255,255,.22));border-radius:inherit;box-shadow:inset 0 1px 0 var(--crm-menu-highlight,rgba(255,255,255,.24)),0 14px 26px -16px rgba(0,0,0,.72);opacity:1}
      .crm-planner-project-world[data-fractal-frame="source"]>.crm-project-transition-acrylic{opacity:1}
      @keyframes crm-project-acrylic-expand{0%,93%{opacity:1}100%{opacity:0}}
      @keyframes crm-project-acrylic-contract{0%{opacity:0}7%,100%{opacity:1}}
      @keyframes crm-project-live-in{0%,76%{opacity:.001}100%{opacity:1}}
      @keyframes crm-project-texture-out{0%,76%{opacity:1}100%{opacity:0}}
      @keyframes crm-project-live-out{0%{opacity:1}24%,100%{opacity:.001}}
      @keyframes crm-project-texture-in{0%{opacity:0}24%,100%{opacity:1}}
      .crm-planner-surface.crm-project-camera-expanding .crm-planner-project-world.has-transition-preview>.crm-planner-project-live{animation:crm-project-live-in var(--fractal-camera-morph-ms,460ms) linear both}
      .crm-planner-surface.crm-project-camera-expanding .crm-planner-project-world.has-transition-preview>.crm-project-transition-preview{animation:crm-project-texture-out var(--fractal-camera-morph-ms,460ms) linear both}
      .crm-planner-surface.crm-project-camera-contracting .crm-planner-project-world.has-transition-preview>.crm-planner-project-live{animation:crm-project-live-out var(--fractal-camera-morph-ms,460ms) linear both}
      .crm-planner-surface.crm-project-camera-contracting .crm-planner-project-world.has-transition-preview>.crm-project-transition-preview{animation:crm-project-texture-in var(--fractal-camera-morph-ms,460ms) linear both}
      /* The tile material changes owners while geometry is still moving: it
         dissolves into the settled project surface on entry and reforms before
         the return reaches its source tile. No endpoint style swap remains. */
      .crm-planner-surface.crm-project-acrylic-expanding .crm-planner-project-world>.crm-project-transition-acrylic{animation:crm-project-acrylic-expand var(--fractal-camera-morph-ms,460ms) linear both}
      .crm-planner-surface.crm-project-acrylic-contracting .crm-planner-project-world>.crm-project-transition-acrylic{animation:crm-project-acrylic-contract var(--fractal-camera-morph-ms,460ms) linear both}
      .crm-planner-warm>.crm-project-transition-acrylic{opacity:1!important;animation:none!important}
      .crm-planner-surface[data-level="1"] .crm-project-gallery-level .crm-project-bucket.is-camera-target{opacity:0}
      .crm-planner-surface.crm-project-camera-expanding .crm-project-gallery-level .crm-project-bucket.is-camera-target{opacity:0;transition:opacity 90ms ease!important}
      .crm-planner-surface.crm-project-camera-contracting .crm-project-gallery-level .crm-project-bucket.is-camera-target{opacity:1;transition:opacity 110ms ease 350ms!important}
      .crm-planner-surface[data-level="1"] .crm-project-gallery-level .crm-project-title-grid{opacity:0}
      .crm-planner-surface.crm-project-camera-expanding .crm-project-title-grid{opacity:0;transition:opacity 90ms ease}
      .crm-planner-surface.crm-project-camera-contracting .crm-project-title-grid{opacity:1;transition:opacity 110ms ease 350ms}
      .crm-planner-surface.crm-project-camera-moving .crm-project-tile-grid>.crm-project-bucket{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
      .crm-planner-surface.crm-project-camera-moving .crm-project-tile-grid>.crm-project-bucket:not(.is-camera-target){transition:none!important}
      .crm-planner-frame{position:absolute;inset:var(--crm-canvas-top,78px) var(--crm-canvas-x,64px) var(--crm-canvas-bottom,78px);max-width:1480px;margin:auto;display:grid;grid-template-rows:40px minmax(0,1fr);gap:12px;min-width:0;min-height:0}
      .crm-planner-projects{min-width:0;height:40px;display:flex;align-items:center;gap:8px;overflow:hidden;-webkit-app-region:no-drag}.crm-planner-heading{flex:0 1 auto;min-width:0;max-width:min(34vw,430px);font-size:var(--crm-type-room,17px);font-weight:700;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-planner-project-context{flex:0 1 auto;min-width:0;display:flex;align-items:center;gap:6px;color:rgba(255,255,255,.4);font-size:var(--crm-type-meta,10px);white-space:nowrap;overflow:hidden}.crm-planner-project-context span{min-width:0;max-width:140px;overflow:hidden;text-overflow:ellipsis}.crm-planner-project-context i{width:2px;height:2px;border-radius:50%;background:currentColor;opacity:.65}.crm-planner-project-list{min-width:0;display:flex;align-items:center;gap:2px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}.crm-planner-project-list::-webkit-scrollbar{display:none}
      .crm-planner-project-back.crm-menu-action{flex:0 0 auto;height:30px;padding:0 8px!important;color:rgba(255,255,255,.5)!important;font-size:var(--crm-type-caption,11px)!important}.crm-planner-project-separator{color:rgba(255,255,255,.24);font-size:13px}.crm-planner-world-spacer{flex:1 1 auto;min-width:0}.crm-planner-world-map{flex:0 1 130px;display:flex;height:3px;gap:2px}.crm-planner-world-map i{flex:1 1 0;border-radius:2px;background:rgba(214,229,248,.12)}.crm-planner-world-map i[data-occupied="true"]{background:rgba(160,193,234,.32)}.crm-planner-world-map i[data-kind="done"][data-occupied="true"]{background:rgba(159,208,184,.38)}
      .crm-planner-project.crm-menu-action{position:relative;flex:0 0 auto;width:clamp(88px,12vw,176px);height:34px;padding:5px 10px 4px!important;text-align:left;font-size:var(--crm-type-body,12px)!important;display:grid;grid-template-rows:minmax(0,1fr) 3px;gap:4px;overflow:hidden;color:rgba(255,255,255,.5)!important}.crm-planner-project.is-selected{color:rgba(255,255,255,.96)!important}.crm-planner-project.is-selected:after{content:"";position:absolute;left:10px;right:10px;bottom:0;height:2px;border-radius:2px;background:rgba(175,211,255,.78);box-shadow:0 0 10px rgba(115,177,252,.22)}.crm-planner-project-name{display:block;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-planner-project-map{display:flex;align-items:stretch;gap:2px;min-width:0;height:3px}.crm-planner-project-segment{flex:1 1 0;min-width:3px;border-radius:2px;background:rgba(214,229,248,.09);box-shadow:inset 0 0 0 1px rgba(225,237,251,.045)}.crm-planner-project-segment[data-occupied="true"]{background:rgba(160,193,234,.28)}.crm-planner-project-segment[data-kind="done"][data-occupied="true"]{background:rgba(159,208,184,.34)}.crm-planner-project.is-selected .crm-planner-project-segment{box-shadow:inset 0 0 0 1px rgba(226,238,252,.08)}
      .crm-planner-new-project.crm-menu-action{flex:0 0 auto;width:auto;height:30px;padding:0 9px!important;font-size:var(--crm-type-caption,11px)!important;white-space:nowrap;color:rgba(255,255,255,.7)!important}.crm-planner-head-actions{flex:0 0 auto;display:flex;align-items:center;gap:2px;padding-left:6px;border-left:1px solid rgba(255,255,255,.1)}.crm-planner-text-action.crm-menu-action{height:30px;font-size:var(--crm-type-caption,11px)!important;padding:0 8px!important}.crm-planner-project-menu{width:30px!important;padding:0!important;font-size:14px!important;text-align:center}
      .crm-planner-stage{--crm-scroll-shadow-left:0;--crm-scroll-shadow-right:0;position:relative;min-width:0;min-height:0;margin-inline:calc(0px - var(--crm-canvas-x,64px));overflow:hidden}.crm-planner-stage:before,.crm-planner-stage:after{content:"";position:absolute;z-index:4;top:0;bottom:14px;width:clamp(34px,4.5vw,68px);pointer-events:none;transition:opacity .12s linear}.crm-planner-stage:before{left:0;opacity:var(--crm-scroll-shadow-left);background:linear-gradient(90deg,rgba(1,9,14,.46) 0,rgba(1,9,14,.14) 40%,rgba(1,9,14,0) 100%)}.crm-planner-stage:after{right:0;opacity:var(--crm-scroll-shadow-right);background:linear-gradient(270deg,rgba(1,9,14,.46) 0,rgba(1,9,14,.14) 40%,rgba(1,9,14,0) 100%)}
      .crm-planner-buckets{width:100%;height:100%;min-width:0;min-height:0;display:flex;align-items:flex-start;justify-content:flex-start;gap:var(--crm-object-gap,18px);overflow-x:auto;overflow-y:hidden;padding:clamp(12px,2.5vh,22px) 0 28px var(--crm-canvas-x,64px);box-sizing:border-box;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent;scroll-padding-inline:0;-webkit-app-region:no-drag}
      .crm-planner-bucket.tk-zone{position:relative;inset:auto;z-index:auto;flex:0 0 226px;width:226px;height:min(500px,calc(100vh - 210px));min-height:342px;box-sizing:border-box;padding:12px 14px;overflow:hidden;transition:width .16s ease,flex-basis .16s ease,height .16s ease}
      .crm-planner-bucket.is-drop-target{border-color:rgba(137,188,255,.72)!important;box-shadow:inset 0 1px rgba(255,255,255,.24),0 0 34px rgba(71,139,231,.24)!important}.crm-planner-bucket .tk-zone-hd{flex:0 0 30px}.crm-planner-bucket .tk-zone-title{max-width:84px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-planner-bucket .tk-zone-hd-r{right:0;top:1px;gap:1px;pointer-events:auto;opacity:.72}.crm-planner-stage-progress{width:48px;margin-right:3px;justify-content:flex-end;gap:2px}.crm-planner-stage-progress .tk-seg,.crm-planner-card-progress .tk-seg{flex:1 1 0;min-width:2px;max-width:9px;height:4px;border-radius:2px;background:rgba(255,255,255,.2);box-shadow:inset 0 0 0 1px rgba(0,0,0,.12)}.crm-planner-stage-progress .tk-seg.g,.crm-planner-card-progress .tk-seg.g{background:#2fd16b}
      .crm-planner-stage-menu.crm-menu-action{width:28px;height:27px;padding:0!important;display:grid;place-items:center;font-size:14px!important}
      .crm-planner-card-list{min-height:0;flex:1 1 auto;overflow-y:auto;display:flex;flex-direction:column;align-items:center;gap:0;padding:4px 2px 8px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}.crm-planner-card-list.is-expanded{gap:8px}
      .crm-planner-card{appearance:none;position:relative;flex:0 0 auto;width:188px;height:128px;box-sizing:border-box;padding:14px 15px;text-align:left;border:0;border-radius:15px;background:linear-gradient(150deg,rgba(98,112,134,.94),rgba(62,74,94,.92));color:rgba(255,255,255,.9);box-shadow:inset 0 1px rgba(255,255,255,.22),0 14px 18px -14px rgba(0,0,0,.5);cursor:grab;overflow:hidden;transition:width .16s ease,height .16s ease,margin .2s cubic-bezier(.22,1,.26,1),box-shadow .14s ease,opacity .14s ease}.crm-planner-card+.crm-planner-card{margin-top:-78px}.crm-planner-card-list.is-expanded .crm-planner-card+.crm-planner-card{margin-top:0}.crm-planner-card:active{cursor:grabbing}.crm-planner-card.is-dragging{opacity:.32}.crm-planner-card-body{display:flex;flex-direction:column;gap:0;height:100%;min-height:0}.crm-planner-card-progress{position:absolute;top:12px;right:13px;z-index:2;width:48px;display:inline-flex;align-items:center;justify-content:flex-end;gap:2px;pointer-events:none}
      .crm-planner-card:hover,.crm-planner-card:focus-visible{outline:0;box-shadow:inset 0 0 0 9999px rgba(255,255,255,.1),inset 0 1px rgba(255,255,255,.3),0 14px 18px -14px rgba(0,0,0,.5)}
      .crm-planner-card-title{display:block;padding-right:54px;font-size:var(--crm-type-object,14px);font-weight:700;line-height:1.24;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-planner-card-note{display:-webkit-box;margin-top:8px;color:rgba(255,255,255,.6);font-size:var(--crm-type-body,12px);line-height:1.35;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.crm-planner-card-meta{display:flex;align-items:center;gap:8px;margin-top:auto;padding-top:10px;color:rgba(255,255,255,.52);font-size:var(--crm-type-meta,10px);white-space:nowrap}.crm-planner-card-meta span{min-width:0;overflow:hidden;text-overflow:ellipsis}.crm-planner-card-link{display:block;margin-top:5px;color:rgba(211,227,249,.56);font-size:var(--crm-type-meta,10px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .crm-planner-bucket.crm-object-small{scale:1!important;flex-basis:176px;width:176px;height:min(420px,calc(100vh - 230px));min-height:308px;padding-inline:11px}.crm-planner-card.crm-object-small{scale:1!important;width:140px;height:90px;padding:11px 12px}.crm-planner-card.crm-object-small+.crm-planner-card{margin-top:-50px}.crm-planner-card-list.is-expanded .crm-planner-card.crm-object-small+.crm-planner-card{margin-top:0}.crm-planner-card.crm-object-small .crm-planner-card-note,.crm-planner-card.crm-object-small .crm-planner-card-link{display:none}.crm-planner-card.crm-object-small .crm-planner-card-title{padding-right:40px;font-size:var(--crm-type-body,12px)}.crm-planner-card.crm-object-small .crm-planner-card-meta{padding-top:7px}.crm-planner-card.crm-object-small .crm-planner-card-progress{top:10px;right:10px;width:36px;gap:1px}.crm-planner-card.crm-object-small .crm-planner-card-progress .tk-seg{height:3px}
      .crm-planner-add-card.crm-menu-action{flex:0 0 31px;width:100%;height:31px;text-align:left;padding-left:4px!important;font-size:var(--crm-type-caption,11px)!important;color:rgba(255,255,255,.48)!important}.crm-planner-add-card:hover{color:#fff!important}.crm-planner-empty{height:100%;display:grid;place-items:center;padding:16px;text-align:center;color:rgba(255,255,255,.3);font-size:var(--crm-type-caption,11px)}
      .crm-planner-popover{position:fixed;z-index:9300;width:min(280px,calc(100vw - 28px));padding:9px;display:grid;gap:8px}.crm-planner-popover-title{padding:2px 3px 5px;font-size:var(--crm-type-control,13px);font-weight:700}.crm-planner-popover-hint{padding:0 3px 3px;color:rgba(255,255,255,.48);font-size:var(--crm-type-meta,10px);line-height:1.4}.crm-planner-popover-actions{display:flex;justify-content:flex-end;gap:2px}.crm-planner-popover .crm-menu-action{height:32px;font-size:var(--crm-type-body,12px)!important}
      .crm-planner-project-creator{width:min(380px,calc(100vw - 28px));gap:8px}.crm-planner-project-creator textarea,.crm-planner-project-editor textarea{min-height:54px;padding-top:9px;resize:none}.crm-planner-project-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:7px}.crm-planner-project-field{min-width:0;display:grid;gap:4px}.crm-planner-project-field>span{padding-left:3px;color:rgba(255,255,255,.42);font-size:var(--crm-type-meta,10px);font-weight:650}.crm-planner-project-field .crm-menu-input{width:100%;min-width:0;box-sizing:border-box}.crm-planner-project-editor{width:min(380px,calc(100vw - 28px));gap:8px}.crm-planner-preset-label{padding:1px 3px 0;color:rgba(255,255,255,.46);font-size:var(--crm-type-meta,10px);font-weight:700;letter-spacing:.045em;text-transform:uppercase}.crm-planner-presets{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:3px}.crm-planner-preset.crm-menu-action{position:relative;height:48px!important;padding:7px 8px 6px!important;text-align:left;display:grid;align-content:center;gap:4px;color:rgba(255,255,255,.56)!important}.crm-planner-preset.is-selected{color:rgba(255,255,255,.96)!important;background:rgba(255,255,255,.08)!important}.crm-planner-preset-name{font-weight:700}.crm-planner-preset-map{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:rgba(255,255,255,.34);font-size:var(--crm-type-micro,9px);font-weight:500}.crm-planner-preset.is-selected .crm-planner-preset-map{color:rgba(255,255,255,.54)}
      .crm-planner-custom-builder{display:grid;gap:7px;padding-top:1px}.crm-planner-custom-builder[hidden]{display:none}.crm-planner-stage-entry{display:grid;grid-template-columns:minmax(0,1fr) 34px;gap:4px}.crm-planner-stage-entry .crm-menu-action{width:34px;padding:0!important;font-size:16px!important}.crm-planner-stage-list{display:flex;flex-wrap:wrap;gap:4px;min-height:0}.crm-planner-stage-pill{display:inline-flex;align-items:center;gap:5px;max-width:100%;height:25px;padding:0 5px 0 8px;border-radius:8px;background:rgba(255,255,255,.065);color:rgba(255,255,255,.72);font-size:var(--crm-type-caption,11px)}.crm-planner-stage-pill span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.crm-planner-stage-remove{appearance:none;width:18px;height:18px;padding:0;border:0;border-radius:5px;background:transparent;color:rgba(255,255,255,.38);font:600 13px/1 system-ui;cursor:pointer}.crm-planner-stage-remove:hover,.crm-planner-stage-remove:focus-visible{outline:0;background:rgba(255,255,255,.08);color:#fff}.crm-planner-creator-status{min-height:14px;padding:0 3px;color:rgba(255,162,162,.9);font-size:var(--crm-type-meta,10px);line-height:1.35}.crm-planner-creator-status:empty{display:none}
      .crm-planner-context{position:fixed;z-index:9320;width:172px;padding:6px;display:grid;gap:1px}.crm-planner-context .crm-menu-action{height:33px;text-align:left;font-size:var(--crm-type-body,12px)!important}.crm-planner-card.is-focus-target{outline:1px solid rgba(159,199,250,.72);box-shadow:0 0 0 5px rgba(90,151,232,.12),inset 0 1px rgba(255,255,255,.3),0 14px 18px -14px rgba(0,0,0,.5)}
      .crm-planner-zero{width:100%;height:100%;min-height:0;display:grid;place-items:center}.crm-planner-zero-copy{width:min(330px,calc(100vw - 48px));display:grid;justify-items:center;gap:7px;text-align:center}.crm-planner-zero-copy strong{font-size:var(--crm-type-object,14px)}.crm-planner-zero-copy span{color:rgba(255,255,255,.48);font-size:var(--crm-type-caption,11px);line-height:1.45}.crm-planner-zero .crm-menu-action{height:34px;margin-top:6px;padding-inline:13px!important;color:rgba(238,245,254,.86)!important;background:rgba(13,19,28,.62)!important;border-color:rgba(213,230,250,.18)!important;box-shadow:inset 0 1px rgba(255,255,255,.08),0 12px 26px -20px rgba(0,0,0,.9)!important;font-weight:650}
      @media(max-width:900px){.crm-planner-projects{gap:6px}.crm-planner-project.crm-menu-action{width:112px}.crm-planner-head-actions{padding-left:4px}.crm-planner-text-action.crm-menu-action{padding-inline:6px!important}}
    `; document.head.appendChild(style);
  }

  async function load() {
    const [projects, items, flows, commitments, contacts, tasks, tickets] = await Promise.all([
      window.crmStore.list("projects", { includeDeleted:false }), window.crmStore.list("workItems", { includeDeleted:false }),
      window.crmDomain.list("workflow-entries", { includeDeleted:false, limit:1000 }), window.crmDomain.list("commitments", { includeDeleted:false, limit:1000 }),
      window.crmStore.list("contacts", { includeDeleted:false }), window.crmStore.list("tasks", { includeDeleted:false }), window.crmStore.list("tickets", { includeDeleted:false }),
    ]);
    return {
      projects:rows(projects).filter((record) => !record.deletedAt).map(normalizeProject),
      items:rows(items).filter((record) => !record.deletedAt).map(normalizeItem), flows:rows(flows).filter((record) => !record.deletedAt),
      commitments:rows(commitments).filter((record) => !record.deletedAt), contacts:rows(contacts).filter((record) => !record.deletedAt),
      tasks:rows(tasks).filter((record) => !record.deletedAt), tickets:rows(tickets).filter((record) => !record.deletedAt),
    };
  }

  async function createLinkedItem(project, stage, title, note = "", options = {}) {
    const rank = model.items.filter((item) => item.projectId === project.id && item.stageId === stage.id).length;
    const itemResult = await window.crmStore.create("workItems", {
      projectId:project.id, projectTitle:project.title, stageId:stage.id, stageLabel:stage.title, title, note,
      dueAt:options.dueAt || null, priority:options.priority || "normal", assignee:options.assignee || null,
      assignedContactId:options.assignedContactId || null, linkedEntityType:options.linkedEntityType || null,
      linkedRecordId:options.linkedRecordId || null, status:stage.kind === "done" ? "completed" : "open", rank,
    });
    const item = itemResult?.record; if (!item) return null;
    const links = [{ entityType:"workItems", recordId:item.id, relation:"regarding" }];
    if (options.linkedEntityType && options.linkedRecordId) links.push({ entityType:options.linkedEntityType, recordId:options.linkedRecordId, relation:"supports" });
    const commitmentResult = await window.crmDomain.create("commitments", {
      title, kind:"pipeline-work", status:stage.kind === "done" ? "completed" : "open", dueAt:options.dueAt || null,
      priority:options.priority || "normal", assignee:options.assignee || null, projectId:project.id, projectTitle:project.title,
      stageId:stage.id, stageLabel:stage.title, links,
    });
    const commitment = commitmentResult?.record;
    if (!commitment) { await window.crmStore.remove("workItems", item.id); return null; }
    const flowResult = await window.crmDomain.create("workflow-entries", {
      workflowKey:`project:${project.id}`, entityType:"workItems", recordId:item.id, stage:stage.id, rank, owner:options.assignee || null,
    });
    const flow = flowResult?.record;
    if (!flow) { await window.crmDomain.remove("commitments", commitment.id); await window.crmStore.remove("workItems", item.id); return null; }
    const linkage = { commitmentId:commitment.id, workflowEntryId:flow.id };
    let linkedResult = await window.crmStore.update("workItems", item.id, linkage);
    if (!linkedResult?.record) linkedResult = await window.crmStore.update("workItems", item.id, linkage);
    if (!linkedResult?.record) {
      await window.crmDomain.remove("workflow-entries", flow.id); await window.crmDomain.remove("commitments", commitment.id); await window.crmStore.remove("workItems", item.id); return null;
    }
    return linkedResult.record;
  }

  async function migrateLegacy() {
    if (window.crmHomePreviews?.isCaptureWorker || model.projects.length || localStorage.getItem(MIGRATED_KEY) === "true") return false;
    let legacy = [];
    try { const parsed = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null"); legacy = Array.isArray(parsed) ? parsed : []; } catch {}
    legacy = legacy.filter((project) => !["project-client-launch", "project-operations", "project-renewals"].includes(project.id));
    if (!legacy.length) { localStorage.setItem(MIGRATED_KEY, "true"); return false; }
    for (const source of legacy) {
      const stages = (source.buckets || []).map((bucket, index) => normalizeStage({ id:uid("stage"), title:bucket.title, kind:index === source.buckets.length - 1 ? "done" : index ? "active" : "queue", rank:index }, index));
      const projectResult = await window.crmStore.create("projects", { title:first(source.title, "Imported project"), note:String(source.note || ""), stages:stages.length ? stages : clone(DEFAULT_STAGES) });
      const project = projectResult?.record; if (!project) continue;
      for (let index = 0; index < stages.length; index += 1) {
        const sourceBucket = source.buckets[index];
        for (const card of sourceBucket.cards || []) await createLinkedItem(normalizeProject(project), stages[index], first(card.title, "Imported work"), String(card.note || ""));
      }
    }
    localStorage.setItem(MIGRATED_KEY, "true"); return true;
  }

  async function refresh(force = false, reason = "refreshed") {
    if (!force && refreshPromise) return refreshPromise;
    clearTimeout(refreshTimer); refreshTimer = 0;
    const run = refreshTail.catch(() => null).then(async () => {
      model = await load();
      if (await migrateLegacy()) model = await load();
      if (!model.projects.some((project) => project.id === selectedId)) selectedId = model.projects[0]?.id || "";
      clearTimeout(refreshTimer); refreshTimer = 0; dirty = false; publish(reason); return model;
    });
    refreshTail = run;
    refreshPromise = run;
    run.finally(() => { if (refreshPromise === run) refreshPromise = null; }).catch(() => {});
    return run;
  }
  const schedule = () => { dirty = true; clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (active && !plannerDetail?.isOpen?.()) refresh(); }, 100); };

  const itemsInStage = (project, stage) => model.items
    .filter((item) => item.projectId === project?.id && item.stageId === stage?.id)
    .sort((a, b) => a.rank - b.rank || String(a.createdAt).localeCompare(String(b.createdAt)));
  const projectPreviewSignature = (project) => JSON.stringify([
    document.documentElement.dataset.background || "",
    project?.id, project?.title, project?.note, project?.ownerContactId, project?.owner, project?.dueAt,
    ...stagesOf(project).map((stage) => [stage.id, stage.title, stage.kind, ...itemsInStage(project, stage).map((item) => [item.id, item.title, item.note, item.priority, item.assignee, item.rank])]),
  ]);
  const projectPreviewStateHTML = () => `<div class="crm-home-preview-state" role="status" aria-live="polite"><i class="crm-home-preview-state-mark" aria-hidden="true"></i><span>Preparing view</span></div>`;
  const projectBucketHTML = (project) => `<button type="button" class="crm-home-bucket crm-project-bucket" data-planner-project="${esc(project.id)}" data-preview-signature="${esc(projectPreviewSignature(project))}" aria-label="Open ${esc(project.title)}"><div class="crm-home-preview" data-project-preview="${esc(project.id)}" data-preview-state="waiting" aria-label="Loading ${esc(project.title)} preview">${projectPreviewStateHTML()}</div></button>`;
  const projectTitleHTML = (project) => `<div class="crm-home-title-slot" data-project-title="${esc(project.id)}"><div class="crm-home-title-glass"><div class="crm-home-title">${esc(project.title)}</div></div></div>`;
  const createProjectHTML = () => `<button type="button" class="crm-home-bucket crm-project-bucket crm-project-create" data-planner-action="new-project" aria-label="Create project"><div class="crm-home-preview" data-preview-state="ready"><span class="crm-project-create-glyph" aria-hidden="true">+</span></div></button>`;
  const createProjectTitleHTML = () => `<div class="crm-home-title-slot crm-project-create-title" data-project-title="create"><div class="crm-home-title-glass"><div class="crm-home-title">Create project</div></div></div>`;
  const galleryHTML = () => `<div class="crm-project-gallery-shell"><div class="crm-project-gallery-scroll" tabindex="0" aria-label="Scrollable projects"><div class="crm-project-gallery-canvas"><section class="crm-project-tile-grid" aria-label="Projects"></section><div class="crm-project-title-grid"></div></div></div><div class="crm-project-gallery-hsb" aria-hidden="true"><div class="crm-project-gallery-hth"></div></div></div>`;
  const isProjectPreviewCurrent = (preview, project) => !!preview?.foregroundSrc && !!preview?.exactSrc
    && preview.version === PROJECT_PREVIEW_VERSION
    && preview.viewState?.signature === projectPreviewSignature(project)
    && Number(preview.width) === innerWidth && Number(preview.height) === innerHeight;
  function mountProjectPreview(host, preview) {
    if (!host || !preview?.foregroundSrc) return false;
    const current = host.querySelector(":scope > .crm-home-preview-foreground");
    const commit = () => {
      if (!host.isConnected && !host.closest?.(".crm-project-gallery-level,.crm-planner-surface")) return;
      let image = host.querySelector(":scope > .crm-home-preview-foreground");
      if (!image) {
        image = document.createElement("img"); image.className = "crm-home-preview-image crm-home-preview-foreground";
        image.alt = ""; image.draggable = false; image.decoding = "async"; image.dataset.previewVariant = "filtered"; host.appendChild(image);
      }
      if (image.src !== preview.foregroundSrc) image.src = preview.foregroundSrc;
      host.dataset.previewState = isProjectPreviewCurrent(preview, projectById(preview.key)) ? "ready" : "stale";
      host.dataset.previewVersion = preview.version || ""; host.dataset.capturedAt = String(preview.capturedAt || 0);
      host.closest(".crm-project-bucket")?.setAttribute("data-preview-ready", "true");
    };
    if (!current || current.src === preview.foregroundSrc) { commit(); return true; }
    const image = new Image(); image.decoding = "async"; image.src = preview.foregroundSrc;
    (image.decode?.() || Promise.resolve()).catch(() => null).then(() => { if (projectPreviews.get(String(preview.key))?.foregroundSrc === preview.foregroundSrc) commit(); });
    return true;
  }
  function acceptProjectPreview(preview) {
    const key = String(preview?.key || ""); if (!key || !preview?.foregroundSrc || !preview?.exactSrc) return false;
    projectPreviews.set(key, preview);
    document.querySelectorAll(`.crm-home-preview[data-project-preview="${cssValue(key)}"]`).forEach((host) => mountProjectPreview(host, preview));
    document.querySelectorAll(`.crm-planner-project-world[data-project-id="${cssValue(key)}"]`).forEach((layer) => ensureProjectTransitionPreview(layer, projectById(key)));
    camera?.layout?.(); return true;
  }
  const projectPreviewState = (project) => ({
    revision:1, view:"project", selectedId:project.id, signature:projectPreviewSignature(project),
    expandedStages:[...expandedStacks].filter((key) => key.startsWith(`${project.id}:`)),
    scrollPositions:{ [project.id]:plannerScrollPositions.get(project.id) || 0 },
  });
  function requestProjectPreview(project, force = false) {
    if (!project || window.crmHomePreviews?.isCaptureWorker || !window.crmHomePreviews?.captureProject) return Promise.resolve(null);
    const signature = projectPreviewSignature(project); const existing = projectPreviews.get(project.id);
    if (!force && isProjectPreviewCurrent(existing, project)) return Promise.resolve(existing);
    if (pendingProjectPreviews.get(project.id)?.signature === signature) return pendingProjectPreviews.get(project.id).promise;
    const promise = Promise.resolve(window.crmHomePreviews.captureProject(project.id, projectPreviewState(project)))
      .then((result) => { if (result?.preview) acceptProjectPreview(result.preview); return result?.preview || null; })
      .catch(() => null)
      .finally(() => { if (pendingProjectPreviews.get(project.id)?.promise === promise) pendingProjectPreviews.delete(project.id); });
    pendingProjectPreviews.set(project.id, { signature, promise }); return promise;
  }
  function scheduleProjectPreviews(forceProjectId = "") {
    if (window.crmHomePreviews?.isCaptureWorker) return;
    clearTimeout(projectPreviewTimer); projectPreviewTimer = setTimeout(() => {
      projectPreviewTimer = 0; model.projects.forEach((project) => requestProjectPreview(project, forceProjectId === project.id));
    }, 90);
  }
  function subscribeProjectPreviews() {
    if (projectPreviewSubscribed) return;
    projectPreviewSubscribed = true;
    Promise.resolve(window.crmHomePreviews?.projectList?.()).then((result) => result?.previews?.forEach(acceptProjectPreview)).finally(() => scheduleProjectPreviews()).catch(() => {});
    try { window.crmHomePreviews?.onProjectChanged?.(acceptProjectPreview); } catch {}
  }
  function projectMapHTML(project, className = "crm-planner-project-map") {
    return `<span class="${className}" aria-hidden="true">${stagesOf(project).map((stage) => `<i class="crm-planner-project-segment" data-kind="${esc(stage.kind)}" data-occupied="${model.items.some((item) => item.projectId === project.id && item.stageId === stage.id)}"></i>`).join("")}</span>`;
  }
  const projectTargetLabel = (value) => {
    const date = value ? new Date(value) : null; if (!date || !Number.isFinite(date.getTime())) return "";
    return new Intl.DateTimeFormat(undefined, { month:"short", day:"numeric", ...(date.getFullYear() === new Date().getFullYear() ? {} : { year:"numeric" }) }).format(date);
  };
  const projectOwnerName = (project) => {
    const contact = model.contacts.find((candidate) => String(candidate.id) === String(project?.ownerContactId || "")); return first(project?.owner, contact && contactName(contact));
  };
  function projectContextHTML(project) {
    const owner = projectOwnerName(project); const target = projectTargetLabel(project?.dueAt); if (!owner && !target) return "";
    return `<span class="crm-planner-project-context">${owner ? `<span>${esc(owner)}</span>` : ""}${owner && target ? '<i aria-hidden="true"></i>' : ""}${target ? `<time datetime="${esc(String(project.dueAt || ""))}">${esc(target)}</time>` : ""}</span>`;
  }
  function projectWorldHTML(project) {
    if (!project) return "";
    const stages = stagesOf(project);
    return `<div class="crm-planner-frame">
      <header class="crm-planner-projects"><button type="button" class="crm-planner-project-back crm-menu-action" data-planner-action="projects-back">Projects</button><span class="crm-planner-project-separator" aria-hidden="true">/</span><span class="crm-planner-heading">${esc(project.title)}</span>${projectContextHTML(project)}<span class="crm-planner-world-spacer"></span>${projectMapHTML(project, "crm-planner-world-map")}<div class="crm-planner-head-actions"><button type="button" class="crm-planner-text-action crm-planner-project-menu crm-menu-action" data-planner-action="project-menu" aria-label="Project options">···</button><button type="button" class="crm-planner-text-action crm-menu-action" data-planner-action="new-stage">Add stage</button></div></header>
      <section class="crm-planner-stage"><div class="crm-planner-buckets" data-planner-scroll-project="${esc(project.id)}" tabindex="0" aria-label="Scrollable project stages">${stages.map((stage) => {
        const items = itemsInStage(project, stage); const expanded = stageExpanded(project.id, stage.id);
        return `<section class="crm-planner-bucket tk-zone${expanded ? " is-stack-expanded" : ""}" data-planner-bucket="${esc(stage.id)}" data-stage="${esc(stage.id)}" data-card-detail-zone data-crm-size-key="${esc(`bucket:planner:${project.id}:${stage.id}`)}"><header class="tk-zone-hd"><span class="tk-zone-title" title="${esc(stage.title)}">${esc(stage.title)}</span><span class="tk-zone-hd-r">${stageProgressHTML(project, stage.id)}<button type="button" class="crm-planner-stage-menu crm-menu-action" data-planner-action="stage-menu" aria-label="${esc(stage.title)} options">···</button></span></header>
          <div class="crm-planner-card-list${expanded ? " is-expanded" : ""}" data-card-detail-track data-card-detail-clip>${items.length ? items.map(cardHTML).join("") : '<div class="crm-planner-empty">No cards yet</div>'}</div><button type="button" class="crm-planner-add-card crm-menu-action" data-planner-action="new-card">+ Add card</button></section>`;
      }).join("")}</div></section></div>`;
  }
  function ensureProjectTransitionPreview(layer, project) {
    if (!layer || !project || window.crmHomePreviews?.isCaptureWorker) return null;
    const preview = projectPreviews.get(project.id); if (!preview?.foregroundSrc) return null;
    let image = layer.querySelector(":scope > .crm-project-transition-preview");
    if (!image) {
      image = document.createElement("img"); image.className = "crm-project-transition-preview";
      image.alt = ""; image.draggable = false; image.decoding = "sync"; layer.appendChild(image);
    }
    layer.classList.add("has-transition-preview");
    // Keep the workspace backdrop singular. The moving layer carries only the
    // project's transparent objects; its sibling acrylic samples the same live
    // wallpaper that remains fixed behind both source and destination.
    if (image.src !== preview.foregroundSrc) image.src = preview.foregroundSrc;
    return image;
  }
  function revealProjectWorld(layer) {
    const image = layer?.querySelector?.(":scope > .crm-project-transition-preview");
    const live = layer?.querySelector?.(":scope > .crm-planner-project-live"); if (!image || !live) return;
    // The final camera frames already crossfade this predecoded texture into
    // the live world. Seat those exact endpoint values in the same task so
    // nothing continues materializing after the transform has stopped.
    live.style.transition = "none"; live.style.opacity = "1";
    image.style.transition = "none"; image.style.opacity = "0";
  }
  function coverProjectWorld(layer, project) {
    const image = ensureProjectTransitionPreview(layer, project); if (!image) return;
    const live = layer?.querySelector?.(":scope > .crm-planner-project-live");
    // Contract begins from the real settled world. Its first camera frames
    // crossfade into the cached object/acrylic composition while both remain
    // geometrically identical.
    if (live) { live.style.transition = "none"; live.style.opacity = "1"; }
    image.style.transition = "none"; image.style.opacity = "0";
  }
  function settleProjectWorld(layer) {
    const image = layer?.querySelector?.(":scope > .crm-project-transition-preview");
    const live = layer?.querySelector?.(":scope > .crm-planner-project-live");
    const acrylic = layer?.querySelector?.(":scope > .crm-project-transition-acrylic");
    if (image) { image.style.transition = "none"; image.style.opacity = "0"; }
    if (live) { live.style.transition = "none"; live.style.opacity = "1"; }
    if (acrylic) acrylic.style.opacity = "";
  }
  function renderGalleryLayer(layer) {
    if (!layer) return;
    const previous = layer.querySelector(".crm-project-gallery-scroll"); if (previous) galleryScrollLeft = previous.scrollLeft;
    layer.classList.add("crm-project-gallery-level");
    if (!previous) layer.innerHTML = galleryHTML();
    const scroller = layer.querySelector(".crm-project-gallery-scroll"); const grid = layer.querySelector(".crm-project-tile-grid"); const titles = layer.querySelector(".crm-project-title-grid"); if (!scroller || !grid || !titles) return;
    const wanted = new Set(model.projects.map((project) => project.id));
    grid.querySelectorAll(".crm-project-bucket[data-planner-project]").forEach((tile) => { if (!wanted.has(tile.dataset.plannerProject)) tile.remove(); });
    titles.querySelectorAll(".crm-home-title-slot[data-project-title]:not([data-project-title='create'])").forEach((title) => { if (!wanted.has(title.dataset.projectTitle)) title.remove(); });
    let createTile = grid.querySelector(".crm-project-create");
    let createTitle = titles.querySelector("[data-project-title='create']");
    model.projects.forEach((project, index) => {
      let tile = grid.querySelector(`.crm-project-bucket[data-planner-project="${cssValue(project.id)}"]`);
      if (!tile) {
        const template = document.createElement("template"); template.innerHTML = projectBucketHTML(project); tile = template.content.firstElementChild;
        grid.insertBefore(tile, createTile);
      }
      const signature = projectPreviewSignature(project);
      tile.dataset.previewSignature = signature;
      tile.setAttribute("aria-label", `Open ${project.title}`);
      mountProjectPreview(tile.querySelector(":scope > .crm-home-preview"), projectPreviews.get(project.id));
      let title = titles.querySelector(`[data-project-title="${cssValue(project.id)}"]`);
      if (!title) { const template=document.createElement("template"); template.innerHTML=projectTitleHTML(project); title=template.content.firstElementChild; titles.insertBefore(title, createTitle); }
      const titleText = title.querySelector(".crm-home-title"); if (titleText?.textContent !== project.title) titleText.textContent = project.title;
      const atIndex = grid.querySelectorAll(".crm-project-bucket[data-planner-project]")[index];
      if (atIndex !== tile) grid.insertBefore(tile, atIndex || createTile);
      const titleAtIndex = titles.querySelectorAll(".crm-home-title-slot[data-project-title]:not([data-project-title='create'])")[index];
      if (titleAtIndex !== title) titles.insertBefore(title, titleAtIndex || createTitle);
    });
    if (!createTile) { const template=document.createElement("template"); template.innerHTML=createProjectHTML(); createTile=template.content.firstElementChild; grid.appendChild(createTile); }
    else if (createTile !== grid.lastElementChild) grid.appendChild(createTile);
    if (!createTitle) { const template=document.createElement("template"); template.innerHTML=createProjectTitleHTML(); createTitle=template.content.firstElementChild; titles.appendChild(createTitle); }
    else if (createTitle !== titles.lastElementChild) titles.appendChild(createTitle);
    scroller.scrollLeft = galleryScrollLeft;
    wireProjectGalleryScroller(layer);
    scheduleProjectPreviews();
  }
  function renderProjectLayer(layer, project) {
    if (!layer || !project) return;
    const previous = layer.querySelector(".crm-planner-buckets");
    if (previous?.dataset.plannerScrollProject) plannerScrollPositions.set(previous.dataset.plannerScrollProject, previous.scrollLeft);
    plannerResizeObserver?.disconnect(); layer.classList.add("crm-planner-project-world"); layer.dataset.projectId = project.id;
    let live = layer.querySelector(":scope > .crm-planner-project-live"); if (!live) { live=document.createElement("div"); live.className="crm-planner-project-live"; layer.prepend(live); }
    live.innerHTML = projectWorldHTML(project); ensureProjectTransitionPreview(layer, project);
    window.crmObjectSizing?.scan?.(layer); wirePlannerScroller(project.id, layer);
  }
  function buildProjectGallery() {
    const layer = document.createElement("div"); renderGalleryLayer(layer); return layer;
  }
  function buildProjectWorld(project) {
    const layer = document.createElement("div"); layer.className = "crm-planner-level crm-planner-project-world"; layer.dataset.projectId = project?.id || "";
    const acrylic=document.createElement("span"); acrylic.className="crm-project-transition-acrylic"; acrylic.setAttribute("aria-hidden","true"); layer.appendChild(acrylic);
    const live=document.createElement("div"); live.className="crm-planner-project-live"; live.innerHTML=projectWorldHTML(project); layer.appendChild(live); ensureProjectTransitionPreview(layer, project); return layer;
  }
  function markProjectCameraTarget(target, context) {
    const gallery = context?.layers?.[0];
    gallery?.querySelectorAll?.(".crm-project-bucket.is-camera-target")?.forEach?.((tile) => tile.classList.remove("is-camera-target"));
    target?.classList?.add?.("is-camera-target");
  }
  function clearProjectCameraTarget(context) {
    context?.layers?.[0]?.querySelectorAll?.(".crm-project-bucket.is-camera-target")?.forEach?.((tile) => tile.classList.remove("is-camera-target"));
  }
  function render() {
    if (!camera) return;
    if (camera.isTransitioning?.()) { camera.whenSettled?.().then(render); return; }
    camera.dropWarm?.(); const layers = camera.layers(); renderGalleryLayer(layers[0]);
    if (camera.level() > 0 && layers[1]) renderProjectLayer(layers[1], selectedProject());
    camera.layout?.();
  }
  function progressSegments(project, stageId) {
    const stages = stagesOf(project); const current = Math.max(0, stages.findIndex((stage) => stage.id === String(stageId)));
    return stages.map((_stage, index) => `<span class="tk-seg${index <= current ? " g" : ""}"></span>`).join("");
  }
  function stageProgressHTML(project, stageId) {
    return `<span class="tk-bars crm-planner-stage-progress" aria-hidden="true">${progressSegments(project, stageId)}</span>`;
  }
  function cardInnerHTML(item) {
    const project = projectById(item.projectId);
    const link = item.linkedEntityType ? `${String(item.linkedEntityType).replace(/s$/, "")} · ${first(item.linkedLabel, item.linkedRecordId)}` : "";
    return `<span class="crm-planner-card-body ticket-body"><span class="crm-planner-card-title">${esc(item.title)}</span>${item.note ? `<span class="crm-planner-card-note">${esc(item.note)}</span>` : ""}<span class="crm-planner-card-meta"><span>${esc(first(item.assignee, "Unassigned"))}</span></span>${link ? `<span class="crm-planner-card-link">${esc(link)}</span>` : ""}</span><span class="tk-bars tk-bars-card crm-planner-card-progress" aria-hidden="true">${progressSegments(project, item.stageId)}</span>`;
  }
  function cardHTML(item) {
    return `<button type="button" class="crm-planner-card" draggable="true" data-planner-card="${esc(item.id)}" data-card-detail-card data-record-entity="workItems" data-record-id="${esc(item.id)}" data-crm-size-key="${esc(`card:workItems:${item.id}`)}" aria-label="${esc(item.title)}">${cardInnerHTML(item)}</button>`;
  }

  const plannerDetailSource = {
    list:async () => ({ records:clone(model.items) }),
    onChanged:(callback) => { const listener = () => callback(); listeners.add(listener); return () => listeners.delete(listener); },
  };
  const linkedTargetOptions = () => [
    ["", "Nothing linked"],
    ...model.tasks.map((record) => [`tasks:${record.id}`, `Task · ${recordName(record)}`]),
    ...model.contacts.map((record) => [`contacts:${record.id}`, `Person · ${recordName(record)}`]),
    ...model.tickets.map((record) => [`tickets:${record.id}`, `Ticket · ${recordName(record)}`]),
  ];
  const plannerDetailFields = () => [
    { key:"title", label:"Card title", q:"What needs to happen?" },
    { key:"note", label:"Details", q:"Add context", area:true, req:false },
    { key:"dueAt", label:"Due", date:true, req:false },
    { key:"assignedContactId", label:"Owner", options:() => [["", "Unassigned"], ...model.contacts.map((contact) => [contact.id, contactName(contact)])], req:false },
    { key:"linkedTarget", label:"Linked to", options:linkedTargetOptions, req:false },
    { key:"priority", label:"Priority", prio:true, req:false },
  ];
  const dateInputValue = (value) => {
    const raw = String(value || ""); if (!raw) return ""; if (!raw.includes("T")) return raw.slice(0, 10);
    const date = new Date(raw); if (Number.isNaN(date.getTime())) return ""; const pad = (part) => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };
  function plannerDetailValue(itemId, key) {
    const item = itemById(itemId); if (!item) return "";
    if (key === "dueAt") return dateInputValue(item.dueAt);
    if (key === "linkedTarget") return item.linkedEntityType && item.linkedRecordId ? `${item.linkedEntityType}:${item.linkedRecordId}` : "";
    return item[key] ?? "";
  }
  function patchPlannerCard(item) {
    if (!item) return;
    document.querySelectorAll(`[data-planner-card="${cssValue(item.id)}"]`).forEach((card) => {
      card.innerHTML = cardInnerHTML(item);
      card.setAttribute("aria-label", first(item.title, "Untitled card"));
    });
  }
  function queuePlannerDetailFields(itemId, fields = {}) {
    const item = itemById(itemId); if (!item) return false;
    const display = {}; const persist = {};
    if (Object.prototype.hasOwnProperty.call(fields, "title")) {
      const raw = String(fields.title || ""); display.title = raw;
      if (raw.trim()) persist.title = raw.trim();
    }
    if (Object.prototype.hasOwnProperty.call(fields, "note")) display.note = persist.note = String(fields.note || "");
    if (Object.prototype.hasOwnProperty.call(fields, "dueAt")) {
      const value = String(fields.dueAt || ""); display.dueAt = persist.dueAt = value ? new Date(`${value}T17:00:00`).toISOString() : null;
    }
    if (Object.prototype.hasOwnProperty.call(fields, "assignedContactId")) {
      const contact = model.contacts.find((record) => String(record.id) === String(fields.assignedContactId || ""));
      display.assignedContactId = persist.assignedContactId = contact?.id || null;
      display.assignee = persist.assignee = contact ? contactName(contact) : null;
    }
    if (Object.prototype.hasOwnProperty.call(fields, "linkedTarget")) {
      const raw = String(fields.linkedTarget || ""); const [entityType, ...parts] = raw.split(":"); const recordId = parts.join(":");
      const record = raw ? [...model.tasks, ...model.contacts, ...model.tickets].find((candidate) => String(candidate.id) === recordId) : null;
      display.linkedEntityType = persist.linkedEntityType = raw ? entityType : null;
      display.linkedRecordId = persist.linkedRecordId = raw ? recordId : null;
      display.linkedLabel = persist.linkedLabel = raw ? recordName(record) : null;
    }
    if (Object.prototype.hasOwnProperty.call(fields, "priority")) display.priority = persist.priority = String(fields.priority || "normal");
    Object.assign(item, display); patchPlannerCard(item);
    if (Object.keys(persist).length) pendingDetailFields.set(item.id, { ...(pendingDetailFields.get(item.id) || {}), ...persist });
    clearTimeout(detailSaveTimer); detailSaveTimer = setTimeout(() => { flushPlannerDetailFields(); }, 180);
    return true;
  }
  function flushPlannerDetailFields() {
    clearTimeout(detailSaveTimer); detailSaveTimer = 0;
    const batch = [...pendingDetailFields.entries()]; pendingDetailFields.clear();
    if (!batch.length) return detailSaveTail;
    detailSaveTail = detailSaveTail.catch(() => null).then(async () => {
      for (const [itemId, fields] of batch) await updateItem(itemId, fields, "item-detail-updated", { deferRefresh:true });
    });
    return detailSaveTail;
  }
  const plannerDetailStacks = {
    stageFields:(itemId) => { const item = itemById(itemId); const project = projectById(item?.projectId); const stage = stageById(project, item?.stageId); return { key:stage?.id || "card", label:stage?.title || "Card", fields:plannerDetailFields() }; },
    fieldValue:plannerDetailValue,
    setMeta:queuePlannerDetailFields,
    setPriority:(itemId, priority) => queuePlannerDetailFields(itemId, { priority }),
    onDetailClosed:() => { flushPlannerDetailFields().finally(() => refresh(true, "item-detail-saved")); },
  };
  function ensurePlannerDetail() {
    if (plannerDetail) return plannerDetail;
    if (typeof window.createCrmCardDetail !== "function") return null;
    plannerDetail = window.createCrmCardDetail({
      apiName:"plannerDetail", source:plannerDetailSource, stacks:plannerDetailStacks,
      expandedCardHeight:279,
      priorities:["normal", "high", "urgent"], intensityValues:["normal", "high", "urgent"], defaultIntensity:"normal",
      severityRgb:{ normal:"120,130,140", high:"120,130,140", urgent:"120,130,140", none:"120,130,140" },
      notFoundText:"Card not found.", draftRequiredText:"A title is required to create the card.",
    });
    return plannerDetail;
  }
  function openPlannerItem(item, card) {
    if (!item || !card) return false;
    closeFloating(); ensurePlannerDetail()?.open(item, card); return true;
  }

  const projectGalleryElements = (scope = camera?.layers?.()[0]) => ({
    shell:scope?.querySelector?.(".crm-project-gallery-shell"),
    scroller:scope?.querySelector?.(".crm-project-gallery-scroll"),
    canvas:scope?.querySelector?.(".crm-project-gallery-canvas"),
    bar:scope?.querySelector?.(".crm-project-gallery-hsb"),
    thumb:scope?.querySelector?.(".crm-project-gallery-hth"),
  });
  function updateProjectGalleryScroll(scope = camera?.layers?.()[0]) {
    const { shell, scroller, bar, thumb } = projectGalleryElements(scope); if (!shell || !scroller || !bar || !thumb) return;
    const view = scroller.clientWidth; const content = scroller.scrollWidth; const maximum = Math.max(0, content - view); const position = clamp(scroller.scrollLeft, 0, maximum); const overflowing = maximum > 1;
    galleryScrollLeft = position;
    const fadeDistance = Math.min(72, Math.max(42, view * .06));
    shell.style.setProperty("--crm-project-shadow-left", String(overflowing ? Math.min(1, position / fadeDistance) : 0));
    shell.style.setProperty("--crm-project-shadow-right", String(overflowing ? Math.min(1, (maximum - position) / fadeDistance) : 0));
    bar.classList.toggle("is-on", overflowing); bar.setAttribute("aria-hidden", String(!overflowing));
    if (!overflowing) { if (scroller.scrollLeft) scroller.scrollLeft = 0; thumb.style.width = "100%"; thumb.style.left = "0px"; return; }
    const trackWidth = Math.max(1, bar.clientWidth); const width = Math.max(28, trackWidth * (view / content)); const left = maximum ? position / maximum * (trackWidth - width) : 0;
    thumb.style.width = `${Math.round(width)}px`; thumb.style.left = `${Math.round(left)}px`;
  }
  function scrollProjectGalleryBy(delta, scope = camera?.layers?.()[0]) {
    const { scroller } = projectGalleryElements(scope); if (!scroller) return false; const maximum = Math.max(0, scroller.scrollWidth - scroller.clientWidth); if (maximum <= 1) return false;
    const next = clamp(scroller.scrollLeft + delta, 0, maximum); if (Math.abs(next - scroller.scrollLeft) < .5) return false;
    scroller.scrollLeft = next; updateProjectGalleryScroll(scope); return true;
  }
  function revealProjectTile(tile) {
    const scope = tile?.closest?.(".crm-project-gallery-level"); const { scroller, bar } = projectGalleryElements(scope); if (!tile || !scroller) return false;
    const view = scroller.getBoundingClientRect(); const bounds = tile.getBoundingClientRect(); const barBounds = bar?.getBoundingClientRect(); const inset = barBounds ? Math.max(0, barBounds.left - view.left) : 22; let delta = 0;
    if (bounds.left < view.left + inset) delta = bounds.left - (view.left + inset);
    else if (bounds.right > view.right - inset) delta = bounds.right - (view.right - inset);
    return !delta || scrollProjectGalleryBy(delta, scope);
  }
  function wireProjectGalleryScroller(scope) {
    const { shell, scroller, canvas, bar, thumb } = projectGalleryElements(scope); if (!shell || !scroller || !canvas || !bar || !thumb || shell.dataset.projectGalleryWired === "true") return;
    shell.dataset.projectGalleryWired = "true";
    scroller.addEventListener("scroll", () => updateProjectGalleryScroll(scope), { passive:true });
    shell.addEventListener("wheel", (event) => {
      if (event.defaultPrevented || event.target.closest?.("button,a,input,select,textarea,[contenteditable],.crm-menu-surface")) return;
      const raw = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY; if (!raw) return;
      const pixels = event.deltaMode === 1 ? raw * 16 : event.deltaMode === 2 ? raw * scroller.clientWidth : raw;
      if (scrollProjectGalleryBy(pixels, scope)) event.preventDefault();
    }, { passive:false });
    scroller.addEventListener("keydown", (event) => {
      if (event.target !== scroller) return;
      const amount = event.key === "ArrowLeft" ? -72 : event.key === "ArrowRight" ? 72 : event.key === "PageUp" ? -scroller.clientWidth * .82 : event.key === "PageDown" ? scroller.clientWidth * .82 : event.key === "Home" ? -scroller.scrollWidth : event.key === "End" ? scroller.scrollWidth : 0;
      if (!amount || !scrollProjectGalleryBy(amount, scope)) return; event.preventDefault();
    });
    let dragging = false; let startX = 0; let startScroll = 0; let pointerId = null;
    const move = (event) => {
      if (!dragging) return; const maximum = Math.max(0, scroller.scrollWidth - scroller.clientWidth); const trackWidth = bar.clientWidth; const thumbWidth = thumb.getBoundingClientRect().width; const fraction = (event.clientX - startX) / Math.max(1, trackWidth - thumbWidth);
      scroller.scrollLeft = clamp(startScroll + fraction * maximum, 0, maximum); updateProjectGalleryScroll(scope);
    };
    const up = () => {
      if (!dragging) return; dragging = false; try { if (pointerId != null && thumb.hasPointerCapture?.(pointerId)) thumb.releasePointerCapture(pointerId); } catch {} pointerId = null;
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
    };
    thumb.addEventListener("pointerdown", (event) => {
      event.preventDefault(); event.stopPropagation(); dragging = true; pointerId = event.pointerId; try { thumb.setPointerCapture?.(pointerId); } catch {} startX = event.clientX; startScroll = scroller.scrollLeft;
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
    });
    projectGalleryResizeObserver?.disconnect(); projectGalleryResizeObserver = new ResizeObserver(() => updateProjectGalleryScroll(scope)); projectGalleryResizeObserver.observe(scroller); projectGalleryResizeObserver.observe(canvas);
    requestAnimationFrame(() => updateProjectGalleryScroll(scope));
  }

  function updatePlannerScrollEdges() {
    const scroller = root?.querySelector(".crm-planner-buckets"); const stage = scroller?.closest(".crm-planner-stage"); if (!stage) return;
    const maximum = Math.max(0, (scroller.scrollWidth || 0) - scroller.clientWidth); const position = Math.max(0, Math.min(maximum, scroller.scrollLeft)); const fadeDistance = Math.min(72, Math.max(42, scroller.clientWidth * .06));
    stage.style.setProperty("--crm-scroll-shadow-left", String(maximum > 1 ? Math.min(1, position / fadeDistance) : 0));
    stage.style.setProperty("--crm-scroll-shadow-right", String(maximum > 1 ? Math.min(1, (maximum - position) / fadeDistance) : 0));
    if (scroller.dataset.plannerScrollProject) plannerScrollPositions.set(scroller.dataset.plannerScrollProject, position);
  }
  function wirePlannerScroller(projectId, scope = root) {
    const scroller = scope?.querySelector(".crm-planner-buckets"); if (!scroller) return;
    const restore = Math.max(0, Number(plannerScrollPositions.get(String(projectId || ""))) || 0);
    scroller.scrollLeft = Math.min(restore, Math.max(0, scroller.scrollWidth - scroller.clientWidth));
    scroller.addEventListener("scroll", updatePlannerScrollEdges, { passive:true });
    plannerResizeObserver = new ResizeObserver(updatePlannerScrollEdges); plannerResizeObserver.observe(scroller); scroller.querySelectorAll(".crm-planner-bucket").forEach((bucket) => plannerResizeObserver.observe(bucket));
    requestAnimationFrame(updatePlannerScrollEdges);
  }

  const closeFloating = () => { floating?.remove(); floating = null; };
  const place = (element, anchor, x, y) => {
    if (!element.isConnected) document.body.appendChild(element); const source = anchor?.getBoundingClientRect(); const bounds = element.getBoundingClientRect();
    const left = Math.max(10, Math.min(innerWidth - bounds.width - 10, Number.isFinite(x) ? x : (source?.right || innerWidth / 2) - bounds.width));
    const top = Math.max(48, Math.min(innerHeight - bounds.height - 12, Number.isFinite(y) ? y : (source?.bottom || innerHeight / 2) + 5));
    element.style.left = `${left}px`; element.style.top = `${top}px`;
  };
  const armOutside = (element) => setTimeout(() => {
    const close = (event) => { if (element.contains(event.target)) return; closeFloating(); document.removeEventListener("pointerdown", close, true); };
    document.addEventListener("pointerdown", close, true);
  }, 0);
  function openTextEditor({ title, value = "", placeholder = "Name", submit = "Save", anchor, onSubmit }) {
    closeFloating(); floating = document.createElement("form"); floating.className = "crm-planner-popover crm-menu-surface";
    floating.innerHTML = `<div class="crm-planner-popover-title">${esc(title)}</div><input class="crm-menu-input" name="value" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" required><div class="crm-planner-creator-status" role="status" aria-live="polite"></div><div class="crm-planner-popover-actions"><button type="button" class="crm-menu-action" data-cancel>Cancel</button><button type="submit" class="crm-menu-action">${esc(submit)}</button></div>`;
    floating.addEventListener("submit", async (event) => { event.preventDefault(); const input = floating.elements.value.value.trim(); if (!input) return; const saved = await onSubmit(input); if (saved === false || saved == null) { floating.querySelector(".crm-planner-creator-status").textContent = "Use a unique name."; floating.elements.value.select(); return; } closeFloating(); });
    floating.querySelector("[data-cancel]")?.addEventListener("click", closeFloating); place(floating, anchor); armOutside(floating); requestAnimationFrame(() => floating?.elements?.value?.focus());
  }
  const projectOwnerOptions = (selectedId = "") => [["", "Unassigned"], ...model.contacts.map((contact) => [contact.id, contactName(contact)])]
    .map(([value, label]) => `<option value="${esc(value)}"${String(value) === String(selectedId || "") ? " selected" : ""}>${esc(label)}</option>`).join("");
  const projectDateValue = (value) => {
    const raw = String(value || ""); if (!raw) return null; const date = new Date(`${raw}T17:00:00`); return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  };
  function openProjectEditor(anchor, project) {
    if (!project) return;
    closeFloating(); floating = document.createElement("form"); floating.className = "crm-planner-popover crm-planner-project-editor crm-menu-surface";
    floating.innerHTML = `<div class="crm-planner-popover-title">Project details</div><input class="crm-menu-input" name="title" value="${esc(project.title)}" placeholder="Project name" autocomplete="off" required><textarea class="crm-menu-input" name="note" placeholder="Brief">${esc(project.note || "")}</textarea><div class="crm-planner-project-fields"><label class="crm-planner-project-field"><span>Owner</span><select class="crm-menu-input" name="ownerContactId">${projectOwnerOptions(project.ownerContactId)}</select></label><label class="crm-planner-project-field"><span>Target</span><input class="crm-menu-input" type="date" name="dueAt" value="${esc(dateInputValue(project.dueAt))}"></label></div><div class="crm-planner-popover-actions"><button type="button" class="crm-menu-action" data-cancel>Cancel</button><button type="submit" class="crm-menu-action">Save</button></div>`;
    floating.addEventListener("submit", async (event) => {
      event.preventDefault(); const data = new FormData(floating); const title = String(data.get("title") || "").trim(); if (!title) { floating.elements.title.focus(); return; }
      const ownerContactId = String(data.get("ownerContactId") || ""); const owner = model.contacts.find((contact) => String(contact.id) === ownerContactId); const dueAt = projectDateValue(data.get("dueAt"));
      const saved = await updateProject(project.id, { title, note:String(data.get("note") || "").trim(), ownerContactId:owner?.id || null, owner:owner ? contactName(owner) : null, dueAt }, "project-details-updated"); if (saved) closeFloating();
    });
    floating.querySelector("[data-cancel]")?.addEventListener("click", closeFloating); place(floating, anchor); armOutside(floating); requestAnimationFrame(() => floating?.elements?.title?.focus());
  }
  function confirmProjectDelete(anchor, project) {
    if (!project) return;
    closeFloating(); floating = document.createElement("div"); floating.className = "crm-planner-popover crm-menu-surface"; const count = model.items.filter((item) => item.projectId === project.id).length;
    floating.innerHTML = `<div class="crm-planner-popover-title">Delete project?</div><div class="crm-planner-popover-hint">${count ? `${count} linked card${count === 1 ? "" : "s"} will also be removed.` : "This project has no linked cards."}</div><div class="crm-planner-popover-actions"><button type="button" class="crm-menu-action" data-cancel>Cancel</button><button type="button" class="crm-menu-action tk-menu-danger" data-confirm-delete>Delete</button></div>`;
    floating.querySelector("[data-cancel]")?.addEventListener("click", closeFloating); floating.querySelector("[data-confirm-delete]")?.addEventListener("click", async () => { const deleted = await deleteProject(project); if (deleted) closeFloating(); }); place(floating, anchor); armOutside(floating);
  }
  function openProjectCreator(anchor) {
    closeFloating(); floating = document.createElement("form"); floating.className = "crm-planner-popover crm-planner-project-creator crm-menu-surface";
    let presetId = "simple"; let customStages = [];
    floating.innerHTML = `<div class="crm-planner-popover-title">Create project</div><input class="crm-menu-input" name="title" placeholder="Project name" autocomplete="off" required><textarea class="crm-menu-input" name="note" placeholder="Brief"></textarea><div class="crm-planner-project-fields"><label class="crm-planner-project-field"><span>Owner</span><select class="crm-menu-input" name="ownerContactId">${projectOwnerOptions()}</select></label><label class="crm-planner-project-field"><span>Target</span><input class="crm-menu-input" type="date" name="dueAt"></label></div><div class="crm-planner-preset-label">Structure</div><div class="crm-planner-presets" role="radiogroup" aria-label="Project structure">${PIPELINE_PRESETS.map((preset) => `<button type="button" class="crm-planner-preset crm-menu-action${preset.id === presetId ? " is-selected" : ""}" data-planner-preset="${preset.id}" role="radio" aria-checked="${preset.id === presetId}"><span class="crm-planner-preset-name">${esc(preset.label)}</span><span class="crm-planner-preset-map">${preset.stages.length ? esc(preset.stages.join(" · ")) : "Add your stages"}</span></button>`).join("")}</div><div class="crm-planner-custom-builder" hidden><div class="crm-planner-stage-entry"><input class="crm-menu-input" name="stageName" placeholder="Stage name" autocomplete="off"><button type="button" class="crm-menu-action" data-add-stage aria-label="Add stage">+</button></div><div class="crm-planner-stage-list" aria-live="polite"></div><div class="crm-planner-popover-hint">Add each stage once, in the order work should move.</div></div><div class="crm-planner-creator-status" role="status" aria-live="polite"></div><div class="crm-planner-popover-actions"><button type="button" class="crm-menu-action" data-cancel>Cancel</button><button type="submit" class="crm-menu-action">Create project</button></div>`;
    const status = floating.querySelector(".crm-planner-creator-status"); const builder = floating.querySelector(".crm-planner-custom-builder"); const stageList = floating.querySelector(".crm-planner-stage-list"); const stageInput = floating.elements.stageName;
    const showStatus = (message = "") => { status.textContent = message; };
    const reposition = () => requestAnimationFrame(() => { if (floating?.isConnected) place(floating, anchor); });
    const renderCustomStages = () => {
      stageList.innerHTML = customStages.map((name, index) => `<span class="crm-planner-stage-pill"><span>${esc(name)}</span><button type="button" class="crm-planner-stage-remove" data-remove-stage="${index}" aria-label="Remove ${esc(name)}">&times;</button></span>`).join("");
      reposition();
    };
    const addCustomStage = () => {
      const name = String(stageInput.value || "").trim();
      if (!name) { showStatus("Give this stage a name."); stageInput.focus(); return false; }
      if (customStages.some((stage) => stage.localeCompare(name, undefined, { sensitivity:"accent" }) === 0)) { showStatus("Stage names must be unique."); stageInput.select(); return false; }
      customStages.push(name); stageInput.value = ""; showStatus(); renderCustomStages(); stageInput.focus(); return true;
    };
    floating.querySelectorAll("[data-planner-preset]").forEach((button) => button.addEventListener("click", () => {
      presetId = button.dataset.plannerPreset; floating.querySelectorAll("[data-planner-preset]").forEach((candidate) => { const selected = candidate === button; candidate.classList.toggle("is-selected", selected); candidate.setAttribute("aria-checked", String(selected)); });
      builder.hidden = presetId !== "custom"; showStatus(); reposition(); if (!builder.hidden) requestAnimationFrame(() => stageInput.focus());
    }));
    floating.querySelector("[data-add-stage]")?.addEventListener("click", addCustomStage);
    stageInput.addEventListener("keydown", (event) => { if (event.key !== "Enter") return; event.preventDefault(); addCustomStage(); });
    stageList.addEventListener("click", (event) => { const button = event.target.closest("[data-remove-stage]"); if (!button) return; customStages.splice(Number(button.dataset.removeStage), 1); showStatus(); renderCustomStages(); });
    floating.addEventListener("submit", async (event) => {
      event.preventDefault(); const data = new FormData(floating); const title = String(data.get("title") || "").trim();
      if (!title) { showStatus("Give this project a name."); floating.elements.title.focus(); return; }
      const preset = PIPELINE_PRESETS.find((candidate) => candidate.id === presetId) || PIPELINE_PRESETS[0];
      if (preset.id === "custom" && customStages.length < 2) { showStatus("Add at least two uniquely named stages."); stageInput.focus(); return; }
      const ownerContactId = String(data.get("ownerContactId") || ""); const owner = model.contacts.find((contact) => String(contact.id) === ownerContactId);
      const created = await createProject(title, String(data.get("note") || "").trim(), preset.id === "custom" ? customStages : preset.stages, { ownerContactId:owner?.id || null, owner:owner ? contactName(owner) : null, dueAt:projectDateValue(data.get("dueAt")) });
      if (created) { closeFloating(); requestAnimationFrame(() => openProject(created.id)); }
    });
    floating.querySelector("[data-cancel]")?.addEventListener("click", closeFloating); place(floating, anchor); armOutside(floating); requestAnimationFrame(() => floating?.elements?.title?.focus());
  }
  function openMenu(anchor, actions, x, y) {
    closeFloating(); floating = document.createElement("div"); floating.className = "crm-planner-context crm-menu-surface";
    actions.filter(Boolean).forEach((action) => { const button = document.createElement("button"); button.type = "button"; button.className = `crm-menu-action${action.danger ? " tk-menu-danger" : ""}`; button.textContent = action.label; button.addEventListener("click", () => { closeFloating(); action.run(); }); floating.appendChild(button); });
    place(floating, anchor, x, y); armOutside(floating);
  }
  async function createProject(title, note = "", stageTitles = null, options = {}) {
    const names = []; const seen = new Set();
    if (Array.isArray(stageTitles)) stageTitles.forEach((value) => { const name = String(value || "").trim(); const key = name.toLocaleLowerCase(); if (name && !seen.has(key)) { seen.add(key); names.push(name); } });
    const stages = names.length ? names.map((name, index) => normalizeStage({ id:uid("stage"), title:name, kind:index === 0 ? "queue" : index === names.length - 1 ? "done" : "active", rank:index }, index)) : clone(DEFAULT_STAGES);
    const result = await window.crmStore.create("projects", { title:String(title || "").trim(), note:String(note || "").trim(), stages, ownerContactId:options.ownerContactId || null, owner:options.owner || null, dueAt:options.dueAt || null });
    if (!result?.record) return null; selectedId = result.record.id; await refresh(true, "project-created"); return clone(projectById(selectedId));
  }
  async function createStage(projectId, title) {
    const project = projectById(projectId); if (!project) return null; const stages = stagesOf(project); const name = String(title || "").trim();
    if (!name || stages.some((candidate) => candidate.title.localeCompare(name, undefined, { sensitivity:"accent" }) === 0)) return null;
    const doneIndex = stages.findIndex((candidate) => candidate.kind === "done"); const insertAt = doneIndex >= 0 ? doneIndex : stages.length;
    const stage = normalizeStage({ id:uid("stage"), title:name, kind:"active", rank:insertAt }, insertAt);
    const next = [...stages.slice(0, insertAt), stage, ...stages.slice(insertAt)].map((candidate, rank) => ({ ...candidate, rank }));
    const result = await window.crmStore.update("projects", project.id, { stages:next }); if (!result?.record) return null; await refresh(true, "stage-created"); return clone(stage);
  }
  async function renameStage(project, stage, title) {
    const stages = stagesOf(project); const name = String(title || "").trim(); if (!name || stages.some((candidate) => candidate.id !== stage.id && candidate.title.localeCompare(name, undefined, { sensitivity:"accent" }) === 0)) return false;
    return updateProject(project.id, { stages:stages.map((candidate) => candidate.id === stage.id ? { ...candidate, title:name } : candidate) }, "stage-renamed");
  }
  const createBucket = createStage;
  async function createCard(projectId, stageId, title, note = "", options = {}) {
    const project = projectById(projectId); const stage = stageById(project, stageId); if (!project || !stage) return null;
    const item = await createLinkedItem(project, stage, title, note, options); if (!item) return null; await refresh(true, "item-created"); return clone(itemById(item.id));
  }
  function selectProject(projectId) {
    if (!projectById(projectId)) return false; selectedId = String(projectId); publish("project-selected"); return true;
  }
  async function openProject(projectId) {
    const project = projectById(projectId); if (!project) return false;
    if (camera?.isTransitioning?.()) await camera.whenSettled();
    if (camera?.level?.() > 0) {
      if (selectedId === project.id) { render(); return true; }
      camera.back(); await camera.whenSettled();
    }
    selectedId = project.id; writeSelected(); announce("project-opened"); render();
    const tile = camera?.layers?.()[0]?.querySelector?.(`.crm-project-bucket[data-planner-project="${cssValue(project.id)}"]`);
    if (!tile) return false;
    camera.expand(tile); await camera.whenSettled(); return camera.level() === 1;
  }
  async function updateProject(projectId, fields, reason = "project-updated") {
    const project = projectById(projectId); if (!project) return false; const result = await window.crmStore.update("projects", project.id, fields); if (!result?.record) return false; await refresh(true, reason); return true;
  }
  async function updateItem(itemId, fields, reason = "item-updated", options = {}) {
    const item = itemById(itemId); if (!item) return false; const project = projectById(item.projectId); if (!project) return false;
    const stageRequested = Object.prototype.hasOwnProperty.call(fields, "stageId");
    const nextStage = stageRequested ? stageById(project, fields.stageId) : stageById(project, item.stageId);
    if (stageRequested && !nextStage) return false;
    const moving = !!nextStage && nextStage.id !== item.stageId;
    const completed = nextStage?.kind === "done";
    const normalizedFields = { ...fields };
    if (moving) Object.assign(normalizedFields, {
      stageId:nextStage.id, stageLabel:nextStage.title,
      rank:Number.isFinite(Number(fields.rank)) ? Number(fields.rank) : model.items.filter((record) => record.projectId === project.id && record.stageId === nextStage.id && record.id !== item.id).length,
      status:completed ? "completed" : "open", completedAt:completed ? nowIso() : null,
    });
    const result = await window.crmStore.update("workItems", item.id, normalizedFields); if (!result?.record) return false;
    const commitment = commitmentFor(item); if (commitment) {
      const commitmentFields = {};
      ["title","dueAt","priority","assignee","status"].forEach((key) => { if (Object.prototype.hasOwnProperty.call(normalizedFields, key)) commitmentFields[key] = normalizedFields[key]; });
      if (moving) Object.assign(commitmentFields, { stageId:nextStage.id, stageLabel:nextStage.title, completedAt:completed ? nowIso() : null, outcome:completed ? `Completed in ${project.title}` : null });
      if (Object.prototype.hasOwnProperty.call(fields, "linkedEntityType") || Object.prototype.hasOwnProperty.call(fields, "linkedRecordId")) {
        const entityType = Object.prototype.hasOwnProperty.call(fields, "linkedEntityType") ? fields.linkedEntityType : item.linkedEntityType;
        const recordId = Object.prototype.hasOwnProperty.call(fields, "linkedRecordId") ? fields.linkedRecordId : item.linkedRecordId;
        commitmentFields.links = [{ entityType:"workItems", recordId:item.id, relation:"regarding" }];
        if (entityType && recordId) commitmentFields.links.push({ entityType, recordId, relation:"supports" });
      }
      if (Object.keys(commitmentFields).length) {
        const commitmentResult = await window.crmDomain.update("commitments", commitment.id, commitmentFields, commitment.version);
        if (commitmentResult?.record) Object.assign(commitment, commitmentResult.record);
      }
    }
    if (moving) {
      const flow = flowFor(item); const flowFields = { stage:nextStage.id, rank:normalizedFields.rank, owner:Object.prototype.hasOwnProperty.call(normalizedFields, "assignee") ? normalizedFields.assignee : item.assignee || null };
      if (flow) { const flowResult = await window.crmDomain.update("workflow-entries", flow.id, flowFields, flow.version); if (flowResult?.record) Object.assign(flow, flowResult.record); }
      else await window.crmDomain.create("workflow-entries", { workflowKey:`project:${project.id}`, entityType:"workItems", recordId:item.id, ...flowFields });
    }
    if (options.deferRefresh) { Object.assign(item, normalizedFields); dirty = true; return true; }
    await refresh(true, moving ? "item-moved" : reason); return true;
  }
  async function moveCard(itemId, stageId) {
    const item = itemById(itemId); const project = projectById(item?.projectId); const stage = stageById(project, stageId); if (!item || !project || !stage) return false;
    const rank = model.items.filter((record) => record.projectId === project.id && record.stageId === stage.id && record.id !== item.id).length;
    return updateItem(item.id, { stageId:stage.id, rank }, "item-moved");
  }
  async function deleteItem(itemId) {
    const item = itemById(itemId); if (!item) return false; const commitment = commitmentFor(item); const flow = flowFor(item);
    await window.crmStore.remove("workItems", item.id); if (commitment) await window.crmDomain.remove("commitments", commitment.id); if (flow) await window.crmDomain.remove("workflow-entries", flow.id);
    await refresh(true, "item-deleted"); return true;
  }
  async function deleteStage(project, stage) {
    const stages = stagesOf(project); if (stages.length <= 1) return false; const index = stages.findIndex((candidate) => candidate.id === stage.id); const fallback = stages[index - 1] || stages[index + 1];
    for (const item of model.items.filter((record) => record.projectId === project.id && record.stageId === stage.id)) await moveCard(item.id, fallback.id);
    return updateProject(project.id, { stages:stages.filter((candidate) => candidate.id !== stage.id).map((candidate, index) => ({ ...candidate, rank:index })) }, "stage-deleted");
  }
  async function deleteProject(project) {
    if (camera?.level?.() > 0 && selectedId === project.id) { camera.back(); await camera.whenSettled(); }
    for (const item of model.items.filter((record) => record.projectId === project.id)) await deleteItem(item.id);
    await window.crmStore.remove("projects", project.id); selectedId = model.projects.find((candidate) => candidate.id !== project.id)?.id || ""; await refresh(true, "project-deleted"); return true;
  }

  function projectMenu(anchor, project = selectedProject()) {
    if (!project) return;
    openMenu(anchor, [
      { label:"Project details", run:() => openProjectEditor(anchor, project) },
      { label:"Delete project", danger:true, run:() => confirmProjectDelete(anchor, project) },
    ]);
  }
  function stageMenu(stage, anchor, x, y) {
    const project = selectedProject(); if (!project || !stage) return; const stages = stagesOf(project); const index = stages.findIndex((candidate) => candidate.id === stage.id); const sized = root?.querySelector(`[data-planner-bucket="${cssValue(stage.id)}"]`);
    openMenu(anchor, [
      { label:window.crmObjectSizing?.isSmall?.(sized, "bucket") ? "Make large" : "Make small", run:() => window.crmObjectSizing?.toggle?.(sized, "bucket") },
      { label:"Rename", run:() => openTextEditor({ title:"Rename stage", value:stage.title, anchor, onSubmit:(value) => renameStage(project, stage, value) }) },
      index > 0 && { label:"Move left", run:() => { const next=[...stages]; [next[index - 1],next[index]]=[next[index],next[index - 1]]; updateProject(project.id, { stages:next.map((candidate, rank) => ({ ...candidate, rank })) }, "stage-reordered"); } },
      index < stages.length - 1 && { label:"Move right", run:() => { const next=[...stages]; [next[index + 1],next[index]]=[next[index],next[index + 1]]; updateProject(project.id, { stages:next.map((candidate, rank) => ({ ...candidate, rank })) }, "stage-reordered"); } },
      { label:stage.kind === "done" ? "Make active stage" : "Mark as done stage", run:() => updateProject(project.id, { stages:stages.map((candidate) => candidate.id === stage.id ? { ...candidate, kind:stage.kind === "done" ? "active" : "done" } : candidate) }, "stage-kind-changed") },
      { label:"Delete stage", danger:true, run:() => deleteStage(project, stage) },
    ], x, y);
  }
  function itemMenu(item, anchor, x, y) {
    openMenu(anchor, [
      { label:window.crmObjectSizing?.isSmall?.(anchor, "card") ? "Make large" : "Make small", run:() => window.crmObjectSizing?.toggle?.(anchor, "card") },
      { label:"Open card", run:() => openPlannerItem(item, anchor) },
      { label:"Delete card", danger:true, run:() => deleteItem(item.id) },
    ], x, y);
  }

  function wire() {
    if (!root || wired) return; wired = true;
    const emphasizeProjectTitle = (tile, emphasized) => {
      if (!tile?.dataset?.plannerProject) return;
      tile.classList.toggle("is-preview-hovered", emphasized);
      camera?.layers?.()[0]?.querySelector?.(`[data-project-title="${cssValue(tile.dataset.plannerProject)}"]`)?.classList.toggle("is-deemphasized", emphasized);
    };
    root.addEventListener("pointermove", (event) => { const tile=event.target.closest?.(".crm-project-bucket[data-planner-project]"); if (tile) emphasizeProjectTitle(tile, true); });
    root.addEventListener("pointerout", (event) => { const tile=event.target.closest?.(".crm-project-bucket[data-planner-project]"); if (tile && !tile.contains(event.relatedTarget)) emphasizeProjectTitle(tile, false); });
    root.addEventListener("focusin", (event) => emphasizeProjectTitle(event.target.closest?.(".crm-project-bucket[data-planner-project]"), true));
    root.addEventListener("focusout", (event) => emphasizeProjectTitle(event.target.closest?.(".crm-project-bucket[data-planner-project]"), false));
    root.addEventListener("click", (event) => {
      const projectButton = event.target.closest("[data-planner-project]"); if (projectButton) return; // the nested camera owns this zoom
      const card = event.target.closest("[data-planner-card]"); if (card) { const item = itemById(card.dataset.plannerCard); if (item) openPlannerItem(item, card); return; }
      const action = event.target.closest("[data-planner-action]"); if (!action) return; const project = selectedProject(); const stageElement = action.closest("[data-planner-bucket]"); const stage = stageById(project, stageElement?.dataset.plannerBucket);
      if (action.dataset.plannerAction === "new-project") openProjectCreator(action);
      if (action.dataset.plannerAction === "projects-back") camera?.back?.();
      if (action.dataset.plannerAction === "project-menu") projectMenu(action, project);
      if (action.dataset.plannerAction === "new-stage" && project) openTextEditor({ title:"New stage", placeholder:"Stage name", submit:"Add", anchor:action, onSubmit:(value) => createStage(project.id, value) });
      if (action.dataset.plannerAction === "stage-menu" && stage) stageMenu(stage, action);
      if (action.dataset.plannerAction === "new-card" && project && stage) openTextEditor({ title:`New card · ${stage.title}`, placeholder:"Card title", submit:"Add card", anchor:action, onSubmit:(value) => createCard(project.id, stage.id, value) });
    });
    root.addEventListener("wheel", (event) => {
      if (event.defaultPrevented || event.target.closest?.("button,a,input,select,textarea,[contenteditable],.crm-menu-surface")) return;
      const scroller = root.querySelector(".crm-planner-buckets"); const bounds = scroller?.getBoundingClientRect();
      if (!scroller || !bounds || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.bottom || event.clientY > innerHeight) return;
      const maximum = Math.max(0, scroller.scrollWidth - scroller.clientWidth); if (maximum <= 1) return;
      const raw = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY; if (!raw) return;
      const pixels = event.deltaMode === 1 ? raw * 16 : event.deltaMode === 2 ? raw * scroller.clientWidth : raw;
      const next = Math.max(0, Math.min(maximum, scroller.scrollLeft + pixels)); if (Math.abs(next - scroller.scrollLeft) < .5) return;
      scroller.scrollLeft = next; updatePlannerScrollEdges(); event.preventDefault();
    }, { passive:false });
    root.addEventListener("keydown", (event) => {
      const current = event.target.closest(".crm-project-bucket"); if (!current || !["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(event.key)) return;
      const grid = current.closest(".crm-project-tile-grid"); const tiles = [...(grid?.querySelectorAll(".crm-project-bucket") || [])]; const index = tiles.indexOf(current); if (index < 0) return;
      const rowCount = Math.max(1, Number(grid.dataset.projectRows) || 1); const row = index % rowCount; const column = Math.floor(index / rowCount); let nextIndex = index;
      if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = tiles.length - 1;
      else if (event.key === "ArrowUp" && row > 0) nextIndex = index - 1;
      else if (event.key === "ArrowDown" && row + 1 < rowCount && index + 1 < tiles.length) nextIndex = index + 1;
      else if (event.key === "ArrowLeft" && column > 0) nextIndex = Math.min(tiles.length - 1, (column - 1) * rowCount + row);
      else if (event.key === "ArrowRight" && (column + 1) * rowCount < tiles.length) nextIndex = Math.min(tiles.length - 1, (column + 1) * rowCount + row);
      if (nextIndex === index) return; event.preventDefault(); tiles[nextIndex]?.focus({ preventScroll:true }); revealProjectTile(tiles[nextIndex]);
    });
    root.addEventListener("contextmenu", (event) => {
      const projectElement = event.target.closest("[data-planner-project]"); const cardElement = event.target.closest("[data-planner-card]"); const stageElement = event.target.closest("[data-planner-bucket]");
      if (cardElement) { event.preventDefault(); itemMenu(itemById(cardElement.dataset.plannerCard), cardElement, event.clientX, event.clientY); }
      else if (stageElement) { event.preventDefault(); stageMenu(stageById(selectedProject(), stageElement.dataset.plannerBucket), stageElement, event.clientX, event.clientY); }
      else if (projectElement) { event.preventDefault(); camera?.dropWarm?.(); selectedId = projectElement.dataset.plannerProject; writeSelected(); projectMenu(projectElement, projectById(selectedId)); }
    });
    root.addEventListener("dragstart", (event) => { const card = event.target.closest("[data-planner-card]"); if (!card) return; dragItemId = card.dataset.plannerCard; card.classList.add("is-dragging"); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", dragItemId); });
    root.addEventListener("dragend", (event) => { event.target.closest("[data-planner-card]")?.classList.remove("is-dragging"); root.querySelectorAll(".is-drop-target").forEach((node) => node.classList.remove("is-drop-target")); dragItemId = ""; });
    root.addEventListener("dragover", (event) => { const stage = event.target.closest("[data-planner-bucket]"); if (!stage || !dragItemId) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; root.querySelectorAll(".crm-planner-bucket").forEach((node) => node.classList.toggle("is-drop-target", node === stage)); });
    root.addEventListener("dragleave", (event) => { const stage = event.target.closest("[data-planner-bucket]"); if (stage && !stage.contains(event.relatedTarget)) stage.classList.remove("is-drop-target"); });
    root.addEventListener("drop", async (event) => { const stage = event.target.closest("[data-planner-bucket]"); if (!stage || !dragItemId) return; event.preventDefault(); await moveCard(dragItemId, stage.dataset.plannerBucket); dragItemId = ""; });
  }

  function layoutProjects() {
    const layer = camera?.layers?.()[0]; const shell = layer?.querySelector?.(".crm-project-gallery-shell"); const scroller = layer?.querySelector?.(".crm-project-gallery-scroll"); const canvas = layer?.querySelector?.(".crm-project-gallery-canvas");
    const grid = layer?.querySelector?.(".crm-project-tile-grid"); const titles = layer?.querySelector?.(".crm-project-title-grid");
    if (shell && scroller && canvas && grid && titles) {
      const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--crm-object-gap")) || 18;
      const railInset = parseFloat(getComputedStyle(shell).getPropertyValue("--crm-project-rail-inset")) || 24;
      const count = Math.max(1, model.projects.length + 1); const rows = Math.min(2, count); const columns = Math.ceil(count / rows);
      const preview = model.projects.map((project) => projectPreviews.get(project.id)).find((item) => Number(item?.width) > 0 && Number(item?.height) > 0);
      const aspect = preview ? preview.width / preview.height : innerWidth / innerHeight;
      const availableWidth = Math.max(1, scroller.clientWidth); const availableHeight = Math.max(1, scroller.clientHeight);
      const heightBound = Math.max(1, (availableHeight - gap * Math.max(0, rows - 1)) / rows); const widthBound = Math.max(1, availableWidth - railInset * 2);
      const cellWidth = Math.max(1, Math.min(heightBound * aspect, widthBound)); const cellHeight = Math.max(1, cellWidth / aspect);
      const gridWidth = cellWidth * columns + gap * Math.max(0, columns - 1); const gridHeight = cellHeight * rows + gap * Math.max(0, rows - 1); const overflowing = gridWidth + railInset * 2 > availableWidth + 1;
      const left = overflowing ? railInset : Math.max(railInset, (availableWidth - gridWidth) / 2); const right = overflowing ? railInset : left; const top = Math.max(0, (availableHeight - gridHeight) / 2);
      const geometry = { left:`${left}px`, top:`${top}px`, width:`${gridWidth}px`, height:`${gridHeight}px`, gridTemplateColumns:`repeat(${columns},${cellWidth}px)`, gridTemplateRows:`repeat(${rows},${cellHeight}px)` };
      grid.dataset.projectRows = String(rows); titles.dataset.projectRows = String(rows); Object.assign(grid.style, geometry); Object.assign(titles.style, geometry);
      canvas.style.width = `${Math.max(availableWidth, left + gridWidth + right)}px`; canvas.style.height = `${availableHeight}px`;
      camera?.surface?.()?.style.setProperty("--home-r", `${Math.min(64, Math.max(2, 16 / 245 * Math.min(cellWidth, cellHeight) * 2)).toFixed(1)}px`);
      if (!camera?.isTransitioning?.()) scroller.scrollLeft = clamp(galleryScrollLeft, 0, Math.max(0, scroller.scrollWidth - scroller.clientWidth));
      requestAnimationFrame(() => updateProjectGalleryScroll(layer));
    }
    if (camera?.level?.() > 0) requestAnimationFrame(updatePlannerScrollEdges);
  }
  function mount() {
    if (root) return root;
    if (typeof window.createFractalCamera !== "function") return null;
    camera = window.createFractalCamera({
      apiName:"crmProjectsCamera", theater:"planner", surfaceClass:"crm-planner-surface", layerClass:"crm-planner-level",
      warmClass:"crm-planner-warm", contractingClass:"crm-planner-contracting", active:false, maxLevel:1, margin:0,
      morphMs:460, expandFadeMs:90, belowFadeMs:90, contractFadeMs:110,
      keepBelowVisibleDuringTransition:true, precomposeTransitions:true, lockInputDuringTransitions:true,
      contractExpanderAbove:true, holdContractEndpointFrame:true, keepExpanderOpaqueDuringTransition:true,
      measureTop:() => 0, ensureStyles, buildRoot:buildProjectGallery, layout:layoutProjects,
      prepareTarget:(target, context) => {
        const project = projectById(target?.dataset?.plannerProject); if (!project) return;
        markProjectCameraTarget(target, context);
        selectedId = project.id; writeSelected(); announce("project-opened");
      },
      prepareJump:(_expander, target, context) => markProjectCameraTarget(target, context),
      buildExpander:(target) => buildProjectWorld(projectById(target?.dataset?.plannerProject)),
      targetFromEvent:(event, context) => {
        if (context.level !== 0 || event.target?.closest?.("[data-planner-action]")) return null;
        const tile = event.target?.closest?.(".crm-project-bucket[data-planner-project]");
        return tile && context.layers[0]?.contains(tile) ? tile : null;
      },
      targetAtPoint:(x, y, context) => {
        if (context.level !== 0) return null;
        return [...(context.layers[0]?.querySelectorAll?.(".crm-project-bucket[data-planner-project]") || [])].find((tile) => {
          const bounds = tile.getBoundingClientRect(); return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
        }) || null;
      },
      sourceSelector:(target) => `.crm-project-bucket[data-planner-project="${cssValue(target?.dataset?.plannerProject)}"]`,
      keyOf:(target) => String(target?.dataset?.plannerProject || ""),
      onTransitionStart:(direction, context) => {
        context.surface?.classList.add("crm-project-camera-moving");
        context.surface?.classList.toggle("crm-project-camera-expanding", direction === "expand");
        context.surface?.classList.toggle("crm-project-camera-contracting", direction === "contract");
        if (direction === "contract") coverProjectWorld(context.layers[1], selectedProject());
      },
      onTransformStart:(direction, context) => {
        context.surface?.classList.toggle("crm-project-acrylic-expanding", direction === "expand");
        context.surface?.classList.toggle("crm-project-acrylic-contracting", direction === "contract");
      },
      onTransitionEnd:(direction, context) => {
        context.surface?.classList.remove("crm-project-camera-moving", "crm-project-camera-expanding", "crm-project-camera-contracting", "crm-project-acrylic-expanding", "crm-project-acrylic-contracting");
        if (direction === "expand") {
          revealProjectWorld(context.layers[1]);
          const project = selectedProject(); if (project) wirePlannerScroller(project.id, context.layers[1]);
          window.crmObjectSizing?.scan?.(context.layers[1]);
        }
        if (direction === "contract") { clearProjectCameraTarget(context); closeFloating(); }
      },
      onRootBack:() => window.crmDeskTransit?.driveTo?.("home"),
    });
    camera.init(); root = camera.surface(); wire();
    subscribeProjectPreviews();
    if (!projectEnvironmentObserver) {
      projectEnvironmentObserver = new MutationObserver(() => scheduleProjectPreviews());
      projectEnvironmentObserver.observe(document.documentElement, { attributes:true, attributeFilter:["data-background"] });
    }
    try { window.crmStore?.onChanged?.(schedule); } catch {} try { window.crmDomain?.onChanged?.(schedule); } catch {}
    refresh(); return root;
  }
  const resetToGallery = () => {
    if (!camera || camera.level() === 0) return;
    if (camera.isTransitioning()) camera.whenSettled().then(() => { if (!active) camera.rebuildRoot(); });
    else camera.rebuildRoot();
  };
  const setActive = (on) => {
    active = !!on; mount(); camera?.setActive?.(active);
    if (active && dirty) refresh();
    if (!active) { closeFloating(); resetToGallery(); }
    return api;
  };
  const baseline = async () => {
    mount(); if (dirty || !model.projects.length) await refresh();
    if (!active && camera?.level?.() > 0) camera.rebuildRoot(); else render();
    camera?.setActive?.(active); return root;
  };
  const homePreviewState = () => {
    const scroller = root?.querySelector(".crm-planner-buckets");
    if (scroller?.dataset.plannerScrollProject) plannerScrollPositions.set(scroller.dataset.plannerScrollProject, scroller.scrollLeft);
    const gallery = camera?.layers?.()[0]?.querySelector?.(".crm-project-gallery-scroll");
    if (gallery) galleryScrollLeft = gallery.scrollLeft;
    return {
      view:"projects",
      selectedId,
      expandedStages:[...expandedStacks],
      scrollPositions:Object.fromEntries(plannerScrollPositions),
      galleryScrollLeft,
    };
  };
  const applyHomePreviewState = async (state = {}) => {
    mount();
    if (dirty || !model.projects.length) await refresh();
    if (projectById(state.selectedId)) selectedId = String(state.selectedId);
    if (Array.isArray(state.expandedStages)) expandedStacks = new Set(state.expandedStages.map(String));
    if (state.scrollPositions && typeof state.scrollPositions === "object") {
      Object.entries(state.scrollPositions).forEach(([projectId, value]) => {
        const position = Number(value); if (Number.isFinite(position)) plannerScrollPositions.set(String(projectId), Math.max(0, position));
      });
    }
    const requestedGalleryLeft = Number(state.galleryScrollLeft ?? state.galleryScrollTop);
    if (Number.isFinite(requestedGalleryLeft)) galleryScrollLeft = Math.max(0, requestedGalleryLeft);
    camera?.rebuildRoot?.();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const gallery = camera?.layers?.()[0]?.querySelector?.(".crm-project-gallery-scroll");
    if (gallery) { gallery.scrollLeft = Math.min(galleryScrollLeft, Math.max(0, gallery.scrollWidth - gallery.clientWidth)); updateProjectGalleryScroll(camera?.layers?.()[0]); }
    if (state.view === "project" && projectById(selectedId)) {
      const tile = camera?.layers?.()[0]?.querySelector?.(`.crm-project-bucket[data-planner-project="${cssValue(selectedId)}"]`);
      if (tile) {
        camera.jumpTo(tile); await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        settleProjectWorld(camera.layers()[1]);
        window.crmObjectSizing?.scan?.(camera.layers()[1]); wirePlannerScroller(selectedId, camera.layers()[1]);
      }
    }
    return homePreviewState();
  };
  async function miniature() {
    await baseline(); const copy = buildProjectGallery();
    copy.classList.add("crm-planner-surface"); copy.removeAttribute("data-crm-theater");
    Object.assign(copy.style, { position:"absolute", left:"50%", top:"50%", width:"1280px", height:"860px", transform:"translate(-50%,-50%) scale(.285)", transformOrigin:"center", pointerEvents:"none" });
    return copy;
  }
  async function openItem(itemId) {
    if (dirty || !itemById(itemId)) await refresh(); const item = itemById(itemId); if (!item) return false;
    await (window.crmDeskTransit?.driveTo?.("planner") || Promise.resolve(window.crmWorkspaces?.setActive?.("planner")));
    if (!(await openProject(item.projectId))) return false;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const card = camera?.layers?.()[1]?.querySelector?.(`[data-planner-card="${cssValue(item.id)}"]`);
    card?.scrollIntoView?.({ block:"nearest", inline:"nearest" }); if (card) openPlannerItem(item, card);
    return !!card;
  }
  const api = { setActive, baseline, miniature, refresh, isActive:() => active, selected:() => selectedId, selectProject, openProject, level:() => camera?.level?.() || 0, view:() => camera?.level?.() ? "project" : "projects", back:() => camera?.back?.(), projects:projectsSnapshot, pipelines:projectsSnapshot, items:() => clone(model.items), createProject, createPipeline:createProject, updateProject, createStage, createBucket, createCard, updateItem, moveCard, deleteItem, openItem, setStageExpanded, expandedStages:() => [...expandedStacks], projectPreviewSignature:(projectId) => projectPreviewSignature(projectById(projectId)), projectPreviewStatus:() => model.projects.map((project) => ({ id:project.id, ready:isProjectPreviewCurrent(projectPreviews.get(project.id), project), capturedAt:projectPreviews.get(project.id)?.capturedAt || 0 })), refreshProjectPreview:(projectId) => requestProjectPreview(projectById(projectId), true), homePreviewState, applyHomePreviewState, detail:() => ensurePlannerDetail(), onChanged:(listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
  document.addEventListener("crm:theater-switch", closeFloating); window.addEventListener("storage", (event) => { if (event.key === SELECTED_KEY) { selectedId = localStorage.getItem(SELECTED_KEY) || ""; render(); } });
  document.addEventListener("crm:object-size-change", (event) => { if (event.detail?.homeKey === "planner") scheduleProjectPreviews(selectedId); });
  window.addEventListener("resize", () => { camera?.layout?.(); scheduleProjectPreviews(); });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once:true }); else mount();
  window.crmPlanner = api;
  window.crmProjects = api;
})();
