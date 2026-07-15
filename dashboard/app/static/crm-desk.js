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
      .crm-overview-frame{position:absolute;inset:60px 58px 78px;max-width:1460px;margin:auto;display:grid;grid-template-rows:52px 224px minmax(0,1fr);gap:11px}
      .crm-overview-head{display:flex;align-items:center;justify-content:space-between;gap:20px;min-width:0;padding:0 8px}.crm-overview-title{font:720 1rem/1.05 system-ui;letter-spacing:-.012em}.crm-overview-brief{margin-top:6px;color:rgba(255,255,255,.35);font-size:9px}
      .crm-overview-context{display:flex;align-items:center;gap:10px;min-width:0;color:rgba(255,255,255,.33);font-size:9px}.crm-overview-context-project{max-width:180px;color:rgba(255,255,255,.66);font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-overview-open.crm-menu-action{height:30px;padding:0 6px!important;font-size:.67rem!important}
      .crm-overview-project-shelf{min-width:0;min-height:0;display:grid;grid-template-rows:28px minmax(0,1fr)}.crm-overview-section-head{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:0 8px}.crm-overview-section-title{font-size:.72rem;font-weight:700}.crm-overview-section-hint{color:rgba(255,255,255,.28);font-size:8px;letter-spacing:.04em}
      .crm-overview-project-list{min-width:0;min-height:0;display:flex;align-items:stretch;gap:16px;overflow-x:auto;overflow-y:hidden;padding:3px 7px 13px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.17) transparent;scroll-snap-type:x proximity}
      .crm-overview-project{appearance:none;position:relative;flex:0 0 304px;height:176px;box-sizing:border-box;display:grid;grid-template-rows:auto minmax(0,1fr);gap:10px;padding:13px;text-align:left;border:1px solid rgba(255,255,255,.15);border-radius:14px;background:linear-gradient(155deg,rgba(20,31,44,.9),rgba(10,18,27,.84));-webkit-backdrop-filter:blur(14px) saturate(125%);backdrop-filter:blur(14px) saturate(125%);color:rgba(255,255,255,.75);box-shadow:inset 0 1px rgba(255,255,255,.13),0 14px 28px -20px rgba(0,0,0,.88);cursor:pointer;scroll-snap-align:start;transition:color .14s ease,border-color .14s ease,translate .14s ease,box-shadow .14s ease}
      .crm-overview-project:hover,.crm-overview-project:focus-visible{outline:0;color:#fff;border-color:rgba(157,198,250,.25);translate:0 -1px}.crm-overview-project.is-selected{color:#fff;border-color:rgba(151,196,255,.34);box-shadow:inset 0 1px rgba(255,255,255,.14),0 0 0 1px rgba(92,151,228,.07),0 18px 34px -22px rgba(30,88,166,.72)}
      .crm-overview-project-copy{display:block;min-width:0;padding-right:18px}.crm-overview-project-name{display:block;font-size:.73rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-overview-project-state{display:block;margin-top:5px;color:rgba(255,255,255,.3);font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-overview-project.is-selected:after{content:"";position:absolute;right:12px;top:14px;width:5px;height:5px;border-radius:50%;background:rgba(152,199,255,.8);box-shadow:0 0 10px rgba(91,151,236,.58)}
      .crm-overview-mini-world{min-height:0;display:flex;gap:6px;padding:8px;border:1px solid rgba(255,255,255,.06);border-radius:9px;background:rgba(255,255,255,.018);overflow:hidden}.crm-overview-mini-lane{min-width:0;flex:1;display:flex;flex-direction:column;gap:4px;padding:5px;border-radius:6px;background:rgba(255,255,255,.015)}.crm-overview-mini-lane:before{content:"";height:2px;border-radius:3px;background:rgba(195,218,248,.26)}.crm-overview-mini-card{display:block;height:11px;border-radius:4px;background:linear-gradient(90deg,rgba(117,165,230,.2),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.025)}.crm-overview-mini-card:nth-child(3n){width:72%}
      .crm-overview-support-stage{min-width:0;min-height:0;display:grid;grid-template-columns:minmax(650px,1.55fr) minmax(270px,.55fr);gap:clamp(34px,4vw,64px);padding:12px 8px 0;overflow:hidden}
      .crm-overview-ticket-orbit,.crm-overview-movement{min-width:0;min-height:0;display:grid;grid-template-rows:34px minmax(0,1fr)}.crm-overview-support-copy{display:flex;align-items:baseline;gap:9px;min-width:0}.crm-overview-support-context{color:rgba(255,255,255,.32);font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-overview-movement{align-self:start;height:min(370px,calc(100vh - 520px));min-height:300px;box-sizing:border-box;padding:7px 8px 6px;border:1px solid rgba(255,255,255,.13);border-radius:14px;background:linear-gradient(165deg,rgba(18,28,40,.86),rgba(9,16,24,.8));-webkit-backdrop-filter:blur(16px) saturate(125%);backdrop-filter:blur(16px) saturate(125%);box-shadow:inset 0 1px rgba(255,255,255,.11),0 16px 30px -22px rgba(0,0,0,.88)}
      .crm-overview-tickets{min-width:0;min-height:0;display:grid;grid-template-columns:repeat(4,minmax(135px,1fr));align-content:start;gap:13px;padding-top:8px;overflow:hidden}.crm-overview-ticket{appearance:none;position:relative;min-width:0;height:136px;box-sizing:border-box;padding:13px;text-align:left;border:1px solid rgba(255,255,255,.13);border-radius:11px;background:linear-gradient(150deg,rgba(53,77,109,.9),rgba(24,36,52,.86));-webkit-backdrop-filter:blur(12px) saturate(120%);backdrop-filter:blur(12px) saturate(120%);color:rgba(255,255,255,.88);box-shadow:inset 0 1px rgba(255,255,255,.1),0 15px 26px -20px rgba(0,0,0,.92);cursor:pointer;transition:border-color .14s ease,translate .14s ease,box-shadow .14s ease}.crm-overview-ticket:nth-child(2n){margin-top:17px;background:linear-gradient(150deg,rgba(75,62,93,.9),rgba(37,29,48,.86))}.crm-overview-ticket:nth-child(3n){background:linear-gradient(150deg,rgba(82,71,42,.9),rgba(43,36,20,.86))}.crm-overview-ticket:hover,.crm-overview-ticket:focus-visible{outline:0;border-color:rgba(166,201,245,.3);translate:0 -2px;box-shadow:inset 0 1px rgba(255,255,255,.12),0 20px 30px -20px rgba(0,0,0,.94)}
      .crm-overview-ticket-label{display:flex;align-items:center;gap:6px;color:rgba(183,210,246,.5);font-size:8px;text-transform:uppercase;letter-spacing:.08em}.crm-overview-ticket-label:before{content:"";width:4px;height:4px;border-radius:50%;background:currentColor}.crm-overview-ticket-bars{position:absolute;right:11px;top:14px;display:flex;gap:2px}.crm-overview-ticket-bars i{display:block;width:7px;height:2px;border-radius:2px;background:rgba(129,211,154,.55)}
      .crm-overview-ticket-title{display:block;margin-top:14px;font-size:.72rem;font-weight:690;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-overview-ticket-meta{display:block;margin-top:9px;color:rgba(255,255,255,.34);font-size:8px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .crm-overview-update-list{position:relative;min-height:0;overflow-y:auto;display:grid;align-content:start;gap:1px;padding:6px 3px 12px 15px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.17) transparent}.crm-overview-update-list:before{content:"";position:absolute;left:5px;top:16px;bottom:16px;width:1px;background:linear-gradient(rgba(133,179,239,.26),transparent)}.crm-overview-update{position:relative;min-height:54px;padding:8px 36px 8px 11px;color:rgba(255,255,255,.7)}.crm-overview-update:before{content:"";position:absolute;left:-12px;top:13px;width:4px;height:4px;border-radius:50%;background:rgba(135,181,242,.64);box-shadow:0 0 9px rgba(90,150,230,.3)}.crm-overview-update-title{font-size:.66rem;font-weight:650;line-height:1.32}.crm-overview-update-context{margin-top:6px;color:rgba(255,255,255,.36);font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-overview-update-time{position:absolute;right:3px;top:8px;color:rgba(255,255,255,.28);font-size:8px}
      .crm-overview-empty{height:100%;display:grid;place-items:center;padding:24px;text-align:center;color:rgba(255,255,255,.32);font-size:.68rem;line-height:1.45}
      @media(max-width:1080px){.crm-overview-frame{inset:58px 24px 80px}.crm-overview-project{flex-basis:270px}.crm-overview-support-stage{grid-template-columns:minmax(560px,1.35fr) minmax(240px,.6fr);gap:24px}.crm-overview-tickets{gap:8px}.crm-overview-ticket{padding:11px}}
    `;
    document.head.appendChild(style);
  }

  const miniWorld = (project) => `<span class="crm-overview-mini-world" aria-hidden="true">${project.buckets.slice(0, 4).map((bucket) => `<span class="crm-overview-mini-lane">${bucket.cards.slice(0, 4).map(() => '<i class="crm-overview-mini-card"></i>').join("")}</span>`).join("")}</span>`;
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

  const selectProject = (projectId) => {
    window.crmPlanner?.selectProject?.(projectId);
  };
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
      <header class="crm-overview-head"><div><div class="crm-overview-title">Overview</div><div class="crm-overview-brief">A quiet view of the worlds already in motion.</div></div>${project ? `<div class="crm-overview-context"><span>Viewing</span><strong class="crm-overview-context-project">${esc(project.title)}</strong><button type="button" class="crm-overview-open crm-menu-action" data-overview-open="${esc(project.id)}">Open in Planner</button></div>` : ""}</header>
      <section class="crm-overview-project-shelf"><header class="crm-overview-section-head"><span class="crm-overview-section-title">Projects</span><span class="crm-overview-section-hint">scroll the pocket worlds</span></header><div class="crm-overview-project-list">${model.projects.length ? model.projects.map((item) => `<button type="button" class="crm-overview-project${item.id === project?.id ? " is-selected" : ""}" data-overview-project="${esc(item.id)}" aria-pressed="${item.id === project?.id}"><span class="crm-overview-project-copy"><span class="crm-overview-project-name">${esc(item.title)}</span><span class="crm-overview-project-state">${esc(item.note || "Custom project world")}</span></span>${miniWorld(item)}</button>`).join("") : '<div class="crm-overview-empty">Your Planner projects will collect here.</div>'}</div></section>
      <section class="crm-overview-support-stage">
        <section class="crm-overview-ticket-orbit"><header class="crm-overview-section-head"><span class="crm-overview-support-copy"><span class="crm-overview-section-title">Tickets nearby</span><span class="crm-overview-support-context">${esc(project?.title || "current work")}</span></span><span class="crm-overview-section-hint">supporting examples</span></header><div class="crm-overview-tickets">${supportingTickets.map((ticket) => `<button type="button" class="crm-overview-ticket" data-overview-ticket="${esc(ticket.id || "")}"><span class="crm-overview-ticket-label">${ticket.id ? "Ticket" : "Project item"}</span><span class="crm-overview-ticket-bars" aria-hidden="true"><i></i><i></i><i></i></span><span class="crm-overview-ticket-title">${esc(ticketTitle(ticket))}</span><span class="crm-overview-ticket-meta">${esc(ticketMeta(ticket))}</span></button>`).join("")}</div></section>
        <section class="crm-overview-movement"><header class="crm-overview-section-head"><span class="crm-overview-section-title">Movement</span><span class="crm-overview-section-hint">recent</span></header><div class="crm-overview-update-list">${model.updates.length ? model.updates.map((update) => `<div class="crm-overview-update"><div class="crm-overview-update-title">${esc(update.title)}</div><div class="crm-overview-update-context">${esc(update.context)}</div><time class="crm-overview-update-time">${esc(relativeTime(update.updatedAt))}</time></div>`).join("") : '<div class="crm-overview-empty">Updates will appear as work moves.</div>'}</div></section>
      </section>
    </div>`;
    root.querySelectorAll("[data-overview-project]").forEach((element) => element.addEventListener("click", () => selectProject(element.dataset.overviewProject)));
    root.querySelectorAll("[data-overview-open]").forEach((element) => element.addEventListener("click", () => openProject(element.dataset.overviewOpen)));
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
