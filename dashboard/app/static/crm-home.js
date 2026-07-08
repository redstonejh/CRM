// crm-home.js - module home menu hosted by the shared fractal camera.
(() => {
  if (typeof window.createFractalCamera !== "function") {
    console.error("[CRM] fractal camera factory is not loaded");
    return;
  }

  const MODULES = [
    { key: "today", label: "Today", note: "The dealt hand for work due now", enabled: true },
    { key: "tickets", label: "Tickets", note: "Active queue and issue history", enabled: true },
    { key: "people", label: "People", note: "Contacts and relationship attention", enabled: true },
    { key: "pipeline", label: "Pipeline", note: "Deals, stages and wins", enabled: true },
    { key: "money", label: "Money", note: "Invoices, cash aging and paid work", enabled: true },
    { key: "calendar", label: "Calendar", note: "Scheduled work by day", enabled: true },
    { key: "tasks", label: "Tasks", note: "Work items from the same card system", status: "Planned" },
    { key: "reports", label: "Reports", note: "Aggregates and builder widgets", enabled: true },
  ];
  let camera = null;
  let subscribed = false;
  let refreshTimer = 0;
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
      if (camera?.isActive?.()) camera.refresh();
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
        grid-template-columns: repeat(3, minmax(0, 1fr)); grid-template-rows: repeat(3, minmax(0, 1fr)); gap: 14px; }
      .crm-home-bucket { position: relative; box-sizing: border-box; display: flex; flex-direction: column; min-height: 0;
        overflow: hidden; color: #fff; cursor: pointer;
        border-radius: 16px; padding: 14px 16px;
        background: linear-gradient(180deg, rgba(22,26,36,0.5), rgba(12,16,24,0.42));
        -webkit-backdrop-filter: blur(28px) saturate(140%); backdrop-filter: blur(28px) saturate(140%);
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.14), inset 0 1px 0 rgba(255,255,255,0.18), 0 18px 42px rgba(0,0,0,0.28);
        transition: box-shadow .18s ease, background .18s ease; }
      .crm-home-bucket:hover {
        background: linear-gradient(180deg, rgba(70,110,190,0.34), rgba(40,70,130,0.26));
        box-shadow: inset 0 0 0 1px rgba(125,180,255,0.5), 0 0 30px rgba(90,150,255,0.42);
      }
      .crm-home-bucket[aria-disabled="true"] { cursor: default; opacity: .54; }
      .crm-home-bucket[aria-disabled="true"]:hover {
        background: linear-gradient(180deg, rgba(22,26,36,0.5), rgba(12,16,24,0.42));
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.14), inset 0 1px 0 rgba(255,255,255,0.18), 0 18px 42px rgba(0,0,0,0.28);
      }
      .crm-home-title { font-size: clamp(1rem, 2.4vw, 1.35rem); font-weight: 800; line-height: 1.1; }
      .crm-home-note { margin-top: 8px; font-size: 0.8rem; line-height: 1.35; color: rgba(255,255,255,0.58); max-width: 24ch; }
      .crm-home-status { margin-top: 10px; width: fit-content; border-radius: 999px; padding: 3px 7px;
        font-size: 0.68rem; font-weight: 800; color: rgba(255,255,255,0.62); background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.10); }
      .crm-home-preview { margin-top: auto; min-height: 52px; opacity: .82; color: rgba(255,255,255,0.62); }
      .crm-home-count { font-size: .68rem; font-weight: 800; line-height: 1; color: rgba(255,255,255,0.68); }
      .crm-home-stack-preview { position: relative; height: 52px; }
      .crm-home-mini-card { position: absolute; left: 0; bottom: 0; width: 44px; height: 34px; border-radius: 6px;
        background: rgba(255,255,255,0.13); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10); }
      .crm-home-mini-card:nth-child(2) { left: 16px; bottom: 6px; }
      .crm-home-mini-card:nth-child(3) { left: 32px; bottom: 12px; }
      .crm-home-mini-card.is-on { background: rgba(125,180,255,0.26); }
      .crm-home-mini-card.is-warn { background: rgba(234,88,12,0.22); }
      .crm-home-stage-preview { height: 52px; display: grid; grid-template-columns: repeat(var(--stage-count, 4), minmax(0,1fr)); gap: 6px; align-items: end; }
      .crm-home-mini-stage { position: relative; min-height: 12px; border-radius: 7px 7px 4px 4px;
        background: rgba(255,255,255,0.12); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08); overflow: hidden; }
      .crm-home-mini-stage::after { content: ""; position: absolute; left: 4px; right: 4px; bottom: 4px; height: 4px; border-radius: 999px; background: rgba(125,180,255,0.36); }
      .crm-home-mini-stage[data-hot="true"]::after { background: rgba(234,88,12,0.44); }
      .crm-home-calendar-preview { display: grid; grid-template-columns: repeat(7, 1fr); grid-template-rows: repeat(2, 1fr); gap: 4px; height: 50px; }
      .crm-home-mini-day { border-radius: 5px; background: rgba(255,255,255,0.10); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.07); }
      .crm-home-mini-day.is-on { background: rgba(125,180,255,0.24); }
      .crm-home-report-preview { height: 50px; display: grid; grid-template-columns: repeat(5, 1fr); gap: 5px; align-items: end; }
      .crm-home-mini-widget { border-radius: 6px; min-height: 16px; background: rgba(255,255,255,0.12); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08); }
      .crm-home-mini-widget.is-on { background: rgba(125,180,255,0.24); }
      .crm-home-expander { position: absolute; z-index: 5; pointer-events: auto; -webkit-app-region: no-drag;
        transform-origin: 0 0; }
      .crm-home-warm, .crm-home-warm * { pointer-events: none !important; }
    `;
    document.head.appendChild(style);
  };

  const maxValue = (items) => Math.max(1, ...items.map((item) => item.value || item.count || 0));
  const stackPreview = (count, warn = 0) => {
    const cards = Math.min(3, Math.max(0, count));
    return `<div class="crm-home-stack-preview">${[0, 1, 2].map((idx) => (
      `<span class="crm-home-mini-card${idx < cards ? " is-on" : ""}${idx < warn ? " is-warn" : ""}"></span>`
    )).join("")}<div class="crm-home-count">${esc(compact(count))}</div></div>`;
  };
  const stagePreview = (stages, hotKey = "") => {
    const scale = maxValue(stages);
    return `<div class="crm-home-stage-preview" style="--stage-count:${Math.max(1, stages.length)}">` +
      stages.map((stage) => {
        const fill = Math.max(0.06, (stage.value || stage.count || 0) / scale);
        return `<span class="crm-home-mini-stage" data-hot="${stage.key === hotKey ? "true" : "false"}" style="height:${Math.round(12 + fill * 34)}px"></span>`;
      }).join("") +
      `</div><div class="crm-home-count">${esc(compact(stages.reduce((sum, stage) => sum + (stage.value || 0), 0)))} / ${esc(compact(stages.reduce((sum, stage) => sum + (stage.count || 0), 0)))}</div>`;
  };
  const calendarPreview = (count) => `<div class="crm-home-calendar-preview">${Array.from({ length: 14 }, (_v, idx) => (
    `<span class="crm-home-mini-day${idx < Math.min(14, count) ? " is-on" : ""}"></span>`
  )).join("")}</div><div class="crm-home-count">${esc(compact(count))}</div>`;
  const reportPreview = (active, total) => `<div class="crm-home-report-preview">${Array.from({ length: total || 5 }, (_v, idx) => (
    `<span class="crm-home-mini-widget${idx < active ? " is-on" : ""}" style="height:${16 + (idx % 3) * 9}px"></span>`
  )).join("")}</div><div class="crm-home-count">${esc(compact(active))} / ${esc(compact(total || 5))}</div>`;
  const previewHTML = (key) => {
    if (key === "today") return stackPreview(homeStats.today.count, 0);
    if (key === "tickets") return stackPreview(homeStats.tickets.count, 0);
    if (key === "people") return stackPreview(homeStats.people.count, homeStats.people.attention);
    if (key === "pipeline") return stagePreview(homeStats.pipeline.stages, "negotiation");
    if (key === "money") return stagePreview(homeStats.money.stages, "overdue");
    if (key === "calendar") return calendarPreview(homeStats.calendar.count);
    if (key === "tasks") return stackPreview(homeStats.tasks.count, 0);
    if (key === "reports") return reportPreview(homeStats.reports.active, homeStats.reports.widgets);
    return "";
  };

  const bucketHTML = (module) => `
    <div class="crm-home-title">${esc(module.label)}</div>
    <div class="crm-home-note">${esc(module.note)}</div>
    ${module.status ? `<div class="crm-home-status">${esc(module.status)}</div>` : ""}
    <div class="crm-home-preview" aria-hidden="true">${previewHTML(module.key)}</div>`;

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

  const layout = ({ expRect }) => {
    const grid = camera?.surface?.()?.querySelector(".crm-home-grid");
    if (!grid) return;
    const E = expRect();
    const maxW = Math.min(E.w, 980);
    const maxH = Math.min(E.h, 640);
    const width = Math.max(320, maxW);
    const height = Math.max(360, maxH);
    Object.assign(grid.style, {
      left: `${Math.round(E.x + (E.w - width) / 2)}px`,
      top: `${Math.round(E.y + (E.h - height) / 2)}px`,
      width: `${Math.round(width)}px`,
      height: `${Math.round(height)}px`,
    });
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
    window.setTimeout(() => window.crmWorkspaces?.setActive?.(module), 180);
  };

  camera = window.createFractalCamera({
    apiName: "crmHomeCamera",
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
    if (on) scheduleStatsRefresh();
    return window.crmHome;
  };

  window.crmHome = {
    setActive,
    isActive: () => camera.isActive(),
    refresh: () => {
      scheduleStatsRefresh();
      camera.refresh();
    },
  };
})();
