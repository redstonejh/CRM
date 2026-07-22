// crm-home.js — four inert screenshot LODs hosted by the original camera.
(() => {
  if (typeof window.createFractalCamera !== "function") return;

  const MODULES = [
    { key: "people", label: "People" }, { key: "cases", label: "Tickets" },
    { key: "planner", label: "Projects" }, { key: "assignments", label: "Assignments" },
  ];
  const RETRY_MS = [0, 120, 320, 700, 1400, 2800, 5000];
  const HOME_PREVIEW_VERSION = "filtered-home-v44";
  const DAY_MS = 86400000;
  const HOME_HAND_WINDOW_DAYS = 7;
  const HAND_LIMIT = 7;
  const previews = new Map();
  const pendingPreviews = new Map();
  const previewSyncKeys = new Set();
  const previewSyncs = new Set();
  let camera = null;
  let subscribed = false;
  let retryTimer = 0;
  let retryAttempt = 0;
  let priorityItems = [];
  let priorityUsername = "";
  let handRefreshTimer = 0;
  let handRefreshGeneration = 0;
  let handDirty = true;
  let activeRefreshPending = false;
  let motionSnapshot = null;
  let pendingMotionSnapshot = null;
  let motionCommitTimer = 0;
  let motionSnapshotSettleTimer = 0;
  let factoryPrewarmHandle = 0;
  let factoryPrewarmTimer = 0;
  let factoryPrewarmRunning = false;
  let factoryPrewarmAttempts = 0;
  let factoryPrewarmAfter = 0;
  let handoffSequence = 0;
  let handoffPromise = Promise.resolve();
  let handoffResolve = null;
  let todoPopover = null;
  let todoOutsideClose = null;
  let previewCommitTimer = 0;
  let previewDecodeSequence = 0;
  let priorityTicketOpen = null;
  const prewarmedFactories = new Set();
  const TODO_LINK_ENTITIES = new Set(["tasks", "contacts", "tickets", "workItems"]);
  const recycledExpanders = new Map();
  const FACTORY_PREWARM_APIS = ["peopleCards", "ticketStacks", "crmPlanner", "crmAssignments"];
  const FACTORY_API_BY_MODULE = { people:"peopleCards", cases:"ticketStacks", planner:"crmPlanner", assignments:"crmAssignments" };

  const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[char]));
  const firstText = (...values) => values.map((value) => String(value ?? "").trim()).find(Boolean) || "";
  const startOfToday = () => { const date = new Date(); date.setHours(0, 0, 0, 0); return date.getTime(); };
  const dueTime = (item) => { const value = Date.parse(item?.dueAt || ""); return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY; };
  const dayKey = (value) => {
    const raw = String(value || ""); const prefix = /^\d{4}-\d{2}-\d{2}/.exec(raw)?.[0] || "";
    if (!prefix || !raw.includes("T") || /T00:00:00(?:\.000)?Z$/i.test(raw)) return prefix;
    const date = new Date(raw); return Number.isFinite(date.getTime()) ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` : prefix;
  };
  const dayNumber = (key) => { const [year, month, day] = String(key).split("-").map(Number); return year && month && day ? Date.UTC(year, month - 1, day) / DAY_MS : Number.POSITIVE_INFINITY; };
  const todayKey = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
  const plateDayOffset = (item) => dayNumber(dayKey(item?.dueAt)) - dayNumber(todayKey());
  const isOnHomePlate = (item) => Number.isFinite(plateDayOffset(item)) && plateDayOffset(item) <= HOME_HAND_WINDOW_DAYS;
  const isDone = (item) => ["completed", "cancelled", "canceled"].includes(String(item?.status || "").toLowerCase());

  const ensureStyles = () => {
    if (document.getElementById("crm-home-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-home-styles";
    style.textContent = `
      .crm-home-surface{position:fixed;inset:0;z-index:820;pointer-events:none;overflow:hidden}
      .crm-home-surface[hidden]{display:none}.crm-home-level{position:absolute;inset:0;transform-origin:0 0}
      .crm-home-motion-snapshot.crm-home-preview-image,
      .crm-home-motion-variant.crm-home-preview-image{display:none;position:absolute;inset:0;z-index:2;width:100%;height:100%;object-fit:fill;
        pointer-events:none;user-select:none;backface-visibility:hidden}
      .crm-home-surface.crm-home-camera-moving .crm-home-level{isolation:isolate;contain:paint;will-change:transform,opacity;backface-visibility:hidden}
      .crm-home-surface.crm-home-camera-moving .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-motion-variant.is-active-motion-variant{display:block}
      /* At the contract endpoint the full Home object raster remains above the
         live root. Glass, previews, hand and shadows rejoin behind it, then the
         two composited layers crossfade without a materialization frame. */
      .crm-home-surface.crm-home-camera-handoff .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-motion-snapshot{
        display:block;z-index:30;opacity:.999;transform:translateZ(0);will-change:opacity;transition:opacity 112ms linear}
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-releasing .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-motion-snapshot{
        opacity:0}
      .crm-home-surface.crm-home-camera-handoff .crm-home-level>.crm-home-grid>.crm-home-bucket,
      .crm-home-surface.crm-home-camera-handoff .crm-home-level>.crm-home-priority-hand{
        opacity:.001;transition:opacity 112ms linear!important}
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-releasing .crm-home-level>.crm-home-grid>.crm-home-bucket,
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-releasing .crm-home-level>.crm-home-priority-hand{opacity:1}
      .crm-home-surface.crm-home-camera-handoff .crm-home-level>.crm-home-title-layer{z-index:31}
      /* Removing .crm-home-camera-moving restores each complete live tile under
         the endpoint raster. Only the compositor opacity is allowed to animate
         while its material is re-established. */
      .crm-home-surface.crm-home-camera-handoff .crm-home-grid>.crm-home-bucket,
      .crm-home-surface.crm-home-camera-handoff .crm-home-priority-hand>.crm-home-hand-card{
        animation:none!important}
      .crm-home-surface.crm-home-camera-moving .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-priority-hand{visibility:hidden}
      /* The expander owns the selected room during travel. One precomposed
         variant carries every other Home object with the selected tile cut
         transparent; the full Home raster is reserved for the endpoint. */
      .crm-home-surface.crm-home-camera-moving .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-grid>.crm-home-bucket:not(.is-camera-target)>.crm-home-preview{
        visibility:hidden}
      /* The real selected tile and the full-size lid trade opacity while their
         geometry is identical. Its acrylic, preview and shadow therefore have
         one continuous owner instead of disappearing and being rebuilt. */
      .crm-home-surface[data-level="1"] .crm-home-level:first-child>.crm-home-grid>.crm-home-bucket.is-camera-target{opacity:0}
      .crm-home-surface.crm-home-camera-expanding .crm-home-level:first-child>.crm-home-grid>.crm-home-bucket.is-camera-target{
        opacity:0;transition:opacity 70ms ease!important}
      .crm-home-surface.crm-home-camera-contracting .crm-home-level:first-child>.crm-home-grid>.crm-home-bucket.is-camera-target{
        opacity:1;transition:opacity 70ms ease 390ms!important}
      .crm-home-grid{position:absolute;z-index:1;display:grid;pointer-events:auto;will-change:transform;contain:layout style;
        grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:var(--crm-object-gap,18px)}
      .crm-home-title-layer{position:absolute;z-index:4;display:grid;pointer-events:none;contain:layout style;
        grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:var(--crm-object-gap,18px)}
      .crm-home-title-slot{position:relative;min-width:0;min-height:0}
      .crm-home-bucket{position:relative;box-sizing:border-box;display:block;min-height:0;overflow:hidden;color:#fff;
        cursor:pointer;border:0;container-type:size;border-radius:var(--home-r,16px);padding:0;will-change:transform,backdrop-filter;
        background:linear-gradient(180deg,rgba(22,26,36,.34),rgba(12,16,24,.28));
        -webkit-backdrop-filter:blur(28px) saturate(140%);backdrop-filter:blur(28px) saturate(140%);
        box-shadow:inset 0 0 0 1px rgba(255,255,255,.14),inset 0 1px 0 rgba(255,255,255,.18),0 14px 26px -16px rgba(0,0,0,.72);
        transition:box-shadow .18s ease,background .18s ease}
      /* Home consumes the canonical glass material, but its four adjacent
         surfaces cannot also consume the menu's large floating shadow. That
         shadow overlaps into a single clipped rectangle around the grid. */
      .crm-home-bucket.crm-menu-surface{box-shadow:inset 0 1px 0 var(--crm-menu-highlight),0 14px 26px -16px rgba(0,0,0,.72)!important}
      .crm-home-bucket:hover{background:linear-gradient(180deg,rgba(40,55,76,.27),rgba(18,26,38,.23));
        box-shadow:inset 0 0 0 1px rgba(166,196,236,.27),inset 0 1px rgba(255,255,255,.15),0 14px 26px -16px rgba(0,0,0,.72)}
      .crm-home-title-glass{position:absolute;z-index:4;left:17px;bottom:16px;max-width:calc(100% - 34px);
        padding:0;text-align:left;pointer-events:none;opacity:.94;background:none;border:0;box-shadow:none;
        transition:opacity .16s ease;display:block}
      .crm-home-title{font:600 var(--crm-type-tile,15px)/1.2 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;letter-spacing:.008em;
        max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(246,249,253,.91);
        text-rendering:geometricPrecision;font-synthesis:none;text-shadow:0 1px 1px rgba(0,0,0,.86)}
      .crm-home-title-slot.is-deemphasized .crm-home-title-glass{opacity:.28}
      .crm-home-preview{position:absolute;inset:0;z-index:1;overflow:hidden;contain:paint;border-radius:inherit;color:rgba(255,255,255,.62)}
      .crm-home-preview-state{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;gap:9px;
        pointer-events:none;opacity:1;visibility:visible;transition:opacity .18s ease,visibility 0s linear 0s;
        font:600 10px/1 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;letter-spacing:.075em;text-transform:uppercase;
        color:rgba(225,234,246,.6)}
      .crm-home-preview-state-mark{position:relative;width:14px;height:14px;border:1px solid rgba(224,235,249,.26);border-radius:50%}
      .crm-home-preview-state-mark::after{content:"";position:absolute;inset:-1px;border:1px solid transparent;border-top-color:rgba(229,239,252,.68);
        border-radius:inherit;animation:crm-home-preview-turn 1.05s linear infinite}
      .crm-home-preview[data-preview-state="ready"]>.crm-home-preview-state,
      .crm-home-preview[data-preview-state="stale"]>.crm-home-preview-state{opacity:0;visibility:hidden;transition:opacity .18s ease,visibility 0s linear .18s}
      @keyframes crm-home-preview-turn{to{transform:rotate(1turn)}}
      .crm-home-preview-image{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:cover;pointer-events:none;
        z-index:1;user-select:none;transform:translateY(var(--far-shift-y,0%));transform-origin:center;backface-visibility:hidden}
      /* Each tile is one inert raster. A small GPU filter provides the resting
         depth cue and is the only visual property released on hover. */
      .crm-home-preview-foreground{filter:blur(1.8px) saturate(.9) brightness(.82);transition:filter .18s ease}
      .crm-home-bucket:is(.is-preview-hovered,:focus-visible) .crm-home-preview-foreground{filter:blur(0) saturate(.96) brightness(.9)}
      /* These are the card system's real .tk-card objects. Home contributes
         only the held-hand geometry and compositor-friendly reveal motion. */
      .crm-home-priority-hand{position:absolute;z-index:9;left:0;right:0;bottom:0;height:var(--home-hand-reserve,280px);
        overflow:visible;pointer-events:none;contain:layout style}
      .crm-home-priority-hand[hidden]{display:none}
      .crm-home-todo-popover{position:fixed;z-index:9360;width:min(340px,calc(100vw - 28px));padding:10px;display:grid;gap:8px}
      .crm-home-todo-fields{display:grid;grid-template-columns:minmax(0,1fr) 112px;gap:7px}.crm-home-todo-fields>.crm-menu-input:first-child{grid-column:1/-1}
      .crm-home-todo-actions{display:flex;justify-content:flex-end;gap:2px;padding-top:1px}
      .crm-home-todo-popover .crm-menu-action{height:32px;font-size:var(--crm-type-body,12px)!important}
      .crm-home-todo-menu{position:fixed;z-index:9365;width:166px;padding:6px;display:grid;gap:1px}.crm-home-todo-menu .crm-menu-action{height:33px;text-align:left;font-size:var(--crm-type-body,12px)!important}
      .crm-home-hand-trigger{position:absolute;z-index:1;left:50%;bottom:0;width:var(--home-hand-span,760px);height:92px;
        transform:translateX(-50%);pointer-events:auto}
      .crm-home-priority-hand>.crm-home-hand-card.tk-card{position:absolute;left:50%;right:auto;bottom:52px;z-index:var(--hand-z,10);
        pointer-events:auto;cursor:pointer;
        transform-origin:50% 108%;transform:translateX(calc(-50% + var(--hand-x,0px))) translateY(var(--hand-rest-y,180px)) rotate(var(--hand-rot,0deg));
        transition:transform .38s cubic-bezier(.22,1,.26,1),box-shadow .18s ease}
      .crm-home-priority-hand.is-seating>.crm-home-hand-card.tk-card{transition:none}
      .crm-home-priority-hand:is(:hover,:focus-within)>.crm-home-hand-card.tk-card{
        transform:translateX(calc(-50% + var(--hand-x,0px))) translateY(var(--hand-open-y,0px)) rotate(var(--hand-open-rot,var(--hand-rot,0deg))) scale(.9)}
      .crm-home-priority-hand:is(:hover,:focus-within)>.crm-home-hand-card.tk-card:is(:hover,:focus-visible){z-index:1000;
        transform:translateX(calc(-50% + var(--hand-x,0px))) translateY(calc(var(--hand-open-y,0px) - 6px)) rotate(var(--hand-open-rot,var(--hand-rot,0deg))) scale(.92);
        box-shadow:inset 0 0 0 9999px rgba(255,255,255,.12),inset 0 1px rgba(255,255,255,.34),0 22px 48px rgba(0,0,0,.44)}
      .crm-home-hand-empty{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);font-size:9px;letter-spacing:.1em;
        text-transform:uppercase;color:rgba(218,228,242,.25);white-space:nowrap}
      @media(prefers-reduced-motion:reduce){
        .crm-home-priority-hand>.crm-home-hand-card.tk-card,
        .crm-home-title-glass{transition-duration:.01ms}
        .crm-home-preview-state-mark::after{animation:none}
      }
      /* The transition lid is full-viewport. It must stay neutral in Electron's
         native app-region map or its temporary rectangle can cancel (and on
         Windows, outlive) the persistent title-bar drag strip. */
      .crm-home-bucket.crm-home-expander{position:absolute;z-index:5;pointer-events:none;transform-origin:0 0;
        overflow:visible;border:0!important;background:transparent!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;box-shadow:none!important;
        will-change:transform,opacity;backface-visibility:hidden}
      .crm-home-transition-acrylic{position:absolute;inset:0;z-index:0;box-sizing:border-box;pointer-events:none;
        border-radius:var(--fractal-source-radius-x,28px) / var(--fractal-source-radius-y,28px);background:var(--crm-menu-background,linear-gradient(180deg,rgba(22,26,36,.62),rgba(12,16,24,.55)));
        -webkit-backdrop-filter:none;backdrop-filter:none;
        transform:translateZ(0)}
      .crm-home-transition-acrylic:after{content:"";position:absolute;inset:0;border:1px solid var(--crm-menu-border,rgba(255,255,255,.22));
        border-radius:inherit;box-shadow:inset 0 1px 0 var(--crm-menu-highlight,rgba(255,255,255,.24)),0 14px 26px -16px rgba(0,0,0,.72);
        opacity:0;transition:opacity var(--fractal-camera-morph-ms,460ms) var(--fractal-camera-ease,cubic-bezier(.22,1,.26,1))}
      .crm-home-expander[data-fractal-frame="source"]>.crm-home-transition-acrylic:after{opacity:1}
      .crm-home-surface.crm-home-camera-expanding .crm-home-title-glass{visibility:hidden;opacity:0!important;transition:none!important}
      /* Freeze only the four resting tiles. The expander is also a
         .crm-home-bucket; matching it here disabled the actual zoom. */
      .crm-home-surface.crm-home-camera-moving .crm-home-grid>.crm-home-bucket:not(.is-camera-target){transition:none!important;border-color:transparent!important;background:transparent!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;box-shadow:none!important}
      .crm-home-surface.crm-home-camera-moving .crm-home-grid>.crm-home-bucket.is-camera-target{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
      .crm-home-surface.crm-home-camera-moving .crm-home-grid{z-index:3}
      .crm-home-expander .crm-home-title-glass{display:none}
      .crm-home-expander .crm-home-preview{opacity:1;border-radius:0;box-shadow:none}
      .crm-home-expander .crm-home-preview-foreground{filter:none;transform:none;opacity:1;transition:none}
      /* The warm expander itself is already at .001 opacity. Keep its one
         transparent room texture composited so the first camera frame never
         performs a wallpaper-sized upload. */
      .crm-home-warm .crm-home-preview-foreground{opacity:1!important;transform:translateZ(0);will-change:transform,opacity}
      .crm-home-surface.crm-home-motion-priming .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-motion-snapshot{
        display:block;opacity:.001;transform:translateZ(0)}
      .crm-home-surface.crm-home-motion-priming .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-motion-variant{
        display:block;opacity:.001;transform:translateZ(0)}
      .crm-home-warm,.crm-home-warm *{pointer-events:none!important}
    `;
    document.head.appendChild(style);
  };

  const previewStateHTML = () => `<div class="crm-home-preview-state" role="status" aria-live="polite">
    <i class="crm-home-preview-state-mark" aria-hidden="true"></i><span>Preparing view</span></div>`;
  const bucketHTML = (module) => `<div class="crm-home-preview" data-preview-key="${esc(module.key)}" data-preview-state="waiting" aria-label="Loading preview">${previewStateHTML()}</div>`;
  const titleHTML = (module) => `<div class="crm-home-title-slot" data-module="${esc(module.key)}">
    <div class="crm-home-title-glass"><div class="crm-home-title">${esc(module.label)}</div></div></div>`;

  const farShift = (preview) => {
    const bounds = preview?.foregroundBounds;
    if (!bounds || !preview.height) return 0;
    const contentCenter = bounds.y + bounds.height / 2;
    return Math.max(-6, Math.min(6, (preview.height / 2 - contentCenter) / preview.height * 100));
  };
  const imageNode = (className, src, decoding = "async") => {
    const image = document.createElement("img");
    image.className = `crm-home-preview-image ${className}`;
    image.decoding = decoding;
    if (src) image.src = src;
    image.alt = ""; image.draggable = false;
    return image;
  };
  const ensurePreviewState = (host) => {
    if (!host || host.querySelector(":scope > .crm-home-preview-state")) return;
    host.insertAdjacentHTML("afterbegin", previewStateHTML());
  };
  const isRenderablePreview = (preview) => !!preview?.foregroundSrc && !!preview?.exactSrc
    && MODULES.some(({ key }) => key === preview.key);
  const isCurrentPreview = (preview) => preview?.version === HOME_PREVIEW_VERSION;
  const mountHost = (host, preview, exact = false, exactOnly = false) => {
    if (!host || !isRenderablePreview(preview)) return false;
    ensurePreviewState(host);
    host.style.setProperty("--far-shift-y", `${farShift(preview).toFixed(3)}%`);
    let foreground = host.querySelector(":scope > .crm-home-preview-foreground");
    if (exactOnly) {
      foreground?.remove();
      foreground = null;
    } else if (!foreground) {
      foreground = imageNode("crm-home-preview-foreground", preview.foregroundSrc);
      host.appendChild(foreground);
    } else {
      if (foreground.src !== preview.foregroundSrc) foreground.src = preview.foregroundSrc;
    }
    if (foreground) {
      foreground.dataset.previewVariant = "filtered";
      host.querySelector(":scope > .crm-home-preview-sharp")?.remove();
    }
    if (exact) {
      let full = host.querySelector(":scope > .crm-home-preview-exact");
      if (!full) { full = imageNode("crm-home-preview-exact", preview.exactSrc, "sync"); host.appendChild(full); }
      else if (full.src !== preview.exactSrc) full.src = preview.exactSrc;
    }
    host.dataset.previewState = isCurrentPreview(preview) ? "ready" : "stale";
    host.dataset.previewVersion = preview.version;
    host.dataset.capturedAt = String(preview.capturedAt || 0);
    host.dataset.previewWidth = String(preview.width || 0);
    host.dataset.previewHeight = String(preview.height || 0);
    host.closest(".crm-home-bucket")?.setAttribute("data-preview-ready", "true");
    return true;
  };
  const mountPreview = (key) => {
    const host = camera?.layers?.()[0]?.querySelector(`.crm-home-bucket[data-module="${key}"] .crm-home-preview`);
    return mountHost(host, previews.get(key), false);
  };
  const mountAll = () => MODULES.forEach(({ key }) => mountPreview(key));
  const revealSharpPreview = (bucket) => {
    if (!bucket) return;
    bucket.classList.add("is-preview-hovered");
    bucket.closest(".crm-home-level")?.querySelector(`:scope > .crm-home-title-layer > .crm-home-title-slot[data-module="${bucket.dataset.module}"]`)?.classList.add("is-deemphasized");
  };
  const restSharpPreview = (bucket) => {
    if (!bucket || bucket.matches(":focus-visible")) return;
    bucket.classList.remove("is-preview-hovered");
    bucket.closest(".crm-home-level")?.querySelector(`:scope > .crm-home-title-layer > .crm-home-title-slot[data-module="${bucket.dataset.module}"]`)?.classList.remove("is-deemphasized");
  };
  const previewCommitBlocked = () => !!camera?.isTransitioning?.()
    || !!camera?.surface?.()?.classList.contains("crm-home-camera-moving")
    || !!camera?.surface?.()?.classList.contains("crm-home-camera-handoff");
  const preloadSource = (src) => new Promise((resolve) => {
    const image = new Image(); let settled = false;
    const finish = () => { if (settled) return; settled = true; resolve(); };
    image.onload = finish; image.onerror = finish; image.src = src;
    image.decode?.().then(finish).catch(() => {});
  });
  const commitPreview = (preview) => {
    const existing = previews.get(preview.key);
    const existingAspect = Number(existing?.width) > 0 && Number(existing?.height) > 0 ? existing.width / existing.height : 0;
    const nextAspect = Number(preview.width) > 0 && Number(preview.height) > 0 ? preview.width / preview.height : 0;
    previews.set(preview.key, preview);
    if (camera?.isActive?.() && camera.level() === 0) {
      mountPreview(preview.key);
      if (nextAspect && Math.abs(nextAspect - existingAspect) > .0005 && !camera.isTransitioning?.()) {
        camera.layout();
        requestAnimationFrame(() => syncMotionSnapshot());
      }
    }
    return true;
  };
  const flushPendingPreviews = () => {
    clearTimeout(previewCommitTimer); previewCommitTimer = 0;
    if (previewCommitBlocked()) {
      previewCommitTimer = setTimeout(flushPendingPreviews, 48);
      return;
    }
    pendingPreviews.forEach((entry, key) => {
      if (!entry.ready) return;
      pendingPreviews.delete(key);
      commitPreview(entry.preview);
    });
  };
  const acceptPreview = (preview, replaceCurrent = false) => {
    if (!isRenderablePreview(preview)) return false;
    const existing = previews.get(preview.key);
    const pending = pendingPreviews.get(preview.key)?.preview;
    const newest = pending && Number(pending.capturedAt || 0) >= Number(existing?.capturedAt || 0) ? pending : existing;
    // Renderer-only reloads can briefly straddle Electron host versions. Keep a
    // current image when one exists, but render an older valid image instead of
    // turning the tile into an empty rectangle while the host catches up.
    if (!replaceCurrent && isCurrentPreview(newest) && !isCurrentPreview(preview)) return true;
    if (newest?.version === preview.version && newest?.capturedAt === preview.capturedAt
      && newest?.foregroundSrc === preview.foregroundSrc && newest?.exactSrc === preview.exactSrc) return true;
    if (!pending && existing?.foregroundSrc === preview.foregroundSrc && existing?.exactSrc === preview.exactSrc) {
      return commitPreview(preview);
    }
    const sequence = ++previewDecodeSequence;
    const entry = { preview, sequence, ready:false };
    pendingPreviews.set(preview.key, entry);
    Promise.all([preloadSource(preview.foregroundSrc), preloadSource(preview.exactSrc)]).then(() => {
      if (pendingPreviews.get(preview.key)?.sequence !== sequence) return;
      entry.ready = true;
      flushPendingPreviews();
    });
    return true;
  };
  const motionLayoutSignature = (root = camera?.layers?.()[0]) => {
    if (!root) return "";
    const rectOf = (node) => {
      if (!node) return [];
      return [node.offsetLeft, node.offsetTop, node.offsetWidth, node.offsetHeight];
    };
    const grid = root.querySelector(":scope > .crm-home-grid");
    const hand = root.querySelector(":scope > .crm-home-priority-hand");
    return JSON.stringify({
      viewport: [innerWidth, innerHeight, devicePixelRatio],
      grid: rectOf(grid),
      buckets: [...(grid?.querySelectorAll(":scope > .crm-home-bucket") || [])].map((bucket) => [bucket.dataset.module, ...rectOf(bucket)]),
      hand: rectOf(hand),
      cards: [...(hand?.querySelectorAll(":scope > .crm-home-hand-card") || [])].map((card) => [
        card.dataset.priorityId || "", ...rectOf(card), getComputedStyle(card).transform,
      ]),
    });
  };
  const selectMotionVariant = (root, key = "") => {
    if (!root) return false;
    let selected = false;
    root.querySelectorAll(":scope > .crm-home-motion-variant").forEach((image) => {
      const active = !!key && image.dataset.motionVariant === key;
      image.classList.toggle("is-active-motion-variant", active);
      selected ||= active;
    });
    root.dataset.motionVariant = selected ? key : "";
    return selected;
  };
  const syncMotionSnapshot = (root = camera?.layers?.()[0]) => {
    if (!root) return;
    let image = root.querySelector(":scope > .crm-home-motion-snapshot");
    if (!image) {
      image = imageNode("crm-home-motion-snapshot", "");
      root.prepend(image);
    }
    const signatureMatches = () => !!motionSnapshot?.layoutSignature
      && motionSnapshot.layoutSignature === motionLayoutSignature(root);
    const variants = Object.entries(motionSnapshot?.variants || {}).filter(([key, src]) => MODULES.some((module) => module.key === key) && !!src);
    if (!motionSnapshot?.src || variants.length !== MODULES.length || !signatureMatches()) {
      root.dataset.motionSnapshotReady = "false";
      return;
    }
    const stamp = String(motionSnapshot.capturedAt || "");
    if (image.dataset.motionCapturedAt !== stamp) {
      image.dataset.motionCapturedAt = stamp;
      image.src = motionSnapshot.src;
    }
    const expectedKeys = new Set(variants.map(([key]) => key));
    root.querySelectorAll(":scope > .crm-home-motion-variant").forEach((node) => {
      if (!expectedKeys.has(node.dataset.motionVariant || "")) node.remove();
    });
    const variantImages = variants.map(([key, src]) => {
      let variant = root.querySelector(`:scope > .crm-home-motion-variant[data-motion-variant="${key}"]`);
      if (!variant) {
        variant = imageNode("crm-home-motion-variant", "", "sync");
        variant.dataset.motionVariant = key;
        root.insertBefore(variant, image.nextSibling);
      }
      if (variant.dataset.motionCapturedAt !== stamp) {
        variant.dataset.motionCapturedAt = stamp;
        variant.src = src;
      }
      return variant;
    });
    const images = [image, ...variantImages];
    const ready = () => {
      if (String(motionSnapshot?.capturedAt || "") !== stamp || images.some((node) => !node.complete || node.naturalWidth <= 0) || !signatureMatches()) {
        root.dataset.motionSnapshotReady = "false";
        return;
      }
      root.dataset.motionSnapshotReady = "true";
      selectMotionVariant(root, root.querySelector(".crm-home-bucket.is-camera-target")?.dataset?.module || "");
      const surface = camera?.surface?.();
      if (surface && root.dataset.motionPrimedAt !== stamp && !surface.classList.contains("crm-home-motion-priming")) {
        root.dataset.motionPrimedAt = stamp;
        surface.classList.add("crm-home-motion-priming");
        requestAnimationFrame(() => requestAnimationFrame(() => surface.classList.remove("crm-home-motion-priming")));
      }
    };
    if (images.every((node) => node.complete && node.naturalWidth > 0)) ready();
    else {
      root.dataset.motionSnapshotReady = "false";
      Promise.all(images.map((node) => node.decode?.().catch(() => null) || Promise.resolve())).then(ready);
    }
  };
  const commitMotionSnapshot = (snapshot) => {
    if (!snapshot?.src || !snapshot?.layoutSignature) return false;
    if (motionSnapshot?.version === HOME_PREVIEW_VERSION && snapshot.version !== HOME_PREVIEW_VERSION) return true;
    motionSnapshot = snapshot;
    clearTimeout(motionSnapshotSettleTimer);
    const settle = (attempt = 0) => {
      const root = camera?.layers?.()[0];
      syncMotionSnapshot(root);
      if (root?.dataset?.motionSnapshotReady === "true" || attempt >= 10) return;
      // A resize can deliver the new raster in the same task that lays out the
      // hand. Recheck across the short seating window instead of permanently
      // rejecting an otherwise exact snapshot on that boundary frame.
      motionSnapshotSettleTimer = setTimeout(() => settle(attempt + 1), 48);
    };
    settle();
    return true;
  };
  const flushPendingMotionSnapshot = () => {
    clearTimeout(motionCommitTimer); motionCommitTimer = 0;
    if (!pendingMotionSnapshot) return;
    if (previewCommitBlocked()) {
      motionCommitTimer = setTimeout(flushPendingMotionSnapshot, 48);
      return;
    }
    const snapshot = pendingMotionSnapshot;
    pendingMotionSnapshot = null;
    commitMotionSnapshot(snapshot);
  };
  const acceptMotionSnapshot = (snapshot) => {
    if (!snapshot?.src || !snapshot?.layoutSignature) return false;
    if (previewCommitBlocked()) {
      if (!pendingMotionSnapshot || Number(snapshot.capturedAt || 0) >= Number(pendingMotionSnapshot.capturedAt || 0)) pendingMotionSnapshot = snapshot;
      if (!motionCommitTimer) motionCommitTimer = setTimeout(flushPendingMotionSnapshot, 48);
      return true;
    }
    return commitMotionSnapshot(snapshot);
  };
  const requestMotionSnapshot = async () => {
    try { acceptMotionSnapshot((await window.crmHomePreviews?.motionSnapshot?.())?.snapshot); } catch {}
  };
  const requestPreviews = async (reset = false) => {
    clearTimeout(retryTimer);
    if (reset) retryAttempt = 0;
    try { (await window.crmHomePreviews?.list?.())?.previews?.forEach(acceptPreview); } catch {}
    if (MODULES.every(({ key }) => isCurrentPreview(previews.get(key)))) return;
    retryTimer = setTimeout(() => requestPreviews(false), RETRY_MS[Math.min(retryAttempt++, RETRY_MS.length - 1)]);
  };
  const priorityWeight = (item) => ({ critical: 900, urgent: 800, high: 650, overdue: 620, medium: 180, normal: 0 }
    [String(item?.priority || "").toLowerCase()] || 0);
  const assignedTo = (item, username) => !!username && String(item?.assignee || "").trim().toLowerCase() === username;
  const priorityScore = (item, username) => {
    const days = plateDayOffset(item);
    let score = priorityWeight(item);
    if (assignedTo(item, username)) score += 1100;
    if (days < 0) score += 1600 + Math.min(500, Math.abs(days) * 24);
    else if (days < 1) score += 1350;
    else if (days < 2) score += 980;
    else if (days < 4) score += 700;
    else if (days <= 14) score += 420 - days * 12;
    if (/reply|respond|follow|call|invoice|bill|payment/.test(`${item?.kind || ""} ${item?.title || ""}`.toLowerCase())) score += 160;
    if (firstText(item?.assignedBy, item?.assigner)) score += 90;
    return score;
  };
  const choosePriorityItems = (records, username = "") => {
    const userKey = String(username || "").trim().toLowerCase();
    return records.filter((item) => {
      if (!item || item.deletedAt || isDone(item) || !priorityLink(item) || !isOnHomePlate(item)) return false;
      const assignee = String(item.assignee || "").trim().toLowerCase();
      if (userKey && assignee && assignee !== userKey) return false;
      return true;
    }).sort((a, b) => priorityScore(b, userKey) - priorityScore(a, userKey) || dueTime(a) - dueTime(b)).slice(0, HAND_LIMIT);
  };
  const priorityLink = (item) => {
    const links = Array.isArray(item?.links) ? item.links : [];
    const explicit = ["workItems", "tickets", "contacts", "tasks"]
      .map((entityType) => links.find((link) => link?.entityType === entityType && link?.recordId))
      .find(Boolean) || null;
    if (explicit) return explicit;
    if (item?.sourceEntity && item?.sourceId && TODO_LINK_ENTITIES.has(item.sourceEntity)) {
      return { entityType: item.sourceEntity, recordId: item.sourceId, relation: "source" };
    }
    return null;
  };
  const dueLabel = (item) => {
    const due = dueTime(item); if (!Number.isFinite(due)) return firstText(item.attentionLabel, item.assignee ? "Assigned" : "Up next");
    const day = plateDayOffset(item);
    if (day < 0) return `${Math.abs(day)}d overdue`;
    if (day === 0) {
      const raw = String(firstText(item.dueAt, item.dueDate, item.date) || "");
      const calendarDay = /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z)?$/i.test(raw);
      if (calendarDay) return "Today";
      const time = new Date(due);
      return time.getHours() || time.getMinutes() ? `Today · ${time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Today";
    }
    if (day === 1) return "Tomorrow";
    return new Date(due).toLocaleDateString([], { month: "short", day: "numeric" });
  };
  const contextLabel = (item, username = "") => {
    if (item.context) return item.context;
    const assignedBy = firstText(item.assignedBy, item.assigner);
    if (assignedBy) return `Assigned by ${assignedBy}`;
    if (assignedTo(item, String(username).toLowerCase())) return "Assigned to you";
    if (item.assignee) return `Assigned to ${item.assignee}`;
    const link = priorityLink(item);
    if (link?.entityType === "workItems") return firstText(item.projectTitle, item.stageLabel, "Pipeline card");
    if (link?.entityType === "contacts") return "Person follow-up";
    if (link?.entityType === "tickets") return "Ticket work";
    if (link?.entityType === "tasks") return "Task";
    return "Personal task";
  };
  const cardReasonOf = (item) => {
    const linkType = priorityLink(item)?.entityType;
    if (linkType === "workItems") return "pipeline-work";
    if (linkType === "tickets") return "ticket-work";
    if (linkType === "contacts") return "person-work";
    if (linkType === "tasks") return "task-work";
    if (item.todayReason) return item.todayReason;
    const text = `${item.kind || ""} ${item.title || ""}`.toLowerCase();
    if (/invoice|bill|payment/.test(text)) return dueTime(item) < startOfToday() ? "invoice-overdue" : "invoice-due";
    if (/reply|respond/.test(text)) return "next-touch";
    if (/follow|reach out|call/.test(text)) return "contact-touch";
    return "task";
  };
  const cardPriorityOf = (item) => {
    const value = String(item.priority || "").toLowerCase();
    if (["critical", "urgent", "overdue"].includes(value)) return "critical";
    if (value === "high") return "high";
    if (["medium", "normal"].includes(value)) return "medium";
    return "none";
  };
  const cardRecordOf = (item, username = "") => {
    const link = priorityLink(item); const context = contextLabel(item, username); const reason = dueLabel(item);
    return {
      ...item,
      id: String(item.id || ""),
      title: firstText(item.title, "Important next action"),
      companyLabel: firstText(item.title, "Important next action"),
      host: context,
      description: context,
      priority: cardPriorityOf(item),
      targetEntity: link?.entityType || "",
      targetId: link?.recordId || "",
      todayReason: cardReasonOf(item),
      todayRow: { ...(item.todayRow || {}), dueDate: "", stageLabel: reason, assignee: item.assignee || "" },
    };
  };
  const prioritySignature = (item) => {
    const link = priorityLink(item);
    return [item.id, item.title, item.status, item.priority, item.dueAt, item.assignee, item.attentionLabel, item.context, link?.entityType || "", link?.recordId || ""];
  };
  const openPriorityTicket = (ticketId) => {
    if (priorityTicketOpen) return priorityTicketOpen;
    priorityTicketOpen = (async () => {
      const moved = window.crmWorkspaces?.active?.() === "cases"
        || await (window.crmDeskTransit?.driveTo?.("cases") || Promise.resolve(window.crmWorkspaces?.setActive?.("cases")));
      if (!moved && window.crmWorkspaces?.active?.() !== "cases") return false;
      // The Home card has left the viewport by this point. Let the ticket
      // subsystem choose and reveal its real stack/bucket card so the detail
      // animation has one stable source in the active Tickets world.
      await window.crmHome?.waitForModuleSettled?.("cases");
      return window.ticketStacks?.open?.(ticketId) || false;
    })().finally(() => { priorityTicketOpen = null; });
    return priorityTicketOpen;
  };
  const openPriorityItem = (item, sourceCard) => {
    const link = priorityLink(item);
    if (link?.entityType === "workItems" && link.recordId) window.crmPlanner?.openItem?.(link.recordId);
    else if (link?.entityType === "tickets" && link.recordId) openPriorityTicket(link.recordId);
    else if (link?.entityType && link?.recordId) window.crmRecordWorld?.open?.(link.entityType, link.recordId, sourceCard);
    else Promise.resolve(window.crmDeskTransit?.driveTo?.("assignments") || window.crmWorkspaces?.setActive?.("assignments"))
      .then(() => window.crmAssignments?.open?.(item.id));
  };
  const closeTodoPopover = () => {
    if (todoOutsideClose) document.removeEventListener("pointerdown", todoOutsideClose, true);
    todoOutsideClose = null; todoPopover?.remove(); todoPopover = null;
  };
  const placeTodoPopover = (element, anchor, x, y) => {
    document.body.appendChild(element);
    const anchorRect = anchor?.getBoundingClientRect(); const bounds = element.getBoundingClientRect();
    const left = Math.max(10, Math.min(innerWidth - bounds.width - 10, Number.isFinite(x) ? x : (anchorRect?.left || innerWidth / 2) - bounds.width / 2));
    const top = Math.max(48, Math.min(innerHeight - bounds.height - 12, Number.isFinite(y) ? y : (anchorRect?.top || innerHeight / 2) - bounds.height - 7));
    element.style.left = `${left}px`; element.style.top = `${top}px`;
  };
  const armTodoOutsideClose = (element) => setTimeout(() => {
    if (todoPopover !== element) return;
    todoOutsideClose = (event) => {
      if (element.contains(event.target)) return;
      closeTodoPopover();
    };
    document.addEventListener("pointerdown", todoOutsideClose, true);
  }, 0);
  const openTodoComposer = async (anchor, item = null) => {
    closeTodoPopover();
    // Home is a projection of linked work, never an authoring surface. The
    // relationship is owned by the source object and cannot be changed here.
    if (!item || !priorityLink(item)) return false;
    const dueValue = item?.dueAt && Number.isFinite(Date.parse(item.dueAt)) ? new Date(item.dueAt).toISOString().slice(0, 10) : "";
    const rawPriority = String(item?.priority || "normal").toLowerCase();
    const priorityValue = ["critical","overdue"].includes(rawPriority) ? "urgent" : ["urgent","high","normal"].includes(rawPriority) ? rawPriority : "normal";
    todoPopover = document.createElement("form"); todoPopover.className = "crm-home-todo-popover crm-menu-surface"; todoPopover.setAttribute("aria-label", "Edit linked task");
    todoPopover.innerHTML = `<div class="crm-home-todo-fields">
      <input class="crm-menu-input" name="title" value="${esc(item?.title || "")}" placeholder="What needs doing?" autocomplete="off" required>
      <input class="crm-menu-input" name="dueAt" type="date" value="${esc(dueValue)}" aria-label="Due date"><select class="crm-menu-input" name="priority" aria-label="Priority">${["normal","high","urgent"].map((value) => `<option value="${value}"${priorityValue === value ? " selected" : ""}>${value[0].toUpperCase() + value.slice(1)}</option>`).join("")}</select>
      </div><div class="crm-home-todo-actions"><button type="button" class="crm-menu-action" data-todo-cancel>Cancel</button><button type="submit" class="crm-menu-action">Save</button></div>`;
    todoPopover.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(todoPopover);
      const due = String(data.get("dueAt") || ""); const fields = { title:String(data.get("title") || "").trim(), dueAt:due ? new Date(`${due}T17:00:00`).toISOString() : null, priority:String(data.get("priority") || "normal") };
      const saved = await updateTodo(item, fields);
      if (saved) closeTodoPopover();
    });
    todoPopover.querySelector("[data-todo-cancel]")?.addEventListener("click", closeTodoPopover);
    placeTodoPopover(todoPopover, anchor); armTodoOutsideClose(todoPopover);
    requestAnimationFrame(() => todoPopover?.elements?.title?.focus());
  };
  const updateTodo = async (item, fields) => {
    if (!item?.id || String(item.id).startsWith("signal:")) return false;
    let result = await window.crmDomain?.update?.("commitments", item.id, fields, item.version);
    if (!result?.record) {
      const latest = (await window.crmDomain?.list?.("commitments", { includeDeleted:false, limit:300 }))?.records?.find((record) => String(record.id) === String(item.id));
      if (latest) result = await window.crmDomain?.update?.("commitments", item.id, fields, latest.version);
    }
    if (result?.record) { scheduleHandRefresh(); return true; }
    return false;
  };
  const openTodoMenu = (item, card, x, y) => {
    closeTodoPopover(); todoPopover = document.createElement("div"); todoPopover.className = "crm-home-todo-menu crm-menu-surface";
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(17, 0, 0, 0);
    const link = priorityLink(item);
    [
      { key:"open", label:"Open", run:() => openPriorityItem(item, card) },
      link?.entityType !== "workItems" && { key:"edit", label:"Edit", run:() => openTodoComposer(card, item) },
      { key:"tomorrow", label:"Due tomorrow", run:() => updateTodo(item, { dueAt:tomorrow.toISOString() }) },
      { key:"complete", label:"Complete", run:() => updateTodo(item, { status:"completed", completedAt:new Date().toISOString(), outcome:"Completed from Home" }) },
    ].filter(Boolean).forEach((action) => {
      const button = document.createElement("button"); button.type = "button"; button.className = "crm-menu-action"; button.textContent = action.label;
      button.dataset.todoAction = action.key;
      button.addEventListener("click", () => { closeTodoPopover(); action.run(); }); todoPopover.appendChild(button);
    });
    placeTodoPopover(todoPopover, card, x, y); armTodoOutsideClose(todoPopover);
  };
  const layoutPriorityHand = (hand = camera?.layers?.()[0]?.querySelector?.(".crm-home-priority-hand")) => {
    if (!hand) return; const cards = [...hand.querySelectorAll(".crm-home-hand-card.tk-card")];
    if (!cards.length) { hand.style.setProperty("--home-hand-span", "220px"); return; }
    const width = cards[0].offsetWidth || 185; const height = cards[0].offsetHeight || 279;
    const maxSpan = Math.min(innerWidth - 44, 760); const step = cards.length > 1 ? Math.min(width * .62, (maxSpan - width) / (cards.length - 1)) : 0;
    const middle = (cards.length - 1) / 2; const peek = 128; const baseBottom = 52; const openDrop = 33;
    cards.forEach((card, index) => {
      const distance = index - middle; const arc = Math.min(18, distance * distance * 2.35); const rotation = Math.max(-15, Math.min(15, distance * 4.2));
      card.style.setProperty("--hand-x", `${(distance * step).toFixed(2)}px`);
      card.style.setProperty("--hand-rot", `${rotation.toFixed(2)}deg`);
      card.style.setProperty("--hand-open-rot", `${(rotation * .72).toFixed(2)}deg`);
      card.style.setProperty("--hand-open-y", `${(openDrop + arc * .1).toFixed(2)}px`);
      card.style.setProperty("--hand-rest-y", `${(baseBottom + height - peek + arc).toFixed(2)}px`);
    });
    hand.style.setProperty("--home-hand-span", `${Math.min(innerWidth - 24, width + step * Math.max(0, cards.length - 1) + 64).toFixed(2)}px`);
  };
  const fillPriorityHand = (hand) => {
    if (!hand) return;
    const renderSignature = JSON.stringify(priorityItems.map(prioritySignature));
    hand.dataset.username = priorityUsername;
    hand.dataset.renderSignature = renderSignature;
    hand.classList.toggle("is-empty", priorityItems.length === 0);
    hand.replaceChildren();
    if (!priorityItems.length) {
      const empty = document.createElement("div"); empty.className = "crm-home-hand-empty"; empty.textContent = "Nothing due today"; hand.appendChild(empty); return;
    }
    const renderer = window.crmToday?.createCard;
    if (typeof renderer !== "function") {
      const empty = document.createElement("div"); empty.className = "crm-home-hand-empty"; empty.textContent = "Preparing priority cards"; hand.appendChild(empty); return;
    }
    const trigger = document.createElement("div"); trigger.className = "crm-home-hand-trigger"; trigger.setAttribute("aria-hidden", "true"); hand.appendChild(trigger);
    priorityItems.forEach((item, index) => {
      const link = priorityLink(item);
      const card = renderer(cardRecordOf(item, priorityUsername), {
        ariaLabel: `${firstText(item.title, "Important next action")}. ${dueLabel(item)}`,
        onOpen: (_record, sourceCard) => openPriorityItem(item, sourceCard),
      });
      card.classList.add("crm-home-hand-card");
      card.dataset.priorityId = String(item.id || "");
      if (link?.entityType) card.dataset.recordEntity = link.entityType;
      if (link?.recordId) card.dataset.recordId = link.recordId;
      card.dataset.commitmentId = String(item.id || "");
      card.addEventListener("contextmenu", (event) => { event.preventDefault(); event.stopPropagation(); openTodoMenu(item, card, event.clientX, event.clientY); });
      card.style.setProperty("--hand-z", String(20 + index));
      hand.appendChild(card);
    });
  };
  const renderPriorityHand = () => {
    const hand = camera?.layers?.()[0]?.querySelector?.(".crm-home-priority-hand"); if (!hand) return;
    const renderSignature = JSON.stringify(priorityItems.map(prioritySignature));
    if (hand.dataset.renderSignature === renderSignature && hand.dataset.username === priorityUsername) {
      layoutPriorityHand(hand); camera?.layout?.(); syncMotionSnapshot(); return;
    }
    hand.classList.add("is-seating");
    fillPriorityHand(hand);
    // The hand is measured and seated in the same task that creates it. Its
    // default CSS variables therefore never reach a paint and cannot fan out
    // one frame late after Home becomes visible.
    layoutPriorityHand(hand);
    camera?.layout?.();
    syncMotionSnapshot();
    requestAnimationFrame(() => { if (hand.isConnected) hand.classList.remove("is-seating"); });
  };
  const refreshPriorityHand = async () => {
    if (!camera?.isActive?.() || !window.crmDomain?.list) return;
    const generation = ++handRefreshGeneration;
    try {
      const [result, session] = await Promise.all([
        window.crmDomain.list("commitments", { includeDeleted: false, limit: 300 }),
        window.auth?.session?.().catch?.(() => null) || null,
      ]);
      if (generation !== handRefreshGeneration) return;
      priorityUsername = session?.user?.username || "";
      priorityItems = choosePriorityItems(result?.records || [], priorityUsername);
      handDirty = false;
      renderPriorityHand();
    } catch {}
  };
  const scheduleHandRefresh = () => {
    handDirty = true;
    clearTimeout(handRefreshTimer);
    if (!camera?.isActive?.() || camera?.isTransitioning?.() || window.crmDeskTransit?.isBusy?.()) return;
    handRefreshTimer = setTimeout(refreshPriorityHand, 120);
  };
  const canPrewarmFactory = () => !!camera?.isActive?.()
    && !camera?.isTransitioning?.()
    && !window.crmDeskTransit?.isBusy?.()
    && performance.now() >= factoryPrewarmAfter;
  const primeInactiveTheater = (node, api) => new Promise((resolve) => {
    if (!node || api?.isActive?.() || !canPrewarmFactory()) { resolve(); return; }
    const properties = ["display", "opacity", "z-index", "pointer-events"];
    const saved = properties.map((property) => [property, node.style.getPropertyValue(property), node.style.getPropertyPriority(property)]);
    node.hidden = true;
    node.style.setProperty("display", "block", "important");
    node.style.setProperty("opacity", ".001", "important");
    node.style.setProperty("z-index", "0", "important");
    node.style.setProperty("pointer-events", "none", "important");
    const restore = () => {
      saved.forEach(([property, value, priority]) => value ? node.style.setProperty(property, value, priority) : node.style.removeProperty(property));
      node.hidden = !api?.isActive?.();
      resolve();
    };
    requestAnimationFrame(() => {
      if (!canPrewarmFactory()) { restore(); return; }
      requestAnimationFrame(restore);
    });
  });
  const scheduleFactoryPrewarm = () => {
    if (window.crmHomePreviews?.isCaptureWorker || factoryPrewarmRunning || factoryPrewarmHandle || factoryPrewarmTimer
      || prewarmedFactories.size >= FACTORY_PREWARM_APIS.length || factoryPrewarmAttempts >= 30) return;
    const run = async () => {
      factoryPrewarmHandle = 0;
      if (!canPrewarmFactory()) {
        factoryPrewarmTimer = setTimeout(() => { factoryPrewarmTimer = 0; scheduleFactoryPrewarm(); }, 120);
        return;
      }
      const name = FACTORY_PREWARM_APIS.find((apiName) => !prewarmedFactories.has(apiName) && window[apiName]?.baseline);
      if (!name) {
        factoryPrewarmAttempts += 1;
        factoryPrewarmTimer = setTimeout(() => { factoryPrewarmTimer = 0; scheduleFactoryPrewarm(); }, 120);
        return;
      }
      factoryPrewarmRunning = true;
      try {
        const api = window[name];
        const theater = await api.baseline({ canRender: canPrewarmFactory });
        if (canPrewarmFactory()) await primeInactiveTheater(theater, api);
        if (canPrewarmFactory()) prewarmedFactories.add(name);
      } catch {}
      factoryPrewarmRunning = false;
      scheduleFactoryPrewarm();
    };
    if (typeof requestIdleCallback === "function") factoryPrewarmHandle = requestIdleCallback(run, { timeout: 700 });
    else factoryPrewarmHandle = requestAnimationFrame(run);
  };
  const subscribe = () => {
    if (subscribed) return;
    subscribed = true;
    try { window.crmHomePreviews?.onChanged?.(acceptPreview); } catch {}
    try { window.crmHomePreviews?.onMotionSnapshotChanged?.(acceptMotionSnapshot); } catch {}
    if (window.crmHomePreviews?.isCaptureWorker) { requestPreviews(true); refreshPriorityHand(); return; }
    try { window.crmDomain?.onChanged?.(scheduleHandRefresh); } catch {}
    try { window.auth?.onChanged?.(scheduleHandRefresh); } catch {}
    requestPreviews(true);
    requestMotionSnapshot();
    refreshPriorityHand();
    scheduleFactoryPrewarm();
  };

  const buildRoot = () => {
    const root = document.createElement("div"); root.className = "crm-home-level";
    const snapshot = imageNode("crm-home-motion-snapshot", ""); root.appendChild(snapshot);
    const grid = document.createElement("div"); grid.className = "crm-home-grid";
    const titleLayer = document.createElement("div"); titleLayer.className = "crm-home-title-layer";
    titleLayer.innerHTML = MODULES.map(titleHTML).join("");
    MODULES.forEach((module) => {
      const bucket = document.createElement("button"); bucket.type = "button"; bucket.className = "crm-home-bucket";
      bucket.dataset.module = module.key; bucket.dataset.enabled = "true"; bucket.innerHTML = bucketHTML(module);
      // Do not activate merely because a tile finishes loading beneath an
      // already-stationary pointer. Actual pointer movement arms the reveal.
      bucket.addEventListener("pointermove", () => {
        if (!bucket.dataset.previewReady || bucket.classList.contains("is-preview-hovered")) return;
        revealSharpPreview(bucket);
      });
      bucket.addEventListener("pointerleave", () => {
        restSharpPreview(bucket);
      });
      bucket.addEventListener("focus", () => revealSharpPreview(bucket));
      bucket.addEventListener("blur", () => restSharpPreview(bucket));
      grid.appendChild(bucket);
    });
    const hand = document.createElement("section"); hand.className = "crm-home-priority-hand"; hand.setAttribute("aria-label", "Important linked work due today");
    fillPriorityHand(hand); root.append(grid, titleLayer, hand); syncMotionSnapshot(root); requestAnimationFrame(mountAll); return root;
  };
  const layout = ({ expRect }) => {
    const surface = camera?.surface?.(); const grid = surface?.querySelector(".crm-home-grid"); const hand = surface?.querySelector(".crm-home-priority-hand"); if (!grid) return;
    const rootStyle = getComputedStyle(document.documentElement);
    const metric = (name, fallback) => parseFloat(rootStyle.getPropertyValue(name)) || fallback;
    const GAP = metric("--crm-object-gap", 18), OUTER = 18, full = expRect(); let controlsBottom = 42;
    document.querySelectorAll(".window-control-cluster").forEach((node) => { controlsBottom = Math.max(controlsBottom, node.getBoundingClientRect().bottom); });
    const top = Math.round(Math.max(controlsBottom + 14, metric("--crm-canvas-top", 78)));
    // Home geometry must not depend on an asynchronous priority query. Keep
    // the same hand reserve before, during, and after the cards arrive.
    const handReserve = Math.min(320, Math.max(254, innerWidth * .16 + 32));
    hand?.style.setProperty("--home-hand-reserve", `${handReserve.toFixed(1)}px`);
    const area = { x: OUTER, y: top, w: full.w - 2 * OUTER, h: Math.max(220, full.h - top - OUTER - handReserve) };
    // Every tile is a geometrically faithful viewport of the room it opens.
    // Artificially widening the 2x2 cells made the cached room look stretched
    // and guaranteed a scale change at the camera endpoint.
    const captured = MODULES.map(({ key }) => previews.get(key)).find((preview) => Number(preview?.width) > 0 && Number(preview?.height) > 0);
    const aspect = captured ? captured.width / captured.height : innerWidth / innerHeight;
    const cellW = Math.max(1, Math.min((area.w - GAP) / 2, ((area.h - GAP) / 2) * aspect));
    const cellH = Math.max(1, cellW / aspect);
    const gridW = 2 * cellW + GAP, gridH = 2 * cellH + GAP;
    const gridGeometry = { left:`${area.x + (area.w-gridW)/2}px`, top:`${area.y + (area.h-gridH)/2}px`, width:`${gridW}px`, height:`${gridH}px` };
    Object.assign(grid.style, gridGeometry);
    const titleLayer = surface?.querySelector(".crm-home-title-layer");
    if (titleLayer) Object.assign(titleLayer.style, gridGeometry);
    surface.style.setProperty("--home-r", `${Math.min(64,Math.max(2,16/245*Math.min(cellW,cellH)*2)).toFixed(1)}px`);
    layoutPriorityHand(hand);
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
    const bucket = recycledExpanders.get(module.key) || document.createElement("div");
    recycledExpanders.delete(module.key);
    bucket.className = "crm-home-bucket crm-home-expander";
    bucket.dataset.module = module.key;
    if (!bucket.querySelector(".crm-home-preview")) bucket.innerHTML = bucketHTML(module);
    if (!bucket.querySelector(":scope > .crm-home-transition-acrylic")) {
      const acrylic = document.createElement("span");
      acrylic.className = "crm-home-transition-acrylic";
      acrylic.setAttribute("aria-hidden", "true");
      bucket.prepend(acrylic);
    }
    // One transparent, full-resolution room texture carries its objects and
    // shadows above a live acrylic lens. The fixed workspace wallpaper remains
    // the only background paint throughout the camera move.
    mountHost(bucket.querySelector(".crm-home-preview"), previews.get(module.key));
    return bucket;
  };
  const recycleExpander = (key, expander) => {
    if (!expander || !MODULES.some((module) => module.key === key)) return;
    expander.remove();
    expander.className = "crm-home-bucket crm-home-expander";
    recycledExpanders.set(key, expander);
  };
  const markCameraTarget = (target, context) => {
    const root = context?.layers?.[0];
    root?.querySelectorAll?.(".crm-home-bucket.is-camera-target")?.forEach?.((bucket) => bucket.classList.remove("is-camera-target"));
    target?.classList?.add?.("is-camera-target");
    selectMotionVariant(root, target?.dataset?.module || "");
  };
  const clearCameraTarget = () => {
    const root = camera?.layers?.()[0];
    root?.querySelectorAll?.(".crm-home-bucket.is-camera-target")?.forEach?.((bucket) => bucket.classList.remove("is-camera-target"));
    selectMotionVariant(root, "");
  };
  const finishHandoff = (clearTarget = true) => {
    camera?.surface?.()?.classList.remove("crm-home-camera-handoff", "crm-home-camera-releasing");
    if (clearTarget) clearCameraTarget();
    const resolve = handoffResolve;
    handoffResolve = null;
    resolve?.();
    flushPendingPreviews();
    flushPendingMotionSnapshot();
  };
  const beginHomeHandoff = (context, sequence) => {
    const surface = context.surface;
    const snapshot = context.layers?.[0]?.querySelector?.(":scope > .crm-home-motion-snapshot");
    if (!surface || !snapshot || context.layers?.[0]?.dataset?.motionSnapshotReady !== "true") {
      finishHandoff();
      handoffPromise = Promise.resolve();
      return;
    }
    finishHandoff(false);
    handoffPromise = new Promise((resolve) => { handoffResolve = resolve; });
    surface.classList.add("crm-home-camera-handoff");
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      snapshot.removeEventListener("transitionend", onEnd);
      if (sequence === handoffSequence) finishHandoff();
      else handoffResolve?.();
    };
    const onEnd = (event) => {
      if (event.target === snapshot && event.propertyName === "opacity") finish();
    };
    const timeout = setTimeout(finish, 180);
    snapshot.addEventListener("transitionend", onEnd);
    // Two fully covered paints instantiate the live Home glass and shadows;
    // the short overlap then trades identical pixels without a hard edge.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (sequence !== handoffSequence) { finish(); return; }
      surface.classList.add("crm-home-camera-releasing");
    }));
  };

  camera = window.createFractalCamera({
    apiName:"crmHomeCamera",theater:"home",surfaceClass:"crm-home-surface",layerClass:"crm-home-level",
    warmClass:"crm-home-warm",contractingClass:"crm-home-contracting",active:false,maxLevel:1,margin:0,
    ignoreSelector:".window-control-cluster,.background-tone-menu,.auth-shell,.auth-modal-backdrop,.crm-home-todo-popover,.crm-home-todo-menu",
    expandFadeMs:70,belowFadeMs:70,contractFadeMs:70,keepBelowVisibleDuringTransition:true,precomposeTransitions:true,lockInputDuringTransitions:true,measureTop:()=>0,ensureStyles,buildRoot,layout,targetFromEvent,targetAtPoint,buildExpander,
    contractExpanderAbove:true,holdContractEndpointFrame:true,
    keyOf:(target)=>target.dataset.module||"",sourceSelector:(target)=>`.crm-home-bucket[data-module="${target.dataset.module}"]`,
    prepareTarget:(target,context)=>markCameraTarget(target,context),
    prepareJump:(_expander,target,context)=>markCameraTarget(target,context),
    onTransitionStart:(direction,context)=>{
      finishHandoff(false);
      handoffSequence += 1;
      factoryPrewarmAfter = Number.POSITIVE_INFINITY;
      context.surface?.classList.remove("crm-home-motion-priming","crm-home-camera-handoff","crm-home-camera-releasing");
      syncMotionSnapshot(context.layers?.[0]);
      context.surface?.classList.add("crm-home-camera-moving");
      context.surface?.classList.toggle("crm-home-camera-expanding",direction==="expand");
      context.surface?.classList.toggle("crm-home-camera-contracting",direction==="contract");
    },
    onTransitionEnd:(direction,context)=>{
      context.surface?.classList.remove("crm-home-camera-moving","crm-home-camera-expanding","crm-home-camera-contracting");
      const sequence = ++handoffSequence;
      if (direction === "contract" && context.layers?.[0]?.dataset?.motionSnapshotReady === "true") {
        beginHomeHandoff(context, sequence);
      } else finishHandoff();
      // After returning Home, use the next idle slice to prepare the next room.
      // Expanding leaves Home inactive, so its longer guard remains appropriate.
      factoryPrewarmAfter = performance.now() + (direction === "contract" ? 60 : 250);
      scheduleFactoryPrewarm();
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

  const setActive = (on) => {
    subscribe();
    const changed = camera.isActive() !== !!on;
    if (changed) {
      camera.setActive(on);
      if (on) factoryPrewarmAfter = performance.now() + 250;
    }
    if (on) {
      mountAll();
      scheduleFactoryPrewarm();
      if (window.crmDeskTransit?.isBusy?.()) activeRefreshPending = handDirty;
      else {
        activeRefreshPending = false;
        requestPreviews(false);
        if (handDirty) refreshPriorityHand();
      }
    }
    else {
      clearTimeout(handRefreshTimer); handRefreshGeneration += 1;
      clearTimeout(factoryPrewarmTimer); factoryPrewarmTimer = 0;
      if (factoryPrewarmHandle) {
        if (typeof cancelIdleCallback === "function") cancelIdleCallback(factoryPrewarmHandle);
        else cancelAnimationFrame(factoryPrewarmHandle);
        factoryPrewarmHandle = 0;
      }
    }
    return window.crmHome;
  };
  document.addEventListener("crm:desk-transit-settled", (event) => {
    if ((!activeRefreshPending && !handDirty) || event.detail?.key !== "home" || !camera?.isActive?.()) return;
    activeRefreshPending = false;
    requestAnimationFrame(() => {
      if (!camera?.isActive?.() || window.crmDeskTransit?.isBusy?.()) { activeRefreshPending = true; return; }
      requestPreviews(false);
      if (handDirty) refreshPriorityHand();
    });
  });
  const waitForModuleSettled = (key, timeoutMs = 2200) => new Promise((resolve) => {
    const started = performance.now(); const theater = key === "cases" ? "tickets" : key;
    const selector = {people:".tk-zone,.tk-card,.tk-zcard",cases:".tk-zone,.tk-deck",planner:".crm-project-bucket,.crm-planner-bucket,.crm-planner-card",assignments:".crm-assignment-bucket,.crm-assignment-work-card"}[key]||"*";
    let stable=0,last=""; const tick=()=>{const source=[...document.querySelectorAll(`[data-crm-theater="${theater}"]`)].find((node)=>!node.hidden);
      const samples=source?[source,...source.querySelectorAll(selector)].slice(0,64):[];
      const geometry=samples.map((node)=>{const rect=node.getBoundingClientRect();const style=getComputedStyle(node);return[
        node.dataset?.id||node.dataset?.recordId||node.dataset?.stage||node.dataset?.assignmentCommitment||node.className,
        rect.x.toFixed(2),rect.y.toFixed(2),rect.width.toFixed(2),rect.height.toFixed(2),style.transform,style.opacity,
      ].join(":")}).join("|");
      // A room can be intentionally empty (notably a new Projects world). Its own
      // stable geometry is still a valid destination; requiring a child object
      // held the reveal open until the timeout and made the handoff hitch.
      const next=source?`${source.childElementCount}:${source.querySelectorAll("*").length}:${source.scrollWidth}:${source.scrollHeight}:${geometry}`:"";
      stable=next&&next===last?stable+1:0;last=next;if(stable>=3||performance.now()-started>=timeoutMs)resolve({stable:stable>=3,signature:next});else requestAnimationFrame(tick)};requestAnimationFrame(tick);
  });
  const waitForModuleReady = (key) => new Promise((resolve) => {
    const theater = key === "cases" ? "tickets" : key;
    const selector = {people:".tk-zone,.tk-card,.tk-zcard",cases:".tk-zone,.tk-deck",planner:".crm-project-bucket,.crm-planner-bucket,.crm-planner-card",assignments:".crm-assignment-bucket,.crm-assignment-work-card"}[key]||"*";
    const source=[...document.querySelectorAll(`[data-crm-theater="${theater}"]`)].find((node)=>!node.hidden);
    if(source?.querySelector?.(selector))resolve();else requestAnimationFrame(resolve);
  });
  const previewApiFor = (key) => window[FACTORY_API_BY_MODULE[key]] || null;
  const captureDisplayedState = (key) => {
    const api = previewApiFor(key);
    let state = null;
    try { state = api?.homePreviewState?.() || null; } catch {}
    try { return JSON.parse(JSON.stringify({ revision:1, ...(state || {}) })); }
    catch { return { revision:1 }; }
  };
  const applyCaptureState = async (key, state = {}) => {
    const api = previewApiFor(key);
    if (!api) return false;
    try {
      await api.baseline?.();
      await api.applyHomePreviewState?.(state);
      await waitForModuleSettled(key);
      return true;
    } catch { return false; }
  };
  const captureBaseline = (key, viewState = captureDisplayedState(key)) => {
    if (window.crmHomePreviews?.isCaptureWorker) return Promise.resolve(previews.get(key)||null);
    previewSyncKeys.add(key);
    const request = (async () => {
      try { const result=await window.crmHomePreviews?.capture?.(key, viewState); if(result?.preview)acceptPreview(result.preview); } catch {}
      return previews.get(key)||null;
    })();
    previewSyncs.add(request);
    request.finally(() => { previewSyncs.delete(request); previewSyncKeys.delete(key); }).catch(() => {});
    return request;
  };
  const waitForPreviewSync = async () => {
    while (previewSyncs.size) await Promise.allSettled([...previewSyncs]);
    const result = await window.crmHomePreviews?.waitForIdle?.().catch?.(() => null);
    if (result?.ok === false) throw new Error(result.error || "Preview synchronization failed");
    return true;
  };
  const noteModuleReady = (key) => {
    const apiName = FACTORY_API_BY_MODULE[key];
    if (apiName) prewarmedFactories.add(apiName);
  };
  window.addEventListener("resize",()=>{camera?.layout?.();requestAnimationFrame(()=>syncMotionSnapshot())});
  window.crmHome={setActive,isActive:()=>camera.isActive(),refresh:()=>{camera.layout();mountAll();requestPreviews(false);syncMotionSnapshot()},captureBaseline,captureDisplayedState,applyCaptureState,refreshDisplayedPreview:captureBaseline,waitForPreviewSync,waitForModuleSettled,waitForModuleReady,waitForHandoff:()=>handoffPromise,noteModuleReady,recycleExpander,acceptPreview,
    previewStatus:()=>MODULES.map(({key})=>{const preview=previews.get(key);const pending=pendingPreviews.get(key);return{key,state:(pending||previewSyncKeys.has(key))?"updating":preview?(isCurrentPreview(preview)?"ready":"stale"):"waiting",version:preview?.version||null,capturedAt:preview?.capturedAt||0,layoutSignature:preview?.layoutSignature||null}}),
    handStatus:()=>({ready:!handDirty,count:priorityItems.length,username:priorityUsername,day:todayKey(),ids:priorityItems.map((item)=>item.id),targets:priorityItems.map((item)=>priorityLink(item))}),
    ensureHandReady:refreshPriorityHand,motionLayoutSignature,motionStatus:()=>({ready:camera?.layers?.()[0]?.dataset?.motionSnapshotReady==="true",capturedAt:motionSnapshot?.capturedAt||0,layoutSignature:motionSnapshot?.layoutSignature||"",backgroundMode:motionSnapshot?.backgroundMode||"",materialMode:motionSnapshot?.materialMode||""}),
    prewarmStatus:()=>({ready:[...prewarmedFactories],running:factoryPrewarmRunning,pending:FACTORY_PREWARM_APIS.filter((name)=>!prewarmedFactories.has(name))})};
})();
