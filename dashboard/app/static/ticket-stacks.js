// ticket-stacks.js — ticket instance of the reusable CRM card system.
(() => {
  const severityRgb = {
    low: "34,211,238",
    medium: "250,204,21",
    high: "249,115,22",
    critical: "234,88,12",
    none: "120,130,140",
  };

  const stages = [
    { key: "triage", label: "Triage" },
    { key: "investigation", label: "Investigation" },
    { key: "resolution", label: "Resolution" },
  ];

  const stageFields = {
    triage: [
      { key: "priority", label: "Severity", q: "How severe is it?", prio: true },
      { key: "assignee", label: "Assignee", q: "Who's handling it?" },
    ],
    investigation: [
      { key: "investigation", label: "Cause", q: "What caused the issue?", area: true },
      { key: "fix", label: "Fix", q: "What's the fix?", area: true },
    ],
    resolution: [
      {
        key: "resolution",
        label: "Proof",
        q: "How do you know it's resolved? (you confirmed it / it auto-resolved / a client confirmed...)",
        area: true,
        big: true,
      },
      { key: "resolutionDate", label: "Date resolved", date: true },
      { key: "duration", label: "Time taken", q: "e.g. 15 minutes, 2 hours, 1 week - a day is 8 working hours" },
      { key: "overtime", label: "Overtime", q: "any extra hours beyond 8/day? (or none)" },
    ],
  };

  const createFields = [
    { key: "client", label: "Client", q: "Client name" },
    { key: "incidentDate", label: "Date of incident", date: true },
    { key: "description", label: "Description", q: "What's the issue?", area: true },
  ];

  if (typeof window.createCrmCardSystem !== "function") {
    console.error("[CRM] card-system factory is not loaded");
    return;
  }

  window.createCrmCardSystem({
    apiName: "ticketStacks",
    workflowKind: "progressive",
    theater: "tickets",
    source: window.tickets,
    detail: window.ticketDetail,
    widgetType: "ticket",
    widgetTitle: "Case",
    widgetCardClass: "ticket-widget-card",
    pinPrefix: "ticket-pin-",
    storageKeys: {
      order: (side) => `tk-stack-order-${side}`,
      stage: "tk-ticket-stage",
      stageOrder: "tk-stage-order",
      deleted: "tk-deleted",
      meta: "tk-ticket-meta",
      color: "tk-ticket-color",
      colorLast: "tk-ticket-color-last",
    },
    stages,
    stageFields,
    createFields,
    severityRgb,
    resolvedState: "resolved",
    deckCopy: { leftTitle: "New cases", rightTitle: "Closed", createAria: "Create a case", createLabel: "New case", emptyLeft: "New cases<br>land here", emptyRight: "Closed cases<br>land here" },
  });
})();
