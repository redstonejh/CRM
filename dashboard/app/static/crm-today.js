// crm-today.js - Today hand as a deck-only card-system instance.
(() => {
  const LAST_DEALT_KEY = "crm-today-last-dealt";
  const reasonLabels = {
    "next-touch": "Next touch",
    "contact-touch": "Next touch",
    "cold-front": "Cold front",
    "invoice-overdue": "Overdue",
    "invoice-due": "Due today",
    task: "Due today",
    calendar: "Due today",
  };
  const severityRgb = {
    none: "120,130,140",
    low: "34,211,238",
    medium: "250,204,21",
    high: "249,115,22",
    critical: "234,88,12",
    cold: "34,211,238",
    warm: "250,204,21",
    hot: "249,115,22",
    commit: "234,88,12",
    draft: "120,130,140",
    sent: "34,211,238",
    overdue: "239,68,68",
    paid: "34,197,94",
  };
  const homeStages = {
    tickets: ["triage", "investigation", "resolution"],
    contacts: ["customers", "prospects", "partners", "vendors"],
    deals: ["lead", "qualified", "proposal", "negotiation"],
    invoices: ["draft", "sent", "overdue"],
  };

  const recordsFrom = (result) => Array.isArray(result) ? result : ((result && (result.records || result.tickets)) || []);
  const escId = (entity, id) => `${entity}:${id}`;
  const splitId = (id) => {
    const text = String(id || "");
    const idx = text.indexOf(":");
    return idx > 0 ? { entity: text.slice(0, idx), id: text.slice(idx + 1) } : { entity: "", id: text };
  };
  const normalizeEntity = (entity) => {
    const value = String(entity || "").trim();
    const lower = value.toLowerCase();
    if (lower === "ticket") return "tickets";
    if (lower === "deal") return "deals";
    if (lower === "contact") return "contacts";
    if (lower === "invoice") return "invoices";
    if (lower === "task") return "tasks";
    if (lower === "calendar" || lower === "calendaritem" || lower === "calendaritems") return "calendarItems";
    return value || lower;
  };
  const metaOf = (record) => record?.meta && typeof record.meta === "object" ? record.meta : {};
  const valueOf = (record, key) => {
    const meta = metaOf(record);
    return record && record[key] != null && record[key] !== "" ? record[key] : meta[key];
  };
  const firstText = (...values) => {
    for (const value of values) {
      const text = String(value ?? "").trim();
      if (text) return text;
    }
    return "";
  };
  const bridgeFor = (entity) => ({
    contacts: window.contacts,
    deals: window.deals,
    invoices: window.invoices,
    tickets: window.tickets,
    tasks: window.tasks,
    calendarItems: {
      list: (options) => window.crmStore?.list?.("calendarItems", options),
      get: (id) => window.crmStore?.get?.("calendarItems", id),
      update: (id, fields) => window.crmStore?.update?.("calendarItems", id, fields),
    },
  }[normalizeEntity(entity)] || null);
  const detailFor = (entity) => ({
    contacts: window.contactDetail,
    deals: window.dealDetail,
    invoices: window.invoiceDetail,
    tickets: window.ticketDetail,
  }[normalizeEntity(entity)] || null);

  const titleOf = (record, row) => firstText(
    valueOf(record, "client"),
    valueOf(record, "title"),
    valueOf(record, "name"),
    record?.companyLabel,
    row?.title,
    row?.label,
    "Untitled",
  );
  const amountText = (row) => {
    const amount = row?.amount ?? row?.amountValue;
    if (amount == null || amount === "") return "";
    return typeof amount === "number" ? `$${amount.toLocaleString()}` : String(amount);
  };
  // Subtitle is the record's own words only — the due/stage/amount facts live
  // in the face body rows now, so they never double up on the card.
  const summaryLine = (record) => firstText(
    valueOf(record, "description"),
    valueOf(record, "host"),
  );
  const todayPriority = (record, row, entity) => {
    const priority = firstText(valueOf(record, "priority"), row?.priority);
    if (entity === "invoices") {
      if (row?.reason === "invoice-overdue") return "overdue";
      return priority || firstText(valueOf(record, "state"), row?.state, "sent");
    }
    if (entity === "deals") return priority || "warm";
    if (entity === "contacts" || entity === "calendarItems") return "none";
    if (entity === "tickets") return priority || "medium";
    return priority || "none";
  };
  const decorateRow = async (row, cache) => {
    const entity = normalizeEntity(row?.entity || row?.type);
    const targetId = String(row?.id || "").trim();
    if (!entity || !targetId) return null;
    let target = null;
    const bridge = bridgeFor(entity);
    if (bridge?.list) {
      if (!cache.has(entity)) {
        try { cache.set(entity, recordsFrom(await bridge.list({ includeDeleted: true }))); }
        catch { cache.set(entity, []); }
      }
      target = (cache.get(entity) || []).find((record) => String(record?.id || "") === targetId) || null;
    }
    const base = target || row;
    const reason = String(row?.reason || "today");
    const title = titleOf(base, row);
    const description = summaryLine(base, row);
    return {
      ...base,
      id: escId(entity, targetId),
      targetId,
      targetEntity: entity,
      targetRecord: target,
      todayReason: reason,
      todayRow: row,
      companyLabel: title,
      title,
      host: description,
      description,
      priority: todayPriority(base, row, entity),
      createdAt: base?.createdAt || row?.createdAt || row?.updatedAt || new Date().toISOString(),
      updatedAt: row?.updatedAt || base?.updatedAt || base?.createdAt || "",
    };
  };
  const targetRef = (record) => {
    if (record?.targetEntity && record?.targetId) return { entity: normalizeEntity(record.targetEntity), id: String(record.targetId) };
    const split = splitId(record?.id);
    return { entity: normalizeEntity(split.entity || record?.entity || record?.type), id: split.id };
  };
  const fetchTarget = async (record) => {
    if (record?.targetRecord?.id) return record.targetRecord;
    const { entity, id } = targetRef(record);
    const bridge = bridgeFor(entity);
    if (!bridge || !id) return null;
    if (bridge.get) {
      try {
        const result = await bridge.get(id);
        const found = result?.record || result?.ticket || (result?.id ? result : null);
        if (found) return found;
      } catch {}
    }
    try {
      return recordsFrom(await bridge.list?.({ includeDeleted: true })).find((item) => String(item?.id || "") === id) || null;
    } catch {
      return null;
    }
  };
  const updateTarget = async (record, fields) => {
    const { entity, id } = targetRef(record);
    const bridge = bridgeFor(entity);
    if (!bridge?.update || !id) return false;
    const result = await bridge.update(id, fields);
    return !(result && result.ok === false);
  };

  const todaySource = {
    list: async () => {
      const summary = await window.crmReportsApi?.summary?.();
      const rows = (summary?.summary?.datasets?.todayHand || []).slice(0, 100);
      const cache = new Map();
      const records = (await Promise.all(rows.map((row) => decorateRow(row, cache)))).filter(Boolean);
      return { records };
    },
    update: (id, fields) => updateTarget({ id }, fields),
    onChanged: (cb) => {
      let timer = 0;
      const reload = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          try { cb(await todaySource.list()); } catch {}
        }, 100);
      };
      try { window.crmStore?.onChanged?.(reload); } catch {}
      try { window.tickets?.onChanged?.(reload); } catch {}
    },
  };
  const todayDetail = {
    open: async (record, card, opts) => {
      const { entity } = targetRef(record);
      const detail = detailFor(entity);
      if (!detail?.open) return;
      const target = await fetchTarget(record);
      if (target) detail.open(target, card, opts);
    },
    isOpen: () => ["contacts", "deals", "invoices", "tickets"].some((entity) => !!detailFor(entity)?.isOpen?.()),
    close: () => ["contacts", "deals", "invoices", "tickets"].forEach((entity) => detailFor(entity)?.close?.()),
  };
  const stageDropFields = (record, stage) => {
    const { entity } = targetRef(record);
    const allowed = homeStages[entity] || [];
    if (!allowed.includes(stage)) return null;
    if (entity === "invoices") return { stage, state: stage, priority: stage };
    return { stage };
  };

  if (typeof window.createCrmCardSystem !== "function") {
    console.error("[CRM] card system factory is not loaded");
    return;
  }

  // Today face: what it is / when it's due / stage · amount / who owns it.
  const todayFace = {
    title: (r) => r.title,
    subtitle: (r) => r.description,
    rows: [
      (r) => (r.todayRow?.dueDate ? { label: "Due", value: r.todayRow.dueDate } : ""),
      (r) => [firstText(r.todayRow?.stageLabel, r.todayRow?.stage), amountText(r.todayRow)].filter(Boolean).join(" · "),
      (r) => {
        const who = firstText(r.targetRecord?.assignee, r.targetRecord?.owner);
        return who ? { label: "Who", value: who } : "";
      },
    ],
  };

  window.createCrmCardSystem({
    apiName: "crmToday",
    theater: "today",
    face: todayFace,
    source: todaySource,
    detail: todayDetail,
    widgetType: "today",
    widgetTitle: "Today",
    pinPrefix: "today-pin-",
    storageKeys: {
      order: (side) => `crm-today-order-${side}`,
      stage: "crm-today-stage",
      stageOrder: "crm-today-stage-order",
      deleted: "crm-today-deleted",
      meta: "crm-today-meta",
      color: "crm-today-color",
      colorLast: "crm-today-color-last",
    },
    stages: [],
    stageFields: {},
    createFields: [],
    recordsFromList: (result) => recordsFrom(result),
    severityRgb,
    intensityValues: Object.keys(severityRgb),
    defaultIntensity: "none",
    intensityOf: (record) => todayPriority(record, record?.todayRow || {}, normalizeEntity(record?.targetEntity)),
    deckOnly: true,
    createEnabled: false,
    rightDeckEnabled: false,
    trashEnabled: false,
    zonesEnabled: false,
    showProgressBars: false,
    showDateUnder: false,
    leftDeckFilter: () => true,
    deckCopy: {
      leftFanAria: "Fan out today's hand",
    },
    faceBadges: (record) => {
      const reason = record?.todayReason || "";
      const label = reasonLabels[reason] || "Today";
      const tone = reason === "invoice-overdue" ? "overdue" : (reason === "cold-front" || reason === "invoice-due" ? "warn" : "neutral");
      return [{ label, tone }];
    },
    autoFanOncePerDayKey: LAST_DEALT_KEY,
    fanStyle: "hand",            // BLUEPRINT A3: the dealt hand — arc fan around screen centre
    emptyStateText: "Desk clear.",
    onCalendarDrop: (record, date) => updateTarget(record, { scheduledDate: date, nextTouchAt: date }),
    onHomeStageDrop: (record, stage) => {
      const fields = stageDropFields(record, stage);
      return fields ? updateTarget(record, fields) : false;
    },
    active: false,
  });
})();
