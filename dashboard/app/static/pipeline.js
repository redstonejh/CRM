// pipeline.js - deals instance of the CRM card system.
(() => {
  const temperatureRgb = {
    cold: "34,211,238",
    warm: "250,204,21",
    hot: "249,115,22",
    commit: "234,88,12",
    none: "120,130,140",
  };

  const stages = [
    { key: "lead", label: "Lead" },
    { key: "qualified", label: "Qualified" },
    { key: "proposal", label: "Proposal" },
    { key: "negotiation", label: "Negotiation" },
  ];

  const stageFields = {
    lead: [
      { key: "priority", label: "Temperature", q: "How warm is this opportunity?", prio: true },
      { key: "amount", label: "Value", q: "Estimated deal value" },
      { key: "owner", label: "Owner", q: "Who's driving it?" },
      { key: "nextTouchAt", label: "Next touch", date: true, req: false },
    ],
    qualified: [
      { key: "decisionMaker", label: "Decision maker", q: "Who can say yes?" },
      { key: "pain", label: "Need", q: "What problem are we solving?", area: true },
      { key: "budget", label: "Budget", q: "Budget / range / constraint" },
    ],
    proposal: [
      { key: "proposal", label: "Offer", q: "What did we propose?", area: true },
      { key: "closeDate", label: "Target close", date: true },
    ],
    negotiation: [
      { key: "nextStep", label: "Next step", q: "The next concrete move", area: true },
      { key: "risk", label: "Risk", q: "What could block the win?", area: true },
    ],
  };

  const createFields = [
    { key: "client", label: "Account", q: "Company or account name" },
    { key: "incidentDate", label: "Opened", date: true },
    { key: "description", label: "Opportunity", q: "What are they trying to buy?", area: true },
  ];

  const recordsFromList = (result) => (result && (result.records || result.tickets)) || [];
  const recordFromCreate = (result) => result && (result.record || result.ticket);
  const valueOf = (record, key) => window.crmNextTouch?.valueOf?.(record, key) ?? record?.[key];
  const isClosedDeal = (deal) => ["won", "lost"].includes(String(valueOf(deal, "state") || valueOf(deal, "stage") || "open").toLowerCase());
  const amountOf = (deal) => {
    const raw = valueOf(deal, "amount") ?? valueOf(deal, "value") ?? valueOf(deal, "budget") ?? "";
    const amount = Number(String(raw).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(amount) ? amount : 0;
  };
  const money = (amount) => amount ? `$${Math.round(amount).toLocaleString()}` : "$0";
  const bucketSummary = (_stage, deals) => {
    const total = deals.reduce((sum, deal) => sum + amountOf(deal), 0);
    return `${money(total)} / ${deals.length}`;
  };

  const dealSource = {
    list: () => window.deals?.list?.({ includeDeleted: true }),
    onChanged: (cb) => window.deals?.onChanged?.((payload) => cb(payload)),
    create: (fields) => window.deals?.create?.(fields),
    update: (id, fields) => window.deals?.update?.(id, fields),
    remove: (id) => window.deals?.remove?.(id, { hard: true }),
    resolve: (id) => window.deals?.update?.(id, { state: "won", wonAt: new Date().toISOString() }),
  };

  const linkIds = (record, id) => {
    const ids = Array.isArray(record.relatedDealIds) ? record.relatedDealIds : [];
    return ids.includes(id) ? ids : [...ids, id];
  };

  const linkDeals = (from, to) => {
    if (!from?.id || !to?.id || from.id === to.id) return;
    const fromIds = linkIds(from, to.id);
    const toIds = linkIds(to, from.id);
    from.relatedDealIds = fromIds;
    to.relatedDealIds = toIds;
    dealSource.update(from.id, { relatedDealIds: fromIds });
    dealSource.update(to.id, { relatedDealIds: toIds });
  };

  if (typeof window.createCrmCardDetail !== "function" || typeof window.createCrmCardSystem !== "function") {
    console.error("[CRM] card factories are not loaded");
    return;
  }

  window.createCrmCardDetail({
    apiName: "dealDetail",
    source: dealSource,
    stacks: () => window.dealPipeline,
    priorities: ["cold", "warm", "hot", "commit"],
    intensityValues: ["cold", "warm", "hot", "commit"],
    defaultIntensity: "warm",
    severityRgb: temperatureRgb,
    notFoundText: "Deal not found.",
    draftRequiredText: "An account, opened date and opportunity are required to create the deal.",
    nextTouch: {
      label: "next touch",
      shouldPrompt: (deal) => window.crmNextTouch?.shouldPrompt?.(deal, { entity: "deals", isClosed: isClosedDeal }),
      schedule: (deal, date, mode) => window.crmNextTouch?.schedule?.({ entity: "deals", bridge: window.deals, record: deal, date, mode }),
      letGo: (deal) => window.crmNextTouch?.letGo?.({ entity: "deals", bridge: window.deals, record: deal }),
    },
  });

  const dateOnly = (value) => {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ""));
    if (match) return match[1];
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
  };
  const daysSince = (value) => {
    const ms = typeof value === "number" ? value : Date.parse(String(value || ""));
    if (!Number.isFinite(ms)) return null;
    return Math.max(0, Math.floor((Date.now() - ms) / 86400000));
  };
  // Deal face: $value / company / next-touch · touch-age.
  const dealFace = {
    title: (r) => r.title ?? r.name ?? r.client,
    subtitle: (r) => r.description,
    rows: [
      (r) => ({ label: "Value", value: money(amountOf(r)) }),
      (r) => ({ label: "Account", value: valueOf(r, "client") || valueOf(r, "company") || "" }),
      (r) => {
        const next = dateOnly(valueOf(r, "nextTouchAt"));
        const age = daysSince(valueOf(r, "lastTouchAt") || r.updatedAt);
        const parts = [next ? `Next touch ${next}` : "", age != null ? `${age}d since touch` : ""].filter(Boolean);
        return parts.join(" · ");
      },
    ],
  };

  window.createCrmCardSystem({
    apiName: "dealPipeline",
    theater: "pipeline",
    face: dealFace,
    source: dealSource,
    detail: window.dealDetail,
    widgetType: "deal",
    widgetTitle: "Deal",
    widgetCardClass: "ticket-widget-card",
    pinPrefix: "deal-pin-",
    storageKeys: {
      order: (side) => `crm-deal-order-${side}`,
      stage: "crm-deal-stage",
      stageOrder: "crm-deal-stage-order",
      deleted: "crm-deal-deleted",
      meta: "crm-deal-meta",
      color: "crm-deal-color",
      colorLast: "crm-deal-color-last",
    },
    stages,
    stageFields,
    createFields,
    createStageLabel: "New deal",
    createDraftFields: () => ({
      companyLabel: "Untitled deal",
      host: "",
      state: "open",
      priority: "warm",
    }),
    recordsFromList,
    recordFromCreate,
    severityRgb: temperatureRgb,
    intensityValues: ["cold", "warm", "hot", "commit"],
    defaultIntensity: "warm",
    stalenessOf: (deal) => window.crmColdFront?.staleness?.(deal, "deals") || 0,
    resolvedState: "won",
    isResolved: (deal) => !!deal && (deal.state || "open") === "won",
    bucketSummary,
    resolvedPulse: true,
    onLinkDrop: linkDeals,
    active: false,
  });
})();
