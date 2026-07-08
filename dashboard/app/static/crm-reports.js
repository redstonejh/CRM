// crm-reports.js - CRM aggregate dashboard backed by the Postgres/API report feed.
(() => {
  const REPORT_WIDGETS = [
    {
      key: "crm-report-open-deals",
      layout: "builder",
      type: "stat",
      col: 1,
      row: 1,
      cols: 1,
      rows: 1,
      data: "openDeals",
      config: { label: "Open Deals", title: "Open Deals", metric: "count", format: "number" },
    },
    {
      key: "crm-report-pipeline-value",
      layout: "builder",
      type: "stat",
      col: 2,
      row: 1,
      cols: 1,
      rows: 1,
      data: "pipelineValueRows",
      config: { label: "Pipeline Value", title: "Pipeline Value", metric: "sum", valueField: "amountValue", format: "currency" },
    },
    {
      key: "crm-report-win-rate",
      layout: "builder",
      type: "stat",
      col: 3,
      row: 1,
      cols: 1,
      rows: 1,
      data: "winRateRows",
      config: { label: "Win Rate", title: "Win Rate", metric: "avg", valueField: "wonRatio", format: "percent" },
    },
    {
      key: "crm-report-contacts-due",
      layout: "builder",
      type: "stat",
      col: 4,
      row: 1,
      cols: 1,
      rows: 1,
      data: "contactsDue",
      config: { label: "Contacts Due", title: "Contacts Due", metric: "count", format: "number" },
    },
    {
      key: "crm-report-open-tasks",
      layout: "builder",
      type: "stat",
      col: 5,
      row: 1,
      cols: 1,
      rows: 1,
      data: "openTasks",
      config: { label: "Open Tasks", title: "Open Tasks", metric: "count", format: "number" },
    },
    {
      key: "crm-report-scheduled",
      layout: "builder",
      type: "stat",
      col: 6,
      row: 1,
      cols: 1,
      rows: 1,
      data: "scheduledItems",
      config: { label: "Scheduled", title: "Scheduled", metric: "count", format: "number" },
    },
    {
      key: "crm-report-pipeline-chart",
      layout: "builder-chart",
      type: "chart",
      col: 1,
      row: 1,
      cols: 3,
      rows: 3,
      data: "pipelineByStage",
      config: {
        title: "Pipeline by Stage",
        chartType: "bar",
        xField: "stageLabel",
        yField: "amountValue",
        aggregation: "sum",
        sortBy: "value",
        sortDirection: "desc",
        limit: 8,
      },
    },
    {
      key: "crm-report-activity-chart",
      layout: "builder-chart",
      type: "chart",
      col: 4,
      row: 1,
      cols: 3,
      rows: 3,
      data: "activityByDay",
      config: {
        title: "Activity Volume",
        chartType: "line",
        xField: "day",
        yField: "activityCount",
        aggregation: "sum",
        sortBy: "",
        sortDirection: "asc",
        limit: 30,
      },
    },
    {
      key: "crm-report-recent-records",
      layout: "builder-table",
      type: "table",
      col: 1,
      row: 1,
      cols: 6,
      rows: 4,
      data: "recentRecords",
      config: {
        title: "Recent CRM Records",
        columns: ["entity", "title", "state", "stageLabel", "amount", "updated"],
        sortBy: "updatedAt",
        sortDirection: "desc",
        limit: 50,
      },
    },
  ];

  let active = false;
  let subscribed = false;
  let refreshTimer = null;
  let widgetsReady = false;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const ensureStyles = () => {
    if (document.getElementById("crm-reports-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-reports-styles";
    style.textContent = `
      .crm-report-widget[hidden] { display: none !important; }
      .crm-report-widget .widget-tools { -webkit-app-region: no-drag; }
    `;
    document.head.appendChild(style);
  };

  const layoutFor = (key) => document.querySelector(`.widget-layout[data-widget-layout-key="${key}"]`);

  const runtimeReady = () => (
    window.dashboardWidgetRuntime &&
    window.dashboardWidgetDataRuntime &&
    REPORT_WIDGETS.every((spec) => layoutFor(spec.layout)?.__initWidget)
  );

  const waitForRuntime = async () => {
    for (let i = 0; i < 50; i += 1) {
      if (runtimeReady()) return true;
      await delay(80);
    }
    return false;
  };

  const widgetConfig = (spec, definition) => {
    const defaults = typeof definition?.getDefaultConfig === "function" ? definition.getDefaultConfig() : {};
    return { ...defaults, ...spec.config };
  };

  const makeWidget = (spec) => {
    const existing = document.querySelector(`.crm-report-widget[data-widget-key="${spec.key}"]`);
    if (existing) return existing;
    const definition = window.dashboardWidgetRuntime?.getWidgetDefinition?.(spec.type);
    const tagName = definition?.htmlTag || "div";
    const widget = document.createElement(tagName);
    widget.className = `${definition?.className || "stat-card widget-card widget-card-custom"} crm-report-widget`;
    if (tagName === "a") widget.href = window.location.pathname + window.location.search;
    else {
      widget.setAttribute("role", "group");
      widget.setAttribute("aria-label", spec.config.title || spec.key);
    }
    widget.dataset.widgetKey = spec.key;
    widget.dataset.widgetRuntimeType = definition?.type || spec.type;
    widget.dataset.widgetDefinition = definition?.type || spec.type;
    widget.dataset.widgetType = definition?.widgetType || spec.type;
    widget.dataset.dashboardObjectKind = definition?.dashboardObjectKind || spec.type;
    widget.dataset.regionRole = definition?.regionRole || "content";
    widget.dataset.workspaceObjectType = "widget";
    widget.dataset.widgetLayer = "presentation";
    widget.dataset.defaultSpan = String(spec.cols);
    widget.dataset.currentSpan = String(spec.cols);
    widget.dataset.gridRowSpan = String(spec.rows);
    widget.dataset.gridCol = String(spec.col);
    widget.dataset.gridRow = String(spec.row);
    widget.dataset.customWidget = "true";
    widget.dataset.crmReportWidget = "true";
    widget.dataset.widgetConfig = JSON.stringify(widgetConfig(spec, definition));
    widget.style.gridColumn = `${spec.col} / span ${spec.cols}`;
    widget.style.gridRow = `${spec.row} / span ${spec.rows}`;
    widget.hidden = !active;
    return widget;
  };

  const ensureWidgets = async () => {
    ensureStyles();
    if (!(await waitForRuntime())) return false;
    REPORT_WIDGETS.forEach((spec) => {
      const layout = layoutFor(spec.layout);
      if (!layout) return;
      const widget = makeWidget(spec);
      if (!widget.parentElement) layout.appendChild(widget);
      layout.__initWidget?.(widget);
    });
    widgetsReady = true;
    setVisibility(active);
    return true;
  };

  const setVisibility = (on) => {
    document.querySelectorAll(".crm-report-widget").forEach((widget) => {
      widget.hidden = !on;
    });
    document.body.dataset.crmReportsActive = on ? "true" : "false";
  };

  const blankSummary = () => ({
    generatedAt: new Date().toISOString(),
    connection: "offline",
    totals: {},
    datasets: {
      openTickets: [],
      openDeals: [],
      pipelineValueRows: [],
      winRateRows: [],
      contactsDue: [],
      openTasks: [],
      scheduledItems: [],
      pipelineByStage: [],
      activityByDay: [],
      recentRecords: [],
    },
  });

  const summaryPayload = async () => {
    try {
      const response = await window.crmReportsApi?.summary?.();
      if (response?.ok && response.summary) return response.summary;
    } catch {}
    return blankSummary();
  };

  const publish = async () => {
    if (!active) return;
    const missingWidget = REPORT_WIDGETS.some((spec) => !document.querySelector(`.crm-report-widget[data-widget-key="${spec.key}"]`));
    if ((!widgetsReady || missingWidget) && !(await ensureWidgets())) return;
    const summary = await summaryPayload();
    const datasets = summary.datasets || {};
    const widgets = {};
    REPORT_WIDGETS.forEach((spec) => {
      widgets[spec.key] = {
        rows: Array.isArray(datasets[spec.data]) ? datasets[spec.data] : [],
        meta: {
          generatedAt: summary.generatedAt,
          connection: summary.connection,
          totals: summary.totals || {},
        },
      };
    });
    window.dashboardWidgetDataRuntime?.ingest?.({ widgets });
  };

  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { publish(); }, 160);
  };

  const subscribe = () => {
    if (subscribed) return;
    subscribed = true;
    try { window.crmStore?.onChanged?.(scheduleRefresh); } catch {}
    try { window.tickets?.onChanged?.(scheduleRefresh); } catch {}
  };

  const setActive = (on) => {
    active = !!on;
    subscribe();
    setVisibility(active);
    if (active) {
      ensureWidgets().then(() => {
        if (active) publish();
      });
    }
    return api;
  };

  const api = {
    setActive,
    isActive: () => active,
    refresh: () => publish(),
  };

  window.crmReports = api;
})();
