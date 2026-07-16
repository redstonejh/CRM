// crm-planner.js — persistent, user-defined multi-stage project pipelines.
(() => {
  const SELECTED_KEY = "crm-planner-selected-v2";
  const LEGACY_KEY = "crm-planner-projects-v1";
  const MIGRATED_KEY = "crm-planner-projects-migrated-v2";
  const listeners = new Set();
  const rows = (result) => result?.records || [];
  const clone = (value) => typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[character]));
  const cssValue = (value) => window.CSS?.escape?.(String(value ?? "")) || String(value ?? "").replace(/["\\]/g, "\\$&");
  const uid = (prefix) => `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  const nowIso = () => new Date().toISOString();
  const first = (...values) => values.map((value) => String(value ?? "").trim()).find(Boolean) || "";
  const DEFAULT_STAGES = [
    { id:"backlog", title:"Backlog", kind:"queue" },
    { id:"active", title:"In progress", kind:"active" },
    { id:"done", title:"Done", kind:"done" },
  ];

  let root = null;
  let active = false;
  let dirty = true;
  let refreshTimer = 0;
  let refreshPromise = null;
  let floating = null;
  let selectedId = localStorage.getItem(SELECTED_KEY) || "";
  let dragItemId = "";
  let model = { projects:[], items:[], flows:[], commitments:[], contacts:[], tasks:[], tickets:[] };

  const normalizeStage = (stage = {}, index = 0) => ({
    id:String(stage.id || uid("stage")), title:first(stage.title, stage.label, `Stage ${index + 1}`),
    kind:String(stage.kind || (index === 0 ? "queue" : "active")), rank:Number.isFinite(Number(stage.rank)) ? Number(stage.rank) : index,
  });
  const stagesOf = (project) => {
    const raw = Array.isArray(project?.stages) && project.stages.length ? project.stages : DEFAULT_STAGES;
    return raw.map(normalizeStage).sort((a, b) => a.rank - b.rank).map((stage, index) => ({ ...stage, rank:index }));
  };
  const normalizeProject = (project = {}) => ({ ...project, id:String(project.id || ""), title:first(project.title, "Untitled project"), note:String(project.note || ""), stages:stagesOf(project) });
  const normalizeItem = (item = {}) => ({ ...item, id:String(item.id || ""), projectId:String(item.projectId || ""), stageId:String(item.stageId || ""), title:first(item.title, "Untitled work"), note:String(item.note || ""), priority:String(item.priority || "normal"), status:String(item.status || "open"), rank:Number(item.rank) || 0 });
  const projectById = (id) => model.projects.find((project) => project.id === String(id));
  const itemById = (id) => model.items.find((item) => item.id === String(id));
  const selectedProject = () => projectById(selectedId) || model.projects[0] || null;
  const stageById = (project, stageId) => stagesOf(project).find((stage) => stage.id === String(stageId));
  const commitmentFor = (item) => model.commitments.find((commitment) => commitment.id === item?.commitmentId)
    || model.commitments.find((commitment) => commitment.links?.some((link) => link.entityType === "workItems" && String(link.recordId) === String(item?.id)));
  const flowFor = (item) => model.flows.find((flow) => flow.entityType === "workItems" && String(flow.recordId) === String(item?.id));
  const contactName = (contact) => first(contact?.name, contact?.title, contact?.id, "Person");
  const recordName = (record) => first(record?.title, record?.name, record?.companyLabel, record?.description, record?.id, "Untitled");

  const writeSelected = () => {
    if (!window.crmHomePreviews?.isCaptureWorker) localStorage.setItem(SELECTED_KEY, selectedId);
  };
  const publish = (reason = "changed") => {
    writeSelected(); render();
    const detail = { reason, selectedId, projects:projectsSnapshot() };
    listeners.forEach((listener) => { try { listener(detail); } catch {} });
    document.dispatchEvent(new CustomEvent("crm:planner-change", { detail }));
  };
  const projectsSnapshot = () => clone(model.projects.map((project) => ({
    ...project,
    buckets:stagesOf(project).map((stage) => ({ ...stage, cards:model.items.filter((item) => item.projectId === project.id && item.stageId === stage.id) })),
  })));

  function ensureStyles() {
    if (document.getElementById("crm-planner-styles")) return;
    const style = document.createElement("style"); style.id = "crm-planner-styles"; style.textContent = `
      .crm-planner-surface{position:fixed;inset:0;z-index:836;color:#fff;overflow:hidden}.crm-planner-surface[hidden]{display:none}
      .crm-planner-frame{position:absolute;inset:var(--crm-canvas-top,78px) var(--crm-canvas-x,64px) var(--crm-canvas-bottom,78px);max-width:1480px;margin:auto;display:grid;grid-template-columns:210px minmax(0,1fr);gap:var(--crm-section-gap,28px);min-height:0}
      .crm-planner-projects{align-self:start;max-height:calc(100vh - var(--crm-canvas-top,78px) - var(--crm-canvas-bottom,78px));box-sizing:border-box;padding:6px;display:grid;grid-template-rows:40px minmax(0,1fr);overflow:hidden}
      .crm-planner-projects-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 7px 0 10px}.crm-planner-projects-title{font-size:var(--crm-type-object,14px);font-weight:680}
      .crm-planner-new-project.crm-menu-action{width:29px;height:29px;padding:0!important;font-size:17px!important}.crm-planner-project-list{min-height:0;display:flex;flex-direction:column;gap:1px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.2) transparent}
      .crm-planner-project-list:empty::after{content:"No projects";padding:9px 10px 12px;color:rgba(255,255,255,.3);font-size:var(--crm-type-meta,10px)}
      .crm-planner-project.crm-menu-action{position:relative;width:100%;min-height:39px;padding:0 10px!important;text-align:left;font-size:var(--crm-type-body,12px)!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-planner-project.is-selected:before{content:"";position:absolute;left:3px;top:12px;width:3px;height:15px;border-radius:2px;background:rgba(166,202,249,.72)}
      .crm-planner-stage{min-width:0;min-height:0;display:grid;grid-template-rows:42px minmax(0,1fr);gap:12px}.crm-planner-topline{min-width:0;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 4px}.crm-planner-heading{min-width:0;font-size:var(--crm-type-room,17px);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .crm-planner-head-actions{display:flex;align-items:center;gap:2px}.crm-planner-text-action.crm-menu-action{height:30px;font-size:var(--crm-type-caption,11px)!important;padding:0 8px!important}.crm-planner-project-menu{width:30px!important;padding:0!important;font-size:14px!important;text-align:center}
      .crm-planner-buckets{min-width:0;min-height:0;display:flex;align-items:flex-start;justify-content:safe center;gap:var(--crm-object-gap,18px);overflow-x:auto;overflow-y:hidden;padding:clamp(18px,4vh,34px) 12px 28px;box-sizing:border-box;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}
      .crm-planner-bucket.tk-zone{position:relative;inset:auto;z-index:auto;flex:0 0 226px;width:226px;height:min(500px,calc(100vh - 210px));min-height:342px;box-sizing:border-box;padding:12px 14px;overflow:hidden;transition:width .16s ease,flex-basis .16s ease,height .16s ease}
      .crm-planner-bucket.is-drop-target{border-color:rgba(137,188,255,.72)!important;box-shadow:inset 0 1px rgba(255,255,255,.24),0 0 34px rgba(71,139,231,.24)!important}.crm-planner-bucket .tk-zone-hd{flex:0 0 30px}.crm-planner-bucket .tk-zone-hd-r{right:2px;top:1px;pointer-events:auto;opacity:.72}
      .crm-planner-stage-menu.crm-menu-action{width:28px;height:27px;padding:0!important;display:grid;place-items:center;font-size:14px!important}.crm-planner-card-list{min-height:0;flex:1 1 auto;overflow-y:auto;display:flex;flex-direction:column;align-items:center;gap:8px;padding:4px 2px 8px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}
      .crm-planner-card{appearance:none;position:relative;flex:0 0 auto;width:188px;min-height:102px;box-sizing:border-box;padding:12px 13px;text-align:left;border:0;border-radius:15px;background:linear-gradient(150deg,rgba(98,112,134,.94),rgba(62,74,94,.92));color:rgba(255,255,255,.9);box-shadow:inset 0 1px rgba(255,255,255,.22),0 14px 18px -14px rgba(0,0,0,.5);cursor:grab;transition:width .16s ease,min-height .16s ease,box-shadow .14s ease,opacity .14s ease}.crm-planner-card:active{cursor:grabbing}.crm-planner-card.is-dragging{opacity:.32}
      .crm-planner-card:hover,.crm-planner-card:focus-visible{outline:0;box-shadow:inset 0 0 0 9999px rgba(255,255,255,.1),inset 0 1px rgba(255,255,255,.3),0 14px 18px -14px rgba(0,0,0,.5)}
      .crm-planner-card-title{display:block;font-size:var(--crm-type-object,14px);font-weight:680;line-height:1.24;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-planner-card-note{display:-webkit-box;margin-top:7px;color:rgba(255,255,255,.54);font-size:var(--crm-type-meta,10px);line-height:1.35;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.crm-planner-card-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;color:rgba(255,255,255,.5);font-size:var(--crm-type-meta,10px);white-space:nowrap}.crm-planner-card-meta span{overflow:hidden;text-overflow:ellipsis}.crm-planner-card-link{color:rgba(211,227,249,.62)!important}
      .crm-planner-bucket.crm-object-small{scale:1!important;flex-basis:176px;width:176px;height:min(420px,calc(100vh - 230px));min-height:308px;padding-inline:11px}.crm-planner-card.crm-object-small{scale:1!important;width:140px;min-height:72px;padding:10px 11px}.crm-planner-card.crm-object-small .crm-planner-card-note,.crm-planner-card.crm-object-small .crm-planner-card-link{display:none}.crm-planner-card.crm-object-small .crm-planner-card-title{font-size:var(--crm-type-body,12px)}.crm-planner-card.crm-object-small .crm-planner-card-meta{margin-top:8px}
      .crm-planner-add-card.crm-menu-action{flex:0 0 29px;width:100%;height:29px;text-align:left;padding-left:4px!important;font-size:var(--crm-type-caption,11px)!important;color:rgba(255,255,255,.34)!important}.crm-planner-add-card:hover{color:#fff!important}.crm-planner-empty{height:100%;display:grid;place-items:center;padding:16px;text-align:center;color:rgba(255,255,255,.3);font-size:var(--crm-type-caption,11px)}
      .crm-planner-popover{position:fixed;z-index:9300;width:min(280px,calc(100vw - 28px));padding:9px;display:grid;gap:8px}.crm-planner-popover-title{padding:2px 3px 5px;font-size:var(--crm-type-control,13px);font-weight:700}.crm-planner-popover-actions{display:flex;justify-content:flex-end;gap:2px}.crm-planner-popover .crm-menu-action{height:32px;font-size:var(--crm-type-body,12px)!important}
      .crm-planner-item-editor{position:fixed;z-index:9310;width:min(370px,calc(100vw - 28px));padding:10px;display:grid;gap:8px}.crm-planner-item-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:7px}.crm-planner-item-fields>.crm-menu-input:first-child,.crm-planner-item-fields>textarea,.crm-planner-item-fields>.crm-planner-wide{grid-column:1/-1}.crm-planner-item-fields textarea{min-height:68px;resize:vertical;padding-top:9px}.crm-planner-item-editor .crm-menu-action{height:32px;font-size:var(--crm-type-body,12px)!important}
      .crm-planner-context{position:fixed;z-index:9320;width:172px;padding:6px;display:grid;gap:1px}.crm-planner-context .crm-menu-action{height:33px;text-align:left;font-size:var(--crm-type-body,12px)!important}.crm-planner-card.is-focus-target{outline:1px solid rgba(159,199,250,.72);box-shadow:0 0 0 5px rgba(90,151,232,.12),inset 0 1px rgba(255,255,255,.3),0 14px 18px -14px rgba(0,0,0,.5)}
      @media(max-width:1050px){.crm-planner-frame{grid-template-columns:184px minmax(0,1fr);gap:16px}.crm-planner-buckets{justify-content:flex-start;padding-inline:8px}.crm-planner-bucket.tk-zone{flex-basis:210px;width:210px}}
    `; document.head.appendChild(style);
  }

  async function load() {
    const [projects, items, flows, commitments, contacts, tasks, tickets] = await Promise.all([
      window.crmStore.list("projects", { includeDeleted:false }), window.crmStore.list("workItems", { includeDeleted:false }),
      window.crmDomain.list("workflow-entries", { includeDeleted:false, limit:1000 }), window.crmDomain.list("commitments", { includeDeleted:false, limit:1000 }),
      window.crmStore.list("contacts", { includeDeleted:false }), window.crmStore.list("tasks", { includeDeleted:false }), window.crmStore.list("tickets", { includeDeleted:false }),
    ]);
    return {
      projects:rows(projects).filter((record) => !record.deletedAt).map(normalizeProject),
      items:rows(items).filter((record) => !record.deletedAt).map(normalizeItem), flows:rows(flows).filter((record) => !record.deletedAt),
      commitments:rows(commitments).filter((record) => !record.deletedAt), contacts:rows(contacts).filter((record) => !record.deletedAt),
      tasks:rows(tasks).filter((record) => !record.deletedAt), tickets:rows(tickets).filter((record) => !record.deletedAt),
    };
  }

  async function createLinkedItem(project, stage, title, note = "", options = {}) {
    const rank = model.items.filter((item) => item.projectId === project.id && item.stageId === stage.id).length;
    const itemResult = await window.crmStore.create("workItems", {
      projectId:project.id, projectTitle:project.title, stageId:stage.id, stageLabel:stage.title, title, note,
      dueAt:options.dueAt || null, priority:options.priority || "normal", assignee:options.assignee || null,
      assignedContactId:options.assignedContactId || null, linkedEntityType:options.linkedEntityType || null,
      linkedRecordId:options.linkedRecordId || null, status:stage.kind === "done" ? "completed" : "open", rank,
    });
    const item = itemResult?.record; if (!item) return null;
    const links = [{ entityType:"workItems", recordId:item.id, relation:"regarding" }];
    if (options.linkedEntityType && options.linkedRecordId) links.push({ entityType:options.linkedEntityType, recordId:options.linkedRecordId, relation:"supports" });
    const commitmentResult = await window.crmDomain.create("commitments", {
      title, kind:"pipeline-work", status:stage.kind === "done" ? "completed" : "open", dueAt:options.dueAt || null,
      priority:options.priority || "normal", assignee:options.assignee || null, projectId:project.id, projectTitle:project.title,
      stageId:stage.id, stageLabel:stage.title, links,
    });
    const flowResult = await window.crmDomain.create("workflow-entries", {
      workflowKey:`project:${project.id}`, entityType:"workItems", recordId:item.id, stage:stage.id, rank, owner:options.assignee || null,
    });
    const linkedResult = await window.crmStore.update("workItems", item.id, { commitmentId:commitmentResult?.record?.id || null, workflowEntryId:flowResult?.record?.id || null });
    return linkedResult?.record || { ...item, commitmentId:commitmentResult?.record?.id || null, workflowEntryId:flowResult?.record?.id || null };
  }

  async function migrateLegacy() {
    if (window.crmHomePreviews?.isCaptureWorker || model.projects.length || localStorage.getItem(MIGRATED_KEY) === "true") return false;
    let legacy = [];
    try { const parsed = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null"); legacy = Array.isArray(parsed) ? parsed : []; } catch {}
    legacy = legacy.filter((project) => !["project-client-launch", "project-operations", "project-renewals"].includes(project.id));
    if (!legacy.length) { localStorage.setItem(MIGRATED_KEY, "true"); return false; }
    for (const source of legacy) {
      const stages = (source.buckets || []).map((bucket, index) => normalizeStage({ id:uid("stage"), title:bucket.title, kind:index === source.buckets.length - 1 ? "done" : index ? "active" : "queue", rank:index }, index));
      const projectResult = await window.crmStore.create("projects", { title:first(source.title, "Imported project"), note:String(source.note || ""), stages:stages.length ? stages : clone(DEFAULT_STAGES) });
      const project = projectResult?.record; if (!project) continue;
      for (let index = 0; index < stages.length; index += 1) {
        const sourceBucket = source.buckets[index];
        for (const card of sourceBucket.cards || []) await createLinkedItem(normalizeProject(project), stages[index], first(card.title, "Imported work"), String(card.note || ""));
      }
    }
    localStorage.setItem(MIGRATED_KEY, "true"); return true;
  }

  async function refresh(force = false) {
    if (refreshPromise) {
      await refreshPromise;
      if (!force) return model;
    }
    const run = (async () => {
      model = await load();
      if (await migrateLegacy()) model = await load();
      if (!model.projects.some((project) => project.id === selectedId)) selectedId = model.projects[0]?.id || "";
      dirty = false; publish("refreshed"); return model;
    })();
    refreshPromise = run;
    try { return await run; }
    finally { if (refreshPromise === run) refreshPromise = null; }
  }
  const schedule = () => { dirty = true; clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (active) refresh(); }, 100); };

  function render() {
    if (!root) return;
    const project = selectedProject(); const stages = stagesOf(project);
    root.innerHTML = `<div class="crm-planner-frame">
      <aside class="crm-planner-projects crm-menu-surface"><header class="crm-planner-projects-head crm-menu-item"><span class="crm-planner-projects-title">Projects</span><button type="button" class="crm-planner-new-project crm-menu-action" data-planner-action="new-project" aria-label="Create project">+</button></header><nav class="crm-planner-project-list" aria-label="Projects">${model.projects.map((item) => `<button type="button" class="crm-planner-project crm-menu-action${item.id === project?.id ? " is-selected" : ""}" data-planner-project="${esc(item.id)}">${esc(item.title)}</button>`).join("")}</nav></aside>
      <section class="crm-planner-stage"><header class="crm-planner-topline"><div class="crm-planner-heading">${esc(project?.title || "Planner")}</div><div class="crm-planner-head-actions">${project ? '<button type="button" class="crm-planner-text-action crm-planner-project-menu crm-menu-action" data-planner-action="project-menu" aria-label="Project options">···</button><button type="button" class="crm-planner-text-action crm-menu-action" data-planner-action="new-stage">Add stage</button>' : ""}</div></header>
      <div class="crm-planner-buckets">${project ? stages.map((stage) => {
        const items = model.items.filter((item) => item.projectId === project.id && item.stageId === stage.id).sort((a, b) => a.rank - b.rank || String(a.createdAt).localeCompare(String(b.createdAt)));
        return `<section class="crm-planner-bucket tk-zone" data-planner-bucket="${esc(stage.id)}" data-stage="${esc(stage.id)}" data-crm-size-key="${esc(`bucket:planner:${project.id}:${stage.id}`)}"><header class="tk-zone-hd"><span class="tk-zone-title" title="${esc(stage.title)}">${esc(stage.title)}</span><span class="tk-zone-hd-r"><button type="button" class="crm-planner-stage-menu crm-menu-action" data-planner-action="stage-menu" aria-label="${esc(stage.title)} options">···</button></span></header>
          <div class="crm-planner-card-list">${items.length ? items.map(cardHTML).join("") : '<div class="crm-planner-empty">No work yet</div>'}</div><button type="button" class="crm-planner-add-card crm-menu-action" data-planner-action="new-card">+ Add work</button></section>`;
      }).join("") : ""}</div></section></div>`;
    window.crmObjectSizing?.scan?.(root);
  }
  function cardHTML(item) {
    const due = item.dueAt ? new Date(item.dueAt) : null; const dueLabel = due && !Number.isNaN(due.getTime()) ? due.toLocaleDateString([], { month:"short", day:"numeric" }) : "No due date";
    const link = item.linkedEntityType ? `${String(item.linkedEntityType).replace(/s$/, "")} · ${first(item.linkedLabel, item.linkedRecordId)}` : "Pipeline work";
    return `<button type="button" class="crm-planner-card" draggable="true" data-planner-card="${esc(item.id)}" data-record-entity="workItems" data-record-id="${esc(item.id)}" data-crm-size-key="${esc(`card:workItems:${item.id}`)}"><span class="crm-planner-card-title">${esc(item.title)}</span>${item.note ? `<span class="crm-planner-card-note">${esc(item.note)}</span>` : ""}<span class="crm-planner-card-meta"><span>${esc(first(item.assignee, "Unassigned"))}</span><span>${esc(dueLabel)}</span></span><span class="crm-planner-card-meta crm-planner-card-link"><span>${esc(link)}</span><span>${esc(item.priority)}</span></span></button>`;
  }

  const closeFloating = () => { floating?.remove(); floating = null; };
  const place = (element, anchor, x, y) => {
    document.body.appendChild(element); const source = anchor?.getBoundingClientRect(); const bounds = element.getBoundingClientRect();
    const left = Math.max(10, Math.min(innerWidth - bounds.width - 10, Number.isFinite(x) ? x : (source?.right || innerWidth / 2) - bounds.width));
    const top = Math.max(48, Math.min(innerHeight - bounds.height - 12, Number.isFinite(y) ? y : (source?.bottom || innerHeight / 2) + 5));
    element.style.left = `${left}px`; element.style.top = `${top}px`;
  };
  const armOutside = (element) => setTimeout(() => {
    const close = (event) => { if (element.contains(event.target)) return; closeFloating(); document.removeEventListener("pointerdown", close, true); };
    document.addEventListener("pointerdown", close, true);
  }, 0);
  function openTextEditor({ title, value = "", placeholder = "Name", submit = "Save", anchor, onSubmit }) {
    closeFloating(); floating = document.createElement("form"); floating.className = "crm-planner-popover crm-menu-surface";
    floating.innerHTML = `<div class="crm-planner-popover-title">${esc(title)}</div><input class="crm-menu-input" name="value" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" required><div class="crm-planner-popover-actions"><button type="button" class="crm-menu-action" data-cancel>Cancel</button><button type="submit" class="crm-menu-action">${esc(submit)}</button></div>`;
    floating.addEventListener("submit", async (event) => { event.preventDefault(); const input = floating.elements.value.value.trim(); if (!input) return; await onSubmit(input); closeFloating(); });
    floating.querySelector("[data-cancel]")?.addEventListener("click", closeFloating); place(floating, anchor); armOutside(floating); requestAnimationFrame(() => floating?.elements?.value?.focus());
  }
  function openMenu(anchor, actions, x, y) {
    closeFloating(); floating = document.createElement("div"); floating.className = "crm-planner-context crm-menu-surface";
    actions.filter(Boolean).forEach((action) => { const button = document.createElement("button"); button.type = "button"; button.className = `crm-menu-action${action.danger ? " tk-menu-danger" : ""}`; button.textContent = action.label; button.addEventListener("click", () => { closeFloating(); action.run(); }); floating.appendChild(button); });
    place(floating, anchor, x, y); armOutside(floating);
  }
  function openItemEditor(item, anchor) {
    const project = projectById(item.projectId); if (!project) return;
    closeFloating(); floating = document.createElement("form"); floating.className = "crm-planner-item-editor crm-menu-surface";
    const targets = [["", "No linked record"], ...model.tasks.map((record) => [`tasks:${record.id}`, `Task · ${recordName(record)}`]), ...model.contacts.map((record) => [`contacts:${record.id}`, `Person · ${recordName(record)}`]), ...model.tickets.map((record) => [`tickets:${record.id}`, `Ticket · ${recordName(record)}`])];
    const selectedTarget = item.linkedEntityType && item.linkedRecordId ? `${item.linkedEntityType}:${item.linkedRecordId}` : "";
    floating.innerHTML = `<div class="crm-planner-popover-title">Work item</div><div class="crm-planner-item-fields"><input class="crm-menu-input" name="title" value="${esc(item.title)}" required><textarea class="crm-menu-input" name="note" placeholder="What does done look like?">${esc(item.note)}</textarea><input class="crm-menu-input" name="dueAt" type="date" value="${esc(String(item.dueAt || "").slice(0, 10))}" aria-label="Due date"><select class="crm-menu-input" name="priority" aria-label="Priority">${["normal","high","urgent"].map((value) => `<option value="${value}"${item.priority === value ? " selected" : ""}>${value[0].toUpperCase() + value.slice(1)}</option>`).join("")}</select><select class="crm-menu-input crm-planner-wide" name="assignee" aria-label="Assignee"><option value="">Unassigned</option>${model.contacts.map((contact) => `<option value="${esc(contact.id)}"${String(item.assignedContactId || "") === String(contact.id) ? " selected" : ""}>${esc(contactName(contact))}</option>`).join("")}</select><select class="crm-menu-input crm-planner-wide" name="target" aria-label="Linked record">${targets.map(([value, label]) => `<option value="${esc(value)}"${selectedTarget === value ? " selected" : ""}>${esc(label)}</option>`).join("")}</select></div><div class="crm-planner-popover-actions"><button type="button" class="crm-menu-action" data-cancel>Cancel</button><button type="submit" class="crm-menu-action">Save</button></div>`;
    floating.addEventListener("submit", async (event) => {
      event.preventDefault(); const data = new FormData(floating); const contact = model.contacts.find((record) => String(record.id) === String(data.get("assignee") || "")); const rawTarget = String(data.get("target") || ""); const [linkedEntityType, ...parts] = rawTarget.split(":"); const due = String(data.get("dueAt") || "");
      await updateItem(item.id, { title:String(data.get("title") || "").trim(), note:String(data.get("note") || ""), dueAt:due ? new Date(`${due}T17:00:00`).toISOString() : null, priority:String(data.get("priority") || "normal"), assignedContactId:contact?.id || null, assignee:contact ? contactName(contact) : null, linkedEntityType:rawTarget ? linkedEntityType : null, linkedRecordId:rawTarget ? parts.join(":") : null, linkedLabel:rawTarget ? recordName([...model.tasks, ...model.contacts, ...model.tickets].find((record) => String(record.id) === parts.join(":"))) : null });
      closeFloating();
    });
    floating.querySelector("[data-cancel]")?.addEventListener("click", closeFloating); place(floating, anchor); armOutside(floating); requestAnimationFrame(() => floating?.elements?.title?.focus());
  }

  async function createProject(title, note = "") {
    const result = await window.crmStore.create("projects", { title, note, stages:clone(DEFAULT_STAGES) });
    if (!result?.record) return null; selectedId = result.record.id; await refresh(true); publish("project-created"); return clone(projectById(selectedId));
  }
  async function createStage(projectId, title) {
    const project = projectById(projectId); if (!project) return null; const stages = stagesOf(project); const stage = normalizeStage({ id:uid("stage"), title, kind:"active", rank:stages.length }, stages.length);
    const result = await window.crmStore.update("projects", project.id, { stages:[...stages, stage] }); if (!result?.record) return null; await refresh(true); publish("stage-created"); return clone(stage);
  }
  const createBucket = createStage;
  async function createCard(projectId, stageId, title, note = "", options = {}) {
    const project = projectById(projectId); const stage = stageById(project, stageId); if (!project || !stage) return null;
    const item = await createLinkedItem(project, stage, title, note, options); if (!item) return null; await refresh(true); publish("item-created"); return clone(itemById(item.id));
  }
  function selectProject(projectId) {
    if (!projectById(projectId)) return false; selectedId = String(projectId); publish("project-selected"); return true;
  }
  async function updateProject(projectId, fields, reason = "project-updated") {
    const project = projectById(projectId); if (!project) return false; const result = await window.crmStore.update("projects", project.id, fields); if (!result?.record) return false; await refresh(true); publish(reason); return true;
  }
  async function updateItem(itemId, fields) {
    const item = itemById(itemId); if (!item) return false; const project = projectById(item.projectId); const result = await window.crmStore.update("workItems", item.id, fields); if (!result?.record) return false;
    const commitment = commitmentFor(item); if (commitment) {
      const commitmentFields = {};
      ["title","dueAt","priority","assignee","status"].forEach((key) => { if (Object.prototype.hasOwnProperty.call(fields, key)) commitmentFields[key] = fields[key]; });
      if (fields.stageId) { const stage = stageById(project, fields.stageId); commitmentFields.stageId = fields.stageId; commitmentFields.stageLabel = stage?.title || ""; }
      if (Object.prototype.hasOwnProperty.call(fields, "linkedEntityType") || Object.prototype.hasOwnProperty.call(fields, "linkedRecordId")) {
        const entityType = Object.prototype.hasOwnProperty.call(fields, "linkedEntityType") ? fields.linkedEntityType : item.linkedEntityType;
        const recordId = Object.prototype.hasOwnProperty.call(fields, "linkedRecordId") ? fields.linkedRecordId : item.linkedRecordId;
        commitmentFields.links = [{ entityType:"workItems", recordId:item.id, relation:"regarding" }];
        if (entityType && recordId) commitmentFields.links.push({ entityType, recordId, relation:"supports" });
      }
      if (Object.keys(commitmentFields).length) await window.crmDomain.update("commitments", commitment.id, commitmentFields, commitment.version);
    }
    await refresh(true); publish("item-updated"); return true;
  }
  async function moveCard(itemId, stageId) {
    const item = itemById(itemId); const project = projectById(item?.projectId); const stage = stageById(project, stageId); if (!item || !project || !stage) return false;
    const completed = stage.kind === "done"; const rank = model.items.filter((record) => record.projectId === project.id && record.stageId === stage.id && record.id !== item.id).length;
    const itemResult = await window.crmStore.update("workItems", item.id, { stageId:stage.id, stageLabel:stage.title, rank, status:completed ? "completed" : "open" }); if (!itemResult?.record) return false;
    const flow = flowFor(item); if (flow) await window.crmDomain.update("workflow-entries", flow.id, { stage:stage.id, rank, owner:item.assignee || null }, flow.version);
    else await window.crmDomain.create("workflow-entries", { workflowKey:`project:${project.id}`, entityType:"workItems", recordId:item.id, stage:stage.id, rank, owner:item.assignee || null });
    const commitment = commitmentFor(item); if (commitment) await window.crmDomain.update("commitments", commitment.id, { status:completed ? "completed" : "open", completedAt:completed ? nowIso() : null, outcome:completed ? `Completed in ${project.title}` : null, stageId:stage.id, stageLabel:stage.title }, commitment.version);
    await refresh(true); publish("item-moved"); return true;
  }
  async function deleteItem(itemId) {
    const item = itemById(itemId); if (!item) return false; const commitment = commitmentFor(item); const flow = flowFor(item);
    await window.crmStore.remove("workItems", item.id); if (commitment) await window.crmDomain.remove("commitments", commitment.id); if (flow) await window.crmDomain.remove("workflow-entries", flow.id);
    await refresh(true); publish("item-deleted"); return true;
  }
  async function deleteStage(project, stage) {
    const stages = stagesOf(project); if (stages.length <= 1) return false; const fallback = stages.find((candidate) => candidate.id !== stage.id);
    for (const item of model.items.filter((record) => record.projectId === project.id && record.stageId === stage.id)) await moveCard(item.id, fallback.id);
    return updateProject(project.id, { stages:stages.filter((candidate) => candidate.id !== stage.id).map((candidate, index) => ({ ...candidate, rank:index })) }, "stage-deleted");
  }
  async function deleteProject(project) {
    for (const item of model.items.filter((record) => record.projectId === project.id)) await deleteItem(item.id);
    await window.crmStore.remove("projects", project.id); selectedId = model.projects.find((candidate) => candidate.id !== project.id)?.id || ""; await refresh(true); publish("project-deleted"); return true;
  }

  function projectMenu(anchor) {
    const project = selectedProject(); if (!project) return;
    openMenu(anchor, [
      { label:"Rename", run:() => openTextEditor({ title:"Rename project", value:project.title, anchor, onSubmit:(value) => updateProject(project.id, { title:value }, "project-renamed") }) },
      { label:"Delete project", danger:true, run:() => deleteProject(project) },
    ]);
  }
  function stageMenu(stage, anchor, x, y) {
    const project = selectedProject(); if (!project || !stage) return; const stages = stagesOf(project); const index = stages.findIndex((candidate) => candidate.id === stage.id); const sized = root?.querySelector(`[data-planner-bucket="${cssValue(stage.id)}"]`);
    openMenu(anchor, [
      { label:window.crmObjectSizing?.isSmall?.(sized, "bucket") ? "Make large" : "Make small", run:() => window.crmObjectSizing?.toggle?.(sized, "bucket") },
      { label:"Rename", run:() => openTextEditor({ title:"Rename stage", value:stage.title, anchor, onSubmit:(value) => updateProject(project.id, { stages:stages.map((candidate) => candidate.id === stage.id ? { ...candidate, title:value } : candidate) }, "stage-renamed") }) },
      index > 0 && { label:"Move left", run:() => { const next=[...stages]; [next[index - 1],next[index]]=[next[index],next[index - 1]]; updateProject(project.id, { stages:next.map((candidate, rank) => ({ ...candidate, rank })) }, "stage-reordered"); } },
      index < stages.length - 1 && { label:"Move right", run:() => { const next=[...stages]; [next[index + 1],next[index]]=[next[index],next[index + 1]]; updateProject(project.id, { stages:next.map((candidate, rank) => ({ ...candidate, rank })) }, "stage-reordered"); } },
      { label:stage.kind === "done" ? "Make active stage" : "Mark as done stage", run:() => updateProject(project.id, { stages:stages.map((candidate) => candidate.id === stage.id ? { ...candidate, kind:stage.kind === "done" ? "active" : "done" } : candidate) }, "stage-kind-changed") },
      { label:"Delete stage", danger:true, run:() => deleteStage(project, stage) },
    ], x, y);
  }
  function itemMenu(item, anchor, x, y) {
    openMenu(anchor, [
      { label:window.crmObjectSizing?.isSmall?.(anchor, "card") ? "Make large" : "Make small", run:() => window.crmObjectSizing?.toggle?.(anchor, "card") },
      { label:"Edit", run:() => openItemEditor(item, anchor) },
      { label:"Delete work", danger:true, run:() => deleteItem(item.id) },
    ], x, y);
  }

  function wire() {
    root.addEventListener("click", (event) => {
      const projectButton = event.target.closest("[data-planner-project]"); if (projectButton) { selectProject(projectButton.dataset.plannerProject); return; }
      const card = event.target.closest("[data-planner-card]"); if (card) { const item = itemById(card.dataset.plannerCard); if (item) openItemEditor(item, card); return; }
      const action = event.target.closest("[data-planner-action]"); if (!action) return; const project = selectedProject(); const stageElement = action.closest("[data-planner-bucket]"); const stage = stageById(project, stageElement?.dataset.plannerBucket);
      if (action.dataset.plannerAction === "new-project") openTextEditor({ title:"New project", placeholder:"Project name", submit:"Create", anchor:action, onSubmit:(value) => createProject(value) });
      if (action.dataset.plannerAction === "project-menu") projectMenu(action);
      if (action.dataset.plannerAction === "new-stage" && project) openTextEditor({ title:"New stage", placeholder:"Stage name", submit:"Add", anchor:action, onSubmit:(value) => createStage(project.id, value) });
      if (action.dataset.plannerAction === "stage-menu" && stage) stageMenu(stage, action);
      if (action.dataset.plannerAction === "new-card" && project && stage) openTextEditor({ title:`Add to ${stage.title}`, placeholder:"Work item", submit:"Add", anchor:action, onSubmit:(value) => createCard(project.id, stage.id, value) });
    });
    root.addEventListener("contextmenu", (event) => {
      const cardElement = event.target.closest("[data-planner-card]"); const stageElement = event.target.closest("[data-planner-bucket]");
      if (cardElement) { event.preventDefault(); itemMenu(itemById(cardElement.dataset.plannerCard), cardElement, event.clientX, event.clientY); }
      else if (stageElement) { event.preventDefault(); stageMenu(stageById(selectedProject(), stageElement.dataset.plannerBucket), stageElement, event.clientX, event.clientY); }
    });
    root.addEventListener("dragstart", (event) => { const card = event.target.closest("[data-planner-card]"); if (!card) return; dragItemId = card.dataset.plannerCard; card.classList.add("is-dragging"); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", dragItemId); });
    root.addEventListener("dragend", (event) => { event.target.closest("[data-planner-card]")?.classList.remove("is-dragging"); root.querySelectorAll(".is-drop-target").forEach((node) => node.classList.remove("is-drop-target")); dragItemId = ""; });
    root.addEventListener("dragover", (event) => { const stage = event.target.closest("[data-planner-bucket]"); if (!stage || !dragItemId) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; root.querySelectorAll(".crm-planner-bucket").forEach((node) => node.classList.toggle("is-drop-target", node === stage)); });
    root.addEventListener("dragleave", (event) => { const stage = event.target.closest("[data-planner-bucket]"); if (stage && !stage.contains(event.relatedTarget)) stage.classList.remove("is-drop-target"); });
    root.addEventListener("drop", async (event) => { const stage = event.target.closest("[data-planner-bucket]"); if (!stage || !dragItemId) return; event.preventDefault(); await moveCard(dragItemId, stage.dataset.plannerBucket); dragItemId = ""; });
  }

  function mount() {
    if (root) return root; ensureStyles(); root = document.createElement("main"); root.className = "crm-planner-surface"; root.dataset.crmTheater = "planner"; root.hidden = true; document.body.appendChild(root); wire();
    try { window.crmStore?.onChanged?.(schedule); } catch {} try { window.crmDomain?.onChanged?.(schedule); } catch {}
    refresh(); return root;
  }
  const setActive = (on) => { active = !!on; mount(); root.hidden = !active; if (active && dirty) refresh(); if (!active) closeFloating(); return api; };
  const baseline = async () => { mount(); if (dirty || !model.projects.length) await refresh(); render(); root.hidden = !active; return root; };
  async function miniature() { await baseline(); const copy = root.cloneNode(true); copy.hidden = false; copy.removeAttribute("data-crm-theater"); Object.assign(copy.style, { position:"absolute", left:"50%", top:"50%", width:"1280px", height:"860px", transform:"translate(-50%,-50%) scale(.285)", transformOrigin:"center", pointerEvents:"none" }); return copy; }
  async function openItem(itemId) {
    if (dirty || !itemById(itemId)) await refresh(); const item = itemById(itemId); if (!item) return false; selectedId = item.projectId; publish("item-selected");
    await (window.crmDeskTransit?.driveTo?.("planner") || Promise.resolve(window.crmWorkspaces?.setActive?.("planner")));
    requestAnimationFrame(() => { const card = root?.querySelector(`[data-planner-card="${cssValue(item.id)}"]`); card?.classList.add("is-focus-target"); card?.scrollIntoView?.({ block:"nearest", inline:"nearest" }); setTimeout(() => card?.classList.remove("is-focus-target"), 1600); });
    return true;
  }
  const api = { setActive, baseline, miniature, refresh, isActive:() => active, selected:() => selectedId, selectProject, projects:projectsSnapshot, items:() => clone(model.items), createProject, createStage, createBucket, createCard, updateItem, moveCard, deleteItem, openItem, onChanged:(listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
  document.addEventListener("crm:theater-switch", closeFloating); window.addEventListener("storage", (event) => { if (event.key === SELECTED_KEY) { selectedId = localStorage.getItem(SELECTED_KEY) || ""; render(); } });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once:true }); else mount();
  window.crmPlanner = api;
})();
