import {
  bindTileObject,
  createTileInstance,
  createTileObjectElement,
  createTileTree,
  ensureTileMaterialPlane,
  indexTileTree,
  isTileObject,
  mountTileChildren,
  normalizeTileRecord,
  syncTileMaterialPlane,
  tileDataOf,
  tileKindOf,
  tileObjectForElement,
  tilePreviewHostFor,
  tileUnionPath,
} from "./modules/tile-system.js";

// Calendar is one recursive tree of concrete viewport tiles hosted by the
// shared fractal camera. Months and days use the same object constructor,
// instance factory, preview store, and child-collection renderer.
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
  const TILE_PREVIEW_VERSION = "canonical-tile-preview-v1";
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
  let calendarYearObject = null;
  let tileTreeIndex = null;
  let calendarDaysByDate = new Map();
  let calendarEntriesById = new Map();
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
  const tilePreviews = new Map();
  const tilePreviewRequests = new Set();
  const tilePreviewListedScopes = new Set();
  const tilePreviewTimers = new Map();
  let tilePreviewSubscription = null;
  let tilePreviewLastError = "";
  let scheduledDataReadyYear = 0;

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
  const daysInYearMonth = (year, month) => new Date(year, month + 1, 0).getDate();
  const firstDowInYearMonth = (year, month) => new Date(year, month, 1).getDay();
  const isoFor = (year, month, day) => (
    `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  );
  const recordsFrom = (result) => (
    Array.isArray(result) ? result : ((result && (result.records || result.tickets)) || [])
  );
  const scheduledDateOf = (record) => {
    const meta = record?.meta || {};
    const raw = meta.scheduledDate || meta.calendarDate
      || record?.scheduledDate || record?.calendarDate
      || record?.dueDate || record?.dueAt || record?.startDate;
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

  const calendarData = (object) => tileDataOf(object) || {};
  const calendarNodeData = ({
    unit,
    year,
    monthIndex = -1,
    day = 0,
    date = "",
    key = "",
  }) => ({
    domain:"calendar",
    unit,
    year,
    monthIndex,
    month:monthIndex + 1,
    day,
    date,
    key,
    dataSignature:"",
    entries:[],
  });
  const createCalendarYearObject = (year) => {
    const months = MONTHS.map((monthTitle, monthIndex) => {
      const monthKey = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
      const days = Array.from(
        { length:daysInYearMonth(year, monthIndex) },
        (_unused, dayIndex) => {
          const day = dayIndex + 1;
          const date = isoFor(year, monthIndex, day);
          return {
            data:calendarNodeData({
              unit:"day",
              year,
              monthIndex,
              day,
              date,
              key:date,
            }),
            tile:normalizeTileRecord({
              id:`calendar-day-${date}`,
              key:date,
              title:`${monthTitle} ${day}`,
              label:`${monthTitle} ${day}, ${year}`,
              tileKind:"calendar-day",
              targetType:"calendar-day",
              targetId:date,
              rank:dayIndex,
            }),
            children:[],
          };
        },
      );
      return {
        data:calendarNodeData({
          unit:"month",
          year,
          monthIndex,
          key:monthKey,
        }),
        tile:normalizeTileRecord({
          id:`calendar-month-${monthKey}`,
          key:monthKey,
          title:monthTitle,
          label:`${monthTitle} ${year}`,
          tileKind:"calendar-month",
          targetType:"calendar-month",
          targetId:monthKey,
          rank:monthIndex,
        }),
        children:days,
      };
    });
    const object = createTileTree({
      data:calendarNodeData({
        unit:"year",
        year,
        key:String(year),
      }),
      revision:0,
      children:months,
      tile:normalizeTileRecord({
        id:`calendar-year-${year}`,
        key:String(year),
        title:String(year),
        label:`Calendar year ${year}`,
        tileKind:"calendar-year",
        targetType:"calendar-year",
        targetId:String(year),
      }),
    });
    tileTreeIndex = indexTileTree(object);
    calendarDaysByDate = new Map(
      [...tileTreeIndex.objectsById.values()]
        .filter((node) => calendarData(node).unit === "day")
        .map((node) => [calendarData(node).date, node]),
    );
    calendarEntriesById = new Map();
    return object;
  };
  const calendarObject = () => {
    if (!calendarYearObject || calendarData(calendarYearObject).year !== currentYear) {
      calendarYearObject = createCalendarYearObject(currentYear);
    }
    return calendarYearObject;
  };
  const resetCalendarObject = () => {
    calendarYearObject = createCalendarYearObject(currentYear);
    renderRevision += 1;
    scheduledDataReadyYear = 0;
    tilePreviewListedScopes.clear();
    tilePreviewTimers.forEach((timer) => clearTimeout(timer));
    tilePreviewTimers.clear();
    tilePreviewRequests.clear();
    return calendarYearObject;
  };
  const calendarObjectForElement = (element) => {
    if (!element) return null;
    return tileObjectForElement(element)
      || (calendarObject(), tileTreeIndex?.objectForId(element.dataset?.tileObjectId || ""))
      || null;
  };
  const bindCalendarObjectView = (element, object, view, {
    bindSchema = false,
    ...options
  } = {}) => {
    if (!element || !object) return null;
    bindTileObject(element, object, { ...options, bindSchema, view });
    element.dataset.calendarObjectKind = tileKindOf(object);
    element.dataset.calendarObjectRevision = String(object.revision || 0);
    return object;
  };
  const bindClonedCalendarViews = (root) => {
    if (!root) return;
    const nodes = [
      ...(root.matches?.("[data-tile-object-id]") ? [root] : []),
      ...(root.querySelectorAll?.("[data-tile-object-id]") || []),
    ];
    nodes.forEach((node) => {
      calendarObject();
      const object = tileTreeIndex?.objectForId(node.dataset.tileObjectId);
      if (object) bindCalendarObjectView(node, object, "transition-copy");
    });
  };
  const entrySignature = (entry) => JSON.stringify([
    entry.type,
    entry.id,
    entry.title,
    entry.hot,
    entry.projectTitle,
    entry.stageId,
    (entry.projectStages || []).map((stage) => [stage.id, stage.kind, stage.rank]),
  ]);
  const reconcileCalendarData = (yearObject, nextByDate) => {
    calendarObject();
    const activeEntryIds = new Set();
    calendarDaysByDate.forEach((dayObject, date) => {
      const dayData = calendarData(dayObject);
      const nextEntries = (nextByDate.get(date) || []).map((payload) => {
        const objectId = `${payload.type}:${payload.id}`;
        activeEntryIds.add(objectId);
        let entry = calendarEntriesById.get(objectId);
        if (!entry) {
          entry = { objectKind:"calendar-entry", objectId, revision:0 };
          calendarEntriesById.set(objectId, entry);
        }
        const signature = entrySignature(payload);
        if (entry.dataSignature !== signature) entry.revision += 1;
        Object.assign(entry, payload, { dataSignature:signature });
        return entry;
      });
      const signature = nextEntries.map((entry) => entry.dataSignature).join("|");
      if (dayData.dataSignature !== signature) {
        dayData.dataSignature = signature;
        dayObject.revision += 1;
      }
      dayData.entries.splice(0, dayData.entries.length, ...nextEntries);
    });
    [...calendarEntriesById.keys()].forEach((objectId) => {
      if (!activeEntryIds.has(objectId)) calendarEntriesById.delete(objectId);
    });
    yearObject.children.forEach((month) => {
      calendarData(month).dataSignature = month.children
        .map((day) => calendarData(day).dataSignature)
        .join("||");
      month.revision = month.children.reduce((sum, day) => sum + day.revision, 0);
    });
    yearObject.revision += 1;
    renderRevision += 1;
  };

  const ensureStyles = () => {
    if (document.getElementById("fractal-calendar-styles")) return;
    const style = document.createElement("style");
    style.id = "fractal-calendar-styles";
    style.textContent = `
      .fc-surface{position:fixed;inset:0;z-index:800;pointer-events:none;overflow:hidden}
      .fc-surface[hidden]{display:none}
      body[data-crm-module="calendar"] .app-window-drag-region{z-index:790}
      .fc-level{position:absolute;inset:0;transform-origin:0 0;will-change:transform;
        contain:layout style;backface-visibility:hidden}
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
        padding:calc(8px * var(--ky,1)) calc(10px * var(--kx,1)) calc(10px * var(--ky,1))}
      .fc-month.fc-month-layout{display:flex;align-items:stretch;text-align:left}
      .fc-month{cursor:pointer;border-radius:calc(var(--mon-r,16px) * var(--kx,1)) /
        calc(var(--mon-r,16px) * var(--ky,1));outline:none}
      /* At year level a month is the same canonical tile used by Home. Its face
         is one inert capture of this module's real entered month renderer. */
      .fc-month:focus-visible{outline:1px solid rgba(125,180,255,.54)}
      .fc-month>.fc-calendar-tile-preview{position:absolute;inset:0;z-index:1;overflow:hidden;
        contain:paint;border-radius:inherit;pointer-events:none;color:rgba(255,255,255,.62)}
      .fc-calendar-tile-preview{pointer-events:none}
      .fc-calendar-tile-preview>.fc-calendar-tile-preview-render{position:absolute;inset:0;display:block;
        width:100%;height:100%;object-fit:fill;pointer-events:none;user-select:none;
        transform:none;transform-origin:center;backface-visibility:hidden;
        filter:blur(.65px) saturate(.95) brightness(.88);transition:filter .18s ease}
      .crm-calendar-tile:is(:hover,:focus-visible)>
        .fc-calendar-tile-preview>.fc-calendar-tile-preview-render{
        filter:blur(0) saturate(.96) brightness(.9)}
      .fc-calendar-tile-preview>.crm-home-preview-state{position:absolute;inset:0;z-index:2;
        display:flex;align-items:center;justify-content:center;gap:9px;pointer-events:none;
        font:600 10px/1 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
        letter-spacing:.075em;text-transform:uppercase;color:rgba(225,234,246,.6)}
      .fc-calendar-tile-preview[data-preview-state="ready"]>.crm-home-preview-state{display:none}
      /* Once a month owns the viewport, park the fully covered year tiles.
         Bring them back before the month-to-year contraction begins so their
         live acrylic and populated faces remain present throughout the visible
         return animation. Geometry is retained because visibility does not
         remove the canonical tiles from layout. */
      .fc-surface[data-level="1"]:not(.fc-camera-contracting)>
        .fc-level[data-kind="year"] .fc-month,
      .fc-surface[data-level="2"]>.fc-level[data-kind="year"] .fc-month{
        visibility:hidden}
      .fc-hd,.fc-dowrow,.fc-day-stage{position:relative;z-index:1;width:100%;box-sizing:border-box}
      .fc-hd{flex:0 0 9%;display:flex;align-items:center;justify-content:space-between;gap:8px;
        padding:0 1%;font-size:clamp(.98rem,8cqh,1.15rem);font-weight:700;line-height:1.05;
        color:rgba(255,255,255,.85);white-space:nowrap;min-height:0}
      .fc-expander .fc-hd{font-size:clamp(1.15rem,3.2cqh,1.7rem)}
      .fc-expander[data-kind="day"] .fc-hd{font-size:clamp(1.05rem,2.8cqh,1.45rem)}
      .fc-dowrow{flex:0 0 5%;display:grid;grid-template-columns:repeat(7,1fr);column-gap:1.6%;
        align-items:center;min-height:0}
      .fc-dowrow span{text-align:center;font-size:var(--crm-type-caption,11px);font-weight:700;
        color:rgba(255,255,255,.4);white-space:nowrap;overflow:hidden}
      .fc-day-stage{flex:1 1 auto;min-height:0}
      .fc-days{position:absolute;inset:0;display:grid;grid-template-columns:repeat(7,1fr);
        grid-template-rows:repeat(6,1fr);column-gap:1.6%;row-gap:2%}
      .fc-days{z-index:1}
      .fc-days>.fc-day{position:relative;z-index:1;min-width:0;min-height:0;width:auto;height:auto;
        border-radius:calc(var(--day-r,3px) * var(--kx,1)) /
          calc(var(--day-r,3px) * var(--ky,1))}
      .fc-days>.fc-day::after{content:attr(data-day-label);position:absolute;z-index:2;top:6%;left:7%;
        font-size:var(--crm-type-body,12px);font-weight:700;color:rgba(255,255,255,.78);
        line-height:1;pointer-events:none}
      /* The collection may consolidate 31 backdrop samples into one clipped
         material plane, but the children remain the unmodified shared tile
         component. Material batching is a collection concern, never a second
         calendar-day surface. */
      .fc-calendar-tile-material{opacity:.999;
        background:transparent;
        -webkit-backdrop-filter:var(--bucket-acrylic-filter);
        backdrop-filter:var(--bucket-acrylic-filter)}
      .fc-transition-copy>.crm-tile-material-plane{display:none}
      .fc-day:hover,.fc-day:focus-visible,
      .fc-day.is-drop-target,
      .fc-day-detail.is-drop-target,.fc-empty.is-drop-target,
      .fc-surface[data-level="0"] .fc-month:is(:hover,:focus-visible) .fc-day{
        background:linear-gradient(180deg,rgba(40,55,76,.27),rgba(18,26,38,.23));
        box-shadow:inset 0 0 0 1px rgba(166,196,236,.27),
          inset 0 1px rgba(255,255,255,.15),
          0 14px 26px -16px rgba(0,0,0,.72)}
      .fc-day.fc-today{box-shadow:
        inset 0 0 0 1px rgba(255,255,255,.14),inset 0 1px 0 rgba(255,255,255,.18),
        inset 0 0 0 1px rgba(125,180,255,.55),0 0 16px rgba(90,150,255,.38)!important}
      .fc-scheduled-list{display:flex;flex-direction:column;gap:0;min-height:0;overflow:hidden}

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

      .fc-expander{position:absolute;z-index:5;pointer-events:auto;-webkit-app-region:no-drag;
        transform-origin:0 0;padding:0;contain:layout style;will-change:transform;
        backface-visibility:hidden;overflow:hidden}
      .fc-expander[data-kind="month"]{background:transparent;border:0;box-shadow:none;
        -webkit-backdrop-filter:none;backdrop-filter:none}
      .fc-expander[data-kind="day"].crm-home-bucket{
        border-radius:calc(var(--day-r,14px) * var(--kx,1)) /
          calc(var(--day-r,14px) * var(--ky,1))!important}
      .fc-transition-acrylic{
        position:absolute;inset:0;box-sizing:border-box;pointer-events:none}
      .fc-transition-acrylic{z-index:4;border-width:1px;border-radius:inherit;opacity:0}
      .fc-expander-live,.fc-transition-copy{position:absolute;inset:0;box-sizing:border-box;
        min-width:0;min-height:0;backface-visibility:hidden;will-change:opacity}
      .fc-expander-live{z-index:3;opacity:1;pointer-events:auto}
      .fc-expander-live.fc-month-layout{display:flex}
      .fc-expander[data-kind="day"]>.fc-expander-live{padding:calc(8px * var(--ky,1))
        calc(10px * var(--kx,1)) calc(10px * var(--ky,1))}
      .fc-transition-copy{z-index:2;opacity:0;pointer-events:none!important}
      .fc-transition-copy.fc-month-preview-transition{overflow:hidden}
      .fc-transition-copy.fc-month-preview-transition>.fc-calendar-tile-preview{
        position:absolute;inset:0;overflow:hidden;border-radius:inherit}
      .fc-transition-copy.fc-month-preview-transition .fc-calendar-tile-preview-render{
        position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:fill;
        filter:none;transform:none}
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

  const scheduledFor = (dayObject) => calendarData(dayObject).entries || [];
  const visibleScheduledFor = (dayObject, limit) => {
    const all = scheduledFor(dayObject);
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
  const scheduledHTML = (dayObject, limit = 4) => {
    const { all, items } = visibleScheduledFor(dayObject, limit);
    if (!items.length) return "";
    const extra = all.length - items.length;
    return `<div class="fc-scheduled-list">${items.map((item) => (
      `<div class="fc-chip" data-type="${esc(item.type)}" data-id="${esc(item.id)}"${
        item.hot ? ' data-hot="true"' : ""
      }${item.projectTitle ? ` title="${esc(item.projectTitle)}"` : ""}>` +
      `<span class="fc-chip-title">${esc(item.title)}</span>${progressMapHTML(item)}</div>`
    )).join("")}${extra > 0 ? `<div class="fc-chip-more">+${extra} more</div>` : ""}</div>`;
  };

  const calendarTileUnit = (object) => String(
    calendarData(object).unit || tileKindOf(object).replace(/^calendar-/, ""),
  );
  const calendarTilePreviewIsCurrent = (preview, object) => {
    const unit = calendarTileUnit(object);
    const common = !!preview?.foregroundSrc
      && preview.kind === `calendar-${unit}`
      && preview.key === object?.tile?.id
      && preview.version === TILE_PREVIEW_VERSION
      && Number(preview.revision) === Number(object.revision)
      && String(preview.dataSignature || "") === String(calendarData(object).dataSignature || "")
      && preview.provenance?.renderer === `calendar-${unit}-full`;
    if (!common) return false;
    return preview.provenance?.tileId === object.tile.id
      && preview.provenance?.tileObjectCanonical === true
      && preview.provenance?.shellSharesSourceObject === true
      && preview.provenance?.fullRendererSharesObject === true
      && Number(preview.provenance?.canonicalChildCount) === object.children.length
      && Number(preview.provenance?.sharedChildCount) === object.children.length
      && Number(preview.provenance?.syntheticChildCount) === 0;
  };
  const tilePreviewStateHTML = (object) => (
    `<div class="crm-home-preview-state" role="status" aria-live="polite">` +
    `<i class="crm-home-preview-state-mark" aria-hidden="true"></i>` +
    `<span>Preparing ${esc(object.tile.title)}</span></div>`
  );
  const updateCalendarTileInstance = (element, object, {
    interactive = false,
  } = {}) => {
    const unit = calendarTileUnit(object);
    const data = calendarData(object);
    bindCalendarObjectView(element, object, "preview", {
      bindSchema:true,
      ariaLabel:`Open ${object.tile.label}`,
    });
    element.dataset.kind = unit;
    element.dataset.calendarTile = unit;
    element.dataset.calendarTileInstance = "true";
    element.dataset.calendarObjectRevision = String(object.revision);
    element.tabIndex = interactive ? 0 : -1;
    if (unit === "month") {
      element.dataset.month = String(data.month);
    } else {
      element.dataset.date = data.date;
      element.dataset.dayLabel = String(data.day);
      element.classList.toggle("fc-today", data.date === todayIso());
    }
    mountCalendarTilePreview(element, object);
    return element;
  };
  const calendarTileElementOptions = (object, interactive = false) => {
    const unit = calendarTileUnit(object);
    const preview = tilePreviews.get(object.tile.id) || object.preview || null;
    const previewIsCurrent = calendarTilePreviewIsCurrent(preview, object);
    return {
      className:`crm-calendar-tile fc-${unit}`,
      ariaLabel:`Open ${object.tile.label}`,
      tabIndex:interactive ? 0 : -1,
      view:"preview",
      previewClassName:"fc-calendar-tile-preview",
      previewKey:object.tile.id,
      previewState:previewIsCurrent ? "ready" : "waiting",
      previewHTML:previewIsCurrent ? "" : tilePreviewStateHTML(object),
    };
  };
  const createMonthViewStructure = (host, monthObject, {
    material,
  }) => {
    const existingMaterial = material
      ? host.querySelector?.(":scope > .crm-tile-material-plane")
      : null;
    const header = document.createElement("div");
    header.className = "fc-hd";
    header.innerHTML = `<span>${MONTHS[calendarData(monthObject).monthIndex]}</span>`;
    const weekdays = document.createElement("div");
    weekdays.className = "fc-dowrow";
    weekdays.innerHTML = DOW.map((day) => `<span>${day}</span>`).join("");
    const stage = document.createElement("div");
    stage.className = "fc-day-stage";
    const days = document.createElement("div");
    days.className = "fc-days";
    stage.appendChild(days);
    host.replaceChildren(header, weekdays, stage);
    if (existingMaterial) host.prepend(existingMaterial);
  };
  const mountCalendarMonthView = (host, monthObject, {
    interactiveDays = false,
    material = false,
    materialClass = "",
  } = {}) => {
    const data = calendarData(monthObject);
    bindCalendarObjectView(host, monthObject, "full");
    host.dataset.month = String(data.month);
    host.dataset.kind = "month";
    host.dataset.tileRenderer = "calendar-month-full";
    host.dataset.calendarObjectRevision = String(monthObject.revision);
    let days = host.querySelector(":scope > .fc-day-stage > .fc-days");
    if (!days) {
      createMonthViewStructure(host, monthObject, {
        material,
      });
      days = host.querySelector(":scope > .fc-day-stage > .fc-days");
    }
    host.querySelector(":scope > .fc-hd > span").textContent = MONTHS[data.monthIndex];
    const dayViews = mountTileChildren(days, monthObject, {
      elementOptions:(object) => calendarTileElementOptions(object, interactiveDays),
      update:(element, object) => updateCalendarTileInstance(element, object, {
        interactive:interactiveDays,
      }),
    });
    const leading = firstDowInYearMonth(data.year, data.monthIndex);
    dayViews.forEach((element, index) => {
      element.style.gridColumnStart = index === 0 ? String(leading + 1) : "";
    });
    if (material) {
      ensureTileMaterialPlane(host, {
        className:`fc-calendar-tile-material ${materialClass}`,
        tileSelector:":scope > .fc-day-stage > .fc-days > .fc-day",
      });
      days.dataset.crmTileSharedMaterial = "true";
    }
    return host;
  };
  const dayInnerHTML = (dayObject) => {
    const data = calendarData(dayObject);
    const parsed = new Date(data.year, data.monthIndex, data.day);
    const items = scheduledHTML(dayObject, 40);
    return `<div class="fc-hd"><span>${DOW_FULL[parsed.getDay()]}, ${MONTHS[data.monthIndex]} ${data.day}</span></div>` +
      `<div class="fc-day-detail" data-date="${data.date}">${
        items || `<div class="fc-empty" data-date="${data.date}">No scheduled records yet</div>`
      }<div class="fc-drop-hint">Drop grid cards here to schedule them</div></div>`;
  };
  const mountCalendarDayViewport = (host, dayObject) => {
    const data = calendarData(dayObject);
    bindCalendarObjectView(host, dayObject, "full");
    host.dataset.kind = "day";
    host.dataset.date = data.date;
    host.dataset.tileRenderer = "calendar-day-full";
    host.dataset.calendarObjectRevision = String(dayObject.revision);
    host.innerHTML = dayInnerHTML(dayObject);
    return host;
  };

  const mountCalendarTilePreview = (tile, object) => {
    if (!tile || !object) return false;
    const host = tilePreviewHostFor(tile);
    if (!host) return false;
    const preview = tilePreviews.get(object.tile.id) || object.preview || null;
    const current = calendarTilePreviewIsCurrent(preview, object);
    host.dataset.previewKey = object.tile.id;
    host.dataset.previewState = current ? "ready" : (preview ? "updating" : "waiting");
    if (!current) {
      tile.removeAttribute("data-preview-ready");
      return false;
    }
    object.preview = preview;
    let image = host.querySelector(":scope > .fc-calendar-tile-preview-render");
    if (!image) {
      image = document.createElement("img");
      image.className = "crm-home-preview-image crm-home-preview-foreground " +
        "fc-calendar-tile-preview-render";
      image.alt = "";
      image.draggable = false;
      image.decoding = "async";
      host.appendChild(image);
    }
    if (image.src !== preview.foregroundSrc) image.src = preview.foregroundSrc;
    host.dataset.previewVersion = preview.version;
    host.dataset.previewRevision = String(preview.revision);
    host.dataset.previewDataSignature = String(preview.dataSignature || "");
    host.dataset.previewRenderer = preview.provenance.renderer;
    host.dataset.previewCanonicalChildren = String(
      preview.provenance.canonicalChildCount ?? object.children.length,
    );
    host.dataset.capturedAt = String(preview.capturedAt || 0);
    tile.dataset.previewReady = "true";
    return true;
  };
  const acceptTilePreview = (preview) => {
    if (!preview?.key) return false;
    calendarObject();
    const object = tileTreeIndex.objectForId(preview.key);
    if (!object || preview.kind !== tileKindOf(object)) return false;
    tilePreviews.set(String(preview.key), preview);
    object.preview = preview;
    camera?.surface?.().querySelectorAll?.(
      `.crm-calendar-tile[data-tile-id="${CSS.escape(String(preview.key))}"]`,
    ).forEach((tile) => mountCalendarTilePreview(tile, object));
    return true;
  };
  const activeMonthObject = () => {
    const layer = camera?.layers?.()[1];
    return layer?.dataset?.kind === "month" ? calendarObjectForElement(layer) : null;
  };
  const tilePreviewKindFor = (parent) => {
    const kind = tileKindOf(parent?.children?.[0]);
    return ["calendar-month", "calendar-day"].includes(kind) ? kind : "";
  };
  const tilePreviewScopeFor = (parent) => {
    const data = calendarData(parent);
    return {
      year:data.year,
      ...(data.unit === "month" ? { month:data.month } : {}),
    };
  };
  const tilePreviewScopeKeyFor = (parent) => {
    const kind = tilePreviewKindFor(parent);
    const scope = tilePreviewScopeFor(parent);
    return kind ? `${kind}:${scope.year}:${scope.month || 0}` : "";
  };
  const tilePathFor = (object) => {
    calendarObject();
    return tileTreeIndex.pathTo(object);
  };
  const tilePreviewRequestFor = (object) => {
    const data = calendarData(object);
    return {
      key:object.tile.id,
      kind:tileKindOf(object),
      path:tilePathFor(object),
      viewState:{
        year:data.year,
        month:data.month,
        day:data.day,
        date:data.date,
      },
      captureMode:data.unit === "day" ? "tile-foreground" : "viewport",
      settleMs:data.unit === "day" ? 0 : 20,
      revision:object.revision,
      dataSignature:data.dataSignature,
    };
  };
  const staleTilePreviewRequests = (parent) => {
    if (!tilePreviewKindFor(parent)) return [];
    return parent.children
      .filter((object) => !calendarTilePreviewIsCurrent(
        tilePreviews.get(object.tile.id) || object.preview,
        object,
      ))
      .filter((object) => !tilePreviewRequests.has(object.tile.id))
      .map(tilePreviewRequestFor);
  };
  const collectionIsVisible = (parent) => (
    parent === calendarObject() || activeMonthObject() === parent
  );
  const scheduleTilePreviewCapture = (parent, delay = 80) => {
    const scopeKey = tilePreviewScopeKeyFor(parent);
    if (!scopeKey) return;
    clearTimeout(tilePreviewTimers.get(scopeKey));
    tilePreviewTimers.set(scopeKey, setTimeout(() => {
      tilePreviewTimers.delete(scopeKey);
      void captureTilePreviews(parent);
    }, delay));
  };
  const captureTilePreviews = async (parent) => {
    const kind = tilePreviewKindFor(parent);
    if (window.crmHomePreviews?.isCaptureWorker
      || !window.crmTilePreviews?.capture
      || !kind
      || scheduledDataReadyYear !== currentYear) return [];
    const requests = staleTilePreviewRequests(parent);
    if (!requests.length) return [];
    requests.forEach((request) => tilePreviewRequests.add(request.key));
    try {
      const result = await window.crmTilePreviews.capture(
        kind,
        tilePreviewScopeFor(parent),
        requests,
      );
      if (result?.ok === false) tilePreviewLastError = String(result.error || "Capture failed");
      else tilePreviewLastError = "";
      (result?.previews || []).forEach(acceptTilePreview);
      return result?.previews || [];
    } catch (error) {
      tilePreviewLastError = String(error?.message || error || "Capture failed");
      return [];
    } finally {
      requests.forEach((request) => tilePreviewRequests.delete(request.key));
      if (camera?.isActive?.() && collectionIsVisible(parent)
        && staleTilePreviewRequests(parent).length) {
        scheduleTilePreviewCapture(parent, 180);
      }
    }
  };
  const requestTilePreviews = async (parent, {
    capture = true,
  } = {}) => {
    const kind = tilePreviewKindFor(parent);
    const scopeKey = tilePreviewScopeKeyFor(parent);
    const scope = tilePreviewScopeFor(parent);
    if (window.crmHomePreviews?.isCaptureWorker || !window.crmTilePreviews || !kind) {
      return [];
    }
    if (!tilePreviewListedScopes.has(scopeKey)) {
      tilePreviewListedScopes.add(scopeKey);
      try {
        const result = await window.crmTilePreviews.list(kind, scope);
        (result?.previews || []).forEach(acceptTilePreview);
      } catch {}
    }
    if (!capture || !camera?.isActive?.() || scheduledDataReadyYear !== currentYear) return [];
    scheduleTilePreviewCapture(parent);
    return [];
  };
  const subscribeTilePreviews = () => {
    if (tilePreviewSubscription || !window.crmTilePreviews?.onChanged) return;
    try { tilePreviewSubscription = window.crmTilePreviews.onChanged(acceptTilePreview); } catch {}
  };
  const waitForTileChildren = async (parent, timeoutMs = 90000) => {
    const kind = tilePreviewKindFor(parent);
    if (!window.crmTilePreviews || !kind) {
      return {
        supported:!!window.crmTilePreviews,
        ready:0,
        total:parent?.children?.length || 0,
      };
    }
    await requestTilePreviews(parent);
    const started = performance.now();
    let ready = 0;
    let diagnostics = null;
    while (performance.now() - started < timeoutMs) {
      ready = parent.children.filter((object) => calendarTilePreviewIsCurrent(
        tilePreviews.get(object.tile.id) || object.preview,
        object,
      )).length;
      const pending = parent.children.filter(
        (object) => tilePreviewRequests.has(object.tile.id),
      ).length;
      if (ready === parent.children.length && !pending) {
        return {
          supported:true,
          ready,
          total:parent.children.length,
          durationMs:performance.now() - started,
        };
      }
      diagnostics = await window.crmTilePreviews.diagnostics?.().catch?.(() => null);
      if (diagnostics?.status?.error) tilePreviewLastError = diagnostics.status.error;
      if (diagnostics?.status?.active === false && diagnostics?.status?.error) {
        return {
          supported:true,
          ready,
          total:parent.children.length,
          pending,
          durationMs:performance.now() - started,
          error:diagnostics.status.error,
          diagnostics,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
      supported:true,
      ready,
      total:parent.children.length,
      pending:parent.children.filter(
        (object) => tilePreviewRequests.has(object.tile.id),
      ).length,
      durationMs:performance.now() - started,
      error:tilePreviewLastError || "Calendar tile previews did not settle",
      diagnostics,
      states:parent.children.map((object) => ({
        key:object.tile.id,
        revision:object.revision,
        previewRevision:tilePreviews.get(object.tile.id)?.revision ?? null,
      })),
    };
  };
  const buildYear = () => {
    const yearObject = calendarObject();
    const root = document.createElement("div");
    root.className = "fc-level";
    root.dataset.kind = "year";
    bindCalendarObjectView(root, yearObject, "year");
    const grid = document.createElement("div");
    grid.className = "fc-grid";
    mountTileChildren(grid, yearObject, {
      elementOptions:(object) => calendarTileElementOptions(object, true),
      update:(element, object) => updateCalendarTileInstance(element, object, {
        interactive:true,
      }),
    });
    root.appendChild(grid);
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
    const animation = backdropCoverMotion?.animation;
    if (animation && animation.playState !== "finished" && animation.playState !== "idle") {
      animation.cancel?.();
    }
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
    // A finished full-viewport opacity effect is cheap to retain but expensive
    // to cancel on the first settled frame. Leave it filled; a later cover
    // animation replaces it, or hideBackdropCover disposes it only after the
    // cover is no longer paint-visible.
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
      requestAnimationFrame(() => {
        if (!motion.cover.hidden) return;
        motion.cover.getAnimations?.().forEach?.((animation) => animation.cancel());
      });
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
    requestAnimationFrame(() => {
      if (!backdropCover?.hidden) return;
      backdropCover.getAnimations?.().forEach?.((animation) => animation.cancel());
    });
  };
  const radiusFor = (width, height) => clampN(RADIUS_F * Math.min(width, height), 2, 64);
  const syncCalendarMaterial = (host) => {
    if (!host) return null;
    const direct = host.querySelector?.(":scope > .crm-tile-material-plane");
    if (direct) return syncTileMaterialPlane(direct);
    return null;
  };
  const layoutCalendar = ({ surface, layers, expRect }) => {
    const root = layers[0];
    const grid = root?.querySelector?.(":scope > .fc-grid");
    if (!surface || !root || !grid) return;
    ensureYearChrome(surface);
    layoutGrid(grid, expRect);
    const firstMonth = grid.firstElementChild;
    const firstDay = layers[1]?.querySelector?.(
      ":scope > .fc-expander-live .fc-day",
    ) || null;
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
    calendarObjectForElement(target)?.tile?.id
      || (target?.dataset?.month
        ? `month:${target.dataset.month}`
        : `day:${target?.dataset?.date || ""}`)
  );
  const createTransitionCopy = (expander, target, isMonth) => {
    const copy = expander.querySelector(":scope > .fc-transition-copy");
    if (!copy) return;
    copy.className = `fc-transition-copy${isMonth ? " fc-month-preview-transition" : ""}`;
    copy.dataset.kind = isMonth ? "month" : "day";
    const sourceObject = calendarObjectForElement(target);
    if (sourceObject) bindCalendarObjectView(copy, sourceObject, "transition-copy");
    if (isMonth) {
      // The transition face is the decoded capture already mounted in the real
      // month tile. No alternate Calendar miniature is constructed here.
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
    bindClonedCalendarViews(copy);
  };
  const renderExpander = (expander, target) => {
    const object = calendarObjectForElement(target) || calendarObjectForElement(expander);
    if (!object) return;
    const isMonth = tileKindOf(object) === "calendar-month";
    bindCalendarObjectView(expander, object, "expanded-shell", {
      bindSchema:true,
      canonicalClass:false,
      ariaLabel:`Open ${object.tile.label}`,
    });
    createTransitionCopy(expander, target, isMonth);
    const live = expander.querySelector(":scope > .fc-expander-live");
    if (isMonth) {
      mountCalendarMonthView(live, object, {
        view:"full",
        interactiveDays:true,
        material:true,
      });
    } else {
      mountCalendarDayViewport(live, object);
    }
    expander.dataset.renderRevision = String(renderRevision);
    if (expander.isConnected && isMonth) syncCalendarMaterial(live);
  };
  const buildExpander = (target, context) => {
    const object = calendarObjectForElement(target);
    const data = calendarData(object);
    const isMonth = tileKindOf(object) === "calendar-month" || context.level === 0;
    const elementOptions = {
      tagName:"div",
      className:isMonth ? "" : "fc-day-expander",
      canonicalClass:!isMonth,
      ariaLabel:`Open ${object?.tile?.label || target.getAttribute("aria-label") || ""}`,
      view:"expanded-shell",
    };
    const expander = isMonth
      ? createTileObjectElement(object, elementOptions)
      : createTileInstance(object, { ...elementOptions, preview:false });
    expander.classList.add("fc-bucket", "fc-expander");
    expander.dataset.kind = isMonth ? "month" : "day";
    if (isMonth) expander.dataset.month = String(data.month || target.dataset.month);
    else expander.dataset.date = data.date || target.dataset.date;
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

  const materialTilesForTarget = (target) => (
    target?.matches?.('.crm-calendar-tile[data-crm-tile-instance="viewport"]')
      ? [target]
      : []
  );
  const lensForTarget = (target) => (
    calendarTileUnit(calendarObjectForElement(target)) === "month"
      ? monthAcrylicLens
      : dayAcrylicLens
  );
  const sourceMaterialTarget = (_expander, target) => {
    const unit = calendarTileUnit(calendarObjectForElement(target));
    if (unit === "month") return target;
    if (unit !== "day") return target;
    return target.closest(".fc-expander-live,.fc-month")
      ?.querySelector?.(":scope > .crm-tile-material-plane")
      || target;
  };
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
    const sourceRadius = calendarTileUnit(calendarObjectForElement(target)) === "day"
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
    const object = calendarObjectForElement(target);
    const data = calendarData(object);
    const kind = tileKindOf(object) === "calendar-month" ? "month" : "day";
    const nextMonth = String(data.month || target.dataset.month || "");
    const nextDate = data.date || target.dataset.date || "";
    const targetChanged = expander.dataset.kind !== kind
      || expander.dataset.tileObjectId !== object?.tile?.id
      || (kind === "month" && expander.dataset.month !== nextMonth)
      || (kind === "day" && expander.dataset.date !== nextDate);
    if (object) {
      bindCalendarObjectView(expander, object, "expanded-shell", {
        bindSchema:true,
        canonicalClass:false,
        ariaLabel:`Open ${object.tile.label}`,
      });
    }
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
    lens?.prepare?.(expander, target, context);
  };

  const targetFromEvent = (event, context) => {
    if (event.target?.closest?.(".fc-year-btn,.fc-year-face")) return null;
    const target = event.target?.closest?.(
      '.crm-calendar-tile[data-crm-tile-instance="viewport"]',
    );
    const layer = context.layers?.[context.level];
    return target && layer?.contains(target) ? target : null;
  };
  const targetFromPoint = (x, y, context) => {
    if (context.level >= 2) return null;
    const target = document.elementFromPoint(x, y)?.closest?.(
      '.crm-calendar-tile[data-crm-tile-instance="viewport"]',
    );
    return target && context.layers?.[context.level]?.contains(target) ? target : null;
  };
  const sourceSelector = (target) => (
    `.crm-calendar-tile[data-tile-id="${CSS.escape(target.dataset.tileId || "")}"]`
  );
  // Month shells share one compositor shape, as do day shells. The real tile
  // records are rebound in configureExpander; only the warmed backdrop shell
  // is reused between selections.
  const keyOf = (target) => (
    `calendar-${calendarTileUnit(calendarObjectForElement(target))}-shell`
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
      kind:calendarTileUnit(calendarObjectForElement(target)),
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
  const endpointMaterial = (context) => {
    const layer = context.layers?.[context.level];
    return layer?.dataset?.kind === "day"
      ? layer
      : null;
  };
  const settleTransitionMaterial = (direction, context) => {
    const transition = activeTransition;
    const lens = transition?.lens;
    if (!transition || !lens) return;
    const destination = endpointMaterial(context);
    let destinationAnimation = null;
    if (destination?.isConnected && direction === "expand") {
      clearMaterialExclusion(destination);
      destination.style.opacity = "1";
    } else if (destination?.isConnected) {
      clearMaterialExclusion(destination);
    }
    const token = {
      destination,
      destinationAnimation,
      endpointOpacity:direction === "expand" ? 1 : null,
    };
    materialHandoffs.set(lens, token);
    const release = lens.release?.();
    Promise.allSettled([
      release,
      destinationAnimation?.finished,
    ].filter(Boolean)).then(() => finishMaterialHandoff(lens, token));
  };
  const resetTransitionMaterials = () => {
    const surface = camera?.surface?.();
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
    const nextYear = Math.max(1901, Math.min(2200, Number(year) || currentYear));
    const changed = nextYear !== currentYear;
    currentYear = nextYear;
    localStorage.setItem(YEAR_STORE, String(currentYear));
    if (changed) resetCalendarObject();
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
      resetCalendarObject();
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
    const yearObject = calendarObject();
    const loadingYear = calendarData(yearObject).year;
    const next = new Map();
    let projects = [];
    let workItems = [];
    const add = (type, label, record) => {
      if (!record || record.deletedAt) return;
      const date = scheduledDateOf(record);
      if (!date || !String(date).startsWith(`${loadingYear}-`)) return;
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
        sourceRecord:record,
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
        .forEach((record) => add("commitment", record.kind || "Commitment", record));
    } catch {}
    if (calendarYearObject !== yearObject || currentYear !== loadingYear) return;
    reconcileCalendarData(yearObject, next);
    scheduledDataReadyYear = loadingYear;
    if (refresh && camera) refreshLevels();
    else if (camera?.isActive?.()) void requestTilePreviews(calendarObject());
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
        const monthObject = calendarObjectForElement(month);
        if (!monthObject) return;
        updateCalendarTileInstance(month, monthObject, { interactive:true });
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
    if (camera.isActive?.()) void requestTilePreviews(calendarObject());
    if (camera.isActive?.() && camera.level?.() >= 1) {
      void requestTilePreviews(activeMonthObject());
    }
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
        if (level === 1) {
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
    calendarObject();
    const dayObject = calendarDaysByDate.get(date);
    return dayObject ? layers[0]?.querySelector?.(
      `:scope > .fc-grid .fc-month[data-month="${calendarData(dayObject).monthIndex + 1}"]`,
    ) || null : null;
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
      const target = event.target?.closest?.(
        '.crm-calendar-tile[data-crm-tile-instance="viewport"]',
      );
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
    hideWhenParked:true,
    retainOwnerWhenParked:true,
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
    primeExpander:(_expander, target, context) => {
      monthAcrylicLens?.prime?.();
      dayAcrylicLens?.prime?.();
    },
    prepareTransition:(direction, target) => {
      if (direction === "expand" && target) camera?.prefetch?.(target);
    },
    prepareTarget:markCameraTarget,
    shouldPrefetch:(_target, context) => context.level < 2,
    targetFromEvent,
    targetAtPoint:targetFromPoint,
    sourceSelector,
    keyOf,
    onTransitionStart:(direction, context) => {
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
      if (context.level === 1) void requestTilePreviews(activeMonthObject());
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
      if (context.level === 1) void requestTilePreviews(activeMonthObject());
    },
    onActiveChange:(active, context) => {
      const yearChrome = ensureYearChrome(context.surface);
      if (yearChrome) yearChrome.hidden = !active;
      clearTimeout(backdropCoverPrewarmTimer);
      backdropCoverPrewarmTimer = 0;
      backdropCoverSourceObserver?.disconnect?.();
      backdropCoverSourceObserver = null;
      if (!active) {
        tilePreviewTimers.forEach((timer) => clearTimeout(timer));
        tilePreviewTimers.clear();
        tilePreviewRequests.clear();
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
        void requestTilePreviews(calendarObject());
        if (context.level === 1) void requestTilePreviews(activeMonthObject());
      }
    },
    onRootBack:() => window.crmDeskTransit?.driveTo?.("home"),
    onReady:() => {
      ensureYearChrome();
      wireCalendarControls();
      wireDrops();
      wireDayOpens();
      subscribeScheduled();
      subscribeTilePreviews();
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
      resetCalendarObject();
      camera.rebuildRoot();
      await loadScheduled({ refresh:true });
    }
    await camera.restoreHistoryState?.(state.camera || {});
    return homePreviewState();
  };
  const prepareTilePreview = async (request = {}) => {
    const tileId = String(
      typeof request === "string" ? request : request?.key || "",
    );
    const viewState = typeof request === "object" ? request.viewState || {} : {};
    if (!tileId) return false;
    const nextYear = Math.max(
      1901,
      Math.min(2200, Number(viewState.year) || currentYear),
    );
    if (nextYear !== currentYear) {
      currentYear = nextYear;
      localStorage.setItem(YEAR_STORE, String(currentYear));
      resetCalendarObject();
    }
    if (scheduledDataReadyYear !== currentYear) await loadScheduled({ refresh:false });
    resetTransitionMaterials();
    camera.rebuildRoot();
    const graph = calendarObject();
    const object = tileTreeIndex.objectForId(tileId);
    if (!object || object === graph) return false;
    const path = tilePathFor(object)
      .map((id) => tileTreeIndex.objectForId(id))
      .filter(Boolean);
    for (const pathObject of path) {
      const layer = camera.layers()[camera.level()];
      const target = layer?.querySelector?.(
        `.crm-calendar-tile[data-tile-id="${CSS.escape(pathObject.tile.id)}"]`,
      );
      if (!target || !camera.jumpTo(target)) return false;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    return camera.level() === path.length;
  };
  const previewCaptureRect = () => {
    const rectangle = camera.expRect();
    return {
      x:rectangle.x,
      y:rectangle.y,
      width:rectangle.w,
      height:rectangle.h,
    };
  };
  const tilePreviewCaptureState = (key) => {
    calendarObject();
    const object = tileTreeIndex.objectForId(key);
    const path = object ? tilePathFor(object) : [];
    const level = path.length;
    const sourceLayer = camera.layers()[level - 1] || null;
    const activeLayer = camera.layers()[level] || null;
    const source = sourceLayer?.querySelector?.(
      `.crm-calendar-tile[data-tile-id="${CSS.escape(object?.tile?.id || "")}"]`,
    ) || null;
    const live = activeLayer?.querySelector?.(":scope > .fc-expander-live") || null;
    const collection = live?.querySelector?.("[data-crm-tile-collection]") || null;
    const children = [...(collection?.querySelectorAll?.(
      ':scope > [data-crm-tile-instance="viewport"]',
    ) || [])];
    const data = calendarData(object);
    const provenance = {
      renderer:live?.dataset?.tileRenderer || "",
      tileId:object?.tile?.id || "",
      tileKind:tileKindOf(object),
      tileObjectCanonical:isTileObject(object),
      shellSharesSourceObject:calendarObjectForElement(source)
        === calendarObjectForElement(activeLayer),
      fullRendererSharesObject:calendarObjectForElement(live) === object,
      sourceView:source?.dataset?.tileObjectView || "",
      canonicalChildCount:children.filter(
        (child) => isTileObject(calendarObjectForElement(child)),
      ).length,
      sharedChildCount:children.filter(
        (child, index) => calendarObjectForElement(child) === object?.children?.[index],
      ).length,
      directChildCount:children.length,
      syntheticChildCount:collection?.querySelectorAll?.(
        ':scope > :not([data-crm-tile-instance="viewport"])',
      ).length || 0,
      path,
      revision:Number(object?.revision) || 0,
      dataSignature:String(data.dataSignature || ""),
    };
    return { region:previewCaptureRect(), provenance };
  };
  const tilePreviewStatusFor = (parent) => (parent?.children || []).map((object) => {
    const data = calendarData(object);
    const preview = tilePreviews.get(object.tile.id) || object.preview || null;
    return {
      key:object.tile.id,
      unit:calendarTileUnit(object),
      month:data.month,
      date:data.date,
      state:tilePreviewRequests.has(object.tile.id)
        ? "updating"
        : (calendarTilePreviewIsCurrent(preview, object)
          ? "ready"
          : (preview ? "stale" : "waiting")),
      revision:object.revision,
      capturedAt:preview?.capturedAt || 0,
      renderer:preview?.provenance?.renderer || "",
      error:tilePreviewLastError,
    };
  });
  const tilePreviewParentFor = (parentTileId) => (
    parentTileId
      ? (calendarObject(), tileTreeIndex.objectForId(parentTileId))
      : calendarObject()
  );

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
    _objectForElement:calendarObjectForElement,
    _objectGraph:() => calendarObject(),
    _objectIndex:() => (calendarObject(), tileTreeIndex),
    prepareTilePreview,
    tilePreviewCaptureState,
    previewCaptureRect,
    waitForTilePreviews:(parentTileId, timeoutMs) => waitForTileChildren(
      tilePreviewParentFor(parentTileId),
      timeoutMs,
    ),
    tilePreviewStatus:(parentTileId) => tilePreviewStatusFor(
      tilePreviewParentFor(parentTileId),
    ),
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
      const monthObject = calendarObjectForElement(mini);
      const preview = tilePreviews.get(monthObject?.tile?.id) || monthObject?.preview;
      if (!calendarTilePreviewIsCurrent(preview, monthObject)) {
        return { ready:false, source:"canonical-month-capture", sharedObjects:0 };
      }
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
      const expanderCells = [...expander.querySelectorAll(":scope > .fc-expander-live .fc-day")];
      return {
        ready:true,
        source:"canonical-month-capture",
        worst:0,
        day1:null,
        day31:null,
        sharedObjects:expanderCells.filter(
          (cell, index) => calendarObjectForElement(cell) === monthObject.children[index],
        ).length,
      };
    },
    _parityClear:() => camera.surface()?.querySelectorAll(".fc-parity").forEach((element) => {
      element.remove();
    }),
  };
})();
