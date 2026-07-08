// money.js - invoices instance of the CRM card system.
(() => {
  const moneyRgb = {
    draft: "120,130,140",
    sent: "34,211,238",
    overdue: "239,68,68",
    paid: "34,197,94",
    none: "120,130,140",
  };

  const stages = [
    { key: "draft", label: "Draft" },
    { key: "sent", label: "Sent" },
    { key: "overdue", label: "Overdue" },
  ];

  const stageFields = {
    draft: [
      { key: "number", label: "Number", q: "Invoice number or reference" },
      { key: "amount", label: "Amount", q: "Invoice total" },
      { key: "companyId", label: "Company", q: "Company or account id", req: false },
      { key: "dealId", label: "Deal", q: "Related deal id", req: false },
    ],
    sent: [
      { key: "dueDate", label: "Due date", date: true },
      { key: "sentAt", label: "Sent", date: true, req: false },
      { key: "deliveryNote", label: "Delivery", q: "How was it sent?", area: true, req: false },
    ],
    overdue: [
      { key: "nextStep", label: "Next step", q: "What happens next?", area: true },
      { key: "collectionNote", label: "Collection note", q: "Last payment conversation", area: true, req: false },
    ],
  };

  const createFields = [
    { key: "client", label: "Invoice", q: "Invoice label or number" },
    { key: "dueDate", label: "Due date", date: true },
    { key: "description", label: "Memo", q: "What is this invoice for?", area: true },
  ];

  const recordsFromList = (result) => (result && (result.records || result.tickets)) || [];
  const recordFromCreate = (result) => result && (result.record || result.ticket);

  const metaOf = (record) => (record && record.meta && typeof record.meta === "object" ? record.meta : {});
  const valueOf = (record, key) => (record && record[key] != null && record[key] !== "" ? record[key] : metaOf(record)[key]);
  const dateOnly = (value) => {
    const text = String(value ?? "").trim();
    const direct = /^(\d{4}-\d{2}-\d{2})/.exec(text);
    if (direct) return direct[1];
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
  };
  const isPastDue = (invoice) => {
    const due = dateOnly(valueOf(invoice, "dueDate"));
    if (!due) return false;
    return due < new Date().toISOString().slice(0, 10);
  };
  const invoiceState = (invoice) => String(valueOf(invoice, "state") || valueOf(invoice, "stage") || "draft").toLowerCase();
  const invoiceIntensity = (invoice) => {
    if (!invoice) return "none";
    const state = invoiceState(invoice);
    if (state === "paid") return "paid";
    if (state === "overdue" || (state === "sent" && isPastDue(invoice))) return "overdue";
    if (state === "sent") return "sent";
    return "draft";
  };

  const invoiceSource = {
    list: () => window.invoices?.list?.({ includeDeleted: true }),
    onChanged: (cb) => window.invoices?.onChanged?.((payload) => cb(payload)),
    create: (fields) => window.invoices?.create?.(fields),
    update: (id, fields) => window.invoices?.update?.(id, fields),
    remove: (id) => window.invoices?.remove?.(id, { hard: true }),
    resolve: (id) => window.invoices?.update?.(id, {
      state: "paid",
      priority: "paid",
      paidAt: new Date().toISOString(),
    }),
  };

  const linkIds = (record, id) => {
    const ids = Array.isArray(record.relatedInvoiceIds) ? record.relatedInvoiceIds : [];
    return ids.includes(id) ? ids : [...ids, id];
  };

  const linkInvoices = (from, to) => {
    if (!from?.id || !to?.id || from.id === to.id) return;
    const fromIds = linkIds(from, to.id);
    const toIds = linkIds(to, from.id);
    from.relatedInvoiceIds = fromIds;
    to.relatedInvoiceIds = toIds;
    invoiceSource.update(from.id, { relatedInvoiceIds: fromIds });
    invoiceSource.update(to.id, { relatedInvoiceIds: toIds });
  };

  if (typeof window.createCrmCardDetail !== "function" || typeof window.createCrmCardSystem !== "function") {
    console.error("[CRM] card factories are not loaded");
    return;
  }

  window.createCrmCardDetail({
    apiName: "invoiceDetail",
    source: invoiceSource,
    stacks: () => window.moneyPipeline,
    priorities: ["draft", "sent", "overdue", "paid"],
    intensityValues: ["draft", "sent", "overdue", "paid"],
    defaultIntensity: "draft",
    severityRgb: moneyRgb,
    notFoundText: "Invoice not found.",
    draftRequiredText: "An invoice label, due date and memo are required to create the invoice.",
  });

  window.createCrmCardSystem({
    apiName: "moneyPipeline",
    source: invoiceSource,
    detail: window.invoiceDetail,
    widgetType: "invoice",
    widgetTitle: "Invoice",
    widgetCardClass: "ticket-widget-card",
    pinPrefix: "invoice-pin-",
    storageKeys: {
      order: (side) => `crm-invoice-order-${side}`,
      stage: "crm-invoice-stage",
      stageOrder: "crm-invoice-stage-order",
      deleted: "crm-invoice-deleted",
      meta: "crm-invoice-meta",
      color: "crm-invoice-color",
      colorLast: "crm-invoice-color-last",
    },
    stages,
    stageFields,
    createFields,
    createStageLabel: "New invoice",
    createDraftFields: () => ({
      companyLabel: "New invoice",
      host: "",
      state: "draft",
      priority: "draft",
    }),
    recordsFromList,
    recordFromCreate,
    severityRgb: moneyRgb,
    intensityValues: ["draft", "sent", "overdue", "paid"],
    defaultIntensity: "draft",
    intensityOf: invoiceIntensity,
    resolvedState: "paid",
    isResolved: (invoice) => !!invoice && invoiceState(invoice) === "paid",
    canResolve: (invoice) => !!invoice && invoiceState(invoice) !== "paid",
    stageMovement: "free",
    stageUpdateFields: (_id, stage) => {
      if (!stage) return {};
      return { state: stage, priority: stage };
    },
    deckCopy: {
      leftFanAria: "Fan out active invoices",
      rightFanAria: "Fan out paid invoices",
      createAria: "Create an invoice",
      trashAria: "Recycle bin (deleted invoices)",
      leftEmptyHtml: "Draft invoices<br>get added here",
      rightEmptyHtml: "Paid invoices<br>get added here",
      trashEmptyHtml: "Deleted invoices<br>get added here",
      zoneEmptyText: "Drag invoices here",
    },
    onLinkDrop: linkInvoices,
    active: false,
  });
})();
