// crm-home.js - module home menu hosted by the shared fractal camera.
(() => {
  if (typeof window.createFractalCamera !== "function") {
    console.error("[CRM] fractal camera factory is not loaded");
    return;
  }

  // The six live module buckets (REMEDIATION_PLAN R5). Tasks' "Planned"
  // placeholder tile is gone until the module exists; Tickets stays reachable
  // from the top workspace switch.
  const MODULES = [
    { key: "today", label: "Today", enabled: true },
    { key: "people", label: "People", enabled: true },
    { key: "pipeline", label: "Pipeline", enabled: true },
    { key: "money", label: "Money", enabled: true },
    { key: "calendar", label: "Calendar", enabled: true },
    { key: "reports", label: "Reports", enabled: true },
  ];
  let camera = null;
  let subscribed = false;
  let refreshTimer = 0;
  let previewTimer = 0;
  let previewGeneration = 0;
  let previewAttempt = 0;
  const PREVIEW_RETRY_MS = [0, 120, 320, 700, 1400, 2800, 5000];
  let homeStats = {
    today: { count: 0 },
    tickets: { count: 0 },
    people: { count: 0, attention: 0 },
    pipeline: { stages: [] },
    money: { stages: [] },
    calendar: { count: 0 },
    tasks: { count: 0 },
    reports: { widgets: 0, active: 0 },
  };

  const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[char]));
  const recordsFrom = (result) => Array.isArray(result) ? result : ((result && (result.records || result.tickets)) || []);
  const metaOf = (record) => record?.meta && typeof record.meta === "object" ? record.meta : {};
  const valueOf = (record, key) => record && record[key] != null && record[key] !== "" ? record[key] : metaOf(record)[key];
  const listFrom = async (bridge) => {
    try { return recordsFrom(await bridge?.list?.({ includeDeleted: true })).filter((record) => record && !record.deletedAt); }
    catch { return []; }
  };
  const amountOf = (record) => {
    const raw = valueOf(record, "amount") ?? valueOf(record, "value") ?? valueOf(record, "budget") ?? "";
    const amount = Number(String(raw).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(amount) ? amount : 0;
  };
  const compact = (number) => {
    if (!Number.isFinite(number) || !number) return "0";
    if (Math.abs(number) >= 1000000) return `${Math.round(number / 100000) / 10}m`;
    if (Math.abs(number) >= 1000) return `${Math.round(number / 100) / 10}k`;
    return String(Math.round(number));
  };
  const dateOnly = (value) => {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ""));
    return match ? match[1] : "";
  };
  const stageOf = (record, fallback) => String(valueOf(record, "stage") || valueOf(record, "state") || fallback || "").toLowerCase();
  const closedState = (record) => ["resolved", "closed", "done", "complete", "completed", "archived", "cancelled", "canceled"].includes(String(valueOf(record, "state") || valueOf(record, "status") || "").toLowerCase());
  const invoiceState = (record) => String(valueOf(record, "state") || valueOf(record, "stage") || "draft").toLowerCase();
  const summarizeStages = (records, stages, amount = false) => stages.map((stage) => {
    const items = records.filter((record) => stageOf(record, stages[0]) === stage);
    return {
      key: stage,
      count: items.length,
      value: amount ? items.reduce((sum, record) => sum + amountOf(record), 0) : items.length,
    };
  });
  const loadHomeStats = async () => {
    const summaryPromise = Promise.resolve(window.crmReportsApi?.summary?.()).catch(() => null);
    const [summaryResult, tickets, contacts, deals, invoices, tasks, calendarItems] = await Promise.all([
      summaryPromise,
      listFrom(window.tickets),
      listFrom(window.contacts),
      listFrom(window.deals),
      listFrom(window.invoices),
      listFrom(window.tasks),
      listFrom({ list: (options) => window.crmStore?.list?.("calendarItems", options) }),
    ]);
    const summary = summaryResult?.summary || {};
    const datasets = summary.datasets || {};
    const openDeals = deals.filter((deal) => !["won", "lost"].includes(String(valueOf(deal, "state") || "").toLowerCase()));
    const openInvoices = invoices.filter((invoice) => !["paid", "void", "cancelled", "canceled"].includes(invoiceState(invoice)));
    return {
      today: { count: (datasets.todayHand || []).length || summary.totals?.todayHand || 0 },
      tickets: { count: tickets.filter((ticket) => !closedState(ticket)).length || summary.totals?.openTickets || 0 },
      people: {
        count: contacts.length,
        attention: contacts.filter((contact) => window.crmColdFront?.isTripped?.(contact, "contacts")).length || summary.totals?.contactsDue || 0,
      },
      pipeline: { stages: summarizeStages(openDeals, ["lead", "qualified", "proposal", "negotiation"], true) },
      money: { stages: summarizeStages(openInvoices, ["draft", "sent", "overdue"], true) },
      calendar: {
        count: calendarItems.length || summary.totals?.scheduledCount || 0,
        today: calendarItems.filter((item) => dateOnly(valueOf(item, "date") || valueOf(item, "scheduledDate") || valueOf(item, "startDate") || valueOf(item, "at")) === window.crmNextTouch?.localDate?.()).length,
      },
      tasks: { count: tasks.filter((task) => !closedState(task)).length || summary.totals?.openTasks || 0 },
      reports: {
        widgets: 5,
        active: [
          summary.totals?.pipelineValue,
          summary.totals?.outstandingCash,
          summary.totals?.invoiceAgingTotal,
          (datasets.activityByDay || []).length,
          (datasets.recentRecords || []).length,
        ].filter(Boolean).length,
      },
    };
  };
  const scheduleStatsRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      homeStats = await loadHomeStats();
      // Never rebuild the root mid-dive: refresh() would replace the layer the
      // camera (or the desk transit's lid) is animating. Try again shortly.
      if (camera?.isTransitioning?.() || window.crmDeskTransit?.isBusy?.()) { scheduleStatsRefresh(); return; }
      if (camera?.isActive?.() && camera.level() === 0) {
        camera.refresh();
        scheduleLivePreviews(true);
      }
    }, 120);
  };
  const subscribe = () => {
    if (subscribed) return;
    subscribed = true;
    try { window.crmStore?.onChanged?.(scheduleStatsRefresh); } catch {}
    try { window.tickets?.onChanged?.(scheduleStatsRefresh); } catch {}
  };

  const ensureStyles = () => {
    if (document.getElementById("crm-home-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-home-styles";
    style.textContent = `
      .crm-home-surface { position: fixed; inset: 0; z-index: 820; pointer-events: none; overflow: hidden; }
      .crm-home-surface[hidden] { display: none; }
      .crm-home-level { position: absolute; inset: 0; transform-origin: 0 0; }
      .crm-home-grid { position: absolute; display: grid; pointer-events: auto; -webkit-app-region: no-drag;
        grid-template-columns: repeat(3, minmax(0, 1fr)); grid-template-rows: repeat(2, minmax(0, 1fr)); gap: 14px; }
      /* The fc-bucket glass recipe (fractal-calendar.js is the source): gradient
         body, inset ring + top highlight, k-scaled radius from the bucket's own
         measured size (--home-r, set in layout()). */
      .crm-home-bucket { position: relative; box-sizing: border-box; display: flex; flex-direction: column; min-height: 0;
        overflow: hidden; color: #fff; cursor: pointer; border: 0;
        border-radius: var(--home-r, 16px); padding: 14px 16px;
        background: linear-gradient(180deg, rgba(22,26,36,0.5), rgba(12,16,24,0.42));
        -webkit-backdrop-filter: blur(28px) saturate(140%); backdrop-filter: blur(28px) saturate(140%);
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.14), inset 0 1px 0 rgba(255,255,255,0.18), 0 18px 42px rgba(0,0,0,0.28);
        transition: box-shadow .18s ease, background .18s ease; }
      .crm-home-bucket:hover {
        background: linear-gradient(180deg, rgba(70,110,190,0.34), rgba(40,70,130,0.26));
        box-shadow: inset 0 0 0 1px rgba(125,180,255,0.5), 0 0 30px rgba(90,150,255,0.42);
      }
      .crm-home-title { font-size: clamp(1rem, 2.4vw, 1.35rem); font-weight: 800; line-height: 1.1; }
      .crm-home-preview { position: relative; flex: 1 1 auto; min-height: 0; margin-top: 10px;
        overflow: hidden; opacity: .88; color: rgba(255,255,255,0.62); }
      .crm-home-preview-state { position: absolute; inset: 0; display: grid; place-items: center;
        font-size: .68rem; font-weight: 760; letter-spacing: .08em; text-transform: uppercase;
        color: rgba(255,255,255,.38); }
      .crm-home-preview-state::after { content: ""; position: absolute; width: 42px; height: 2px; margin-top: 26px;
        border-radius: 999px; background: linear-gradient(90deg, transparent, rgba(125,180,255,.72), transparent);
        animation: crm-home-preview-wait 1.15s ease-in-out infinite; }
      .crm-home-preview[data-preview-state="error"] .crm-home-preview-state { color: rgba(255,190,150,.64); }
      @keyframes crm-home-preview-wait { 0%,100% { opacity:.2; transform:scaleX(.45) } 50% { opacity:1; transform:scaleX(1) } }
      /* Factory-produced real DOM, viewed at k-scale. The miniature contains
         the same tk-zone/tk-card markup and paint as its full module. */
      .crm-factory-mini-scene { position: absolute; left: 50%; top: 50%; width: 1080px; height: 650px;
        transform: translate(-50%, -50%) scale(.31); transform-origin: center; pointer-events: none; }
      .crm-factory-mini-zone { position: absolute !important; top: 0 !important; bottom: auto !important;
        width: 240px !important; height: 620px !important; }
      .crm-factory-mini-zone .tk-zone-body { min-height: 540px; }
      .crm-factory-mini-zone .tk-zone-track { min-height: 540px; }
      .crm-factory-mini-hand { position: absolute; inset: 120px 0 0; }
      .crm-factory-mini-hand > .tk-card { position: absolute !important; top: 0 !important; bottom: auto !important; }
      .crm-calendar-mini-scene { position: absolute !important; left: 50%; top: 50%; width: 1540px; height: 900px;
        transform: translate(-50%, -50%) scale(.25); transform-origin: center; pointer-events: none; }
      .crm-calendar-mini-scene .fc-grid { position: absolute !important; inset: 25px !important;
        width: auto !important; height: auto !important; }
      .crm-report-mini-scene { position: absolute; inset: 0; display: grid; grid-template-columns: repeat(3, minmax(0,1fr));
        grid-template-rows: repeat(2, minmax(0,1fr)); gap: 6px; pointer-events: none; }
      .crm-report-mini-scene .crm-report-widget { position: relative !important; inset: auto !important; grid-area: auto !important;
        min-width: 0 !important; min-height: 0 !important; width: auto !important; height: auto !important; margin: 0 !important; }
      .crm-home-expander { position: absolute; z-index: 5; pointer-events: auto; -webkit-app-region: no-drag;
        transform-origin: 0 0; }
      .crm-home-warm, .crm-home-warm * { pointer-events: none !important; }
    `;
    document.head.appendChild(style);
  };

  const bucketHTML = (module) => `
    <div class="crm-home-title">${esc(module.label)}</div>
    <div class="crm-home-preview" data-preview-key="${esc(module.key)}" data-preview-state="waiting" aria-hidden="true">
      <div class="crm-home-preview-state">Live view</div>
    </div>`;

  const liveFactories = () => ({
    today: window.crmToday,
    people: window.peopleCards,
    pipeline: window.dealPipeline,
    money: window.moneyPipeline,
    calendar: window.fractalCalendar,
    reports: window.crmReports,
  });
  const refreshLivePreviews = async (generation = previewGeneration) => {
    if (!camera?.isActive?.() || camera.level() !== 0) return { ready: 0, missing: MODULES.map(({ key }) => key) };
    const level = camera.layers?.()[0];
    if (!level) return { ready: 0, missing: MODULES.map(({ key }) => key) };
    const missing = [];
    let ready = 0;
    await Promise.all(Object.entries(liveFactories()).map(async ([key, factory]) => {
      const preview = level.querySelector(`.crm-home-bucket[data-module="${key}"] .crm-home-preview`);
      if (!preview) return;
      if (typeof factory?.miniature !== "function") {
        missing.push(key);
        return;
      }
      try {
        const miniature = await factory.miniature();
        if (generation !== previewGeneration || !preview.isConnected || !miniature) return;
        preview.replaceChildren(miniature);
        preview.dataset.previewState = "ready";
        ready += 1;
      } catch {
        if (generation !== previewGeneration || !preview.isConnected) return;
        preview.dataset.previewState = "error";
        preview.innerHTML = '<div class="crm-home-preview-state">Retrying live view</div>';
        missing.push(key);
      }
    }));
    return { ready, missing };
  };

  const scheduleLivePreviews = (reset = false) => {
    clearTimeout(previewTimer);
    if (reset) {
      previewGeneration += 1;
      previewAttempt = 0;
    }
    const generation = previewGeneration;
    const delay = PREVIEW_RETRY_MS[Math.min(previewAttempt, PREVIEW_RETRY_MS.length - 1)];
    previewTimer = setTimeout(async () => {
      if (generation !== previewGeneration || !camera?.isActive?.() || camera.level() !== 0) return;
      const result = await refreshLivePreviews(generation);
      if (generation !== previewGeneration || !result?.missing?.length) return;
      previewAttempt += 1;
      scheduleLivePreviews(false);
    }, delay);
  };

  const buildRoot = () => {
    const root = document.createElement("div");
    root.className = "crm-home-level";
    const grid = document.createElement("div");
    grid.className = "crm-home-grid";
    MODULES.forEach((module) => {
      const bucket = document.createElement("button");
      bucket.type = "button";
      bucket.className = "crm-home-bucket";
      bucket.dataset.module = module.key;
      bucket.dataset.enabled = module.enabled ? "true" : "false";
      if (!module.enabled) bucket.setAttribute("aria-disabled", "true");
      bucket.innerHTML = bucketHTML(module);
      grid.appendChild(bucket);
    });
    root.appendChild(grid);
    return root;
  };

  // Fill the working viewport the way the calendar's year view does: cells
  // aspect-locked to the viewport, the 3x2 grid centred inside expRect(), the
  // bucket radius k-scaled from the measured cell (fc's RADIUS_F discipline).
  const RADIUS_F = 16 / 245;
  const layout = ({ expRect }) => {
    const surface = camera?.surface?.();
    const grid = surface?.querySelector(".crm-home-grid");
    if (!grid) return;
    const GAP = 14, COLS = 3, ROWS = 2;
    const E = expRect();
    const aspect = E.w / E.h;
    let cellW = (E.w - (COLS - 1) * GAP) / COLS;
    let cellH = cellW / aspect;
    if (ROWS * cellH + (ROWS - 1) * GAP > E.h) {
      cellH = (E.h - (ROWS - 1) * GAP) / ROWS;
      cellW = cellH * aspect;
    }
    const gridW = COLS * cellW + (COLS - 1) * GAP;
    const gridH = ROWS * cellH + (ROWS - 1) * GAP;
    Object.assign(grid.style, {
      left: `${(E.x + (E.w - gridW) / 2).toFixed(2)}px`,
      top: `${(E.y + (E.h - gridH) / 2).toFixed(2)}px`,
      width: `${gridW.toFixed(2)}px`,
      height: `${gridH.toFixed(2)}px`,
    });
    const radius = Math.min(64, Math.max(2, RADIUS_F * Math.min(cellW, cellH) * 2));
    surface.style.setProperty("--home-r", `${radius.toFixed(1)}px`);
  };

  const targetAtPoint = (x, y, context) => {
    if (context.level > 0) return null;
    return [...(context.layers[0]?.querySelectorAll('.crm-home-bucket[data-enabled="true"]') || [])].find((bucket) => {
      const rect = bucket.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }) || null;
  };

  const targetFromEvent = (event, context) => {
    if (context.level > 0) return null;
    const target = event.target.closest?.('.crm-home-bucket[data-enabled="true"]');
    return target && context.layers[0]?.contains(target) ? target : null;
  };

  const moduleFor = (target) => MODULES.find((module) => module.key === target?.dataset?.module) || MODULES[0];
  const buildExpander = (target) => {
    const module = moduleFor(target);
    const bucket = document.createElement("div");
    bucket.className = "crm-home-bucket crm-home-expander";
    bucket.dataset.module = module.key;
    bucket.innerHTML = bucketHTML(module);
    return bucket;
  };

  const openModule = (target) => {
    const module = target?.dataset?.module || "";
    if (!module || target?.dataset?.enabled !== "true") return;
    // The camera's own onClick already started the dive for this click; the
    // desk transit adopts its ending so the theater commit happens at dive
    // completion behind the lid — never the old 180ms mid-flight cut (A1).
    if (window.crmDeskTransit?.adoptDive) window.crmDeskTransit.adoptDive(module);
    else window.setTimeout(() => window.crmWorkspaces?.setActive?.(module), 180);
  };

  camera = window.createFractalCamera({
    apiName: "crmHomeCamera",
    theater: "home",
    surfaceClass: "crm-home-surface",
    layerClass: "crm-home-level",
    warmClass: "crm-home-warm",
    contractingClass: "crm-home-contracting",
    active: false,
    maxLevel: 1,
    margin: 16,
    ensureStyles,
    buildRoot,
    layout,
    targetFromEvent,
    targetAtPoint,
    buildExpander,
    keyOf: (target) => target.dataset.module || "",
    sourceSelector: (target) => `.crm-home-bucket[data-module="${target.dataset.module}"]`,
  });

  document.addEventListener("click", (event) => {
    if (!camera?.isActive?.()) return;
    const target = event.target?.closest?.(".crm-home-bucket[data-module]");
    if (!target || !camera.surface()?.contains(target)) return;
    openModule(target);
  }, true);

  const setActive = (on) => {
    subscribe();
    camera.setActive(on);
    if (on) {
      scheduleStatsRefresh();
      scheduleLivePreviews(true);
    } else {
      clearTimeout(previewTimer);
      previewGeneration += 1;
    }
    return window.crmHome;
  };

  window.crmHome = {
    setActive,
    isActive: () => camera.isActive(),
    refresh: () => {
      scheduleStatsRefresh();
      camera.refresh();
      scheduleLivePreviews(true);
    },
    previewStatus: () => MODULES.map(({ key }) => ({
      key,
      state: camera.layers?.()[0]?.querySelector(`.crm-home-bucket[data-module="${key}"] .crm-home-preview`)?.dataset?.previewState || "missing",
    })),
  };
})();
