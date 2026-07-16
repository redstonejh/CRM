// crm-planner.js — user-defined projects made from the app's ordinary buckets and cards.
(() => {
  const STORE_KEY = "crm-planner-projects-v1";
  const SELECTED_KEY = "crm-planner-selected-v1";
  const listeners = new Set();
  let root = null;
  let active = false;
  let editor = null;
  let menu = null;
  let projects = [];
  let selectedId = "";

  const esc = (value) => String(value ?? "").replace(/[&<>\"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[character]));
  const clone = (value) => typeof structuredClone === "function"
    ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  const uid = (prefix) => `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  const nowIso = () => new Date().toISOString();
  const LEGACY_SEED_IDS = new Set(["project-client-launch", "project-operations", "project-renewals"]);

  const normalizeCard = (card = {}) => ({
    id: String(card.id || uid("card")), title: String(card.title || "Untitled item").trim() || "Untitled item",
    note: String(card.note || ""), updatedAt: card.updatedAt || nowIso(),
  });
  const normalizeBucket = (bucket = {}) => ({
    id: String(bucket.id || uid("bucket")), title: String(bucket.title || "Untitled bucket").trim() || "Untitled bucket",
    cards: Array.isArray(bucket.cards) ? bucket.cards.map(normalizeCard) : [],
  });
  const normalizeProject = (project = {}) => ({
    id: String(project.id || uid("project")), title: String(project.title || "Untitled project").trim() || "Untitled project",
    note: String(project.note || ""), updatedAt: project.updatedAt || nowIso(),
    buckets: Array.isArray(project.buckets) ? project.buckets.map(normalizeBucket) : [],
  });
  const read = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      projects = Array.isArray(parsed) ? parsed.map(normalizeProject).filter((project) => !LEGACY_SEED_IDS.has(project.id)) : [];
    } catch { projects = []; }
    selectedId = localStorage.getItem(SELECTED_KEY) || projects[0]?.id || "";
    if (!projects.some((project) => project.id === selectedId)) selectedId = projects[0]?.id || "";
  };
  const write = () => {
    if (!window.crmHomePreviews?.isCaptureWorker) {
      localStorage.setItem(STORE_KEY, JSON.stringify(projects));
      localStorage.setItem(SELECTED_KEY, selectedId);
    }
  };
  const publish = (reason = "changed") => {
    write();
    render();
    const detail = { reason, selectedId, projects: clone(projects) };
    listeners.forEach((listener) => { try { listener(detail); } catch {} });
    document.dispatchEvent(new CustomEvent("crm:planner-change", { detail }));
  };
  const selectedProject = () => projects.find((project) => project.id === selectedId) || projects[0] || null;
  const projectById = (projectId) => projects.find((project) => project.id === String(projectId));
  const bucketById = (project, bucketId) => project?.buckets.find((bucket) => bucket.id === String(bucketId));
  const touch = (project) => { if (project) project.updatedAt = nowIso(); };

  function ensureStyles() {
    if (document.getElementById("crm-planner-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-planner-styles";
    style.textContent = `
      .crm-planner-surface{position:fixed;inset:0;z-index:836;color:#fff;overflow:hidden}.crm-planner-surface[hidden]{display:none}
      .crm-planner-frame{position:absolute;inset:var(--crm-canvas-top,78px) var(--crm-canvas-x,64px) var(--crm-canvas-bottom,78px);max-width:1380px;margin:auto;display:grid;grid-template-columns:210px minmax(0,1fr);gap:var(--crm-section-gap,28px);min-height:0}
      .crm-planner-projects{align-self:start;max-height:calc(100vh - var(--crm-canvas-top,78px) - var(--crm-canvas-bottom,78px));box-sizing:border-box;padding:6px;display:grid;grid-template-rows:40px minmax(0,1fr);overflow:hidden}
      .crm-planner-projects-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 7px 0 10px}
      .crm-planner-projects-title{font-size:var(--crm-type-object,14px);font-weight:680}.crm-planner-new-project.crm-menu-action{width:29px;height:29px;padding:0!important;font-size:17px!important}
      .crm-planner-project-list{min-height:0;display:flex;flex-direction:column;gap:1px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.2) transparent}
      .crm-planner-project-list:empty::after{content:"No projects";padding:9px 10px 12px;color:rgba(255,255,255,.3);font-size:var(--crm-type-meta,10px)}
      .crm-planner-project.crm-menu-action{position:relative;width:100%;min-height:39px;padding:0 10px!important;text-align:left;font-size:var(--crm-type-body,12px)!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .crm-planner-project.is-selected:before{content:"";position:absolute;left:3px;top:12px;width:3px;height:15px;border-radius:2px;background:rgba(166,202,249,.72)}
      .crm-planner-stage{min-width:0;min-height:0;display:grid;grid-template-rows:42px minmax(0,1fr);gap:12px}
      .crm-planner-topline{min-width:0;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 4px}
      .crm-planner-heading{min-width:0;font-size:var(--crm-type-room,17px);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .crm-planner-head-actions{display:flex;align-items:center;gap:2px}.crm-planner-text-action.crm-menu-action{height:30px;font-size:var(--crm-type-caption,11px)!important;padding:0 8px!important}.crm-planner-project-menu{width:30px!important;padding:0!important;font-size:14px!important;text-align:center}
      .crm-planner-buckets{min-width:0;min-height:0;display:flex;align-items:flex-start;justify-content:safe center;gap:var(--crm-object-gap,18px);overflow-x:auto;overflow-y:hidden;padding:clamp(30px,5.5vh,48px) 12px 28px;box-sizing:border-box;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}
      .crm-planner-bucket.tk-zone{position:relative;inset:auto;z-index:auto;flex:0 0 220px;width:220px;height:360px;box-sizing:border-box;padding:12px 14px 12px;overflow:hidden;transition:width .16s ease,flex-basis .16s ease,height .16s ease}
      .crm-planner-bucket .tk-zone-hd{flex:0 0 30px}.crm-planner-bucket .tk-zone-hd-r{right:4px;top:6px}
      .crm-planner-card-list{min-height:0;flex:1 1 auto;overflow-y:auto;display:flex;flex-direction:column;align-items:center;gap:7px;padding:4px 2px 8px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}
      .crm-planner-card{appearance:none;position:relative;flex:0 0 auto;width:184px;min-height:82px;box-sizing:border-box;padding:12px 13px;text-align:left;border:0;border-radius:15px;background:linear-gradient(150deg,rgba(98,112,134,.92),rgba(62,74,94,.9));color:rgba(255,255,255,.9);box-shadow:inset 0 1px rgba(255,255,255,.22),0 14px 18px -14px rgba(0,0,0,.5);cursor:pointer;transition:width .16s ease,min-height .16s ease,box-shadow .14s ease}
      .crm-planner-card:hover,.crm-planner-card:focus-visible{outline:0;box-shadow:inset 0 0 0 9999px rgba(255,255,255,.1),inset 0 1px rgba(255,255,255,.3),0 14px 18px -14px rgba(0,0,0,.5)}
      .crm-planner-card-title{display:block;font-size:var(--crm-type-body,12px);font-weight:680;line-height:1.28;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-planner-card-note{display:block;margin-top:7px;color:rgba(255,255,255,.48);font-size:var(--crm-type-meta,10px);line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .crm-planner-add-card.crm-menu-action{flex:0 0 29px;width:100%;height:29px;text-align:left;padding-left:4px!important;font-size:var(--crm-type-caption,11px)!important;color:rgba(255,255,255,.32)!important}.crm-planner-add-card:hover{color:#fff!important}
      .crm-planner-bucket.crm-object-small{scale:1!important;flex-basis:184px;width:184px;height:304px}.crm-planner-card.crm-object-small{scale:1!important;width:138px;min-height:62px;padding:10px 11px}.crm-planner-card.crm-object-small .crm-planner-card-note{display:none}
      .crm-planner-empty{height:100%;display:grid;place-items:center;padding:16px;text-align:center;color:rgba(255,255,255,.3);font-size:var(--crm-type-caption,11px)}
      .crm-planner-popover{position:fixed;z-index:9300;width:min(264px,calc(100vw - 28px));padding:9px;display:grid;gap:8px}.crm-planner-popover-title{padding:2px 3px 5px;font-size:var(--crm-type-control,13px);font-weight:700;color:#fff}.crm-planner-popover-actions{display:flex;justify-content:flex-end;gap:2px}.crm-planner-popover .crm-menu-action{height:32px;font-size:var(--crm-type-body,12px)!important}
      .crm-planner-context{position:fixed;z-index:9310;width:158px;padding:6px;display:grid;gap:1px}.crm-planner-context .crm-menu-action{height:33px;text-align:left;font-size:var(--crm-type-body,12px)!important}
      @media(max-width:1050px){.crm-planner-frame{grid-template-columns:184px minmax(0,1fr);gap:16px}.crm-planner-buckets{justify-content:flex-start;padding-inline:8px}}
    `;
    document.head.appendChild(style);
  }

  function render() {
    if (!root) return;
    const project = selectedProject();
    root.innerHTML = `<div class="crm-planner-frame">
      <aside class="crm-planner-projects crm-menu-surface"><header class="crm-planner-projects-head crm-menu-item"><span class="crm-planner-projects-title">Projects</span><button type="button" class="crm-planner-new-project crm-menu-action" data-planner-action="new-project" aria-label="Create project">+</button></header><nav class="crm-planner-project-list" aria-label="Projects">${projects.map((item) => `<button type="button" class="crm-planner-project crm-menu-action${item.id === project?.id ? " is-selected" : ""}" data-planner-project="${esc(item.id)}">${esc(item.title)}</button>`).join("")}</nav></aside>
      <section class="crm-planner-stage"><header class="crm-planner-topline"><div class="crm-planner-heading">${esc(project?.title || "Planner")}</div><div class="crm-planner-head-actions">${project ? '<button type="button" class="crm-planner-text-action crm-planner-project-menu crm-menu-action" data-planner-action="project-menu" aria-label="Project options">···</button><button type="button" class="crm-planner-text-action crm-menu-action" data-planner-action="new-bucket">Add bucket</button>' : ""}</div></header>
      <div class="crm-planner-buckets">${project ? project.buckets.map((bucket) => `<section class="crm-planner-bucket tk-zone" data-planner-bucket="${esc(bucket.id)}">
        <header class="tk-zone-hd"><span class="tk-zone-title">${esc(bucket.title)}</span><span class="tk-zone-hd-r tk-bars" aria-hidden="true"><i class="tk-seg g"></i><i class="tk-seg"></i><i class="tk-seg"></i></span></header>
        <div class="crm-planner-card-list">${bucket.cards.length ? bucket.cards.map((card) => `<button type="button" class="crm-planner-card" data-planner-card="${esc(card.id)}"><span class="crm-planner-card-title">${esc(card.title)}</span>${card.note ? `<span class="crm-planner-card-note">${esc(card.note)}</span>` : ""}</button>`).join("") : '<div class="crm-planner-empty">No items</div>'}</div>
        <button type="button" class="crm-planner-add-card crm-menu-action" data-planner-action="new-card">+ Add item</button>
      </section>`).join("") : ""}</div></section>
    </div>`;
  }

  const place = (element, anchor, x, y) => {
    document.body.appendChild(element);
    const anchorRect = anchor?.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    const left = Math.max(12, Math.min(innerWidth - bounds.width - 12, Number.isFinite(x) ? x : (anchorRect?.right || innerWidth / 2) - bounds.width));
    const top = Math.max(48, Math.min(innerHeight - bounds.height - 16, Number.isFinite(y) ? y : (anchorRect?.bottom || innerHeight / 2) + 5));
    element.style.left = `${left}px`; element.style.top = `${top}px`;
  };
  const closeFloating = () => { editor?.remove(); menu?.remove(); editor = null; menu = null; };
  const armOutsideClose = (element) => setTimeout(() => {
    const close = (event) => {
      if (element.contains(event.target)) return;
      element.remove(); if (element === editor) editor = null; if (element === menu) menu = null;
      document.removeEventListener("pointerdown", close, true);
    };
    document.addEventListener("pointerdown", close, true);
  }, 0);
  function openEditor({ title, value = "", placeholder = "Name", submit = "Save", anchor, onSubmit }) {
    closeFloating();
    editor = document.createElement("form"); editor.className = "crm-planner-popover crm-menu-surface";
    editor.innerHTML = `<div class="crm-planner-popover-title">${esc(title)}</div><input class="crm-menu-input" name="value" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off"><div class="crm-planner-popover-actions"><button type="button" class="crm-menu-action" data-cancel>Cancel</button><button type="submit" class="crm-menu-action">${esc(submit)}</button></div>`;
    editor.addEventListener("submit", (event) => { event.preventDefault(); const input = editor.elements.value.value.trim(); if (!input) return; onSubmit(input); closeFloating(); });
    editor.querySelector("[data-cancel]").addEventListener("click", closeFloating);
    place(editor, anchor); armOutsideClose(editor);
    requestAnimationFrame(() => { editor?.elements.value.focus(); editor?.elements.value.select(); });
  }
  function openMenu(anchor, actions, x, y) {
    closeFloating(); menu = document.createElement("div"); menu.className = "crm-planner-context crm-menu-surface";
    actions.forEach((action) => {
      const button = document.createElement("button"); button.type = "button"; button.className = `crm-menu-action${action.danger ? " tk-menu-danger" : ""}`; button.textContent = action.label;
      button.addEventListener("click", () => { closeFloating(); action.run(); }); menu.appendChild(button);
    });
    place(menu, anchor, x, y); armOutsideClose(menu);
  }

  const createProject = (title, note = "") => {
    const project = normalizeProject({ id: uid("project"), title, note, updatedAt: nowIso(), buckets: [] });
    projects.unshift(project); selectedId = project.id; publish("project-created"); return clone(project);
  };
  const createBucket = (projectId, title) => {
    const project = projectById(projectId); if (!project) return null;
    const bucket = normalizeBucket({ id: uid("bucket"), title, cards: [] }); project.buckets.push(bucket); touch(project); publish("bucket-created"); return clone(bucket);
  };
  const createCard = (projectId, bucketId, title, note = "") => {
    const project = projectById(projectId); const bucket = bucketById(project, bucketId); if (!project || !bucket) return null;
    const card = normalizeCard({ id: uid("card"), title, note }); bucket.cards.push(card); touch(project); publish("card-created"); return clone(card);
  };
  const selectProject = (projectId) => {
    if (!projectById(projectId)) return false;
    selectedId = String(projectId); publish("project-selected"); return true;
  };

  function projectMenu(anchor) {
    const project = selectedProject(); if (!project) return;
    openMenu(anchor, [
      { label: "Rename", run: () => openEditor({ title: "Rename project", value: project.title, anchor, onSubmit: (value) => { project.title = value; touch(project); publish("project-renamed"); } }) },
      { label: "Delete project", danger: true, run: () => { projects = projects.filter((item) => item.id !== project.id); selectedId = projects[0]?.id || ""; publish("project-deleted"); } },
    ]);
  }
  function bucketMenu(bucket, anchor, x, y) {
    const project = selectedProject(); if (!project || !bucket) return;
    const sizeTarget = anchor?.closest?.("[data-planner-bucket]") || root?.querySelector(`[data-planner-bucket="${CSS.escape(bucket.id)}"]`);
    openMenu(anchor, [
      { label: window.crmObjectSizing?.isSmall?.(sizeTarget, "bucket") ? "Make large" : "Make small", run: () => window.crmObjectSizing?.toggle?.(sizeTarget, "bucket") },
      { label: "Rename", run: () => openEditor({ title: "Rename bucket", value: bucket.title, anchor, onSubmit: (value) => { bucket.title = value; touch(project); publish("bucket-renamed"); } }) },
      { label: "Delete bucket", danger: true, run: () => { project.buckets = project.buckets.filter((item) => item.id !== bucket.id); touch(project); publish("bucket-deleted"); } },
    ], x, y);
  }
  function cardMenu(bucket, card, anchor, x, y) {
    const project = selectedProject(); if (!project || !bucket || !card) return;
    openMenu(anchor, [
      { label: window.crmObjectSizing?.isSmall?.(anchor, "card") ? "Make large" : "Make small", run: () => window.crmObjectSizing?.toggle?.(anchor, "card") },
      { label: "Rename", run: () => openEditor({ title: "Rename item", value: card.title, anchor, onSubmit: (value) => { card.title = value; card.updatedAt = nowIso(); touch(project); publish("card-renamed"); } }) },
      { label: "Edit note", run: () => openEditor({ title: "Item note", value: card.note, placeholder: "A small update", anchor, onSubmit: (value) => { card.note = value; card.updatedAt = nowIso(); touch(project); publish("card-updated"); } }) },
      { label: "Delete item", danger: true, run: () => { bucket.cards = bucket.cards.filter((item) => item.id !== card.id); touch(project); publish("card-deleted"); } },
    ], x, y);
  }

  function mount() {
    if (root) return root;
    ensureStyles(); read();
    root = document.createElement("main"); root.className = "crm-planner-surface"; root.dataset.crmTheater = "planner"; root.hidden = true;
    root.addEventListener("click", (event) => {
      const projectButton = event.target.closest("[data-planner-project]");
      if (projectButton) { selectProject(projectButton.dataset.plannerProject); return; }
      const action = event.target.closest("[data-planner-action]"); if (!action) return;
      const project = selectedProject(); const bucketElement = action.closest("[data-planner-bucket]"); const bucket = bucketById(project, bucketElement?.dataset.plannerBucket);
      if (action.dataset.plannerAction === "new-project") openEditor({ title: "New project", placeholder: "Project name", submit: "Create", anchor: action, onSubmit: (value) => createProject(value) });
      if (action.dataset.plannerAction === "project-menu") projectMenu(action);
      if (action.dataset.plannerAction === "new-bucket" && project) openEditor({ title: "New bucket", placeholder: "Bucket name", submit: "Create", anchor: action, onSubmit: (value) => createBucket(project.id, value) });
      if (action.dataset.plannerAction === "bucket-menu") bucketMenu(bucket, action);
      if (action.dataset.plannerAction === "new-card" && project && bucket) openEditor({ title: `Add to ${bucket.title}`, placeholder: "Item title", submit: "Add", anchor: action, onSubmit: (value) => createCard(project.id, bucket.id, value) });
    });
    root.addEventListener("dblclick", (event) => {
      const cardElement = event.target.closest("[data-planner-card]"); if (!cardElement) return;
      const project = selectedProject(); const bucket = bucketById(project, cardElement.closest("[data-planner-bucket]")?.dataset.plannerBucket); const card = bucket?.cards.find((item) => item.id === cardElement.dataset.plannerCard);
      if (card) openEditor({ title: "Rename item", value: card.title, anchor: cardElement, onSubmit: (value) => { card.title = value; card.updatedAt = nowIso(); touch(project); publish("card-renamed"); } });
    });
    root.addEventListener("contextmenu", (event) => {
      const project = selectedProject(); const bucketElement = event.target.closest("[data-planner-bucket]"); const bucket = bucketById(project, bucketElement?.dataset.plannerBucket); const cardElement = event.target.closest("[data-planner-card]");
      if (cardElement && bucket) { event.preventDefault(); const card = bucket.cards.find((item) => item.id === cardElement.dataset.plannerCard); cardMenu(bucket, card, cardElement, event.clientX, event.clientY); }
      else if (bucketElement && bucket) { event.preventDefault(); bucketMenu(bucket, bucketElement, event.clientX, event.clientY); }
    });
    document.body.appendChild(root); render(); return root;
  }

  const setActive = (on) => { active = !!on; mount(); root.hidden = !active; if (!active) closeFloating(); return api; };
  const baseline = async () => { mount(); render(); root.hidden = !active; return root; };
  const api = {
    setActive, baseline, isActive: () => active, selected: () => selectedId, selectProject,
    projects: () => clone(projects), createProject, createBucket, createCard,
    onChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  window.addEventListener("storage", (event) => { if (event.key === STORE_KEY) { read(); render(); } });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true }); else mount();
  window.crmPlanner = api;
})();
