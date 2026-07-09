// crm-record-search.js - top-search results dealt through a deck-only card system.
(() => {
  if (typeof window.createCrmCardSystem !== "function") {
    console.error("[CRM] card system factory is not loaded");
    return;
  }

  const LIMIT = 36;
  const RECENT_LIMIT = 14;
  const moneyRed = "239,68,68";
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
    overdue: moneyRed,
    paid: "34,197,94",
  };
  const entitySpecs = [
    { entity: "contacts", label: "Contact", bridge: () => window.contacts, detail: () => window.contactDetail },
    { entity: "deals", label: "Deal", bridge: () => window.deals, detail: () => window.dealDetail },
    { entity: "invoices", label: "Invoice", bridge: () => window.invoices, detail: () => window.invoiceDetail },
    { entity: "tickets", label: "Ticket", bridge: () => window.tickets, detail: () => window.ticketDetail },
    { entity: "tasks", label: "Task", bridge: () => window.tasks },
    { entity: "calendarItems", label: "Calendar", bridge: () => ({
      list: (options) => window.crmStore?.list?.("calendarItems", options),
      get: (id) => window.crmStore?.get?.("calendarItems", id),
      update: (id, fields) => window.crmStore?.update?.("calendarItems", id, fields),
    }) },
    { entity: "companies", label: "Company", bridge: () => window.companies },
    { entity: "interactions", label: "Thread", bridge: () => window.interactions },
  ];
  const homeStages = {
    tickets: ["triage", "investigation", "resolution"],
    contacts: ["customers", "prospects", "partners", "vendors"],
    deals: ["lead", "qualified", "proposal", "negotiation"],
    invoices: ["draft", "sent", "overdue"],
  };

  let query = "";
  let open = false;
  let lastCount = 0;
  let reloadTimer = 0;
  let cardApi = null;
  let btn = null;
  let pop = null;
  let input = null;
  let results = null;

  const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[char]));
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
  const recordsFrom = (result) => Array.isArray(result) ? result : ((result && (result.records || result.tickets)) || []);
  const normalizeEntity = (entity) => {
    const lower = String(entity || "").trim().toLowerCase();
    if (lower === "ticket") return "tickets";
    if (lower === "deal") return "deals";
    if (lower === "contact") return "contacts";
    if (lower === "invoice") return "invoices";
    if (lower === "task") return "tasks";
    if (lower === "company") return "companies";
    if (lower === "interaction") return "interactions";
    if (lower === "calendar" || lower === "calendaritem" || lower === "calendaritems") return "calendarItems";
    return entity || lower;
  };
  const specFor = (entity) => entitySpecs.find((spec) => spec.entity === normalizeEntity(entity)) || null;
  const bridgeFor = (entity) => specFor(entity)?.bridge?.() || null;
  const detailFor = (entity) => specFor(entity)?.detail?.() || null;
  const entityLabel = (entity) => specFor(entity)?.label || "Record";
  const splitId = (id) => {
    const text = String(id || "");
    const idx = text.indexOf(":");
    return idx > 0 ? { entity: normalizeEntity(text.slice(0, idx)), id: text.slice(idx + 1) } : { entity: "", id: text };
  };
  const compoundId = (entity, id) => `${normalizeEntity(entity)}:${id}`;
  const amountOf = (record) => {
    const raw = firstText(valueOf(record, "amountValue"), valueOf(record, "amount"), valueOf(record, "value"), valueOf(record, "budget"));
    const number = Number(String(raw).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(number) ? number : 0;
  };
  const moneyText = (amount) => amount ? `$${Math.round(amount).toLocaleString()}` : "";
  const dateMs = (value) => {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const invoiceState = (invoice) => String(valueOf(invoice, "state") || valueOf(invoice, "stage") || "draft").toLowerCase();
  const isPastDue = (invoice) => {
    const direct = /^(\d{4}-\d{2}-\d{2})/.exec(firstText(valueOf(invoice, "dueDate")));
    return !!direct && direct[1] < new Date().toISOString().slice(0, 10);
  };
  const titleOf = (entity, record) => {
    if (entity === "companies") return firstText(valueOf(record, "name"), valueOf(record, "title"), record?.companyLabel, record?.title, "Company");
    if (entity === "contacts") return firstText(valueOf(record, "client"), valueOf(record, "name"), valueOf(record, "title"), record?.companyLabel, "Contact");
    if (entity === "deals") return firstText(valueOf(record, "title"), valueOf(record, "client"), record?.companyLabel, "Deal");
    if (entity === "invoices") return firstText(valueOf(record, "number"), valueOf(record, "client"), valueOf(record, "title"), record?.companyLabel, "Invoice");
    if (entity === "interactions") return firstText(valueOf(record, "kind"), valueOf(record, "title"), "Interaction");
    return firstText(valueOf(record, "title"), valueOf(record, "client"), valueOf(record, "name"), record?.companyLabel, record?.host, "Record");
  };
  const subtitleOf = (entity, record) => {
    if (entity === "companies") return firstText(record?.host, valueOf(record, "domain"), valueOf(record, "kind"), valueOf(record, "description"));
    if (entity === "contacts") return [firstText(valueOf(record, "company"), valueOf(record, "role")), valueOf(record, "nextTouchAt") ? `Next ${valueOf(record, "nextTouchAt")}` : ""].filter(Boolean).join(" / ");
    if (entity === "deals") return [moneyText(amountOf(record)), firstText(valueOf(record, "stage"), valueOf(record, "state")), valueOf(record, "nextTouchAt") ? `Next ${valueOf(record, "nextTouchAt")}` : ""].filter(Boolean).join(" / ");
    if (entity === "invoices") return [moneyText(amountOf(record)), firstText(valueOf(record, "state"), valueOf(record, "stage")), valueOf(record, "dueDate") ? `Due ${valueOf(record, "dueDate")}` : ""].filter(Boolean).join(" / ");
    if (entity === "interactions") return firstText(valueOf(record, "note"), valueOf(record, "description"), valueOf(record, "at"));
    return firstText(valueOf(record, "description"), valueOf(record, "host"), valueOf(record, "state"), valueOf(record, "status"));
  };
  const intensityOf = (record) => {
    const entity = normalizeEntity(record?.targetEntity || record?.entity || record?.type);
    if (entity === "contacts" || entity === "companies" || entity === "interactions" || entity === "calendarItems") return "none";
    if (entity === "deals") return firstText(valueOf(record, "priority"), valueOf(record, "temperature"), "warm");
    if (entity === "invoices") {
      const state = invoiceState(record);
      if (state === "paid") return "paid";
      if (state === "overdue" || (state === "sent" && isPastDue(record))) return "overdue";
      if (state === "sent") return "sent";
      return "draft";
    }
    const priority = firstText(valueOf(record, "priority"), "medium");
    return severityRgb[priority] ? priority : "medium";
  };
  const searchableText = (entity, record) => [
    entityLabel(entity),
    titleOf(entity, record),
    subtitleOf(entity, record),
    record?.id,
    valueOf(record, "company"),
    valueOf(record, "companyId"),
    valueOf(record, "companyLabel"),
    valueOf(record, "host"),
    valueOf(record, "note"),
    valueOf(record, "description"),
    valueOf(record, "email"),
    valueOf(record, "phone"),
    valueOf(record, "domain"),
    ...(Array.isArray(record?.history) ? record.history.map((item) => firstText(item.detail, item.action, item.note, item.text)) : []),
  ].filter(Boolean).join(" ").toLowerCase();
  const scoreRecord = (row, q) => {
    if (!q) return 1;
    const terms = q.split(/\s+/).filter(Boolean);
    const haystack = row.searchText || "";
    if (!terms.every((term) => haystack.includes(term))) return 0;
    const title = String(row.title || "").toLowerCase();
    return terms.reduce((score, term) => score + (title.startsWith(term) ? 16 : title.includes(term) ? 10 : 3), 0);
  };
  const targetRef = (record) => {
    if (record?.targetEntity && record?.targetId) return { entity: normalizeEntity(record.targetEntity), id: String(record.targetId) };
    const split = splitId(record?.id);
    return { entity: normalizeEntity(split.entity || record?.entity || record?.type), id: split.id };
  };
  const bridgeId = (entity, id) => entity === "companies" && String(id || "").startsWith("id:") ? String(id).slice(3) : id;
  const fetchTarget = async (record) => {
    if (record?.targetRecord?.id) return record.targetRecord;
    const { entity, id } = targetRef(record);
    const bridge = bridgeFor(entity);
    const realId = bridgeId(entity, id);
    if (!bridge || !realId) return null;
    try {
      const result = await bridge.get?.(realId);
      return result?.record || result?.ticket || (result?.id ? result : null);
    } catch {
      return null;
    }
  };
  const updateTarget = async (record, fields) => {
    const { entity, id } = targetRef(record);
    const bridge = bridgeFor(entity);
    const realId = bridgeId(entity, id);
    if (!bridge?.update || !realId || entity === "interactions") return false;
    const result = await bridge.update(realId, fields);
    return !(result && result.ok === false);
  };

  const normalizeRecord = (entity, record, source = "store") => {
    const normalized = normalizeEntity(entity);
    const targetId = String(record?.targetId || record?.id || "").trim();
    if (!targetId) return null;
    const title = firstText(record?.title, record?.companyLabel, titleOf(normalized, record));
    const description = firstText(record?.host, record?.description, subtitleOf(normalized, record));
    return {
      ...record,
      id: compoundId(normalized, targetId),
      targetEntity: normalized,
      targetId,
      targetRecord: record?.targetRecord || (source === "store" ? record : null),
      searchSource: source,
      companyLabel: title,
      title,
      host: description,
      description,
      priority: intensityOf({ ...record, targetEntity: normalized }),
      createdAt: record?.createdAt || record?.updatedAt || new Date().toISOString(),
      updatedAt: record?.updatedAt || record?.createdAt || "",
      searchText: searchableText(normalized, record),
    };
  };

  const loadAllRecords = async () => {
    const pairs = await Promise.all(entitySpecs.filter((spec) => spec.entity !== "companies").map(async (spec) => {
      try { return [spec.entity, recordsFrom(await spec.bridge()?.list?.({ includeDeleted: true }))]; }
      catch { return [spec.entity, []]; }
    }));
    let records = pairs.flatMap(([entity, list]) => list.map((record) => normalizeRecord(entity, record)).filter(Boolean));
    try {
      const companies = await window.crmCompanyDive?.summaries?.();
      records = records.concat((companies || []).map((record) => normalizeRecord("companies", record, "company-dive")).filter(Boolean));
    } catch {
      try {
        const companyRecords = recordsFrom(await window.companies?.list?.({ includeDeleted: true }));
        records = records.concat(companyRecords.map((record) => normalizeRecord("companies", record)).filter(Boolean));
      } catch {}
    }
    return records;
  };

  const renderStatus = () => {
    if (!results) return;
    const text = query
      ? (lastCount ? `${lastCount} card${lastCount === 1 ? "" : "s"}` : "No cards")
      : (lastCount ? `Recent / ${lastCount} card${lastCount === 1 ? "" : "s"}` : "No recent cards");
    results.innerHTML = `<div class="dashboard-search-empty">${esc(text)}</div>`;
  };

  const searchSource = {
    list: async () => {
      const q = query.trim().toLowerCase();
      const records = await loadAllRecords();
      const ranked = records.map((record) => ({ ...record, searchScore: scoreRecord(record, q) }))
        .filter((record) => q ? record.searchScore > 0 : true)
        .sort((a, b) => (
          (b.searchScore - a.searchScore) ||
          (dateMs(b.updatedAt || b.createdAt) - dateMs(a.updatedAt || a.createdAt)) ||
          String(a.title || "").localeCompare(String(b.title || ""))
        ))
        .slice(0, q ? LIMIT : RECENT_LIMIT);
      lastCount = ranked.length;
      renderStatus();
      return { records: ranked };
    },
    update: (id, fields) => updateTarget({ id }, fields),
    onChanged: (cb) => {
      let timer = 0;
      const reload = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          try { cb(await searchSource.list()); } catch {}
        }, 140);
      };
      try { window.crmStore?.onChanged?.(reload); } catch {}
      try { window.tickets?.onChanged?.(reload); } catch {}
    },
  };

  const searchDetail = {
    open: async (record, card) => {
      const { entity } = targetRef(record);
      if (entity === "companies") {
        api.close();
        window.crmCompanyDive?.openForRecord?.(record, "companies");
        return;
      }
      const detail = detailFor(entity);
      const target = await fetchTarget(record);
      if (detail?.open && target) {
        detail.open(target, card);
        return;
      }
      if (target || record) {
        api.close();
        window.crmCompanyDive?.openForRecord?.(target || record, entity);
      }
    },
    isOpen: () => false,
    close: () => {},
  };

  const stageDropFields = (record, stage) => {
    const { entity } = targetRef(record);
    const allowed = homeStages[entity] || [];
    if (!allowed.includes(stage)) return null;
    if (entity === "invoices") return { stage, state: stage, priority: stage };
    return { stage };
  };

  cardApi = window.createCrmCardSystem({
    apiName: "crmSearchDeckCards",
    theater: "search",
    source: searchSource,
    detail: searchDetail,
    widgetType: "search-result",
    widgetTitle: "Search Result",
    pinPrefix: "search-pin-",
    storageKeys: {
      order: (side) => `crm-search-order-${side}`,
      stage: "crm-search-stage",
      stageOrder: "crm-search-stage-order",
      deleted: "crm-search-deleted",
      meta: "crm-search-meta",
      color: "crm-search-color",
      colorLast: "crm-search-color-last",
    },
    stages: [],
    stageFields: {},
    createFields: [],
    recordsFromList: (result) => recordsFrom(result),
    severityRgb,
    intensityValues: Object.keys(severityRgb),
    defaultIntensity: "none",
    intensityOf,
    deckOnly: true,
    createEnabled: false,
    rightDeckEnabled: false,
    trashEnabled: false,
    zonesEnabled: false,
    showProgressBars: false,
    showDateUnder: false,
    showFlow: false,
    leftDeckFilter: () => true,
    deckCopy: {
      leftFanAria: "Fan out CRM search results",
      leftEmptyHtml: "No cards.",
    },
    faceBadges: (record) => {
      const entity = normalizeEntity(record?.targetEntity || record?.entity || record?.type);
      const overdue = entity === "invoices" && intensityOf(record) === "overdue";
      return [{ label: entityLabel(entity), tone: overdue ? "overdue" : "neutral" }];
    },
    onCalendarDrop: (record, date) => updateTarget(record, { scheduledDate: date, nextTouchAt: date }),
    onHomeStageDrop: (record, stage) => {
      const fields = stageDropFields(record, stage);
      return fields ? updateTarget(record, fields) : false;
    },
    active: false,
  });

  const reloadAndFan = (delay = 80) => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (!open) return;
      Promise.resolve(cardApi.reload?.()).then(() => {
        cardApi.fan?.("left", lastCount > 1);
      });
    }, delay);
  };

  const positionPopover = () => {
    if (!btn || !pop) return;
    const rect = btn.getBoundingClientRect();
    pop.style.top = `${Math.round(rect.bottom + 8)}px`;
    pop.style.left = `${Math.round(rect.left)}px`;
  };
  const openPopover = () => {
    open = true;
    if (pop) pop.hidden = false;
    btn?.setAttribute("aria-expanded", "true");
    positionPopover();
    cardApi.setActive?.(true);
    reloadAndFan(0);
    input?.focus();
  };
  const closePopover = () => {
    open = false;
    if (pop) pop.hidden = true;
    btn?.setAttribute("aria-expanded", "false");
    cardApi.fan?.("left", false);
    cardApi.setActive?.(false);
  };
  const setQuery = (value) => {
    query = String(value || "").trim();
    if (!open) openPopover();
    reloadAndFan();
  };

  const wireTopSearch = () => {
    btn = document.querySelector(".control-bar-search");
    pop = document.getElementById("dashboard-search-popover");
    if (!btn || !pop || pop.dataset.crmSearchWired === "true") return;
    pop.dataset.crmSearchWired = "true";
    input = pop.querySelector(".dashboard-search-input");
    results = pop.querySelector(".dashboard-search-results");
    btn.setAttribute("aria-label", "Search CRM cards");
    btn.title = "Search CRM cards";
    if (input) {
      input.placeholder = "Search CRM cards...";
      input.setAttribute("aria-label", "Search CRM cards");
    }
    renderStatus();
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (open) closePopover();
      else {
        if (input) input.value = query;
        openPopover();
      }
    }, true);
    input?.addEventListener("input", (event) => {
      event.stopImmediatePropagation();
      setQuery(input.value);
    }, true);
    input?.addEventListener("keydown", (event) => {
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        closePopover();
        btn.focus();
      } else if (event.key === "Enter") {
        event.preventDefault();
        cardApi.fan?.("left", true);
      }
    }, true);
    document.addEventListener("pointerdown", (event) => {
      if (!open) return;
      if (pop.contains(event.target) || btn.contains(event.target)) return;
      closePopover();
    }, true);
    window.addEventListener("resize", () => { if (open) positionPopover(); });
  };

  const api = {
    open: openPopover,
    close: closePopover,
    setQuery,
    isOpen: () => open,
    reload: () => reloadAndFan(0),
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireTopSearch);
  else wireTopSearch();
  window.crmSearchDeck = api;
})();
