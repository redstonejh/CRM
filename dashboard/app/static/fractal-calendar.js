// fractal-calendar.js - calendar content hosted by the shared fractal camera.
(() => {
  if (typeof window.createFractalCamera !== "function") {
    console.error("[CRM] fractal camera factory is not loaded");
    return;
  }

  const YEAR_STORE = "crm-calendar-year";
  const EASE = "cubic-bezier(.22, 1, .26, 1)";
  const MORPH_MS = 460;
  const EXP_M = 16;
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
    return match ? match[1] : "";
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
      .fc-year-btn { appearance: none; border: 0; border-radius: 999px; width: 26px; height: 24px;
        display: inline-grid; place-items: center; background: transparent; color: rgba(255,255,255,0.62);
        font: inherit; font-size: 16px; font-weight: 800; cursor: pointer; }
      .fc-year-btn:hover { color: #fff; background: rgba(255,255,255,0.08); }
      .fc-year-label { min-width: 4.5ch; text-align: center; font-size: 12px; font-weight: 800; letter-spacing: .02em; }
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
      .fc-expander .fc-hd { font-size: clamp(1.15rem, 3.2cqh, 1.7rem); }
      .fc-expander[data-kind="day"] .fc-hd { font-size: clamp(1.05rem, 2.8cqh, 1.45rem); }
      .fc-dowrow { flex: 0 0 5%; display: grid; grid-template-columns: repeat(7, 1fr); column-gap: 1.6%;
        align-items: center; min-height: 0; }
      .fc-dowrow span { text-align: center; font-size: 0.72rem; font-weight: 700; color: rgba(255,255,255,0.4);
        white-space: nowrap; overflow: hidden; }
      .fc-days { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: repeat(7, 1fr);
        grid-template-rows: repeat(6, 1fr); column-gap: 1.6%; row-gap: 2%; }
      .fc-day-spacer { min-height: 0; visibility: hidden; pointer-events: none; }
      .fc-day { position: relative; min-height: 0; overflow: hidden; border: 0;
        border-radius: calc(var(--day-r, 3px) * var(--kx, 1)) / calc(var(--day-r, 3px) * var(--ky, 1));
        background: linear-gradient(180deg, rgba(255,255,255,0.075), rgba(255,255,255,0.035));
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10), inset 0 1px 0 rgba(255,255,255,0.08);
        transition: box-shadow .18s ease, background .18s ease; }
      .fc-day-num { position: absolute; top: 6%; left: 7%; font-size: 0.85rem; font-weight: 700;
        color: rgba(255,255,255,0.78); line-height: 1; }
      .fc-day-body { position: absolute; inset: 24% 5% 5%; display: flex; flex-direction: column; gap: 3px; min-height: 0; }
      .fc-scheduled-list { display: flex; flex-direction: column; gap: 0; min-height: 0; overflow: hidden; }
      /* BLUEPRINT A4: day cells hold TITLE-PEEK bands — the card anatomy at
         k-scale (glass body, left edge accent), stacked flush like a peeking
         pile, never colored pills. Red stays money-only (data-hot). */
      .fc-chip { position: relative; border-radius: 3px; margin-top: -1px; padding: 2px 6px 2px 9px;
        font-size: 0.64rem; line-height: 1.2; color: rgba(255,255,255,0.88);
        background: linear-gradient(180deg, rgba(83,95,117,0.6), rgba(33,41,56,0.55));
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.09), inset 0 1px 0 rgba(255,255,255,0.10), 0 2px 6px rgba(0,0,0,0.22);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .fc-chip:first-child { margin-top: 0; }
      .fc-chip::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
        background: rgba(148,163,184,0.35); }
      .fc-chip[data-type="deal"]::before { background: rgba(249,115,22,0.85); }
      .fc-chip[data-type="task"]::before { background: rgba(111,201,154,0.85); }
      .fc-chip[data-type="ticket"]::before { background: rgba(125,180,255,0.85); }
      .fc-chip[data-type="invoice"]::before { background: rgba(56,189,248,0.85); }
      .fc-chip[data-type="contact"]::before, .fc-chip[data-type="calendar"]::before { background: rgba(148,163,184,0.35); }
      .fc-chip[data-hot="true"]::before { background: rgba(220,38,38,0.95); }   /* overdue invoice — the only red */
      .fc-chip-more { font-size: 0.6rem; padding: 1px 6px; color: rgba(255,255,255,0.5); }
      /* Inside the day dive the same bands read near-card-size and open on click. */
      .fc-day-detail .fc-chip { font-size: 0.82rem; padding: 9px 12px 9px 14px; border-radius: 6px;
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
        border-radius: 12px; padding: 10px 12px; color: #fff; font-size: 0.9rem; font-weight: 700;
        overflow: hidden; background-color: rgb(74, 84, 101);
        background-image: linear-gradient(180deg, rgba(83,95,117,0.85), rgba(33,41,56,0.9));
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.2), 0 18px 42px rgba(0,0,0,0.4);
        transition: transform 460ms ${EASE}, opacity 220ms ease 300ms; }
      .fc-empty, .fc-day-detail { width: 100%; margin: auto 0; padding: 14px 8px; text-align: center;
        color: rgba(255,255,255,0.42); font-size: 0.8rem; line-height: 1.4; }
      .fc-day-detail { margin: 0; height: 100%; box-sizing: border-box; display: flex; flex-direction: column; gap: 10px; text-align: left; }
      .fc-day-detail .fc-scheduled-list { overflow: auto; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.5) transparent; }
      .fc-drop-hint { margin-top: auto; text-align: center; color: rgba(255,255,255,0.42); }
      .fc-level .fc-day-num { display: none; }
      .fc-level .fc-dowrow span { visibility: hidden; }
      .fc-surface[data-level="0"] .fc-scheduled-list { display: none; }
      .fc-surface[data-level="0"] .fc-day { pointer-events: none; }
      .fc-surface[data-level="0"] .fc-month { cursor: pointer; }
      .fc-surface[data-level="0"] .fc-month:hover,
      .fc-expander[data-kind="month"] .fc-day:hover,
      .fc-day.is-drop-target,
      .fc-day-detail.is-drop-target,
      .fc-empty.is-drop-target {
        background: linear-gradient(180deg, rgba(70,110,190,0.34), rgba(40,70,130,0.26));
        box-shadow: inset 0 0 0 1px rgba(125,180,255,0.5), 0 0 30px rgba(90,150,255,0.42); }
      .fc-expander[data-kind="month"] .fc-day { cursor: pointer; pointer-events: auto; }
      .fc-expander { position: absolute; z-index: 5; pointer-events: auto; -webkit-app-region: no-drag;
        transform-origin: 0 0;
        -webkit-backdrop-filter: blur(28px) saturate(140%); backdrop-filter: blur(28px) saturate(140%); }
      .fc-contracting-expander { background: transparent; box-shadow: none;
        -webkit-backdrop-filter: none; backdrop-filter: none; }
      .fc-warm, .fc-warm * { pointer-events: none !important; }
    `;
    document.head.appendChild(style);
  };

  const scheduledFor = (date) => scheduledByDate.get(date) || [];
  const scheduledHTML = (date, limit = 4) => {
    const all = scheduledFor(date);
    const items = all.slice(0, limit);
    if (!items.length) return "";
    const extra = all.length - items.length;
    return `<div class="fc-scheduled-list">${items.map((item) =>
      `<div class="fc-chip" data-type="${esc(item.type)}" data-id="${esc(item.id)}"${item.hot ? ' data-hot="true"' : ""}>${esc(item.title)}</div>`).join("")}${
      extra > 0 ? `<div class="fc-chip-more">+${extra} more</div>` : ""}</div>`;
  };
  const dayCellHTML = (month, day) => {
    const date = iso(month, day);
    const today = date === todayIso() ? " fc-today" : "";
    return `<div class="fc-day${today}" data-date="${date}"><span class="fc-day-num">${day}</span><div class="fc-day-body">${scheduledHTML(date)}</div></div>`;
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
    el.innerHTML = `<div class="fc-year-strip">
      <button type="button" class="fc-year-btn" data-year-step="-1" aria-label="Previous year">&lt;</button>
      <span class="fc-year-label">${currentYear}</span>
      <button type="button" class="fc-year-btn" data-year-step="1" aria-label="Next year">&gt;</button>
    </div>`;
    const frost = document.createElement("div");
    frost.className = "fc-frost";
    el.appendChild(frost);
    const grid = document.createElement("div");
    grid.className = "fc-grid";
    for (let month = 0; month < 12; month++) {
      const bucket = document.createElement("div");
      bucket.className = "fc-bucket fc-month";
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
    const strip = yearEl.querySelector(".fc-year-strip");
    if (strip) strip.style.top = `${Math.max(58, expRect().y - 8)}px`;
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
  };
  const buildExpander = (target, context) => {
    const isMonth = context.level === 0;
    const expander = document.createElement("div");
    expander.className = "fc-bucket fc-expander";
    expander.dataset.kind = isMonth ? "month" : "day";
    if (isMonth) {
      expander.dataset.month = target.dataset.month;
      expander.innerHTML = monthInnerHTML(Number(target.dataset.month) - 1);
    } else {
      expander.dataset.date = target.dataset.date;
      expander.innerHTML = dayInnerHTML(target.dataset.date);
    }
    return expander;
  };
  const configureExpander = (expander, target, context) => {
    const E = context.expRect();
    const b = context.sourceRect;
    expander.style.setProperty("--kx", (E.w / b.w).toFixed(4));
    expander.style.setProperty("--ky", (E.h / b.h).toFixed(4));
  };
  const targetFromPoint = (x, y, context) => {
    if (context.level >= 2) return null;
    const layer = context.layers[context.level];
    const selector = context.level === 0 ? ".fc-month" : ".fc-day";
    return [...(layer?.querySelectorAll(selector) || [])].find((bucket) => {
      const rect = bucket.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }) || null;
  };
  const targetFromEvent = (event, context) => {
    if (event.target?.closest?.(".fc-year-btn")) return null;
    const selector = context.level === 0 ? ".fc-month" : ".fc-day";
    const target = event.target.closest?.(selector);
    return target && context.layers[context.level]?.contains(target) ? target : null;
  };
  const sourceSelector = (target, context) => (
    context.level === 0 ? `.fc-month[data-month="${target.dataset.month}"]` : `.fc-day[data-date="${target.dataset.date}"]`
  );
  const keyOf = (target) => target.dataset.month ? `m${target.dataset.month}` : `d${target.dataset.date}`;

  const setYear = (year) => {
    currentYear = Math.max(1901, Math.min(2200, Number(year) || currentYear));
    localStorage.setItem(YEAR_STORE, String(currentYear));
    camera?.rebuildRoot?.();
    loadScheduled({ refresh: true });
  };
  const shiftYear = (delta) => setYear(currentYear + delta);

  const loadScheduled = async ({ refresh = false } = {}) => {
    const next = new Map();
    const add = (type, label, record) => {
      if (!record || record.deletedAt) return;
      const date = scheduledDateOf(record);
      if (!date || !yearDate(date)) return;
      const items = next.get(date) || [];
      items.push({ type, label, id: record.id, title: titleOf(record), hot: record.priority === "urgent" && Date.parse(record.dueAt || "") < Date.now() });
      next.set(date, items);
    };
    try {
      const result = await window.crmDomain?.list?.("commitments", { includeDeleted: false, limit: 500 });
      recordsFrom(result).filter((record) => !["completed", "cancelled", "canceled"].includes(String(record.status).toLowerCase())).forEach((record) => {
        add("commitment", record.kind || "Commitment", { ...record, dueDate: record.dueAt });
      });
    } catch {}
    scheduledByDate = next;
    if (refresh && camera) refreshLevels();
  };
  // Refresh every visible layer IN PLACE (BLUEPRINT A4): a data change while
  // dived into a month/day must repaint the chips without collapsing the
  // camera back to the year (rebuildRoot resets to level 0 — a navigation cut).
  const refreshLevels = () => {
    if (!camera) return;
    if (camera.isTransitioning?.()) { scheduleReload(); return; }   // never repaint mid-dive
    camera.dropWarm?.();
    const layers = camera.layers();
    layers[0]?.querySelectorAll?.(".fc-month").forEach((bucket) => {
      bucket.innerHTML = monthInnerHTML(Number(bucket.dataset.month) - 1);
    });
    layers.slice(1).forEach((layer) => {
      if (!layer?.dataset) return;
      if (layer.dataset.kind === "month") layer.innerHTML = monthInnerHTML(Number(layer.dataset.month) - 1);
      else if (layer.dataset.kind === "day") layer.innerHTML = dayInnerHTML(layer.dataset.date);
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
  const flyCardToDay = (fromRect, date, { title = "" } = {}) => {
    const surface = camera?.surface?.();
    if (!camera?.isActive?.() || !surface || surface.hidden) return false;
    const dest = surface.querySelector(`.fc-day[data-date="${date}"], .fc-day-detail[data-date="${date}"], .fc-empty[data-date="${date}"]`);
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
      if (!button || !camera?.surface?.()?.contains(button)) return;
      event.preventDefault();
      event.stopPropagation();
      shiftYear(Number(button.dataset.yearStep) || 0);
    }, true);
  };

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
    ensureStyles,
    buildRoot: buildYear,
    layout: layoutFrost,
    buildExpander,
    configureExpander,
    targetFromEvent,
    targetAtPoint: targetFromPoint,
    sourceSelector,
    keyOf,
    // B/Esc at the year root backs out to Home — the module→Home leg of the
    // one continuous B chain (BLUEPRINT A1): day→month→year→Home.
    onRootBack: () => window.crmDeskTransit?.driveTo?.("home"),
    onReady: () => {
      wireYearControls();
      wireDrops();
      wireDayOpens();
      subscribeScheduled();
      loadScheduled({ refresh: true });
    },
  });

  window.fractalCalendar = {
    setActive: (on) => camera.setActive(on),
    isActive: () => camera.isActive(),
    year: () => currentYear,
    setYear,
    nextYear: () => shiftYear(1),
    previousYear: () => shiftYear(-1),
    level: () => camera.level(),
    back: () => camera.back(),
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
    dayEl: (date) => camera.surface()?.querySelector(`.fc-day[data-date="${date}"], .fc-empty[data-date="${date}"], .fc-day-detail[data-date="${date}"]`) || null,
    monthEl: (month) => camera.surface()?.querySelector(`.fc-expander[data-month="${month}"], .fc-month[data-month="${month}"]`) || null,
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
