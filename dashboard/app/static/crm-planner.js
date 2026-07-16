// crm-planner.js — persistent, user-defined multi-stage project pipelines.
(() => {
  const SELECTED_KEY = "crm-planner-selected-v2";
  const LEGACY_KEY = "crm-planner-projects-v1";
  const MIGRATED_KEY = "crm-planner-projects-migrated-v2";
  const EXPANDED_KEY = "crm-planner-stack-expansion-v1";
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
  let refreshTail = Promise.resolve();
  let floating = null;
  let selectedId = localStorage.getItem(SELECTED_KEY) || "";
  let dragItemId = "";
  let plannerResizeObserver = null;
  const plannerScrollPositions = new Map();
  let model = { projects:[], items:[], flows:[], commitments:[], contacts:[], tasks:[], tickets:[] };
  let expandedStacks = (() => { try { const value = JSON.parse(localStorage.getItem(EXPANDED_KEY) || "[]"); return new Set(Array.isArray(value) ? value.map(String) : []); } catch { return new Set(); } })();

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
  const expansionKey = (projectId, stageId) => `${projectId}:${stageId}`;
  const stageExpanded = (projectId, stageId) => expandedStacks.has(expansionKey(projectId, stageId));
  const setStageExpanded = (projectId, stageId, open = !stageExpanded(projectId, stageId)) => {
    const key = expansionKey(projectId, stageId); if (open) expandedStacks.add(key); else expandedStacks.delete(key);
    if (!window.crmHomePreviews?.isCaptureWorker) localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expandedStacks]));
    render(); return expandedStacks.has(key);
  };

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
      .crm-planner-frame{position:absolute;inset:var(--crm-canvas-top,78px) var(--crm-canvas-x,64px) var(--crm-canvas-bottom,78px);max-width:1480px;margin:auto;display:grid;grid-template-rows:40px minmax(0,1fr);gap:12px;min-width:0;min-height:0}
      .crm-planner-projects{min-width:0;height:40px;display:flex;align-items:center;gap:10px;overflow:hidden;-webkit-app-region:no-drag}.crm-planner-heading{flex:0 0 auto;font-size:var(--crm-type-room,17px);font-weight:700;letter-spacing:-.01em;white-space:nowrap}.crm-planner-project-list{min-width:0;display:flex;align-items:center;gap:2px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}.crm-planner-project-list::-webkit-scrollbar{display:none}.crm-planner-project-list:empty::after{content:"No projects";padding:0 10px;color:rgba(255,255,255,.3);font-size:var(--crm-type-meta,10px);white-space:nowrap}
      .crm-planner-project.crm-menu-action{position:relative;flex:0 0 auto;width:clamp(88px,12vw,176px);height:34px;padding:5px 10px 4px!important;text-align:left;font-size:var(--crm-type-body,12px)!important;display:grid;grid-template-rows:minmax(0,1fr) 3px;gap:4px;overflow:hidden;color:rgba(255,255,255,.5)!important}.crm-planner-project.is-selected{color:rgba(255,255,255,.96)!important}.crm-planner-project.is-selected:after{content:"";position:absolute;left:10px;right:10px;bottom:0;height:2px;border-radius:2px;background:rgba(175,211,255,.78);box-shadow:0 0 10px rgba(115,177,252,.22)}.crm-planner-project-name{display:block;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-planner-project-map{display:flex;align-items:stretch;gap:2px;min-width:0;height:3px}.crm-planner-project-segment{flex:1 1 0;min-width:3px;border-radius:2px;background:rgba(214,229,248,.09);box-shadow:inset 0 0 0 1px rgba(225,237,251,.045)}.crm-planner-project-segment[data-occupied="true"]{background:rgba(160,193,234,.28)}.crm-planner-project-segment[data-kind="done"][data-occupied="true"]{background:rgba(159,208,184,.34)}.crm-planner-project.is-selected .crm-planner-project-segment{box-shadow:inset 0 0 0 1px rgba(226,238,252,.08)}
      .crm-planner-new-project.crm-menu-action{flex:0 0 29px;width:29px;height:29px;padding:0!important;font-size:17px!important}.crm-planner-head-actions{flex:0 0 auto;display:flex;align-items:center;gap:2px;padding-left:8px;border-left:1px solid rgba(255,255,255,.1)}.crm-planner-text-action.crm-menu-action{height:30px;font-size:var(--crm-type-caption,11px)!important;padding:0 8px!important}.crm-planner-project-menu{width:30px!important;padding:0!important;font-size:14px!important;text-align:center}
      .crm-planner-stage{--crm-scroll-shadow-left:0;--crm-scroll-shadow-right:0;position:relative;min-width:0;min-height:0;margin-inline:calc(0px - var(--crm-canvas-x,64px));overflow:hidden}.crm-planner-stage:before,.crm-planner-stage:after{content:"";position:absolute;z-index:4;top:0;bottom:14px;width:clamp(34px,4.5vw,68px);pointer-events:none;transition:opacity .12s linear}.crm-planner-stage:before{left:0;opacity:var(--crm-scroll-shadow-left);background:linear-gradient(90deg,rgba(1,9,14,.46) 0,rgba(1,9,14,.14) 40%,rgba(1,9,14,0) 100%)}.crm-planner-stage:after{right:0;opacity:var(--crm-scroll-shadow-right);background:linear-gradient(270deg,rgba(1,9,14,.46) 0,rgba(1,9,14,.14) 40%,rgba(1,9,14,0) 100%)}
      .crm-planner-buckets{width:100%;height:100%;min-width:0;min-height:0;display:flex;align-items:flex-start;justify-content:flex-start;gap:var(--crm-object-gap,18px);overflow-x:auto;overflow-y:hidden;padding:clamp(12px,2.5vh,22px) 0 28px var(--crm-canvas-x,64px);box-sizing:border-box;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent;scroll-padding-inline:0;-webkit-app-region:no-drag}
      .crm-planner-bucket.tk-zone{position:relative;inset:auto;z-index:auto;flex:0 0 226px;width:226px;height:min(500px,calc(100vh - 210px));min-height:342px;box-sizing:border-box;padding:12px 14px;overflow:hidden;transition:width .16s ease,flex-basis .16s ease,height .16s ease}
      .crm-planner-bucket.is-drop-target{border-color:rgba(137,188,255,.72)!important;box-shadow:inset 0 1px rgba(255,255,255,.24),0 0 34px rgba(71,139,231,.24)!important}.crm-planner-bucket .tk-zone-hd{flex:0 0 30px}.crm-planner-bucket .tk-zone-hd-r{right:0;top:1px;gap:1px;pointer-events:auto;opacity:.72}
      .crm-planner-stage-menu.crm-menu-action,.crm-planner-stack-toggle.crm-menu-action{width:28px;height:27px;padding:0!important;display:grid;place-items:center;font-size:14px!important}.crm-planner-stack-toggle svg{width:13px;height:13px}.crm-planner-stack-toggle path{fill:none;stroke:currentColor;stroke-width:1.35;stroke-linecap:round;stroke-linejoin:round}.crm-planner-stack-toggle[aria-expanded="true"]{color:rgba(193,220,255,.96)!important;background:rgba(124,175,241,.1)!important}
      .crm-planner-card-list{min-height:0;flex:1 1 auto;overflow-y:auto;display:flex;flex-direction:column;align-items:center;gap:0;padding:4px 2px 8px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}.crm-planner-card-list.is-expanded{gap:8px}
      .crm-planner-card{appearance:none;position:relative;flex:0 0 auto;width:188px;min-height:102px;box-sizing:border-box;padding:12px 13px;text-align:left;border:0;border-radius:15px;background:linear-gradient(150deg,rgba(98,112,134,.94),rgba(62,74,94,.92));color:rgba(255,255,255,.9);box-shadow:inset 0 1px rgba(255,255,255,.22),0 14px 18px -14px rgba(0,0,0,.5);cursor:grab;transition:width .16s ease,min-height .16s ease,margin .2s cubic-bezier(.22,1,.26,1),box-shadow .14s ease,opacity .14s ease}.crm-planner-card+.crm-planner-card{margin-top:-58px}.crm-planner-card-list.is-expanded .crm-planner-card+.crm-planner-card{margin-top:0}.crm-planner-card:active{cursor:grabbing}.crm-planner-card.is-dragging{opacity:.32}
      .crm-planner-card:hover,.crm-planner-card:focus-visible{outline:0;box-shadow:inset 0 0 0 9999px rgba(255,255,255,.1),inset 0 1px rgba(255,255,255,.3),0 14px 18px -14px rgba(0,0,0,.5)}
      .crm-planner-card-title{display:block;font-size:var(--crm-type-object,14px);font-weight:680;line-height:1.24;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-planner-card-note{display:-webkit-box;margin-top:7px;color:rgba(255,255,255,.54);font-size:var(--crm-type-meta,10px);line-height:1.35;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.crm-planner-card-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;color:rgba(255,255,255,.5);font-size:var(--crm-type-meta,10px);white-space:nowrap}.crm-planner-card-meta span{overflow:hidden;text-overflow:ellipsis}.crm-planner-card-link{color:rgba(211,227,249,.62)!important}
      .crm-planner-bucket.crm-object-small{scale:1!important;flex-basis:176px;width:176px;height:min(420px,calc(100vh - 230px));min-height:308px;padding-inline:11px}.crm-planner-card.crm-object-small{scale:1!important;width:140px;min-height:72px;padding:10px 11px}.crm-planner-card.crm-object-small+.crm-planner-card{margin-top:-34px}.crm-planner-card-list.is-expanded .crm-planner-card.crm-object-small+.crm-planner-card{margin-top:0}.crm-planner-card.crm-object-small .crm-planner-card-note,.crm-planner-card.crm-object-small .crm-planner-card-link{display:none}.crm-planner-card.crm-object-small .crm-planner-card-title{font-size:var(--crm-type-body,12px)}.crm-planner-card.crm-object-small .crm-planner-card-meta{margin-top:8px}
      .crm-planner-add-card.crm-menu-action{flex:0 0 29px;width:100%;height:29px;text-align:left;padding-left:4px!important;font-size:var(--crm-type-caption,11px)!important;color:rgba(255,255,255,.34)!important}.crm-planner-add-card:hover{color:#fff!important}.crm-planner-empty{height:100%;display:grid;place-items:center;padding:16px;text-align:center;color:rgba(255,255,255,.3);font-size:var(--crm-type-caption,11px)}
      .crm-planner-popover{position:fixed;z-index:9300;width:min(280px,calc(100vw - 28px));padding:9px;display:grid;gap:8px}.crm-planner-popover-title{padding:2px 3px 5px;font-size:var(--crm-type-control,13px);font-weight:700}.crm-planner-popover-actions{display:flex;justify-content:flex-end;gap:2px}.crm-planner-popover .crm-menu-action{height:32px;font-size:var(--crm-type-body,12px)!important}
      .crm-planner-item-editor{position:fixed;z-index:9310;width:min(370px,calc(100vw - 28px));padding:10px;display:grid;gap:8px}.crm-planner-item-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:7px}.crm-planner-item-fields>.crm-menu-input:first-child,.crm-planner-item-fields>textarea,.crm-planner-item-fields>.crm-planner-wide{grid-column:1/-1}.crm-planner-item-fields textarea{min-height:68px;resize:vertical;padding-top:9px}.crm-planner-item-editor .crm-menu-action{height:32px;font-size:var(--crm-type-body,12px)!important}
      .crm-planner-context{position:fixed;z-index:9320;width:172px;padding:6px;display:grid;gap:1px}.crm-planner-context .crm-menu-action{height:33px;text-align:left;font-size:var(--crm-type-body,12px)!important}.crm-planner-card.is-focus-target{outline:1px solid rgba(159,199,250,.72);box-shadow:0 0 0 5px rgba(90,151,232,.12),inset 0 1px rgba(255,255,255,.3),0 14px 18px -14px rgba(0,0,0,.5)}
      .crm-planner-zero{width:100%;height:100%;min-height:0;display:grid;place-items:center}.crm-planner-zero .crm-menu-action{height:34px;padding-inline:13px!important;color:rgba(238,245,254,.86)!important;background:rgba(13,19,28,.62)!important;border-color:rgba(213,230,250,.18)!important;box-shadow:inset 0 1px rgba(255,255,255,.08),0 12px 26px -20px rgba(0,0,0,.9)!important;font-weight:650}
      @media(max-width:900px){.crm-planner-projects{gap:6px}.crm-planner-project.crm-menu-action{width:112px}.crm-planner-head-actions{padding-left:4px}.crm-planner-text-action.crm-menu-action{padding-inline:6px!important}}
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
    const commitment = commitmentResult?.record;
    if (!commitment) { await window.crmStore.remove("workItems", item.id); return null; }
    const flowResult = await window.crmDomain.create("workflow-entries", {
      workflowKey:`project:${project.id}`, entityType:"workItems", recordId:item.id, stage:stage.id, rank, owner:options.assignee || null,
    });
    const flow = flowResult?.record;
    if (!flow) { await window.crmDomain.remove("commitments", commitment.id); await window.crmStore.remove("workItems", item.id); return null; }
    const linkage = { commitmentId:commitment.id, workflowEntryId:flow.id };
    let linkedResult = await window.crmStore.update("workItems", item.id, linkage);
    if (!linkedResult?.record) linkedResult = await window.crmStore.update("workItems", item.id, linkage);
    if (!linkedResult?.record) {
      await window.crmDomain.remove("workflow-entries", flow.id); await window.crmDomain.remove("commitments", commitment.id); await window.crmStore.remove("workItems", item.id); return null;
    }
    return linkedResult.record;
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

  async function refresh(force = false, reason = "refreshed") {
    if (!force && refreshPromise) return refreshPromise;
    clearTimeout(refreshTimer); refreshTimer = 0;
    const run = refreshTail.catch(() => null).then(async () => {
      model = await load();
      if (await migrateLegacy()) model = await load();
      if (!model.projects.some((project) => project.id === selectedId)) selectedId = model.projects[0]?.id || "";
      clearTimeout(refreshTimer); refreshTimer = 0; dirty = false; publish(reason); return model;
    });
    refreshTail = run;
    refreshPromise = run;
    run.finally(() => { if (refreshPromise === run) refreshPromise = null; }).catch(() => {});
    return run;
  }
  const schedule = () => { dirty = true; clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (active) refresh(); }, 100); };

  function render() {
    if (!root) return;
    const previousScroller = root.querySelector(".crm-planner-buckets");
    if (previousScroller?.dataset.plannerScrollProject) plannerScrollPositions.set(previousScroller.dataset.plannerScrollProject, previousScroller.scrollLeft);
    plannerResizeObserver?.disconnect();
    const project = selectedProject(); const stages = stagesOf(project);
    root.innerHTML = `<div class="crm-planner-frame">
      <header class="crm-planner-projects"><span class="crm-planner-heading">Planner</span><nav class="crm-planner-project-list" role="tablist" aria-label="Projects">${model.projects.map((item) => `<button type="button" role="tab" class="crm-planner-project crm-menu-action${item.id === project?.id ? " is-selected" : ""}" data-planner-project="${esc(item.id)}" aria-selected="${item.id === project?.id}"><span class="crm-planner-project-name">${esc(item.title)}</span>${projectMapHTML(item)}</button>`).join("")}</nav><button type="button" class="crm-planner-new-project crm-menu-action" data-planner-action="new-project" aria-label="Create project">+</button><div class="crm-planner-head-actions">${project ? '<button type="button" class="crm-planner-text-action crm-planner-project-menu crm-menu-action" data-planner-action="project-menu" aria-label="Project options">···</button><button type="button" class="crm-planner-text-action crm-menu-action" data-planner-action="new-stage">Add stage</button>' : ""}</div></header>
      <section class="crm-planner-stage">${project ? `<div class="crm-planner-buckets" data-planner-scroll-project="${esc(project.id)}" tabindex="0" aria-label="Scrollable project stages">${stages.map((stage) => {
        const items = model.items.filter((item) => item.projectId === project.id && item.stageId === stage.id).sort((a, b) => a.rank - b.rank || String(a.createdAt).localeCompare(String(b.createdAt)));
        const expanded = stageExpanded(project.id, stage.id);
        return `<section class="crm-planner-bucket tk-zone${expanded ? " is-stack-expanded" : ""}" data-planner-bucket="${esc(stage.id)}" data-stage="${esc(stage.id)}" data-crm-size-key="${esc(`bucket:planner:${project.id}:${stage.id}`)}"><header class="tk-zone-hd"><span class="tk-zone-title" title="${esc(stage.title)}">${esc(stage.title)}</span><span class="tk-zone-hd-r"><button type="button" class="crm-planner-stack-toggle crm-menu-action" data-planner-action="toggle-stack" aria-label="${expanded ? "Collapse" : "Expand"} ${esc(stage.title)} stack" aria-expanded="${expanded}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M3 11.5h10M8 2v5M6.2 3.8 8 2l1.8 1.8M8 14v-5m-1.8 3.2L8 14l1.8-1.8"/></svg></button><button type="button" class="crm-planner-stage-menu crm-menu-action" data-planner-action="stage-menu" aria-label="${esc(stage.title)} options">···</button></span></header>
          <div class="crm-planner-card-list${expanded ? " is-expanded" : ""}">${items.length ? items.map(cardHTML).join("") : '<div class="crm-planner-empty">No work yet</div>'}</div><button type="button" class="crm-planner-add-card crm-menu-action" data-planner-action="new-card">+ Add work</button></section>`;
      }).join("")}</div>` : '<div class="crm-planner-zero"><button type="button" class="crm-menu-action" data-planner-action="new-project">Create project</button></div>'}</section></div>`;
    window.crmObjectSizing?.scan?.(root);
    wirePlannerScroller(project?.id);
  }
  function projectMapHTML(project) {
    return `<span class="crm-planner-project-map" aria-hidden="true">${stagesOf(project).map((stage) => `<i class="crm-planner-project-segment" data-kind="${esc(stage.kind)}" data-occupied="${model.items.some((item) => item.projectId === project.id && item.stageId === stage.id)}"></i>`).join("")}</span>`;
  }
  function cardHTML(item) {
    const due = item.dueAt ? new Date(item.dueAt) : null; const dueLabel = due && !Number.isNaN(due.getTime()) ? due.toLocaleDateString([], { month:"short", day:"numeric" }) : "No due date";
    const link = item.linkedEntityType ? `${String(item.linkedEntityType).replace(/s$/, "")} · ${first(item.linkedLabel, item.linkedRecordId)}` : "Pipeline work";
    return `<button type="button" class="crm-planner-card" draggable="true" data-planner-card="${esc(item.id)}" data-record-entity="workItems" data-record-id="${esc(item.id)}" data-crm-size-key="${esc(`card:workItems:${item.id}`)}"><span class="crm-planner-card-title">${esc(item.title)}</span>${item.note ? `<span class="crm-planner-card-note">${esc(item.note)}</span>` : ""}<span class="crm-planner-card-meta"><span>${esc(first(item.assignee, "Unassigned"))}</span><span>${esc(dueLabel)}</span></span><span class="crm-planner-card-meta crm-planner-card-link"><span>${esc(link)}</span><span>${esc(item.priority)}</span></span></button>`;
  }

  function updatePlannerScrollEdges() {
    const scroller = root?.querySelector(".crm-planner-buckets"); const stage = scroller?.closest(".crm-planner-stage"); if (!stage) return;
    const maximum = Math.max(0, (scroller.scrollWidth || 0) - scroller.clientWidth); const position = Math.max(0, Math.min(maximum, scroller.scrollLeft)); const fadeDistance = Math.min(72, Math.max(42, scroller.clientWidth * .06));
    stage.style.setProperty("--crm-scroll-shadow-left", String(maximum > 1 ? Math.min(1, position / fadeDistance) : 0));
    stage.style.setProperty("--crm-scroll-shadow-right", String(maximum > 1 ? Math.min(1, (maximum - position) / fadeDistance) : 0));
    if (scroller.dataset.plannerScrollProject) plannerScrollPositions.set(scroller.dataset.plannerScrollProject, position);
  }
  function wirePlannerScroller(projectId) {
    const scroller = root?.querySelector(".crm-planner-buckets"); if (!scroller) return;
    const restore = Math.max(0, Number(plannerScrollPositions.get(String(projectId || ""))) || 0);
    scroller.scrollLeft = Math.min(restore, Math.max(0, scroller.scrollWidth - scroller.clientWidth));
    scroller.addEventListener("scroll", updatePlannerScrollEdges, { passive:true });
    plannerResizeObserver = new ResizeObserver(updatePlannerScrollEdges); plannerResizeObserver.observe(scroller); scroller.querySelectorAll(".crm-planner-bucket").forEach((bucket) => plannerResizeObserver.observe(bucket));
    const tabs = root.querySelector(".crm-planner-project-list"); const selectedTab = tabs?.querySelector(".crm-planner-project.is-selected");
    requestAnimationFrame(() => { if (selectedTab && tabs) { const left = selectedTab.offsetLeft; const right = left + selectedTab.offsetWidth; if (left < tabs.scrollLeft) tabs.scrollLeft = left; else if (right > tabs.scrollLeft + tabs.clientWidth) tabs.scrollLeft = right - tabs.clientWidth; } updatePlannerScrollEdges(); });
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
  function openProjectCreator(anchor) {
    closeFloating(); floating = document.createElement("form"); floating.className = "crm-planner-popover crm-planner-project-creator crm-menu-surface";
    floating.innerHTML = `<div class="crm-planner-popover-title">New project</div><input class="crm-menu-input" name="title" placeholder="Project name" autocomplete="off" required><input class="crm-menu-input" name="stages" value="Backlog, In progress, Done" aria-label="Stages" autocomplete="off"><div class="crm-planner-popover-actions"><button type="button" class="crm-menu-action" data-cancel>Cancel</button><button type="submit" class="crm-menu-action">Create</button></div>`;
    floating.addEventListener("submit", async (event) => {
      event.preventDefault(); const data = new FormData(floating); const title = String(data.get("title") || "").trim();
      const stageTitles = String(data.get("stages") || "").split(/[,\n>]+/).map((value) => value.trim()).filter(Boolean);
      if (!title) return; await createProject(title, "", stageTitles); closeFloating();
    });
    floating.querySelector("[data-cancel]")?.addEventListener("click", closeFloating); place(floating, anchor); armOutside(floating); requestAnimationFrame(() => floating?.elements?.title?.focus());
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
    floating.innerHTML = `<div class="crm-planner-popover-title">Work item</div><div class="crm-planner-item-fields"><input class="crm-menu-input" name="title" value="${esc(item.title)}" required><textarea class="crm-menu-input" name="note" placeholder="What does done look like?">${esc(item.note)}</textarea><select class="crm-menu-input" name="stage" aria-label="Stage">${stagesOf(project).map((stage) => `<option value="${esc(stage.id)}"${stage.id === item.stageId ? " selected" : ""}>${esc(stage.title)}</option>`).join("")}</select><input class="crm-menu-input" name="dueAt" type="date" value="${esc(String(item.dueAt || "").slice(0, 10))}" aria-label="Due date"><select class="crm-menu-input" name="priority" aria-label="Priority">${["normal","high","urgent"].map((value) => `<option value="${value}"${item.priority === value ? " selected" : ""}>${value[0].toUpperCase() + value.slice(1)}</option>`).join("")}</select><select class="crm-menu-input" name="assignee" aria-label="Assignee"><option value="">Unassigned</option>${model.contacts.map((contact) => `<option value="${esc(contact.id)}"${String(item.assignedContactId || "") === String(contact.id) ? " selected" : ""}>${esc(contactName(contact))}</option>`).join("")}</select><select class="crm-menu-input crm-planner-wide" name="target" aria-label="Linked record">${targets.map(([value, label]) => `<option value="${esc(value)}"${selectedTarget === value ? " selected" : ""}>${esc(label)}</option>`).join("")}</select></div><div class="crm-planner-popover-actions"><button type="button" class="crm-menu-action" data-cancel>Cancel</button><button type="submit" class="crm-menu-action">Save</button></div>`;
    floating.addEventListener("submit", async (event) => {
      event.preventDefault(); const data = new FormData(floating); const contact = model.contacts.find((record) => String(record.id) === String(data.get("assignee") || "")); const rawTarget = String(data.get("target") || ""); const [linkedEntityType, ...parts] = rawTarget.split(":"); const due = String(data.get("dueAt") || "");
      await updateItem(item.id, { title:String(data.get("title") || "").trim(), note:String(data.get("note") || ""), stageId:String(data.get("stage") || item.stageId), dueAt:due ? new Date(`${due}T17:00:00`).toISOString() : null, priority:String(data.get("priority") || "normal"), assignedContactId:contact?.id || null, assignee:contact ? contactName(contact) : null, linkedEntityType:rawTarget ? linkedEntityType : null, linkedRecordId:rawTarget ? parts.join(":") : null, linkedLabel:rawTarget ? recordName([...model.tasks, ...model.contacts, ...model.tickets].find((record) => String(record.id) === parts.join(":"))) : null });
      closeFloating();
    });
    floating.querySelector("[data-cancel]")?.addEventListener("click", closeFloating); place(floating, anchor); armOutside(floating); requestAnimationFrame(() => floating?.elements?.title?.focus());
  }

  async function createProject(title, note = "", stageTitles = null) {
    const names = Array.isArray(stageTitles) ? [...new Set(stageTitles.map((value) => String(value || "").trim()).filter(Boolean))] : [];
    const stages = names.length ? names.map((name, index) => normalizeStage({ id:uid("stage"), title:name, kind:index === 0 ? "queue" : index === names.length - 1 ? "done" : "active", rank:index }, index)) : clone(DEFAULT_STAGES);
    const result = await window.crmStore.create("projects", { title, note, stages });
    if (!result?.record) return null; selectedId = result.record.id; await refresh(true, "project-created"); return clone(projectById(selectedId));
  }
  async function createStage(projectId, title) {
    const project = projectById(projectId); if (!project) return null; const stages = stagesOf(project); const stage = normalizeStage({ id:uid("stage"), title, kind:"active", rank:stages.length }, stages.length);
    const result = await window.crmStore.update("projects", project.id, { stages:[...stages, stage] }); if (!result?.record) return null; await refresh(true, "stage-created"); return clone(stage);
  }
  const createBucket = createStage;
  async function createCard(projectId, stageId, title, note = "", options = {}) {
    const project = projectById(projectId); const stage = stageById(project, stageId); if (!project || !stage) return null;
    const item = await createLinkedItem(project, stage, title, note, options); if (!item) return null; await refresh(true, "item-created"); return clone(itemById(item.id));
  }
  function selectProject(projectId) {
    if (!projectById(projectId)) return false; selectedId = String(projectId); publish("project-selected"); return true;
  }
  async function updateProject(projectId, fields, reason = "project-updated") {
    const project = projectById(projectId); if (!project) return false; const result = await window.crmStore.update("projects", project.id, fields); if (!result?.record) return false; await refresh(true, reason); return true;
  }
  async function updateItem(itemId, fields, reason = "item-updated") {
    const item = itemById(itemId); if (!item) return false; const project = projectById(item.projectId); if (!project) return false;
    const stageRequested = Object.prototype.hasOwnProperty.call(fields, "stageId");
    const nextStage = stageRequested ? stageById(project, fields.stageId) : stageById(project, item.stageId);
    if (stageRequested && !nextStage) return false;
    const moving = !!nextStage && nextStage.id !== item.stageId;
    const completed = nextStage?.kind === "done";
    const normalizedFields = { ...fields };
    if (moving) Object.assign(normalizedFields, {
      stageId:nextStage.id, stageLabel:nextStage.title,
      rank:Number.isFinite(Number(fields.rank)) ? Number(fields.rank) : model.items.filter((record) => record.projectId === project.id && record.stageId === nextStage.id && record.id !== item.id).length,
      status:completed ? "completed" : "open", completedAt:completed ? nowIso() : null,
    });
    const result = await window.crmStore.update("workItems", item.id, normalizedFields); if (!result?.record) return false;
    const commitment = commitmentFor(item); if (commitment) {
      const commitmentFields = {};
      ["title","dueAt","priority","assignee","status"].forEach((key) => { if (Object.prototype.hasOwnProperty.call(normalizedFields, key)) commitmentFields[key] = normalizedFields[key]; });
      if (moving) Object.assign(commitmentFields, { stageId:nextStage.id, stageLabel:nextStage.title, completedAt:completed ? nowIso() : null, outcome:completed ? `Completed in ${project.title}` : null });
      if (Object.prototype.hasOwnProperty.call(fields, "linkedEntityType") || Object.prototype.hasOwnProperty.call(fields, "linkedRecordId")) {
        const entityType = Object.prototype.hasOwnProperty.call(fields, "linkedEntityType") ? fields.linkedEntityType : item.linkedEntityType;
        const recordId = Object.prototype.hasOwnProperty.call(fields, "linkedRecordId") ? fields.linkedRecordId : item.linkedRecordId;
        commitmentFields.links = [{ entityType:"workItems", recordId:item.id, relation:"regarding" }];
        if (entityType && recordId) commitmentFields.links.push({ entityType, recordId, relation:"supports" });
      }
      if (Object.keys(commitmentFields).length) await window.crmDomain.update("commitments", commitment.id, commitmentFields, commitment.version);
    }
    if (moving) {
      const flow = flowFor(item); const flowFields = { stage:nextStage.id, rank:normalizedFields.rank, owner:Object.prototype.hasOwnProperty.call(normalizedFields, "assignee") ? normalizedFields.assignee : item.assignee || null };
      if (flow) await window.crmDomain.update("workflow-entries", flow.id, flowFields, flow.version);
      else await window.crmDomain.create("workflow-entries", { workflowKey:`project:${project.id}`, entityType:"workItems", recordId:item.id, ...flowFields });
    }
    await refresh(true, moving ? "item-moved" : reason); return true;
  }
  async function moveCard(itemId, stageId) {
    const item = itemById(itemId); const project = projectById(item?.projectId); const stage = stageById(project, stageId); if (!item || !project || !stage) return false;
    const rank = model.items.filter((record) => record.projectId === project.id && record.stageId === stage.id && record.id !== item.id).length;
    return updateItem(item.id, { stageId:stage.id, rank }, "item-moved");
  }
  async function deleteItem(itemId) {
    const item = itemById(itemId); if (!item) return false; const commitment = commitmentFor(item); const flow = flowFor(item);
    await window.crmStore.remove("workItems", item.id); if (commitment) await window.crmDomain.remove("commitments", commitment.id); if (flow) await window.crmDomain.remove("workflow-entries", flow.id);
    await refresh(true, "item-deleted"); return true;
  }
  async function deleteStage(project, stage) {
    const stages = stagesOf(project); if (stages.length <= 1) return false; const fallback = stages.find((candidate) => candidate.id !== stage.id);
    for (const item of model.items.filter((record) => record.projectId === project.id && record.stageId === stage.id)) await moveCard(item.id, fallback.id);
    return updateProject(project.id, { stages:stages.filter((candidate) => candidate.id !== stage.id).map((candidate, index) => ({ ...candidate, rank:index })) }, "stage-deleted");
  }
  async function deleteProject(project) {
    for (const item of model.items.filter((record) => record.projectId === project.id)) await deleteItem(item.id);
    await window.crmStore.remove("projects", project.id); selectedId = model.projects.find((candidate) => candidate.id !== project.id)?.id || ""; await refresh(true, "project-deleted"); return true;
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
      if (action.dataset.plannerAction === "new-project") openProjectCreator(action);
      if (action.dataset.plannerAction === "project-menu") projectMenu(action);
      if (action.dataset.plannerAction === "new-stage" && project) openTextEditor({ title:"New stage", placeholder:"Stage name", submit:"Add", anchor:action, onSubmit:(value) => createStage(project.id, value) });
      if (action.dataset.plannerAction === "toggle-stack" && project && stage) setStageExpanded(project.id, stage.id);
      if (action.dataset.plannerAction === "stage-menu" && stage) stageMenu(stage, action);
      if (action.dataset.plannerAction === "new-card" && project && stage) openTextEditor({ title:`Add to ${stage.title}`, placeholder:"Work item", submit:"Add", anchor:action, onSubmit:(value) => createCard(project.id, stage.id, value) });
    });
    root.addEventListener("keydown", (event) => {
      const current = event.target.closest(".crm-planner-project"); if (!current || !["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
      const tabs = [...root.querySelectorAll(".crm-planner-project")]; const index = tabs.indexOf(current); if (index < 0) return; event.preventDefault();
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      const projectId = tabs[nextIndex]?.dataset.plannerProject; if (!projectId || !selectProject(projectId)) return;
      requestAnimationFrame(() => root?.querySelector(`.crm-planner-project[data-planner-project="${cssValue(projectId)}"]`)?.focus({ preventScroll:true }));
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
  const homePreviewState = () => {
    const scroller = root?.querySelector(".crm-planner-buckets");
    const tabs = root?.querySelector(".crm-planner-project-list");
    if (scroller?.dataset.plannerScrollProject) plannerScrollPositions.set(scroller.dataset.plannerScrollProject, scroller.scrollLeft);
    return {
      selectedId,
      expandedStages:[...expandedStacks],
      scrollPositions:Object.fromEntries(plannerScrollPositions),
      tabsScrollLeft:tabs?.scrollLeft || 0,
    };
  };
  const applyHomePreviewState = async (state = {}) => {
    mount();
    if (dirty || !model.projects.length) await refresh();
    if (projectById(state.selectedId)) selectedId = String(state.selectedId);
    if (Array.isArray(state.expandedStages)) expandedStacks = new Set(state.expandedStages.map(String));
    if (state.scrollPositions && typeof state.scrollPositions === "object") {
      Object.entries(state.scrollPositions).forEach(([projectId, value]) => {
        const position = Number(value); if (Number.isFinite(position)) plannerScrollPositions.set(String(projectId), Math.max(0, position));
      });
    }
    render();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const scroller = root?.querySelector(".crm-planner-buckets");
    if (scroller) {
      const requested = Number(state.scrollPositions?.[scroller.dataset.plannerScrollProject]);
      if (Number.isFinite(requested)) scroller.scrollLeft = Math.min(Math.max(0, requested), Math.max(0, scroller.scrollWidth - scroller.clientWidth));
    }
    const tabs = root?.querySelector(".crm-planner-project-list");
    const tabsLeft = Number(state.tabsScrollLeft);
    if (tabs && Number.isFinite(tabsLeft)) tabs.scrollLeft = Math.min(Math.max(0, tabsLeft), Math.max(0, tabs.scrollWidth - tabs.clientWidth));
    updatePlannerScrollEdges();
    return homePreviewState();
  };
  async function miniature() { await baseline(); const copy = root.cloneNode(true); copy.hidden = false; copy.removeAttribute("data-crm-theater"); Object.assign(copy.style, { position:"absolute", left:"50%", top:"50%", width:"1280px", height:"860px", transform:"translate(-50%,-50%) scale(.285)", transformOrigin:"center", pointerEvents:"none" }); return copy; }
  async function openItem(itemId) {
    if (dirty || !itemById(itemId)) await refresh(); const item = itemById(itemId); if (!item) return false; selectedId = item.projectId; publish("item-selected");
    await (window.crmDeskTransit?.driveTo?.("planner") || Promise.resolve(window.crmWorkspaces?.setActive?.("planner")));
    requestAnimationFrame(() => { const card = root?.querySelector(`[data-planner-card="${cssValue(item.id)}"]`); card?.classList.add("is-focus-target"); card?.scrollIntoView?.({ block:"nearest", inline:"nearest" }); setTimeout(() => card?.classList.remove("is-focus-target"), 1600); });
    return true;
  }
  const api = { setActive, baseline, miniature, refresh, isActive:() => active, selected:() => selectedId, selectProject, projects:projectsSnapshot, items:() => clone(model.items), createProject, createStage, createBucket, createCard, updateItem, moveCard, deleteItem, openItem, setStageExpanded, expandedStages:() => [...expandedStacks], homePreviewState, applyHomePreviewState, onChanged:(listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
  document.addEventListener("crm:theater-switch", closeFloating); window.addEventListener("storage", (event) => { if (event.key === SELECTED_KEY) { selectedId = localStorage.getItem(SELECTED_KEY) || ""; render(); } });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once:true }); else mount();
  window.crmPlanner = api;
})();
