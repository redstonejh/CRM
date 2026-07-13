// crm-desk.js — the actionable operating surface. Home and Today are one desk.
(() => {
  let root = null;
  let active = false;
  let model = null;
  let timer = 0;
  const esc = (value) => String(value ?? "").replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
  const rows = (result) => result?.records || [];
  const first = (...values) => values.map((v) => String(v ?? "").trim()).find(Boolean) || "";
  const meta = (record) => record?.meta && typeof record.meta === "object" ? record.meta : {};
  const val = (record, key) => record?.[key] ?? meta(record)[key];
  const title = (record) => first(val(record, "name"), val(record, "title"), val(record, "client"), val(record, "number"), record?.companyLabel, record?.id, "Untitled");
  const done = (item) => ["completed", "cancelled", "canceled"].includes(String(item.status || "").toLowerCase());
  const dueMs = (item) => Date.parse(item.dueAt || "") || Number.MAX_SAFE_INTEGER;
  const dayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const dayEnd = () => dayStart() + 86400000;
  const dueLabel = (item) => {
    if (!item.dueAt) return "Unscheduled";
    const ms = dueMs(item); const delta = Math.floor((ms - dayStart()) / 86400000);
    if (ms < dayStart()) return `${Math.max(1, Math.ceil((dayStart() - ms) / 86400000))}d overdue`;
    if (delta === 0) return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (delta === 1) return "Tomorrow";
    return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
  };
  const workStages = {
    sales: ["lead", "qualified", "proposal", "negotiation", "won"],
    jobs: ["intake", "planned", "active", "review", "complete"],
    money: ["draft", "sent", "overdue", "paid"],
    cases: ["new", "triage", "investigation", "resolution", "closed"],
  };
  const workLabels = { sales: "Pipeline", jobs: "Jobs", money: "Money", cases: "Cases" };

  function ensureStyles() {
    if (document.getElementById("crm-desk-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-desk-styles";
    style.textContent = `
      /* Only the separate title-bar strip owns Electron app regions. Keeping
         this full-window room neutral prevents it from excluding the strip. */
      .crm-desk-surface { position:fixed; inset:0; z-index:835; color:rgba(243,247,253,.93); pointer-events:auto; overflow:hidden; }
      .crm-desk-surface[hidden] { display:none; }
      .crm-desk-frame { position:absolute; inset:54px 56px 90px; display:grid; grid-template-rows:auto minmax(0,1fr); max-width:1500px; margin:auto; }
      .crm-desk-head { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; padding:0 2px 22px; }
      .crm-desk-date { font:650 18px/1.15 system-ui; letter-spacing:-.015em; color:rgba(245,248,253,.9); }
      .crm-desk-brief { margin-top:6px; font-size:11px; color:rgba(211,222,239,.48); }
      .crm-desk-new { border:1px solid rgba(174,202,244,.2); border-radius:10px; background:rgba(126,165,220,.09); color:rgba(230,239,253,.82); padding:8px 11px; font:620 11px system-ui; cursor:pointer; }
      .crm-desk-new:hover { background:rgba(126,165,220,.18); color:#fff; }
      .crm-desk-grid { min-height:0; display:grid; grid-template-columns:minmax(310px,.84fr) minmax(430px,1.25fr) minmax(290px,.8fr); gap:13px; }
      .crm-desk-panel { min-height:0; display:flex; flex-direction:column; overflow:hidden; border:1px solid rgba(255,255,255,.115); border-radius:19px;
        background:linear-gradient(155deg,rgba(26,31,41,.72),rgba(10,14,21,.64)); backdrop-filter:blur(26px) saturate(120%);
        box-shadow:inset 0 1px rgba(255,255,255,.1),0 20px 52px rgba(0,0,0,.24); }
      .crm-desk-panel-head { display:flex; align-items:baseline; justify-content:space-between; gap:10px; padding:17px 18px 12px; }
      .crm-desk-panel-title { font-size:10px; font-weight:750; text-transform:uppercase; letter-spacing:.13em; color:rgba(182,203,233,.64); }
      .crm-desk-panel-count { font-size:10px; color:rgba(219,227,240,.35); }
      .crm-desk-scroll { min-height:0; overflow:auto; padding:0 11px 13px; scrollbar-width:thin; scrollbar-color:rgba(255,255,255,.17) transparent; }
      .crm-desk-commitments { display:grid; gap:5px; }
      .crm-desk-commitment { position:relative; display:grid; grid-template-columns:21px minmax(0,1fr) auto; gap:9px; align-items:center; min-height:54px; padding:8px 9px;
        border:1px solid transparent; border-radius:11px; background:rgba(255,255,255,.026); transition:background .14s,border-color .14s,transform .14s; }
      .crm-desk-commitment:hover { background:rgba(255,255,255,.058); border-color:rgba(255,255,255,.07); transform:translateX(2px); }
      .crm-desk-check { width:18px; height:18px; border-radius:50%; border:1px solid rgba(204,219,241,.34); background:transparent; cursor:pointer; }
      .crm-desk-check:hover { border-color:rgba(146,192,255,.86); background:rgba(105,162,240,.15); }
      .crm-desk-commitment-main { min-width:0; cursor:pointer; }
      .crm-desk-commitment-title { font-size:12px; line-height:1.3; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .crm-desk-commitment-context { margin-top:4px; font-size:9px; color:rgba(214,224,240,.38); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .crm-desk-due { padding:4px 6px; border-radius:6px; font-size:9px; color:rgba(215,226,242,.51); white-space:nowrap; }
      .crm-desk-due.is-late { color:rgba(247,167,147,.88); background:rgba(187,75,55,.09); }
      .crm-desk-divider { display:flex; align-items:center; gap:8px; padding:12px 5px 7px; font-size:9px; text-transform:uppercase; letter-spacing:.1em; color:rgba(211,222,239,.35); }
      .crm-desk-divider:after { content:""; flex:1; height:1px; background:rgba(255,255,255,.065); }
      .crm-desk-work-groups { display:grid; gap:13px; }
      .crm-desk-work-head { display:flex; justify-content:space-between; align-items:center; padding:0 3px 7px; }
      .crm-desk-work-name { font-size:10px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:rgba(205,220,242,.56); }
      .crm-desk-work-count { font-size:9px; color:rgba(212,223,239,.3); }
      .crm-desk-work-deck { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px; }
      .crm-desk-work-card { position:relative; min-width:0; height:92px; padding:10px; text-align:left; color:inherit; cursor:pointer; overflow:hidden;
        border:1px solid rgba(255,255,255,.08); border-radius:12px; background:linear-gradient(155deg,rgba(105,128,166,.13),rgba(255,255,255,.025)); }
      .crm-desk-work-card:hover { border-color:rgba(157,193,244,.28); background:linear-gradient(155deg,rgba(105,145,205,.2),rgba(255,255,255,.035)); }
      .crm-desk-work-title { font-size:11px; font-weight:620; line-height:1.25; height:29px; overflow:hidden; }
      .crm-desk-work-meta { margin-top:5px; font-size:9px; text-transform:capitalize; color:rgba(217,227,242,.42); }
      .crm-desk-stagebar { position:absolute; left:10px; right:10px; bottom:10px; display:grid; grid-auto-flow:column; grid-auto-columns:1fr; gap:3px; }
      .crm-desk-stagebar i { height:3px; border-radius:8px; background:rgba(255,255,255,.095); }
      .crm-desk-stagebar i.is-on { background:rgba(137,180,240,.7); }
      .crm-desk-activity { position:relative; display:grid; gap:2px; padding:7px 5px 12px 20px; }
      .crm-desk-activity:before { content:""; position:absolute; left:5px; top:12px; width:5px; height:5px; border-radius:50%; background:rgba(151,184,231,.58); }
      .crm-desk-activity:after { content:""; position:absolute; left:7px; top:19px; bottom:-2px; width:1px; background:rgba(255,255,255,.07); }
      .crm-desk-activity:last-child:after { display:none; }
      .crm-desk-activity-when { font-size:9px; color:rgba(211,222,239,.34); }
      .crm-desk-activity-text { font-size:11px; line-height:1.4; color:rgba(235,240,248,.72); }
      .crm-desk-empty { padding:15px 7px; font-size:11px; line-height:1.5; color:rgba(217,226,240,.34); }
      .crm-desk-composer { position:fixed; z-index:7300; top:76px; right:58px; width:min(360px,calc(100vw - 40px)); padding:13px; display:grid; gap:8px;
        border:1px solid rgba(255,255,255,.15); border-radius:14px; background:rgba(17,22,30,.94); box-shadow:0 24px 70px rgba(0,0,0,.48); }
      .crm-desk-composer[hidden] { display:none; }
      .crm-desk-input { width:100%; box-sizing:border-box; min-height:35px; padding:8px 9px; color:#fff; background:rgba(0,0,0,.18); border:1px solid rgba(255,255,255,.12); border-radius:8px; outline:none; font:12px system-ui; }
      .crm-desk-composer-actions { display:flex; justify-content:flex-end; gap:7px; }
      @media(max-width:1050px){.crm-desk-frame{inset:50px 25px 86px}.crm-desk-grid{grid-template-columns:.9fr 1.2fr}.crm-desk-panel:last-child{display:none}}
    `;
    document.head.appendChild(style);
  }

  async function load() {
    const [commitmentResult, activityResult, flowResult] = await Promise.all([
      window.crmDomain.list("commitments", { includeDeleted: false, limit: 300 }),
      window.crmDomain.list("activities", { includeDeleted: false, limit: 40 }),
      window.crmDomain.list("workflow-entries", { includeDeleted: false, limit: 200 }),
    ]);
    const commitments = rows(commitmentResult).filter((item) => !done(item));
    const flows = rows(flowResult).filter((item) => !item.deletedAt && !["won", "lost", "paid", "closed", "complete", "completed"].includes(String(item.stage).toLowerCase()));
    const refs = new Map();
    commitments.forEach((item) => (item.links || []).forEach((link) => refs.set(`${link.entityType}:${link.recordId}`, link)));
    flows.forEach((flow) => refs.set(`${flow.entityType}:${flow.recordId}`, flow));
    const entityGroups = new Map();
    refs.forEach((_, key) => { const entity = key.slice(0, key.indexOf(":")); if (!entityGroups.has(entity)) entityGroups.set(entity, []); });
    await Promise.all([...entityGroups.keys()].map(async (entity) => {
      const result = await window.crmStore.list(entity, { includeDeleted: false });
      entityGroups.set(entity, new Map((result?.records || []).map((record) => [String(record.id), record])));
    }));
    const recordFor = (entity, id) => entityGroups.get(entity)?.get(String(id)) || null;
    commitments.forEach((item) => {
      const link = (item.links || []).find((candidate) => recordFor(candidate.entityType, candidate.recordId));
      item.context = link ? { ...link, record: recordFor(link.entityType, link.recordId) } : null;
    });
    flows.forEach((flow) => { flow.record = recordFor(flow.entityType, flow.recordId); });
    return { commitments, activities: rows(activityResult), flows };
  }

  function stageBar(flow) {
    const stages = workStages[flow.workflowKey] || [flow.stage];
    const at = Math.max(0, stages.indexOf(String(flow.stage).toLowerCase()));
    return `<div class="crm-desk-stagebar" aria-label="${esc(flow.stage)} stage">${stages.map((_, index) => `<i class="${index <= at ? "is-on" : ""}"></i>`).join("")}</div>`;
  }
  function commitmentHTML(item) {
    const late = item.dueAt && dueMs(item) < dayStart();
    const context = item.context;
    return `<div class="crm-desk-commitment" data-commitment-id="${esc(item.id)}">
      <button class="crm-desk-check" type="button" data-complete="${esc(item.id)}" aria-label="Complete ${esc(item.title)}"></button>
      <div class="crm-desk-commitment-main"${context ? ` data-record-entity="${esc(context.entityType)}" data-record-id="${esc(context.recordId)}"` : ""}><div class="crm-desk-commitment-title">${esc(item.title)}</div><div class="crm-desk-commitment-context">${esc(context ? title(context.record) : first(item.kind, item.assignee, "Commitment"))}</div></div>
      <div class="crm-desk-due${late ? " is-late" : ""}">${esc(dueLabel(item))}</div>
    </div>`;
  }
  function workHTML(flow) {
    return `<button class="crm-desk-work-card" type="button" data-record-entity="${esc(flow.entityType)}" data-record-id="${esc(flow.recordId)}"><div class="crm-desk-work-title">${esc(title(flow.record || { id: flow.recordId }))}</div><div class="crm-desk-work-meta">${esc(flow.stage)}${flow.owner ? ` · ${esc(flow.owner)}` : ""}</div>${stageBar(flow)}</button>`;
  }
  function activityHTML(item) {
    const date = new Date(item.occurredAt || item.createdAt);
    return `<div class="crm-desk-activity"><div class="crm-desk-activity-when">${esc(Number.isFinite(date.getTime()) ? date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "")}${item.actor ? ` · ${esc(item.actor)}` : ""}</div><div class="crm-desk-activity-text">${esc(first(item.content, item.kind))}</div></div>`;
  }

  function render() {
    if (!root || !model) return;
    const overdue = model.commitments.filter((item) => item.dueAt && dueMs(item) < dayStart()).sort((a, b) => dueMs(a) - dueMs(b));
    const today = model.commitments.filter((item) => item.dueAt && dueMs(item) >= dayStart() && dueMs(item) < dayEnd()).sort((a, b) => dueMs(a) - dueMs(b));
    const next = model.commitments.filter((item) => !item.dueAt || dueMs(item) >= dayEnd()).sort((a, b) => dueMs(a) - dueMs(b)).slice(0, 30);
    const grouped = Object.fromEntries(Object.keys(workLabels).map((key) => [key, model.flows.filter((flow) => flow.workflowKey === key)]));
    const now = new Date();
    const date = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    const brief = overdue.length ? `${overdue.length} overdue · ${today.length} due today` : today.length ? `${today.length} due today · the rest can wait` : "Nothing is on fire. Protect the next useful move.";
    root.innerHTML = `<div class="crm-desk-frame">
      <header class="crm-desk-head"><div><div class="crm-desk-date">${esc(date)}</div><div class="crm-desk-brief">${esc(brief)}</div></div><button class="crm-desk-new" type="button" data-new-commitment>New commitment</button></header>
      <div class="crm-desk-grid">
        <section class="crm-desk-panel"><div class="crm-desk-panel-head"><div class="crm-desk-panel-title">Commitments</div><div class="crm-desk-panel-count">${model.commitments.length} open</div></div><div class="crm-desk-scroll crm-desk-commitments">
          ${overdue.length ? `<div class="crm-desk-divider">Overdue</div>${overdue.map(commitmentHTML).join("")}` : ""}
          ${today.length ? `<div class="crm-desk-divider">Today</div>${today.map(commitmentHTML).join("")}` : ""}
          ${next.length ? `<div class="crm-desk-divider">Next</div>${next.map(commitmentHTML).join("")}` : ""}
          ${!model.commitments.length ? `<div class="crm-desk-empty">No open commitments. Create one only when someone has genuinely promised a next action.</div>` : ""}
        </div></section>
        <section class="crm-desk-panel"><div class="crm-desk-panel-head"><div class="crm-desk-panel-title">Work in motion</div><div class="crm-desk-panel-count">${model.flows.length} active</div></div><div class="crm-desk-scroll crm-desk-work-groups">
          ${Object.entries(grouped).map(([key, flows]) => `<section><div class="crm-desk-work-head"><div class="crm-desk-work-name">${esc(workLabels[key])}</div><div class="crm-desk-work-count">${flows.length}</div></div>${flows.length ? `<div class="crm-desk-work-deck">${flows.slice(0, 8).map(workHTML).join("")}</div>` : `<div class="crm-desk-empty">No active ${esc(workLabels[key].toLowerCase())}.</div>`}</section>`).join("")}
        </div></section>
        <section class="crm-desk-panel"><div class="crm-desk-panel-head"><div class="crm-desk-panel-title">What changed</div><div class="crm-desk-panel-count">latest</div></div><div class="crm-desk-scroll">${model.activities.length ? model.activities.slice(0, 35).map(activityHTML).join("") : `<div class="crm-desk-empty">Activity will appear here when calls, notes, meetings, and outcomes are recorded.</div>`}</div></section>
      </div>
    </div><form class="crm-desk-composer" data-desk-composer hidden><input class="crm-desk-input" name="title" placeholder="What must happen?" required><input class="crm-desk-input" name="dueAt" type="datetime-local"><div class="crm-desk-composer-actions"><button class="crm-desk-new" type="button" data-cancel-new>Cancel</button><button class="crm-desk-new" type="submit">Create commitment</button></div></form>`;
  }

  async function refresh() { model = await load(); render(); }
  async function miniature() {
    if (!root) mount();
    await refresh();
    const clone = root.cloneNode(true);
    clone.hidden = false;
    clone.removeAttribute("data-crm-theater");
    clone.querySelector("[data-desk-composer]")?.remove();
    Object.assign(clone.style, { position: "absolute", left: "50%", top: "50%", width: "1280px", height: "860px", transform: "translate(-50%,-50%) scale(.285)", transformOrigin: "center", pointerEvents: "none" });
    return clone;
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 120); };
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
    root.className = "crm-desk-surface";
    root.dataset.crmTheater = "desk";
    root.hidden = true;
    document.body.appendChild(root);
    root.addEventListener("click", async (event) => {
      const create = event.target.closest("[data-new-commitment]");
      if (create) { root.querySelector("[data-desk-composer]").hidden = false; root.querySelector("[data-desk-composer] input")?.focus(); return; }
      if (event.target.closest("[data-cancel-new]")) { root.querySelector("[data-desk-composer]").hidden = true; return; }
      const complete = event.target.closest("[data-complete]");
      if (complete) {
        const item = model.commitments.find((candidate) => candidate.id === complete.dataset.complete);
        await window.crmDomain.update("commitments", item.id, { status: "completed", completedAt: new Date().toISOString(), outcome: "Completed" }, item.version);
        return refresh();
      }
      const target = event.target.closest("[data-record-entity][data-record-id]");
      if (target) window.crmRecordWorld?.open?.(target.dataset.recordEntity, target.dataset.recordId, target);
    });
    root.addEventListener("contextmenu", async (event) => {
      const target = event.target.closest("[data-record-entity][data-record-id]");
      if (!target || !["ticket", "tickets", "case", "cases"].includes(String(target.dataset.recordEntity || "").toLowerCase())) return;
      event.preventDefault(); event.stopPropagation();
      await window.ticketStacks?.contextMenu?.(target.dataset.recordId, target, event.clientX, event.clientY);
    });
    root.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target; const data = new FormData(form); const rawDue = String(data.get("dueAt") || "");
      await window.crmDomain.create("commitments", { title: data.get("title"), kind: "task", dueAt: rawDue ? new Date(rawDue).toISOString() : null });
      form.hidden = true; await refresh();
    });
    try { window.crmDomain?.onChanged?.(schedule); } catch {}
    try { window.crmStore?.onChanged?.(schedule); } catch {}
  }
  const api = { setActive, refresh, miniature, isActive: () => active };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
  window.crmDesk = api;
})();
