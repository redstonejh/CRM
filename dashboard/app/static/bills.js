// bills.js — outgoing vendor obligations, separate from customer invoices.
(() => {
  if (typeof window.createCrmCardDetail !== "function" || typeof window.createCrmCardSystem !== "function") {
    console.error("[CRM] card factories are not loaded");
    return;
  }

  const billRgb = {
    upcoming: "112,145,192",
    due: "232,171,77",
    overdue: "239,68,68",
    paid: "34,197,94",
    none: "120,130,140",
  };
  const stages = [
    { key: "upcoming", label: "Upcoming" },
    { key: "due", label: "Due soon" },
    { key: "overdue", label: "Overdue" },
  ];
  const stageFields = {
    upcoming: [
      { key: "reference", label: "Reference", q: "Bill or account reference" },
      { key: "amount", label: "Amount", q: "Amount owed" },
      { key: "category", label: "Category", q: "Utilities, software, rent…", req: false },
    ],
    due: [
      { key: "dueDate", label: "Due date", date: true },
      { key: "paymentMethod", label: "Payment method", q: "ACH, card, check…", req: false },
      { key: "owner", label: "Owner", q: "Who is responsible?", req: false },
    ],
    overdue: [
      { key: "nextStep", label: "Next step", q: "What must happen now?", area: true },
      { key: "lateNote", label: "Late note", q: "Fees or vendor conversation", area: true, req: false },
    ],
  };
  const createFields = [
    { key: "vendor", label: "Vendor", q: "Who needs to be paid?" },
    { key: "amount", label: "Amount", q: "Amount owed" },
    { key: "dueDate", label: "Due date", date: true },
    { key: "description", label: "Memo", q: "What is this bill for?", area: true },
  ];

  const recordsFromList = (result) => result?.records || [];
  const recordFromCreate = (result) => result?.record;
  const metaOf = (record) => record?.meta && typeof record.meta === "object" ? record.meta : {};
  const valueOf = (record, key) => record?.[key] != null && record[key] !== "" ? record[key] : metaOf(record)[key];
  const dateOnly = (value) => {
    const text = String(value ?? "").trim();
    const direct = /^(\d{4}-\d{2}-\d{2})/.exec(text);
    if (direct) return direct[1];
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
  };
  const today = () => {
    const now = window.__CRM_NOW__ ? new Date(window.__CRM_NOW__) : new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  };
  const billState = (bill) => String(valueOf(bill, "state") || valueOf(bill, "stage") || "upcoming").toLowerCase();
  const dueDistance = (bill) => {
    const due = dateOnly(valueOf(bill, "dueDate"));
    return due ? Math.round((Date.parse(`${due}T00:00:00`) - Date.parse(`${today()}T00:00:00`)) / 86400000) : Number.POSITIVE_INFINITY;
  };
  const billIntensity = (bill) => {
    if (!bill) return "none";
    const state = billState(bill);
    if (state === "paid") return "paid";
    const days = dueDistance(bill);
    if (state === "overdue" || days < 0) return "overdue";
    if (state === "due" || days <= 7) return "due";
    return "upcoming";
  };
  const amountOf = (bill) => {
    const amount = Number(String(valueOf(bill, "amount") ?? "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(amount) ? amount : 0;
  };
  const money = (amount) => `$${Math.round(amount || 0).toLocaleString()}`;
  const humanDue = (bill) => {
    const days = dueDistance(bill);
    if (!Number.isFinite(days)) return "Not scheduled";
    if (days < -1) return `${Math.abs(days)}d overdue`;
    if (days === -1) return "Yesterday";
    if (days === 0) return "Today";
    if (days === 1) return "Tomorrow";
    if (days < 14) return `${days} days`;
    return new Date(`${dateOnly(valueOf(bill, "dueDate"))}T00:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });
  };

  const source = {
    list: () => window.bills?.list?.({ includeDeleted: true }),
    onChanged: (cb) => window.bills?.onChanged?.(cb),
    create: (fields) => window.bills?.create?.(fields),
    update: (id, fields) => window.bills?.update?.(id, fields),
    remove: (id) => window.bills?.remove?.(id, { hard: true }),
    resolve: (id) => window.bills?.update?.(id, { state: "paid", stage: "paid", priority: "paid", paidAt: new Date().toISOString() }),
  };

  window.createCrmCardDetail({
    apiName: "billDetail",
    source,
    stacks: () => window.billPipeline,
    priorities: ["upcoming", "due", "overdue", "paid"],
    intensityValues: ["upcoming", "due", "overdue", "paid"],
    defaultIntensity: "upcoming",
    severityRgb: billRgb,
    notFoundText: "Bill not found.",
    draftRequiredText: "A vendor, amount, due date and memo are required to create the bill.",
  });

  window.createCrmCardSystem({
    apiName: "billPipeline",
    workflowKind: "lifecycle",
    theater: "bills",
    active: false,
    source,
    detail: window.billDetail,
    widgetType: "bill",
    widgetTitle: "Bill",
    widgetCardClass: "ticket-widget-card",
    pinPrefix: "bill-pin-",
    face: {
      title: (bill) => valueOf(bill, "vendor") || valueOf(bill, "title") || valueOf(bill, "reference") || "Bill",
      subtitle: (bill) => valueOf(bill, "description"),
      rows: [
        (bill) => money(amountOf(bill)),
        (bill) => ({ label: "Due", value: humanDue(bill) }),
        (bill) => valueOf(bill, "category") ? ({ label: "Type", value: valueOf(bill, "category") }) : "",
      ],
    },
    stages,
    zoneGap: 22,
    stageFields,
    createFields,
    createStageLabel: "New bill",
    createDraftFields: () => ({ vendor: "New bill", state: "upcoming", stage: "upcoming", priority: "upcoming" }),
    recordsFromList,
    recordFromCreate,
    severityRgb: billRgb,
    intensityValues: ["upcoming", "due", "overdue", "paid"],
    defaultIntensity: "upcoming",
    intensityOf: billIntensity,
    resolvedState: "paid",
    isResolved: (bill) => billState(bill) === "paid",
    canResolve: (bill) => billState(bill) !== "paid",
    stageOf: (bill) => billState(bill) === "paid" ? false : billIntensity(bill),
    stageMovement: "free",
    stageUpdateFields: (_id, stage) => stage ? { state: stage, stage, priority: stage } : {},
    zoneGravity: true,
    bucketSummary: (_stage, bills) => `${money(bills.reduce((sum, bill) => sum + amountOf(bill), 0))} · ${bills.length} ${bills.length === 1 ? "bill" : "bills"}`,
    storageKeys: {
      order: (side) => `crm-bill-order-${side}`,
      stage: "crm-bill-stage",
      stageOrder: "crm-bill-stage-order",
      deleted: "crm-bill-deleted",
      meta: "crm-bill-meta",
      color: "crm-bill-color",
      colorLast: "crm-bill-color-last",
    },
    deckCopy: {
      leftFanAria: "Fan out active bills",
      rightFanAria: "Fan out paid bills",
      leftTitle: "Active bills",
      rightTitle: "Paid bills",
      createAria: "Create a bill",
      createLabel: "New bill",
      trashAria: "Recycle bin (deleted bills)",
    },
  });
})();
