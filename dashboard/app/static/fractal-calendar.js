// fractal-calendar.js - calendar content hosted by the shared fractal camera.
(() => {
  if (typeof window.createFractalCamera !== "function") {
    console.error("[CRM] fractal camera factory is not loaded");
    return;
  }

  const YEAR_STORE = "crm-calendar-year";
  const EASE = "cubic-bezier(.22, 1, .26, 1)";
  const MORPH_MS = 460;
  const EXP_M = 48;
  const EXP_TOP = 132;
  const YEAR_STRIP_TOP = 66;
  const RADIUS_F = 16 / 245;
  const MONTHS = ["January", "February", "March", "April", "May", "June",
                  "July", "August", "September", "October", "November", "December"];
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const DOW_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  let currentYear = (() => {
    const saved = Number(localStorage.getItem(YEAR_STORE));
    return Number.isFinite(saved) && saved > 1900 ? saved : 2026;
  })();
  let camera = null;
  let scheduledByDate = new Map();
  let subscriptionsReady = false;
  let reloadTimer = 0;
  let dropHighlight = null;
  let renderRevision = 0;
  let transitionPortal = null;
  let transitionPortalOwner = null;
  const belowSnapshotCache = new Map();
  const belowMaterialCache = new Map();
  const yearStripTextureCache = new Map();
  const yearStripTexturePromises = new Map();
  const yearStripCaptureFailureCounts = new Map();
  let yearStripCapturePending = 0;
  let yearStripCaptureLastError = "";
  let yearStripCaptureLastAudit = null;
  const levelMaterialByOwner = new Map();
  let activeBelowSnapshot = null;
  let activeBelowMaterial = null;
  let activeDestinationMaterial = null;
  let activeDestinationOwner = null;
  let activeDestinationBackdropState = null;
  let sourceAcrylicLens = null;
  let activeYearStripPortal = null;
  let activeYearStripPortalState = null;
  let activeYearStripTexture = null;
  let yearStripVisualObserver = null;
  let observedYearStripVisualSignature = "";
  let yearStripVisualInvalidation = 0;
  let materialCleanupObserver = null;
  let layoutGeometrySignature = "";
  let geometryRefreshRevision = 0;
  let geometryReady = true;
  let geometryReadyWaiters = [];

  const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[char]));
  const clampN = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
  // Test seam (BLUEPRINT A4): the today-glow and any "now" derivation honor a
  // pinned clock so the harness can freeze the wall. Product behavior when
  // unset is the real clock.
  const crmNow = () => (window.__CRM_NOW__ ? new Date(window.__CRM_NOW__) : new Date());
  const todayIso = () => {
    const d = crmNow();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const daysIn = (month) => new Date(currentYear, month + 1, 0).getDate();
  const firstDow = (month) => new Date(currentYear, month, 1).getDay();
  const iso = (month, day) => `${currentYear}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const yearDate = (date) => String(date || "").startsWith(`${currentYear}-`);
  const recordsFrom = (result) => Array.isArray(result) ? result : ((result && (result.records || result.tickets)) || []);
  const scheduledDateOf = (record) => {
    const meta = record?.meta || {};
    const raw = meta.scheduledDate || meta.calendarDate || record?.scheduledDate || record?.calendarDate || record?.dueDate || record?.startDate;
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(raw || ""));
    if (!match) return "";
    const value = String(raw || "");
    if (!value.includes("T") || (record?.source === "legacy-projection" && /T00:00:00(?:\.000)?Z$/i.test(value))) return match[1];
    const date = new Date(value); if (!Number.isFinite(date.getTime())) return match[1];
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const titleOf = (record) => {
    const meta = record?.meta || {};
    return meta.client || meta.title || record?.companyLabel || record?.title || record?.name || record?.host || "Untitled";
  };
  const entitySources = [
    { type: "ticket", entity: "tickets" }, { type: "deal", entity: "deals" },
    { type: "contact", entity: "contacts" }, { type: "job", entity: "jobs" },
    { type: "bill", entity: "bills" },
    { type: "invoice", entity: "invoices" },
  ];

  const ensureStyles = () => {
    if (document.getElementById("fractal-calendar-styles")) return;
    const style = document.createElement("style");
    style.id = "fractal-calendar-styles";
    style.textContent = `
      .fc-surface { position: fixed; inset: 0; z-index: 800; pointer-events: none; overflow: hidden; }
      .fc-surface[hidden] { display: none; }
      .fc-level { position: absolute; inset: 0; transform-origin: 0 0; }
      .fc-grid { position: absolute; display: grid; pointer-events: auto; -webkit-app-region: no-drag;
        grid-template-columns: repeat(4, 1fr); grid-template-rows: repeat(3, 1fr); gap: 14px; }
      .fc-frost { position: absolute; inset: 0; pointer-events: none;
        -webkit-backdrop-filter: blur(28px) saturate(140%); backdrop-filter: blur(28px) saturate(140%); }
      .fc-year-strip { position: fixed; left: 50%; top: 58px; z-index: 11; transform: translateX(-50%);
        display: inline-flex; align-items: center; gap: 8px; pointer-events: auto; -webkit-app-region: no-drag;
        padding: 4px 7px; border-radius: 999px; color: #fff;
        background: linear-gradient(180deg, rgba(22,26,36,0.62), rgba(12,16,24,0.55));
        border: 1px solid rgba(255,255,255,0.18);
        -webkit-backdrop-filter: blur(22px) saturate(135%); backdrop-filter: blur(22px) saturate(135%);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 12px 28px rgba(0,0,0,0.28); }
      .fc-year-label { min-width: 4.5ch; text-align: center; font-size: var(--crm-type-body,12px); font-weight: 800; letter-spacing: .02em; }
      .fc-bucket { position: relative; box-sizing: border-box; display: flex; flex-direction: column; min-height: 0;
        overflow: hidden; color: #fff; border: 0; container-type: size;
        border-radius: calc(var(--mon-r, 16px) * var(--kx, 1)) / calc(var(--mon-r, 16px) * var(--ky, 1));
        padding: calc(8px * var(--ky, 1)) calc(10px * var(--kx, 1)) calc(10px * var(--ky, 1));
        background: linear-gradient(180deg, rgba(22,26,36,0.5), rgba(12,16,24,0.42));
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.14),
          inset 0 1px 0 rgba(255,255,255,0.18), 0 18px 42px rgba(0,0,0,0.28);
        transition: box-shadow .18s ease, background .18s ease; }
      .fc-hd { flex: 0 0 9%; display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 0 1%; font-size: clamp(0.98rem, 8cqh, 1.15rem); font-weight: 700; line-height: 1.05;
        color: rgba(255,255,255,0.85); white-space: nowrap; min-height: 0; }
      .fc-expander .fc-hd,
      .fc-transition-portal .fc-hd { font-size: clamp(1.15rem, 3.2cqh, 1.7rem); }
      .fc-expander[data-kind="day"] .fc-hd,
      .fc-transition-portal[data-kind="day"] .fc-hd { font-size: clamp(1.05rem, 2.8cqh, 1.45rem); }
      .fc-dowrow { flex: 0 0 5%; display: grid; grid-template-columns: repeat(7, 1fr); column-gap: 1.6%;
        align-items: center; min-height: 0; }
      .fc-dowrow span { text-align: center; font-size: var(--crm-type-caption,11px); font-weight: 700; color: rgba(255,255,255,0.4);
        white-space: nowrap; overflow: hidden; }
      .fc-days { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: repeat(7, 1fr);
        grid-template-rows: repeat(6, 1fr); column-gap: 1.6%; row-gap: 2%; }
      .fc-day-spacer { min-height: 0; visibility: hidden; pointer-events: none; }
      .fc-day { position: relative; min-height: 0; overflow: hidden; border: 0;
        border-radius: calc(var(--day-r, 3px) * var(--kx, 1)) / calc(var(--day-r, 3px) * var(--ky, 1));
        background: linear-gradient(180deg, rgba(255,255,255,0.075), rgba(255,255,255,0.035));
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10), inset 0 1px 0 rgba(255,255,255,0.08);
        transition: box-shadow .18s ease, background .18s ease; }
      .fc-day-num { position: absolute; top: 6%; left: 7%; font-size: var(--crm-type-body,12px); font-weight: 700;
        color: rgba(255,255,255,0.78); line-height: 1; }
      .fc-day-body { position: absolute; inset: 24% 5% 5%; display: flex; flex-direction: column; gap: 3px; min-height: 0; }
      .fc-scheduled-list { display: flex; flex-direction: column; gap: 0; min-height: 0; overflow: hidden; }
      /* At year scale, days render only a tiny structural preview. These are
         ordinary opaque spans (no filters, text or nested cards), so twelve
         live month thumbnails stay cheap while still revealing where work is. */
      .fc-day-preview { display: none; width: 100%; height: 100%; flex-direction: column; justify-content: center; gap: 12%; overflow: hidden; }
      .fc-day-preview-item { display: flex; width: 100%; height: 2px; gap: 1px; opacity: .82; }
      .fc-day-preview-item i { flex: 1 1 0; min-width: 1px; border-radius: 2px; background: rgba(143,158,180,.24); }
      .fc-day-preview-item i[data-reached="true"] { background: rgba(151,184,226,.62); }
      .fc-day-preview-item[data-complete="true"] i[data-reached="true"] { background: rgba(143,195,169,.62); }
      /* BLUEPRINT A4: day cells hold TITLE-PEEK bands — the card anatomy at
         k-scale (glass body, left edge accent), stacked flush like a peeking
         pile, never colored pills. Red stays money-only (data-hot). */
      .fc-chip { position: relative; display: grid; grid-template-rows: minmax(0,auto) 2px; gap: 2px; border-radius: 3px; margin-top: -1px; padding: 2px 6px 3px 9px;
        font-size: var(--crm-type-micro,9px); line-height: 1.2; color: rgba(255,255,255,0.88);
        background: linear-gradient(180deg, rgba(83,95,117,0.6), rgba(33,41,56,0.55));
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.09), inset 0 1px 0 rgba(255,255,255,0.10), 0 2px 6px rgba(0,0,0,0.22);
        white-space: nowrap; overflow: hidden; }
      .fc-chip-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .fc-chip-project-map { display: flex; align-items: stretch; gap: 1px; min-width: 0; height: 2px; }
      .fc-chip-project-map i { flex: 1 1 0; min-width: 2px; border-radius: 2px; background: rgba(218,230,245,.13); }
      .fc-chip-project-map i[data-reached="true"] { background: rgba(157,190,232,.55); }
      .fc-chip-project-map[data-complete="true"] i[data-reached="true"] { background: rgba(145,197,171,.58); }
      .fc-chip:not(:has(.fc-chip-project-map)) { grid-template-rows: minmax(0,auto); }
      .fc-chip:first-child { margin-top: 0; }
      .fc-chip::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
        background: rgba(148,163,184,0.35); }
      .fc-chip[data-type="deal"]::before { background: rgba(249,115,22,0.85); }
      .fc-chip[data-type="task"]::before { background: rgba(111,201,154,0.85); }
      .fc-chip[data-type="ticket"]::before { background: rgba(125,180,255,0.85); }
      .fc-chip[data-type="invoice"]::before { background: rgba(56,189,248,0.85); }
      .fc-chip[data-type="contact"]::before, .fc-chip[data-type="calendar"]::before { background: rgba(148,163,184,0.35); }
      .fc-chip[data-hot="true"]::before { background: rgba(220,38,38,0.95); }   /* overdue invoice — the only red */
      .fc-chip-more { font-size: var(--crm-type-micro,9px); padding: 1px 6px; color: rgba(255,255,255,0.5); }
      /* Inside the day dive the same bands read near-card-size and open on click. */
      .fc-day-detail .fc-chip { font-size: var(--crm-type-body,12px); padding: 9px 12px 9px 14px; border-radius: 6px;
        margin-top: 3px; cursor: pointer; }
      .fc-day-detail .fc-chip:hover { background: linear-gradient(180deg, rgba(103,115,137,0.66), rgba(53,61,76,0.6));
        box-shadow: inset 0 0 0 1px rgba(125,180,255,0.4), inset 0 1px 0 rgba(255,255,255,0.14), 0 2px 8px rgba(0,0,0,0.28); }
      /* BLUEPRINT A4: today's cell carries the lid glow — the wall's only
         ambient signal. */
      .fc-day.fc-today { box-shadow: inset 0 0 0 1px rgba(125,180,255,0.55), inset 0 1px 0 rgba(255,255,255,0.14),
        0 0 16px rgba(90,150,255,0.38); }
      /* The drag-to-day / chip-tap flight: a shrinking glass card that seats
         into the day cell (house ease, opaque body — no backdrop under transform). */
      .fc-fly-card { position: fixed; z-index: 6000; pointer-events: none; box-sizing: border-box;
        border-radius: 12px; padding: 10px 12px; color: #fff; font-size: var(--crm-type-control,13px); font-weight: 700;
        overflow: hidden; background-color: rgb(74, 84, 101);
        background-image: linear-gradient(180deg, rgba(83,95,117,0.85), rgba(33,41,56,0.9));
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.2), 0 18px 42px rgba(0,0,0,0.4);
        transition: transform 460ms ${EASE}, opacity 220ms ease 300ms; }
      .fc-empty, .fc-day-detail { width: 100%; margin: auto 0; padding: 14px 8px; text-align: center;
        color: rgba(255,255,255,0.42); font-size: var(--crm-type-body,12px); line-height: 1.4; }
      .fc-day-detail { margin: 0; height: 100%; box-sizing: border-box; display: flex; flex-direction: column; gap: 10px; text-align: left; }
      .fc-day-detail .fc-scheduled-list { overflow: auto; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.5) transparent; }
      .fc-drop-hint { margin-top: auto; text-align: center; color: rgba(255,255,255,0.42); }
      .fc-level .fc-day-num { display: none; }
      .fc-level .fc-dowrow span { visibility: hidden; }
      .fc-expander[data-kind="month"] > .fc-transition-preview .fc-day-num { display: none; }
      .fc-expander[data-kind="month"] > .fc-transition-preview .fc-dowrow span { visibility: hidden; }
      /* Year LOD belongs only to the root and the exact source clone riding
         into/out of it. The destination month is already its real LOD before
         motion, so changing data-level at the endpoint cannot reveal a late
         batch of objects. */
      .fc-surface[data-level="0"] > .fc-level .fc-scheduled-list,
      .fc-expander[data-kind="month"] > .fc-transition-preview .fc-scheduled-list { display: none; }
      .fc-surface[data-level="0"] > .fc-level .fc-day-body,
      .fc-expander[data-kind="month"] > .fc-transition-preview .fc-day-body { inset: 13% 10%; }
      .fc-surface[data-level="0"] > .fc-level .fc-day-preview,
      .fc-expander[data-kind="month"] > .fc-transition-preview .fc-day-preview { display: flex; }
      .fc-surface[data-level="0"] > .fc-level .fc-day,
      .fc-expander[data-kind="month"] > .fc-transition-preview .fc-day { pointer-events: none; }
      .fc-surface[data-level="0"] > .fc-level .fc-month { cursor: pointer; }
      .fc-surface[data-level="0"] .fc-month:hover,
      .fc-expander[data-kind="month"] .fc-day:hover,
      .fc-day.is-drop-target,
      .fc-day-detail.is-drop-target,
      .fc-empty.is-drop-target {
        background: linear-gradient(180deg, rgba(70,110,190,0.34), rgba(40,70,130,0.26));
        box-shadow: inset 0 0 0 1px rgba(125,180,255,0.5), 0 0 30px rgba(90,150,255,0.42); }
      .fc-expander[data-kind="month"] .fc-day { cursor: pointer; pointer-events: auto; }
      /*
       * Calendar dives are one precomposed scene, not a source tree followed
       * by a freshly-mounted destination.  The source clone and destination
       * are both present before motion; their late, synchronized dissolve is
       * hidden inside the bucket-acrylic release.  Every moving property is a
       * compositor property (transform/opacity).
      */
      .fc-expander { position: absolute; z-index: 5; pointer-events: auto; -webkit-app-region: no-drag;
        transform-origin: 0 0; padding: 0; contain: layout paint style;
        will-change: transform; backface-visibility: hidden; }
      /* crm-menu-surface is the canonical bucket material.  Once its exact
         computed material has been copied to a fixed sibling, the transformed
         owner becomes objects-only; no filter is ever nested under scale. */
      .fc-expander.fc-material-externalized {
        background-color: transparent !important; background-image: none !important;
        border-color: transparent !important; box-shadow: none !important;
        filter: none !important;
        -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
      .fc-expander-live { position: absolute; inset: 0; z-index: 2; box-sizing: border-box;
        display: flex; flex-direction: column; min-width: 0; min-height: 0;
        padding: calc(8px * var(--ky, 1)) calc(10px * var(--kx, 1)) calc(10px * var(--ky, 1));
        opacity: 1; pointer-events: auto; transform: translateZ(0); backface-visibility: hidden;
        will-change: opacity; }
      .fc-transition-portal { position: absolute; z-index: 6; pointer-events: none;
        object-fit: fill; opacity: 0; transform: translateZ(0);
        backface-visibility: hidden; will-change: opacity; contain: strict; }
      .fc-transition-preview { position: absolute !important; inset: auto !important; z-index: 2;
        box-sizing: border-box; margin: 0 !important; pointer-events: none !important;
        background: transparent !important; box-shadow: none !important;
        -webkit-backdrop-filter: none !important; backdrop-filter: none !important;
        transform-origin: 0 0; opacity: 0; backface-visibility: hidden; contain: layout paint style;
        will-change: transform, opacity; }
      .fc-warm > .fc-transition-preview,
      .fc-expander[data-fractal-frame="source"] > .fc-transition-preview { opacity: 1; }
      .fc-warm > .fc-expander-live,
      .fc-expander[data-fractal-frame="source"] > .fc-expander-live { opacity: .001; }
      @keyframes fc-transition-preview-out {
        0% { opacity: 1; }
        78% { opacity: 1; animation-timing-function: cubic-bezier(.37, 0, .63, 1); }
        100% { opacity: 0; }
      }
      @keyframes fc-transition-live-in {
        0% { opacity: 0; }
        78% { opacity: 0; animation-timing-function: cubic-bezier(.37, 0, .63, 1); }
        100% { opacity: 1; }
      }
      @keyframes fc-transition-preview-in {
        0% { opacity: 0; animation-timing-function: cubic-bezier(.37, 0, .63, 1); }
        22% { opacity: 1; }
        100% { opacity: 1; }
      }
      @keyframes fc-transition-live-out {
        0% { opacity: 1; animation-timing-function: cubic-bezier(.37, 0, .63, 1); }
        22% { opacity: 0; }
        100% { opacity: 0; }
      }
      .fc-surface.fc-camera-expanding > .fc-transition-portal {
        animation: fc-transition-live-in ${MORPH_MS}ms linear both; }
      .fc-surface.fc-camera-expanding
        > .fc-expander:not(.fc-warm):not(.fc-camera-below)
        > .fc-transition-preview {
        animation: fc-transition-preview-out ${MORPH_MS}ms linear both; }
      .fc-surface.fc-camera-contracting > .fc-transition-portal {
        animation: fc-transition-live-out ${MORPH_MS}ms linear both; }
      .fc-surface.fc-camera-contracting
        > .fc-expander:not(.fc-warm):not(.fc-camera-below)
        > .fc-transition-preview {
        animation: fc-transition-preview-in ${MORPH_MS}ms linear both; }
      .fc-source-screen-acrylic,
      .fc-level-material,
      .fc-below-material-scene,
      .fc-below-material-piece {
        position: absolute; box-sizing: border-box; pointer-events: none;
        transform: none !important; backface-visibility: hidden; }
      .fc-level-material { z-index: 2; opacity: 0; will-change: opacity; }
      .fc-below-material-scene { inset: 0; z-index: 2; opacity: 0; }
      .fc-surface.fc-camera-expanding > .fc-level-material.is-destination-material {
        animation: fc-transition-live-in ${MORPH_MS}ms linear both; }
      .fc-surface.fc-camera-contracting > .fc-level-material.is-destination-material {
        animation: fc-transition-live-out ${MORPH_MS}ms linear both; }
      @keyframes fc-below-release {
        0% { opacity: 1; }
        78% { opacity: 1; animation-timing-function: cubic-bezier(.37, 0, .63, 1); }
        100% { opacity: 0; }
      }
      @keyframes fc-below-return {
        0% { opacity: 0; animation-timing-function: cubic-bezier(.37, 0, .63, 1); }
        22% { opacity: 1; }
        100% { opacity: 1; }
      }
      /* The selected source is already riding in the precomposed expander.
         Re-scaling the complete 12-month/42-day source tree would only ask
         Chromium to raster a multi-viewport texture. Keep that tree at native
         resolution and exchange it beneath the same acrylic release. */
      .fc-surface.fc-camera-moving > .fc-camera-below {
        transform: none !important; filter: none !important; visibility: hidden !important;
        -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
      .fc-surface.fc-camera-moving > .fc-camera-below .fc-frost,
      .fc-surface.fc-camera-moving > .fc-camera-below .fc-year-strip,
      .fc-surface.fc-camera-moving > .fc-camera-below * {
        filter: none !important;
        -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
      .fc-surface.fc-camera-moving > .fc-camera-below > .fc-transition-preview {
        visibility: hidden !important; }
      .fc-surface.fc-camera-expanding > .fc-camera-below {
        animation: none; }
      .fc-surface.fc-camera-contracting > .fc-camera-below {
        animation: none; }
      .fc-below-snapshot { position: absolute; z-index: 3; pointer-events: none;
        opacity: 0; object-fit: fill; transform: translateZ(0); backface-visibility: hidden;
        will-change: opacity; contain: strict; }
      .fc-surface.fc-camera-expanding > .fc-below-snapshot.is-active {
        animation: fc-below-release ${MORPH_MS}ms linear both; }
      .fc-surface.fc-camera-contracting > .fc-below-snapshot.is-active {
        animation: fc-below-return ${MORPH_MS}ms linear both; }
      /* The original strip keeps its identity/listeners but is paint-suspended
         during motion. A decoded compositor capture supplies the exact nested
         acrylic, icons and wallpaper sample as one cheap texture, avoiding six
         simultaneous live backdrop owners at 100 Hz. */
      .fc-year-strip.fc-year-strip-portal,
      .fc-year-strip.fc-year-strip-portal .crm-secondary-control {
        visibility: hidden !important; pointer-events: none !important;
        filter: none !important;
        -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
      .fc-year-strip-texture { position: absolute; z-index: 11; pointer-events: none;
        opacity: 0; transform: translateZ(0); backface-visibility: hidden;
        contain: layout style; will-change: opacity; }
      .fc-year-strip-texture > .fc-year-strip-texture-shadow {
        position: absolute; z-index: 0; pointer-events: none; }
      .fc-year-strip-texture > .fc-year-strip-texture-image {
        position: absolute; z-index: 1; inset: 0; width: 100%; height: 100%;
        display: block; object-fit: fill; pointer-events: none; }
      .fc-surface.fc-camera-expanding > .fc-year-strip-texture.is-active {
        animation: fc-below-release ${MORPH_MS}ms linear both; }
      .fc-surface.fc-camera-contracting > .fc-year-strip-texture.is-active {
        animation: fc-below-return ${MORPH_MS}ms linear both; }
      .fc-surface.fc-camera-moving > .fc-expander {
        background-color: transparent !important; background-image: none !important;
        border-color: transparent !important; box-shadow: none !important; filter: none !important;
        -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
      .fc-camera-target { opacity: 0 !important; }
      .fc-contracting-expander { background: transparent; box-shadow: none;
        -webkit-backdrop-filter: none; backdrop-filter: none; }
      .fc-warm, .fc-warm * { pointer-events: none !important; }
    `;
    document.head.appendChild(style);
  };
  const scheduledFor = (date) => scheduledByDate.get(date) || [];
  const visibleScheduledFor = (date, limit) => {
    const all = scheduledFor(date); const items = all.slice(0, limit);
    const projectItem = all.find((item) => item.projectStages?.length);
    if (projectItem && !items.includes(projectItem)) {
      if (items.length) items[items.length - 1] = projectItem;
      else items.push(projectItem);
    }
    return { all, items };
  };
  const progressMapHTML = (item, className = "fc-chip-project-map") => {
    const stages = Array.isArray(item?.projectStages) ? item.projectStages : [];
    if (!stages.length) return "";
    const current = stages.findIndex((stage) => String(stage.id) === String(item.stageId));
    const complete = current >= 0 && stages[current]?.kind === "done";
    return `<span class="${className}"${complete ? ' data-complete="true"' : ""} aria-hidden="true">${stages.map((_stage, index) => `<i data-reached="${index <= current}"></i>`).join("")}</span>`;
  };
  const scheduledPreviewHTML = (date, limit = 3) => {
    const { items } = visibleScheduledFor(date, limit); if (!items.length) return "";
    return `<div class="fc-day-preview" aria-hidden="true">${items.map((item) => {
      const map = progressMapHTML(item, "fc-day-preview-item");
      return map || `<span class="fc-day-preview-item" data-type="${esc(item.type)}"><i data-reached="true"></i></span>`;
    }).join("")}</div>`;
  };
  const scheduledHTML = (date, limit = 4) => {
    const { all, items } = visibleScheduledFor(date, limit);
    if (!items.length) return "";
    const extra = all.length - items.length;
    return `<div class="fc-scheduled-list">${items.map((item) =>
      `<div class="fc-chip" data-type="${esc(item.type)}" data-id="${esc(item.id)}"${item.hot ? ' data-hot="true"' : ""}${item.projectTitle ? ` title="${esc(item.projectTitle)}"` : ""}><span class="fc-chip-title">${esc(item.title)}</span>${progressMapHTML(item)}</div>`).join("")}${
      extra > 0 ? `<div class="fc-chip-more">+${extra} more</div>` : ""}</div>`;
  };
  const dayCellHTML = (month, day) => {
    const date = iso(month, day);
    const today = date === todayIso() ? " fc-today" : "";
    return `<div class="fc-day${today}" data-date="${date}"><span class="fc-day-num">${day}</span><div class="fc-day-body">${scheduledPreviewHTML(date)}${scheduledHTML(date)}</div></div>`;
  };
  const monthDaysHTML = (month) => {
    const leading = firstDow(month);
    const dayCount = daysIn(month);
    const trailing = 42 - leading - dayCount;
    return `${'<div class="fc-day-spacer"></div>'.repeat(leading)}` +
      `${Array.from({ length: dayCount }, (_, i) => dayCellHTML(month, i + 1)).join("")}` +
      `${'<div class="fc-day-spacer"></div>'.repeat(trailing)}`;
  };
  const monthInnerHTML = (month) =>
    `<div class="fc-hd"><span>${MONTHS[month]}</span></div>` +
    `<div class="fc-dowrow">${DOW.map((day) => `<span>${day}</span>`).join("")}</div>` +
    `<div class="fc-days">${monthDaysHTML(month)}</div>`;
  const dayInnerHTML = (date) => {
    const [, month, day] = date.split("-").map(Number);
    const parsed = new Date(currentYear, month - 1, day);
    const items = scheduledHTML(date, 40);
    return `<div class="fc-hd"><span>${DOW_FULL[parsed.getDay()]}, ${MONTHS[month - 1]} ${day}</span></div>` +
      `<div class="fc-day-detail" data-date="${date}">` +
        (items || `<div class="fc-empty">No scheduled records yet</div>`) +
        `<div class="fc-drop-hint">Drop grid cards here to schedule them</div>` +
      `</div>`;
  };
  const buildYear = () => {
    const el = document.createElement("div");
    el.className = "fc-level";
    el.innerHTML = `<div class="fc-year-strip crm-menu-surface">
      <button type="button" class="fc-year-btn crm-secondary-control" data-year-step="-1" aria-label="Previous year"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14.5 6-6 6 6 6"></path></svg></button>
      <span class="fc-year-label">${currentYear}</span>
      <button type="button" class="fc-year-btn crm-secondary-control" data-year-step="1" aria-label="Next year"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 6 6 6-6 6"></path></svg></button>
    </div>`;
    const frost = document.createElement("div");
    frost.className = "fc-frost";
    el.appendChild(frost);
    const grid = document.createElement("div");
    grid.className = "fc-grid";
    for (let month = 0; month < 12; month++) {
      const bucket = document.createElement("div");
      bucket.className = "fc-bucket fc-month crm-menu-surface";
      bucket.dataset.month = String(month + 1);
      bucket.innerHTML = monthInnerHTML(month);
      grid.appendChild(bucket);
    }
    el.appendChild(grid);
    return el;
  };
  const layoutGrid = (grid, expRect) => {
    const GAP = 14;
    const E = expRect();
    const aspect = E.w / E.h;
    let cellW = (E.w - 3 * GAP) / 4;
    let cellH = cellW / aspect;
    if (3 * cellH + 2 * GAP > E.h) {
      cellH = (E.h - 2 * GAP) / 3;
      cellW = cellH * aspect;
    }
    const gridW = 4 * cellW + 3 * GAP;
    const gridH = 3 * cellH + 2 * GAP;
    Object.assign(grid.style, {
      left: `${(E.x + (E.w - gridW) / 2).toFixed(2)}px`,
      top: `${(E.y + (E.h - gridH) / 2).toFixed(2)}px`,
      width: `${gridW.toFixed(2)}px`,
      height: `${gridH.toFixed(2)}px`,
    });
  };
  const radiusFor = (width, height) => clampN(RADIUS_F * Math.min(width, height), 2, 64);
  const layoutFrost = ({ surface, layers, expRect }) => {
    const yearEl = layers[0];
    if (!yearEl) return;
    const viewport = expRect();
    const strip = yearEl.querySelector(".fc-year-strip");
    if (strip) strip.style.top = `${YEAR_STRIP_TOP}px`;
    const frost = yearEl.querySelector(":scope > .fc-frost");
    const grid = yearEl.querySelector(":scope > .fc-grid");
    if (!surface || !frost || !grid) return;
    layoutGrid(grid, expRect);
    const firstMonth = grid.firstElementChild;
    const firstDay = grid.querySelector(".fc-day");
    if (!firstMonth) return;
    const monthR = radiusFor(firstMonth.offsetWidth, firstMonth.offsetHeight);
    surface.style.setProperty("--mon-r", `${monthR.toFixed(1)}px`);
    if (firstDay) surface.style.setProperty("--day-r", `${radiusFor(firstDay.offsetWidth, firstDay.offsetHeight).toFixed(1)}px`);
    const gx = grid.offsetLeft;
    const gy = grid.offsetTop;
    const parts = [...grid.children].map((month) => {
      const width = month.offsetWidth;
      const height = month.offsetHeight;
      const x = gx + month.offsetLeft;
      const y = gy + month.offsetTop;
      const r = monthR;
      return `M ${x + r} ${y} L ${x + width - r} ${y} A ${r} ${r} 0 0 1 ${x + width} ${y + r} ` +
        `L ${x + width} ${y + height - r} A ${r} ${r} 0 0 1 ${x + width - r} ${y + height} L ${x + r} ${y + height} ` +
        `A ${r} ${r} 0 0 1 ${x} ${y + height - r} L ${x} ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`;
    });
    frost.style.clipPath = `path('${parts.join(" ")}')`;

    // Expanded-level acrylic is a fixed screen-space sibling, so it does not
    // inherit the camera layer's resized geometry. Keep it seated on the
    // viewport immediately, then rebuild only the decoded warm textures once
    // resize activity has gone quiet.
    const materialContext = { surface, expRect:() => viewport };
    levelMaterialByOwner.forEach((material, owner) => {
      if (owner?.isConnected && material?.isConnected) {
        placeViewportMaterial(material, materialContext);
      }
    });
    const nextGeometrySignature = [
      window.innerWidth, window.innerHeight,
      viewport.x.toFixed(2), viewport.y.toFixed(2),
      viewport.w.toFixed(2), viewport.h.toFixed(2),
    ].join("|");
    const geometryChanged = !!layoutGeometrySignature
      && layoutGeometrySignature !== nextGeometrySignature;
    layoutGeometrySignature = nextGeometrySignature;
    surface.dataset.geometrySignature = nextGeometrySignature;
    surface.dataset.geometryReady = String(geometryReady);
    if (geometryChanged) scheduleGeometryCacheRefresh(surface);
  };
  const transitionSourceKey = (target) => (
    target?.dataset?.month ? `month:${target.dataset.month}` : `day:${target?.dataset?.date || ""}`
  );
  const SNAPSHOT_PROPERTIES = [
    "position", "display", "box-sizing", "width", "height", "min-width", "min-height",
    "flex", "flex-basis", "flex-direction", "flex-grow", "flex-shrink", "align-items",
    "align-content", "justify-content", "justify-items", "grid-template-columns",
    "grid-template-rows", "grid-auto-flow", "column-gap", "row-gap", "gap",
    "inset", "top", "right", "bottom", "left", "margin", "padding", "overflow",
    "visibility", "opacity", "color", "font-family", "font-size", "font-style",
    "font-weight", "letter-spacing", "line-height", "text-align", "text-overflow",
    "white-space", "background-color", "background-image", "background-position",
    "background-size", "background-repeat", "border", "border-radius", "box-shadow",
    "z-index", "transform", "transform-origin", "mask", "mask-image", "mask-position",
    "mask-size", "mask-repeat", "-webkit-mask", "-webkit-mask-image",
    "-webkit-mask-position", "-webkit-mask-size", "-webkit-mask-repeat",
  ];
  const materializeSnapshotPseudo = (source, destination, pseudo, prepend = false) => {
    const computed = getComputedStyle(source, pseudo);
    const content = computed.content;
    if (!content || content === "none" || content === "normal" || computed.display === "none") return false;
    const material = document.createElement("span");
    material.setAttribute("aria-hidden", "true");
    material.dataset.fcSnapshotPseudo = pseudo.slice(2);
    SNAPSHOT_PROPERTIES.forEach((property) => {
      const value = computed.getPropertyValue(property);
      if (value) material.style.setProperty(property, value);
    });
    material.style.setProperty("pointer-events", "none");
    if (content !== '""' && content !== "''") {
      try { material.textContent = JSON.parse(content); } catch {}
    }
    if (prepend) destination.insertBefore(material, destination.firstChild);
    else destination.appendChild(material);
    return true;
  };
  const clearSnapshotFill = (node) => {
    node.style.setProperty("background-color", "transparent", "important");
    node.style.setProperty("background-image", "none", "important");
    node.style.setProperty("-webkit-backdrop-filter", "none", "important");
    node.style.setProperty("backdrop-filter", "none", "important");
  };
  const clearSnapshotBackdrop = (node) => {
    node.style.setProperty("filter", "none", "important");
    node.style.setProperty("-webkit-backdrop-filter", "none", "important");
    node.style.setProperty("backdrop-filter", "none", "important");
  };
  const snapshotDataUrl = (
    target,
    hiddenSource = null,
    rasterWidth = null,
    rasterHeight = null,
    options = {},
  ) => {
    const clone = target.cloneNode(true);
    const sourceNodes = [target, ...target.querySelectorAll("*")];
    const cloneNodes = [clone, ...clone.querySelectorAll("*")];
    let pseudoCount = 0;
    let controlPseudoCount = 0;
    let yearStripHiddenCount = 0;
    sourceNodes.forEach((source, index) => {
      const destination = cloneNodes[index];
      const computed = getComputedStyle(source);
      SNAPSHOT_PROPERTIES.forEach((property) => {
        const value = computed.getPropertyValue(property);
        if (value) destination.style.setProperty(property, value);
      });
      destination.removeAttribute("id");
      destination.removeAttribute("tabindex");
      destination.removeAttribute("draggable");
      if (options.forceRootOpacity && index === 0) {
        destination.style.setProperty("opacity", "1", "important");
        destination.style.setProperty("visibility", "visible", "important");
      }
      if (options.materialFreeRoot && index === 0) clearSnapshotFill(destination);
      if (options.hideYearStrip && source.matches?.(".fc-year-strip")) {
        destination.style.setProperty("visibility", "hidden", "important");
        destination.style.setProperty("opacity", "0", "important");
        yearStripHiddenCount += 1;
      }
      const ownsLiveMaterial = source.matches?.(".crm-menu-surface,.fc-frost")
        || [computed.filter, computed.webkitBackdropFilter, computed.backdropFilter]
          .some((value) => value && value !== "none");
      if (options.materialFreeScene && ownsLiveMaterial) {
        // Literal fills, edges and shadows remain decoded in place. The live
        // root scene owns only two screen-space backdrop recipes: its frost
        // and one canonical 26px union for every menu/control surface.
        clearSnapshotBackdrop(destination);
      }
      if (source.matches?.(".fc-chip,.crm-secondary-control")) {
        if (materializeSnapshotPseudo(source, destination, "::before", true)) pseudoCount += 1;
        if (materializeSnapshotPseudo(source, destination, "::after")) pseudoCount += 1;
        if (source.matches?.(".crm-secondary-control")
          && destination.querySelector?.(':scope > [data-fc-snapshot-pseudo="before"]')) {
          controlPseudoCount += 1;
        }
      }
    });
    const hiddenIndex = hiddenSource ? sourceNodes.indexOf(hiddenSource) : -1;
    if (hiddenIndex >= 0) {
      cloneNodes[hiddenIndex].style.setProperty("visibility", "hidden", "important");
      cloneNodes[hiddenIndex].style.setProperty("opacity", "0", "important");
    }
    const width = Math.max(1, target.offsetWidth);
    const height = Math.max(1, target.offsetHeight);
    const outputWidth = Math.max(width, Number(rasterWidth) || width);
    const outputHeight = Math.max(height, Number(rasterHeight) || height);
    Object.assign(clone.style, {
      position:"relative", inset:"auto", left:"0", top:"0", margin:"0",
      width:`${width}px`, height:`${height}px`,
    });
    const body = new XMLSerializer().serializeToString(clone);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${width} ${height}"><foreignObject x="0" y="0" width="${width}" height="${height}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px;overflow:hidden">${body}</div></foreignObject></svg>`;
    return {
      url:`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      pseudoCount,
      controlPseudoCount,
      yearStripHiddenCount,
      hiddenCount:hiddenIndex >= 0 ? 1 : 0,
    };
  };
  const blobDataUrl = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const rasterSnapshotInto = async (
    node,
    target,
    hiddenSource = null,
    readyOpacity = .001,
    rasterWidth = null,
    rasterHeight = null,
    options = {},
  ) => {
    const width = Math.max(1, target.offsetWidth);
    const height = Math.max(1, target.offsetHeight);
    const outputWidth = Math.max(width, Number(rasterWidth) || width);
    const outputHeight = Math.max(height, Number(rasterHeight) || height);
    node.dataset.snapshotReady = "pending";
    node.dataset.snapshotForcedOpaque = String(options.forceRootOpacity === true);
    const previousVisibility = target.style.getPropertyValue("visibility");
    const previousVisibilityPriority = target.style.getPropertyPriority("visibility");
    const revealForSnapshot = getComputedStyle(target).visibility === "hidden";
    if (revealForSnapshot) target.style.setProperty("visibility", "visible", "important");
    let snapshot;
    try {
      snapshot = snapshotDataUrl(target, hiddenSource, outputWidth, outputHeight, options);
    } finally {
      if (revealForSnapshot) {
        if (previousVisibility) {
          target.style.setProperty("visibility", previousVisibility, previousVisibilityPriority);
        } else target.style.removeProperty("visibility");
      }
    }
    node.dataset.snapshotPseudoCount = String(snapshot.pseudoCount);
    node.dataset.snapshotControlPseudoCount = String(snapshot.controlPseudoCount);
    node.dataset.snapshotYearStripHiddenCount = String(snapshot.yearStripHiddenCount);
    node.dataset.snapshotHiddenCount = String(snapshot.hiddenCount);
    node.src = snapshot.url;
    try {
      await node.decode?.();
      if (!node.isConnected) return;
      const scale = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(outputWidth * scale));
      canvas.height = Math.max(1, Math.ceil(outputHeight * scale));
      const context = canvas.getContext("2d", { alpha:true });
      context.drawImage(node, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (blob) {
        const png = await blobDataUrl(blob);
        if (!node.isConnected) return;
        node.src = png;
        await node.decode?.();
        node.dataset.snapshotFormat = "png";
      } else {
        node.dataset.snapshotFormat = "svg";
      }
    } catch {
      node.dataset.snapshotFormat = "svg";
    }
    if (!node.isConnected) return;
    node.dataset.snapshotReady = "true";
    precomposeOpacity(node, readyOpacity);
  };
  const precomposeOpacity = (node, baseOpacity) => {
    if (!node || node.dataset.compositeWarm === "true") return;
    node.dataset.compositeWarm = "pending";
    const base = Number(baseOpacity);
    const pulse = base > .5 ? .985 : .008;
    const animation = node.animate(
      [{ opacity:base }, { opacity:pulse }, { opacity:base }],
      { duration:72, easing:"linear", fill:"both" },
    );
    node._fcCompositeWarmAnimation = animation;
    animation.finished.then(() => {
      animation.cancel();
      node._fcCompositeWarmAnimation = null;
      node.dataset.compositeWarm = "true";
    }).catch(() => {});
  };
  const settlePrecomposedOpacity = (node) => {
    node?._fcCompositeWarmAnimation?.cancel?.();
    if (node) {
      node._fcCompositeWarmAnimation = null;
      node.dataset.compositeWarm = "true";
    }
  };
  const shortHash = (value) => {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  };
  const splitCssList = (value) => {
    const entries = [];
    let depth = 0;
    let start = 0;
    String(value || "").split("").forEach((character, index) => {
      if (character === "(") depth += 1;
      else if (character === ")") depth = Math.max(0, depth - 1);
      else if (character === "," && depth === 0) {
        entries.push(String(value).slice(start, index).trim());
        start = index + 1;
      }
    });
    entries.push(String(value || "").slice(start).trim());
    return entries.filter(Boolean);
  };
  const outerBoxShadow = (value) => {
    const shadows = splitCssList(value).filter((shadow) => !/^inset(?:\s|$)/i.test(shadow));
    return shadows.length ? shadows.join(", ") : "none";
  };
  const yearStripVisualSignature = () => {
    const root = document.documentElement;
    const body = document.body;
    const backdrop = document.querySelector(".workspace-photo-backdrop");
    const rootStyle = getComputedStyle(root);
    const bodyStyle = getComputedStyle(body);
    const backdropStyle = backdrop ? getComputedStyle(backdrop) : null;
    return shortHash([
      root.className, root.getAttribute("style") || "",
      body.className, body.getAttribute("style") || "",
      root.dataset.background || "", body.dataset.background || "",
      rootStyle.getPropertyValue("--page-background"),
      rootStyle.getPropertyValue("--bg"),
      rootStyle.getPropertyValue("--bg-end"),
      rootStyle.backgroundImage, bodyStyle.backgroundImage,
      backdrop?.getAttribute("style") || "",
      backdrop?.getAttribute("src") || "",
      backdropStyle?.backgroundImage || "",
    ].join("\u241f"));
  };
  const rootYearStrip = () => (
    camera?.layers?.()?.[0]?.querySelector?.(":scope > .fc-year-strip")
    || activeYearStripPortal
    || null
  );
  const YEAR_STRIP_RENDER_SCHEMA = "strip-paint-r1";
  const YEAR_STRIP_RENDER_PROPERTIES = [
    "display", "box-sizing", "width", "height", "padding", "gap",
    "align-items", "justify-content", "color", "font-family", "font-size",
    "font-style", "font-weight", "letter-spacing", "line-height", "text-align",
    "background-color", "background-image", "background-position",
    "background-size", "background-repeat", "border", "border-radius",
    "box-shadow", "filter", "-webkit-backdrop-filter", "backdrop-filter",
    "opacity", "content", "inset", "transform", "stroke", "stroke-width",
    "stroke-linecap", "stroke-linejoin", "fill",
  ];
  const yearStripRenderRevision = () => {
    const strip = rootYearStrip();
    if (!strip) return "";
    const entries = [YEAR_STRIP_RENDER_SCHEMA, strip.innerHTML];
    [strip, ...strip.querySelectorAll("*")].forEach((node) => {
      entries.push(node.tagName, node.className?.baseVal || node.className || "");
      ["", "::before", "::after"].forEach((pseudo) => {
        const style = getComputedStyle(node, pseudo || null);
        entries.push(pseudo);
        YEAR_STRIP_RENDER_PROPERTIES.forEach((property) => {
          entries.push(style.getPropertyValue(property));
        });
      });
    });
    return shortHash(entries.join("\u241e"));
  };
  const yearStripCaptureKey = () => [
    "calendar-strip-v3",
    currentYear,
    layoutGeometrySignature,
    Number(window.devicePixelRatio || 1).toFixed(3),
    yearStripVisualSignature(),
    yearStripRenderRevision(),
  ].join(":");
  const stripCaptureRequestState = () => {
    const surface = camera?.surface?.();
    const strip = rootYearStrip();
    const stable = !!surface
      && !!strip
      && camera?.isActive?.()
      && !camera?.isTransitioning?.()
      && !surface.hidden
      && !surface.classList.contains("fc-camera-moving")
      && layoutGeometrySignature
      && currentGeometrySignature() === layoutGeometrySignature
      && strip.isConnected
      && !strip.classList.contains("fc-year-strip-portal");
    if (!stable) return { ready:false };
    const rect = strip.getBoundingClientRect();
    const style = getComputedStyle(strip);
    const ready = rect.width >= 100
      && rect.height >= 40;
    return {
      ready,
      visible:ready
        && camera.level() === 0
        && style.visibility !== "hidden"
        && Number(style.opacity) > .99,
      captureKey:ready ? yearStripCaptureKey() : "",
      captureRevision:ready ? yearStripRenderRevision() : "",
      year:currentYear,
      level:camera.level(),
      geometry:layoutGeometrySignature,
      visualSignature:yearStripVisualSignature(),
      rect:ready ? {
        x:rect.left, y:rect.top, width:rect.width, height:rect.height,
      } : null,
      dpr:window.devicePixelRatio || 1,
    };
  };
  const stripCaptureState = () => {
    const state = stripCaptureRequestState();
    return state.ready && state.visible ? state : { ready:false };
  };
  const placeYearStripTexture = (texture, captureRect, surface) => {
    const surfaceRect = surface.getBoundingClientRect();
    Object.assign(texture.style, {
      left:`${(captureRect.x - surfaceRect.left).toFixed(2)}px`,
      top:`${(captureRect.y - surfaceRect.top).toFixed(2)}px`,
      width:`${captureRect.width.toFixed(2)}px`,
      height:`${captureRect.height.toFixed(2)}px`,
    });
  };
  const placeYearStripShadow = (shadow, stripRect, captureRect, stripStyle) => {
    const outerShadow = outerBoxShadow(stripStyle.boxShadow);
    Object.assign(shadow.style, {
      left:`${(stripRect.x - captureRect.x).toFixed(2)}px`,
      top:`${(stripRect.y - captureRect.y).toFixed(2)}px`,
      width:`${stripRect.width.toFixed(2)}px`,
      height:`${stripRect.height.toFixed(2)}px`,
      borderRadius:stripStyle.borderRadius,
      boxShadow:outerShadow,
    });
    shadow.dataset.stripOuterShadow = outerShadow;
  };
  const validateYearStripCapture = (result, expectedKey, expectedRevision) => {
    const captureRect = result?.captureRect;
    const stripRect = result?.stripRect;
    const pixelSize = result?.pixelSize;
    const numeric = [
      captureRect?.x, captureRect?.y, captureRect?.width, captureRect?.height,
      stripRect?.x, stripRect?.y, stripRect?.width, stripRect?.height,
      pixelSize?.width, pixelSize?.height, result?.dpr,
    ].map(Number);
    if (result?.ok !== true
      || result.captureKey !== expectedKey
      || result.captureRevision !== expectedRevision
      || !/^[a-z0-9]+$/i.test(String(result.captureRevision || ""))
      || typeof result.src !== "string"
      || !result.src.startsWith("data:image/png;base64,")
      || !["main", "offscreen"].includes(result.source)
      || !numeric.every(Number.isFinite)) return false;
    const dpr = Number(result.dpr);
    return captureRect.width >= stripRect.width
      && captureRect.height >= stripRect.height
      && captureRect.width <= 400
      && captureRect.height <= 220
      && stripRect.x >= captureRect.x
      && stripRect.y >= captureRect.y
      && stripRect.x + stripRect.width <= captureRect.x + captureRect.width + .1
      && stripRect.y + stripRect.height <= captureRect.y + captureRect.height + .1
      && Math.abs(dpr - Number(window.devicePixelRatio || 1)) <= .01
      && Math.abs(pixelSize.width - (captureRect.width * dpr)) <= 2
      && Math.abs(pixelSize.height - (captureRect.height * dpr)) <= 2;
  };
  const prepareYearStripTexture = (context) => {
    const surface = context?.surface;
    const strip = rootYearStrip();
    if (!surface || !strip) return null;
    const key = yearStripCaptureKey();
    const captureRevision = yearStripRenderRevision();
    let texture = yearStripTextureCache.get(key);
    if (texture?.isConnected) return texture;
    texture = document.createElement("div");
    texture.className = "fc-year-strip-texture";
    texture.setAttribute("aria-hidden", "true");
    const shadow = document.createElement("span");
    shadow.className = "fc-year-strip-texture-shadow";
    const image = document.createElement("img");
    image.className = "fc-year-strip-texture-image";
    image.alt = "";
    image.draggable = false;
    texture.append(shadow, image);
    texture.dataset.snapshotReady = "pending";
    texture.dataset.snapshotFormat = "";
    texture.dataset.snapshotForcedOpaque = "true";
    texture.dataset.stripCaptureKey = key;
    texture.dataset.stripCaptureRevision = String(captureRevision);
    texture.dataset.stripGeometry = layoutGeometrySignature;
    texture.dataset.stripVisualSignature = yearStripVisualSignature();
    const stripStyle = getComputedStyle(strip);
    surface.appendChild(texture);
    yearStripTextureCache.set(key, texture);

    const bridge = window.crmCalendarTransition?.captureStrip;
    if (typeof bridge !== "function") {
      // Browser-only development retains navigation without pretending to be
      // the Electron compositor. Native/product verification requires and
      // asserts the exact capture bridge.
      const rect = strip.getBoundingClientRect();
      const surfaceRect = surface.getBoundingClientRect();
      Object.assign(texture.style, {
        left:`${(rect.left - surfaceRect.left).toFixed(2)}px`,
        top:`${(rect.top - surfaceRect.top).toFixed(2)}px`,
        width:`${rect.width.toFixed(2)}px`,
        height:`${rect.height.toFixed(2)}px`,
      });
      placeYearStripShadow(shadow, {
        x:rect.left, y:rect.top, width:rect.width, height:rect.height,
      }, {
        x:rect.left, y:rect.top, width:rect.width, height:rect.height,
      }, stripStyle);
      texture.dataset.stripCaptureMode = "dom-fallback";
      void rasterSnapshotInto(image, strip, null, 1, null, null, {
        forceRootOpacity:true,
      }).then(() => {
        if (!texture.isConnected) return;
        [
          "snapshotReady", "snapshotFormat", "snapshotForcedOpaque",
          "snapshotPseudoCount", "snapshotControlPseudoCount",
        ].forEach((property) => {
          texture.dataset[property] = image.dataset[property] || "";
        });
        precomposeOpacity(texture, .001);
      });
      return texture;
    }

    yearStripCapturePending += 1;
    const promise = Promise.resolve()
      .then(() => bridge())
      .then(async (result) => {
        yearStripCaptureLastAudit = result?.audit || null;
        if (yearStripTextureCache.get(key) !== texture
          || !texture.isConnected
          || !validateYearStripCapture(result, key, captureRevision)) {
          throw new Error(result?.error || "Invalid Calendar strip capture");
        }
        image.src = result.src;
        await image.decode?.();
        if (yearStripTextureCache.get(key) !== texture || !texture.isConnected) return;
        if (image.naturalWidth !== Number(result.pixelSize.width)
          || image.naturalHeight !== Number(result.pixelSize.height)) {
          throw new Error("Calendar strip capture decoded at an invalid size");
        }
        const captureRect = {
          x:Number(result.captureRect.x),
          y:Number(result.captureRect.y),
          width:Number(result.captureRect.width),
          height:Number(result.captureRect.height),
        };
        const capturedStripRect = {
          x:Number(result.stripRect.x),
          y:Number(result.stripRect.y),
          width:Number(result.stripRect.width),
          height:Number(result.stripRect.height),
        };
        placeYearStripTexture(texture, captureRect, surface);
        placeYearStripShadow(shadow, capturedStripRect, captureRect, stripStyle);
        texture.dataset.snapshotReady = "true";
        texture.dataset.snapshotFormat = "png";
        texture.dataset.stripCaptureMode = "compositor";
        texture.dataset.stripCaptureRect = [
          result.captureRect.x, result.captureRect.y,
          result.captureRect.width, result.captureRect.height,
        ].join(",");
        texture.dataset.stripRect = [
          result.stripRect.x, result.stripRect.y,
          result.stripRect.width, result.stripRect.height,
        ].join(",");
        texture.dataset.stripPixelSize = [
          result.pixelSize.width, result.pixelSize.height,
        ].join("x");
        texture.dataset.stripDpr = String(result.dpr);
        texture.dataset.stripCaptureSource = result.source;
        yearStripCaptureFailureCounts.delete(key);
        yearStripCaptureLastError = "";
        precomposeOpacity(texture, .001);
      })
      .catch((error) => {
        yearStripCaptureLastError = String(error?.message || error || "Calendar strip capture failed");
        if (yearStripTextureCache.get(key) === texture) yearStripTextureCache.delete(key);
        texture.remove();
        const failures = (yearStripCaptureFailureCounts.get(key) || 0) + 1;
        yearStripCaptureFailureCounts.set(key, failures);
        if (failures < 3
          && key === yearStripCaptureKey()
          && surface.isConnected
          && camera?.isActive?.()
          && !camera?.isTransitioning?.()) {
          setTimeout(() => prepareYearStripTexture(context), 60);
        }
      })
      .finally(() => {
        yearStripCapturePending = Math.max(0, yearStripCapturePending - 1);
        if (yearStripTexturePromises.get(key) === promise) {
          yearStripTexturePromises.delete(key);
        }
      });
    yearStripTexturePromises.set(key, promise);
    return texture;
  };
  const discardYearStripTextures = () => {
    activeYearStripTexture = null;
    yearStripTextureCache.forEach((texture) => {
      texture.getAnimations?.().forEach((animation) => animation.cancel());
      texture.remove();
    });
    yearStripTextureCache.clear();
    yearStripTexturePromises.clear();
    yearStripCaptureFailureCounts.clear();
  };
  const stripCaptureDiagnostics = () => ({
    pending:yearStripCapturePending,
    lastError:yearStripCaptureLastError,
    lastAudit:yearStripCaptureLastAudit,
    cachedTextureCount:yearStripTextureCache.size,
    promiseCount:yearStripTexturePromises.size,
    failureCounts:Object.fromEntries(yearStripCaptureFailureCounts),
    textures:[...yearStripTextureCache.values()].map((texture) => ({
      connected:texture.isConnected,
      key:texture.dataset.stripCaptureKey || "",
      revision:texture.dataset.stripCaptureRevision || "",
      source:texture.dataset.stripCaptureSource || "",
      ready:texture.dataset.snapshotReady || "",
      format:texture.dataset.snapshotFormat || "",
      compositeWarm:texture.dataset.compositeWarm || "",
    })),
  });
  const invalidateYearStripVisuals = () => {
    const nextSignature = yearStripVisualSignature();
    if (nextSignature === observedYearStripVisualSignature) return;
    observedYearStripVisualSignature = nextSignature;
    const invalidation = ++yearStripVisualInvalidation;
    const apply = () => {
      if (invalidation !== yearStripVisualInvalidation) return;
      renderRevision += 1;
      deferredNavigationSequence += 1;
      discardTransitionPortal();
      discardBelowSnapshots();
      camera?.dropWarm?.();
      sourceAcrylicLens?.finish?.();
    };
    if (camera?.isTransitioning?.()) {
      void camera.whenSettled?.().then(apply);
    } else apply();
  };
  const installYearStripVisualObserver = () => {
    yearStripVisualObserver?.disconnect?.();
    observedYearStripVisualSignature = yearStripVisualSignature();
    yearStripVisualObserver = new MutationObserver(invalidateYearStripVisuals);
    const options = {
      attributes:true,
      attributeFilter:["class", "style", "data-background", "data-theme", "src"],
    };
    yearStripVisualObserver.observe(document.documentElement, options);
    yearStripVisualObserver.observe(document.body, options);
    const backdrop = document.querySelector(".workspace-photo-backdrop");
    if (backdrop) yearStripVisualObserver.observe(backdrop, options);
  };
  const MATERIAL_PROPERTIES = [
    "background-color", "background-image", "background-position", "background-size",
    "background-repeat", "background-origin", "background-clip", "border-top-width",
    "border-right-width", "border-bottom-width", "border-left-width", "border-top-style",
    "border-right-style", "border-bottom-style", "border-left-style", "border-top-color",
    "border-right-color", "border-bottom-color", "border-left-color",
    "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius",
    "border-bottom-left-radius", "box-shadow", "filter", "-webkit-backdrop-filter",
    "backdrop-filter", "clip-path", "-webkit-clip-path", "mix-blend-mode",
  ];
  const copyExactMaterial = (destination, source) => {
    if (!destination || !source) return false;
    const computed = getComputedStyle(source);
    MATERIAL_PROPERTIES.forEach((property) => {
      const value = computed.getPropertyValue(property);
      if (value) destination.style.setProperty(property, value);
    });
    destination.dataset.materialBackdrop = computed.webkitBackdropFilter
      || computed.backdropFilter
      || "none";
    destination.dataset.materialSourceClass = String(source.className || source.tagName || "");
    return true;
  };
  const suspendMaterialBackdrop = (material) => {
    if (!material) return null;
    const properties = ["filter", "-webkit-backdrop-filter", "backdrop-filter"];
    const state = properties.map((property) => ({
      property,
      value:material.style.getPropertyValue(property),
      priority:material.style.getPropertyPriority(property),
    }));
    properties.forEach((property) => material.style.setProperty(property, "none", "important"));
    material.dataset.materialBackdropSuspended = "true";
    return state;
  };
  const restoreMaterialBackdrop = (material, state) => {
    if (!material || !state) return;
    state.forEach(({ property, value, priority }) => {
      if (value) material.style.setProperty(property, value, priority);
      else material.style.removeProperty(property);
    });
    material.dataset.materialBackdropSuspended = "false";
  };
  const holdTransitionAcrylicLens = () => {
    const lens = sourceAcrylicLens?.element?.();
    if (!lens) return;
    lens.getAnimations?.().forEach((animation) => {
      const keyframes = animation.effect?.getKeyframes?.() || [];
      const animatesOpacity = keyframes.some((frame) => Object.hasOwn(frame, "opacity"));
      const animatesClip = keyframes.some((frame) => (
        Object.hasOwn(frame, "clipPath") || Object.hasOwn(frame, "webkitClipPath")
      ));
      if (animatesOpacity && !animatesClip) animation.cancel();
    });
    lens.style.opacity = "1";
    lens.dataset.materialOwnership = "transition";
  };
  const holdTransitionProbePhase = (direction, context) => {
    const probe = window.__crmCalendarTransitionProbe;
    if (!probe || typeof probe.hold !== "function") return;
    const phase = Number(probe.phase);
    if (!Number.isFinite(phase) || phase <= 0 || phase >= 1) return;
    // This seam is inert outside the native visual profiler. It freezes the
    // already-composited transition at one exact direction-normalized phase,
    // allowing a screenshot to be sampled without lengthening product timing.
    requestAnimationFrame(() => {
      if (window.__crmCalendarTransitionProbe !== probe
        || !context.surface?.classList?.contains("fc-camera-moving")) return;
      void (async () => {
        const rawPhase = direction === "contract" ? 1 - phase : phase;
        const moving = [...context.surface.querySelectorAll(
          ":scope > .fc-expander:not(.fc-warm):not(.fc-camera-below)",
        )].at(-1);
        const targetEntries = [
          ["moving", moving],
          ["preview", moving?.querySelector(":scope > .fc-transition-preview")],
          ["portal", context.surface.querySelector(":scope > .fc-transition-portal")],
          ["snapshot", context.surface.querySelector(":scope > .fc-below-snapshot.is-active")],
          ["below-material", context.surface.querySelector(
            ":scope > .fc-level-material.is-below-material,"
            + ":scope > .fc-below-material-scene.is-below-material",
          )],
          ...(context.surface.querySelector(":scope > .fc-year-strip-texture.is-active")
            ? [["strip", context.surface.querySelector(
              ":scope > .fc-year-strip-texture.is-active",
            )]]
            : []),
          ["lens", context.surface.querySelector(":scope > .fc-source-screen-acrylic")],
        ];
        const targetAnimations = targetEntries.map(([role, target]) => ({
          role,
          target,
          animations:[...(target?.getAnimations?.() || [])].filter((animation) => {
            const duration = Number(animation.effect?.getComputedTiming?.().duration);
            return Number.isFinite(duration) && Math.abs(duration - MORPH_MS) <= 1;
          }),
        }));
        const invalidTargets = targetAnimations.filter(({ role, target, animations }) => (
          !target || animations.length !== (role === "below-material" ? 0 : 1)
        ));
        if (invalidTargets.length) {
          try {
            probe.failed?.(probe.name || "phase", {
              direction,
              phase,
              rawPhase,
              targetAudit:targetAnimations.map(({ role, target, animations }) => ({
                role,
                present:!!target,
                animationCount:animations.length,
              })),
            });
          } catch {}
          return;
        }
        const animations = targetAnimations.flatMap(({ animations:owned }) => owned);
        context.surface.dataset.fractalCameraProbeHold = "true";
        animations.forEach((animation) => animation.pause());
        await Promise.allSettled(animations.map((animation) => animation.ready));
        animations.forEach((animation) => {
          const duration = Number(animation.effect?.getComputedTiming?.().duration);
          animation.currentTime = rawPhase * duration;
        });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const animationDetails = animations.map((animation) => {
          const timing = animation.effect?.getComputedTiming?.();
          const duration = Number(timing?.duration);
          const currentTime = Number(animation.currentTime);
          return {
            name:animation.animationName || "",
            property:animation.transitionProperty || "",
            target:String(animation.effect?.target?.className
              || animation.effect?.target?.nodeName || ""),
            duration,
            currentTime,
            timeFraction:duration > 0 ? currentTime / duration : null,
            easedProgress:Number(timing?.progress),
            easing:String(animation.effect?.getTiming?.().easing || ""),
          };
        });
        // getComputedTiming().progress includes each animation's easing
        // (the transform is intentionally ~.973 at 50% wall time). The
        // coherent cross-animation phase is normalized local active time.
        const phaseVerified = animationDetails.every(({ timeFraction }) => (
          Number.isFinite(timeFraction) && Math.abs(timeFraction - rawPhase) <= .002
        ));
        const movingState = context.surface.classList.contains("fc-camera-moving")
          && !!context.api?.isTransitioning?.();
        const pausedCount = animations.filter((animation) => animation.playState === "paused").length;
        if (!phaseVerified) {
          delete context.surface.dataset.fractalCameraProbeHold;
          try {
            probe.failed?.(probe.name || "phase", {
              direction,
              phase,
              rawPhase,
              moving:movingState,
              pausedCount,
              animations:animationDetails,
            });
          } catch {}
          animations.forEach((animation) => {
            try { animation.play(); } catch {}
          });
          return;
        }
        const detail = {
          direction,
          phase,
          rawPhase,
          phaseVerified,
          moving:movingState,
          pausedCount,
          animationCount:animations.length,
          targetRoles:targetAnimations.map(({ role }) => role),
          animations:animationDetails,
        };
        try {
          await Promise.resolve(probe.hold(probe.name || "phase", detail));
        } catch {}
        const prematureSettlement = !context.api?.isTransitioning?.()
          || !context.surface.classList.contains("fc-camera-moving");
        if (prematureSettlement) {
          animations.forEach((animation) => animation.cancel());
          delete context.surface.dataset.fractalCameraProbeHold;
          try {
            probe.resumed?.(probe.name || "phase", {
              direction,
              phase,
              animationCount:animations.length,
              awaitedCount:0,
              fulfilledCount:0,
              settledPaints:0,
              prematureSettlement:true,
              settledCamera:!context.api?.isTransitioning?.(),
            });
          } catch {}
          return;
        }
        const completions = [];
        animations.forEach((animation) => {
          try {
            animation.play();
            completions.push(animation.finished);
          } catch {
            completions.push(Promise.reject(new Error("animation resume failed")));
          }
        });
        const results = await Promise.allSettled(completions);
        delete context.surface.dataset.fractalCameraProbeHold;
        await context.api?.whenSettled?.();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const visible = (node) => {
          if (!node?.isConnected) return false;
          let opacity = 1;
          let cursor = node;
          while (cursor && cursor.nodeType === Node.ELEMENT_NODE) {
            const cursorStyle = getComputedStyle(cursor);
            if (cursorStyle.display === "none" || cursorStyle.visibility !== "visible") return false;
            opacity *= Number(cursorStyle.opacity);
            if (cursor === context.surface) break;
            cursor = cursor.parentElement;
          }
          const rect = node.getBoundingClientRect();
          return opacity > .01 && rect.width > 1 && rect.height > 1;
        };
        const staleVisible = {
          previews:[...context.surface.querySelectorAll(".fc-transition-preview")].filter(visible).length,
          portals:[...context.surface.querySelectorAll(":scope > .fc-transition-portal")].filter(visible).length,
          overlays:[...context.surface.querySelectorAll(
            ":scope > .fc-source-screen-acrylic,"
            + ":scope > .fc-below-snapshot,"
            + ":scope > .is-suspended-destination-material",
          )].filter(visible).length,
          stripPortals:context.surface.querySelectorAll(
            ":scope > .fc-year-strip.fc-year-strip-portal",
          ).length,
        };
        try {
          probe.resumed?.(probe.name || "phase", {
            direction,
            phase,
            animationCount:animations.length,
            awaitedCount:results.length,
            fulfilledCount:results.filter((result) => result.status === "fulfilled").length,
            settledPaints:2,
            prematureSettlement:false,
            settledCamera:!context.api?.isTransitioning?.()
              && !context.surface.classList.contains("fc-camera-moving"),
            staleVisible,
          });
        } catch {}
      })();
    });
  };
  const placeFixedMaterial = (node, source, surface) => {
    if (!node || !source || !surface) return;
    const rect = source.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    Object.assign(node.style, {
      left:`${(rect.left - surfaceRect.left).toFixed(2)}px`,
      top:`${(rect.top - surfaceRect.top).toFixed(2)}px`,
      width:`${rect.width.toFixed(2)}px`,
      height:`${rect.height.toFixed(2)}px`,
    });
  };
  const roundedRectMaterialPath = (source, surface) => {
    const rect = source.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    const style = getComputedStyle(source);
    const x = rect.left - surfaceRect.left;
    const y = rect.top - surfaceRect.top;
    const width = rect.width;
    const height = rect.height;
    const radius = Math.min(
      width / 2,
      height / 2,
      Math.max(0, parseFloat(style.borderTopLeftRadius) || 0),
    );
    return [
      `M ${(x + radius).toFixed(2)} ${y.toFixed(2)}`,
      `L ${(x + width - radius).toFixed(2)} ${y.toFixed(2)}`,
      `A ${radius.toFixed(2)} ${radius.toFixed(2)} 0 0 1 ${(x + width).toFixed(2)} ${(y + radius).toFixed(2)}`,
      `L ${(x + width).toFixed(2)} ${(y + height - radius).toFixed(2)}`,
      `A ${radius.toFixed(2)} ${radius.toFixed(2)} 0 0 1 ${(x + width - radius).toFixed(2)} ${(y + height).toFixed(2)}`,
      `L ${(x + radius).toFixed(2)} ${(y + height).toFixed(2)}`,
      `A ${radius.toFixed(2)} ${radius.toFixed(2)} 0 0 1 ${x.toFixed(2)} ${(y + height - radius).toFixed(2)}`,
      `L ${x.toFixed(2)} ${(y + radius).toFixed(2)}`,
      `A ${radius.toFixed(2)} ${radius.toFixed(2)} 0 0 1 ${(x + radius).toFixed(2)} ${y.toFixed(2)} Z`,
    ].join(" ");
  };
  const appendBackdropUnion = (scene, owners, surface) => {
    if (!scene || !owners?.length || !surface) return null;
    const source = owners[0];
    const computed = getComputedStyle(source);
    const backdrop = computed.webkitBackdropFilter || computed.backdropFilter || "none";
    const piece = document.createElement("span");
    piece.className = "fc-below-material-piece fc-below-material-union fc-below-material-base-union";
    piece.dataset.materialRole = "base";
    piece.dataset.materialBounded = "false";
    piece.dataset.materialBackdrop = backdrop;
    piece.dataset.materialOwnerCount = String(owners.length);
    piece.dataset.materialSourceClass = `${owners.length}x ${String(source.className || source.tagName || "")}`;
    Object.assign(piece.style, {
      inset:"0",
      backgroundColor:"transparent",
      backgroundImage:"none",
      border:"0",
      boxShadow:"none",
      filter:computed.filter || "none",
      webkitBackdropFilter:backdrop,
      backdropFilter:backdrop,
      clipPath:`path('${owners.map((owner) => roundedRectMaterialPath(owner, surface)).join(" ")}')`,
      webkitClipPath:`path('${owners.map((owner) => roundedRectMaterialPath(owner, surface)).join(" ")}')`,
    });
    scene.appendChild(piece);
    return piece;
  };
  const placeViewportMaterial = (node, context) => {
    const surface = context?.surface;
    const viewport = context?.expRect?.();
    if (!node || !surface || !viewport) return;
    const surfaceRect = surface.getBoundingClientRect();
    Object.assign(node.style, {
      left:`${(viewport.x - surfaceRect.left).toFixed(2)}px`,
      top:`${(viewport.y - surfaceRect.top).toFixed(2)}px`,
      width:`${viewport.w.toFixed(2)}px`,
      height:`${viewport.h.toFixed(2)}px`,
    });
  };
  const removeLevelMaterial = (owner) => {
    const material = levelMaterialByOwner.get(owner);
    material?.remove?.();
    levelMaterialByOwner.delete(owner);
    owner?.classList?.remove?.("fc-material-externalized");
  };
  const ensureMaterialCleanupObserver = (surface) => {
    if (materialCleanupObserver || !surface) return;
    materialCleanupObserver = new MutationObserver(() => {
      levelMaterialByOwner.forEach((_material, owner) => {
        if (!owner.isConnected) removeLevelMaterial(owner);
      });
      if (sourceAcrylicLens?.element?.()?.isConnected
        && !surface.querySelector(":scope > .fc-source-acrylic-owner")) {
        sourceAcrylicLens.finish();
      }
    });
    materialCleanupObserver.observe(surface, { childList:true });
  };
  const prepareLevelMaterial = (owner, context) => {
    const surface = context?.surface;
    if (!owner || !surface || !owner.isConnected) return null;
    ensureMaterialCleanupObserver(surface);
    let material = levelMaterialByOwner.get(owner);
    // Read the canonical crm-menu-surface before making its moving DOM
    // objects-only. This is an exact computed-material transfer, not a
    // hand-matched tint.
    owner.classList.remove("fc-material-externalized");
    if (!material?.isConnected) {
      material = document.createElement("span");
      material.className = "fc-level-material";
      material.setAttribute("aria-hidden", "true");
      material.dataset.materialOwner = owner.dataset.kind || "level";
      surface.appendChild(material);
      levelMaterialByOwner.set(owner, material);
    }
    copyExactMaterial(material, owner);
    placeViewportMaterial(material, context);
    if (!material.dataset.compositeWarm) {
      material.style.opacity = ".001";
      precomposeOpacity(material, .001);
    }
    owner.classList.add("fc-material-externalized");
    return material;
  };
  const materialSceneOwners = (source) => {
    if (!source?.below) return [];
    if (source.below.dataset?.kind) return [];
    return [source.below, ...source.below.querySelectorAll("*")].filter((node) => {
      if (!node || node === source.selected || source.selected?.contains?.(node)) return false;
      if (node.matches?.(".fc-year-strip") || node.closest?.(".fc-year-strip")) return false;
      const computed = getComputedStyle(node);
      return node.matches?.(".crm-menu-surface,.fc-frost")
        || [computed.filter, computed.webkitBackdropFilter, computed.backdropFilter]
          .some((value) => value && value !== "none");
    });
  };
  const prepareBelowMaterial = (source, context) => {
    const surface = context?.surface;
    if (!source || !surface) return null;
    if (source.below.dataset?.kind) {
      const material = prepareLevelMaterial(source.below, context);
      if (material) material.dataset.materialBelowKey = source.key;
      return material;
    }
    let scene = belowMaterialCache.get(source.key);
    if (!scene?.isConnected) {
      scene = document.createElement("div");
      scene.className = "fc-below-material-scene";
      scene.setAttribute("aria-hidden", "true");
      scene.dataset.materialKey = source.key;
      const owners = materialSceneOwners(source);
      const frostOwners = owners.filter((owner) => owner.matches?.(".fc-frost"));
      const canonicalOwners = owners.filter((owner) => !frostOwners.includes(owner));
      scene.dataset.materialOwnerCount = String(owners.length);
      // Frost remains its exact 28px recipe. The eleven unselected month
      // surfaces share one canonical 26px union. The year strip is excluded:
      // its exact nested acrylic is supplied by the compositor capture, so
      // root motion owns two resting filters plus one transition lens.
      frostOwners.forEach((owner) => {
        const piece = document.createElement("span");
        piece.className = "fc-below-material-piece";
        copyExactMaterial(piece, owner);
        piece.dataset.materialOwnerCount = "1";
        placeFixedMaterial(piece, owner, surface);
        scene.appendChild(piece);
      });
      appendBackdropUnion(scene, canonicalOwners, surface);
      scene.dataset.materialPieceCount = String(scene.childElementCount);
      surface.appendChild(scene);
      scene.style.opacity = ".001";
      precomposeOpacity(scene, .001);
      belowMaterialCache.set(source.key, scene);
    }
    return scene;
  };
  const transitionOwner = (direction, context) => (
    direction === "contract"
      ? context.layers?.[context.level]
      : [...(context.surface?.querySelectorAll?.(":scope > .fc-expander:not(.fc-warm):not(.fc-camera-below)") || [])].at(-1)
  );
  const stageTransitionMaterials = (direction, context) => {
    const owner = transitionOwner(direction, context);
    const destination = prepareLevelMaterial(owner, context);
    const source = belowSnapshotSource(direction, context);
    const belowMaterial = prepareBelowMaterial(source, context);
    activeDestinationBackdropState = null;
    [destination, belowMaterial].forEach((node) => {
      if (!node) return;
      settlePrecomposedOpacity(node);
      node.classList.remove(
        "is-destination-material", "is-suspended-destination-material", "is-below-material",
      );
      node.style.removeProperty("animation");
    });
    if (destination) {
      destination.classList.add("is-suspended-destination-material");
      destination.style.zIndex = "4";
      destination.style.opacity = "0";
      activeDestinationBackdropState = suspendMaterialBackdrop(destination);
    }
    if (belowMaterial) {
      belowMaterial.classList.add("is-below-material");
      belowMaterial.style.zIndex = "2";
      // Keep the lower screen-space filters fully active. Animating opacity
      // on their common parent creates a backdrop root, preventing the child
      // blur recipes from sampling the wallpaper. The single moving lens
      // already occludes/reveals this exact resting material continuously.
      belowMaterial.style.opacity = "1";
    }
    settlePrecomposedOpacity(sourceAcrylicLens?.element?.());
    holdTransitionAcrylicLens();
    activeDestinationMaterial = destination;
    activeDestinationOwner = owner;
    activeBelowMaterial = belowMaterial;
  };
  const finishTransitionMaterials = (direction) => {
    if (activeDestinationMaterial) {
      activeDestinationMaterial.getAnimations?.().forEach((animation) => animation.cancel());
      // Restore the resting filter and make it opaque before removing the
      // identical full-viewport transition lens. Both writes occur in this
      // task, so no paint can observe a gap or two live backdrop owners.
      restoreMaterialBackdrop(activeDestinationMaterial, activeDestinationBackdropState);
      activeDestinationMaterial.classList.remove(
        "is-destination-material", "is-suspended-destination-material",
      );
      activeDestinationMaterial.style.animation = "none";
      activeDestinationMaterial.style.zIndex = "2";
      activeDestinationMaterial.style.opacity = direction === "expand" ? "1" : "0";
    }
    if (activeBelowMaterial) {
      activeBelowMaterial.getAnimations?.().forEach((animation) => animation.cancel());
      activeBelowMaterial.classList.remove("is-below-material");
      activeBelowMaterial.style.animation = "none";
      activeBelowMaterial.style.zIndex = "2";
      // Root owns its material when it is resting; expanded levels externalize
      // the same material permanently to this fixed sibling. A lower expanded
      // level stays released while its owner DOM is hidden; it returns to one
      // only when contraction makes that level the resting destination.
      const isRootScene = activeBelowMaterial.classList.contains("fc-below-material-scene");
      activeBelowMaterial.style.opacity = (!isRootScene && direction === "contract") ? "1" : "0";
    }
    if (direction === "contract") removeLevelMaterial(activeDestinationOwner);
    activeDestinationMaterial = null;
    activeDestinationOwner = null;
    activeDestinationBackdropState = null;
    activeBelowMaterial = null;
    sourceAcrylicLens?.finish?.();
  };
  const captureInlineProperty = (node, property) => ({
    property,
    value:node.style.getPropertyValue(property),
    priority:node.style.getPropertyPriority(property),
  });
  const restoreInlineProperties = (node, properties = []) => {
    properties.forEach(({ property, value, priority }) => {
      if (value) node.style.setProperty(property, value, priority);
      else node.style.removeProperty(property);
    });
  };
  const finishYearStripPortal = () => {
    const texture = activeYearStripTexture;
    activeYearStripTexture = null;
    if (texture) {
      texture.getAnimations?.().forEach((animation) => animation.cancel());
      texture.classList.remove("is-active");
      texture.style.animation = "none";
      texture.style.opacity = "0";
      delete texture.dataset.portalDirection;
      delete texture.dataset.stripSourceIdentity;
    }
    const state = activeYearStripPortalState;
    const strip = activeYearStripPortal;
    activeYearStripPortal = null;
    activeYearStripPortalState = null;
    if (!strip || !state) return;
    strip.getAnimations?.().forEach((animation) => animation.cancel());
    strip.classList.remove("fc-year-strip-portal");
    delete strip.dataset.portalDirection;
    delete strip.dataset.portalGeometryStable;
    restoreInlineProperties(strip, state.inlineProperties);
    if (state.anchor?.parentNode) {
      state.anchor.parentNode.insertBefore(strip, state.anchor);
    } else if (state.parent?.isConnected) {
      const before = state.nextSibling?.parentNode === state.parent ? state.nextSibling : null;
      state.parent.insertBefore(strip, before);
    } else {
      strip.remove();
    }
    state.anchor?.remove?.();
  };
  const stageYearStripPortal = (direction, context) => {
    finishYearStripPortal();
    const source = belowSnapshotSource(direction, context);
    if (!source || source.below.dataset?.kind) return null;
    const strip = source.below.querySelector?.(":scope > .fc-year-strip");
    const surface = context?.surface;
    if (!strip || !surface) return null;
    const texture = yearStripTextureCache.get(yearStripCaptureKey());
    if (!texture?.isConnected
      || texture.dataset.snapshotReady !== "true"
      || texture.dataset.snapshotFormat !== "png"
      || texture.dataset.compositeWarm !== "true") return null;
    const anchor = document.createComment("fc-year-strip-anchor");
    const parent = strip.parentNode;
    const nextSibling = strip.nextSibling;
    const beforeRect = strip.getBoundingClientRect();
    parent.insertBefore(anchor, strip);
    const inlineProperties = ["animation", "z-index"].map((property) => (
      captureInlineProperty(strip, property)
    ));
    strip.dataset.stripIdentity ||= shortHash(
      `${currentYear}:${performance.timeOrigin}:${beforeRect.left}:${beforeRect.width}`,
    );
    strip.getAnimations?.().forEach((animation) => animation.cancel());
    strip.classList.add("fc-year-strip-portal");
    strip.dataset.portalDirection = direction;
    strip.style.animation = "none";
    strip.style.zIndex = "11";
    surface.appendChild(strip);
    const afterRect = strip.getBoundingClientRect();
    strip.dataset.portalGeometryStable = String(
      Math.abs(afterRect.left - beforeRect.left) <= .1
      && Math.abs(afterRect.top - beforeRect.top) <= .1
      && Math.abs(afterRect.width - beforeRect.width) <= .1
      && Math.abs(afterRect.height - beforeRect.height) <= .1
    );
    settlePrecomposedOpacity(texture);
    texture.getAnimations?.().forEach((animation) => animation.cancel());
    texture.classList.add("is-active");
    texture.dataset.portalDirection = direction;
    texture.dataset.stripSourceIdentity = strip.dataset.stripIdentity;
    texture.style.animation = "none";
    texture.style.opacity = direction === "expand" ? "1" : "0";
    activeYearStripPortal = strip;
    activeYearStripTexture = texture;
    activeYearStripPortalState = {
      strip,
      anchor,
      parent,
      nextSibling,
      inlineProperties,
    };
    return texture;
  };
  const startYearStripPortal = () => {
    activeYearStripTexture?.style?.removeProperty?.("animation");
  };
  const cancelHistoricalTransitionFills = (surface) => {
    surface?.querySelectorAll?.(
      ".fc-transition-preview,.fc-transition-portal,.fc-below-snapshot,.fc-year-strip-texture,"
      + ".fc-level-material,.fc-below-material-scene",
    )?.forEach?.((node) => {
      node.getAnimations?.().forEach((animation) => {
        if (String(animation.animationName || "").startsWith("fc-")) animation.cancel();
      });
    });
  };
  const discardLevelMaterials = () => {
    materialCleanupObserver?.disconnect?.();
    materialCleanupObserver = null;
    levelMaterialByOwner.forEach((material, owner) => {
      material.remove();
      owner?.classList?.remove?.("fc-material-externalized");
    });
    levelMaterialByOwner.clear();
    belowMaterialCache.forEach((scene) => scene.remove());
    belowMaterialCache.clear();
    activeBelowMaterial = null;
    activeDestinationMaterial = null;
    activeDestinationOwner = null;
    activeDestinationBackdropState = null;
    sourceAcrylicLens?.finish?.();
  };
  const transitionPreview = (target, context) => {
    const preview = document.createElement("img");
    preview.className = "fc-transition-preview";
    preview.setAttribute("aria-hidden", "true");
    preview.alt = "";
    preview.draggable = false;
    preview.dataset.transitionSource = transitionSourceKey(target);
    preview.dataset.transitionRevision = String(renderRevision);
    preview.dataset.transitionGeometry = layoutGeometrySignature;
    const E = context?.expRect?.();
    void rasterSnapshotInto(preview, target, null, 1, E?.w, E?.h, {
      materialFreeRoot:true,
      forceRootOpacity:true,
    });
    return preview;
  };
  const syncTransitionPreview = (expander, target, context) => {
    let preview = expander.querySelector(":scope > .fc-transition-preview");
    const sourceKey = transitionSourceKey(target);
    if (!preview || preview.dataset.transitionSource !== sourceKey
      || preview.dataset.transitionRevision !== String(renderRevision)
      || preview.dataset.transitionGeometry !== layoutGeometrySignature) {
      const next = transitionPreview(target, context);
      if (preview) preview.replaceWith(next);
      else expander.insertBefore(next, expander.querySelector(":scope > .fc-expander-live"));
      preview = next;
    }
    const E = context.expRect();
    const source = context.sourceRect;
    const kx = E.w / Math.max(1, source.w);
    const ky = E.h / Math.max(1, source.h);
    Object.assign(preview.style, {
      left: "0px",
      top: "0px",
      width: `${source.w.toFixed(3)}px`,
      height: `${source.h.toFixed(3)}px`,
      transform: `scale(${kx.toFixed(5)}, ${ky.toFixed(5)})`,
    });
  };
  const buildExpander = (target, context) => {
    const isMonth = context.level === 0;
    const expander = document.createElement("div");
    expander.className = "fc-bucket fc-expander crm-menu-surface";
    expander.dataset.kind = isMonth ? "month" : "day";
    expander.appendChild(transitionPreview(target, context));
    const live = document.createElement("div");
    live.className = "fc-expander-live";
    if (isMonth) {
      expander.dataset.month = target.dataset.month;
      live.innerHTML = monthInnerHTML(Number(target.dataset.month) - 1);
    } else {
      expander.dataset.date = target.dataset.date;
      live.innerHTML = dayInnerHTML(target.dataset.date);
    }
    expander.appendChild(live);
    return expander;
  };
  const configureExpander = (expander, target, context) => {
    const E = context.expRect();
    const b = context.sourceRect;
    const geometryKey = [
      transitionSourceKey(target), renderRevision,
      E.w.toFixed(2), E.h.toFixed(2), b.w.toFixed(2), b.h.toFixed(2),
    ].join("|");
    if (context.direction === "contract") target.classList.add("fc-camera-target");
    const sourceMaterial = sourceAcrylicLens?.prepare?.(expander, target, context);
    if (sourceMaterial) {
      const sourceStyle = getComputedStyle(target);
      sourceMaterial.dataset.materialSourceClass = String(target.className || target.tagName || "");
      sourceMaterial.dataset.materialBackdrop = sourceStyle.webkitBackdropFilter
        || sourceStyle.backdropFilter
        || "none";
      // The decoded source texture already owns its literal edge and shadow.
      // Keep the fixed lens to fill/backdrop only so those edges are never
      // double-painted as the clip approaches the viewport.
      sourceMaterial.style.borderStyle = "none";
      sourceMaterial.style.boxShadow = "none";
    }
    if (expander.isConnected) prepareLevelMaterial(expander, context);
    // Hover precomposition already prepared this exact source/destination
    // pair. Reapplying inherited scale variables or frame paint on click would
    // invalidate both transition textures immediately before motion.
    if (expander.dataset.transitionGeometry === geometryKey) return;
    expander.dataset.transitionGeometry = geometryKey;
    expander.style.setProperty("--kx", (E.w / b.w).toFixed(4));
    expander.style.setProperty("--ky", (E.h / b.h).toFixed(4));
    expander.style.setProperty("--fractal-camera-morph-ms", `${MORPH_MS}ms`);
    syncTransitionPreview(expander, target, context);
  };
  const discardTransitionPortal = () => {
    transitionPortal?.remove?.();
    transitionPortal = null;
    transitionPortalOwner = null;
  };
  const prepareTransitionPortal = (expander, context) => {
    const surface = context?.surface;
    const live = expander?.querySelector?.(":scope > .fc-expander-live");
    if (!surface || !expander || !live) return null;
    if (transitionPortalOwner === expander
      && transitionPortal?.isConnected
      && transitionPortal.dataset.transitionGeometry === layoutGeometrySignature) {
      return transitionPortal;
    }
    discardTransitionPortal();
    const E = context.expRect();
    const portal = document.createElement("img");
    portal.className = "fc-transition-portal";
    portal.dataset.kind = expander.dataset.kind || "";
    portal.dataset.transitionSource = expander.querySelector(
      ":scope > .fc-transition-preview",
    )?.dataset.transitionSource || "";
    portal.dataset.transitionGeometry = layoutGeometrySignature;
    portal.setAttribute("aria-hidden", "true");
    portal.alt = "";
    portal.draggable = false;
    void rasterSnapshotInto(portal, live, null, .001, null, null, {
      forceRootOpacity:true,
    });
    Object.assign(portal.style, {
      left: `${E.x}px`,
      top: `${E.y}px`,
      width: `${E.w}px`,
      height: `${E.h}px`,
      opacity: "0",
    });
    surface.appendChild(portal);
    transitionPortal = portal;
    transitionPortalOwner = expander;
    return portal;
  };
  const stageTransitionPortal = (direction, context) => {
    const surface = context.surface;
    const expander = direction === "contract"
      ? context.layers?.[context.level]
      : [...(surface?.querySelectorAll?.(":scope > .fc-expander:not(.fc-warm):not(.fc-camera-below)") || [])].at(-1);
    const portal = prepareTransitionPortal(expander, context);
    const live = expander?.querySelector?.(":scope > .fc-expander-live");
    if (!portal || !live) return;
    settlePrecomposedOpacity(portal);
    settlePrecomposedOpacity(expander.querySelector(":scope > .fc-transition-preview"));
    portal.style.removeProperty("animation");
    live.style.visibility = "hidden";
    portal.style.opacity = direction === "expand" ? "0" : "1";
  };
  const finishTransitionPortal = (direction, context) => {
    const owner = transitionPortalOwner;
    owner?.querySelector?.(":scope > .fc-expander-live")?.style?.removeProperty?.("visibility");
    transitionPortal?.getAnimations?.().forEach((animation) => animation.cancel());
    if (direction === "expand" && transitionPortal?.isConnected) {
      transitionPortal.style.animation = "none";
      transitionPortal.style.opacity = "0";
      return;
    }
    discardTransitionPortal();
    if (direction === "contract" && context.level > 0) {
      prepareTransitionPortal(context.layers?.[context.level], context);
    }
  };
  const belowSnapshotSource = (direction, context, selectedTarget = null) => {
    const below = direction === "contract"
      ? context.layers?.[context.level - 1]
      : context.layers?.[context.level];
    if (!below) return null;
    const content = below.dataset?.kind
      ? below.querySelector?.(":scope > .fc-expander-live")
      : below;
    if (!content) return null;
    const selected = content.contains(selectedTarget)
      ? selectedTarget
      : content.querySelector?.(".fc-camera-target");
    const prefix = below.dataset?.kind === "month"
      ? `month:${below.dataset.month || ""}:${renderRevision}`
      : `year:${currentYear}:${renderRevision}`;
    const key = `${prefix}:${layoutGeometrySignature}:${transitionSourceKey(selected)}`;
    return { below, content, selected, prefix, key };
  };
  const prepareBelowSnapshot = (direction, context, selectedTarget = null) => {
    const source = belowSnapshotSource(direction, context, selectedTarget);
    const surface = context?.surface;
    if (!source || !surface) return null;
    belowSnapshotCache.forEach((candidate, key) => {
      if (key !== source.key && key.startsWith(`${source.prefix}:`)) {
        candidate.remove();
        belowSnapshotCache.delete(key);
      }
    });
    belowMaterialCache.forEach((candidate, key) => {
      if (key !== source.key && key.startsWith(`${source.prefix}:`)) {
        candidate.remove();
        belowMaterialCache.delete(key);
      }
    });
    let snapshot = belowSnapshotCache.get(source.key);
    if (!snapshot?.isConnected) {
      snapshot = document.createElement("img");
      snapshot.className = "fc-below-snapshot";
      snapshot.alt = "";
      snapshot.draggable = false;
      snapshot.dataset.snapshotKey = source.key;
      snapshot.dataset.snapshotSelectedKey = transitionSourceKey(source.selected);
      snapshot.dataset.snapshotGeometry = layoutGeometrySignature;
      surface.appendChild(snapshot);
      void rasterSnapshotInto(snapshot, source.content, source.selected, .001, null, null, {
        materialFreeScene:!source.below.dataset?.kind,
        forceRootOpacity:true,
        hideYearStrip:!source.below.dataset?.kind,
      });
      belowSnapshotCache.set(source.key, snapshot);
    }
    const rect = source.content.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    Object.assign(snapshot.style, {
      left:`${(rect.left - surfaceRect.left).toFixed(2)}px`,
      top:`${(rect.top - surfaceRect.top).toFixed(2)}px`,
      width:`${rect.width.toFixed(2)}px`,
      height:`${rect.height.toFixed(2)}px`,
    });
    prepareBelowMaterial(source, context);
    if (!source.below.dataset?.kind) prepareYearStripTexture(context);
    return snapshot;
  };
  const stageBelowSnapshot = (direction, context) => {
    const snapshot = prepareBelowSnapshot(direction, context);
    belowSnapshotCache.forEach((candidate) => candidate.classList.toggle("is-active", candidate === snapshot));
    if (snapshot) {
      settlePrecomposedOpacity(snapshot);
      snapshot.style.removeProperty("animation");
      snapshot.style.opacity = direction === "expand" ? "1" : "0";
    }
    activeBelowSnapshot = snapshot;
  };
  const finishBelowSnapshot = () => {
    belowSnapshotCache.forEach((snapshot) => {
      snapshot.getAnimations?.().forEach((animation) => animation.cancel());
      snapshot.classList.remove("is-active");
      snapshot.style.animation = "none";
      snapshot.style.opacity = "0";
    });
    activeBelowSnapshot = null;
  };
  const discardBelowSnapshots = () => {
    finishYearStripPortal();
    belowSnapshotCache.forEach((snapshot) => snapshot.remove());
    belowSnapshotCache.clear();
    belowMaterialCache.forEach((scene) => scene.remove());
    belowMaterialCache.clear();
    discardYearStripTextures();
    activeBelowSnapshot = null;
    activeBelowMaterial = null;
  };
  const setGeometryReady = (ready, surface = camera?.surface?.()) => {
    geometryReady = !!ready;
    if (surface) surface.dataset.geometryReady = String(geometryReady);
    if (!geometryReady) return;
    const waiters = geometryReadyWaiters;
    geometryReadyWaiters = [];
    waiters.forEach((resolve) => resolve(true));
  };
  const whenGeometryReady = () => (
    geometryReady
      ? Promise.resolve(true)
      : new Promise((resolve) => geometryReadyWaiters.push(resolve))
  );
  const currentGeometrySignature = () => {
    const viewport = camera?.expRect?.();
    if (!viewport) return "";
    return [
      window.innerWidth, window.innerHeight,
      viewport.x.toFixed(2), viewport.y.toFixed(2),
      viewport.w.toFixed(2), viewport.h.toFixed(2),
    ].join("|");
  };
  const synchronizeGeometryState = () => {
    // Chromium may expose the new viewport metrics one task before dispatching
    // its resize event. Any readiness read or navigation attempt in that task
    // must invalidate the old decoded geometry before it can be observed.
    if (camera && layoutGeometrySignature
      && currentGeometrySignature() !== layoutGeometrySignature) {
      camera.layout?.();
    }
    return geometryReady;
  };
  const waitForGeometryTextures = (nodes, revision) => new Promise((resolve) => {
    let frames = 0;
    const tick = () => {
      if (revision !== geometryRefreshRevision) { resolve(false); return; }
      const ready = nodes.filter(Boolean).every((node) => (
        node.isConnected
        && (!node.matches?.("img") || node.dataset.snapshotReady === "true")
        && node.dataset.compositeWarm === "true"
      ));
      if (ready) { resolve(true); return; }
      frames += 1;
      if (frames > 900) { resolve(false); return; }
      requestAnimationFrame(tick);
    };
    tick();
  });
  const yearStripTextureReady = () => {
    const texture = yearStripTextureCache.get(yearStripCaptureKey());
    return !!texture?.isConnected
      && texture.dataset.snapshotReady === "true"
      && texture.dataset.snapshotFormat === "png"
      && texture.dataset.compositeWarm === "true"
      && (typeof window.crmCalendarTransition?.captureStrip !== "function"
        || texture.dataset.stripCaptureMode === "compositor");
  };
  const prepareContractTextures = async () => {
    const context = cameraContext();
    if (!context.surface || context.level !== 1 || camera?.isTransitioning?.()) return false;
    const revision = geometryRefreshRevision;
    const source = belowSnapshotSource("contract", context);
    const portal = prepareTransitionPortal(context.layers[context.level], context);
    const below = prepareBelowSnapshot("contract", context);
    const belowMaterial = source?.below?.dataset?.kind
      ? levelMaterialByOwner.get(source.below)
      : belowMaterialCache.get(source?.key);
    const stripTexture = prepareYearStripTexture(context);
    return waitForGeometryTextures(
      [portal, below, belowMaterial, stripTexture],
      revision,
    );
  };
  const scheduleGeometryCacheRefresh = (surface) => {
    const revision = ++geometryRefreshRevision;
    renderRevision += 1;
    setGeometryReady(false, surface);
    const wasTransitioning = !!camera?.isTransitioning?.();
    // Resize invalidation is synchronous while idle: no hover or click can
    // observe an old raster, clip, or owner key in the former 96ms window.
    if (!wasTransitioning) {
      discardTransitionPortal();
      discardBelowSnapshots();
      sourceAcrylicLens?.finish?.();
    }
    const refresh = async () => {
      if (revision !== geometryRefreshRevision) return;
      if (camera?.isTransitioning?.()) {
        await camera.whenSettled?.();
        if (revision !== geometryRefreshRevision) return;
        discardTransitionPortal();
        discardBelowSnapshots();
        sourceAcrylicLens?.finish?.();
      }
      const level = camera?.level?.() || 0;
      if (!camera?.isActive?.() || level < 1 || !surface?.isConnected) {
        setGeometryReady(true, surface);
        return;
      }

      // Back-navigation has no hover phase. Re-prime its full-viewport
      // textures immediately after resize. Navigation stays gated until every
      // geometry-keyed image/material has decoded and precomposed.
      const context = {
        surface,
        layers:camera.layers(),
        level,
        expRect:camera.expRect,
      };
      const ready = level === 1
        ? await prepareContractTextures()
        : await waitForGeometryTextures([
          prepareTransitionPortal(context.layers[level], context),
          prepareBelowSnapshot("contract", context),
          levelMaterialByOwner.get(context.layers[level - 1]),
        ], revision);
      if (ready && revision === geometryRefreshRevision) setGeometryReady(true, surface);
    };
    void refresh();
  };
  const cameraContext = () => ({
    surface:camera?.surface?.(),
    layers:camera?.layers?.() || [],
    level:camera?.level?.() || 0,
    expRect:camera?.expRect,
  });
  const warmTexturesReadyFor = (target) => {
    if (!synchronizeGeometryState() || !target?.isConnected) return false;
    const context = cameraContext();
    const key = transitionSourceKey(target);
    const warm = [...(context.surface?.querySelectorAll?.(":scope > .fc-warm") || [])]
      .find((node) => node.querySelector(
        ":scope > .fc-transition-preview",
      )?.dataset.transitionSource === key);
    if (!warm) return false;
    const preview = warm.querySelector(":scope > .fc-transition-preview");
    const portal = transitionPortalOwner === warm ? transitionPortal : null;
    const source = belowSnapshotSource("expand", context, target);
    const below = belowSnapshotCache.get(source?.key);
    const destinationMaterial = levelMaterialByOwner.get(warm);
    const belowMaterial = source?.below?.dataset?.kind
      ? levelMaterialByOwner.get(source.below)
      : belowMaterialCache.get(source?.key);
    const sourceMaterial = sourceAcrylicLens?.element?.();
    const requiresStripTexture = !source?.below?.dataset?.kind;
    const stripTexture = requiresStripTexture
      ? yearStripTextureCache.get(yearStripCaptureKey())
      : null;
    const textures = [
      preview,
      portal,
      below,
      ...(requiresStripTexture ? [stripTexture] : []),
    ];
    const expectedTextureCount = requiresStripTexture ? 4 : 3;
    if (textures.length !== expectedTextureCount || textures.some((node) => !node)) return false;
    const materials = [sourceMaterial, destinationMaterial, belowMaterial];
    return textures.every((node) => (
      node.isConnected
      && node.dataset.snapshotReady === "true"
      && node.dataset.snapshotFormat === "png"
      && node.dataset.compositeWarm === "true"
      && node.dataset.snapshotForcedOpaque === "true"
    ))
      && below.dataset.snapshotHiddenCount === "1"
      && below.dataset.snapshotSelectedKey === key
      && portal.dataset.transitionSource === key
      && preview.dataset.transitionGeometry === layoutGeometrySignature
      && portal.dataset.transitionGeometry === layoutGeometrySignature
      && below.dataset.snapshotGeometry === layoutGeometrySignature
      && materials.every((node) => node?.isConnected && node.dataset.compositeWarm === "true")
      && (!source?.below?.dataset?.kind
        ? below.dataset.snapshotControlPseudoCount === "2"
          && below.dataset.snapshotYearStripHiddenCount === "1"
          && stripTexture.dataset.stripCaptureKey === yearStripCaptureKey()
          && (typeof window.crmCalendarTransition?.captureStrip !== "function"
            || stripTexture.dataset.stripCaptureMode === "compositor")
        : true);
  };
  const waitForWarmTarget = (target, revision) => new Promise((resolve) => {
    let frames = 0;
    const tick = () => {
      if (revision !== geometryRefreshRevision || !target?.isConnected) {
        resolve(false);
        return;
      }
      if (warmTexturesReadyFor(target)) { resolve(true); return; }
      frames += 1;
      if (frames > 900) { resolve(false); return; }
      requestAnimationFrame(tick);
    };
    tick();
  });
  let deferredNavigationSequence = 0;
  const rawTargetFromEvent = (event, context) => {
    if (event.target?.closest?.(".fc-year-btn")) return null;
    const selector = context.level === 0 ? ".fc-month" : ".fc-day";
    const target = event.target?.closest?.(selector);
    const live = context.level === 0
      ? context.layers[0]?.querySelector?.(":scope > .fc-grid")
      : context.layers[context.level]?.querySelector?.(":scope > .fc-expander-live");
    return target && live?.contains(target) ? target : null;
  };
  const requestContractNavigation = () => {
    const sequence = ++deferredNavigationSequence;
    void (async () => {
      await whenGeometryReady();
      if (sequence !== deferredNavigationSequence || camera?.isTransitioning?.()) return;
      if (camera?.level?.() === 1 && !yearStripTextureReady()) {
        const ready = await prepareContractTextures();
        if (!ready || sequence !== deferredNavigationSequence
          || camera?.isTransitioning?.() || !yearStripTextureReady()) return;
      }
      camera?.back?.();
    })();
    return false;
  };
  const wireTransitionReadinessGuard = () => {
    if (window.__crmCalendarTransitionReadinessGuard) return;
    window.__crmCalendarTransitionReadinessGuard = true;
    window.addEventListener("keydown", (event) => {
      if (!camera?.isActive?.()
        || !["b", "B", "Escape"].includes(event.key)) return;
      const geometryIsReady = synchronizeGeometryState();
      const stripIsReady = camera.level() !== 1 || yearStripTextureReady();
      if (geometryIsReady && stripIsReady) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestContractNavigation();
    }, true);
    window.addEventListener("click", (event) => {
      if (!camera?.isActive?.() || camera?.isTransitioning?.()) return;
      synchronizeGeometryState();
      const context = cameraContext();
      const target = rawTargetFromEvent(event, context);
      if (!target || (geometryReady && warmTexturesReadyFor(target))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const sequence = ++deferredNavigationSequence;
      const surface = context.surface;
      const targetKey = transitionSourceKey(target);
      if (surface) {
        surface.dataset.deferredNavigation = targetKey;
        surface.dataset.deferredTextureReady = "false";
      }
      void (async () => {
        await whenGeometryReady();
        if (sequence !== deferredNavigationSequence || !target.isConnected) return;
        const rect = target.getBoundingClientRect();
        target.dispatchEvent(new MouseEvent("mousemove", {
          bubbles:true,
          clientX:rect.left + (rect.width / 2),
          clientY:rect.top + (rect.height / 2),
        }));
        const revision = geometryRefreshRevision;
        const ready = await waitForWarmTarget(target, revision);
        if (!ready || sequence !== deferredNavigationSequence
          || camera?.isTransitioning?.() || !target.isConnected) return;
        if (surface) surface.dataset.deferredTextureReady = "true";
        camera.expand(target);
      })();
    }, true);
  };
  const targetFromPoint = (x, y, context) => {
    if (!synchronizeGeometryState()) return null;
    if (context.level >= 2) return null;
    const layer = context.layers[context.level];
    const selector = context.level === 0
      ? ":scope > .fc-grid > .fc-month"
      : ":scope > .fc-expander-live .fc-day";
    return [...(layer?.querySelectorAll(selector) || [])].find((bucket) => {
      const rect = bucket.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }) || null;
  };
  const targetFromEvent = (event, context) => {
    if (!synchronizeGeometryState()) return null;
    return rawTargetFromEvent(event, context);
  };
  const sourceSelector = (target, context) => (
    context.level === 0
      ? `:scope > .fc-grid > .fc-month[data-month="${target.dataset.month}"]`
      : `:scope > .fc-expander-live .fc-day[data-date="${target.dataset.date}"]`
  );
  const keyOf = (target) => target.dataset.month ? `m${target.dataset.month}` : `d${target.dataset.date}`;
  const markCameraTarget = (target, context) => {
    const layer = context?.layers?.[context.level];
    layer?.querySelectorAll?.(".fc-camera-target")?.forEach?.((node) => node.classList.remove("fc-camera-target"));
    target?.classList?.add?.("fc-camera-target");
  };
  const clearCameraTarget = (context) => {
    context?.layers?.[context.level]?.querySelectorAll?.(".fc-camera-target")?.forEach?.((node) => {
      node.classList.remove("fc-camera-target");
    });
  };
  const setYear = (year) => {
    currentYear = Math.max(1901, Math.min(2200, Number(year) || currentYear));
    localStorage.setItem(YEAR_STORE, String(currentYear));
    discardTransitionPortal();
    discardBelowSnapshots();
    discardLevelMaterials();
    camera?.rebuildRoot?.();
    loadScheduled({ refresh: true });
  };
  const shiftYear = (delta) => setYear(currentYear + delta);
  const openMonthFor = (value = new Date()) => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return false;
    if (!synchronizeGeometryState()) {
      void whenGeometryReady().then(() => openMonthFor(date));
      return true;
    }
    if (camera.isTransitioning?.()) {
      camera.whenSettled?.().then(() => openMonthFor(date));
      return true;
    }
    const year = date.getFullYear();
    if (currentYear !== year) {
      currentYear = year;
      localStorage.setItem(YEAR_STORE, String(currentYear));
    }
    discardTransitionPortal();
    discardBelowSnapshots();
    discardLevelMaterials();
    camera.rebuildRoot();
    const month = camera.layers()[0]?.querySelector(`.fc-month[data-month="${date.getMonth() + 1}"]`);
    const opened = camera.jumpTo(month);
    loadScheduled({ refresh: true });
    return opened;
  };

  const loadScheduled = async ({ refresh = false } = {}) => {
    const next = new Map();
    let projects = []; let workItems = [];
    const add = (type, label, record) => {
      if (!record || record.deletedAt) return;
      const date = scheduledDateOf(record);
      if (!date || !yearDate(date)) return;
      const workLink = (record.links || []).find((link) => link.entityType === "workItems");
      const workItem = workItems.find((item) => String(item.id) === String(workLink?.recordId));
      const projectId = String(record.projectId || workItem?.projectId || "");
      const project = projects.find((candidate) => String(candidate.id) === projectId);
      const projectStages = (Array.isArray(project?.stages) ? project.stages : []).map((stage, index) => ({
        id:String(stage.id || index), kind:String(stage.kind || "active"), rank:Number.isFinite(Number(stage.rank)) ? Number(stage.rank) : index,
      })).sort((a, b) => a.rank - b.rank);
      const items = next.get(date) || [];
      items.push({ type, label, id: record.id, title: titleOf(record), hot: record.priority === "urgent" && Date.parse(record.dueAt || "") < Date.now(),
        projectTitle:String(project?.title || record.projectTitle || workItem?.projectTitle || ""), stageId:String(record.stageId || workItem?.stageId || ""), projectStages });
      next.set(date, items);
    };
    try {
      const [result, projectResult, workItemResult] = await Promise.all([
        window.crmDomain?.list?.("commitments", { includeDeleted: false, limit: 500 }),
        window.crmStore?.list?.("projects", { includeDeleted:false }),
        window.crmStore?.list?.("workItems", { includeDeleted:false }),
      ]);
      projects = recordsFrom(projectResult).filter((record) => !record.deletedAt);
      workItems = recordsFrom(workItemResult).filter((record) => !record.deletedAt);
      recordsFrom(result).filter((record) => !["completed", "cancelled", "canceled"].includes(String(record.status).toLowerCase())).forEach((record) => {
        add("commitment", record.kind || "Commitment", { ...record, dueDate: record.dueAt });
      });
    } catch {}
    scheduledByDate = next;
    renderRevision += 1;
    if (refresh && camera) refreshLevels();
  };
  // Refresh every visible layer IN PLACE (BLUEPRINT A4): a data change while
  // dived into a month/day must repaint the chips without collapsing the
  // camera back to the year (rebuildRoot resets to level 0 — a navigation cut).
  const refreshLevels = () => {
    if (!camera) return;
    if (camera.isTransitioning?.()) { scheduleReload(); return; }   // never repaint mid-dive
    discardTransitionPortal();
    discardBelowSnapshots();
    camera.dropWarm?.();
    const layers = camera.layers();
    layers[0]?.querySelectorAll?.(".fc-month").forEach((bucket) => {
      bucket.innerHTML = monthInnerHTML(Number(bucket.dataset.month) - 1);
    });
    layers.slice(1).forEach((layer) => {
      if (!layer?.dataset) return;
      const live = layer.querySelector?.(":scope > .fc-expander-live") || layer;
      if (layer.dataset.kind === "month") live.innerHTML = monthInnerHTML(Number(layer.dataset.month) - 1);
      else if (layer.dataset.kind === "day") live.innerHTML = dayInnerHTML(layer.dataset.date);
    });
    camera.layout();
  };
  const scheduleReload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => loadScheduled({ refresh: true }), 80);
  };
  const subscribeScheduled = () => {
    if (subscriptionsReady) return;
    subscriptionsReady = true;
    try { window.crmDomain?.onChanged?.(scheduleReload); } catch {}
  };

  const draggedWidget = () => document.querySelector(
    ".dashboard-layout-grid .widget-card.widget-dragging[data-widget-runtime-type], .widget-layout .widget-card.widget-dragging[data-widget-runtime-type]"
  );
  const dayAtPoint = (x, y, ignore = null) => {
    const old = ignore ? ignore.style.pointerEvents : "";
    if (ignore) ignore.style.pointerEvents = "none";
    const el = document.elementFromPoint(x, y)?.closest?.(".fc-day[data-date], .fc-day-detail[data-date], .fc-empty[data-date]") || null;
    if (ignore) ignore.style.pointerEvents = old;
    return el;
  };
  const setDropHighlight = (el) => {
    const day = el?.closest?.(".fc-day") || null;
    if (day === dropHighlight) return;
    if (dropHighlight) dropHighlight.classList.remove("is-drop-target");
    dropHighlight = day;
    if (dropHighlight) dropHighlight.classList.add("is-drop-target");
  };
  const bridgeForWidget = (widget) => {
    const type = widget?.dataset?.widgetRuntimeType || "";
    return entitySources.find((source) => source.type === type) || null;
  };
  const scheduleWidget = async (widget, date) => {
    const source = bridgeForWidget(widget);
    const id = widget?.dataset?.ticketId || "";
    if (!source || !id || !date) return false;
    try {
      const cardTitle = widget.querySelector?.(".ticket-company")?.textContent?.trim() || `Follow up ${source.entity}`;
      const result = await window.crmDomain?.create?.("commitments", {
        title: cardTitle, kind: "follow-up", dueAt: `${date}T09:00:00`,
        links: [{ entityType: source.entity, recordId: id }],
      });
      if (result && result.ok === false) return false;
      scheduleReload();
      return true;
    } catch {
      return false;
    }
  };
  const wireDrops = () => {
    document.addEventListener("pointermove", (event) => {
      if (!camera?.isActive?.()) return;
      const widget = draggedWidget();
      if (!widget) { setDropHighlight(null); return; }
      setDropHighlight(dayAtPoint(event.clientX, event.clientY, widget));
    }, true);
    document.addEventListener("pointerup", (event) => {
      if (!camera?.isActive?.()) return;
      const widget = draggedWidget();
      const target = widget ? dayAtPoint(event.clientX, event.clientY, widget) : null;
      setDropHighlight(null);
      if (widget && target?.dataset?.date) scheduleWidget(widget, target.dataset.date);
    }, true);
  };
  // BLUEPRINT A4: the day at full size is a bucket of that day's cards —
  // clicking a title-peek band inside the day dive opens the record's own
  // detail (the same open every surface plays). Camera clicks are untouched:
  // this only fires inside .fc-day-detail, which exists at day level only.
  const wireDayOpens = () => {
    document.addEventListener("click", async (event) => {
      const chip = event.target?.closest?.(".fc-day-detail .fc-chip[data-id]");
      if (!chip || !camera?.surface?.()?.contains(chip)) return;
      if (chip.dataset.type !== "commitment") return;
      event.preventDefault();
      event.stopPropagation();
      let commitment = null;
      try {
        commitment = (await window.crmDomain?.get?.("commitments", chip.dataset.id))?.record || null;
      } catch {}
      const link = commitment?.links?.[0];
      if (link) window.crmRecordWorld?.open?.(link.entityType, link.recordId, chip);
    }, true);
  };

  // BLUEPRINT A4: the flight — a card (a drag release, or a next-touch chip
  // tap) flies from `fromRect` into its calendar day and seats as the peek
  // band appearing beneath it. Returns false when the calendar isn't on
  // stage or the day cell isn't visible (callers fall back to the pill pulse).
  const activeDayElement = (date) => {
    const layers = camera?.layers?.() || [];
    if (camera?.level?.() >= 2 && layers[2]?.dataset?.date === date) {
      return layers[2].querySelector(`:scope > .fc-expander-live .fc-day-detail[data-date="${date}"], :scope > .fc-expander-live .fc-empty[data-date="${date}"]`);
    }
    if (camera?.level?.() >= 1) {
      return layers[1]?.querySelector?.(`:scope > .fc-expander-live .fc-day[data-date="${date}"]`) || null;
    }
    return layers[0]?.querySelector?.(`:scope > .fc-grid .fc-day[data-date="${date}"]`) || null;
  };
  const flyCardToDay = (fromRect, date, { title = "" } = {}) => {
    const surface = camera?.surface?.();
    if (!camera?.isActive?.() || !surface || surface.hidden) return false;
    const dest = activeDayElement(date);
    if (!dest || !fromRect || fromRect.width < 4) return false;
    const to = dest.getBoundingClientRect();
    if (to.width < 4) return false;
    const clone = document.createElement("div");
    clone.className = "fc-fly-card";
    clone.textContent = title;
    Object.assign(clone.style, {
      left: `${Math.round(fromRect.left)}px`, top: `${Math.round(fromRect.top)}px`,
      width: `${Math.round(fromRect.width)}px`, height: `${Math.round(fromRect.height)}px`,
      transformOrigin: "top left",
    });
    document.body.appendChild(clone);
    requestAnimationFrame(() => {
      clone.style.transform = `translate(${Math.round(to.left - fromRect.left)}px, ${Math.round(to.top - fromRect.top)}px) scale(${(to.width / fromRect.width).toFixed(4)}, ${(to.height / fromRect.height).toFixed(4)})`;
      clone.style.opacity = "0.12";
    });
    setTimeout(() => {
      clone.remove();
      dest.classList.add("is-drop-target");             // one settle pulse where it seated
      setTimeout(() => dest.classList.remove("is-drop-target"), 340);
    }, 500);
    scheduleReload();
    return true;
  };

  const wireYearControls = () => {
    document.addEventListener("click", (event) => {
      const button = event.target?.closest?.(".fc-year-btn");
      const surface = camera?.surface?.();
      if (!button || !surface?.contains(button)) return;
      event.preventDefault();
      event.stopPropagation();
      if (camera?.isTransitioning?.() || surface.classList.contains("fc-camera-moving")) return;
      shiftYear(Number(button.dataset.yearStep) || 0);
    }, true);
  };

  sourceAcrylicLens = window.createFractalAcrylicLens({
    frameSelector:":scope > .fc-transition-acrylic",
    ownerClass:"fc-source-acrylic-owner",
    lensClass:"fc-source-screen-acrylic",
    entryHold:.78,
    exitReveal:.22,
    expandZIndex:4,
    contractZIndex:4,
  });

  camera = window.createFractalCamera({
    apiName: "fractalCalendarCamera",
    theater: "calendar",
    surfaceClass: "fc-surface",
    layerClass: "fc-level",
    warmClass: "fc-warm",
    contractingClass: "fc-contracting-expander",
    active: false,
    maxLevel: 2,
    ease: EASE,
    morphMs: MORPH_MS,
    margin: EXP_M,
    measureTop: () => EXP_TOP,
    expandFadeMs: 70,
    belowFadeMs: 70,
    contractFadeMs: 70,
    keepBelowVisibleDuringTransition: true,
    precomposeTransitions: true,
    lockInputDuringTransitions: true,
    contractExpanderAbove: true,
    holdContractEndpointFrame: true,
    keepExpanderOpaqueDuringTransition: true,
    ensureStyles,
    buildRoot: buildYear,
    layout: layoutFrost,
    buildExpander,
    configureExpander,
    primeExpander: (expander, target, context) => {
      prepareLevelMaterial(expander, context);
      prepareTransitionPortal(expander, context);
      prepareBelowSnapshot("expand", context, target);
      const sourceMaterial = sourceAcrylicLens?.prime?.();
      precomposeOpacity(sourceMaterial, .001);
    },
    prepareTarget: markCameraTarget,
    targetFromEvent,
    targetAtPoint: targetFromPoint,
    sourceSelector,
    keyOf,
    onTransitionStart: (direction, context) => {
      stageBelowSnapshot(direction, context);
      stageTransitionMaterials(direction, context);
      stageYearStripPortal(direction, context);
      const below = direction === "expand"
        ? context.layers?.[context.level]
        : context.layers?.[context.level - 1];
      below?.classList?.add?.("fc-camera-below");
      context.surface?.classList.add("fc-camera-moving");
      stageTransitionPortal(direction, context);
    },
    onTransformStart: (direction, context) => {
      sourceAcrylicLens?.start?.(direction);
      holdTransitionAcrylicLens();
      startYearStripPortal();
      context.surface?.classList.toggle("fc-camera-expanding", direction === "expand");
      context.surface?.classList.toggle("fc-camera-contracting", direction === "contract");
      holdTransitionProbePhase(direction, context);
    },
    onTransitionEnd: (direction, context) => {
      context.surface?.classList.remove(
        "fc-camera-moving", "fc-camera-expanding", "fc-camera-contracting",
      );
      cancelHistoricalTransitionFills(context.surface);
      context.surface?.querySelectorAll?.(":scope > .fc-camera-below")?.forEach?.((node) => {
        node.classList.remove("fc-camera-below");
      });
      finishBelowSnapshot();
      finishYearStripPortal();
      finishTransitionPortal(direction, context);
      finishTransitionMaterials(direction);
      const resting = context.layers?.[context.level];
      if (resting?.matches?.(".fc-expander")) resting.dataset.fractalFrame = "viewport";
      if (direction === "contract" && context.level > 0) prepareBelowSnapshot("contract", context);
      if (direction === "contract") clearCameraTarget(context);
    },
    onLevelChange: (context) => {
      const moving = context.surface?.classList.contains("fc-camera-moving");
      if (context.level > 0 && !moving) prepareLevelMaterial(context.layers?.[context.level], context);
      if (!moving) sourceAcrylicLens?.finish?.();
    },
    onActiveChange: (active) => {
      if (!active) {
        deferredNavigationSequence += 1;
        discardTransitionPortal();
        discardBelowSnapshots();
        discardLevelMaterials();
        setGeometryReady(true);
      }
    },
    // B/Esc at the year root backs out to Home — the module→Home leg of the
    // one continuous B chain (BLUEPRINT A1): day→month→year→Home.
    onRootBack: () => window.crmDeskTransit?.driveTo?.("home"),
    onReady: () => {
      installYearStripVisualObserver();
      wireTransitionReadinessGuard();
      wireYearControls();
      wireDrops();
      wireDayOpens();
      subscribeScheduled();
      loadScheduled({ refresh: true });
    },
  });

  const homePreviewState = () => ({
    year:currentYear,
    camera:camera.historyState?.() || { level:camera.level(), selectors:[] },
  });
  const applyHomePreviewState = async (state = {}) => {
    const year = Math.max(1901, Math.min(2200, Number(state.year) || currentYear));
    if (year !== currentYear) {
      currentYear = year;
      localStorage.setItem(YEAR_STORE, String(currentYear));
      discardTransitionPortal();
      discardBelowSnapshots();
      discardLevelMaterials();
      camera.rebuildRoot();
      await loadScheduled({ refresh:true });
    }
    await camera.restoreHistoryState?.(state.camera || {});
    return homePreviewState();
  };

  window.fractalCalendar = {
    setActive: (on) => camera.setActive(on),
    isActive: () => camera.isActive(),
    year: () => currentYear,
    setYear,
    nextYear: () => shiftYear(1),
    previousYear: () => shiftYear(-1),
    openMonthFor,
    level: () => camera.level(),
    back: () => {
      if (!synchronizeGeometryState()
        || (camera.level() === 1 && !yearStripTextureReady())) {
        return requestContractNavigation();
      }
      return camera.back();
    },
    geometryReady: () => synchronizeGeometryState(),
    geometrySignature: () => layoutGeometrySignature,
    stripCaptureState,
    stripCaptureRequestState,
    stripCaptureDiagnostics,
    homePreviewState,
    applyHomePreviewState,
    refresh: () => loadScheduled({ refresh: true }),
    // Census A1: the Home bucket receives the calendar's own year DOM and
    // scales it as a static, non-interactive view.
    miniature: () => {
      ensureStyles();
      const year = buildYear();
      year.classList.add("crm-calendar-mini-scene");
      year.querySelector(".fc-year-strip")?.remove();
      return year;
    },
    dayEl: activeDayElement,
    monthEl: (month) => camera.layers()?.[1]?.matches?.(`.fc-expander[data-month="${month}"]`)
      ? camera.layers()[1]
      : camera.layers()?.[0]?.querySelector?.(`:scope > .fc-grid > .fc-month[data-month="${month}"]`) || null,
    scheduleWidget,
    flyCardToDay,
    _parity: (monthIndex, opacity = 1) => {
      const layers = camera.layers();
      const mini = layers[0]?.querySelector(`.fc-month[data-month="${monthIndex}"]`);
      if (!mini) return null;
      const rect = mini.getBoundingClientRect();
      const E = camera.expRect();
      const expander = document.createElement("div");
      expander.className = "fc-bucket fc-expander fc-parity";
      expander.dataset.kind = "month";
      expander.innerHTML = monthInnerHTML(monthIndex - 1);
      const source = camera.layoutRect(mini, layers[0]);
      expander.style.setProperty("--kx", (E.w / source.w).toFixed(4));
      expander.style.setProperty("--ky", (E.h / source.h).toFixed(4));
      Object.assign(expander.style, {
        left: `${E.x}px`,
        top: `${E.y}px`,
        width: `${E.w}px`,
        height: `${E.h}px`,
        opacity: String(opacity),
        transformOrigin: "0 0",
        transform: `translate(${(rect.left - E.x).toFixed(2)}px, ${(rect.top - E.y).toFixed(2)}px) scale(${(rect.width / E.w).toFixed(5)}, ${(rect.height / E.h).toFixed(5)})`,
      });
      camera.surface().appendChild(expander);
      const miniCells = [...mini.querySelectorAll(".fc-day")];
      const expCells = [...expander.querySelectorAll(".fc-day")];
      const deltas = miniCells.map((cell, index) => {
        const a = cell.getBoundingClientRect();
        const b = expCells[index].getBoundingClientRect();
        return [b.left - a.left, b.top - a.top, b.right - a.right, b.bottom - a.bottom].map((value) => +value.toFixed(2));
      });
      const worst = Math.max(...deltas.flat().map(Math.abs));
      return { worst, day1: deltas[0], day31: deltas[deltas.length - 1] };
    },
    _parityClear: () => camera.surface()?.querySelectorAll(".fc-parity").forEach((el) => el.remove()),
  };
})();
