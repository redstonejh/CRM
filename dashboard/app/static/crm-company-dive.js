// crm-company-dive.js - company worlds hosted by the shared fractal camera.
(() => {
  if (typeof window.createFractalCamera !== "function") {
    console.error("[CRM] fractal camera factory is not loaded");
    return;
  }

  const entitySpecs = [
    { entity: "companies", label: "Company", bridge: () => window.companies },
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
    { entity: "interactions", label: "Thread", bridge: () => window.interactions },
  ];
  const recordEntities = ["contacts", "deals", "invoices", "tickets", "tasks", "calendarItems"];
  const moneyRed = "239,68,68";
  const palette = {
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

  let camera = null;
  let active = false;
  let cache = { loadedAt: 0, records: new Map(), summaries: [] };
  let reloadPromise = null;
  let reloadTimer = 0;
  let subscribed = false;

  const cssEsc = (window.CSS && CSS.escape) ? (value) => CSS.escape(value) : (value) => String(value).replace(/["\\\]]/g, "\\$&");
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
    if (lower === "calendar" || lower === "calendaritem" || lower === "calendaritems") return "calendarItems";
    if (lower === "company") return "companies";
    if (lower === "interaction") return "interactions";
    return entity || lower;
  };
  const specFor = (entity) => entitySpecs.find((spec) => spec.entity === normalizeEntity(entity)) || null;
  const slug = (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const companyKeyFromName = (name) => {
    const clean = slug(name);
    return clean ? `name:${clean}` : "";
  };
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
  const shortWhen = (value) => {
    const ms = dateMs(value);
    if (!ms) return "";
    try { return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
    catch { return ""; }
  };
  const humanDate = (value) => {
    const ms = dateMs(value);
    if (!ms) return "";
    const date = new Date(ms); date.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.round((date - today) / 86400000);
    if (days === 0) return "today";
    if (days > 0 && days < 14) return `${days}d`;
    if (days === -1) return "yesterday";
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  };
  const entityLabel = (entity) => specFor(entity)?.label || "Record";
  const titleOf = (entity, record) => {
    if (entity === "companies") return firstText(valueOf(record, "name"), valueOf(record, "company"), valueOf(record, "title"), valueOf(record, "client"), record?.companyLabel, "Company");
    if (entity === "contacts") return firstText(valueOf(record, "client"), valueOf(record, "name"), valueOf(record, "title"), record?.companyLabel, "Contact");
    if (entity === "deals") return firstText(valueOf(record, "title"), valueOf(record, "client"), record?.companyLabel, "Deal");
    if (entity === "invoices") return firstText(valueOf(record, "number"), valueOf(record, "client"), valueOf(record, "title"), record?.companyLabel, "Invoice");
    return firstText(valueOf(record, "title"), valueOf(record, "client"), valueOf(record, "name"), record?.companyLabel, record?.host, "Record");
  };
  const subtitleOf = (entity, record) => {
    if (entity === "contacts") return firstText(valueOf(record, "company"), valueOf(record, "role"), valueOf(record, "description"), record?.host);
    if (entity === "deals") return [moneyText(amountOf(record)), firstText(valueOf(record, "stage"), valueOf(record, "state")), valueOf(record, "description")].filter(Boolean).join(" / ");
    if (entity === "invoices") return [moneyText(amountOf(record)), firstText(valueOf(record, "state"), valueOf(record, "stage")), valueOf(record, "dueDate") ? `Due ${humanDate(valueOf(record, "dueDate"))}` : ""].filter(Boolean).join(" / ");
    return firstText(valueOf(record, "description"), valueOf(record, "host"), valueOf(record, "state"), valueOf(record, "status"));
  };
  const invoiceState = (invoice) => String(valueOf(invoice, "state") || valueOf(invoice, "stage") || "draft").toLowerCase();
  const isPastDue = (invoice) => {
    const raw = firstText(valueOf(invoice, "dueDate"));
    const direct = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
    const due = direct ? direct[1] : "";
    return !!due && due < new Date().toISOString().slice(0, 10);
  };
  const intensityOf = (entity, record) => {
    if (entity === "contacts" || entity === "companies" || entity === "interactions") return "none";
    if (entity === "deals") return firstText(valueOf(record, "priority"), valueOf(record, "temperature"), "warm");
    if (entity === "invoices") {
      const state = invoiceState(record);
      if (state === "paid") return "paid";
      if (state === "overdue" || (state === "sent" && isPastDue(record))) return "overdue";
      if (state === "sent") return "sent";
      return "draft";
    }
    const priority = firstText(valueOf(record, "priority"), "medium");
    return palette[priority] ? priority : "medium";
  };
  // FIDELITY_ORDER §1: dive faces wear the original's full-body severity wash —
  // the entity palette rendered as the fill gradient, exactly like every stack
  // card. Contacts render the neutral "none" tone.
  const cardBackground = (entity, record) => {
    const intensity = intensityOf(entity, record);
    const rgb = palette[intensity] || palette.none;
    return `linear-gradient(180deg, rgba(${rgb},0.4), rgba(${rgb},0.2))`;
  };
  const accentStyle = () => "";
  const isOpenInvoice = (invoice) => !["paid", "void", "cancelled", "canceled"].includes(invoiceState(invoice));
  const isOpenDeal = (deal) => !["won", "lost"].includes(String(valueOf(deal, "state") || valueOf(deal, "stage") || "").toLowerCase());
  const inferredCompanyName = (entity, record) => {
    if (entity === "companies") return titleOf(entity, record);
    if (entity === "contacts") return firstText(valueOf(record, "company"), valueOf(record, "companyName"), valueOf(record, "account"));
    if (entity === "deals") return firstText(valueOf(record, "company"), valueOf(record, "companyName"), valueOf(record, "account"), valueOf(record, "client"), record?.companyLabel);
    if (entity === "invoices") return firstText(valueOf(record, "company"), valueOf(record, "companyName"), valueOf(record, "account"));
    return firstText(valueOf(record, "company"), valueOf(record, "companyName"), valueOf(record, "account"), valueOf(record, "client"), record?.companyLabel);
  };

  const listEntity = async (spec) => {
    try {
      const result = await spec.bridge()?.list?.({ includeDeleted: true });
      return recordsFrom(result).filter(Boolean);
    } catch {
      return [];
    }
  };

  const buildSummaries = (records) => {
    const summaries = new Map();
    const companyIdToKey = new Map();
    const companyNameToKey = new Map();
    const recordKey = new Map();
    const ensureSummary = (key, label, companyRecord = null) => {
      if (!key) return null;
      if (!summaries.has(key)) {
        summaries.set(key, {
          key,
          label: firstText(label, "Company"),
          companyRecord,
          contacts: [],
          deals: [],
          invoices: [],
          tickets: [],
          tasks: [],
          calendarItems: [],
          interactions: [],
          openValue: 0,
          updatedAt: "",
        });
      }
      const summary = summaries.get(key);
      if (label && /^Company /.test(summary.label)) summary.label = label;
      if (companyRecord && !summary.companyRecord) summary.companyRecord = companyRecord;
      return summary;
    };
    (records.get("companies") || []).forEach((company) => {
      const id = String(company?.id || "").trim();
      const label = titleOf("companies", company);
      const key = id ? `id:${id}` : companyKeyFromName(label);
      if (!key) return;
      companyIdToKey.set(id, key);
      companyNameToKey.set(slug(label), key);
      ensureSummary(key, label, company);
    });
    const keyForCompanyId = (id) => {
      const clean = String(id || "").trim();
      if (!clean) return "";
      return companyIdToKey.get(clean) || `id:${clean}`;
    };
    const keyForRecord = (entity, record) => {
      if (!record) return "";
      if (entity === "companies") return keyForCompanyId(record.id) || companyKeyFromName(titleOf(entity, record));
      const companyId = firstText(valueOf(record, "companyId"));
      if (companyId) return keyForCompanyId(companyId);
      const name = inferredCompanyName(entity, record);
      if (!name) return "";
      return companyNameToKey.get(slug(name)) || companyKeyFromName(name);
    };
    recordEntities.forEach((entity) => {
      (records.get(entity) || []).forEach((record) => {
        const key = keyForRecord(entity, record);
        if (!key) return;
        const label = inferredCompanyName(entity, record);
        const summary = ensureSummary(key, label);
        if (!summary) return;
        summary[entity].push(record);
        recordKey.set(`${entity}:${record.id}`, key);
        const updated = firstText(record?.updatedAt, record?.createdAt);
        if (dateMs(updated) > dateMs(summary.updatedAt)) summary.updatedAt = updated;
        if (entity === "deals" && isOpenDeal(record)) summary.openValue += amountOf(record);
        if (entity === "invoices" && isOpenInvoice(record)) summary.openValue += amountOf(record);
      });
    });
    const addInteractionKey = (keys, entity, id) => {
      const cleanEntity = normalizeEntity(entity);
      const cleanId = String(id || "").trim();
      if (!cleanEntity || !cleanId) return;
      if (cleanEntity === "companies") keys.add(keyForCompanyId(cleanId));
      else if (recordKey.has(`${cleanEntity}:${cleanId}`)) keys.add(recordKey.get(`${cleanEntity}:${cleanId}`));
    };
    (records.get("interactions") || []).forEach((interaction) => {
      const keys = new Set();
      const relatedIds = Array.isArray(valueOf(interaction, "relatedIds")) ? valueOf(interaction, "relatedIds") : [];
      relatedIds.forEach((ref) => addInteractionKey(keys, ref?.entity || ref?.type, ref?.id));
      ["companyId", "contactId", "dealId", "invoiceId", "taskId", "calendarItemId"].forEach((field) => {
        const entity = field === "companyId" ? "companies" : field.replace(/Id$/, "s");
        addInteractionKey(keys, entity === "calendarItems" ? "calendarItems" : entity, valueOf(interaction, field));
      });
      ["relatedCompanyIds", "relatedContactIds", "relatedDealIds", "relatedInvoiceIds", "relatedTaskIds", "relatedCalendarItemIds"].forEach((field) => {
        const ids = Array.isArray(valueOf(interaction, field)) ? valueOf(interaction, field) : [];
        const entity = field.replace(/^related/, "").replace(/Ids$/, "s");
        ids.forEach((id) => addInteractionKey(keys, entity === "Companys" ? "companies" : entity.charAt(0).toLowerCase() + entity.slice(1), id));
      });
      keys.forEach((key) => {
        const summary = ensureSummary(key, key.replace(/^id:|^name:/, "Company "));
        if (summary) summary.interactions.push(interaction);
      });
    });
    return [...summaries.values()].map((summary) => ({
      ...summary,
      cardCount: summary.contacts.length + summary.deals.length + summary.invoices.length + summary.tickets.length + summary.tasks.length + summary.calendarItems.length,
      totalThread: summary.interactions.length + recordEntities.reduce((total, entity) => (
        total + summary[entity].reduce((count, record) => count + (Array.isArray(record.history) ? record.history.length : 0), 0)
      ), 0),
    })).sort((a, b) => (b.openValue - a.openValue) || a.label.localeCompare(b.label));
  };

  const loadData = async (force = false) => {
    if (reloadPromise) return reloadPromise;
    if (!force && Date.now() - cache.loadedAt < 4000 && cache.summaries.length) return cache;
    reloadPromise = Promise.all(entitySpecs.map(async (spec) => [spec.entity, await listEntity(spec)]))
      .then((pairs) => {
        const records = new Map(pairs);
        cache = { loadedAt: Date.now(), records, summaries: buildSummaries(records) };
        reloadPromise = null;
        return cache;
      })
      .catch(() => {
        reloadPromise = null;
        return cache;
      });
    return reloadPromise;
  };

  const summaryForKey = (key) => cache.summaries.find((summary) => summary.key === key) || null;
  const summaryAsRecord = (summary) => ({
    id: summary.key,
    entity: "companies",
    targetEntity: "companies",
    targetId: summary.companyRecord?.id || summary.key,
    targetRecord: summary.companyRecord || null,
    companyKey: summary.key,
    companyLabel: summary.label,
    title: summary.label,
    host: [summary.cardCount ? `${summary.cardCount} cards` : "", moneyText(summary.openValue), summary.totalThread ? `${summary.totalThread} thread` : ""].filter(Boolean).join(" / "),
    description: summary.label,
    priority: "none",
    createdAt: summary.companyRecord?.createdAt || summary.updatedAt || new Date().toISOString(),
    updatedAt: summary.updatedAt || summary.companyRecord?.updatedAt || "",
  });

  const ensureStyles = () => {
    if (document.getElementById("crm-company-dive-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-company-dive-styles";
    style.textContent = `
      .crm-company-surface { position: fixed; inset: 0; z-index: 4200; pointer-events: none; overflow: hidden;
        background: rgba(5,9,15,0.82); }
      .crm-company-surface[hidden] { display: none; }
      .crm-company-level { position: absolute; inset: 0; transform-origin: 0 0; }
      .crm-company-grid { position: absolute; display: grid; pointer-events: auto; -webkit-app-region: no-drag;
        grid-template-columns: repeat(4, minmax(220px, 245px)); grid-auto-rows: minmax(300px, 1fr);
        justify-content: center; align-content: center; gap: 14px; }
      @media (max-width: 860px) {
        .crm-company-grid { grid-template-columns: repeat(2, minmax(220px, 245px)); }
      }
      .crm-company-bucket { position: relative; box-sizing: border-box; display: flex; flex-direction: column; min-height: 0;
        overflow: hidden; color: #fff; cursor: pointer; border: 0; text-align: left;
        border-radius: 16px; padding: 14px 16px;
        background: linear-gradient(180deg, rgba(22,26,36,0.54), rgba(12,16,24,0.46));
        -webkit-backdrop-filter: blur(28px) saturate(140%); backdrop-filter: blur(28px) saturate(140%);
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.14), inset 0 1px 0 rgba(255,255,255,0.18), 0 18px 42px rgba(0,0,0,0.28);
        transition: box-shadow .18s ease, background .18s ease; }
      .crm-company-bucket:hover {
        background: linear-gradient(180deg, rgba(70,110,190,0.34), rgba(40,70,130,0.26));
        box-shadow: inset 0 0 0 1px rgba(125,180,255,0.5), 0 0 30px rgba(90,150,255,0.42);
      }
      .crm-company-name { font-size: 1.05rem; font-weight: 820; line-height: 1.12; color: rgba(255,255,255,0.92); }
      .crm-company-meta { margin-top: 8px; font-size: .78rem; line-height: 1.35; color: rgba(255,255,255,0.58); }
      .crm-company-minis { margin-top: auto; display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; opacity: .76; }
      .crm-company-mini { height: 9px; border-radius: 999px; background: rgba(255,255,255,0.14); }
      .crm-company-mini.is-on { background: rgba(125,180,255,0.42); }
      .crm-company-empty { align-self: center; justify-self: center; color: rgba(255,255,255,0.5); pointer-events: none; }
      .crm-company-world { position: absolute; z-index: 5; pointer-events: auto; -webkit-app-region: no-drag;
        transform-origin: 0 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 14px;
        padding: 16px; color: #fff; border-radius: 18px; overflow: hidden;
        background: linear-gradient(180deg, rgba(22,26,36,0.68), rgba(12,16,24,0.6));
        border: 1px solid rgba(255,255,255,0.18);
        -webkit-backdrop-filter: blur(30px) saturate(140%); backdrop-filter: blur(30px) saturate(140%);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 22px 54px rgba(0,0,0,0.34); }
      .crm-company-world-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-height: 0; }
      .crm-company-world-title { font-size: clamp(1.2rem, 2.2vw, 1.8rem); font-weight: 840; line-height: 1.1; }
      .crm-company-world-stats { font-size: .82rem; font-weight: 760; color: rgba(255,255,255,0.58); white-space: nowrap; }
      .crm-company-world-body { min-height: 0; flex: 1 1 auto; display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(260px, .85fr); gap: 14px; }
      .crm-company-records { min-height: 0; display: grid; grid-template-rows: repeat(3, minmax(0, 1fr)); gap: 12px; }
      .crm-company-lane { min-height: 0; display: flex; flex-direction: column; gap: 8px; }
      .crm-company-lane-title { font-size: .74rem; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: rgba(160,190,255,0.86); }
      .crm-company-face-row { min-height: 0; display: flex; gap: 10px; overflow: auto; padding: 1px 2px 8px; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.5) transparent; }
      .crm-company-face.tk-card { position: relative; left: auto; right: auto; bottom: auto; width: 150px; height: 216px;
        flex: 0 0 150px; transform: none !important; cursor: pointer; }
      .crm-company-face .ticket-company { white-space: normal; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
      .crm-company-face .ticket-host { white-space: normal; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
      .crm-company-thread { min-height: 0; display: flex; flex-direction: column; gap: 8px; }
      .crm-company-thread-list { min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 7px; padding-right: 4px;
        scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.5) transparent; }
      .crm-company-thread-row { border-radius: 10px; padding: 8px 9px; background: rgba(255,255,255,0.055); }
      .crm-company-thread-at { font-size: .68rem; color: rgba(255,255,255,0.42); }
      .crm-company-thread-text { margin-top: 2px; font-size: .82rem; line-height: 1.35; color: rgba(255,255,255,0.8); }
      .crm-company-none { color: rgba(255,255,255,0.45); font-size: .82rem; padding: 8px 2px; }
      .crm-company-warm, .crm-company-warm * { pointer-events: none !important; }
      @media (max-width: 860px) {
        .crm-company-world-body { grid-template-columns: 1fr; grid-template-rows: minmax(0, 1fr) minmax(180px, .7fr); }
      }
    `;
    document.head.appendChild(style);
  };

  const bucketHTML = (summary) => {
    const meta = [summary.cardCount ? `${summary.cardCount} cards` : "No cards", moneyText(summary.openValue), summary.totalThread ? `${summary.totalThread} thread` : ""].filter(Boolean).join(" / ");
    const miniCount = Math.min(4, Math.max(1, summary.cardCount));
    return `
      <div class="crm-company-name">${esc(summary.label)}</div>
      <div class="crm-company-meta">${esc(meta)}</div>
      <div class="crm-company-minis" aria-hidden="true">
        ${[0, 1, 2, 3].map((idx) => `<span class="crm-company-mini${idx < miniCount ? " is-on" : ""}"></span>`).join("")}
      </div>`;
  };

  const buildRoot = () => {
    const root = document.createElement("div");
    root.className = "crm-company-level";
    const grid = document.createElement("div");
    grid.className = "crm-company-grid";
    if (!cache.summaries.length) {
      const empty = document.createElement("div");
      empty.className = "crm-company-empty";
      empty.textContent = "No company buckets yet.";
      root.appendChild(empty);
    } else {
      cache.summaries.forEach((summary) => {
        const bucket = document.createElement("button");
        bucket.type = "button";
        bucket.className = "crm-company-bucket";
        bucket.dataset.companyKey = summary.key;
        bucket.innerHTML = bucketHTML(summary);
        grid.appendChild(bucket);
      });
      root.appendChild(grid);
    }
    return root;
  };

  const layout = ({ expRect }) => {
    const E = expRect();
    const grid = camera?.surface?.()?.querySelector(".crm-company-grid");
    const empty = camera?.surface?.()?.querySelector(".crm-company-empty");
    const width = Math.max(300, Math.min(E.w, 1080));
    const height = Math.max(280, Math.min(E.h, 720));
    const box = {
      left: `${Math.round(E.x + (E.w - width) / 2)}px`,
      top: `${Math.round(E.y + (E.h - height) / 2)}px`,
      width: `${Math.round(width)}px`,
      height: `${Math.round(height)}px`,
    };
    if (grid) Object.assign(grid.style, box);
    if (empty) Object.assign(empty.style, { position: "absolute", ...box, display: "grid", placeItems: "center" });
  };

  const targetFromEvent = (event, context) => {
    if (context.level > 0) return null;
    const target = event.target.closest?.(".crm-company-bucket[data-company-key]");
    return target && context.layers[0]?.contains(target) ? target : null;
  };
  const targetAtPoint = (x, y, context) => {
    if (context.level > 0) return null;
    return [...(context.layers[0]?.querySelectorAll(".crm-company-bucket[data-company-key]") || [])].find((bucket) => {
      const rect = bucket.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }) || null;
  };

  // BLUEPRINT A6: interior faces carry the cold front too — the desaturation
  // variable rides the same .tk-card recipe the surfaces use.
  const stalenessStyle = (entity, record) => {
    const value = Number(window.crmColdFront?.staleness?.(record, entity));
    return Number.isFinite(value) && value > 0.005 ? ` --crm-staleness: ${Math.min(1, value).toFixed(3)};` : "";
  };
  const cardFaceHTML = (entity, record) => `
    <button class="tk-card crm-company-face" type="button" data-company-record="${esc(entity)}:${esc(record.id)}"
      style="background-color: rgb(107, 114, 128); background-image: ${cardBackground(entity, record)};${accentStyle(entity, record)}${stalenessStyle(entity, record)}">
      <div class="ticket-body">
        <div class="ticket-company">${esc(titleOf(entity, record))}</div>
        ${subtitleOf(entity, record) ? `<div class="ticket-host">${esc(subtitleOf(entity, record))}</div>` : ""}
        <div class="ticket-fields">
          <div class="ticket-field"><span class="ticket-field-l">${esc(entityLabel(entity))}</span><span class="ticket-field-v">${esc(firstText(valueOf(record, "stage"), valueOf(record, "state"), valueOf(record, "status"), ""))}</span></div>
        </div>
      </div>
      <div class="tk-edge-shade"></div>
    </button>`;

  const laneHTML = (title, entity, records) => `
    <section class="crm-company-lane">
      <div class="crm-company-lane-title">${esc(title)}</div>
      <div class="crm-company-face-row">
        ${records.length ? records.map((record) => cardFaceHTML(entity, record)).join("") : `<div class="crm-company-none">None</div>`}
      </div>
    </section>`;

  const historyEntries = (summary) => {
    const entries = [];
    recordEntities.forEach((entity) => {
      (summary[entity] || []).forEach((record) => {
        (Array.isArray(record.history) ? record.history : []).forEach((item) => {
          const text = firstText(item.detail, item.action, item.note, item.text);
          if (!text) return;
          entries.push({
            at: firstText(item.at, item.createdAt, record.updatedAt, record.createdAt),
            label: `${entityLabel(entity)} / ${titleOf(entity, record)}`,
            text,
          });
        });
      });
    });
    (summary.interactions || []).forEach((interaction) => {
      entries.push({
        at: firstText(valueOf(interaction, "at"), interaction.updatedAt, interaction.createdAt),
        label: firstText(valueOf(interaction, "kind"), "Interaction"),
        text: firstText(valueOf(interaction, "note"), valueOf(interaction, "description"), valueOf(interaction, "title"), "Interaction"),
      });
    });
    return entries.sort((a, b) => dateMs(b.at) - dateMs(a.at)).slice(0, 80);
  };

  const threadHTML = (summary) => {
    const entries = historyEntries(summary);
    return `
      <section class="crm-company-thread">
        <div class="crm-company-lane-title">Merged Thread</div>
        <div class="crm-company-thread-list">
          ${entries.length ? entries.map((entry) => `
            <div class="crm-company-thread-row">
              <div class="crm-company-thread-at">${esc(shortWhen(entry.at))}${entry.label ? ` / ${esc(entry.label)}` : ""}</div>
              <div class="crm-company-thread-text">${esc(entry.text)}</div>
            </div>`).join("") : `<div class="crm-company-none">No thread yet</div>`}
        </div>
      </section>`;
  };

  const buildExpander = (target) => {
    const summary = summaryForKey(target?.dataset?.companyKey) || cache.summaries[0];
    const world = document.createElement("div");
    world.className = "crm-company-world";
    world.dataset.companyKey = summary?.key || "";
    if (!summary) return world;
    world.innerHTML = `
      <header class="crm-company-world-head">
        <div class="crm-company-world-title">${esc(summary.label)}</div>
        <div class="crm-company-world-stats">${esc([summary.cardCount ? `${summary.cardCount} cards` : "", moneyText(summary.openValue), summary.totalThread ? `${summary.totalThread} thread` : ""].filter(Boolean).join(" / "))}</div>
      </header>
      <div class="crm-company-world-body">
        <div class="crm-company-records">
          ${laneHTML("People", "contacts", summary.contacts)}
          ${laneHTML("Deals", "deals", summary.deals)}
          ${laneHTML("Invoices", "invoices", summary.invoices)}
        </div>
        ${threadHTML(summary)}
      </div>`;
    return world;
  };

  camera = window.createFractalCamera({
    apiName: "crmCompanyCamera",
    theater: "company-dive",
    surfaceClass: "crm-company-surface",
    layerClass: "crm-company-level",
    warmClass: "crm-company-warm",
    contractingClass: "crm-company-contracting",
    active: false,
    maxLevel: 1,
    margin: 16,
    ensureStyles,
    buildRoot,
    layout,
    targetFromEvent,
    targetAtPoint,
    buildExpander,
    keyOf: (target) => target?.dataset?.companyKey || "",
    sourceSelector: (target) => `.crm-company-bucket[data-company-key="${cssEsc(target?.dataset?.companyKey || "")}"]`,
  });

  const openRecordDetail = async (entity, id, card) => {
    const spec = specFor(entity);
    const detail = spec?.detail?.();
    if (!detail?.open || !id) return;
    try {
      const result = await spec.bridge()?.get?.(id);
      const record = result?.record || result?.ticket || (result?.id ? result : null);
      if (record) detail.open(record, card);
    } catch {}
  };

  document.addEventListener("click", (event) => {
    if (!camera?.isActive?.()) return;
    const node = event.target?.closest?.("[data-company-record]");
    if (!node || !camera.surface()?.contains(node)) return;
    const text = String(node.dataset.companyRecord || "");
    const split = text.indexOf(":");
    if (split <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    openRecordDetail(text.slice(0, split), text.slice(split + 1), node);
  }, true);

  document.addEventListener("keydown", (event) => {
    if (!camera?.isActive?.()) return;
    if (event.target && /INPUT|TEXTAREA/.test(event.target.tagName)) return;
    if (event.key === "Escape" && camera.level?.() === 0) {
      api.setActive(false);
    }
  });

  const subscribe = () => {
    if (subscribed) return;
    subscribed = true;
    const schedule = () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(async () => {
        await loadData(true);
        if (active) camera.rebuildRoot();
      }, 160);
    };
    try { window.crmStore?.onChanged?.(schedule); } catch {}
    try { window.tickets?.onChanged?.(schedule); } catch {}
  };

  const openCompany = async (key) => {
    await loadData(true);
    subscribe();
    api.setActive(true);
    camera.rebuildRoot();
    requestAnimationFrame(() => {
      const selector = `.crm-company-bucket[data-company-key="${cssEsc(key || "")}"]`;
      const target = camera.surface()?.querySelector(selector);
      if (target) camera.expand(target);
    });
  };

  const companyKeyForRecord = async (record, entity = record?.targetEntity || record?.entity || record?.type) => {
    await loadData();
    const normalized = normalizeEntity(entity);
    if (normalized === "companies") return record?.companyKey || (record?.id ? `id:${record.id}` : companyKeyFromName(titleOf("companies", record)));
    const id = String(record?.id || record?.targetId || "").trim();
    if (id) {
      const summary = cache.summaries.find((candidate) => {
        if (normalized === "interactions") return candidate.interactions.some((item) => String(item.id || "") === id);
        return recordEntities.includes(normalized) && (candidate[normalized] || []).some((item) => String(item.id || "") === id);
      });
      if (summary) return summary.key;
    }
    const name = inferredCompanyName(normalized, record);
    const byName = companyKeyFromName(name);
    const companyId = firstText(valueOf(record, "companyId"));
    if (companyId) return `id:${companyId}`;
    return byName;
  };

  const openForRecord = async (record, entity) => {
    const key = record?.companyKey || await companyKeyForRecord(record, entity);
    if (key) openCompany(key);
  };

  const api = {
    setActive: (on) => {
      active = !!on;
      subscribe();
      camera.setActive(active);
      document.body.dataset.crmCompanyDive = active ? "true" : "false";
      return api;
    },
    isActive: () => active,
    refresh: async () => {
      await loadData(true);
      camera.refresh();
    },
    openCompany,
    openForRecord,
    companyKeyForRecord,
    summaries: async (force = false) => (await loadData(force)).summaries.map(summaryAsRecord),
  };

  window.crmCompanyDive = api;
})();
