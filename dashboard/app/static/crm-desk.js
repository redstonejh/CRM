// crm-desk.js — Overview as a set of lightweight project pocket universes.
(() => {
  let root = null;
  let active = false;
  let model = null;
  let dirty = true;
  let timer = 0;

  const esc = (value) => String(value ?? "").replace(/[&<>\"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[character]));
  const rows = (result) => result?.records || [];
  const first = (...values) => values.map((value) => String(value ?? "").trim()).find(Boolean) || "";
  const ticketTitle = (ticket) => first(ticket?.title, ticket?.subject, ticket?.name, ticket?.id, "Untitled ticket");
  const ticketMeta = (ticket) => first(ticket?.companyLabel, ticket?.client, ticket?.requesterName, ticket?.priority, ticket?.state, "Open ticket");
  const updateTitle = (activity) => first(activity?.title, activity?.summary, activity?.description, activity?.type, "Project updated");
  const timeValue = (item) => Date.parse(item?.updatedAt || item?.occurredAt || item?.createdAt || "") || 0;
  const relativeTime = (value) => {
    const milliseconds = Date.now() - (Date.parse(value || "") || Date.now());
    const minutes = Math.max(0, Math.floor(milliseconds / 60000));
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24); return `${days}d`;
  };
  const projectCards = (project) => project?.buckets.flatMap((bucket) => bucket.cards.map((card) => ({ ...card, bucket: bucket.title, projectId: project.id, projectTitle: project.title }))) || [];

  function ensureStyles() {
    if (document.getElementById("crm-overview-styles")) return;
    const style = document.createElement("style"); style.id = "crm-overview-styles";
    style.textContent = `
      .crm-overview-surface{position:fixed;inset:0;z-index:835;color:#fff;pointer-events:auto;overflow:hidden}.crm-overview-surface[hidden]{display:none}
      .crm-overview-frame{position:absolute;inset:58px 48px 84px;max-width:1400px;margin:auto;display:grid;grid-template-rows:56px minmax(0,1fr);gap:12px}
      .crm-overview-head{display:flex;align-items:center;justify-content:space-between;min-width:0;padding:0 5px}.crm-overview-title{font:720 1rem/1.1 system-ui;letter-spacing:-.012em}.crm-overview-brief{margin-top:5px;color:rgba(255,255,255,.42);font-size:10px}
      .crm-overview-worlds{min-height:0;display:grid;grid-template-columns:minmax(276px,.85fr) minmax(420px,1.5fr) minmax(250px,.78fr);gap:14px}
      .crm-overview-pocket{min-width:0;min-height:0;padding:9px;display:grid;grid-template-rows:40px minmax(0,1fr);overflow:hidden}
      .crm-overview-pocket-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 8px}.crm-overview-pocket-title{font-size:.78rem;font-weight:720}.crm-overview-pocket-hint{color:rgba(255,255,255,.32);font-size:9px;white-space:nowrap}
      .crm-overview-project-list{min-height:0;overflow-y:auto;display:grid;align-content:start;gap:5px;padding:2px 2px 4px;scrollbar-width:thin}
      .crm-overview-project{appearance:none;width:100%;height:106px;display:grid;grid-template-rows:auto minmax(0,1fr);gap:8px;padding:11px;text-align:left;border:0;border-radius:10px;background:transparent;color:rgba(255,255,255,.75);cursor:pointer;transition:color .14s ease,background .14s ease}.crm-overview-project:hover,.crm-overview-project:focus-visible,.crm-overview-project.is-selected{outline:0;color:#fff;background:rgba(255,255,255,.025)}
      .crm-overview-project-copy{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0}.crm-overview-project-name{font-size:.7rem;font-weight:680;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-overview-project-state{color:rgba(255,255,255,.3);font-size:8px;white-space:nowrap}
      .crm-overview-mini-world{min-height:0;display:flex;gap:5px;padding:6px;border:1px solid rgba(255,255,255,.055);border-radius:8px;background:rgba(255,255,255,.018);overflow:hidden}.crm-overview-mini-lane{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}.crm-overview-mini-lane:before{content:"";height:2px;border-radius:3px;background:rgba(195,218,248,.25)}.crm-overview-mini-card{display:block;height:7px;border-radius:3px;background:linear-gradient(90deg,rgba(117,165,230,.22),rgba(255,255,255,.035))}.crm-overview-mini-card:nth-child(3n){width:72%}
      .crm-overview-focus-body{min-height:0;display:grid;grid-template-rows:218px minmax(0,1fr);gap:9px}
      .crm-overview-featured{position:relative;min-height:0;padding:14px;border-radius:11px;background:linear-gradient(150deg,rgba(85,127,188,.105),rgba(255,255,255,.015));border:1px solid rgba(255,255,255,.065);overflow:hidden}.crm-overview-featured-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.crm-overview-featured-title{font-size:.88rem;font-weight:720;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-overview-featured-note{margin-top:5px;color:rgba(255,255,255,.38);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-overview-featured-open.crm-menu-action{height:28px;font-size:.66rem!important;padding:0 4px!important}
      .crm-overview-map{position:absolute;left:13px;right:13px;bottom:13px;height:130px;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(74px,1fr);gap:8px;overflow:hidden}.crm-overview-map-lane{min-width:0;padding:8px;border-radius:8px;background:rgba(255,255,255,.023);border:1px solid rgba(255,255,255,.055);overflow:hidden}.crm-overview-map-title{display:block;color:rgba(255,255,255,.35);font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-overview-map-cards{display:grid;gap:4px;margin-top:8px}.crm-overview-map-card{height:19px;border-radius:5px;background:linear-gradient(145deg,rgba(119,162,220,.17),rgba(255,255,255,.027));border:1px solid rgba(255,255,255,.035)}.crm-overview-map-card:nth-child(2n){width:84%}
      .crm-overview-tickets{min-height:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-content:start;gap:7px;overflow-y:auto;padding:1px;scrollbar-width:thin}.crm-overview-ticket{appearance:none;min-width:0;min-height:92px;padding:11px;text-align:left;border:1px solid rgba(255,255,255,.07);border-radius:10px;background:linear-gradient(150deg,rgba(100,143,203,.09),rgba(255,255,255,.018));color:rgba(255,255,255,.8);cursor:pointer;transition:border-color .14s ease,background .14s ease}.crm-overview-ticket:hover,.crm-overview-ticket:focus-visible{outline:0;border-color:rgba(160,197,245,.2);background:linear-gradient(150deg,rgba(100,143,203,.14),rgba(255,255,255,.026))}.crm-overview-ticket-label{display:flex;align-items:center;gap:6px;color:rgba(159,196,245,.55);font-size:8px;text-transform:uppercase;letter-spacing:.07em}.crm-overview-ticket-label:before{content:"";width:4px;height:4px;border-radius:50%;background:currentColor}.crm-overview-ticket-title{display:block;margin-top:8px;font-size:.7rem;font-weight:680;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-overview-ticket-meta{display:block;margin-top:7px;color:rgba(255,255,255,.33);font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .crm-overview-update-list{min-height:0;overflow-y:auto;display:grid;align-content:start;gap:1px;padding:1px 3px;scrollbar-width:thin}.crm-overview-update{position:relative;min-height:67px;padding:11px 34px 10px 20px;color:rgba(255,255,255,.67)}.crm-overview-update:before{content:"";position:absolute;left:7px;top:16px;width:4px;height:4px;border-radius:50%;background:rgba(135,181,242,.52);box-shadow:0 0 9px rgba(90,150,230,.22)}.crm-overview-update-title{font-size:.68rem;font-weight:650;line-height:1.32}.crm-overview-update-context{margin-top:6px;color:rgba(255,255,255,.31);font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-overview-update-time{position:absolute;right:4px;top:12px;color:rgba(255,255,255,.24);font-size:8px}
      .crm-overview-empty{height:100%;display:grid;place-items:center;padding:24px;text-align:center;color:rgba(255,255,255,.35);font-size:.7rem;line-height:1.45}
      @media(max-width:1080px){.crm-overview-frame{inset:56px 24px 82px}.crm-overview-worlds{grid-template-columns:235px minmax(400px,1fr) 225px;gap:10px}}
    `;
    document.head.appendChild(style);
  }

  const miniWorld = (project) => `<span class="crm-overview-mini-world" aria-hidden="true">${project.buckets.slice(0, 4).map((bucket) => `<span class="crm-overview-mini-lane">${bucket.cards.slice(0, 4).map(() => '<i class="crm-overview-mini-card"></i>').join("")}</span>`).join("")}</span>`;
  const projectMap = (project) => `<div class="crm-overview-map">${project.buckets.slice(0, 5).map((bucket) => `<div class="crm-overview-map-lane"><span class="crm-overview-map-title">${esc(bucket.title)}</span><div class="crm-overview-map-cards">${bucket.cards.slice(0, 4).map(() => '<i class="crm-overview-map-card"></i>').join("")}</div></div>`).join("")}</div>`;

  async function safeList(source) { try { return rows(await source()); } catch { return []; } }
  async function load() {
    const [tickets, activities] = await Promise.all([
      safeList(() => window.crmStore.list("tickets", { includeDeleted: false })),
      safeList(() => window.crmDomain.list("activities", { includeDeleted: false, limit: 80 })),
    ]);
    const projects = window.crmPlanner?.projects?.() || [];
    const selected = window.crmPlanner?.selected?.();
    const project = projects.find((item) => item.id === selected) || projects[0] || null;
    const projectUpdates = projects.flatMap(projectCards).map((card) => ({
      id: `planner:${card.id}`, title: card.title, context: `${card.projectTitle} · ${card.bucket}`,
      updatedAt: card.updatedAt, projectId: card.projectId, source: "planner",
    }));
    const activityUpdates = activities.map((activity) => ({
      id: `activity:${activity.id}`, title: updateTitle(activity),
      context: first(activity?.entityLabel, activity?.actorName, activity?.type, "CRM activity"),
      updatedAt: activity.occurredAt || activity.updatedAt || activity.createdAt, source: "activity",
    }));
    return {
      projects, project, tickets: tickets.filter((ticket) => !ticket.deletedAt).sort((a, b) => timeValue(b) - timeValue(a)).slice(0, 8),
      updates: [...projectUpdates, ...activityUpdates].sort((a, b) => timeValue(b) - timeValue(a)).slice(0, 12),
    };
  }

  const openProject = (projectId) => {
    window.crmPlanner?.selectProject?.(projectId);
    window.crmDeskTransit?.driveTo?.("planner");
  };
  const openTicket = (ticket, source) => {
    if (ticket?.id) window.ticketStacks?.open?.(ticket, source);
  };
  function render() {
    if (!root || !model) return;
    const project = model.project || model.projects[0] || null;
    const projectItems = projectCards(project).slice(0, 4);
    const supportingTickets = model.tickets.length ? model.tickets.slice(0, 4) : projectItems.map((card) => ({
      id: "", title: card.title, companyLabel: `${card.bucket} · ${project?.title || "Project"}`, state: "Project item",
    }));
    root.innerHTML = `<div class="crm-overview-frame">
      <header class="crm-overview-head"><div><div class="crm-overview-title">Overview</div><div class="crm-overview-brief">Projects, tickets, and movement — held in one quiet map.</div></div></header>
      <div class="crm-overview-worlds">
        <section class="crm-overview-pocket crm-menu-surface" data-overview-pocket="projects"><header class="crm-overview-pocket-head"><span class="crm-overview-pocket-title">Projects</span><span class="crm-overview-pocket-hint">open a universe</span></header><div class="crm-overview-project-list">${model.projects.length ? model.projects.map((item) => `<button type="button" class="crm-overview-project${item.id === project?.id ? " is-selected" : ""}" data-overview-project="${esc(item.id)}"><span class="crm-overview-project-copy"><span class="crm-overview-project-name">${esc(item.title)}</span><span class="crm-overview-project-state">${item.buckets.length} paths</span></span>${miniWorld(item)}</button>`).join("") : '<div class="crm-overview-empty">Your Planner projects will collect here.</div>'}</div></section>
        <section class="crm-overview-pocket crm-menu-surface" data-overview-pocket="focus"><header class="crm-overview-pocket-head"><span class="crm-overview-pocket-title">In focus</span><span class="crm-overview-pocket-hint">supporting examples</span></header><div class="crm-overview-focus-body">${project ? `<article class="crm-overview-featured"><div class="crm-overview-featured-head"><div><div class="crm-overview-featured-title">${esc(project.title)}</div><div class="crm-overview-featured-note">${esc(project.note || "A custom project plan")}</div></div><button type="button" class="crm-overview-featured-open crm-menu-action" data-overview-project="${esc(project.id)}">Open</button></div>${projectMap(project)}</article>` : '<div class="crm-overview-empty">Create a project in Planner to shape this space.</div>'}<div class="crm-overview-tickets">${supportingTickets.map((ticket) => `<button type="button" class="crm-overview-ticket" data-overview-ticket="${esc(ticket.id || "")}"><span class="crm-overview-ticket-label">${ticket.id ? "Ticket" : "Project item"}</span><span class="crm-overview-ticket-title">${esc(ticketTitle(ticket))}</span><span class="crm-overview-ticket-meta">${esc(ticketMeta(ticket))}</span></button>`).join("")}</div></div></section>
        <section class="crm-overview-pocket crm-menu-surface" data-overview-pocket="updates"><header class="crm-overview-pocket-head"><span class="crm-overview-pocket-title">Updates</span><span class="crm-overview-pocket-hint">recent movement</span></header><div class="crm-overview-update-list">${model.updates.length ? model.updates.map((update) => `<div class="crm-overview-update crm-menu-item"><div class="crm-overview-update-title">${esc(update.title)}</div><div class="crm-overview-update-context">${esc(update.context)}</div><time class="crm-overview-update-time">${esc(relativeTime(update.updatedAt))}</time></div>`).join("") : '<div class="crm-overview-empty">Updates will appear as work moves.</div>'}</div></section>
      </div>
    </div>`;
    root.querySelectorAll("[data-overview-project]").forEach((element) => element.addEventListener("click", () => openProject(element.dataset.overviewProject)));
    root.querySelectorAll("[data-overview-ticket]").forEach((element) => element.addEventListener("click", () => {
      const ticket = model.tickets.find((item) => String(item.id) === element.dataset.overviewTicket); if (ticket) openTicket(ticket, element);
    }));
  }

  async function refresh() { model = await load(); render(); dirty = false; return model; }
  const schedule = () => { dirty = true; clearTimeout(timer); timer = setTimeout(() => { if (active) refresh(); }, 90); };
  async function miniature() {
    if (!root) mount(); await refresh(); const copy = root.cloneNode(true); copy.hidden = false; copy.removeAttribute("data-crm-theater");
    Object.assign(copy.style, { position: "absolute", left: "50%", top: "50%", width: "1280px", height: "860px", transform: "translate(-50%,-50%) scale(.285)", transformOrigin: "center", pointerEvents: "none" });
    return copy;
  }
  function mount() {
    if (root) return root; ensureStyles(); root = document.createElement("main"); root.className = "crm-overview-surface"; root.dataset.crmTheater = "desk"; root.hidden = true; document.body.appendChild(root);
    try { window.crmStore?.onChanged?.(schedule); } catch {} try { window.crmDomain?.onChanged?.(schedule); } catch {} try { window.crmPlanner?.onChanged?.(schedule); } catch {}
    document.addEventListener("crm:planner-change", schedule); return root;
  }
  const setActive = (on) => { active = !!on; mount(); root.hidden = !active; if (active && dirty) refresh(); return api; };
  const baseline = async (options = {}) => { if (!root) mount(); if (!model || dirty) { model = await load(); if (typeof options.canRender === "function" && !options.canRender()) return root; render(); dirty = false; } root.hidden = !active; return root; };
  const api = { setActive, refresh, miniature, baseline, isActive: () => active };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true }); else mount();
  window.crmDesk = api;
})();
