// people.js - contacts instance of the CRM card system.
(() => {
  const neutralRgb = {
    none: "120,130,140",
    current: "120,130,140",
  };

  const companyFields = [
    { key: "company", label: "Company", q: "Company or account" },
    { key: "role", label: "Role", q: "Role or buying influence" },
    { key: "lastContactAt", label: "Last touch", date: true, req: false },
    { key: "nextTouchAt", label: "Next touch", date: true, req: false },
    { key: "nextStep", label: "Next step", q: "What should happen next?", area: true, req: false },
  ];

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

  const listRecords = (result) => Array.isArray(result) ? result : ((result && (result.records || result.tickets)) || []);
  const initialize = async () => {
    if (typeof window.createCrmCardDetail !== "function" || typeof window.createCrmCardSystem !== "function") {
      console.error("[CRM] card factories are not loaded");
      return;
    }

    // Census A2: company records, not relationship taxonomy, define the
    // furniture. Contacts may still carry kind/stage as data, but it never
    // determines which bucket exists or where a person is seated.
    const [companyResult, contactResult, dealResult] = await Promise.all([
      window.companies?.list?.({ includeDeleted: false }).catch?.(() => []),
      contactSource.list().catch?.(() => []),
      window.deals?.list?.({ includeDeleted: false }).catch?.(() => []),
    ]);
    const companies = listRecords(companyResult).filter((company) => company && !company.deletedAt);
    const initialContacts = listRecords(contactResult).filter((contact) => contact && !contact.deletedAt);
    const companyByName = new Map(companies.map((company) => [String(company.name || company.title || "").trim().toLowerCase(), company]));
    const missingCompany = initialContacts.some((contact) => {
      const id = String(valueOf(contact, "companyId") || "");
      const name = String(valueOf(contact, "company") || "").trim().toLowerCase();
      return !companies.some((company) => String(company.id) === id) && !companyByName.has(name);
    });
    const stages = companies.map((company) => ({
      key: String(company.id),
      label: String(company.name || company.title || "Company"),
    }));
    if (missingCompany || !stages.length) stages.push({ key: "unassigned-company", label: "Unassigned company" });
    const stageFields = Object.fromEntries(stages.map((stage) => [stage.key, companyFields]));
    const stageKeys = new Set(stages.map((stage) => stage.key));
    const companyStage = (contact) => {
      const id = String(valueOf(contact, "companyId") || "");
      if (stageKeys.has(id)) return id;
      const company = companyByName.get(String(valueOf(contact, "company") || "").trim().toLowerCase());
      return company ? String(company.id) : "unassigned-company";
    };
    const openDealValue = new Map();
    const recalculateDealValues = (records) => {
      openDealValue.clear();
      listRecords(records).forEach((deal) => {
        if (!deal || deal.deletedAt || ["won", "lost"].includes(String(valueOf(deal, "state") || "").toLowerCase())) return;
        const companyId = String(valueOf(deal, "companyId") || "unassigned-company");
        const raw = valueOf(deal, "amount") ?? valueOf(deal, "value") ?? 0;
        const amount = Number(String(raw).replace(/[^0-9.-]/g, "")) || 0;
        openDealValue.set(companyId, (openDealValue.get(companyId) || 0) + amount);
      });
    };
    recalculateDealValues(dealResult);
    const money = (amount) => `$${Math.round(amount || 0).toLocaleString()}`;

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

  const dateOnly = (value) => {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ""));
    if (match) return match[1];
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
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
  const daysSince = (value) => {
    const ms = typeof value === "number" ? value : Date.parse(String(value || ""));
    if (!Number.isFinite(ms)) return null;
    return Math.max(0, Math.floor((Date.now() - ms) / 86400000));
  };
  // Contact face: company · role / last touch / next touch.
  const contactFace = {
    title: (r) => r.name ?? r.title ?? r.client,
    subtitle: (r) => r.description,
    rows: [
      (r) => [valueOf(r, "company"), valueOf(r, "role")].filter(Boolean).join(" · "),
      (r) => {
        const age = daysSince(valueOf(r, "lastTouchAt") || valueOf(r, "lastContactAt"));
        return age == null ? "" : { label: "Last touch", value: `${age}d ago` };
      },
      (r) => {
        const next = humanDate(valueOf(r, "nextTouchAt"));
        return next ? { label: "Next touch", value: next } : "";
      },
    ],
  };

  window.createCrmCardSystem({
    apiName: "peopleCards",
    workflowKind: "grouped",
    showFlow: false,
    theater: "people",
    stageOf: companyStage,
    face: contactFace,
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
    rightDeckEnabled: false,
    showProgressBars: false,
    showDateUnder: false,
    stageMovement: "free",
    stageUpdateFields: (_id, stage) => {
      const company = companies.find((item) => String(item.id) === String(stage));
      return company
        ? { companyId: company.id, company: company.name || company.title || "" }
        : { companyId: "", company: "" };
    },
    bucketSummary: (stage, contacts) => `${money(openDealValue.get(stage.key) || 0)} · ${contacts.length} ${contacts.length === 1 ? "person" : "people"}`,
    zoneGravity: true,   // BLUEPRINT A2: contacts rest on the bucket floor
    leftDeckFilter: () => true,
    deckCopy: {
      leftFanAria: "Fan out contacts needing attention",
      leftTitle: "Needs attention",
      emptyLeft: "Relationships needing attention<br>appear here",
      createAria: "Create a contact",
      trashAria: "Recycle bin (deleted contacts)",
      trashTitle: "Recycle bin",
    },
    onLinkDrop: linkContacts,
    active: (document.body?.dataset?.crmModule || localStorage.getItem("crm-active-module")) === "people",
  });

  window.peopleCards.needsAttention = needsAttention;
    try {
      window.deals?.onChanged?.((payload) => {
        recalculateDealValues(payload);
        window.peopleCards?.reload?.();
      });
    } catch {}
  };

  initialize().catch((error) => console.error("[CRM] People company buckets failed", error));
})();
