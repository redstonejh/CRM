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
    { key: "desk", label: "Desk", enabled: true },
    { key: "people", label: "People", enabled: true },
    { key: "pipeline", label: "Pipeline", enabled: true },
    { key: "jobs", label: "Jobs", enabled: true },
    { key: "money", label: "Money", enabled: true },
    { key: "calendar", label: "Calendar", enabled: true },
  ];
  let camera = null;
  let subscribed = false;
  let refreshTimer = 0;
  let previewTimer = 0;
  let previewGeneration = 0;
  let previewAttempt = 0;
  let previewModel = window.crmHomePreviewData?.emptyModel?.() || { commitments: [], flows: [], companies: [], contacts: [], recordIndex: new Map() };
  const previewBaselines = new Map();
  const baselineJobs = new Map();
  let activePreviewKey = "";
  let lastWorkspace = "home";
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
    // Data changes repaint the real module that owns them. Home deliberately
    // does not maintain six live render trees; its cached LOD is recaptured at
    // the next enter/leave boundary.
    refreshTimer = setTimeout(() => {}, 120);
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
        grid-template-columns: repeat(3, minmax(0, 1fr)); grid-template-rows: repeat(2, minmax(0, 1fr)); gap: 16px; }
      /* The fc-bucket glass recipe (fractal-calendar.js is the source): gradient
         body, inset ring + top highlight, k-scaled radius from the bucket's own
         measured size (--home-r, set in layout()). */
      .crm-home-bucket { position: relative; box-sizing: border-box; display: block; min-height: 0;
        overflow: hidden; color: #fff; cursor: pointer; border: 0; container-type: size;
        border-radius: var(--home-r, 16px); padding: 0;
        background: linear-gradient(180deg, rgba(22,26,36,0.34), rgba(12,16,24,0.28));
        -webkit-backdrop-filter: blur(28px) saturate(140%); backdrop-filter: blur(28px) saturate(140%);
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.14), inset 0 1px 0 rgba(255,255,255,0.18), 0 18px 42px rgba(0,0,0,0.28);
        transition: box-shadow .18s ease, background .18s ease; }
      .crm-home-bucket:hover {
        background: linear-gradient(180deg, rgba(70,110,190,0.34), rgba(40,70,130,0.26));
        box-shadow: inset 0 0 0 1px rgba(125,180,255,0.5), 0 0 30px rgba(90,150,255,0.42);
      }
      .crm-home-title-glass { position: absolute; z-index: 4; left: 50%; top: 50%; transform: translate(-50%,-50%);
        width: max-content; max-width: 80%; padding: 0; border: 0; border-radius: 0; text-align: center; pointer-events: none;
        background: none; -webkit-backdrop-filter: none; backdrop-filter: none; box-shadow: none;
        transition: opacity .18s ease; }
      .crm-home-title { font: 600 clamp(11px, 3.2cqh, 15px)/1.05 system-ui; letter-spacing: .14em; text-transform: uppercase;
        color: rgba(226,234,246,.66); text-shadow: 0 1px 0 rgba(255,255,255,.19), 0 -1px 0 rgba(0,0,0,.78), 0 2px 8px rgba(0,0,0,.24); }
      .crm-home-bucket:hover .crm-home-title-glass { opacity: .72; }
      .crm-home-preview { position: absolute; inset: 0; width: 100%; height: 100%; box-sizing: border-box;
        overflow: hidden; opacity: .92; color: rgba(255,255,255,0.62); }
      .crm-home-preview-state { position: absolute; inset: 0; display: grid; place-items: center;
        font-size: .68rem; font-weight: 760; letter-spacing: .08em; text-transform: uppercase;
        color: rgba(255,255,255,.38); }
      .crm-home-preview-state::after { content: ""; position: absolute; width: 42px; height: 2px; margin-top: 26px;
        border-radius: 999px; background: linear-gradient(90deg, transparent, rgba(125,180,255,.72), transparent);
        animation: crm-home-preview-wait 1.15s ease-in-out infinite; }
      .crm-home-preview[data-preview-state="error"] .crm-home-preview-state { color: rgba(255,190,150,.64); }
      @keyframes crm-home-preview-wait { 0%,100% { opacity:.2; transform:scaleX(.45) } 50% { opacity:1; transform:scaleX(1) } }
      /* A Home preview is a cached full-viewport baseline, never a separately
         rendered miniature. Only one near/transition LOD is promoted at once. */
      .crm-home-lod-scene { position: absolute; left: 0; top: 0; overflow: hidden; pointer-events: none;
        transform-origin: 0 0; contain: layout paint style; }
      .crm-home-lod-scene > .crm-home-lod-root { display: block !important; pointer-events: none !important; }
      .crm-home-lod-scene [data-crm-theater] { pointer-events: none !important; }
      .crm-home-lod-scene[data-lod="far"] :is(.tk-menu,.tk-stack-scrim,.crm-desk-composer,.record-world-shell,canvas) { display: none !important; }
      .crm-home-lod-scene[data-lod="far"] :is(.ticket-description,.ticket-fields,.ticket-face-badges,.crm-desk-commitment-context,.crm-desk-work-meta,.crm-desk-activity-text,.crm-person-role,.fc-chip) { visibility: hidden !important; }
      .crm-home-lod-scene :is(.crm-home-empty,.crm-desk-empty,.crm-people-empty,.tk-zone-empty,.tk-empty,.tk-desk-clear) { visibility: hidden !important; }
      .crm-home-expander { position: absolute; z-index: 5; pointer-events: auto; -webkit-app-region: no-drag;
        transform-origin: 0 0; }
      .crm-home-expander .crm-home-lod-scene { transform: none !important; contain: paint style; }
      .crm-home-expander .crm-home-title-glass { opacity: 0; transition: opacity 180ms ease; }
      .crm-home-warm, .crm-home-warm * { pointer-events: none !important; }
    `;
    document.head.appendChild(style);
  };

  const bucketHTML = (module) => `
    <div class="crm-home-preview" data-preview-key="${esc(module.key)}" data-preview-state="waiting" aria-hidden="true"></div>
    <div class="crm-home-title-glass"><div class="crm-home-title">${esc(module.label)}</div></div>`;

  const liveFactories = () => ({
    desk: window.crmDesk,
    people: window.crmPeopleRoom,
    pipeline: window.dealPipeline,
    jobs: window.jobPipeline,
    money: window.moneyPipeline,
    calendar: window.fractalCalendar,
  });

  const theaterFor = (key) => ({ people: "relationships" }[key] || key);
  const sourceFor = (key) => [...document.querySelectorAll(`[data-crm-theater="${theaterFor(key)}"]`)]
    .find((node) => !node.closest(".crm-home-surface,.crm-transit-veil")) || null;
  const sanitizeClone = (source) => {
    const clone = source.cloneNode(true);
    clone.hidden = false;
    clone.removeAttribute("hidden");
    clone.removeAttribute("data-crm-theater");
    clone.classList.add("crm-home-lod-root");
    clone.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    clone.querySelectorAll("input,button,select,textarea,a,[tabindex]").forEach((node) => {
      node.setAttribute("tabindex", "-1");
      if ("disabled" in node) node.disabled = true;
    });
    clone.querySelectorAll(":scope > [hidden]").forEach((node) => node.remove());
    clone.inert = true;
    return clone;
  };
  const captureBaseline = (key) => {
    const source = sourceFor(key);
    if (!source) return null;
    const baseline = {
      root: sanitizeClone(source),
      width: window.innerWidth,
      height: window.innerHeight,
      capturedAt: performance.now(),
    };
    previewBaselines.set(key, baseline);
    return baseline;
  };
  const trimFarLod = (scene) => {
    const selectors = [".tk-zone-track", ".tk-deck-box", ".crm-desk-commitments", ".crm-desk-work-deck", ".crm-company-people", ".crm-company-list"];
    scene.querySelectorAll(selectors.join(",")).forEach((group) => {
      [...group.children].slice(5).forEach((node) => node.remove());
    });
    scene.querySelectorAll(":is(.tk-menu,.crm-desk-composer,.record-world-shell,.record-world-backdrop,.ticket-detail-overlay)").forEach((node) => node.remove());
  };
  const sceneFor = (key, lod = "far") => {
    const baseline = previewBaselines.get(key);
    if (!baseline) return null;
    const scene = document.createElement("div");
    scene.className = "crm-home-lod-scene";
    scene.dataset.lod = lod;
    scene.dataset.previewKey = key;
    Object.assign(scene.style, { width: `${baseline.width}px`, height: `${baseline.height}px` });
    scene.appendChild(baseline.root.cloneNode(true));
    if (lod === "far") trimFarLod(scene);
    return scene;
  };
  const fitPreview = (preview) => {
    const scene = preview?.querySelector(":scope > .crm-home-lod-scene");
    if (!scene) return;
    const baseline = previewBaselines.get(preview.dataset.previewKey);
    if (!baseline || preview.closest(".crm-home-expander")) return;
    const scale = Math.min(preview.clientWidth / baseline.width, preview.clientHeight / baseline.height);
    const x = (preview.clientWidth - baseline.width * scale) / 2;
    const y = (preview.clientHeight - baseline.height * scale) / 2;
    scene.style.transform = `translate(${x.toFixed(2)}px,${y.toFixed(2)}px) scale(${scale.toFixed(6)})`;
  };
  const mountPreview = (key, lod = "far") => {
    const preview = camera?.layers?.()[0]?.querySelector(`.crm-home-bucket[data-module="${key}"] .crm-home-preview`);
    const scene = sceneFor(key, lod);
    if (!preview || !scene) return false;
    preview.replaceChildren(scene);
    preview.dataset.previewState = "ready";
    fitPreview(preview);
    return true;
  };
  const setPreviewLod = (key, lod) => {
    if (lod !== "far" && activePreviewKey && activePreviewKey !== key) mountPreview(activePreviewKey, "far");
    if (mountPreview(key, lod)) activePreviewKey = lod === "far" ? "" : key;
  };
  const refreshBaseline = async (key, { reload = false, mount = true } = {}) => {
    if (baselineJobs.has(key)) return baselineJobs.get(key);
    const job = (async () => {
      const factory = liveFactories()[key];
      if (reload) {
        try {
          if (typeof factory?.baseline === "function") await factory.baseline();
          else if (typeof factory?.reload === "function") await factory.reload();
          else if (typeof factory?.refresh === "function") await factory.refresh();
        } catch {}
      }
      const baseline = captureBaseline(key);
      if (baseline && mount && camera?.isActive?.() && camera.level() === 0) mountPreview(key, key === activePreviewKey ? "near" : "far");
      return baseline;
    })().finally(() => baselineJobs.delete(key));
    baselineJobs.set(key, job);
    return job;
  };
  const refreshLivePreviews = async (generation = previewGeneration) => {
    if (!camera?.isActive?.() || camera.level() !== 0) return { ready: 0, missing: MODULES.map(({ key }) => key) };
    const level = camera.layers?.()[0];
    if (!level) return { ready: 0, missing: MODULES.map(({ key }) => key) };
    const missing = [];
    let ready = 0;
    await Promise.all(MODULES.map(async ({ key }) => {
      const preview = level.querySelector(`.crm-home-bucket[data-module="${key}"] .crm-home-preview`);
      if (!preview) return;
      try {
        const baseline = previewBaselines.get(key) || await refreshBaseline(key, { reload: true, mount: false });
        if (generation !== previewGeneration || !preview.isConnected || !baseline) { missing.push(key); return; }
        mountPreview(key, "far");
        ready += 1;
      } catch { missing.push(key); }
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

  // Each bucket is the aspect ratio of the real window beneath it. That lets
  // the cached baseline use one uniform scale at Home and land at scale(1)
  // with no crop, second transform, or final-frame correction.
  const RADIUS_F = 16 / 245;
  const layout = ({ expRect }) => {
    const surface = camera?.surface?.();
    const grid = surface?.querySelector(".crm-home-grid");
    if (!grid) return;
    const GAP = 16, COLS = 3, ROWS = 2, OUTER = 16;
    const full = expRect();
    let controlsBottom = 42;
    document.querySelectorAll(".window-control-cluster").forEach((node) => {
      controlsBottom = Math.max(controlsBottom, node.getBoundingClientRect().bottom);
    });
    const E = { x: OUTER, y: Math.round(controlsBottom + 12), w: full.w - OUTER * 2, h: full.h - Math.round(controlsBottom + 12) - OUTER };
    const aspect = window.innerWidth / window.innerHeight;
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
    surface.querySelectorAll(".crm-home-preview").forEach(fitPreview);
  };

  const targetAtPoint = (x, y, context) => {
    if (context.level > 0) return null;
    const target = [...(context.layers[0]?.querySelectorAll('.crm-home-bucket[data-enabled="true"]') || [])].find((bucket) => {
      const rect = bucket.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }) || null;
    const key = target?.dataset?.module || "";
    if (key && activePreviewKey !== key) setPreviewLod(key, "near");
    return target;
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
    const preview = bucket.querySelector(".crm-home-preview");
    const scene = sceneFor(module.key, "transition");
    if (preview && scene) {
      preview.replaceChildren(scene);
      preview.dataset.previewState = "ready";
    }
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
    margin: 0,
    measureTop: () => 0,
    ensureStyles,
    buildRoot,
    layout,
    targetFromEvent,
    targetAtPoint,
    buildExpander,
    keyOf: (target) => target.dataset.module || "",
    sourceSelector: (target) => `.crm-home-bucket[data-module="${target.dataset.module}"]`,
    prepareTarget: (target) => setPreviewLod(target.dataset.module || "", "transition"),
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
      scheduleLivePreviews(true);
    } else {
      clearTimeout(previewTimer);
      previewGeneration += 1;
    }
    return window.crmHome;
  };

  const waitForModuleSettled = (key, timeoutMs = 1800) => new Promise((resolve) => {
    const started = performance.now();
    const readySelector = {
      desk: ".crm-desk-frame", people: ".crm-people-frame,.crm-company-list",
      pipeline: ".tk-zone,.tk-deck", jobs: ".tk-zone,.tk-deck", money: ".tk-zone,.tk-deck",
      calendar: ".fc-grid",
    }[key] || "*";
    let stableFrames = 0;
    let lastSignature = "";
    const tick = () => {
      const source = sourceFor(key);
      const ready = !!source?.querySelector?.(readySelector);
      const signature = ready ? `${source.childElementCount}:${source.textContent.length}:${source.querySelectorAll("*").length}` : "";
      stableFrames = ready && signature === lastSignature ? stableFrames + 1 : 0;
      lastSignature = signature;
      if (stableFrames >= 2 || performance.now() - started >= timeoutMs) {
        refreshBaseline(key, { mount: false }).finally(resolve);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  document.addEventListener("crm:theater-switch", (event) => {
    const next = event.detail?.key || "home";
    const previous = lastWorkspace;
    lastWorkspace = next;
    if (previous !== "home" && previous !== next) refreshBaseline(previous, { mount: next === "home" });
    if (next !== "home") waitForModuleSettled(next);
    else if (camera?.isActive?.()) scheduleLivePreviews(true);
  });

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      MODULES.forEach(({ key }) => {
        if (sourceFor(key)) captureBaseline(key);
      });
      if (camera?.isActive?.() && camera.level() === 0) MODULES.forEach(({ key }) => mountPreview(key, "far"));
    }, 100);
  });

  window.crmHome = {
    setActive,
    isActive: () => camera.isActive(),
    refresh: () => {
      camera.refresh();
      scheduleLivePreviews(true);
    },
    captureBaseline: (key, options) => refreshBaseline(key, options),
    waitForModuleSettled,
    previewStatus: () => MODULES.map(({ key }) => ({
      key,
      state: camera.layers?.()[0]?.querySelector(`.crm-home-bucket[data-module="${key}"] .crm-home-preview`)?.dataset?.previewState || "missing",
    })),
  };
})();
