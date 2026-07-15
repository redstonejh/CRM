// crm-desk.js — a restrained index of real projects, tickets, and recent work.
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
  const updateTitle = (activity) => first(activity?.title, activity?.summary, activity?.description, activity?.content, activity?.type, activity?.kind, "Update");
  const timeValue = (item) => Date.parse(item?.updatedAt || item?.occurredAt || item?.createdAt || "") || 0;
  const relativeTime = (value) => {
    const milliseconds = Date.now() - (Date.parse(value || "") || Date.now());
    const minutes = Math.max(0, Math.floor(milliseconds / 60000));
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  };
  const projectCards = (project) => (project?.buckets || []).flatMap((bucket) => (bucket.cards || []).map((card) => ({
    ...card, bucket: bucket.title, projectId: project.id, projectTitle: project.title,
  })));

  function ensureStyles() {
    if (document.getElementById("crm-overview-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-overview-styles";
    style.textContent = `
      .crm-overview-surface{position:fixed;inset:0;z-index:835;color:#fff;pointer-events:auto;overflow:hidden}.crm-overview-surface[hidden]{display:none}
      .crm-overview-frame{position:absolute;inset:var(--crm-canvas-top,78px) var(--crm-canvas-x,64px) var(--crm-canvas-bottom,78px);max-width:1380px;margin:auto;display:grid;grid-template-rows:30px auto minmax(0,1fr);row-gap:14px;min-height:0}
      .crm-overview-head{display:flex;align-items:center;padding:0 3px}.crm-overview-title{font-size:.95rem;font-weight:700}
      .crm-overview-project-shelf{min-width:0;min-height:0;display:grid;grid-template-rows:26px 148px}
      .crm-overview-section-head{display:flex;align-items:center;gap:12px;padding:0 3px}.crm-overview-section-title{font-size:.72rem;font-weight:680;color:rgba(255,255,255,.82);text-shadow:0 1px 8px rgba(0,0,0,.72)}
      .crm-overview-project-list{min-width:0;min-height:0;display:flex;align-items:flex-start;gap:12px;overflow-x:auto;overflow-y:hidden;padding:2px 2px 10px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.17) transparent}
      .crm-overview-project-shelf.is-empty{grid-template-columns:auto minmax(0,1fr);grid-template-rows:30px;align-items:center;column-gap:10px}
      .crm-overview-project-shelf.is-empty .crm-overview-project-list{display:block;overflow:hidden;padding:0}
      .crm-overview-project-shelf.is-empty .crm-overview-empty{min-height:0;height:30px;display:flex;align-items:center;justify-content:flex-start;padding:0 2px}
      .crm-overview-project{appearance:none;position:relative;flex:0 0 238px;height:142px;box-sizing:border-box;overflow:hidden;padding:0;text-align:left;border:1px solid rgba(255,255,255,.14);border-radius:14px;background:linear-gradient(155deg,rgba(21,31,43,.78),rgba(11,18,27,.72));-webkit-backdrop-filter:blur(16px) saturate(125%);backdrop-filter:blur(16px) saturate(125%);color:rgba(255,255,255,.82);box-shadow:inset 0 1px rgba(255,255,255,.12),0 14px 26px -20px rgba(0,0,0,.9);cursor:pointer;transition:border-color .14s ease,box-shadow .14s ease}
      .crm-overview-project:hover,.crm-overview-project:focus-visible{outline:0;border-color:rgba(173,205,246,.28);box-shadow:inset 0 1px rgba(255,255,255,.15),0 16px 28px -20px rgba(0,0,0,.9)}
      .crm-overview-project-name{position:absolute;z-index:2;left:13px;right:13px;bottom:12px;font-size:.72rem;font-weight:680;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .crm-overview-mini-world{position:absolute;inset:12px 12px 38px;display:flex;gap:6px;padding:7px;border-radius:9px;background:rgba(255,255,255,.018);overflow:hidden}
      .crm-overview-mini-lane{min-width:0;flex:1;display:flex;flex-direction:column;gap:4px;padding:5px;border-radius:6px;background:rgba(255,255,255,.022)}.crm-overview-mini-lane:before{content:"";height:2px;border-radius:3px;background:rgba(195,218,248,.24)}
      .crm-overview-mini-card{display:block;height:10px;border-radius:4px;background:linear-gradient(90deg,rgba(117,165,230,.19),rgba(255,255,255,.025));border:1px solid rgba(255,255,255,.025)}.crm-overview-mini-card:nth-child(3n){width:72%}
      .crm-overview-lower{min-width:0;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,310px);gap:clamp(34px,3.3vw,44px);height:min(410px,100%);align-self:center;padding:0 3px;overflow:hidden}
      .crm-overview-ticket-section,.crm-overview-recent{min-width:0;min-height:0;display:grid;grid-template-rows:30px minmax(0,1fr)}
      .crm-overview-tickets{min-width:0;min-height:0;display:flex;align-items:flex-start;gap:20px;overflow-x:auto;overflow-y:hidden;padding:6px 2px 16px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.17) transparent}
      .crm-overview-ticket.tk-card{position:relative!important;left:auto!important;right:auto!important;top:auto!important;bottom:auto!important;flex:0 0 165px!important;width:165px!important;height:249px!important;margin:0!important;transform:none!important;cursor:pointer}
      .crm-overview-update-list{position:relative;min-height:0;overflow-y:auto;display:grid;align-content:start;gap:2px;padding:4px 0 12px 16px;border-left:1px solid rgba(255,255,255,.1);scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.17) transparent;text-shadow:0 1px 8px rgba(0,0,0,.9)}
      .crm-overview-update{position:relative;min-height:54px;padding:9px 38px 9px 10px;color:rgba(255,255,255,.78)}.crm-overview-update:before{content:"";position:absolute;left:-19px;top:16px;width:4px;height:4px;border-radius:50%;background:rgba(143,183,236,.62)}
      .crm-overview-update-title{font-size:.71rem;font-weight:650;line-height:1.38}.crm-overview-update-context{margin-top:5px;color:rgba(255,255,255,.45);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-overview-update-time{position:absolute;right:2px;top:9px;color:rgba(255,255,255,.38);font-size:9px}
      .crm-overview-empty{min-height:80px;display:grid;place-items:center;color:rgba(255,255,255,.28);font-size:.66rem}
      @media(max-width:1080px){.crm-overview-lower{grid-template-columns:minmax(0,1fr) 250px;gap:24px}.crm-overview-project{flex-basis:224px}.crm-overview-tickets{gap:12px}}
    `;
    document.head.appendChild(style);
  }

  const miniWorld = (project) => `<span class="crm-overview-mini-world" aria-hidden="true">${(project.buckets || []).slice(0, 4).map((bucket) => `<span class="crm-overview-mini-lane">${(bucket.cards || []).slice(0, 4).map(() => '<i class="crm-overview-mini-card"></i>').join("")}</span>`).join("")}</span>`;
  async function safeList(source) { try { return rows(await source()); } catch { return []; } }
  async function load() {
    const [tickets, activities] = await Promise.all([
      safeList(() => window.crmStore.list("tickets", { includeDeleted: false })),
      safeList(() => window.crmDomain.list("activities", { includeDeleted: false, limit: 60 })),
    ]);
    const projects = window.crmPlanner?.projects?.() || [];
    const projectUpdates = projects.flatMap(projectCards).map((card) => ({
      id: `planner:${card.id}`, title: card.title, context: `${card.projectTitle} · ${card.bucket}`,
      updatedAt: card.updatedAt, source: "planner",
    }));
    const activityUpdates = activities.map((activity) => ({
      id: `activity:${activity.id}`, title: updateTitle(activity),
      context: first(activity?.entityLabel, activity?.actorName, activity?.type, activity?.kind),
      updatedAt: activity.occurredAt || activity.updatedAt || activity.createdAt, source: "activity",
    }));
    return {
      projects,
      tickets: tickets.filter((ticket) => !ticket.deletedAt).sort((a, b) => timeValue(b) - timeValue(a)).slice(0, 4),
      updates: [...projectUpdates, ...activityUpdates].sort((a, b) => timeValue(b) - timeValue(a)).slice(0, 8),
    };
  }

  const openProject = (projectId) => {
    window.crmPlanner?.selectProject?.(projectId);
    window.crmDeskTransit?.driveTo?.("planner");
  };
  const openTicket = (ticket, source) => { if (ticket?.id) window.ticketStacks?.open?.(ticket, source); };

  function render() {
    if (!root || !model) return;
    root.innerHTML = `<div class="crm-overview-frame">
      <header class="crm-overview-head"><div class="crm-overview-title">Overview</div></header>
      <section class="crm-overview-project-shelf${model.projects.length ? "" : " is-empty"}"><header class="crm-overview-section-head"><span class="crm-overview-section-title">Projects</span></header>
        <div class="crm-overview-project-list">${model.projects.length ? model.projects.map((project) => `<button type="button" class="crm-overview-project" data-overview-project="${esc(project.id)}"><span class="crm-overview-project-name">${esc(project.title)}</span>${miniWorld(project)}</button>`).join("") : '<div class="crm-overview-empty">No projects</div>'}</div></section>
      <section class="crm-overview-lower"><section class="crm-overview-ticket-section"><header class="crm-overview-section-head"><span class="crm-overview-section-title">Tickets</span></header><div class="crm-overview-tickets"></div></section>
        <section class="crm-overview-recent"><header class="crm-overview-section-head"><span class="crm-overview-section-title">Recent</span></header><div class="crm-overview-update-list">${model.updates.length ? model.updates.map((update) => `<div class="crm-overview-update"><div class="crm-overview-update-title">${esc(update.title)}</div>${update.context ? `<div class="crm-overview-update-context">${esc(update.context)}</div>` : ""}<time class="crm-overview-update-time">${esc(relativeTime(update.updatedAt))}</time></div>`).join("") : '<div class="crm-overview-empty">No recent activity</div>'}</div></section>
      </section></div>`;
    const ticketHost = root.querySelector(".crm-overview-tickets");
    model.tickets.forEach((ticket) => {
      const card = window.ticketStacks?.createCard?.(ticket, { onOpen: (_record, source) => openTicket(ticket, source) });
      if (!card) return;
      card.classList.add("crm-overview-ticket");
      card.dataset.overviewTicket = ticket.id;
      ticketHost.appendChild(card);
    });
    if (!ticketHost.children.length) ticketHost.innerHTML = '<div class="crm-overview-empty">No tickets</div>';
    root.querySelectorAll("[data-overview-project]").forEach((element) => element.addEventListener("click", () => openProject(element.dataset.overviewProject)));
    window.crmInterfaceParity?.scan?.(root);
  }

  async function refresh() { model = await load(); render(); dirty = false; return model; }
  const schedule = () => { dirty = true; clearTimeout(timer); timer = setTimeout(() => { if (active) refresh(); }, 90); };
  async function miniature() {
    if (!root) mount();
    await refresh();
    const copy = root.cloneNode(true); copy.hidden = false; copy.removeAttribute("data-crm-theater");
    Object.assign(copy.style, { position: "absolute", left: "50%", top: "50%", width: "1280px", height: "860px", transform: "translate(-50%,-50%) scale(.285)", transformOrigin: "center", pointerEvents: "none" });
    return copy;
  }
  function mount() {
    if (root) return root;
    ensureStyles();
    root = document.createElement("main"); root.className = "crm-overview-surface"; root.dataset.crmTheater = "desk"; root.hidden = true; document.body.appendChild(root);
    try { window.crmStore?.onChanged?.(schedule); } catch {}
    try { window.crmDomain?.onChanged?.(schedule); } catch {}
    try { window.crmPlanner?.onChanged?.(schedule); } catch {}
    document.addEventListener("crm:planner-change", schedule);
    return root;
  }
  const setActive = (on) => { active = !!on; mount(); root.hidden = !active; if (active && dirty) refresh(); return api; };
  const baseline = async (options = {}) => {
    if (!root) mount();
    if (!model || dirty) { model = await load(); if (typeof options.canRender === "function" && !options.canRender()) return root; render(); dirty = false; }
    root.hidden = !active; return root;
  };
  const api = { setActive, refresh, miniature, baseline, isActive: () => active };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true }); else mount();
  window.crmDesk = api;
})();
