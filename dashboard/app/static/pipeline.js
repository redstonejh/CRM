// pipeline.js - deals instance of the CRM card system.
(() => {
  const temperatureRgb = {
    cold: "34,211,238",
    warm: "250,204,21",
    hot: "249,115,22",
    commit: "239,68,68",
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

  window.createCrmCardSystem({
    apiName: "dealPipeline",
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
    onLinkDrop: linkDeals,
    active: false,
  });
})();
