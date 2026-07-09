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
      { key: "nextTouchAt", label: "Next touch", date: true, req: false },
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
  const shouldPromptInvoice = async (invoice) => ["sent", "overdue"].includes(invoiceState(invoice))
    && !!(await window.crmNextTouch?.shouldPrompt?.(invoice, {
      entity: "invoices",
      isClosed: (record) => ["paid", "void", "cancelled", "canceled"].includes(invoiceState(record)),
    }));
  const invoiceIntensity = (invoice) => {
    if (!invoice) return "none";
    const state = invoiceState(invoice);
    if (state === "paid") return "paid";
    if (state === "overdue" || (state === "sent" && isPastDue(invoice))) return "overdue";
    if (state === "sent") return "sent";
    return "draft";
  };
  const amountOf = (invoice) => {
    const raw = valueOf(invoice, "amount") ?? valueOf(invoice, "value") ?? "";
    const amount = Number(String(raw).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(amount) ? amount : 0;
  };
  const money = (amount) => amount ? `$${Math.round(amount).toLocaleString()}` : "$0";
  const bucketSummary = (_stage, invoices) => {
    const total = invoices.reduce((sum, invoice) => sum + amountOf(invoice), 0);
    return `${money(total)} · ${invoices.length} ${invoices.length === 1 ? "invoice" : "invoices"}`;
  };
  const humanDate = (value) => {
    const iso = dateOnly(value);
    if (!iso) return "";
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const date = new Date(`${iso}T00:00:00`);
    const days = Math.round((date - today) / 86400000);
    if (days === 0) return "today";
    if (days > 0 && days < 14) return `${days}d`;
    if (days === -1) return "yesterday";
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
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
    nextTouch: {
      label: "next touch",
      shouldPrompt: shouldPromptInvoice,
      schedule: (invoice, date, mode) => window.crmNextTouch?.schedule?.({ entity: "invoices", bridge: window.invoices, record: invoice, date, mode }),
      letGo: (invoice) => window.crmNextTouch?.letGo?.({ entity: "invoices", bridge: window.invoices, record: invoice }),
    },
  });

  // Invoice face: amount (dominant) / due line / state.
  const invoiceFace = {
    title: (r) => r.number ?? r.title ?? r.client,
    subtitle: (r) => r.description,
    rows: [
      (r) => money(amountOf(r)),
      (r) => {
        const due = dateOnly(valueOf(r, "dueDate"));
        if (!due) return "";
        if (invoiceIntensity(r) === "overdue") {
          const days = Math.max(1, Math.floor((Date.now() - Date.parse(`${due}T00:00:00`)) / 86400000));
          return { label: "Due", value: `${humanDate(due)} · ${days}d overdue` };
        }
        return { label: "Due", value: humanDate(due) };
      },
    ],
  };

  // FIX_PASS_2 F5: the bucket follows the invoice's DERIVED state — a sent
  // invoice past its due date is Overdue without a drag; paid → the pile.
  const invoiceBucket = (invoice) => {
    const state = invoiceIntensity(invoice);
    if (state === "paid") return false;
    return ["draft", "sent", "overdue"].includes(state) ? state : null;
  };

  window.createCrmCardSystem({
    apiName: "moneyPipeline",
    workflowKind: "lifecycle",
    theater: "money",
    stageOf: invoiceBucket,
    face: invoiceFace,
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
    zoneGravity: true,   // BLUEPRINT A2: invoices rest on the bucket floor
    isResolved: (invoice) => !!invoice && invoiceState(invoice) === "paid",
    canResolve: (invoice) => !!invoice && invoiceState(invoice) !== "paid",
    bucketSummary,
    stageMovement: "free",
    stageUpdateFields: (_id, stage) => {
      if (!stage) return {};
      return { state: stage, priority: stage };
    },
    deckCopy: {
      leftFanAria: "Fan out active invoices",
      rightFanAria: "Fan out paid invoices",
      leftTitle: "Active invoices",
      rightTitle: "Paid",
      createAria: "Create an invoice",
      trashAria: "Recycle bin (deleted invoices)",
    },
    onLinkDrop: linkInvoices,
    active: false,
  });
})();
