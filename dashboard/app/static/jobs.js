// jobs.js — delivery work has its own lifecycle; it is not a disguised deal.
(() => {
  if (typeof window.createCrmCardSystem !== "function") return;
  const stages = [
    { key: "intake", label: "Intake" }, { key: "planned", label: "Planned" },
    { key: "active", label: "Active" }, { key: "review", label: "Review" },
  ];
  const stageFields = {
    intake: [{ key: "scope", label: "Scope", q: "What result are we responsible for?", area: true }, { key: "owner", label: "Owner", q: "Who owns delivery?" }],
    planned: [{ key: "startDate", label: "Start", date: true }, { key: "targetDate", label: "Target", date: true }, { key: "plan", label: "Plan", q: "What are the important moves?", area: true }],
    active: [{ key: "nextMilestone", label: "Next milestone", q: "What proves forward motion?", area: true }, { key: "risk", label: "Risk", q: "What can interrupt delivery?", area: true, req: false }],
    review: [{ key: "acceptance", label: "Acceptance", q: "What must be true to call this complete?", area: true }, { key: "outcome", label: "Outcome", q: "What was delivered?", area: true, req: false }],
  };
  const source = {
    list: () => window.crmStore.list("jobs", { includeDeleted: true }),
    get: (id) => window.crmStore.get("jobs", id),
    create: (fields) => window.crmStore.create("jobs", fields),
    update: (id, fields) => window.crmStore.update("jobs", id, fields),
    remove: (id) => window.crmStore.remove("jobs", id, { hard: true }),
    resolve: (id) => window.crmStore.update("jobs", id, { state: "complete", stage: "complete", completedAt: new Date().toISOString() }),
    onChanged: (cb) => window.crmStore.onChanged(async () => cb(await window.crmStore.list("jobs", { includeDeleted: true }))),
  };
  const detail = {
    open: (record) => window.crmRecordWorld?.open?.("jobs", record.id),
    close: () => window.crmRecordWorld?.close?.(),
    isOpen: () => window.crmRecordWorld?.isOpen?.(),
  };
  const face = {
    title: (record) => record.title || record.name || record.client,
    subtitle: (record) => record.description || record.scope,
    rows: [
      (record) => ({ label: "Owner", value: record.owner || record.assignee || "Unassigned" }),
      (record) => ({ label: "Target", value: record.targetDate || "Not set" }),
      (record) => record.nextMilestone ? ({ label: "Next", value: record.nextMilestone }) : "",
    ],
  };
  window.createCrmCardSystem({
    apiName: "jobPipeline", workflowKind: "progressive", theater: "jobs", active: false,
    widgetType: "job", widgetTitle: "Job",
    source, detail, face, stages, stageFields,
    createFields: [
      { key: "title", label: "Job", q: "What are we delivering?" },
      { key: "companyId", label: "Company", q: "Which company is this for?", req: false },
      { key: "description", label: "Brief", q: "What outcome was agreed?", area: true },
    ],
    createDraftFields: () => ({ title: "Untitled job", state: "intake", stage: "intake", priority: "medium" }),
    createStageLabel: "New job", recordsFromList: (result) => result?.records || [], recordFromCreate: (result) => result?.record,
    stageOf: (record) => ["complete", "completed", "cancelled"].includes(String(record.state || record.stage).toLowerCase()) ? false : (record.stage || "intake"),
    stageUpdateFields: (_id, stage) => ({ stage, state: stage }),
    isResolved: (record) => ["complete", "completed"].includes(String(record?.state || record?.stage).toLowerCase()),
    resolvedState: "complete", zoneGravity: true,
    severityRgb: { low: "90,150,220", medium: "112,145,192", high: "190,145,90", critical: "190,100,78", none: "120,130,140" },
    intensityValues: ["low", "medium", "high", "critical"], defaultIntensity: "medium",
    storageKeys: {
      order: (side) => `crm-job-order-${side}`, stage: "crm-job-stage", stageOrder: "crm-job-stage-order",
      deleted: "crm-job-deleted", meta: "crm-job-meta", color: "crm-job-color", colorLast: "crm-job-color-last",
    },
    deckCopy: { leftTitle: "Queued jobs", rightTitle: "Completed", createAria: "Create a job", createLabel: "New job", emptyLeft: "New jobs<br>land here", emptyRight: "Completed jobs<br>land here" },
  });
})();
