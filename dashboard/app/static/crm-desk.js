// crm-desk.js — a semantic cross-system Overview whose evidence is made from
// the same literal cards and buckets as the operating rooms.
(() => {
  let root = null;
  let active = false;
  let model = null;
  let timer = 0;

  const rows = (result) => result?.records || [];
  const terminalStages = new Set(["won", "lost", "paid", "closed", "resolved", "complete", "completed", "cancelled", "canceled"]);
  const supportedWorkflows = new Set(["sales", "jobs", "money", "bills", "cases"]);
  const done = (item) => ["completed", "cancelled", "canceled"].includes(String(item?.status || "").toLowerCase());
  const dueMs = (item) => Date.parse(item?.dueAt || "") || Number.MAX_SAFE_INTEGER;
  const dayStart = () => { const date = new Date(); date.setHours(0, 0, 0, 0); return date.getTime(); };
  const normalizeEntity = (entity) => ({
    case: "tickets", cases: "tickets", ticket: "tickets", deal: "deals", job: "jobs",
    invoice: "invoices", bill: "bills", contact: "contacts", person: "contacts",
  }[String(entity || "").toLowerCase()] || String(entity || "").toLowerCase());
  const cardApi = (entity) => ({
    tickets: window.ticketStacks,
    deals: window.dealPipeline,
    jobs: window.jobPipeline,
    invoices: window.moneyPipeline,
    bills: window.billPipeline,
    contacts: window.peopleCards,
  }[normalizeEntity(entity)] || null);
  const systems = [
    { key: "sales", label: "Sales", entity: "deals", module: "pipeline", stages: ["lead", "qualified", "proposal", "negotiation"] },
    { key: "jobs", label: "Work", entity: "jobs", module: "jobs", stages: ["intake", "planned", "active", "review"] },
    { key: "cases", label: "Tickets", entity: "tickets", module: "cases", stages: ["triage", "investigation", "resolution"] },
    { key: "bills", label: "Bills", entity: "bills", module: "bills", stages: ["upcoming", "due", "overdue"] },
    { key: "money", label: "Invoices", entity: "invoices", module: "invoices", stages: ["draft", "sent", "overdue"] },
  ];

  function ensureStyles() {
    if (document.getElementById("crm-overview-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-overview-styles";
    style.textContent = `
      .crm-overview-surface{position:fixed;inset:0;z-index:835;color:#fff;pointer-events:auto;overflow:hidden}
      .crm-overview-surface[hidden]{display:none}
      .crm-overview-frame{position:absolute;inset:58px 48px 86px;max-width:1320px;margin:auto;display:grid;grid-template-rows:58px minmax(0,1fr)}
      .crm-overview-head{display:flex;align-items:flex-end;justify-content:space-between;padding:0 4px 15px}
      .crm-overview-date{font:650 18px/1.15 system-ui;letter-spacing:-.015em;color:#fff}
      .crm-overview-brief{margin-top:6px;font-size:11px;color:rgba(255,255,255,.62)}
      .crm-overview-panels{min-height:0;display:grid;grid-template-columns:290px minmax(610px,1fr) 290px;gap:18px}
      .crm-overview-panel{min-width:0;min-height:0;display:grid;grid-template-rows:38px minmax(0,1fr);padding:9px 6px;overflow:hidden}
      .crm-overview-panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 12px}
      .crm-overview-panel-title{font-size:.95rem;font-weight:700;color:#fff}
      .crm-overview-panel-count{font-size:.78rem;color:rgba(255,255,255,.62)}
      .crm-overview-panel-body{position:relative;min-height:0;overflow:hidden}
      .crm-overview-metric{position:absolute;left:12px;right:12px;top:4px;height:92px;display:flex;align-items:flex-end;gap:10px;padding-bottom:10px;box-sizing:border-box}
      .crm-overview-metric-value{font:680 54px/.82 system-ui;letter-spacing:-.055em;color:#fff}
      .crm-overview-metric-copy{padding-bottom:2px;font-size:11px;line-height:1.35;color:rgba(255,255,255,.62)}
      .crm-overview-work-summary{position:absolute;left:10px;right:10px;top:5px;height:88px;display:grid;grid-template-columns:repeat(4,1fr);gap:5px}
      .crm-overview-summary-cell{display:flex;flex-direction:column;justify-content:flex-end;padding:0 7px 10px;color:rgba(255,255,255,.62)}
      .crm-overview-summary-value{font:680 27px/1 system-ui;letter-spacing:-.035em;color:#fff}.crm-overview-summary-label{margin-top:4px;font-size:10px}
      .crm-overview-work-groups{position:absolute;left:0;right:0;top:98px;bottom:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:4px 10px;padding:4px}
      .crm-overview-work-group{position:relative;min-width:0;min-height:0;overflow:hidden}
      .crm-overview-work-head{height:30px;display:flex;align-items:center;justify-content:space-between;padding:0 10px;color:rgba(255,255,255,.62)}
      .crm-overview-work-name{font-size:.78rem;font-weight:700}.crm-overview-work-count{font-size:.78rem}
      .crm-overview-work-stack{position:absolute;left:8px;right:8px;top:31px;bottom:3px}
      .crm-overview-work-card.tk-card{position:absolute!important;left:8px!important;right:auto!important;bottom:auto!important;top:50%!important;
        width:122px!important;height:184px!important;margin:0!important;cursor:pointer;z-index:var(--overview-z,1);
        transform:translate3d(var(--group-rest-x),calc(-50% + var(--group-y)),0) rotate(var(--group-r));transition:transform .3s cubic-bezier(.22,1,.26,1)}
      .crm-overview-work-group:is(:hover,:focus-within) .crm-overview-work-card.tk-card{transform:translate3d(var(--group-fan-x),calc(-50% + var(--group-y)),0) rotate(var(--group-r))}
      .crm-overview-work-group:is(:hover,:focus-within) .crm-overview-work-card.tk-card:is(:hover,:focus-visible){transform:translate3d(var(--group-fan-x),calc(-50% + var(--group-y) - 10px),0) rotate(0deg) scale(1.018);z-index:90}
      .crm-overview-card.tk-card:focus-visible{z-index:50}
      .crm-overview-attention-stack,.crm-overview-recent-trail{position:absolute;left:0;right:0;top:98px;bottom:0}
      .crm-overview-stack-card.tk-card,.crm-overview-recent-card.tk-card{position:absolute!important;left:50%!important;right:auto!important;bottom:auto!important;
        width:165px!important;height:249px!important;margin:0!important;cursor:pointer;z-index:var(--overview-z,1);transition:top .32s cubic-bezier(.22,1,.26,1),transform .32s cubic-bezier(.22,1,.26,1)}
      .crm-overview-stack-card.tk-card{top:calc(var(--stack-y) + 20px)!important;transform:translateX(-50%) rotate(var(--stack-r))}
      .crm-overview-attention-stack:is(:hover,:focus-within) .crm-overview-stack-card.tk-card{top:var(--open-y)!important;transform:translateX(-50%) rotate(0deg)}
      .crm-overview-attention-stack:is(:hover,:focus-within) .crm-overview-stack-card.tk-card:is(:hover,:focus-visible){transform:translateX(-50%) translateY(-10px) scale(1.018);z-index:90}
      .crm-overview-recent-card.tk-card{top:calc(var(--trail-y) + var(--trail-start,0px))!important;transform:translateX(calc(-50% + var(--trail-x))) rotate(var(--trail-r));width:160px!important;height:242px!important}
      .crm-overview-recent-card.tk-card:is(:hover,:focus-visible){transform:translateX(calc(-50% + var(--trail-x))) translateY(-8px) rotate(0deg);z-index:90}
      @media(max-width:1180px){.crm-overview-frame{inset:56px 24px 84px}.crm-overview-panels{grid-template-columns:260px minmax(570px,1fr) 260px;gap:12px}}
    `;
    document.head.appendChild(style);
  }

  async function load() {
    const [commitmentResult, activityResult, flowResult, ...systemResults] = await Promise.all([
      window.crmDomain.list("commitments", { includeDeleted: false, limit: 300 }),
      window.crmDomain.list("activities", { includeDeleted: false, limit: 80 }),
      window.crmDomain.list("workflow-entries", { includeDeleted: false, limit: 300 }),
      ...systems.map((system) => window.crmStore.list(system.entity, { includeDeleted: false })),
    ]);
    const commitments = rows(commitmentResult).filter((item) => !done(item));
    const activities = rows(activityResult);
    const flows = rows(flowResult).filter((item) => !item.deletedAt
      && supportedWorkflows.has(String(item.workflowKey || "").toLowerCase())
      && !terminalStages.has(String(item.stage || "").toLowerCase()));

    const references = [];
    const addLinks = (owner, kind) => (owner?.links || []).forEach((link) => references.push({ owner, kind, link }));
    commitments.forEach((item) => addLinks(item, "commitment"));
    activities.forEach((item) => addLinks(item, "activity"));
    flows.forEach((flow) => references.push({ owner: flow, kind: "flow", link: { entityType: flow.entityType, recordId: flow.recordId } }));

    const entityIds = new Map();
    references.forEach(({ link }) => {
      const entity = normalizeEntity(link.entityType);
      if (!entity || !link.recordId || !cardApi(entity)?.createCard) return;
      if (!entityIds.has(entity)) entityIds.set(entity, new Set());
      entityIds.get(entity).add(String(link.recordId));
    });
    const recordsByEntity = new Map(systems.map((system, index) => [
      system.entity, new Map(rows(systemResults[index]).map((record) => [String(record.id), record])),
    ]));
    await Promise.all([...entityIds.keys()].filter((entity) => !recordsByEntity.has(entity)).map(async (entity) => {
      const result = await window.crmStore.list(entity, { includeDeleted: false });
      recordsByEntity.set(entity, new Map(rows(result).map((record) => [String(record.id), record])));
    }));
    const resolveLink = (link) => {
      const entity = normalizeEntity(link?.entityType);
      const record = recordsByEntity.get(entity)?.get(String(link?.recordId || ""));
      return record && cardApi(entity)?.createCard ? { entity, record } : null;
    };

    commitments.forEach((item) => { item.overviewRecord = (item.links || []).map(resolveLink).find(Boolean) || null; });
    activities.forEach((item) => { item.overviewRecord = (item.links || []).map(resolveLink).find(Boolean) || null; });
    flows.forEach((item) => { item.overviewRecord = resolveLink({ entityType: item.entityType, recordId: item.recordId }); });
    const flowedRecords = new Set(flows.filter((item) => item.overviewRecord)
      .map((item) => `${item.overviewRecord.entity}:${item.overviewRecord.record.id}`));
    const sourceFallbacks = systems.flatMap((system) => [...(recordsByEntity.get(system.entity)?.values() || [])]
      .filter((record) => !record.deletedAt && !terminalStages.has(String(record.stage || record.state || "").toLowerCase()))
      .filter((record) => !flowedRecords.has(`${system.entity}:${record.id}`))
      .map((record) => ({
        id: `overview:${system.entity}:${record.id}`, workflowKey: system.key, entityType: system.entity,
        recordId: record.id, stage: String(record.stage || record.state || system.stages[0]).toLowerCase(),
        createdAt: record.createdAt, updatedAt: record.updatedAt || record.createdAt,
        overviewRecord: { entity: system.entity, record },
      })));
    return { commitments, activities, flows: [...flows, ...sourceFallbacks] };
  }

  const uniqueItems = (items, limit = 5) => {
    const seen = new Set();
    return items.filter((item) => {
      const context = item.overviewRecord;
      const key = context ? `${context.entity}:${context.record.id}` : "";
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, limit);
  };

  function priorityWeight(item) {
    return ({ critical: 5, overdue: 5, urgent: 4, high: 3, due: 2 }
      [String(item?.overviewRecord?.record?.priority || item?.overviewRecord?.record?.state || "").toLowerCase()] || 0);
  }

  function overviewDecks() {
    const attention = uniqueItems([
      ...model.commitments.slice().sort((a, b) => dueMs(a) - dueMs(b)),
      ...model.flows.filter((item) => priorityWeight(item) > 0)
        .sort((a, b) => priorityWeight(b) - priorityWeight(a)),
    ], 5);
    const recent = uniqueItems(model.activities
      .slice().sort((a, b) => (Date.parse(b.occurredAt || b.createdAt || "") || 0) - (Date.parse(a.occurredAt || a.createdAt || "") || 0)), 5);
    return [
      { key: "attention", label: "Commitments", items: attention },
      { key: "recent", label: "What changed", items: recent },
    ];
  }

  function workGroups() {
    return systems.map((system) => {
      const all = model.flows.filter((item) => String(item.workflowKey || "").toLowerCase() === system.key)
        .sort((a, b) => (Date.parse(b.updatedAt || b.createdAt || "") || 0) - (Date.parse(a.updatedAt || a.createdAt || "") || 0));
      return {
        key: system.key, label: system.label,
        items: uniqueItems(all, 3),
        total: uniqueItems(all, Number.MAX_SAFE_INTEGER).length,
      };
    }).filter((group) => group.total > 0).slice(0, 4);
  }

  function createOverviewCard(item, mechanism, index) {
    const context = item.overviewRecord;
    const api = cardApi(context.entity);
    const card = api.createCard(context.record, {
      onOpen: (_record, source) => {
        if (context.entity === "tickets") window.ticketStacks?.open?.(context.record, source);
        else window.crmRecordWorld?.open?.(context.entity, context.record.id, source);
      },
      ariaLabel: `${context.record.title || context.record.name || context.record.companyLabel || context.record.id} — open from Overview`,
    });
    card.classList.add("crm-overview-card");
    card.dataset.overviewMechanism = mechanism;
    card.dataset.recordEntity = context.entity;
    card.dataset.recordId = context.record.id;
    card.style.setProperty("--overview-z", String(index + 1));
    if (mechanism === "work") {
      card.classList.add("crm-overview-work-card");
      card.style.setProperty("--group-rest-x", `${index * 40}px`);
      card.style.setProperty("--group-fan-x", `${index * 56}px`);
      card.style.setProperty("--group-y", `${Math.abs(index - 1) * 6}px`);
      card.style.setProperty("--group-r", `${(index - 1) * 1.4}deg`);
    } else if (mechanism === "attention") {
      card.classList.add("crm-overview-stack-card");
      card.style.setProperty("--stack-y", `${index * 34}px`);
      card.style.setProperty("--open-y", `${index * 68}px`);
      card.style.setProperty("--stack-r", `${(index - 1.5) * 1.2}deg`);
    } else {
      card.classList.add("crm-overview-recent-card");
      card.style.setProperty("--trail-y", `${index * 80}px`);
      card.style.setProperty("--trail-x", `${(index - 1.5) * 7}px`);
      card.style.setProperty("--trail-r", `${(index - 1.5) * .8}deg`);
    }
    if (mechanism === "attention") {
      let badges = card.querySelector(".ticket-face-badges");
      if (!badges) { badges = document.createElement("div"); badges.className = "ticket-face-badges"; card.querySelector(".ticket-body")?.appendChild(badges); }
      const chip = document.createElement("span"); chip.className = "ticket-face-chip";
      const late = item.dueAt && dueMs(item) < dayStart(); chip.dataset.tone = late ? "overdue" : "warn";
      chip.textContent = late ? `${Math.max(1, Math.ceil((dayStart() - dueMs(item)) / 86400000))}d overdue` : (item.dueAt ? "Due soon" : "Needs attention");
      badges.appendChild(chip);
    }
    if (mechanism === "recent") {
      let badges = card.querySelector(".ticket-face-badges");
      if (!badges) { badges = document.createElement("div"); badges.className = "ticket-face-badges"; card.querySelector(".ticket-body")?.appendChild(badges); }
      const chip = document.createElement("span"); chip.className = "ticket-face-chip"; chip.textContent = "Recently changed"; badges.appendChild(chip);
    }
    if (context.entity === "tickets") card.addEventListener("contextmenu", (event) => {
      event.preventDefault(); event.stopPropagation();
      window.ticketStacks?.contextMenu?.(context.record, card, event.clientX, event.clientY);
    });
    return card;
  }

  function render() {
    if (!root || !model) return;
    const decks = overviewDecks();
    const groups = workGroups();
    const attention = decks.find((deck) => deck.key === "attention");
    const recent = decks.find((deck) => deck.key === "recent");
    const activeTotal = uniqueItems(model.flows, Number.MAX_SAFE_INTEGER).length;
    const now = new Date();
    const overdueTotal = model.commitments.filter((item) => item.dueAt && dueMs(item) < dayStart()).length;
    const recentTotal = model.activities.filter((item) => (Date.parse(item.occurredAt || item.createdAt || "") || 0) >= now.getTime() - 7 * 86400000).length;
    const date = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    const brief = overdueTotal
      ? `${overdueTotal} overdue · ${activeTotal} active records · ${recentTotal} changes this week`
      : `${activeTotal} records are moving · nothing needs immediate judgment`;
    root.innerHTML = `<div class="crm-overview-frame">
      <header class="crm-overview-head"><div><div class="crm-overview-date">${date}</div><div class="crm-overview-brief">${brief}</div></div></header>
      <div class="crm-overview-panels">
        <section class="crm-overview-panel crm-menu-surface" data-overview-panel="attention">
          <div class="crm-overview-panel-head"><span class="crm-overview-panel-title">${attention.label}</span><span class="crm-overview-panel-count">calculated</span></div>
          <div class="crm-overview-panel-body"><div class="crm-overview-metric"><span class="crm-overview-metric-value">${model.commitments.length}</span><span class="crm-overview-metric-copy">open<br>${overdueTotal} overdue</span></div><div class="crm-overview-attention-stack"></div></div>
        </section>
        <section class="crm-overview-panel crm-menu-surface" data-overview-panel="motion">
          <div class="crm-overview-panel-head"><span class="crm-overview-panel-title">Work in motion</span><span class="crm-overview-panel-count">${activeTotal} active</span></div>
          <div class="crm-overview-panel-body"><div class="crm-overview-work-summary">${groups.map((group) => `<div class="crm-overview-summary-cell crm-menu-item"><span class="crm-overview-summary-value">${group.total}</span><span class="crm-overview-summary-label">${group.label}</span></div>`).join("")}</div><div class="crm-overview-work-groups">${groups.map((group) => `
            <section class="crm-overview-work-group crm-menu-item" data-overview-work-group="${group.key}">
              <div class="crm-overview-work-head"><span class="crm-overview-work-name">${group.label}</span><span class="crm-overview-work-count">${group.total}</span></div>
              <div class="crm-overview-work-stack"></div>
            </section>`).join("")}</div></div>
        </section>
        <section class="crm-overview-panel crm-menu-surface" data-overview-panel="recent">
          <div class="crm-overview-panel-head"><span class="crm-overview-panel-title">${recent.label}</span><span class="crm-overview-panel-count">7 days</span></div>
          <div class="crm-overview-panel-body"><div class="crm-overview-metric"><span class="crm-overview-metric-value">${recentTotal}</span><span class="crm-overview-metric-copy">changes<br>this week</span></div><div class="crm-overview-recent-trail"></div></div>
        </section>
      </div>
    </div>`;
    groups.forEach((group) => {
      const stack = root.querySelector(`[data-overview-work-group="${group.key}"] .crm-overview-work-stack`);
      group.items.forEach((item, index) => stack.appendChild(createOverviewCard(item, "work", index)));
    });
    attention.items.slice(0, 4).forEach((item, index) => root.querySelector(".crm-overview-attention-stack")
      .appendChild(createOverviewCard(item, "attention", index)));
    root.querySelector(".crm-overview-recent-trail").style.setProperty("--trail-start", `${Math.max(0, (4 - Math.min(4, recent.items.length)) * 40)}px`);
    recent.items.slice(0, 4).forEach((item, index) => root.querySelector(".crm-overview-recent-trail")
      .appendChild(createOverviewCard(item, "recent", index)));
  }

  async function refresh() { model = await load(); render(); return model; }
  async function miniature() {
    if (!root) mount();
    await refresh();
    const clone = root.cloneNode(true); clone.hidden = false; clone.removeAttribute("data-crm-theater");
    Object.assign(clone.style, { position: "absolute", left: "50%", top: "50%", width: "1280px", height: "860px", transform: "translate(-50%,-50%) scale(.285)", transformOrigin: "center", pointerEvents: "none" });
    return clone;
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { if (active) refresh(); }, 120); };
  function setActive(on) {
    active = !!on;
    if (!root) mount();
    root.hidden = !active;
    if (active) refresh();
    return api;
  }
  function mount() {
    ensureStyles();
    root = document.createElement("main");
    root.className = "crm-overview-surface";
    root.dataset.crmTheater = "desk";
    root.hidden = true;
    document.body.appendChild(root);
    try { window.crmDomain?.onChanged?.(schedule); } catch {}
    try { window.crmStore?.onChanged?.(schedule); } catch {}
  }
  const api = { setActive, refresh, miniature, isActive: () => active };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
  window.crmDesk = api;
})();
