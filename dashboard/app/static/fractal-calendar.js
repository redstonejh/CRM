import {
  createTileElement,
  ensureTileMaterialPlane,
  syncTileMaterialPlane,
  tileUnionPath,
} from "./modules/tile-system.js";

// Calendar is a layout of canonical tiles hosted by the shared fractal camera.
// It deliberately owns no private screenshot/capture pipeline.
(() => {
  if (typeof window.createFractalCamera !== "function") {
    console.error("[CRM] fractal camera factory is not loaded");
    return;
  }

  const YEAR_STORE = "crm-calendar-year";
  const EASE = "cubic-bezier(.22, 1, .26, 1)";
  const MORPH_MS = 460;
  const MATERIAL_HANDOFF_MS = 72;
  const MATERIAL_PRIME_OPACITY = .02;
  const EXP_M = 48;
  const EXP_TOP = 132;
  const YEAR_STRIP_TOP = 12;
  const RADIUS_F = 16 / 245;
  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const DOW_FULL = [
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
  ];

  let currentYear = (() => {
    const saved = Number(localStorage.getItem(YEAR_STORE));
    return Number.isFinite(saved) && saved > 1900 ? saved : new Date().getFullYear();
  })();
  let camera = null;
  let monthAcrylicLens = null;
  let dayAcrylicLens = null;
  const materialHandoffs = new Map();
  let scheduledByDate = new Map();
  let subscriptionsReady = false;
  let reloadTimer = 0;
  let materialPrewarmFrame = 0;
  let materialPrewarmTimer = 0;
  let dropHighlight = null;
  let renderRevision = 0;
  let layoutGeometrySignature = "";
  let activeTransition = null;
  let backdropCover = null;
  let backdropCoverScene = null;
  let backdropCoverMotion = null;
  let backdropCoverSettleTimer = 0;
  let backdropCoverPrewarmTimer = 0;
  let backdropCoverSourceObserver = null;

  const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (character) => ({
    "&":"&amp;",
    "<":"&lt;",
    ">":"&gt;",
    '"':"&quot;",
  }[character]));
  const clampN = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
  const crmNow = () => (window.__CRM_NOW__ ? new Date(window.__CRM_NOW__) : new Date());
  const todayIso = () => {
    const date = crmNow();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const daysIn = (month) => new Date(currentYear, month + 1, 0).getDate();
  const firstDow = (month) => new Date(currentYear, month, 1).getDay();
  const iso = (month, day) => `${currentYear}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const yearDate = (date) => String(date || "").startsWith(`${currentYear}-`);
  const recordsFrom = (result) => (
    Array.isArray(result) ? result : ((result && (result.records || result.tickets)) || [])
  );
  const scheduledDateOf = (record) => {
    const meta = record?.meta || {};
    const raw = meta.scheduledDate || meta.calendarDate
      || record?.scheduledDate || record?.calendarDate
      || record?.dueDate || record?.startDate;
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(raw || ""));
    if (!match) return "";
    const value = String(raw || "");
    if (!value.includes("T")
      || (record?.source === "legacy-projection" && /T00:00:00(?:\.000)?Z$/i.test(value))) {
      return match[1];
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return match[1];
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const titleOf = (record) => {
    const meta = record?.meta || {};
    return meta.client || meta.title || record?.companyLabel || record?.title
      || record?.name || record?.host || "Untitled";
  };
  const entitySources = [
    { type:"ticket", entity:"tickets" },
    { type:"deal", entity:"deals" },
    { type:"contact", entity:"contacts" },
    { type:"job", entity:"jobs" },
    { type:"bill", entity:"bills" },
    { type:"invoice", entity:"invoices" },
  ];

  const ensureStyles = () => {
    if (document.getElementById("fractal-calendar-styles")) return;
    const style = document.createElement("style");
    style.id = "fractal-calendar-styles";
    style.textContent = `
      .fc-surface{position:fixed;inset:0;z-index:800;pointer-events:none;overflow:hidden}
      .fc-surface[hidden]{display:none}
      body[data-crm-module="calendar"] .app-window-drag-region{z-index:790}
      .fc-level{position:absolute;inset:0;transform-origin:0 0;will-change:transform;
        contain:layout paint style;backface-visibility:hidden}
      .fc-live-backdrop-cover{position:absolute;z-index:3;overflow:hidden;pointer-events:none;
        will-change:opacity;contain:strict;backface-visibility:hidden}
      .fc-live-backdrop-cover[hidden]{display:none}
      .fc-live-backdrop-scene{position:absolute;inset:0;overflow:visible;pointer-events:none;
        backface-visibility:hidden}
      .fc-live-backdrop-wallpaper{position:absolute;overflow:hidden;pointer-events:none;
        background:var(--page-background);background-attachment:fixed}
      .fc-live-backdrop-wallpaper>.workspace-photo-backdrop{position:absolute!important;
        inset:0!important;z-index:0!important;display:block!important;visibility:visible!important;
        width:100%!important;height:100%!important;pointer-events:none!important}
      .fc-surface.fc-camera-moving>.fc-calendar-below[data-kind="year"]{z-index:0!important}
      .fc-surface.fc-camera-moving>.fc-calendar-below[data-kind="month"]{z-index:4!important}
      .fc-calendar-active-level[data-kind="month"],
      .fc-calendar-active-level[data-kind="day"]{z-index:5!important}
      .fc-grid{position:absolute;z-index:1;display:grid;pointer-events:auto;-webkit-app-region:no-drag;
        grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(3,1fr);gap:14px;
        contain:layout style}

      .fc-year-strip{position:fixed;left:50%;top:${YEAR_STRIP_TOP}px;z-index:9400;
        transform:translateX(-50%);display:inline-flex;align-items:center;gap:7px;
        pointer-events:auto;-webkit-app-region:no-drag;padding:0;color:rgba(245,249,255,.84);
        background:transparent;border:0;-webkit-backdrop-filter:none;backdrop-filter:none;
        box-shadow:none;opacity:1;transition:opacity .14s ease,transform .18s ease}
      .fc-year-strip[hidden]{display:none}
      .fc-year-strip .fc-year-btn,.fc-year-strip .fc-year-face{flex:0 0 46px;width:46px;
        height:46px;min-width:46px;min-height:46px;padding:0}
      .fc-year-strip .fc-year-btn::before,.fc-year-strip .fc-year-face::before{display:none}
      .fc-year-strip .fc-year-btn{opacity:0;pointer-events:none;transform:scale(.82);
        transition:opacity .16s ease,transform .2s cubic-bezier(.19,1,.22,1),color .18s ease,box-shadow .18s ease}
      .fc-year-strip:hover .fc-year-btn,.fc-year-strip:focus-within .fc-year-btn{
        opacity:1;pointer-events:auto;transform:none}
      .fc-year-strip .fc-year-btn svg{display:block;width:18px;height:18px}
      .fc-year-face{appearance:none;box-sizing:border-box;display:grid;grid-template-rows:9px 1fr;
        place-items:center;padding:6px 0 3px!important;font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
        font-variant-numeric:tabular-nums;-webkit-app-region:no-drag}
      .fc-year-kicker{align-self:end;text-transform:uppercase;font-size:7px;line-height:1;
        font-weight:700;letter-spacing:.08em;opacity:.62}
      .fc-year-label{align-self:start;min-width:0;text-align:center;font-size:14px;line-height:1;
        font-weight:650;letter-spacing:-.035em}
      @media (hover:none){.fc-year-strip .fc-year-btn{opacity:.72;pointer-events:auto;transform:none}}

      .fc-month-layout{position:relative;box-sizing:border-box;display:flex;flex-direction:column;
        min-height:0;overflow:hidden;color:#fff;container-type:size;
        padding:calc(8px * var(--ky,1)) calc(10px * var(--kx,1)) calc(10px * var(--ky,1));
        background:transparent;border:0;box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none}
      .fc-month{cursor:pointer;border-radius:calc(var(--mon-r,16px) * var(--kx,1)) /
        calc(var(--mon-r,16px) * var(--ky,1));outline:none}
      .fc-month:focus-visible{box-shadow:0 0 0 1px rgba(125,180,255,.54)}
      .fc-hd,.fc-dowrow,.fc-days{position:relative;z-index:1}
      .fc-hd{flex:0 0 9%;display:flex;align-items:center;justify-content:space-between;gap:8px;
        padding:0 1%;font-size:clamp(.98rem,8cqh,1.15rem);font-weight:700;line-height:1.05;
        color:rgba(255,255,255,.85);white-space:nowrap;min-height:0}
      .fc-expander .fc-hd{font-size:clamp(1.15rem,3.2cqh,1.7rem)}
      .fc-expander[data-kind="day"] .fc-hd{font-size:clamp(1.05rem,2.8cqh,1.45rem)}
      .fc-dowrow{flex:0 0 5%;display:grid;grid-template-columns:repeat(7,1fr);column-gap:1.6%;
        align-items:center;min-height:0}
      .fc-dowrow span{text-align:center;font-size:var(--crm-type-caption,11px);font-weight:700;
        color:rgba(255,255,255,.4);white-space:nowrap;overflow:hidden}
      .fc-days{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:repeat(7,1fr);
        grid-template-rows:repeat(6,1fr);column-gap:1.6%;row-gap:2%}
      .fc-day-spacer{min-height:0;visibility:hidden;pointer-events:none}

      /* A day is a canonical shared tile instance. Its DOM identity, tile
         record, focus/interaction contract and material layers are the same
         architecture used by Home/Projects; Calendar only places it. */
      .fc-day.crm-home-bucket{position:relative;z-index:1;box-sizing:border-box;display:block;
        min-width:0;min-height:0;width:auto;height:auto;overflow:hidden;padding:0;appearance:none;
        color:#fff;cursor:pointer;border:1px solid var(--bucket-acrylic-border)!important;
        border-radius:calc(var(--day-r,3px) * var(--kx,1)) /
          calc(var(--day-r,3px) * var(--ky,1))!important;
        background:var(--bucket-acrylic-surface)!important;
        -webkit-backdrop-filter:none!important;backdrop-filter:none!important;
        box-shadow:var(--bucket-acrylic-shadow)!important;
        transition:box-shadow .18s ease,background .18s ease}
      .fc-day.crm-home-bucket:hover,.fc-day.crm-home-bucket:focus-visible,
      .fc-day.crm-home-bucket.is-drop-target,
      .fc-day-detail.is-drop-target,.fc-empty.is-drop-target,
      .fc-surface[data-level="0"] .fc-month:is(:hover,:focus-visible) .fc-day{
        background:linear-gradient(180deg,rgba(70,110,190,.34),rgba(40,70,130,.26))!important;
        box-shadow:inset 0 0 0 1px rgba(125,180,255,.5),0 0 30px rgba(90,150,255,.42)!important}
      .fc-day.fc-today{box-shadow:var(--bucket-acrylic-shadow),
        inset 0 0 0 1px rgba(125,180,255,.55),0 0 16px rgba(90,150,255,.38)!important}
      .fc-day-num{position:absolute;top:6%;left:7%;font-size:var(--crm-type-body,12px);
        font-weight:700;color:rgba(255,255,255,.78);line-height:1}
      .fc-day-body{position:absolute;inset:24% 5% 5%;display:flex;flex-direction:column;
        gap:3px;min-height:0}
      .fc-scheduled-list{display:flex;flex-direction:column;gap:0;min-height:0;overflow:hidden}
      .fc-day-preview{display:none;width:100%;height:100%;flex-direction:column;justify-content:center;
        gap:12%;overflow:hidden}
      .fc-day-preview-item{display:flex;width:100%;height:2px;gap:1px;opacity:.82}
      .fc-day-preview-item i{flex:1 1 0;min-width:1px;border-radius:2px;background:rgba(143,158,180,.24)}
      .fc-day-preview-item i[data-reached="true"]{background:rgba(151,184,226,.62)}
      .fc-day-preview-item[data-complete="true"] i[data-reached="true"]{background:rgba(143,195,169,.62)}

      .fc-chip{position:relative;display:grid;grid-template-rows:minmax(0,auto) 2px;gap:2px;
        border-radius:3px;margin-top:-1px;padding:2px 6px 3px 9px;font-size:var(--crm-type-micro,9px);
        line-height:1.2;color:rgba(255,255,255,.88);
        background:linear-gradient(180deg,rgba(83,95,117,.6),rgba(33,41,56,.55));
        box-shadow:inset 0 0 0 1px rgba(255,255,255,.09),inset 0 1px 0 rgba(255,255,255,.1),
          0 2px 6px rgba(0,0,0,.22);white-space:nowrap;overflow:hidden}
      .fc-chip-title{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fc-chip-project-map{display:flex;align-items:stretch;gap:1px;min-width:0;height:2px}
      .fc-chip-project-map i{flex:1 1 0;min-width:2px;border-radius:2px;background:rgba(218,230,245,.13)}
      .fc-chip-project-map i[data-reached="true"]{background:rgba(157,190,232,.55)}
      .fc-chip-project-map[data-complete="true"] i[data-reached="true"]{background:rgba(145,197,171,.58)}
      .fc-chip:not(:has(.fc-chip-project-map)){grid-template-rows:minmax(0,auto)}
      .fc-chip:first-child{margin-top:0}
      .fc-chip::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:rgba(148,163,184,.35)}
      .fc-chip[data-type="deal"]::before{background:rgba(249,115,22,.85)}
      .fc-chip[data-type="task"]::before{background:rgba(111,201,154,.85)}
      .fc-chip[data-type="ticket"]::before{background:rgba(125,180,255,.85)}
      .fc-chip[data-type="invoice"]::before{background:rgba(56,189,248,.85)}
      .fc-chip[data-type="contact"]::before,.fc-chip[data-type="calendar"]::before{background:rgba(148,163,184,.35)}
      .fc-chip[data-hot="true"]::before{background:rgba(220,38,38,.95)}
      .fc-chip-more{font-size:var(--crm-type-micro,9px);padding:1px 6px;color:rgba(255,255,255,.5)}
      .fc-day-detail .fc-chip{font-size:var(--crm-type-body,12px);padding:9px 12px 9px 14px;
        border-radius:6px;margin-top:3px;cursor:pointer}
      .fc-day-detail .fc-chip:hover{background:linear-gradient(180deg,rgba(103,115,137,.66),rgba(53,61,76,.6));
        box-shadow:inset 0 0 0 1px rgba(125,180,255,.4),inset 0 1px 0 rgba(255,255,255,.14),
          0 2px 8px rgba(0,0,0,.28)}

      .fc-empty,.fc-day-detail{width:100%;margin:auto 0;padding:14px 8px;text-align:center;
        color:rgba(255,255,255,.42);font-size:var(--crm-type-body,12px);line-height:1.4}
      .fc-day-detail{position:relative;z-index:2;margin:0;height:100%;box-sizing:border-box;
        display:flex;flex-direction:column;gap:10px;text-align:left}
      .fc-day-detail .fc-scheduled-list{overflow:auto;scrollbar-width:thin;
        scrollbar-color:rgba(255,255,255,.5) transparent}
      .fc-drop-hint{margin-top:auto;text-align:center;color:rgba(255,255,255,.42)}

      .fc-surface[data-level="0"]>.fc-level .fc-day-num,
      .fc-transition-copy[data-kind="month"] .fc-day-num{display:none}
      .fc-surface[data-level="0"]>.fc-level .fc-dowrow span,
      .fc-transition-copy[data-kind="month"] .fc-dowrow span{visibility:hidden}
      .fc-surface[data-level="0"]>.fc-level .fc-scheduled-list,
      .fc-transition-copy[data-kind="month"] .fc-scheduled-list{display:none}
      .fc-surface[data-level="0"]>.fc-level .fc-day-body,
      .fc-transition-copy[data-kind="month"] .fc-day-body{inset:13% 10%}
      .fc-surface[data-level="0"]>.fc-level .fc-day-preview,
      .fc-transition-copy[data-kind="month"] .fc-day-preview{display:flex}
      .fc-surface[data-level="0"]>.fc-level .fc-day{pointer-events:none}

      .fc-expander{position:absolute;z-index:5;pointer-events:auto;-webkit-app-region:no-drag;
        transform-origin:0 0;padding:0;contain:layout paint style;will-change:transform;
        backface-visibility:hidden;overflow:hidden}
      .fc-expander[data-kind="month"]{background:transparent;border:0;box-shadow:none;
        -webkit-backdrop-filter:none;backdrop-filter:none}
      .fc-expander[data-kind="day"].crm-home-bucket{background:transparent!important;border:0!important;
        box-shadow:none!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;
        border-radius:calc(var(--day-r,14px) * var(--kx,1)) /
          calc(var(--day-r,14px) * var(--ky,1))!important}
      .fc-day-expander-tint,.fc-day-detail-material,.fc-transition-acrylic{
        position:absolute;inset:0;box-sizing:border-box;pointer-events:none}
      .fc-day-expander-tint{z-index:0;background:var(--bucket-acrylic-surface);
        border-radius:inherit}
      .fc-day-detail-material{z-index:1;clip-path:inset(0 round 14px);
        -webkit-clip-path:inset(0 round 14px)}
      .fc-transition-acrylic{z-index:4;border-width:1px;border-radius:inherit}
      .fc-expander-live,.fc-transition-copy{position:absolute;inset:0;box-sizing:border-box;
        min-width:0;min-height:0;backface-visibility:hidden;will-change:opacity}
      .fc-expander-live{z-index:3;opacity:1;pointer-events:auto}
      .fc-expander-live.fc-month-layout{display:flex}
      .fc-expander[data-kind="day"]>.fc-expander-live{padding:calc(8px * var(--ky,1))
        calc(10px * var(--kx,1)) calc(10px * var(--ky,1))}
      .fc-transition-copy{z-index:2;opacity:0;pointer-events:none!important}
      .fc-transition-copy.fc-month-layout{display:flex}
      .fc-transition-copy>.fc-transition-day-tile{position:absolute!important;inset:0!important;
        width:100%!important;height:100%!important}
      .fc-warm>.fc-transition-copy,.fc-expander[data-fractal-frame="source"]>.fc-transition-copy{opacity:1}
      .fc-warm>.fc-expander-live,.fc-expander[data-fractal-frame="source"]>.fc-expander-live{opacity:.001}
      .fc-warm,.fc-warm *{pointer-events:none!important}

      @keyframes fc-copy-out{0%{opacity:1}62%{opacity:1}100%{opacity:0}}
      @keyframes fc-live-in{0%{opacity:0}54%{opacity:0}100%{opacity:1}}
      @keyframes fc-copy-in{0%{opacity:0}46%{opacity:1}100%{opacity:1}}
      @keyframes fc-live-out{0%{opacity:1}38%{opacity:0}100%{opacity:0}}
      .fc-surface.fc-camera-expanding>.fc-expander:not(.fc-warm)>.fc-transition-copy{
        animation:fc-copy-out ${MORPH_MS}ms linear both}
      .fc-surface.fc-camera-expanding>.fc-expander:not(.fc-warm)>.fc-expander-live{
        animation:fc-live-in ${MORPH_MS}ms linear both}
      .fc-surface.fc-camera-contracting>.fc-expander:not(.fc-warm)>.fc-transition-copy{
        animation:fc-copy-in ${MORPH_MS}ms linear both}
      .fc-surface.fc-camera-contracting>.fc-expander:not(.fc-warm)>.fc-expander-live{
        animation:fc-live-out ${MORPH_MS}ms linear both}

      .fc-source-screen-acrylic,.fc-source-screen-acrylic-clip{
        position:absolute;inset:0;box-sizing:border-box;pointer-events:none;backface-visibility:hidden}
      /* Destination planes ride the existing live-content crossfade beneath
         the moving material. Keeping them fully compositor-active avoids
         allocating a new blur surface on the first settled frame. */
      .fc-source-acrylic-owner[data-kind="month"] .crm-tile-material-plane,
      .fc-source-acrylic-owner[data-kind="day"]>.fc-day-detail-material{
        opacity:.999}
      .fc-camera-target{opacity:0!important}
      .fc-contracting-expander{pointer-events:none}
      .fc-fly-card{position:fixed;z-index:6000;pointer-events:none;box-sizing:border-box;
        border-radius:12px;padding:10px 12px;color:#fff;font-size:var(--crm-type-control,13px);
        font-weight:700;overflow:hidden;background-color:rgb(74,84,101);
        background-image:linear-gradient(180deg,rgba(83,95,117,.85),rgba(33,41,56,.9));
        box-shadow:inset 0 1px 0 rgba(255,255,255,.2),0 18px 42px rgba(0,0,0,.4);
        transition:transform 460ms ${EASE},opacity 220ms ease 300ms}
    `;
    document.head.appendChild(style);
  };

  const scheduledFor = (date) => scheduledByDate.get(date) || [];
  const visibleScheduledFor = (date, limit) => {
    const all = scheduledFor(date);
    const items = all.slice(0, limit);
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
    return `<span class="${className}"${complete ? ' data-complete="true"' : ""} aria-hidden="true">${
      stages.map((_stage, index) => `<i data-reached="${index <= current}"></i>`).join("")
    }</span>`;
  };
  const scheduledPreviewHTML = (date, limit = 3) => {
    const { items } = visibleScheduledFor(date, limit);
    if (!items.length) return "";
    return `<div class="fc-day-preview" aria-hidden="true">${items.map((item) => {
      const map = progressMapHTML(item, "fc-day-preview-item");
      return map || `<span class="fc-day-preview-item" data-type="${esc(item.type)}"><i data-reached="true"></i></span>`;
    }).join("")}</div>`;
  };
  const scheduledHTML = (date, limit = 4) => {
    const { all, items } = visibleScheduledFor(date, limit);
    if (!items.length) return "";
    const extra = all.length - items.length;
    return `<div class="fc-scheduled-list">${items.map((item) => (
      `<div class="fc-chip" data-type="${esc(item.type)}" data-id="${esc(item.id)}"${
        item.hot ? ' data-hot="true"' : ""
      }${item.projectTitle ? ` title="${esc(item.projectTitle)}"` : ""}>` +
      `<span class="fc-chip-title">${esc(item.title)}</span>${progressMapHTML(item)}</div>`
    )).join("")}${extra > 0 ? `<div class="fc-chip-more">+${extra} more</div>` : ""}</div>`;
  };

  const dayTileRecord = (month, day) => {
    const date = iso(month, day);
    return {
      id:`calendar-day-${date}`,
      key:date,
      title:`${MONTHS[month]} ${day}`,
      label:`${MONTHS[month]} ${day}, ${currentYear}`,
      tileKind:"calendar-day",
      targetType:"calendar-day",
      targetId:date,
      rank:day - 1,
    };
  };
  const createDayTile = (month, day, { interactive = false } = {}) => {
    const date = iso(month, day);
    const tile = createTileElement(dayTileRecord(month, day), {
      className:`fc-day${date === todayIso() ? " fc-today" : ""}`,
      ariaLabel:`Open ${MONTHS[month]} ${day}, ${currentYear}`,
      tabIndex:interactive ? 0 : -1,
    });
    tile.dataset.date = date;
    tile.dataset.calendarTile = "day";
    tile.innerHTML = `<span class="fc-day-num">${day}</span><div class="fc-day-body">${
      scheduledPreviewHTML(date)
    }${scheduledHTML(date)}</div>`;
    return tile;
  };
  const mountMonthContents = (host, month, {
    interactiveDays = false,
    material = false,
  } = {}) => {
    const existingMaterial = material
      ? host.querySelector?.(":scope > .crm-tile-material-plane")
      : null;
    host.dataset.month = String(month + 1);
    host.dataset.kind = "month";
    const header = document.createElement("div");
    header.className = "fc-hd";
    header.innerHTML = `<span>${MONTHS[month]}</span>`;
    const weekdays = document.createElement("div");
    weekdays.className = "fc-dowrow";
    weekdays.innerHTML = DOW.map((day) => `<span>${day}</span>`).join("");
    const days = document.createElement("div");
    days.className = "fc-days";
    const leading = firstDow(month);
    const count = daysIn(month);
    const trailing = 42 - leading - count;
    for (let index = 0; index < leading; index += 1) {
      const spacer = document.createElement("div");
      spacer.className = "fc-day-spacer";
      days.appendChild(spacer);
    }
    for (let day = 1; day <= count; day += 1) {
      days.appendChild(createDayTile(month, day, { interactive:interactiveDays }));
    }
    for (let index = 0; index < trailing; index += 1) {
      const spacer = document.createElement("div");
      spacer.className = "fc-day-spacer";
      days.appendChild(spacer);
    }
    host.replaceChildren(header, weekdays, days);
    if (material) {
      if (existingMaterial) host.prepend(existingMaterial);
      ensureTileMaterialPlane(host, {
        className:"fc-calendar-tile-material",
        tileSelector:":scope > .fc-days > .fc-day",
      });
    }
    return host;
  };
  const dayInnerHTML = (date) => {
    const [, month, day] = date.split("-").map(Number);
    const parsed = new Date(currentYear, month - 1, day);
    const items = scheduledHTML(date, 40);
    return `<div class="fc-hd"><span>${DOW_FULL[parsed.getDay()]}, ${MONTHS[month - 1]} ${day}</span></div>` +
      `<div class="fc-day-detail" data-date="${date}">${
        items || `<div class="fc-empty" data-date="${date}">No scheduled records yet</div>`
      }<div class="fc-drop-hint">Drop grid cards here to schedule them</div></div>`;
  };

  const buildYear = () => {
    const root = document.createElement("div");
    root.className = "fc-level";
    root.dataset.kind = "year";
    const grid = document.createElement("div");
    grid.className = "fc-grid";
    for (let month = 0; month < 12; month += 1) {
      const bucket = document.createElement("section");
      bucket.className = "fc-month fc-month-layout";
      bucket.dataset.month = String(month + 1);
      bucket.dataset.kind = "month";
      bucket.setAttribute("role", "button");
      bucket.setAttribute("aria-label", `Open ${MONTHS[month]} ${currentYear}`);
      bucket.tabIndex = 0;
      mountMonthContents(bucket, month, { interactiveDays:false, material:false });
      grid.appendChild(bucket);
    }
    root.appendChild(grid);
    ensureTileMaterialPlane(root, {
      className:"fc-calendar-tile-material fc-year-tile-material",
      tileSelector:":scope > .fc-grid > .fc-month > .fc-days > .fc-day",
    });
    return root;
  };

  const yearChromeHTML = () => `
    <button type="button" class="fc-year-btn window-glass-control" data-year-step="-1"
      aria-label="Previous year"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="m14.5 6-6 6 6 6"></path></svg></button>
    <button type="button" class="fc-year-face window-glass-control" data-year-current
      aria-label="Return to the current year"><span class="fc-year-kicker" aria-hidden="true">Year</span>
      <span class="fc-year-label">${currentYear}</span></button>
    <button type="button" class="fc-year-btn window-glass-control" data-year-step="1"
      aria-label="Next year"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="m9.5 6 6 6-6 6"></path></svg></button>`;
  const ensureYearChrome = (surface = camera?.surface?.()) => {
    if (!surface || !document.body) return null;
    // Window chrome must not live in the camera/theater tree. A fixed element
    // inside that temporarily transformed tree still inherits its scale and
    // offset while Calendar opens, which made the year face visibly wander.
    let strip = document.querySelector("body > .fc-year-strip");
    if (!strip) {
      strip = document.createElement("nav");
      strip.className = "fc-year-strip";
      strip.setAttribute("aria-label", "Calendar year");
      document.body.appendChild(strip);
    }
    strip.innerHTML = yearChromeHTML();
    strip.style.top = `${YEAR_STRIP_TOP}px`;
    strip.hidden = !(camera?.isActive?.() ?? !surface.hidden);
    return strip;
  };

  const layoutGrid = (grid, expRect) => {
    const gap = 14;
    const viewport = expRect();
    const aspect = viewport.w / viewport.h;
    let cellWidth = (viewport.w - 3 * gap) / 4;
    let cellHeight = cellWidth / aspect;
    if (3 * cellHeight + 2 * gap > viewport.h) {
      cellHeight = (viewport.h - 2 * gap) / 3;
      cellWidth = cellHeight * aspect;
    }
    const gridWidth = 4 * cellWidth + 3 * gap;
    const gridHeight = 3 * cellHeight + 2 * gap;
    Object.assign(grid.style, {
      left:`${(viewport.x + (viewport.w - gridWidth) / 2).toFixed(2)}px`,
      top:`${(viewport.y + (viewport.h - gridHeight) / 2).toFixed(2)}px`,
      width:`${gridWidth.toFixed(2)}px`,
      height:`${gridHeight.toFixed(2)}px`,
    });
  };
  const stopBackdropCoverMotion = () => {
    clearTimeout(backdropCoverSettleTimer);
    backdropCoverSettleTimer = 0;
    backdropCoverMotion?.animation?.cancel?.();
    backdropCoverMotion = null;
  };
  const rebuildBackdropWallpaper = (wallpaper) => {
    if (!wallpaper) return;
    wallpaper.replaceChildren();
    const rootStyle = getComputedStyle(document.documentElement);
    const bodyStyle = getComputedStyle(document.body);
    const backgroundStyle = rootStyle.backgroundImage !== "none" ? rootStyle : bodyStyle;
    Object.assign(wallpaper.style, {
      backgroundImage:backgroundStyle.backgroundImage,
      backgroundColor:rootStyle.backgroundColor !== "rgba(0, 0, 0, 0)"
        ? rootStyle.backgroundColor
        : bodyStyle.backgroundColor,
      backgroundPosition:backgroundStyle.backgroundPosition,
      backgroundSize:backgroundStyle.backgroundSize,
      backgroundRepeat:backgroundStyle.backgroundRepeat,
    });
    const source = document.querySelector("body > .workspace-photo-backdrop");
    if (!source) return;
    const clone = source.cloneNode(true);
    clone.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    clone.removeAttribute("id");
    clone.hidden = false;
    wallpaper.appendChild(clone);
  };
  const ensureBackdropCover = (surface) => {
    if (backdropCover?.isConnected && backdropCover.parentElement === surface) {
      return backdropCover;
    }
    stopBackdropCoverMotion();
    backdropCover = document.createElement("div");
    backdropCover.className = "fc-live-backdrop-cover";
    backdropCover.setAttribute("aria-hidden", "true");
    backdropCover.hidden = true;
    backdropCoverScene = document.createElement("div");
    backdropCoverScene.className = "fc-live-backdrop-scene";
    const wallpaper = document.createElement("div");
    wallpaper.className = "fc-live-backdrop-wallpaper";
    backdropCoverScene.appendChild(wallpaper);
    backdropCover.appendChild(backdropCoverScene);
    surface.appendChild(backdropCover);
    return backdropCover;
  };
  const updateBackdropCoverGeometry = (context) => {
    const cover = ensureBackdropCover(context.surface);
    const scene = backdropCoverScene;
    const wallpaper = scene.querySelector(":scope > .fc-live-backdrop-wallpaper");
    const viewport = context.expRect();
    const source = document.querySelector("body > .workspace-photo-backdrop");
    const photoSignature = source
      ? [
        source.hidden,
        source.querySelector(".workspace-photo-track")?.style?.transform || "",
        ...[...source.querySelectorAll(".workspace-photo-panel")]
          .map((panel) => panel.style.backgroundImage || ""),
      ].join("|")
      : "no-photo";
    const signature = [
      innerWidth,
      innerHeight,
      viewport.x.toFixed(2),
      viewport.y.toFixed(2),
      viewport.w.toFixed(2),
      viewport.h.toFixed(2),
      document.documentElement.dataset.background || document.body.dataset.background || "",
      photoSignature,
    ].join("|");
    Object.assign(cover.style, {
      left:"0px",
      top:"0px",
      width:`${innerWidth}px`,
      height:`${innerHeight}px`,
      clipPath:`inset(${viewport.y}px ${innerWidth - viewport.x - viewport.w}px ` +
        `${innerHeight - viewport.y - viewport.h}px ${viewport.x}px)`,
      webkitClipPath:`inset(${viewport.y}px ${innerWidth - viewport.x - viewport.w}px ` +
        `${innerHeight - viewport.y - viewport.h}px ${viewport.x}px)`,
    });
    Object.assign(wallpaper.style, {
      left:"0px",
      top:"0px",
      width:`${innerWidth}px`,
      height:`${innerHeight}px`,
    });
    if (cover.dataset.backdropSignature !== signature
      || (!!source && !wallpaper.querySelector(":scope > .workspace-photo-backdrop"))) {
      cover.dataset.backdropSignature = signature;
      rebuildBackdropWallpaper(wallpaper);
    }
    return { cover, scene, viewport };
  };
  const prepareBackdropCover = (direction, context) => {
    if (!activeTransition?.target) return;
    const { cover, scene } = updateBackdropCoverGeometry(context);
    stopBackdropCoverMotion();
    const expanding = direction === "expand";
    const crossesYearBoundary = expanding
      ? context.level === 0
      : context.level === 1;
    // Keep the wallpaper clone on an opacity layer at rest. Chromium may
    // flatten a large animated surface when it reaches exactly 1, which
    // creates a visible multi-frame stall at the end of this fade.
    const opacityFrom = crossesYearBoundary
      ? (expanding ? 0 : .999)
      : .999;
    const opacityTo = crossesYearBoundary
      ? (expanding ? .999 : 0)
      : .999;
    cover.hidden = false;
    cover.style.opacity = String(opacityFrom);
    scene.style.transform = "none";
    backdropCoverMotion = {
      direction,
      cover,
      opacityFrom,
      opacityTo,
      animation:null,
    };
  };
  const startBackdropCover = (direction) => {
    const motion = backdropCoverMotion;
    if (!motion || motion.direction !== direction) return;
    if (motion.opacityFrom === motion.opacityTo) {
      motion.cover.style.opacity = String(motion.opacityTo);
      return;
    }
    const expanding = direction === "expand";
    const timing = {
      duration:expanding ? 190 : 340,
      delay:expanding ? 0 : 70,
      easing:"ease",
      fill:"both",
    };
    motion.animation = motion.cover.animate(
      [{ opacity:motion.opacityFrom }, { opacity:motion.opacityTo }],
      timing,
    );
  };
  const syncBackdropCover = (transformStartTime) => {
    if (!backdropCoverMotion || !Number.isFinite(Number(transformStartTime))) return;
    try { backdropCoverMotion.animation.startTime = Number(transformStartTime); } catch {}
  };
  const settleBackdropCover = (direction, context) => {
    const motion = backdropCoverMotion;
    if (!motion || motion.direction !== direction) return;
    motion.cover.style.opacity = String(motion.opacityTo);
    motion.animation?.cancel?.();
    backdropCoverMotion = null;
    clearTimeout(backdropCoverSettleTimer);
    if (context.level > 0) {
      motion.cover.hidden = false;
      motion.cover.style.opacity = ".999";
      return;
    }
    backdropCoverSettleTimer = setTimeout(() => {
      backdropCoverSettleTimer = 0;
      if (!motion.cover.isConnected) return;
      motion.cover.hidden = true;
      motion.cover.style.opacity = "0";
    }, MATERIAL_HANDOFF_MS + 28);
  };
  const seatBackdropCover = (context) => {
    const { cover } = updateBackdropCoverGeometry(context);
    stopBackdropCoverMotion();
    cover.hidden = false;
    cover.style.opacity = ".999";
  };
  const hideBackdropCover = () => {
    stopBackdropCoverMotion();
    if (!backdropCover) return;
    backdropCover.hidden = true;
    backdropCover.style.opacity = "0";
  };
  const radiusFor = (width, height) => clampN(RADIUS_F * Math.min(width, height), 2, 64);
  const syncCalendarMaterial = (host) => {
    if (!host) return null;
    const direct = host.querySelector?.(":scope > .crm-tile-material-plane");
    if (direct) return syncTileMaterialPlane(direct);
    const planes = [...(host.querySelectorAll?.(
      ":scope > .fc-grid > .fc-month > .crm-tile-material-plane",
    ) || [])];
    planes.forEach((plane) => syncTileMaterialPlane(plane));
    return planes;
  };
  const layoutCalendar = ({ surface, layers, expRect }) => {
    const root = layers[0];
    const grid = root?.querySelector?.(":scope > .fc-grid");
    if (!surface || !root || !grid) return;
    ensureYearChrome(surface);
    layoutGrid(grid, expRect);
    const firstMonth = grid.firstElementChild;
    const firstDay = grid.querySelector(".fc-day");
    if (firstMonth) {
      surface.style.setProperty("--mon-r", `${radiusFor(
        firstMonth.offsetWidth,
        firstMonth.offsetHeight,
      ).toFixed(1)}px`);
    }
    if (firstDay) {
      surface.style.setProperty("--day-r", `${radiusFor(
        firstDay.offsetWidth,
        firstDay.offsetHeight,
      ).toFixed(1)}px`);
    }
    syncCalendarMaterial(root);
    layers.slice(1).forEach((layer) => {
      const live = layer?.querySelector?.(":scope > .fc-expander-live");
      if (layer?.dataset?.kind === "month") syncCalendarMaterial(live);
    });
    const viewport = expRect();
    layoutGeometrySignature = [
      innerWidth,
      innerHeight,
      viewport.x.toFixed(2),
      viewport.y.toFixed(2),
      viewport.w.toFixed(2),
      viewport.h.toFixed(2),
    ].join("|");
    surface.dataset.geometrySignature = layoutGeometrySignature;
    surface.dataset.geometryReady = "true";
    if (!surface.classList.contains("fc-camera-moving")) {
      if (Number(surface.dataset.level || 0) > 0) {
        seatBackdropCover({ surface, expRect });
      } else hideBackdropCover();
    }
  };

  const transitionSourceKey = (target) => (
    target?.dataset?.month ? `month:${target.dataset.month}` : `day:${target?.dataset?.date || ""}`
  );
  const createTransitionCopy = (expander, target, isMonth) => {
    const copy = expander.querySelector(":scope > .fc-transition-copy");
    if (!copy) return;
    copy.className = `fc-transition-copy${isMonth ? " fc-month-layout" : ""}`;
    copy.dataset.kind = isMonth ? "month" : "day";
    if (isMonth) {
      // The transition face is purely visual. Clone the already-rendered
      // source month instead of constructing a second collection of tile
      // records on the click path.
      copy.replaceChildren(...[...target.children].map((child) => child.cloneNode(true)));
      copy.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
      copy.querySelectorAll("button,[tabindex]").forEach((node) => {
        node.tabIndex = -1;
        node.setAttribute("aria-hidden", "true");
      });
    } else {
      const clone = target.cloneNode(true);
      clone.classList.remove("fc-camera-target");
      clone.classList.add("fc-transition-day-tile");
      clone.tabIndex = -1;
      clone.setAttribute("aria-hidden", "true");
      copy.replaceChildren(clone);
    }
  };
  const renderExpander = (expander, target) => {
    const isMonth = expander.dataset.kind === "month";
    createTransitionCopy(expander, target, isMonth);
    const live = expander.querySelector(":scope > .fc-expander-live");
    if (isMonth) {
      mountMonthContents(live, Number(expander.dataset.month) - 1, {
        interactiveDays:true,
        material:true,
      });
    } else {
      live.innerHTML = dayInnerHTML(expander.dataset.date);
    }
    expander.dataset.renderRevision = String(renderRevision);
    if (expander.isConnected && isMonth) syncCalendarMaterial(live);
  };
  const buildExpander = (target, context) => {
    const isMonth = context.level === 0;
    const expander = isMonth
      ? document.createElement("div")
      : createTileElement({
        id:`calendar-detail-${target.dataset.date}`,
        key:target.dataset.date,
        title:target.getAttribute("aria-label") || target.dataset.date,
        tileKind:"calendar-day-detail",
        targetType:"calendar-day",
        targetId:target.dataset.date,
      }, {
        tagName:"div",
        className:"fc-day-expander",
        ariaLabel:target.getAttribute("aria-label") || target.dataset.date,
      });
    expander.classList.add("fc-bucket", "fc-expander");
    expander.dataset.kind = isMonth ? "month" : "day";
    if (isMonth) expander.dataset.month = target.dataset.month;
    else expander.dataset.date = target.dataset.date;
    if (!isMonth) {
      const tint = document.createElement("span");
      tint.className = "fc-day-expander-tint";
      tint.setAttribute("aria-hidden", "true");
      const material = document.createElement("span");
      material.className = "crm-tile-material-plane fc-day-detail-material";
      material.setAttribute("aria-hidden", "true");
      material.dataset.crmTileMaterialCount = "1";
      material.dataset.crmTileMaterialReady = "true";
      expander.append(tint, material);
    }
    const copy = document.createElement("div");
    copy.className = "fc-transition-copy";
    copy.setAttribute("aria-hidden", "true");
    const live = document.createElement("div");
    live.className = `fc-expander-live${isMonth ? " fc-month-layout" : ""}`;
    const frame = document.createElement("span");
    frame.className = "fc-transition-acrylic";
    frame.setAttribute("aria-hidden", "true");
    expander.append(copy, live, frame);
    renderExpander(expander, target);
    return expander;
  };

  const materialPlaneForTarget = (target) => {
    if (!target) return null;
    if (target.matches?.(".fc-month")) {
      return target.querySelector(":scope > .crm-tile-material-plane")
        || target.closest(".fc-level")
          ?.querySelector?.(":scope > .crm-tile-material-plane")
        || null;
    }
    if (target.matches?.(".fc-day")) {
      return target.closest(".fc-expander-live,.fc-level")
        ?.querySelector?.(":scope > .crm-tile-material-plane") || null;
    }
    return null;
  };
  const materialTilesForTarget = (target) => (
    target?.matches?.(".fc-month")
      ? [...target.querySelectorAll(".fc-day")]
      : (target?.matches?.(".fc-day") ? [target] : [])
  );
  const lensForTarget = (target) => (
    target?.matches?.(".fc-month") ? monthAcrylicLens : dayAcrylicLens
  );
  const sourceMaterialTarget = (_expander, target) => materialPlaneForTarget(target) || target;
  const acrylicTransformGeometry = (expander, target, context) => {
    const tiles = materialTilesForTarget(target);
    if (!tiles.length || !context.surface || !context.sourceRect || !context.destinationRect) return null;
    const surfaceRect = context.surfaceRect || context.surface.getBoundingClientRect();
    const source = context.sourceRect;
    const destination = context.destinationRect;
    const scaleX = destination.width / Math.max(1, source.width);
    const scaleY = destination.height / Math.max(1, source.height);
    const radiusParts = getComputedStyle(expander).borderTopLeftRadius
      .split(/\s+/)
      .map((value) => parseFloat(value) || 0);
    const boundaryRadiusX = radiusParts[0] || 0;
    const boundaryRadiusY = radiusParts[1] || boundaryRadiusX;
    const sourceRadius = target.matches?.(".fc-day")
      ? Math.max(0, Math.min(
        boundaryRadiusX / Math.max(.0001, scaleX),
        boundaryRadiusY / Math.max(.0001, scaleY),
      ))
      : null;
    const sourceClip = tileUnionPath(
      tiles,
      context.surface,
      sourceRadius == null
        ? { precise:true }
        : { precise:true, radius:sourceRadius },
    );
    if (sourceClip === "none") return null;
    const sourceX = source.left - surfaceRect.left;
    const sourceY = source.top - surfaceRect.top;
    const destinationX = destination.left - surfaceRect.left;
    const destinationY = destination.top - surfaceRect.top;
    const translateX = destinationX - (sourceX * scaleX);
    const translateY = destinationY - (sourceY * scaleY);
    const forward = `translate(${translateX.toFixed(3)}px,${translateY.toFixed(3)}px) ` +
      `scale(${scaleX.toFixed(6)},${scaleY.toFixed(6)}) translateZ(0)`;
    const inverse = `scale(${(1 / scaleX).toFixed(6)},${(1 / scaleY).toFixed(6)}) ` +
      `translate(${(-translateX).toFixed(3)}px,${(-translateY).toFixed(3)}px) translateZ(0)`;
    return {
      mode:"transform",
      sourceClip,
      destinationClip:sourceClip,
      sourceOwnerTransform:"translateZ(0)",
      destinationOwnerTransform:forward,
      sourceLensTransform:"translateZ(0)",
      destinationLensTransform:inverse,
      boundaryRadiusX,
      boundaryRadiusY,
    };
  };
  const finishMaterialHandoff = (lens, token = materialHandoffs.get(lens)) => {
    if (!lens || !token || materialHandoffs.get(lens) !== token) return;
    materialHandoffs.delete(lens);
    token.destinationAnimation?.cancel?.();
    if (token.destination?.isConnected && token.endpointOpacity != null) {
      token.destination.style.opacity = String(token.endpointOpacity);
    }
    // Keep the transparent compositor shell mounted for the next zoom. DOM
    // removal of a full-screen backdrop plane can itself cost several frames
    // after the visual handoff has completed.
    if (!lens.park?.()) lens.finish?.();
  };
  const finishAllMaterialHandoffs = () => {
    [...materialHandoffs.entries()].forEach(([lens, token]) => {
      finishMaterialHandoff(lens, token);
    });
  };
  const configureExpander = (expander, target, context) => {
    const kind = target.dataset.month ? "month" : "day";
    const nextMonth = target.dataset.month || "";
    const nextDate = target.dataset.date || "";
    const targetChanged = expander.dataset.kind !== kind
      || (kind === "month" && expander.dataset.month !== nextMonth)
      || (kind === "day" && expander.dataset.date !== nextDate);
    expander.dataset.kind = kind;
    if (kind === "month") {
      expander.dataset.month = nextMonth;
      delete expander.dataset.date;
    } else {
      expander.dataset.date = nextDate;
      delete expander.dataset.month;
    }
    const lens = lensForTarget(target);
    if (context.direction && materialHandoffs.has(lens)) {
      // A rapid reversal may reuse this exact lens. Finish only that owner;
      // a handoff from the previous zoom level can complete independently
      // instead of forcing an unrelated full-screen compositor teardown.
      finishMaterialHandoff(lens);
    }
    if (context.direction === "contract") {
      activeTransition = {
        ...(activeTransition || {}),
        target,
        key:transitionSourceKey(target),
        kind,
        month:target.dataset.month || "",
        date:target.dataset.date || "",
        lens,
      };
      target.classList.add("fc-camera-target");
    } else if (context.direction === "expand" && activeTransition) {
      activeTransition.lens = lens;
    }
    const viewport = context.expRect();
    const source = context.sourceRect;
    const needsRender = targetChanged
      || expander.dataset.renderRevision !== String(renderRevision);
    const signature = [
      transitionSourceKey(target),
      renderRevision,
      viewport.w.toFixed(2),
      viewport.h.toFixed(2),
      source.w.toFixed(2),
      source.h.toFixed(2),
    ].join("|");
    if (needsRender) renderExpander(expander, target);
    expander.style.setProperty("--kx", (viewport.w / Math.max(1, source.w)).toFixed(4));
    expander.style.setProperty("--ky", (viewport.h / Math.max(1, source.h)).toFixed(4));
    expander.style.setProperty("--fractal-camera-morph-ms", `${MORPH_MS}ms`);
    expander.dataset.transitionGeometry = signature;
    if (expander.isConnected && expander.dataset.kind === "month") {
      const live = expander.querySelector(":scope > .fc-expander-live");
      const material = live?.querySelector?.(":scope > .crm-tile-material-plane");
      if (needsRender || material?.dataset?.crmTileMaterialReady !== "true") {
        syncCalendarMaterial(live);
      }
    }
    if (context.direction) {
      expander.querySelectorAll?.(
        ":scope > .fc-day-detail-material," +
        ":scope > .fc-expander-live > .crm-tile-material-plane",
      ).forEach((plane) => plane.style.removeProperty("opacity"));
    }
    lens?.prepare?.(expander, target, context);
  };

  const targetFromEvent = (event, context) => {
    if (event.target?.closest?.(".fc-year-btn,.fc-year-face")) return null;
    const selector = context.level === 0 ? ".fc-month" : ".fc-day";
    const target = event.target?.closest?.(selector);
    const layer = context.layers?.[context.level];
    return target && layer?.contains(target) ? target : null;
  };
  const targetFromPoint = (x, y, context) => {
    if (context.level >= 2) return null;
    const selector = context.level === 0 ? ".fc-month" : ".fc-day";
    const target = document.elementFromPoint(x, y)?.closest?.(selector);
    return target && context.layers?.[context.level]?.contains(target) ? target : null;
  };
  const sourceSelector = (target, context) => (
    context.level === 0
      ? `:scope > .fc-grid > .fc-month[data-month="${target.dataset.month}"]`
      : `:scope > .fc-expander-live .fc-day[data-date="${target.dataset.date}"]`
  );
  // Month shells share one compositor shape, as do day shells. The real tile
  // records are rebound in configureExpander; only the warmed backdrop shell
  // is reused between selections.
  const keyOf = (target) => (
    target.dataset.month ? "calendar-month-shell" : "calendar-day-shell"
  );
  const markCameraTarget = (target, context) => {
    context.layers?.forEach?.((layer) => {
      layer?.querySelectorAll?.(".fc-camera-target")?.forEach?.((node) => {
        node.classList.remove("fc-camera-target");
      });
    });
    target?.classList?.add?.("fc-camera-target");
    activeTransition = {
      target,
      key:transitionSourceKey(target),
      kind:target?.dataset?.month ? "month" : "day",
      month:target?.dataset?.month || "",
      date:target?.dataset?.date || "",
    };
  };
  const clearCameraTargets = (surface) => {
    surface?.querySelectorAll?.(".fc-camera-target")?.forEach?.((target) => {
      target.classList.remove("fc-camera-target");
    });
  };
  const clearMaterialExclusion = (plane) => {
    if (!plane) return;
    [
      "maskImage",
      "maskPosition",
      "maskSize",
      "maskRepeat",
      "maskComposite",
      "webkitMaskImage",
      "webkitMaskPosition",
      "webkitMaskSize",
      "webkitMaskRepeat",
      "webkitMaskComposite",
    ].forEach((property) => plane.style[property] = "");
    delete plane.dataset.crmTileMaterialExcluded;
    delete plane.dataset.crmTileMaterialMuted;
  };
  const excludeTransitionTiles = () => {
    const target = activeTransition?.target;
    const tiles = materialTilesForTarget(target);
    if (!tiles.length) return;
    const plane = materialPlaneForTarget(target);
    if (!plane) return;
    // The live wallpaper cover occludes the source region from the first
    // transform frame. Mutating a backdrop mask here would force the full
    // 365-day plane to reraster on click.
    activeTransition.sourcePlane = plane;
    activeTransition.sourceTiles = tiles;
  };
  const endpointMaterial = (context) => {
    const layer = context.layers?.[context.level];
    if (!layer) return null;
    if (context.level === 0) {
      return layer.querySelector(":scope > .crm-tile-material-plane");
    }
    if (layer.dataset.kind === "month") {
      return layer.querySelector(":scope > .fc-expander-live > .crm-tile-material-plane");
    }
    return layer.querySelector(":scope > .fc-day-detail-material");
  };
  const settleTransitionMaterial = (direction, context) => {
    const transition = activeTransition;
    const lens = transition?.lens;
    if (!transition || !lens) return;
    const destination = endpointMaterial(context);
    if (transition.sourcePlane?.isConnected) {
      clearMaterialExclusion(transition.sourcePlane);
    }
    let destinationAnimation = null;
    if (destination?.isConnected && direction === "expand") {
      clearMaterialExclusion(destination);
      destination.style.opacity = ".999";
    } else if (destination?.isConnected) {
      clearMaterialExclusion(destination);
    }
    const token = {
      destination,
      destinationAnimation,
      endpointOpacity:direction === "expand" ? .999 : null,
    };
    materialHandoffs.set(lens, token);
    const release = lens.release?.();
    Promise.allSettled([
      release,
      destinationAnimation?.finished,
    ].filter(Boolean)).then(() => finishMaterialHandoff(lens, token));
  };
  const resetTransitionMaterials = () => {
    camera?.surface?.()?.querySelectorAll?.(".crm-tile-material-plane")?.forEach?.(
      (plane) => {
        clearMaterialExclusion(plane);
        plane.style.removeProperty("opacity");
      },
    );
    finishAllMaterialHandoffs();
    monthAcrylicLens?.finish?.();
    dayAcrylicLens?.finish?.();
    hideBackdropCover();
    activeTransition = null;
  };

  const setYear = (year) => {
    currentYear = Math.max(1901, Math.min(2200, Number(year) || currentYear));
    localStorage.setItem(YEAR_STORE, String(currentYear));
    resetTransitionMaterials();
    camera?.rebuildRoot?.();
    ensureYearChrome();
    void loadScheduled({ refresh:true });
  };
  const shiftYear = (delta) => setYear(currentYear + delta);
  const openMonthFor = (value = new Date()) => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return false;
    if (camera?.isTransitioning?.()) {
      camera.whenSettled?.().then(() => openMonthFor(date));
      return true;
    }
    const year = date.getFullYear();
    if (currentYear !== year) {
      currentYear = year;
      localStorage.setItem(YEAR_STORE, String(currentYear));
    }
    resetTransitionMaterials();
    camera.rebuildRoot();
    ensureYearChrome();
    const month = camera.layers()[0]?.querySelector(
      `.fc-month[data-month="${date.getMonth() + 1}"]`,
    );
    const opened = camera.jumpTo(month);
    void loadScheduled({ refresh:true });
    return opened;
  };

  const loadScheduled = async ({ refresh = false } = {}) => {
    const next = new Map();
    let projects = [];
    let workItems = [];
    const add = (type, label, record) => {
      if (!record || record.deletedAt) return;
      const date = scheduledDateOf(record);
      if (!date || !yearDate(date)) return;
      const workLink = (record.links || []).find((link) => link.entityType === "workItems");
      const workItem = workItems.find((item) => String(item.id) === String(workLink?.recordId));
      const projectId = String(record.projectId || workItem?.projectId || "");
      const project = projects.find((candidate) => String(candidate.id) === projectId);
      const projectStages = (Array.isArray(project?.stages) ? project.stages : [])
        .map((stage, index) => ({
          id:String(stage.id || index),
          kind:String(stage.kind || "active"),
          rank:Number.isFinite(Number(stage.rank)) ? Number(stage.rank) : index,
        }))
        .sort((first, second) => first.rank - second.rank);
      const items = next.get(date) || [];
      items.push({
        type,
        label,
        id:record.id,
        title:titleOf(record),
        hot:record.priority === "urgent" && Date.parse(record.dueAt || "") < Date.now(),
        projectTitle:String(project?.title || record.projectTitle || workItem?.projectTitle || ""),
        stageId:String(record.stageId || workItem?.stageId || ""),
        projectStages,
      });
      next.set(date, items);
    };
    try {
      const [commitmentResult, projectResult, workItemResult] = await Promise.all([
        window.crmDomain?.list?.("commitments", { includeDeleted:false, limit:500 }),
        window.crmStore?.list?.("projects", { includeDeleted:false }),
        window.crmStore?.list?.("workItems", { includeDeleted:false }),
      ]);
      projects = recordsFrom(projectResult).filter((record) => !record.deletedAt);
      workItems = recordsFrom(workItemResult).filter((record) => !record.deletedAt);
      recordsFrom(commitmentResult)
        .filter((record) => !["completed", "cancelled", "canceled"].includes(
          String(record.status).toLowerCase(),
        ))
        .forEach((record) => add("commitment", record.kind || "Commitment", {
          ...record,
          dueDate:record.dueAt,
        }));
    } catch {}
    scheduledByDate = next;
    renderRevision += 1;
    if (refresh && camera) refreshLevels();
  };
  const refreshLevels = () => {
    if (!camera) return;
    if (camera.isTransitioning?.()) {
      scheduleReload();
      return;
    }
    resetTransitionMaterials();
    camera.dropWarm?.();
    const layers = camera.layers();
    const root = layers[0];
    const grid = root?.querySelector?.(":scope > .fc-grid");
    if (grid) {
      [...grid.querySelectorAll(":scope > .fc-month")].forEach((month) => {
        mountMonthContents(month, Number(month.dataset.month) - 1, {
          interactiveDays:false,
          material:false,
        });
      });
      ensureTileMaterialPlane(root, {
        className:"fc-calendar-tile-material fc-year-tile-material",
        tileSelector:":scope > .fc-grid > .fc-month > .fc-days > .fc-day",
      });
    }
    layers.slice(1).forEach((layer) => {
      if (!layer?.dataset) return;
      const target = layer.dataset.kind === "month"
        ? root?.querySelector?.(`.fc-month[data-month="${layer.dataset.month}"]`)
        : layers[1]?.querySelector?.(`.fc-day[data-date="${layer.dataset.date}"]`);
      if (target) renderExpander(layer, target);
    });
    camera.layout();
    scheduleYearMaterialPrewarm();
  };
  const scheduleYearMaterialPrewarm = ({ delay = 0 } = {}) => {
    clearTimeout(materialPrewarmTimer);
    materialPrewarmTimer = 0;
    cancelAnimationFrame(materialPrewarmFrame);
    materialPrewarmTimer = setTimeout(() => {
      materialPrewarmTimer = 0;
      materialPrewarmFrame = requestAnimationFrame(() => {
        materialPrewarmFrame = 0;
        if (!camera?.isActive?.() || camera.isTransitioning?.()) return;
        const level = camera.level();
        let target = null;
        if (level === 0) {
          const preferredMonth = currentYear === crmNow().getFullYear()
            ? crmNow().getMonth() + 1
            : 1;
          target = camera.layers()?.[0]?.querySelector?.(
            `:scope > .fc-grid > .fc-month[data-month="${preferredMonth}"]`,
          );
        } else if (level === 1) {
          const monthLayer = camera.layers()?.[1];
          const preferredDate = currentYear === crmNow().getFullYear()
            && Number(monthLayer?.dataset?.month) === crmNow().getMonth() + 1
            ? todayIso()
            : "";
          target = (preferredDate && monthLayer?.querySelector?.(
            `.fc-day[data-date="${preferredDate}"]`,
          )) || monthLayer?.querySelector?.(".fc-day");
        }
        if (target) camera.prefetch?.(target);
      });
    }, Math.max(0, Number(delay) || 0));
  };
  const scheduleReload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => loadScheduled({ refresh:true }), 80);
  };
  const subscribeScheduled = () => {
    if (subscriptionsReady) return;
    subscriptionsReady = true;
    try { window.crmDomain?.onChanged?.(scheduleReload); } catch {}
  };

  const draggedWidget = () => document.querySelector(
    ".dashboard-layout-grid .widget-card.widget-dragging[data-widget-runtime-type], " +
    ".widget-layout .widget-card.widget-dragging[data-widget-runtime-type]",
  );
  const dayAtPoint = (x, y, ignore = null) => {
    const old = ignore ? ignore.style.pointerEvents : "";
    if (ignore) ignore.style.pointerEvents = "none";
    const element = document.elementFromPoint(x, y)?.closest?.(
      ".fc-day[data-date],.fc-day-detail[data-date],.fc-empty[data-date]",
    ) || null;
    if (ignore) ignore.style.pointerEvents = old;
    return element;
  };
  const setDropHighlight = (element) => {
    const day = element?.closest?.(".fc-day") || null;
    if (day === dropHighlight) return;
    dropHighlight?.classList.remove("is-drop-target");
    dropHighlight = day;
    dropHighlight?.classList.add("is-drop-target");
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
      const cardTitle = widget.querySelector?.(".ticket-company")?.textContent?.trim()
        || `Follow up ${source.entity}`;
      const result = await window.crmDomain?.create?.("commitments", {
        title:cardTitle,
        kind:"follow-up",
        dueAt:`${date}T09:00:00`,
        links:[{ entityType:source.entity, recordId:id }],
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
      if (!widget) {
        setDropHighlight(null);
        return;
      }
      setDropHighlight(dayAtPoint(event.clientX, event.clientY, widget));
    }, true);
    document.addEventListener("pointerup", (event) => {
      if (!camera?.isActive?.()) return;
      const widget = draggedWidget();
      const target = widget ? dayAtPoint(event.clientX, event.clientY, widget) : null;
      setDropHighlight(null);
      if (widget && target?.dataset?.date) void scheduleWidget(widget, target.dataset.date);
    }, true);
  };
  const wireDayOpens = () => {
    document.addEventListener("click", async (event) => {
      const chip = event.target?.closest?.(".fc-day-detail .fc-chip[data-id]");
      if (!chip || !camera?.surface?.()?.contains(chip) || chip.dataset.type !== "commitment") return;
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
  const activeDayElement = (date) => {
    const layers = camera?.layers?.() || [];
    if (camera?.level?.() >= 2 && layers[2]?.dataset?.date === date) {
      return layers[2].querySelector(
        `:scope > .fc-expander-live .fc-day-detail[data-date="${date}"],` +
        `:scope > .fc-expander-live .fc-empty[data-date="${date}"]`,
      );
    }
    if (camera?.level?.() >= 1) {
      return layers[1]?.querySelector?.(
        `:scope > .fc-expander-live .fc-day[data-date="${date}"]`,
      ) || null;
    }
    return layers[0]?.querySelector?.(
      `:scope > .fc-grid .fc-day[data-date="${date}"]`,
    ) || null;
  };
  const flyCardToDay = (fromRect, date, { title = "" } = {}) => {
    const surface = camera?.surface?.();
    if (!camera?.isActive?.() || !surface || surface.hidden) return false;
    const destination = activeDayElement(date);
    if (!destination || !fromRect || fromRect.width < 4) return false;
    const to = destination.getBoundingClientRect();
    if (to.width < 4) return false;
    const clone = document.createElement("div");
    clone.className = "fc-fly-card";
    clone.textContent = title;
    Object.assign(clone.style, {
      left:`${Math.round(fromRect.left)}px`,
      top:`${Math.round(fromRect.top)}px`,
      width:`${Math.round(fromRect.width)}px`,
      height:`${Math.round(fromRect.height)}px`,
      transformOrigin:"top left",
    });
    document.body.appendChild(clone);
    requestAnimationFrame(() => {
      clone.style.transform = `translate(${Math.round(to.left - fromRect.left)}px,` +
        `${Math.round(to.top - fromRect.top)}px) scale(${(to.width / fromRect.width).toFixed(4)},` +
        `${(to.height / fromRect.height).toFixed(4)})`;
      clone.style.opacity = ".12";
    });
    setTimeout(() => {
      clone.remove();
      destination.classList.add("is-drop-target");
      setTimeout(() => destination.classList.remove("is-drop-target"), 340);
    }, 500);
    scheduleReload();
    return true;
  };
  const wireCalendarControls = () => {
    document.addEventListener("click", (event) => {
      const button = event.target?.closest?.(".fc-year-btn,.fc-year-face");
      if (!button || !camera?.isActive?.()
        || button.closest(".fc-year-strip") !== document.querySelector("body > .fc-year-strip")) return;
      event.preventDefault();
      event.stopPropagation();
      if (camera?.isTransitioning?.()) return;
      if (button.matches(".fc-year-face")) setYear(crmNow().getFullYear());
      else shiftYear(Number(button.dataset.yearStep) || 0);
    }, true);
    document.addEventListener("keydown", (event) => {
      if (!camera?.isActive?.() || !["Enter", " "].includes(event.key)) return;
      const target = event.target?.closest?.(".fc-month,.fc-day");
      if (!target || !camera.surface()?.contains(target)) return;
      event.preventDefault();
      target.click();
    }, true);
  };

  const createCalendarAcrylicLens = (options = {}) => window.createFractalAcrylicLens({
    frameSelector:":scope > .fc-transition-acrylic",
    ownerClass:"fc-source-acrylic-owner",
    lensClass:"fc-source-screen-acrylic",
    materialTarget:sourceMaterialTarget,
    clipGeometry:acrylicTransformGeometry,
    holdThroughMotion:true,
    motionHandoffStart:.54,
    clipToDestinationBounds:options.clipToDestinationBounds === true,
    prewarmOpacity:options.prewarmOpacity ?? MATERIAL_PRIME_OPACITY,
    prewarmZIndex:options.prewarmZIndex,
    parkOpacity:.001,
    releaseMs:MATERIAL_HANDOFF_MS,
    releaseEase:"linear",
    expandZIndex:4,
    contractZIndex:4,
  });
  monthAcrylicLens = createCalendarAcrylicLens();
  dayAcrylicLens = createCalendarAcrylicLens({
    prewarmOpacity:MATERIAL_PRIME_OPACITY,
    prewarmZIndex:2,
  });

  camera = window.createFractalCamera({
    apiName:"fractalCalendarCamera",
    theater:"calendar",
    surfaceClass:"fc-surface",
    layerClass:"fc-level",
    warmClass:"fc-warm",
    contractingClass:"fc-contracting-expander",
    active:false,
    maxLevel:2,
    ease:EASE,
    morphMs:MORPH_MS,
    margin:EXP_M,
    measureTop:() => EXP_TOP,
    keepBelowVisibleDuringTransition:true,
    keepBelowStationaryDuringTransition:true,
    keepBelowRenderedAtRest:true,
    precomposeTransitions:false,
    animateWarmExpander:false,
    lockInputDuringTransitions:true,
    contractExpanderAbove:true,
    holdContractEndpointFrame:true,
    keepExpanderOpaqueDuringTransition:true,
    ensureStyles,
    buildRoot:buildYear,
    layout:layoutCalendar,
    buildExpander,
    configureExpander,
    primeExpander:() => {
      monthAcrylicLens?.prime?.();
      dayAcrylicLens?.prime?.();
    },
    prepareTarget:markCameraTarget,
    targetFromEvent,
    targetAtPoint:targetFromPoint,
    sourceSelector,
    keyOf,
    onTransitionStart:(direction, context) => {
      excludeTransitionTiles();
      const belowIndex = direction === "expand" ? context.level : context.level - 1;
      context.layers?.[belowIndex]?.classList?.add?.("fc-calendar-below");
      prepareBackdropCover(direction, context);
      context.surface?.classList.add("fc-camera-moving");
      context.surface?.classList.toggle("fc-camera-expanding", direction === "expand");
      context.surface?.classList.toggle("fc-camera-contracting", direction === "contract");
    },
    onTransformPrepare:(direction) => {
      activeTransition?.lens?.start?.(direction);
      startBackdropCover(direction);
    },
    onTransformReady:(_direction, context) => {
      activeTransition?.lens?.sync?.(context.transformAnimation, context.transformStartTime);
      syncBackdropCover(context.transformStartTime);
    },
    onTransitionEnd:(direction, context) => {
      settleTransitionMaterial(direction, context);
      settleBackdropCover(direction, context);
      clearCameraTargets(context.surface);
      context.layers?.forEach?.((layer) => layer?.classList?.remove?.("fc-calendar-below"));
      context.surface?.classList.remove(
        "fc-camera-moving",
        "fc-camera-expanding",
        "fc-camera-contracting",
      );
      activeTransition = null;
      if (context.level < 2) {
        // Do not upload the next zoom shell during the live material
        // crossfade. That work is useful, but it must happen after the user
        // has seen a clean endpoint paint.
        scheduleYearMaterialPrewarm({ delay:MATERIAL_HANDOFF_MS + 40 });
      }
    },
    onLevelChange:(context) => {
      ensureYearChrome(context.surface);
      context.layers?.forEach?.((layer, index) => {
        layer?.classList?.toggle?.("fc-calendar-active-level", index === context.level);
      });
      if (!context.surface?.classList.contains("fc-camera-moving")) {
        clearCameraTargets(context.surface);
        if (context.level > 0) seatBackdropCover(context);
        else hideBackdropCover();
      }
    },
    onActiveChange:(active, context) => {
      const yearChrome = ensureYearChrome(context.surface);
      if (yearChrome) yearChrome.hidden = !active;
      clearTimeout(backdropCoverPrewarmTimer);
      backdropCoverPrewarmTimer = 0;
      backdropCoverSourceObserver?.disconnect?.();
      backdropCoverSourceObserver = null;
      if (!active) {
        clearTimeout(materialPrewarmTimer);
        materialPrewarmTimer = 0;
        cancelAnimationFrame(materialPrewarmFrame);
        materialPrewarmFrame = 0;
        resetTransitionMaterials();
      } else {
        const syncBackdropSource = () => {
          const source = document.querySelector("body > .workspace-photo-backdrop");
          if (!source?.querySelector?.(".workspace-photo-panel")) return false;
          backdropCoverSourceObserver?.disconnect?.();
          backdropCoverSourceObserver = null;
          updateBackdropCoverGeometry(context);
          if (context.level > 0) seatBackdropCover(context);
          else hideBackdropCover();
          return true;
        };
        if (!syncBackdropSource()) {
          // Background panels are mounted by the workspace after Calendar can
          // become active. Observe that exact source so the first click never
          // has to build its live wallpaper clone on the interaction frame.
          backdropCoverSourceObserver = new MutationObserver(syncBackdropSource);
          backdropCoverSourceObserver.observe(document.body, {
            childList:true,
            subtree:true,
          });
        }
        requestAnimationFrame(() => {
          if (!camera?.isActive?.()) return;
          updateBackdropCoverGeometry(context);
          if (context.level > 0) seatBackdropCover(context);
          else hideBackdropCover();
        });
        // The photo surface may finish mounting one frame after the Calendar.
        // Warm the exact live wallpaper clone once it exists so the first
        // zoom never pays that DOM/compositor setup cost on the click frame.
        const warmBackdropWhenReady = (attempt = 0) => {
          backdropCoverPrewarmTimer = 0;
          if (!camera?.isActive?.() || camera?.isTransitioning?.()) return;
          const source = document.querySelector("body > .workspace-photo-backdrop");
          const expectsPhoto = document.body.classList.contains("has-photo-background");
          const sourceReady = source
            ? source.querySelectorAll(".workspace-photo-panel").length > 0
            : !expectsPhoto;
          updateBackdropCoverGeometry(context);
          if (context.level > 0) seatBackdropCover(context);
          else hideBackdropCover();
          if (!sourceReady && attempt < 12) {
            backdropCoverPrewarmTimer = setTimeout(
              () => warmBackdropWhenReady(attempt + 1),
              240,
            );
          }
        };
        backdropCoverPrewarmTimer = setTimeout(warmBackdropWhenReady, 120);
        scheduleYearMaterialPrewarm();
      }
    },
    onRootBack:() => window.crmDeskTransit?.driveTo?.("home"),
    onReady:() => {
      ensureYearChrome();
      wireCalendarControls();
      wireDrops();
      wireDayOpens();
      subscribeScheduled();
      void loadScheduled({ refresh:true });
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
      camera.rebuildRoot();
      await loadScheduled({ refresh:true });
    }
    await camera.restoreHistoryState?.(state.camera || {});
    return homePreviewState();
  };

  window.fractalCalendar = {
    setActive:(active) => camera.setActive(active),
    isActive:() => camera.isActive(),
    year:() => currentYear,
    setYear,
    nextYear:() => shiftYear(1),
    previousYear:() => shiftYear(-1),
    openMonthFor,
    level:() => camera.level(),
    back:() => camera.back(),
    geometryReady:() => true,
    geometrySignature:() => layoutGeometrySignature,
    stripCaptureState:() => ({ ready:true, mode:"live-camera-chrome", year:currentYear }),
    stripCaptureRequestState:() => ({ ready:true, mode:"live-camera-chrome", year:currentYear }),
    stripCaptureDiagnostics:() => ({
      mode:"live-camera-chrome",
      captureWorkers:0,
      pending:0,
      lastError:"",
    }),
    homePreviewState,
    applyHomePreviewState,
    refresh:() => loadScheduled({ refresh:true }),
    miniature:() => {
      ensureStyles();
      const year = buildYear();
      year.classList.add("crm-calendar-mini-scene");
      requestAnimationFrame(() => syncCalendarMaterial(year));
      return year;
    },
    dayEl:activeDayElement,
    monthEl:(month) => camera.layers()?.[1]?.matches?.(
      `.fc-expander[data-month="${month}"]`,
    )
      ? camera.layers()[1]
      : camera.layers()?.[0]?.querySelector?.(
        `:scope > .fc-grid > .fc-month[data-month="${month}"]`,
      ) || null,
    scheduleWidget,
    flyCardToDay,
    _parity:(monthIndex, opacity = 1) => {
      const layers = camera.layers();
      const mini = layers[0]?.querySelector(`.fc-month[data-month="${monthIndex}"]`);
      if (!mini) return null;
      const viewport = camera.expRect();
      const source = camera.layoutRect(mini, layers[0]);
      const expander = buildExpander(mini, {
        level:0,
        sourceRect:source,
        expRect:camera.expRect,
      });
      expander.classList.add("fc-parity");
      Object.assign(expander.style, {
        left:`${viewport.x}px`,
        top:`${viewport.y}px`,
        width:`${viewport.w}px`,
        height:`${viewport.h}px`,
        opacity:String(opacity),
        transformOrigin:"0 0",
        transform:`translate(${(mini.getBoundingClientRect().left - viewport.x).toFixed(2)}px,` +
          `${(mini.getBoundingClientRect().top - viewport.y).toFixed(2)}px) ` +
          `scale(${(source.w / viewport.w).toFixed(5)},${(source.h / viewport.h).toFixed(5)})`,
      });
      expander.style.setProperty("--kx", (viewport.w / source.w).toFixed(4));
      expander.style.setProperty("--ky", (viewport.h / source.h).toFixed(4));
      camera.surface().appendChild(expander);
      syncCalendarMaterial(expander.querySelector(":scope > .fc-expander-live"));
      const miniCells = [...mini.querySelectorAll(".fc-day")];
      const expanderCells = [...expander.querySelectorAll(":scope > .fc-expander-live .fc-day")];
      const deltas = miniCells.map((cell, index) => {
        const first = cell.getBoundingClientRect();
        const second = expanderCells[index].getBoundingClientRect();
        return [
          second.left - first.left,
          second.top - first.top,
          second.right - first.right,
          second.bottom - first.bottom,
        ].map((value) => +value.toFixed(2));
      });
      return {
        worst:Math.max(...deltas.flat().map(Math.abs)),
        day1:deltas[0],
        day31:deltas[deltas.length - 1],
      };
    },
    _parityClear:() => camera.surface()?.querySelectorAll(".fc-parity").forEach((element) => {
      element.remove();
    }),
  };
})();
