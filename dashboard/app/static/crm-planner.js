// crm-planner.js — small, editable project worlds shared with Overview.
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
  const seed = () => [
    {
      id: "project-client-launch", title: "Client launch", note: "A calm path from approval to release", updatedAt: "2026-07-14T18:20:00.000Z",
      buckets: [
        { id: "launch-shape", title: "Shape", cards: [
          { id: "launch-brief", title: "Confirm the final brief", note: "Waiting on one stakeholder", updatedAt: "2026-07-14T18:20:00.000Z" },
          { id: "launch-copy", title: "Tighten launch copy", note: "Voice pass is ready", updatedAt: "2026-07-13T16:10:00.000Z" },
        ] },
        { id: "launch-build", title: "Build", cards: [
          { id: "launch-assets", title: "Package campaign assets", note: "12 of 15 approved", updatedAt: "2026-07-14T15:45:00.000Z" },
          { id: "launch-qa", title: "Run release QA", note: "Desktop complete", updatedAt: "2026-07-12T11:00:00.000Z" },
        ] },
        { id: "launch-release", title: "Release", cards: [
          { id: "launch-handoff", title: "Schedule handoff", note: "Thursday · 10:30", updatedAt: "2026-07-14T13:05:00.000Z" },
        ] },
      ],
    },
    {
      id: "project-operations", title: "Operations reset", note: "Remove friction from the weekly rhythm", updatedAt: "2026-07-13T20:40:00.000Z",
      buckets: [
        { id: "ops-observe", title: "Observe", cards: [
          { id: "ops-intake", title: "Map the intake path", note: "Three handoffs found", updatedAt: "2026-07-13T20:40:00.000Z" },
        ] },
        { id: "ops-improve", title: "Improve", cards: [
          { id: "ops-template", title: "Simplify weekly template", note: "Draft ready for review", updatedAt: "2026-07-13T17:10:00.000Z" },
          { id: "ops-rules", title: "Define escalation rules", note: "Needs owner", updatedAt: "2026-07-12T16:30:00.000Z" },
        ] },
        { id: "ops-keep", title: "Keep", cards: [
          { id: "ops-notes", title: "Publish decision notes", note: "Every Friday", updatedAt: "2026-07-11T12:00:00.000Z" },
        ] },
      ],
    },
    {
      id: "project-renewals", title: "Renewals", note: "Make every account decision visible", updatedAt: "2026-07-12T14:15:00.000Z",
      buckets: [
        { id: "renewals-next", title: "Next", cards: [
          { id: "renewals-north", title: "Northwind review", note: "Usage notes attached", updatedAt: "2026-07-12T14:15:00.000Z" },
          { id: "renewals-verde", title: "Verde scope", note: "Draft pricing", updatedAt: "2026-07-12T10:00:00.000Z" },
        ] },
        { id: "renewals-conversation", title: "Conversation", cards: [
          { id: "renewals-orbit", title: "Orbit expansion", note: "Call on Wednesday", updatedAt: "2026-07-11T19:20:00.000Z" },
        ] },
        { id: "renewals-decided", title: "Decided", cards: [
          { id: "renewals-cascade", title: "Cascade renewal", note: "Approved", updatedAt: "2026-07-10T15:10:00.000Z" },
        ] },
      ],
    },
  ];

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
      projects = Array.isArray(parsed) && parsed.length ? parsed.map(normalizeProject) : seed();
    } catch { projects = seed(); }
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
      .crm-planner-frame{position:absolute;inset:62px 50px 84px;max-width:1400px;margin:auto;display:grid;grid-template-columns:238px minmax(0,1fr);gap:16px}
      .crm-planner-sidebar{min-height:0;padding:8px;display:grid;grid-template-rows:46px minmax(0,1fr)}
      .crm-planner-sidebar-head,.crm-planner-canvas-head{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}
      .crm-planner-sidebar-head{padding:0 7px 0 11px}.crm-planner-sidebar-title{font-size:.82rem;font-weight:720;letter-spacing:.01em}
      .crm-planner-icon{appearance:none;width:30px;height:30px;padding:0;border:0;border-radius:8px;background:transparent;color:rgba(255,255,255,.48);cursor:pointer;display:grid;place-items:center;font:500 18px/1 system-ui;transition:color .14s ease}.crm-planner-icon:hover,.crm-planner-icon:focus-visible{color:#fff;outline:0}
      .crm-planner-project-list{min-height:0;overflow-y:auto;overflow-x:hidden;display:grid;align-content:start;gap:2px;padding-right:2px;scrollbar-width:thin}
      .crm-planner-project.crm-menu-action{position:relative;width:100%;height:64px;padding:8px 8px 8px 14px!important;display:grid;grid-template-columns:minmax(0,1fr) 54px;align-items:center;gap:9px;text-align:left;font-size:.78rem!important}
      .crm-planner-project.is-selected:before{content:"";position:absolute;left:2px;top:17px;width:2px;height:30px;border-radius:4px;background:rgba(143,191,255,.88);box-shadow:0 0 12px rgba(98,159,240,.42)}
      .crm-planner-project-copy{min-width:0}.crm-planner-project-name{display:block;color:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-planner-project-meta{display:block;margin-top:5px;color:rgba(255,255,255,.34);font-size:9px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .crm-project-minimap{height:31px;display:flex;align-items:stretch;gap:3px;padding:3px;border-radius:7px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.055);overflow:hidden}
      .crm-project-minimap-column{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}.crm-project-minimap-column:before{content:"";height:2px;border-radius:4px;background:rgba(190,215,249,.27)}
      .crm-project-minimap-card{display:block;height:4px;border-radius:2px;background:rgba(126,169,228,.24)}.crm-project-minimap-card:nth-child(3n){width:72%}
      .crm-planner-main{min-width:0;min-height:0;display:grid;grid-template-rows:54px minmax(0,1fr);gap:12px}
      .crm-planner-canvas-head{padding:0 12px 0 16px}.crm-planner-heading-copy{min-width:0}.crm-planner-heading{font-size:.94rem;font-weight:720;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-planner-subheading{margin-top:4px;color:rgba(255,255,255,.39);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .crm-planner-head-actions{display:flex;align-items:center;gap:2px}.crm-planner-text-action.crm-menu-action{height:32px;font-size:.72rem!important;padding:0 9px!important}
      .crm-planner-buckets{min-width:0;min-height:0;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(226px,1fr);gap:12px;overflow-x:auto;overflow-y:hidden;padding:2px 2px 10px;scrollbar-width:thin}
      .crm-planner-bucket{position:relative;min-width:0;min-height:0;padding:10px;display:grid;grid-template-rows:34px minmax(0,1fr) 34px;overflow:hidden}
      .crm-planner-bucket-head{display:flex;align-items:center;min-width:0;padding:0 30px 0 3px}.crm-planner-bucket-title{font-size:.76rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .crm-planner-bucket-menu{position:absolute;right:7px;top:7px;width:28px;height:28px;font-size:16px}.crm-planner-card-list{min-height:0;overflow-y:auto;display:grid;align-content:start;gap:7px;padding:3px 1px 8px;scrollbar-width:thin}
      .crm-planner-card{appearance:none;position:relative;width:100%;min-height:74px;padding:11px;text-align:left;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:linear-gradient(155deg,rgba(112,151,207,.12),rgba(255,255,255,.025));color:rgba(255,255,255,.88);box-shadow:inset 0 1px rgba(255,255,255,.045),0 8px 20px -18px rgba(0,0,0,.8);cursor:pointer;transition:border-color .14s ease,background .14s ease}.crm-planner-card:hover,.crm-planner-card:focus-visible{outline:0;border-color:rgba(164,199,245,.2);background:linear-gradient(155deg,rgba(112,151,207,.17),rgba(255,255,255,.035))}
      .crm-planner-card-title{display:block;padding-right:14px;font-size:.72rem;font-weight:680;line-height:1.28}.crm-planner-card-note{display:block;margin-top:7px;color:rgba(255,255,255,.4);font-size:9px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .crm-planner-add-card.crm-menu-action{width:100%;height:32px;text-align:left;padding-left:4px!important;font-size:.68rem!important;color:rgba(255,255,255,.35)!important}.crm-planner-add-card:hover{color:#fff!important}
      .crm-planner-empty{height:100%;display:grid;place-items:center;padding:22px;text-align:center;color:rgba(255,255,255,.34);font-size:.7rem;line-height:1.45}
      .crm-planner-popover{position:fixed;z-index:9300;width:min(286px,calc(100vw - 28px));padding:9px;display:grid;gap:8px}.crm-planner-popover-title{padding:2px 3px 5px;font-size:.72rem;font-weight:700;color:#fff}.crm-planner-popover-actions{display:flex;justify-content:flex-end;gap:2px}.crm-planner-popover .crm-menu-action{height:32px;font-size:.72rem!important}
      .crm-planner-context{position:fixed;z-index:9310;width:166px;padding:6px;display:grid;gap:1px}.crm-planner-context .crm-menu-action{height:34px;text-align:left;font-size:.72rem!important}
      @media(max-width:900px){.crm-planner-frame{inset:58px 22px 82px;grid-template-columns:190px minmax(0,1fr);gap:10px}.crm-planner-buckets{grid-auto-columns:minmax(210px,1fr)}}
    `;
    document.head.appendChild(style);
  }

  const miniature = (project) => `<span class="crm-project-minimap" aria-hidden="true">${project.buckets.slice(0, 4).map((bucket) => `<span class="crm-project-minimap-column">${bucket.cards.slice(0, 4).map(() => '<i class="crm-project-minimap-card"></i>').join("")}</span>`).join("")}</span>`;
  const summary = (project) => {
    const items = project.buckets.reduce((total, bucket) => total + bucket.cards.length, 0);
    return `${project.buckets.length} ${project.buckets.length === 1 ? "bucket" : "buckets"} · ${items} ${items === 1 ? "item" : "items"}`;
  };

  function render() {
    if (!root) return;
    const project = selectedProject();
    root.innerHTML = `<div class="crm-planner-frame">
      <aside class="crm-planner-sidebar crm-menu-surface">
        <header class="crm-planner-sidebar-head"><span class="crm-planner-sidebar-title">Projects</span><button type="button" class="crm-planner-icon" data-planner-action="new-project" aria-label="Create project">+</button></header>
        <div class="crm-planner-project-list">${projects.map((item) => `<button type="button" class="crm-planner-project crm-menu-action${item.id === project?.id ? " is-selected" : ""}" data-planner-project="${esc(item.id)}"><span class="crm-planner-project-copy"><span class="crm-planner-project-name">${esc(item.title)}</span><span class="crm-planner-project-meta">${esc(summary(item))}</span></span>${miniature(item)}</button>`).join("")}</div>
      </aside>
      <section class="crm-planner-main">
        <header class="crm-planner-canvas-head crm-menu-surface">
          <div class="crm-planner-heading-copy"><div class="crm-planner-heading">${esc(project?.title || "Projects")}</div><div class="crm-planner-subheading">${esc(project?.note || "Define a project with the buckets it actually needs.")}</div></div>
          <div class="crm-planner-head-actions">${project ? '<button type="button" class="crm-planner-text-action crm-menu-action" data-planner-action="project-menu">Project</button><button type="button" class="crm-planner-text-action crm-menu-action" data-planner-action="new-bucket">Add bucket</button>' : '<button type="button" class="crm-planner-text-action crm-menu-action" data-planner-action="new-project">New project</button>'}</div>
        </header>
        <div class="crm-planner-buckets">${project ? project.buckets.map((bucket) => `<section class="crm-planner-bucket crm-menu-surface" data-planner-bucket="${esc(bucket.id)}">
          <header class="crm-planner-bucket-head"><span class="crm-planner-bucket-title">${esc(bucket.title)}</span></header><button type="button" class="crm-planner-icon crm-planner-bucket-menu" data-planner-action="bucket-menu" aria-label="Options for ${esc(bucket.title)}">···</button>
          <div class="crm-planner-card-list">${bucket.cards.length ? bucket.cards.map((card) => `<button type="button" class="crm-planner-card" data-planner-card="${esc(card.id)}"><span class="crm-planner-card-title">${esc(card.title)}</span>${card.note ? `<span class="crm-planner-card-note">${esc(card.note)}</span>` : ""}</button>`).join("") : '<div class="crm-planner-empty">This bucket is ready for its first item.</div>'}</div>
          <button type="button" class="crm-planner-add-card crm-menu-action" data-planner-action="new-card">+ Add item</button>
        </section>`).join("") : '<div class="crm-planner-empty">Create a project to start shaping a plan.</div>'}</div>
      </section>
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
    const project = normalizeProject({ id: uid("project"), title, note, updatedAt: nowIso(), buckets: [
      { id: uid("bucket"), title: "Ideas", cards: [] }, { id: uid("bucket"), title: "In progress", cards: [] }, { id: uid("bucket"), title: "Done", cards: [] },
    ] });
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
      { label: "Edit description", run: () => openEditor({ title: "Project description", value: project.note, placeholder: "A short purpose", anchor, onSubmit: (value) => { project.note = value; touch(project); publish("project-updated"); } }) },
      { label: "Delete project", danger: true, run: () => { if (projects.length <= 1) return; projects = projects.filter((item) => item.id !== project.id); selectedId = projects[0]?.id || ""; publish("project-deleted"); } },
    ]);
  }
  function bucketMenu(bucket, anchor, x, y) {
    const project = selectedProject(); if (!project || !bucket) return;
    openMenu(anchor, [
      { label: "Rename", run: () => openEditor({ title: "Rename bucket", value: bucket.title, anchor, onSubmit: (value) => { bucket.title = value; touch(project); publish("bucket-renamed"); } }) },
      { label: "Delete bucket", danger: true, run: () => { project.buckets = project.buckets.filter((item) => item.id !== bucket.id); touch(project); publish("bucket-deleted"); } },
    ], x, y);
  }
  function cardMenu(bucket, card, anchor, x, y) {
    const project = selectedProject(); if (!project || !bucket || !card) return;
    openMenu(anchor, [
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
      if (action.dataset.plannerAction === "new-project") openEditor({ title: "New project", placeholder: "Project name", submit: "Create", anchor: action, onSubmit: (value) => createProject(value, "A custom project plan") });
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
