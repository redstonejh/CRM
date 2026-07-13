// crm-record-world.js — contextual truth for any CRM record.
(() => {
  let root = null;
  let current = null;
  let refreshTimer = 0;

  const esc = (value) => String(value ?? "").replace(/[&<>\"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[char]));
  const first = (...values) => values.map((v) => String(v ?? "").trim()).find(Boolean) || "";
  const records = (result) => result?.records || [];
  const meta = (record) => record?.meta && typeof record.meta === "object" ? record.meta : {};
  const value = (record, key) => record?.[key] ?? meta(record)[key];
  const title = (record) => first(value(record, "name"), value(record, "title"), value(record, "client"), value(record, "number"), record?.companyLabel, record?.id, "Untitled");
  const entityLabel = (entity) => ({
    contacts: "Person", companies: "Company", deals: "Deal", jobs: "Job", cases: "Case",
    tickets: "Case", invoices: "Invoice", tasks: "Task", calendarItems: "Event",
  }[entity] || "Record");
  const bridgeGet = async (entity, id) => {
    const result = await window.crmStore?.get?.(entity, id);
    return result?.record || null;
  };
  const when = (raw) => {
    const date = new Date(raw);
    if (!Number.isFinite(date.getTime())) return "";
    return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };
  const relativeDue = (raw) => {
    const ms = Date.parse(raw || "");
    if (!Number.isFinite(ms)) return "No date";
    const days = Math.round((ms - Date.now()) / 86400000);
    if (days < -1) return `${Math.abs(days)}d overdue`;
    if (days === -1) return "Yesterday";
    if (days === 0) return "Today";
    if (days === 1) return "Tomorrow";
    return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
  };

  function ensureStyles() {
    if (document.getElementById("crm-record-world-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-record-world-styles";
    style.textContent = `
      .record-world-shell { position:fixed; inset:0; z-index:7200; display:grid; place-items:center; padding:38px;
        background:rgba(4,7,12,.48); backdrop-filter:blur(13px) saturate(112%); -webkit-app-region:no-drag; }
      .record-world-shell[hidden] { display:none; }
      .record-world { width:min(1240px, calc(100vw - 76px)); height:min(760px, calc(100vh - 76px)); overflow:hidden;
        display:grid; grid-template-rows:auto minmax(0,1fr); color:rgba(245,247,252,.94); border-radius:22px;
        border:1px solid rgba(255,255,255,.16); background:linear-gradient(155deg,rgba(25,30,40,.94),rgba(10,14,21,.92));
        box-shadow:inset 0 1px rgba(255,255,255,.13),0 34px 100px rgba(0,0,0,.52); }
      .record-world-head { min-height:88px; display:flex; align-items:center; gap:18px; padding:17px 22px;
        border-bottom:1px solid rgba(255,255,255,.09); }
      .record-world-mark { width:42px; height:52px; border-radius:9px; flex:0 0 auto; position:relative;
        background:linear-gradient(180deg,rgba(131,162,213,.4),rgba(70,91,126,.2)); border:1px solid rgba(177,204,246,.28); }
      .record-world-mark:after { content:""; position:absolute; left:8px; right:8px; top:12px; height:1px;
        background:rgba(220,233,255,.58); box-shadow:0 8px rgba(220,233,255,.28),0 16px rgba(220,233,255,.18); }
      .record-world-heading { min-width:0; flex:1; }
      .record-world-kicker { font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:rgba(190,205,230,.52); }
      .record-world-title { margin-top:4px; font:650 23px/1.15 system-ui,sans-serif; letter-spacing:-.018em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .record-world-subtitle { margin-top:5px; font-size:12px; color:rgba(220,227,239,.52); }
      .record-world-close { width:34px; height:34px; border:0; border-radius:50%; color:rgba(240,245,255,.7); cursor:pointer;
        background:rgba(255,255,255,.07); font-size:18px; }
      .record-world-close:hover { background:rgba(255,255,255,.13); color:#fff; }
      .record-world-body { min-height:0; display:grid; grid-template-columns:minmax(230px,.74fr) minmax(370px,1.28fr) minmax(280px,.92fr); }
      .record-world-column { min-width:0; min-height:0; overflow:auto; padding:20px; scrollbar-width:thin; scrollbar-color:rgba(255,255,255,.2) transparent; }
      .record-world-column + .record-world-column { border-left:1px solid rgba(255,255,255,.085); }
      .record-world-section + .record-world-section { margin-top:25px; }
      .record-world-section-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px; }
      .record-world-section-title { font-size:10px; font-weight:720; letter-spacing:.12em; text-transform:uppercase; color:rgba(177,199,233,.62); }
      .record-world-action { border:1px solid rgba(174,202,244,.2); background:rgba(137,174,228,.08); color:rgba(223,235,253,.76);
        border-radius:8px; padding:5px 8px; font:600 10px/1 system-ui; cursor:pointer; }
      .record-world-action:hover { background:rgba(137,174,228,.16); color:#fff; }
      .record-world-facts { display:grid; gap:1px; border:1px solid rgba(255,255,255,.08); border-radius:12px; overflow:hidden; }
      .record-world-fact { min-height:41px; display:grid; grid-template-columns:82px minmax(0,1fr); gap:10px; align-items:center; padding:7px 10px; background:rgba(255,255,255,.028); }
      .record-world-fact-label { font-size:10px; color:rgba(217,225,239,.42); }
      .record-world-fact-value { font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .record-world-related { display:grid; gap:7px; }
      .record-world-related-row { display:grid; grid-template-columns:32px minmax(0,1fr); gap:9px; align-items:center; width:100%;
        border:0; padding:7px; text-align:left; color:inherit; border-radius:10px; background:rgba(255,255,255,.035); cursor:pointer; }
      .record-world-related-row:hover { background:rgba(255,255,255,.075); }
      .record-world-related-icon { width:30px; height:34px; border-radius:7px; background:rgba(139,169,212,.12); border:1px solid rgba(170,196,233,.13); }
      .record-world-related-name { font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .record-world-related-kind { margin-top:2px; font-size:9px; text-transform:uppercase; letter-spacing:.08em; color:rgba(213,223,238,.38); }
      .record-world-flow { border-radius:12px; padding:12px; background:rgba(255,255,255,.035); border:1px solid rgba(255,255,255,.075); }
      .record-world-flow-top { display:flex; justify-content:space-between; font-size:11px; }
      .record-world-flow-name { font-weight:650; text-transform:capitalize; }
      .record-world-flow-stage { color:rgba(213,227,249,.57); text-transform:capitalize; }
      .record-world-flow-bar { display:grid; grid-auto-flow:column; grid-auto-columns:1fr; gap:4px; margin-top:10px; }
      .record-world-flow-bar i { height:3px; border-radius:9px; background:rgba(255,255,255,.1); }
      .record-world-flow-bar i.is-on { background:rgba(137,179,240,.72); box-shadow:0 0 8px rgba(92,151,235,.25); }
      .record-world-commitments { display:grid; gap:7px; }
      .record-world-commitment { display:grid; grid-template-columns:18px minmax(0,1fr) auto; gap:9px; align-items:start; padding:10px;
        border-radius:11px; background:rgba(255,255,255,.036); border:1px solid rgba(255,255,255,.07); }
      .record-world-check { width:16px; height:16px; margin-top:1px; border:1px solid rgba(204,220,244,.36); border-radius:50%; background:transparent; cursor:pointer; }
      .record-world-check:hover { border-color:rgba(151,194,255,.86); background:rgba(113,170,249,.15); }
      .record-world-commitment-title { font-size:12px; line-height:1.35; }
      .record-world-commitment-meta { margin-top:4px; font-size:10px; color:rgba(216,225,240,.43); }
      .record-world-due { font-size:10px; color:rgba(216,225,240,.52); white-space:nowrap; }
      .record-world-due.is-late { color:rgba(244,163,145,.82); }
      .record-world-empty { padding:12px 2px; color:rgba(221,229,242,.38); font-size:11px; line-height:1.5; }
      .record-world-timeline { position:relative; display:grid; gap:2px; }
      .record-world-event { position:relative; padding:7px 4px 14px 21px; }
      .record-world-event:before { content:""; position:absolute; left:5px; top:13px; width:5px; height:5px; border-radius:50%; background:rgba(155,185,229,.66); }
      .record-world-event:after { content:""; position:absolute; left:7px; top:20px; bottom:-3px; width:1px; background:rgba(255,255,255,.09); }
      .record-world-event:last-child:after { display:none; }
      .record-world-event-meta { font-size:9px; color:rgba(211,222,239,.4); }
      .record-world-event-content { margin-top:3px; font-size:11px; line-height:1.45; color:rgba(238,242,249,.77); }
      .record-world-composer { display:grid; gap:8px; padding:10px; border-radius:12px; background:rgba(0,0,0,.13); }
      .record-world-composer[hidden] { display:none; }
      .record-world-input { box-sizing:border-box; width:100%; min-height:34px; border:1px solid rgba(255,255,255,.12); border-radius:8px;
        background:rgba(0,0,0,.18); color:#fff; padding:8px 9px; font:12px system-ui; outline:none; }
      textarea.record-world-input { resize:vertical; min-height:64px; }
      .record-world-input:focus { border-color:rgba(137,179,240,.55); }
      .record-world-composer-actions { display:flex; justify-content:flex-end; gap:6px; }
      @media(max-width:920px){ .record-world { height:calc(100vh - 36px); width:calc(100vw - 36px); } .record-world-body{grid-template-columns:1fr 1.3fr}.record-world-column:last-child{display:none} }
    `;
    document.head.appendChild(style);
  }

  const workflowStages = {
    sales: ["lead", "qualified", "proposal", "negotiation", "won"],
    jobs: ["intake", "planned", "active", "review", "complete"],
    money: ["draft", "sent", "overdue", "paid"],
    cases: ["new", "triage", "investigation", "resolution", "closed"],
  };
  const flowHTML = (flow) => {
    const stages = workflowStages[flow.workflowKey] || [flow.stage];
    const currentIndex = Math.max(0, stages.indexOf(String(flow.stage).toLowerCase()));
    return `<div class="record-world-flow">
      <div class="record-world-flow-top"><span class="record-world-flow-name">${esc(flow.workflowKey)}</span><span class="record-world-flow-stage">${esc(flow.stage)}</span></div>
      <div class="record-world-flow-bar" aria-label="${esc(flow.stage)} stage">${stages.map((_, i) => `<i class="${i <= currentIndex ? "is-on" : ""}"></i>`).join("")}</div>
    </div>`;
  };

  async function load(entity, id) {
    const [record, relationships, commitments, activities, workflows] = await Promise.all([
      bridgeGet(entity, id),
      window.crmDomain.list("relationships", { relatedEntity: entity, relatedId: id }),
      window.crmDomain.list("commitments", { entityType: entity, recordId: id }),
      window.crmDomain.list("activities", { entityType: entity, recordId: id }),
      window.crmDomain.list("workflow-entries", { entityType: entity, recordId: id }),
    ]);
    const relations = records(relationships);
    const related = await Promise.all(relations.map(async (relation) => {
      const fromCurrent = relation.fromEntity === entity && relation.fromId === id;
      const targetEntity = fromCurrent ? relation.toEntity : relation.fromEntity;
      const targetId = fromCurrent ? relation.toId : relation.fromId;
      return { ...relation, targetEntity, targetId, target: await bridgeGet(targetEntity, targetId).catch(() => null) };
    }));
    const history = (Array.isArray(record?.history) ? record.history : []).map((item, index) => ({
      id: `history-${index}`, kind: item.action || "change", occurredAt: item.at || record.updatedAt,
      actor: item.by || "", content: first(item.detail, item.note, item.text, item.action),
    })).filter((item) => item.content);
    return { entity, id, record, relationships: related, commitments: records(commitments), activities: [...records(activities), ...history], workflows: records(workflows) };
  }

  function factsHTML(record, entity) {
    const candidates = [
      ["Role", value(record, "role")], ["Company", value(record, "company") || value(record, "companyName")],
      ["Email", value(record, "email")], ["Phone", value(record, "phone")], ["Owner", value(record, "assignee") || value(record, "owner")],
      ["Value", value(record, "amount") || value(record, "value")], ["State", value(record, "state") || value(record, "status")],
      ["Due", value(record, "dueDate")], ["ID", record?.id],
    ].filter(([, val]) => val !== undefined && val !== null && val !== "").slice(0, 7);
    if (!candidates.length) candidates.push([entityLabel(entity), "No structured details yet"]);
    return `<div class="record-world-facts">${candidates.map(([label, val]) => `<div class="record-world-fact"><span class="record-world-fact-label">${esc(label)}</span><span class="record-world-fact-value">${esc(val)}</span></div>`).join("")}</div>`;
  }

  function render(data) {
    current = data;
    const r = data.record || { id: data.id };
    const openCommitments = data.commitments.filter((item) => !["completed", "cancelled", "canceled"].includes(String(item.status).toLowerCase()) && !item.deletedAt);
    const activity = [...data.activities].sort((a, b) => Date.parse(b.occurredAt || b.createdAt) - Date.parse(a.occurredAt || a.createdAt));
    root.innerHTML = `<article class="record-world" role="dialog" aria-modal="true" aria-label="${esc(title(r))}">
      <header class="record-world-head">
        <div class="record-world-mark" aria-hidden="true"></div>
        <div class="record-world-heading"><div class="record-world-kicker">${esc(entityLabel(data.entity))}</div><div class="record-world-title">${esc(title(r))}</div>
          <div class="record-world-subtitle">${esc(first(value(r, "description"), value(r, "role"), value(r, "company"), `${openCommitments.length} open commitments`))}</div></div>
        <button class="record-world-close" type="button" data-record-close aria-label="Close">×</button>
      </header>
      <div class="record-world-body">
        <div class="record-world-column">
          <section class="record-world-section"><div class="record-world-section-head"><div class="record-world-section-title">Identity</div></div>${factsHTML(r, data.entity)}</section>
          <section class="record-world-section"><div class="record-world-section-head"><div class="record-world-section-title">Relationships</div></div>
            <div class="record-world-related">${data.relationships.length ? data.relationships.map((rel) => `<button class="record-world-related-row" type="button" data-related-entity="${esc(rel.targetEntity)}" data-related-id="${esc(rel.targetId)}"><span class="record-world-related-icon"></span><span><div class="record-world-related-name">${esc(title(rel.target || { id: rel.targetId }))}</div><div class="record-world-related-kind">${esc(rel.kind)}${rel.role ? ` · ${esc(rel.role)}` : ""}</div></span></button>`).join("") : `<div class="record-world-empty">No explicit relationships yet.</div>`}</div>
          </section>
        </div>
        <div class="record-world-column">
          <section class="record-world-section"><div class="record-world-section-head"><div class="record-world-section-title">Active work</div></div>
            ${data.workflows.length ? data.workflows.map(flowHTML).join("") : `<div class="record-world-empty">This record is not in an active workflow.</div>`}
          </section>
          <section class="record-world-section"><div class="record-world-section-head"><div class="record-world-section-title">Commitments</div><button class="record-world-action" type="button" data-show-commitment>New commitment</button></div>
            <form class="record-world-composer" data-commitment-form hidden><input class="record-world-input" name="title" placeholder="What must happen?" required><input class="record-world-input" name="dueAt" type="datetime-local"><div class="record-world-composer-actions"><button class="record-world-action" type="button" data-cancel-composer>Cancel</button><button class="record-world-action" type="submit">Create</button></div></form>
            <div class="record-world-commitments">${openCommitments.length ? openCommitments.map((item) => { const late = item.dueAt && Date.parse(item.dueAt) < Date.now(); return `<div class="record-world-commitment"><button class="record-world-check" type="button" data-complete-commitment="${esc(item.id)}" aria-label="Complete"></button><div><div class="record-world-commitment-title">${esc(item.title)}</div><div class="record-world-commitment-meta">${esc(first(item.kind, "commitment"))}${item.assignee ? ` · ${esc(item.assignee)}` : ""}</div></div><div class="record-world-due${late ? " is-late" : ""}">${esc(relativeDue(item.dueAt))}</div></div>`; }).join("") : `<div class="record-world-empty">Nothing is owed from this record.</div>`}</div>
          </section>
        </div>
        <div class="record-world-column">
          <section class="record-world-section"><div class="record-world-section-head"><div class="record-world-section-title">Activity</div><button class="record-world-action" type="button" data-show-note>Add note</button></div>
            <form class="record-world-composer" data-note-form hidden><textarea class="record-world-input" name="content" placeholder="Record what happened" required></textarea><div class="record-world-composer-actions"><button class="record-world-action" type="button" data-cancel-composer>Cancel</button><button class="record-world-action" type="submit">Add</button></div></form>
            <div class="record-world-timeline">${activity.length ? activity.map((item) => `<div class="record-world-event"><div class="record-world-event-meta">${esc(when(item.occurredAt || item.createdAt))}${item.actor ? ` · ${esc(item.actor)}` : ""}</div><div class="record-world-event-content">${esc(first(item.content, item.kind))}</div></div>`).join("") : `<div class="record-world-empty">No activity has been recorded.</div>`}</div>
          </section>
        </div>
      </div>
    </article>`;
  }

  async function refresh() {
    if (!current) return;
    render(await load(current.entity, current.id));
  }
  const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 100); };

  async function openWorld(entity, id) {
    if (!root) mount();
    root.hidden = false;
    root.innerHTML = `<article class="record-world"><div class="record-world-empty" style="margin:auto">Loading record…</div></article>`;
    render(await load(entity, id));
  }
  const isTicketEntity = (entity) => ["ticket", "tickets", "case", "cases"].includes(String(entity || "").trim().toLowerCase());
  async function open(entity, id, sourceEl) {
    // The ticketing reference owns ticket presentation. `cases` is included for
    // legacy links, but falls back to the CRM record world when the id is not a
    // real ticket id.
    if (isTicketEntity(entity) && window.ticketStacks?.open) {
      const opened = await window.ticketStacks.open(id, sourceEl);
      if (opened) { close(); return true; }
    }
    await openWorld(entity, id);
    return true;
  }
  function close() { if (root) root.hidden = true; current = null; }

  function mount() {
    ensureStyles();
    root = document.createElement("div");
    root.className = "record-world-shell";
    root.hidden = true;
    document.body.appendChild(root);
    // CRM-native entity cards open the contextual record world. Tickets are
    // intentionally excluded: their reference implementation owns a complete
    // left-click flight/detail screen and right-click action system.
    [["contactDetail", "contacts"], ["dealDetail", "deals"], ["invoiceDetail", "invoices"]].forEach(([name, entity]) => {
      const legacy = window[name];
      if (!legacy) return;
      legacy.open = (record) => openWorld(entity, record?.id);
      legacy.close = close;
      legacy.isOpen = () => !!root && !root.hidden;
    });
    root.addEventListener("click", async (event) => {
      if (event.target === root || event.target.closest("[data-record-close]")) return close();
      const related = event.target.closest("[data-related-entity]");
      if (related) return open(related.dataset.relatedEntity, related.dataset.relatedId, related);
      const showCommitment = event.target.closest("[data-show-commitment]");
      if (showCommitment) { root.querySelector("[data-commitment-form]").hidden = false; root.querySelector("[data-commitment-form] input")?.focus(); return; }
      const showNote = event.target.closest("[data-show-note]");
      if (showNote) { root.querySelector("[data-note-form]").hidden = false; root.querySelector("[data-note-form] textarea")?.focus(); return; }
      if (event.target.closest("[data-cancel-composer]")) { event.target.closest("form").hidden = true; return; }
      const complete = event.target.closest("[data-complete-commitment]");
      if (complete) {
        const item = current.commitments.find((c) => c.id === complete.dataset.completeCommitment);
        await window.crmDomain.update("commitments", item.id, { status: "completed", completedAt: new Date().toISOString(), outcome: "Completed" }, item.version);
        return refresh();
      }
    });
    root.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target;
      const data = new FormData(form);
      if (form.matches("[data-commitment-form]")) {
        const dueRaw = String(data.get("dueAt") || "");
        await window.crmDomain.create("commitments", { title: data.get("title"), kind: "follow-up", dueAt: dueRaw ? new Date(dueRaw).toISOString() : null, links: [{ entityType: current.entity, recordId: current.id }] });
      } else if (form.matches("[data-note-form]")) {
        await window.crmDomain.create("activities", { kind: "note", content: data.get("content"), occurredAt: new Date().toISOString(), links: [{ entityType: current.entity, recordId: current.id }] });
      }
      await refresh();
    });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !root.hidden) close(); });
    try { window.crmDomain?.onChanged?.(() => { if (!root.hidden) scheduleRefresh(); }); } catch {}
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
  window.crmRecordWorld = { open, close, isOpen: () => !!root && !root.hidden, refresh };
})();
