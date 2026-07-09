// people.js - contacts instance of the CRM card system.
(() => {
  const neutralCardBg = "linear-gradient(180deg, rgba(83, 95, 117, 0.42), rgba(33, 41, 56, 0.34))";
  const neutralRgb = {
    none: "120,130,140",
    current: "120,130,140",
  };

  const stages = [
    { key: "customers", label: "Customers" },
    { key: "prospects", label: "Prospects" },
    { key: "partners", label: "Partners" },
    { key: "vendors", label: "Vendors" },
  ];

  const companyFields = [
    { key: "company", label: "Company", q: "Company or account" },
    { key: "role", label: "Role", q: "Role or buying influence" },
    { key: "lastContactAt", label: "Last touch", date: true, req: false },
    { key: "nextTouchAt", label: "Next touch", date: true, req: false },
    { key: "nextStep", label: "Next step", q: "What should happen next?", area: true, req: false },
  ];

  const stageFields = Object.fromEntries(stages.map((stage) => [stage.key, companyFields]));

  const createFields = [
    { key: "client", label: "Name", q: "Contact name" },
    { key: "incidentDate", label: "Added", date: true },
    { key: "description", label: "Context", q: "Why is this person in the CRM?", area: true },
  ];

  const recordsFromList = (result) => (result && (result.records || result.tickets)) || [];
  const recordFromCreate = (result) => result && (result.record || result.ticket);
  const valueOf = (record, key) => window.crmNextTouch?.valueOf?.(record, key) ?? record?.[key];
  const isClosedContact = (contact) => ["archived", "deleted"].includes(String(valueOf(contact, "state") || valueOf(contact, "status") || "open").toLowerCase());

  const contactSource = {
    list: () => window.contacts?.list?.({ includeDeleted: true }),
    onChanged: (cb) => window.contacts?.onChanged?.((payload) => cb(payload)),
    create: (fields) => window.contacts?.create?.(fields),
    update: (id, fields) => window.contacts?.update?.(id, fields),
    remove: (id) => window.contacts?.remove?.(id, { hard: true }),
    resolve: (id) => window.contacts?.update?.(id, { state: "archived", archivedAt: new Date().toISOString() }),
  };

  const touchDate = (contact) => {
    const meta = contact?.meta || {};
    const value = meta.lastTouchAt || contact?.lastTouchAt || meta.lastContactAt || contact?.lastContactAt || contact?.updatedAt || contact?.createdAt;
    const ms = typeof value === "number" ? value : Date.parse(value || "");
    return Number.isFinite(ms) ? ms : 0;
  };

  const needsAttention = (contact) => {
    const last = touchDate(contact);
    if (!last) return true;
    return Date.now() - last > 1000 * 60 * 60 * 24 * 30;
  };

  const linkIds = (record, id, field) => {
    const ids = Array.isArray(record[field]) ? record[field] : [];
    return ids.includes(id) ? ids : [...ids, id];
  };

  const linkContacts = (from, to) => {
    if (!from?.id || !to?.id || from.id === to.id) return;
    const fromIds = linkIds(from, to.id, "relatedContactIds");
    const toIds = linkIds(to, from.id, "relatedContactIds");
    from.relatedContactIds = fromIds;
    to.relatedContactIds = toIds;
    contactSource.update(from.id, { relatedContactIds: fromIds });
    contactSource.update(to.id, { relatedContactIds: toIds });
  };

  if (typeof window.createCrmCardDetail !== "function" || typeof window.createCrmCardSystem !== "function") {
    console.error("[CRM] card factories are not loaded");
    return;
  }

  window.createCrmCardDetail({
    apiName: "contactDetail",
    source: contactSource,
    stacks: () => window.peopleCards,
    priorities: [],
    intensityValues: ["none"],
    defaultIntensity: "none",
    severityRgb: neutralRgb,
    notFoundText: "Contact not found.",
    draftRequiredText: "A name, added date and context are required to create the contact.",
    nextTouch: {
      label: "next touch",
      shouldPrompt: (contact) => window.crmNextTouch?.shouldPrompt?.(contact, { entity: "contacts", isClosed: isClosedContact }),
      schedule: (contact, date, mode) => window.crmNextTouch?.schedule?.({ entity: "contacts", bridge: window.contacts, record: contact, date, mode }),
      letGo: (contact) => window.crmNextTouch?.letGo?.({ entity: "contacts", bridge: window.contacts, record: contact }),
    },
  });

  window.createCrmCardSystem({
    apiName: "peopleCards",
    theater: "people",
    source: contactSource,
    detail: window.contactDetail,
    widgetType: "contact",
    widgetTitle: "Contact",
    widgetCardClass: "ticket-widget-card contact-widget-card",
    pinPrefix: "contact-pin-",
    storageKeys: {
      order: (side) => `crm-contact-order-${side}`,
      stage: "crm-contact-stage",
      stageOrder: "crm-contact-stage-order",
      deleted: "crm-contact-deleted",
      meta: "crm-contact-meta",
      color: "crm-contact-color",
      colorLast: "crm-contact-color-last",
    },
    stages,
    stageFields,
    createFields,
    createStageLabel: "New contact",
    createDraftFields: () => ({
      companyLabel: "New contact",
      host: "",
      state: "open",
      priority: "none",
    }),
    recordsFromList,
    recordFromCreate,
    severityRgb: neutralRgb,
    intensityValues: ["none"],
    defaultIntensity: "none",
    intensityOf: () => "none",
    stalenessOf: (contact) => window.crmColdFront?.staleness?.(contact, "contacts") || 0,
    attentionDeckFilter: (contact) => window.crmColdFront?.isTripped?.(contact, "contacts"),
    cardBackground: () => neutralCardBg,
    rightDeckEnabled: false,
    showProgressBars: false,
    showDateUnder: false,
    showFlow: false,
    stageMovement: "free",
    leftDeckFilter: () => true,
    deckCopy: {
      leftFanAria: "Fan out contacts needing attention",
      createAria: "Create a contact",
      trashAria: "Recycle bin (deleted contacts)",
      trashTitle: "Recycle bin",
      leftEmptyHtml: "Contacts needing<br>attention show here",
      trashEmptyHtml: "Deleted contacts<br>get added here",
      zoneEmptyText: "Drag contacts here",
    },
    onLinkDrop: linkContacts,
    active: false,
  });

  window.peopleCards.needsAttention = needsAttention;
})();
