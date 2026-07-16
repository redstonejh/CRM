// crm-assignments.js — one real commitment moving through an assignment lifecycle.
(() => {
  const FILTER_KEY = "crm-assignments-filter-v2";
  const EXPANDED_KEY = "crm-assignments-expanded-v2";
  const STAGES = [
    { id:"unassigned", title:"Unassigned", kind:"queue" },
    { id:"assigned", title:"Assigned", kind:"assigned" },
    { id:"active", title:"In progress", kind:"active" },
    { id:"blocked", title:"Blocked", kind:"blocked" },
    { id:"done", title:"Done", kind:"done" },
  ];
  const FILTERS = [
    { id:"all", label:"All work" },
    { id:"mine", label:"Assigned to me" },
    { id:"unassigned", label:"Unassigned" },
    { id:"due", label:"Due soon" },
  ];

  const rows = (result) => result?.records || [];
  const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[character]));
  const first = (...values) => values.map((value) => String(value ?? "").trim()).find(Boolean) || "";
  const clone = (value) => typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  const nowIso = () => new Date().toISOString();
  const closed = (item) => ["completed", "cancelled", "canceled"].includes(String(item?.status || "").toLowerCase());
  const contactName = (contact) => first(contact?.name, contact?.title, contact?.client, contact?.id, "Person");
  const recordName = (record) => first(record?.title, record?.name, record?.companyLabel, record?.description, record?.id, "Untitled");
  const dueTime = (item) => Date.parse(item?.dueAt || "") || Number.MAX_SAFE_INTEGER;
  const stageById = (id) => STAGES.find((stage) => stage.id === String(id));
  const stageOf = (item) => {
    if (closed(item)) return "done";
    const explicit = String(item?.assignmentStage || "").toLowerCase();
    if (stageById(explicit)) return explicit;
    return item?.assignedContactId || first(item?.assignee) ? "assigned" : "unassigned";
  };
  const linkOf = (item) => item?.links?.find((link) => link.relation === "assignment-context")
    || ["workItems","tickets","tasks","contacts","companies"].map((entityType) => item?.links?.find((link) => link.entityType === entityType)).find(Boolean)
    || item?.links?.[0] || null;
  const expansionKey = (stageId) => String(stageId || "");

  let root = null;
  let active = false;
  let dirty = true;
  let refreshTimer = 0;
  let refreshPromise = null;
  let refreshTail = Promise.resolve();
  let floating = null;
  let dragItemId = "";
  let currentUser = "";
  let selectedFilter = localStorage.getItem(FILTER_KEY) || "all";
  let expandedStages = (() => { try { const value = JSON.parse(localStorage.getItem(EXPANDED_KEY) || "[]"); return new Set(Array.isArray(value) ? value.map(String) : []); } catch { return new Set(); } })();
  let model = { commitments:[], flows:[], contacts:[], companies:[], tasks:[], tickets:[], workItems:[] };

  const itemById = (id) => model.commitments.find((item) => String(item.id) === String(id));
  const flowFor = (item) => model.flows.find((flow) => flow.workflowKey === "assignments" && flow.entityType === "commitments" && String(flow.recordId) === String(item?.id));
  const targetRecord = (link) => !link ? null : ({
    contacts:model.contacts, companies:model.companies, tasks:model.tasks, tickets:model.tickets, workItems:model.workItems,
  }[link.entityType] || []).find((record) => String(record.id) === String(link.recordId));
  const filteredItems = () => model.commitments.filter((item) => {
    if (selectedFilter === "mine") return !!currentUser && String(item.assignee || "").trim().toLowerCase() === currentUser.toLowerCase();
    if (selectedFilter === "unassigned") return stageOf(item) === "unassigned";
    if (selectedFilter === "due") return !closed(item) && dueTime(item) <= Date.now() + 7 * 86400000;
    return true;
  });
  const sorted = (items) => [...items].sort((a, b) => {
    const rank = Number(a.assignmentRank ?? a.rank ?? Number.MAX_SAFE_INTEGER) - Number(b.assignmentRank ?? b.rank ?? Number.MAX_SAFE_INTEGER);
    return rank || dueTime(a) - dueTime(b) || String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
  });

  function ensureStyles() {
    if (document.getElementById("crm-assignments-styles")) return;
    const style = document.createElement("style"); style.id = "crm-assignments-styles"; style.textContent = `
      .crm-assignments-surface{position:fixed;inset:0;z-index:836;color:#fff;overflow:hidden}.crm-assignments-surface[hidden]{display:none}
      .crm-assignments-frame{position:absolute;inset:var(--crm-canvas-top,78px) var(--crm-canvas-x,64px) var(--crm-canvas-bottom,78px);max-width:1490px;margin:auto;display:grid;grid-template-columns:184px minmax(0,1fr);gap:var(--crm-object-gap,18px);min-height:0}
      .crm-assignment-rail{align-self:start;max-height:100%;box-sizing:border-box;padding:6px;display:grid;grid-template-rows:40px minmax(0,1fr) auto;overflow:hidden}.crm-assignment-rail-head{display:flex;align-items:center;justify-content:space-between;padding:0 7px 0 10px}.crm-assignment-title{font-size:var(--crm-type-object,14px);font-weight:700}.crm-assignment-new.crm-menu-action{width:29px;height:29px;padding:0!important;font-size:17px!important}
      .crm-assignment-filters{min-height:0;display:flex;flex-direction:column;gap:1px;overflow-y:auto}.crm-assignment-filter.crm-menu-action{position:relative;width:100%;min-height:39px;text-align:left}.crm-assignment-filter.is-selected:before{content:"";position:absolute;left:3px;top:12px;width:3px;height:15px;border-radius:2px;background:rgba(166,202,249,.72)}
      .crm-assignment-rail-foot{padding:10px;color:rgba(255,255,255,.34);font-size:var(--crm-type-meta,10px);line-height:1.45}
      .crm-assignment-pipeline{--assignment-stage-width:clamp(164px,calc((100% - 56px)/5),226px);min-width:0;min-height:0;display:flex;align-items:flex-start;justify-content:flex-start;gap:14px;overflow-x:auto;overflow-y:hidden;padding:0 4px 22px;box-sizing:border-box;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}
      .crm-assignment-bucket.tk-zone{position:relative;inset:auto;z-index:auto;flex:0 0 var(--assignment-stage-width);width:var(--assignment-stage-width);height:min(600px,calc(100vh - 184px));min-height:390px;box-sizing:border-box;padding:12px 13px 13px;overflow:hidden;transition:width .18s cubic-bezier(.22,1,.26,1),flex-basis .18s cubic-bezier(.22,1,.26,1),height .18s cubic-bezier(.22,1,.26,1)}
      .crm-assignment-bucket .tk-zone-hd{flex:0 0 30px;padding-right:42px}.crm-assignment-bucket .tk-zone-hd-r{right:0;top:1px;opacity:.72;pointer-events:auto}.crm-assignment-stack-toggle.crm-menu-action{width:28px;height:27px;padding:0!important;display:grid;place-items:center}.crm-assignment-stack-toggle svg{width:13px;height:13px}.crm-assignment-stack-toggle path{fill:none;stroke:currentColor;stroke-width:1.35;stroke-linecap:round;stroke-linejoin:round}.crm-assignment-stack-toggle[aria-expanded="true"]{color:rgba(193,220,255,.96)!important;background:rgba(124,175,241,.1)!important}
      .crm-assignment-bucket.is-drop-target{border-color:rgba(137,188,255,.72)!important;box-shadow:inset 0 1px rgba(255,255,255,.24),0 0 34px rgba(71,139,231,.24)!important}
      .crm-assignment-card-list{min-height:0;flex:1 1 auto;overflow-y:auto;display:flex;flex-direction:column;align-items:center;gap:0;padding:4px 1px 9px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}.crm-assignment-card-list.is-expanded{gap:8px}
      .crm-assignment-work-card{appearance:none;position:relative;flex:0 0 auto;width:calc(100% - 4px);min-height:116px;box-sizing:border-box;padding:12px 13px;text-align:left;border:0;border-radius:15px;color:rgba(255,255,255,.9);background:linear-gradient(150deg,rgba(92,108,131,.95),rgba(54,67,87,.94));box-shadow:inset 0 1px rgba(255,255,255,.22),0 14px 18px -14px rgba(0,0,0,.55);cursor:grab;overflow:hidden;transition:width .18s cubic-bezier(.22,1,.26,1),min-height .18s cubic-bezier(.22,1,.26,1),margin .2s cubic-bezier(.22,1,.26,1),opacity .14s ease,box-shadow .14s ease}.crm-assignments-surface.is-seating .crm-assignment-work-card{transition:none!important}.crm-assignment-work-card+.crm-assignment-work-card{margin-top:-72px}.crm-assignment-card-list.is-expanded .crm-assignment-work-card+.crm-assignment-work-card{margin-top:0}.crm-assignment-work-card[data-priority="high"]{background:linear-gradient(150deg,rgba(133,104,83,.96),rgba(78,63,57,.94))}.crm-assignment-work-card[data-priority="urgent"]{background:linear-gradient(150deg,rgba(142,82,82,.96),rgba(81,50,59,.94))}.crm-assignment-work-card:hover,.crm-assignment-work-card:focus-visible{outline:0;box-shadow:inset 0 0 0 9999px rgba(255,255,255,.09),inset 0 1px rgba(255,255,255,.3),0 16px 22px -14px rgba(0,0,0,.6)}.crm-assignment-work-card.is-dragging{opacity:.3}.crm-assignment-work-card:active{cursor:grabbing}
      .crm-assignment-card-title{display:block;font-size:var(--crm-type-object,14px);font-weight:700;line-height:1.22;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-assignment-card-note{display:-webkit-box;margin-top:7px;color:rgba(255,255,255,.53);font-size:var(--crm-type-meta,10px);line-height:1.35;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.crm-assignment-card-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;color:rgba(255,255,255,.5);font-size:var(--crm-type-meta,10px);white-space:nowrap}.crm-assignment-card-meta span{min-width:0;overflow:hidden;text-overflow:ellipsis}.crm-assignment-card-context{color:rgba(211,227,249,.64)!important}
      .crm-assignment-empty{height:100%;display:grid;place-items:center;padding:15px;text-align:center;color:rgba(255,255,255,.28);font-size:var(--crm-type-caption,11px)}
      .crm-assignment-bucket.crm-object-small{scale:1!important;flex-basis:clamp(142px,calc(var(--assignment-stage-width) - 28px),164px);width:clamp(142px,calc(var(--assignment-stage-width) - 28px),164px);height:min(510px,calc(100vh - 206px));min-height:340px;padding-inline:10px}.crm-assignment-work-card.crm-object-small{scale:1!important;width:clamp(112px,calc(100% - 30px),136px);min-height:78px;padding:10px 11px}.crm-assignment-work-card.crm-object-small+.crm-assignment-work-card{margin-top:-38px}.crm-assignment-card-list.is-expanded .crm-assignment-work-card.crm-object-small+.crm-assignment-work-card{margin-top:0}.crm-assignment-work-card.crm-object-small .crm-assignment-card-note{display:none}.crm-assignment-work-card.crm-object-small .crm-assignment-card-title{font-size:var(--crm-type-body,12px)}.crm-assignment-work-card.crm-object-small .crm-assignment-card-meta{margin-top:7px}
      .crm-assignment-menu{position:fixed;z-index:9320;width:178px;padding:6px;display:grid;gap:1px}.crm-assignment-menu .crm-menu-action{height:33px;text-align:left}
      .crm-assignment-editor{position:fixed;z-index:9330;width:min(380px,calc(100vw - 28px));padding:10px;display:grid;gap:8px}.crm-assignment-editor-title{padding:2px 3px 5px;font-size:var(--crm-type-control,13px);font-weight:700}.crm-assignment-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:7px}.crm-assignment-fields>.crm-wide,.crm-assignment-fields>textarea{grid-column:1/-1}.crm-assignment-fields textarea{min-height:64px;resize:vertical;padding-top:9px}.crm-assignment-editor-actions{display:flex;justify-content:flex-end;gap:2px}.crm-assignment-editor .crm-menu-action{height:32px;font-size:var(--crm-type-body,12px)!important}
      @media(max-width:1250px){.crm-assignments-frame{grid-template-columns:172px minmax(0,1fr);gap:14px}}
      @media(prefers-reduced-motion:reduce){.crm-assignment-work-card,.crm-assignment-bucket{transition-duration:.01ms!important}}
    `; document.head.appendChild(style);
  }

  async function load() {
    const [commitments, flows, contacts, companies, tasks, tickets, workItems, session] = await Promise.all([
      window.crmDomain.list("commitments", { includeDeleted:false, limit:1000 }),
      window.crmDomain.list("workflow-entries", { includeDeleted:false, workflowKey:"assignments", limit:1000 }),
      window.crmStore.list("contacts", { includeDeleted:false }), window.crmStore.list("companies", { includeDeleted:false }), window.crmStore.list("tasks", { includeDeleted:false }),
      window.crmStore.list("tickets", { includeDeleted:false }), window.crmStore.list("workItems", { includeDeleted:false }),
      window.auth?.session?.().catch?.(() => ({ user:null })) || Promise.resolve({ user:null }),
    ]);
    currentUser = first(session?.user?.username, currentUser, "rosa");
    return {
      commitments:rows(commitments).filter((item) => !item.deletedAt), flows:rows(flows).filter((item) => !item.deletedAt),
      contacts:rows(contacts).filter((item) => !item.deletedAt), companies:rows(companies).filter((item) => !item.deletedAt), tasks:rows(tasks).filter((item) => !item.deletedAt),
      tickets:rows(tickets).filter((item) => !item.deletedAt), workItems:rows(workItems).filter((item) => !item.deletedAt),
    };
  }

  const closeFloating = () => { floating?.remove(); floating = null; };
  const placeFloating = (element, anchor, x, y) => {
    document.body.appendChild(element); const source = anchor?.getBoundingClientRect(); const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(10, Math.min(innerWidth - bounds.width - 10, Number.isFinite(x) ? x : (source?.right || innerWidth / 2) - bounds.width))}px`;
    element.style.top = `${Math.max(48, Math.min(innerHeight - bounds.height - 12, Number.isFinite(y) ? y : (source?.bottom || innerHeight / 2) + 5))}px`;
    setTimeout(() => { const outside = (event) => { if (element.contains(event.target)) return; closeFloating(); document.removeEventListener("pointerdown", outside, true); }; document.addEventListener("pointerdown", outside, true); }, 0);
  };

  const dueLabel = (item) => {
    if (!item.dueAt) return "No due date"; const date = new Date(item.dueAt); if (Number.isNaN(date.getTime())) return "No due date";
    const days = Math.ceil((date.getTime() - Date.now()) / 86400000); if (days < 0) return `${Math.abs(days)}d overdue`; if (days === 0) return "Due today"; if (days === 1) return "Due tomorrow";
    return date.toLocaleDateString([], { month:"short", day:"numeric" });
  };
  const contextLabel = (item) => { const link = linkOf(item); if (!link) return "Independent work"; const entity = ({ workItems:"Pipeline", tickets:"Ticket", tasks:"Task", contacts:"Person", companies:"Company" })[link.entityType] || "Work"; return `${entity} · ${recordName(targetRecord(link) || { id:link.recordId })}`; };
  function cardHTML(item) {
    return `<button type="button" class="crm-assignment-work-card" draggable="true" data-assignment-card="${esc(item.id)}" data-record-entity="commitments" data-record-id="${esc(item.id)}" data-crm-size-key="${esc(`card:commitments:${item.id}`)}" data-priority="${esc(String(item.priority || "normal").toLowerCase())}"><span class="crm-assignment-card-title">${esc(first(item.title, "Untitled work"))}</span>${first(item.context, item.note, item.description) ? `<span class="crm-assignment-card-note">${esc(first(item.context, item.note, item.description))}</span>` : ""}<span class="crm-assignment-card-meta"><span>${esc(first(item.assignee, "Unassigned"))}</span><span>${esc(dueLabel(item))}</span></span><span class="crm-assignment-card-meta crm-assignment-card-context"><span>${esc(contextLabel(item))}</span><span>${esc(first(item.priority, "normal"))}</span></span></button>`;
  }

  function render() {
    if (!root) return;
    root.classList.add("is-seating");
    if (!FILTERS.some((filter) => filter.id === selectedFilter)) selectedFilter = "all";
    const visible = filteredItems(); const openCount = model.commitments.filter((item) => !closed(item)).length; const unassignedCount = model.commitments.filter((item) => stageOf(item) === "unassigned").length;
    root.innerHTML = `<div class="crm-assignments-frame"><aside class="crm-assignment-rail crm-menu-surface"><header class="crm-assignment-rail-head crm-menu-item"><span class="crm-assignment-title">Assignments</span><button type="button" class="crm-assignment-new crm-menu-action" data-assignment-action="new" aria-label="Create assignment">+</button></header><nav class="crm-assignment-filters" aria-label="Assignment filters">${FILTERS.map((filter) => `<button type="button" class="crm-assignment-filter crm-menu-action${filter.id === selectedFilter ? " is-selected" : ""}" data-assignment-filter="${filter.id}" aria-pressed="${filter.id === selectedFilter}">${esc(filter.label)}</button>`).join("")}</nav><footer class="crm-assignment-rail-foot">${openCount} open<br>${unassignedCount} unassigned</footer></aside><section class="crm-assignment-pipeline" aria-label="Assignment pipeline">${STAGES.map((stage) => {
      const items = sorted(visible.filter((item) => stageOf(item) === stage.id)); const expanded = expandedStages.has(expansionKey(stage.id));
      return `<section class="crm-assignment-bucket tk-zone${expanded ? " is-stack-expanded" : ""}" data-assignment-stage="${stage.id}" data-stage="${stage.id}" data-crm-size-key="bucket:assignments:${stage.id}"><header class="tk-zone-hd"><span class="tk-zone-title" title="${esc(stage.title)}">${esc(stage.title)}</span><span class="tk-zone-hd-r"><button type="button" class="crm-assignment-stack-toggle crm-menu-action" data-assignment-action="toggle-stack" aria-label="${expanded ? "Collapse" : "Expand"} ${esc(stage.title)} stack" aria-expanded="${expanded}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M3 11.5h10M8 2v5M6.2 3.8 8 2l1.8 1.8M8 14v-5m-1.8 3.2L8 14l1.8-1.8"/></svg></button></span></header><div class="crm-assignment-card-list${expanded ? " is-expanded" : ""}">${items.length ? items.map(cardHTML).join("") : '<div class="crm-assignment-empty">No work here</div>'}</div></section>`;
    }).join("")}</section></div>`;
    window.crmObjectSizing?.scan?.(root);
    requestAnimationFrame(() => requestAnimationFrame(() => root?.classList.remove("is-seating")));
  }

  async function refresh(force = false) {
    if (!force && refreshPromise) return refreshPromise;
    const run = refreshTail.catch(() => null).then(async () => { model = await load(); dirty = false; render(); return model; });
    refreshTail = run; refreshPromise = run; run.finally(() => { if (refreshPromise === run) refreshPromise = null; }).catch(() => {}); return run;
  }
  const schedule = () => { dirty = true; clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (active) refresh(); }, 100); };

  async function syncFlow(item, stageId, rank = 0) {
    const flow = flowFor(item); const fields = { workflowKey:"assignments", entityType:"commitments", recordId:item.id, stage:stageId, rank, owner:item.assignee || null };
    if (flow) {
      let result = await window.crmDomain.update("workflow-entries", flow.id, fields, flow.version);
      if (!result?.ok) { await refresh(true); const fresh = flowFor(itemById(item.id)); if (fresh) result = await window.crmDomain.update("workflow-entries", fresh.id, fields, fresh.version); }
      return result?.record || null;
    }
    return (await window.crmDomain.create("workflow-entries", fields))?.record || null;
  }
  async function updateCommitment(itemId, fields, stageId = null) {
    let item = itemById(itemId); if (!item) return false;
    let result = await window.crmDomain.update("commitments", item.id, fields, item.version);
    if (!result?.ok) { await refresh(true); item = itemById(itemId); if (!item) return false; result = await window.crmDomain.update("commitments", item.id, fields, item.version); }
    if (!result?.record) return false;
    const nextStage = stageId || stageOf(result.record); const rank = model.commitments.filter((candidate) => candidate.id !== itemId && stageOf(candidate) === nextStage).length;
    await syncFlow({ ...item, ...result.record }, nextStage, rank); await refresh(true); return true;
  }
  async function move(itemId, stageId) {
    const item = itemById(itemId); const stage = stageById(stageId); if (!item || !stage) return false;
    const fields = { assignmentStage:stage.id, assignmentRank:model.commitments.filter((candidate) => candidate.id !== item.id && stageOf(candidate) === stage.id).length };
    if (stage.id === "done") Object.assign(fields, { status:"completed", completedAt:nowIso(), outcome:first(item.outcome, "Assignment completed"), assignmentPreviousStage:stageOf(item) });
    else Object.assign(fields, { status:"open", completedAt:null, outcome:null });
    if (stage.id === "unassigned") Object.assign(fields, { assignee:null, assignedContactId:null, assignedContactName:null, assignedAt:null });
    else if (["assigned","active"].includes(stage.id) && !first(item.assignee)) Object.assign(fields, { assignee:currentUser, assignedAt:nowIso() });
    return updateCommitment(item.id, fields, stage.id);
  }
  async function assign(commitmentId, contactId) {
    const person = model.contacts.find((contact) => String(contact.id) === String(contactId)); if (!person || !itemById(commitmentId)) return false;
    return updateCommitment(commitmentId, { assignee:contactName(person), assignedContactId:person.id, assignedContactName:contactName(person), assignedAt:nowIso(), assignmentStage:"assigned", status:"open", completedAt:null }, "assigned");
  }
  const unassign = (commitmentId) => move(commitmentId, "unassigned");

  function targetOptions(item) {
    const records = [["", "No linked record"], ...model.tasks.map((record) => [`tasks:${record.id}`, `Task · ${recordName(record)}`]), ...model.contacts.map((record) => [`contacts:${record.id}`, `Person · ${recordName(record)}`]), ...model.tickets.map((record) => [`tickets:${record.id}`, `Ticket · ${recordName(record)}`]), ...model.workItems.map((record) => [`workItems:${record.id}`, `Pipeline · ${recordName(record)}`])];
    const link = linkOf(item); const selected = link ? `${link.entityType}:${link.recordId}` : "";
    return records.map(([value, label]) => `<option value="${esc(value)}"${selected === value ? " selected" : ""}>${esc(label)}</option>`).join("");
  }
  function openEditor(item = null, anchor = null) {
    closeFloating(); const stageId = item ? stageOf(item) : "unassigned"; const assignedId = String(item?.assignedContactId || "");
    floating = document.createElement("form"); floating.className = "crm-assignment-editor crm-menu-surface";
    floating.innerHTML = `<div class="crm-assignment-editor-title">${item ? "Assignment" : "New assignment"}</div><div class="crm-assignment-fields"><input class="crm-menu-input crm-wide" name="title" value="${esc(item?.title || "")}" placeholder="What needs to happen?" required><textarea class="crm-menu-input" name="context" placeholder="What does done look like?">${esc(first(item?.context, item?.note, item?.description))}</textarea><select class="crm-menu-input" name="stage" aria-label="Stage">${STAGES.map((stage) => `<option value="${stage.id}"${stage.id === stageId ? " selected" : ""}>${esc(stage.title)}</option>`).join("")}</select><select class="crm-menu-input" name="priority" aria-label="Priority">${["normal","high","urgent"].map((value) => `<option value="${value}"${String(item?.priority || "normal") === value ? " selected" : ""}>${value[0].toUpperCase() + value.slice(1)}</option>`).join("")}</select><input class="crm-menu-input" name="dueAt" type="date" value="${esc(String(item?.dueAt || "").slice(0, 10))}" aria-label="Due date"><select class="crm-menu-input" name="assignee" aria-label="Assignee"><option value="">Unassigned</option><option value="__me"${!assignedId && String(item?.assignee || "").toLowerCase() === currentUser.toLowerCase() ? " selected" : ""}>Me · ${esc(currentUser)}</option>${model.contacts.map((contact) => `<option value="${esc(contact.id)}"${assignedId === String(contact.id) ? " selected" : ""}>${esc(contactName(contact))}</option>`).join("")}</select><select class="crm-menu-input crm-wide" name="target" aria-label="Linked record">${targetOptions(item)}</select></div><div class="crm-assignment-editor-actions"><button type="button" class="crm-menu-action" data-cancel>Cancel</button><button type="submit" class="crm-menu-action">${item ? "Save" : "Create"}</button></div>`;
    floating.addEventListener("submit", async (event) => {
      event.preventDefault(); const data = new FormData(floating); const stage = stageById(data.get("stage")) || STAGES[0]; const rawAssignee = String(data.get("assignee") || ""); const contact = model.contacts.find((candidate) => String(candidate.id) === rawAssignee); const rawTarget = String(data.get("target") || ""); const [entityType, ...recordParts] = rawTarget.split(":"); const due = String(data.get("dueAt") || ""); const isDone = stage.id === "done";
      const links = (item?.links || []).filter((link) => link.entityType === "workItems" && link.relation === "regarding"); if (rawTarget && !links.some((link) => link.entityType === entityType && String(link.recordId) === recordParts.join(":"))) links.push({ entityType, recordId:recordParts.join(":"), relation:"assignment-context" });
      const fields = { title:String(data.get("title") || "").trim(), context:String(data.get("context") || ""), kind:first(item?.kind, "assignment"), priority:String(data.get("priority") || "normal"), dueAt:due ? new Date(`${due}T17:00:00`).toISOString() : null, assignmentStage:stage.id, status:isDone ? "completed" : "open", completedAt:isDone ? first(item?.completedAt, nowIso()) : null, links, assignedContactId:contact?.id || null, assignedContactName:contact ? contactName(contact) : null, assignee:contact ? contactName(contact) : rawAssignee === "__me" ? currentUser : null, assignedAt:rawAssignee ? first(item?.assignedAt, nowIso()) : null };
      if (item) await updateCommitment(item.id, fields, stage.id);
      else { const result = await window.crmDomain.create("commitments", fields); if (result?.record) { await window.crmDomain.create("workflow-entries", { workflowKey:"assignments", entityType:"commitments", recordId:result.record.id, stage:stage.id, rank:model.commitments.filter((candidate) => stageOf(candidate) === stage.id).length, owner:fields.assignee || null }); await refresh(true); } }
      closeFloating();
    });
    floating.querySelector("[data-cancel]")?.addEventListener("click", closeFloating); placeFloating(floating, anchor); requestAnimationFrame(() => floating?.elements?.title?.focus());
  }

  async function openLinked(item) {
    const link = linkOf(item); if (!link) return false;
    if (link.entityType === "workItems") return window.crmPlanner?.openItem?.(link.recordId) || false;
    if (link.entityType === "tickets") return window.ticketStacks?.open?.(link.recordId) || false;
    return window.crmRecordWorld?.open?.(link.entityType, link.recordId) || false;
  }
  function openMenu(item, anchor, x, y) {
    closeFloating(); floating = document.createElement("div"); floating.className = "crm-assignment-menu crm-menu-surface";
    const actions = [
      { label:"Edit", run:() => openEditor(item, anchor) },
      linkOf(item) && { label:"Open linked record", run:() => openLinked(item) },
      { label:window.crmObjectSizing?.isSmall?.(anchor, "card") ? "Make large" : "Make small", run:() => window.crmObjectSizing?.toggle?.(anchor, "card") },
      { label:stageOf(item) === "done" ? "Reopen" : "Complete", run:() => move(item.id, stageOf(item) === "done" ? first(item.assignmentPreviousStage, "assigned") : "done") },
      { label:"Delete", danger:true, run:async () => { await window.crmDomain.remove("commitments", item.id); const flow = flowFor(item); if (flow) await window.crmDomain.remove("workflow-entries", flow.id); await refresh(true); } },
    ].filter(Boolean);
    actions.forEach((action) => { const button = document.createElement("button"); button.type = "button"; button.className = `crm-menu-action${action.danger ? " tk-menu-danger" : ""}`; button.textContent = action.label; button.addEventListener("click", () => { closeFloating(); action.run(); }); floating.appendChild(button); });
    placeFloating(floating, anchor, x, y);
  }

  const setStageExpanded = (stageId, open = !expandedStages.has(expansionKey(stageId))) => {
    const key = expansionKey(stageId); if (!stageById(key)) return false; if (open) expandedStages.add(key); else expandedStages.delete(key);
    if (!window.crmHomePreviews?.isCaptureWorker) localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expandedStages]));
    const bucket = root?.querySelector(`[data-assignment-stage="${key}"]`); const list = bucket?.querySelector(".crm-assignment-card-list"); const button = bucket?.querySelector(".crm-assignment-stack-toggle");
    bucket?.classList.toggle("is-stack-expanded", !!open); list?.classList.toggle("is-expanded", !!open); button?.setAttribute("aria-expanded", String(!!open)); button?.setAttribute("aria-label", `${open ? "Collapse" : "Expand"} ${stageById(key).title} stack`);
    return expandedStages.has(key);
  };
  function wire() {
    root.addEventListener("click", (event) => {
      const filter = event.target.closest("[data-assignment-filter]"); if (filter) { selectedFilter = filter.dataset.assignmentFilter; if (!window.crmHomePreviews?.isCaptureWorker) localStorage.setItem(FILTER_KEY, selectedFilter); render(); return; }
      const action = event.target.closest("[data-assignment-action]"); const stageElement = action?.closest("[data-assignment-stage]");
      if (action?.dataset.assignmentAction === "new") { openEditor(null, action); return; }
      if (action?.dataset.assignmentAction === "toggle-stack" && stageElement) { setStageExpanded(stageElement.dataset.assignmentStage); return; }
      const card = event.target.closest("[data-assignment-card]"); if (card) openEditor(itemById(card.dataset.assignmentCard), card);
    });
    root.addEventListener("contextmenu", (event) => { const card = event.target.closest("[data-assignment-card]"); if (!card) return; event.preventDefault(); event.stopPropagation(); const item = itemById(card.dataset.assignmentCard); if (item) openMenu(item, card, event.clientX, event.clientY); });
    root.addEventListener("dragstart", (event) => { const card = event.target.closest("[data-assignment-card]"); if (!card) return; dragItemId = card.dataset.assignmentCard; card.classList.add("is-dragging"); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", dragItemId); });
    root.addEventListener("dragend", (event) => { event.target.closest("[data-assignment-card]")?.classList.remove("is-dragging"); root.querySelectorAll(".is-drop-target").forEach((node) => node.classList.remove("is-drop-target")); dragItemId = ""; });
    root.addEventListener("dragover", (event) => { const bucket = event.target.closest("[data-assignment-stage]"); if (!bucket || !dragItemId) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; root.querySelectorAll(".crm-assignment-bucket").forEach((node) => node.classList.toggle("is-drop-target", node === bucket)); });
    root.addEventListener("dragleave", (event) => { const bucket = event.target.closest("[data-assignment-stage]"); if (bucket && !bucket.contains(event.relatedTarget)) bucket.classList.remove("is-drop-target"); });
    root.addEventListener("drop", async (event) => { const bucket = event.target.closest("[data-assignment-stage]"); if (!bucket || !dragItemId) return; event.preventDefault(); const id = dragItemId; dragItemId = ""; await move(id, bucket.dataset.assignmentStage); });
  }

  function mount() {
    if (root) return root; ensureStyles(); root = document.createElement("main"); root.className = "crm-assignments-surface"; root.dataset.crmTheater = "assignments"; root.hidden = true; document.body.appendChild(root); wire();
    try { window.crmDomain?.onChanged?.(schedule); } catch {} try { window.crmStore?.onChanged?.(schedule); } catch {} refresh(); return root;
  }
  const setActive = (on) => { active = !!on; mount(); root.hidden = !active; if (active && dirty) refresh(); if (!active) closeFloating(); return api; };
  const baseline = async () => { mount(); if (dirty || !model.commitments.length) await refresh(); render(); root.hidden = !active; return root; };
  async function miniature() { await baseline(); const copy = root.cloneNode(true); copy.hidden = false; copy.removeAttribute("data-crm-theater"); Object.assign(copy.style, { position:"absolute", left:"50%", top:"50%", width:"1320px", height:"860px", transform:"translate(-50%,-50%) scale(.285)", transformOrigin:"center", pointerEvents:"none" }); return copy; }
  const open = async (id, anchor) => { if (dirty || !itemById(id)) await refresh(); const item = itemById(id); if (!item) return false; openEditor(item, anchor); return true; };
  const api = { setActive, baseline, miniature, refresh, move, assign, unassign, create:() => openEditor(), open, items:() => clone(model.commitments), stages:() => clone(STAGES), selectFilter:(id) => { selectedFilter = String(id); render(); }, setStageExpanded, expandedStages:() => [...expandedStages], isActive:() => active };
  document.addEventListener("crm:theater-switch", closeFloating);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once:true }); else mount();
  window.crmAssignments = api;
})();
