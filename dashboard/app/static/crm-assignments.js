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
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
  const MAX_OVERSCROLL = 92;
  const damp = (value, minimum) => {
    if (value > 0) return MAX_OVERSCROLL * Math.tanh(value / MAX_OVERSCROLL);
    if (value < minimum) return minimum - MAX_OVERSCROLL * Math.tanh((minimum - value) / MAX_OVERSCROLL);
    return value;
  };
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
  let assignmentDetail = null;
  let detailSaveTimer = 0;
  let detailSaveTail = Promise.resolve();
  const pendingDetailFields = new Map();
  let dragItemId = "";
  let currentUser = "";
  let selectedFilter = localStorage.getItem(FILTER_KEY) || "all";
  let expandedStages = (() => { try { const value = JSON.parse(localStorage.getItem(EXPANDED_KEY) || "[]"); return new Set(Array.isArray(value) ? value.map(String) : []); } catch { return new Set(); } })();
  let model = { commitments:[], flows:[], contacts:[], companies:[], tasks:[], tickets:[], workItems:[] };
  const boardScroll = { x:0, target:0, raf:0, wheeling:false, releaseTimer:0 };
  let boardResizeObserver = null;
  let boardAutoRaf = 0;
  let boardAutoVelocity = 0;

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
      .crm-assignments-surface{--assignment-card-width:185px;--assignment-card-height:279px;--assignment-card-peek:42px;--assignment-card-small:.8;--assignment-bucket-width:268px;--assignment-bucket-small:.76;--crm-rail-inset:clamp(22px,2.2vw,30px);position:fixed;inset:0;z-index:836;color:#fff;overflow:hidden}.crm-assignments-surface[hidden]{display:none}
      .crm-assignments-frame{position:absolute;inset:var(--crm-canvas-top,78px) var(--crm-canvas-x,64px) var(--crm-canvas-bottom,78px);display:grid;grid-template-rows:40px minmax(0,1fr);gap:12px;min-width:0;min-height:0}
      .crm-assignment-tabs{min-width:0;height:40px;display:flex;align-items:center;gap:10px;-webkit-app-region:no-drag}.crm-assignment-title{flex:0 0 auto;font-size:var(--crm-type-room,17px);font-weight:700;letter-spacing:-.01em}.crm-assignment-filters{min-width:0;display:flex;align-items:center;gap:2px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}.crm-assignment-filters::-webkit-scrollbar{display:none}.crm-assignment-filter.crm-menu-action{position:relative;flex:0 0 auto;width:auto;height:32px;padding:0 11px!important;text-align:center;color:rgba(255,255,255,.5)!important}.crm-assignment-filter.is-selected{color:rgba(255,255,255,.96)!important}.crm-assignment-filter.is-selected:after{content:"";position:absolute;left:10px;right:10px;bottom:1px;height:2px;border-radius:2px;background:rgba(175,211,255,.78);box-shadow:0 0 10px rgba(115,177,252,.22)}
      .crm-assignment-tab-status{flex:0 0 auto;margin-left:auto;color:rgba(255,255,255,.38);font-size:var(--crm-type-meta,10px);white-space:nowrap}.crm-assignment-new.crm-menu-action{flex:0 0 29px;width:29px;height:29px;padding:0!important;font-size:17px!important}
      .crm-assignment-board{--crm-scroll-shadow-left:0;--crm-scroll-shadow-right:0;position:relative;min-width:0;min-height:0;height:100%;margin-inline:calc(0px - var(--crm-canvas-x,64px));overflow:hidden;-webkit-app-region:no-drag}.crm-assignment-board:before,.crm-assignment-board:after{content:"";position:absolute;z-index:4;top:0;bottom:20px;width:clamp(34px,4.5vw,68px);pointer-events:none;transition:opacity .12s linear}.crm-assignment-board:before{left:0;opacity:var(--crm-scroll-shadow-left);background:linear-gradient(90deg,rgba(1,9,14,.46) 0,rgba(1,9,14,.14) 40%,rgba(1,9,14,0) 100%)}.crm-assignment-board:after{right:0;opacity:var(--crm-scroll-shadow-right);background:linear-gradient(270deg,rgba(1,9,14,.46) 0,rgba(1,9,14,.14) 40%,rgba(1,9,14,0) 100%)}.crm-assignment-board-clip{position:absolute;inset:0 0 20px;overflow:hidden;outline:0}.crm-assignment-board-clip:focus-visible{box-shadow:inset 0 -1px rgba(190,220,255,.22)}
      .crm-assignment-pipeline{position:relative;width:max-content;min-width:100%;height:100%;min-height:0;display:flex;align-items:flex-start;justify-content:space-between;gap:var(--crm-object-gap,18px);padding:0 var(--crm-rail-inset);box-sizing:border-box;will-change:transform}
      .crm-assignment-bucket{position:relative;flex:0 0 var(--assignment-bucket-width);width:var(--assignment-bucket-width);height:100%;min-height:0;box-sizing:border-box;overflow:visible;transition:width .18s cubic-bezier(.22,1,.26,1),flex-basis .18s cubic-bezier(.22,1,.26,1),height .18s cubic-bezier(.22,1,.26,1)}.crm-assignment-bucket-shell.tk-zone{position:absolute;inset:0;z-index:auto;width:100%;height:100%;box-sizing:border-box;padding:12px 13px 13px;overflow:hidden;transform:scale(1);transform-origin:top left;transition:transform .18s cubic-bezier(.22,1,.26,1)}
      .crm-assignment-bucket .tk-zone-hd{flex:0 0 30px;padding-right:42px}.crm-assignment-bucket .tk-zone-hd-r{right:0;top:1px;opacity:.72;pointer-events:auto}.crm-assignment-stack-toggle.crm-menu-action{width:28px;height:27px;padding:0!important;display:grid;place-items:center}.crm-assignment-stack-toggle svg{width:13px;height:13px}.crm-assignment-stack-toggle path{fill:none;stroke:currentColor;stroke-width:1.35;stroke-linecap:round;stroke-linejoin:round}.crm-assignment-stack-toggle[aria-expanded="true"]{color:rgba(193,220,255,.96)!important;background:rgba(124,175,241,.1)!important}
      .crm-assignment-bucket.is-drop-target .crm-assignment-bucket-shell{border-color:rgba(137,188,255,.72)!important;box-shadow:inset 0 1px rgba(255,255,255,.24),0 0 34px rgba(71,139,231,.24)!important}
      .crm-assignment-card-list{min-height:0;flex:1 1 auto;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;align-items:center;gap:0;padding:4px 1px 10px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.5) transparent}.crm-assignment-card-list.is-expanded{gap:8px}
      .crm-assignment-work-card{appearance:none;position:relative;flex:0 0 auto;width:var(--assignment-card-width);height:var(--assignment-card-height);box-sizing:border-box;padding:0;text-align:left;border:0;border-radius:15px;color:#fff;background:transparent;cursor:grab;overflow:visible;transition:width .18s cubic-bezier(.22,1,.26,1),height .18s cubic-bezier(.22,1,.26,1),margin .2s cubic-bezier(.22,1,.26,1),opacity .14s ease}.crm-assignments-surface.is-seating .crm-assignment-work-card{transition:none!important}.crm-assignment-work-card+.crm-assignment-work-card{margin-top:-237px}.crm-assignment-work-card.crm-object-small+.crm-assignment-work-card{margin-top:-189.6px}.crm-assignment-card-list.is-expanded .crm-assignment-work-card+.crm-assignment-work-card{margin-top:0}.crm-assignment-work-card:focus-visible{outline:0}.crm-assignment-work-card.is-dragging{opacity:.3}.crm-assignment-work-card:active{cursor:grabbing}
      .crm-assignment-card-face{position:absolute;left:0;top:0;width:var(--assignment-card-width);height:var(--assignment-card-height);box-sizing:border-box;padding:14px 15px;border-radius:15px;display:flex;flex-direction:column;overflow:hidden;transform:scale(1);transform-origin:top left;background-color:rgb(107,114,128);background-image:linear-gradient(180deg,rgba(14,165,233,.42),rgba(14,165,233,.2));box-shadow:inset 0 1px rgba(255,255,255,.22),0 14px 18px -14px rgba(0,0,0,.55);transition:transform .18s cubic-bezier(.22,1,.26,1),box-shadow .14s ease}.crm-assignment-work-card[data-priority="high"] .crm-assignment-card-face{background-image:linear-gradient(180deg,rgba(202,138,4,.45),rgba(202,138,4,.22))}.crm-assignment-work-card[data-priority="urgent"] .crm-assignment-card-face{background-image:linear-gradient(180deg,rgba(220,38,38,.46),rgba(190,24,93,.2))}.crm-assignment-work-card:hover .crm-assignment-card-face,.crm-assignment-work-card:focus-visible .crm-assignment-card-face{box-shadow:inset 0 0 0 9999px rgba(255,255,255,.1),inset 0 1px rgba(255,255,255,.32),0 14px 18px -14px rgba(0,0,0,.55)}
      .crm-assignment-card-progress{position:absolute;right:13px;top:14px;display:flex;gap:3px}.crm-assignment-card-progress i{display:block;width:8px;height:3px;border-radius:4px;background:rgba(255,255,255,.18)}.crm-assignment-card-progress i.is-past{background:rgba(94,231,157,.8)}.crm-assignment-card-title{display:block;max-width:132px;font-size:var(--crm-type-object,14px);font-weight:800;line-height:1.22;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-assignment-card-note{display:-webkit-box;margin-top:9px;color:rgba(255,255,255,.67);font-size:var(--crm-type-body,12px);line-height:1.38;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}.crm-assignment-card-details{display:grid;gap:7px;margin-top:auto;padding-top:13px}.crm-assignment-card-meta{display:grid;grid-template-columns:48px minmax(0,1fr);gap:6px;color:rgba(255,255,255,.75);font-size:var(--crm-type-meta,10px);line-height:1.25}.crm-assignment-card-meta b{color:rgba(255,255,255,.4);font-weight:700}.crm-assignment-card-meta span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .crm-assignment-empty{height:100%;display:grid;place-items:center;padding:15px;text-align:center;color:rgba(255,255,255,.28);font-size:var(--crm-type-caption,11px)}
      .crm-assignment-bucket.crm-object-small{scale:1!important;flex-basis:203.68px;width:203.68px;height:76%}.crm-assignment-bucket.crm-object-small .crm-assignment-bucket-shell{width:268px;height:131.578947%;transform:scale(.76)}.crm-assignment-work-card.crm-object-small{scale:1!important;width:148px;height:223.2px;border-radius:12px}.crm-assignment-work-card.crm-object-small .crm-assignment-card-face{transform:scale(.8)}
      .crm-assignment-hsb{position:absolute;z-index:3;left:var(--crm-rail-inset);right:var(--crm-rail-inset);bottom:4px;height:8px;border-radius:999px;background:rgba(255,255,255,.16);box-shadow:inset 0 0 0 1px rgba(255,255,255,.06);opacity:0;transition:opacity .2s ease;pointer-events:none;-webkit-app-region:no-drag}.crm-assignment-hsb.is-on{opacity:1;pointer-events:auto}.crm-assignment-hth{position:absolute;top:0;height:8px;border-radius:999px;background:rgba(255,255,255,.66);box-shadow:0 1px 4px rgba(0,0,0,.4);cursor:grab;touch-action:none;transition:background .15s ease;-webkit-app-region:no-drag}.crm-assignment-hth:hover{background:rgba(255,255,255,.88)}.crm-assignment-hth:active{cursor:grabbing;background:#fff}
      body[data-crm-module="assignments"] .crm-home-control-deadzone{pointer-events:none}
      .crm-assignment-menu{position:fixed;z-index:9320;width:178px;padding:6px;display:grid;gap:1px}.crm-assignment-menu .crm-menu-action{height:33px;text-align:left}
      .crm-assignment-editor{position:fixed;z-index:9330;width:min(380px,calc(100vw - 28px));padding:10px;display:grid;gap:8px}.crm-assignment-editor-title{padding:2px 3px 5px;font-size:var(--crm-type-control,13px);font-weight:700}.crm-assignment-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:7px}.crm-assignment-fields>.crm-wide,.crm-assignment-fields>textarea{grid-column:1/-1}.crm-assignment-fields textarea{min-height:64px;resize:vertical;padding-top:9px}.crm-assignment-editor-actions{display:flex;justify-content:flex-end;gap:2px}.crm-assignment-editor .crm-menu-action{height:32px;font-size:var(--crm-type-body,12px)!important}
      @media(max-width:900px){.crm-assignment-tab-status{display:none}.crm-assignment-tabs{gap:6px}.crm-assignment-filter.crm-menu-action{padding-inline:8px!important}}
      @media(prefers-reduced-motion:reduce){.crm-assignment-work-card,.crm-assignment-card-face,.crm-assignment-bucket{transition-duration:.01ms!important}}
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

  const contextLabel = (item) => { const link = linkOf(item); if (!link) return "Independent work"; const entity = ({ workItems:"Pipeline", tickets:"Ticket", tasks:"Task", contacts:"Person", companies:"Company" })[link.entityType] || "Work"; return `${entity} · ${recordName(targetRecord(link) || { id:link.recordId })}`; };
  function cardHTML(item) {
    const currentStage = stageOf(item); const stageIndex = Math.max(0, STAGES.findIndex((stage) => stage.id === currentStage));
    const progress = STAGES.map((stage, index) => `<i class="${index <= stageIndex ? "is-past" : ""}" title="${esc(stage.title)}"></i>`).join("");
    return `<button type="button" class="crm-assignment-work-card" draggable="true" data-assignment-card="${esc(item.id)}" data-card-detail-card data-record-entity="commitments" data-record-id="${esc(item.id)}" data-crm-size-key="${esc(`card:commitments:${item.id}`)}" data-priority="${esc(String(item.priority || "normal").toLowerCase())}" aria-label="${esc(first(item.title, "Untitled assignment"))}"><span class="crm-assignment-card-face ticket-body"><span class="crm-assignment-card-progress" aria-hidden="true">${progress}</span><span class="crm-assignment-card-title">${esc(first(item.title, "Untitled assignment"))}</span>${first(item.context, item.note, item.description) ? `<span class="crm-assignment-card-note">${esc(first(item.context, item.note, item.description))}</span>` : ""}<span class="crm-assignment-card-details"><span class="crm-assignment-card-meta"><b>Owner</b><span>${esc(first(item.assignee, "Unassigned"))}</span></span><span class="crm-assignment-card-meta"><b>For</b><span>${esc(contextLabel(item))}</span></span><span class="crm-assignment-card-meta"><b>Priority</b><span>${esc(first(item.priority, "Normal"))}</span></span></span></span></button>`;
  }

  const boardElements = () => ({
    clip:root?.querySelector(".crm-assignment-board-clip"),
    track:root?.querySelector(".crm-assignment-pipeline"),
    bar:root?.querySelector(".crm-assignment-hsb"),
    thumb:root?.querySelector(".crm-assignment-hth"),
  });
  const boardMinimum = () => {
    const { clip, track } = boardElements();
    return Math.min(0, (clip?.clientWidth || 0) - (track?.scrollWidth || track?.offsetWidth || 0));
  };
  function positionBoard() {
    const { clip, track, bar, thumb } = boardElements(); if (!clip || !track || !bar || !thumb) return;
    track.style.transform = `translateX(${Math.round(boardScroll.x)}px)`;
    const view = clip.clientWidth; const content = track.scrollWidth || track.offsetWidth; const minimum = Math.min(0, view - content); const overflowing = content > view + 1;
    const board = clip.closest(".crm-assignment-board"); const fadeDistance = Math.min(72, Math.max(42, view * .06));
    board?.style.setProperty("--crm-scroll-shadow-left", String(overflowing ? clamp(-boardScroll.x / fadeDistance, 0, 1) : 0));
    board?.style.setProperty("--crm-scroll-shadow-right", String(overflowing ? clamp((boardScroll.x - minimum) / fadeDistance, 0, 1) : 0));
    bar.classList.toggle("is-on", overflowing); bar.setAttribute("aria-hidden", String(!overflowing));
    if (!overflowing) { boardScroll.x = 0; boardScroll.target = 0; track.style.transform = "translateX(0px)"; return; }
    const trackWidth = Math.max(1, bar.clientWidth); const base = Math.max(28, trackWidth * (view / content)); let width = base; let left = 0;
    if (boardScroll.x > 0) { width = Math.max(14, base - boardScroll.x); left = 0; }
    else if (boardScroll.x < minimum) { width = Math.max(14, base - (minimum - boardScroll.x)); left = trackWidth - width; }
    else left = (minimum ? boardScroll.x / minimum : 0) * (trackWidth - width);
    thumb.style.width = `${Math.round(width)}px`; thumb.style.left = `${Math.round(left)}px`;
  }
  function runBoardScroll() {
    if (boardScroll.raf) return;
    const tick = () => {
      const minimum = boardMinimum(); const goal = boardScroll.wheeling ? boardScroll.target : clamp(boardScroll.target, minimum, 0);
      boardScroll.x += (goal - boardScroll.x) * .22;
      if (!boardScroll.wheeling && Math.abs(goal - boardScroll.x) < .4) { boardScroll.x = goal; boardScroll.target = goal; positionBoard(); boardScroll.raf = 0; return; }
      positionBoard(); boardScroll.raf = requestAnimationFrame(tick);
    };
    boardScroll.raf = requestAnimationFrame(tick);
  }
  function scrollBoardBy(delta, immediate = false) {
    const minimum = boardMinimum(); if (minimum >= 0) return false;
    if (immediate) { boardScroll.x = boardScroll.target = clamp(boardScroll.x - delta, minimum, 0); positionBoard(); return true; }
    if (!boardScroll.raf) boardScroll.target = boardScroll.x;
    boardScroll.target = damp(boardScroll.target - delta, minimum); boardScroll.wheeling = true;
    clearTimeout(boardScroll.releaseTimer); boardScroll.releaseTimer = setTimeout(() => { boardScroll.wheeling = false; runBoardScroll(); }, 90); runBoardScroll(); return true;
  }
  function revealStage(stageId) {
    const { clip, bar } = boardElements(); const bucket = root?.querySelector(`[data-assignment-stage="${String(stageId || "").replace(/["\\\]]/g, "\\$&")}"]`); if (!clip || !bucket) return false;
    const view = clip.getBoundingClientRect(); const bounds = bucket.getBoundingClientRect(); const barBounds = bar?.getBoundingClientRect(); const inset = barBounds ? Math.max(0, barBounds.left - view.left) : 24; let shift = 0;
    if (bounds.left < view.left + inset) shift = (view.left + inset) - bounds.left;
    else if (bounds.right > view.right - inset) shift = (view.right - inset) - bounds.right;
    if (!shift) return true; boardScroll.target = clamp(boardScroll.x + shift, boardMinimum(), 0); boardScroll.wheeling = false; runBoardScroll(); return true;
  }
  function stopBoardAutoScroll() { boardAutoVelocity = 0; if (boardAutoRaf) { cancelAnimationFrame(boardAutoRaf); boardAutoRaf = 0; } }
  function updateBoardAutoScroll(clientX) {
    const { clip } = boardElements(); const minimum = boardMinimum(); if (!clip || minimum >= 0) return stopBoardAutoScroll();
    const bounds = clip.getBoundingClientRect(); const edge = 74; boardAutoVelocity = 0;
    if (clientX < bounds.left + edge && boardScroll.x < 0) boardAutoVelocity = clamp((bounds.left + edge - clientX) / edge, 0, 1) * 13;
    else if (clientX > bounds.right - edge && boardScroll.x > minimum) boardAutoVelocity = -clamp((clientX - (bounds.right - edge)) / edge, 0, 1) * 13;
    if (!boardAutoVelocity) return stopBoardAutoScroll();
    if (!boardAutoRaf) {
      const tick = () => { boardAutoRaf = 0; if (!boardAutoVelocity || !dragItemId) return; const next = clamp(boardScroll.x + boardAutoVelocity, boardMinimum(), 0); boardScroll.x = boardScroll.target = next; positionBoard(); boardAutoRaf = requestAnimationFrame(tick); };
      boardAutoRaf = requestAnimationFrame(tick);
    }
  }
  function wireBoardScroller() {
    const { clip, bar, thumb } = boardElements(); if (!clip || !bar || !thumb) return;
    clip.addEventListener("wheel", (event) => { const raw = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY; if (!raw) return; const pixels = event.deltaMode === 1 ? raw * 16 : event.deltaMode === 2 ? raw * clip.clientWidth : raw; if (scrollBoardBy(pixels)) event.preventDefault(); }, { passive:false });
    clip.addEventListener("keydown", (event) => { const amount = event.key === "ArrowLeft" ? -72 : event.key === "ArrowRight" ? 72 : event.key === "PageUp" ? -clip.clientWidth * .82 : event.key === "PageDown" ? clip.clientWidth * .82 : 0; if (!amount) return; event.preventDefault(); scrollBoardBy(amount); });
    let dragging = false; let startX = 0; let startScroll = 0; let pointerId = null;
    const move = (event) => { if (!dragging) return; const minimum = boardMinimum(); const view = clip.clientWidth; const content = view - minimum; const trackWidth = bar.clientWidth; const thumbWidth = Math.max(28, trackWidth * (view / content)); const fraction = (event.clientX - startX) / Math.max(1, trackWidth - thumbWidth); boardScroll.x = damp(startScroll + fraction * minimum, minimum); boardScroll.target = boardScroll.x; positionBoard(); };
    const up = () => { if (!dragging) return; dragging = false; try { if (pointerId != null && thumb.hasPointerCapture?.(pointerId)) thumb.releasePointerCapture(pointerId); } catch {} pointerId = null; window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); boardScroll.wheeling = false; boardScroll.target = boardScroll.x; runBoardScroll(); };
    thumb.addEventListener("pointerdown", (event) => { event.stopPropagation(); dragging = true; pointerId = event.pointerId; try { thumb.setPointerCapture?.(pointerId); } catch {} startX = event.clientX; startScroll = boardScroll.x; cancelAnimationFrame(boardScroll.raf); boardScroll.raf = 0; clearTimeout(boardScroll.releaseTimer); boardScroll.wheeling = false; window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up); });
    boardResizeObserver?.disconnect(); boardResizeObserver = new ResizeObserver(() => { boardScroll.x = boardScroll.target = clamp(boardScroll.x, boardMinimum(), 0); positionBoard(); }); boardResizeObserver.observe(clip); boardResizeObserver.observe(root.querySelector(".crm-assignment-pipeline"));
    requestAnimationFrame(() => { boardScroll.x = boardScroll.target = clamp(boardScroll.x, boardMinimum(), 0); positionBoard(); });
  }

  function render() {
    if (!root) return;
    root.classList.add("is-seating");
    if (!FILTERS.some((filter) => filter.id === selectedFilter)) selectedFilter = "all";
    const visible = filteredItems(); const openCount = model.commitments.filter((item) => !closed(item)).length; const unassignedCount = model.commitments.filter((item) => stageOf(item) === "unassigned").length;
    root.innerHTML = `<div class="crm-assignments-frame"><header class="crm-assignment-tabs"><span class="crm-assignment-title">Assignments</span><nav class="crm-assignment-filters" role="tablist" aria-label="Assignment filters">${FILTERS.map((filter) => `<button type="button" role="tab" class="crm-assignment-filter crm-menu-action${filter.id === selectedFilter ? " is-selected" : ""}" data-assignment-filter="${filter.id}" aria-selected="${filter.id === selectedFilter}" aria-pressed="${filter.id === selectedFilter}">${esc(filter.label)}</button>`).join("")}</nav><span class="crm-assignment-tab-status">${openCount} open · ${unassignedCount} unassigned</span><button type="button" class="crm-assignment-new crm-menu-action" data-assignment-action="new" aria-label="Create assignment">+</button></header><section class="crm-assignment-board" aria-label="Assignment pipeline"><div class="crm-assignment-board-clip" tabindex="0" aria-label="Scrollable assignment buckets"><div class="crm-assignment-pipeline">${STAGES.map((stage) => {
      const items = sorted(visible.filter((item) => stageOf(item) === stage.id)); const expanded = expandedStages.has(expansionKey(stage.id));
       return `<section class="crm-assignment-bucket${expanded ? " is-stack-expanded" : ""}" data-assignment-stage="${stage.id}" data-stage="${stage.id}" data-crm-size-key="bucket:assignments:${stage.id}"><div class="crm-assignment-bucket-shell tk-zone${expanded ? " is-stack-expanded" : ""}" data-assignment-stage="${stage.id}" data-stage="${stage.id}" data-card-detail-zone data-crm-size-key="bucket:assignments:${stage.id}"><header class="tk-zone-hd"><span class="tk-zone-title" title="${esc(stage.title)}">${esc(stage.title)}</span><span class="tk-zone-hd-r"><button type="button" class="crm-assignment-stack-toggle crm-menu-action" data-assignment-action="toggle-stack" aria-label="${expanded ? "Collapse" : "Expand"} ${esc(stage.title)} stack" aria-expanded="${expanded}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M3 11.5h10M8 2v5M6.2 3.8 8 2l1.8 1.8M8 14v-5m-1.8 3.2L8 14l1.8-1.8"/></svg></button></span></header><div class="crm-assignment-card-list${expanded ? " is-expanded" : ""}" data-card-detail-track data-card-detail-clip>${items.length ? items.map(cardHTML).join("") : '<div class="crm-assignment-empty">No work here</div>'}</div></div></section>`;
    }).join("")}</div></div><div class="crm-assignment-hsb" aria-hidden="true"><div class="crm-assignment-hth"></div></div></section></div>`;
    window.crmObjectSizing?.scan?.(root);
    wireBoardScroller();
    requestAnimationFrame(() => requestAnimationFrame(() => root?.classList.remove("is-seating")));
  }

  async function refresh(force = false) {
    if (!force && refreshPromise) return refreshPromise;
    const run = refreshTail.catch(() => null).then(async () => { model = await load(); dirty = false; render(); return model; });
    refreshTail = run; refreshPromise = run; run.finally(() => { if (refreshPromise === run) refreshPromise = null; }).catch(() => {}); return run;
  }
  const schedule = () => { dirty = true; clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (active && !assignmentDetail?.isOpen?.()) refresh(); }, 100); };

  async function syncFlow(item, stageId, rank = 0) {
    const flow = flowFor(item); const fields = { workflowKey:"assignments", entityType:"commitments", recordId:item.id, stage:stageId, rank, owner:item.assignee || null };
    if (flow) {
      let result = await window.crmDomain.update("workflow-entries", flow.id, fields, flow.version);
      if (!result?.ok) { await refresh(true); const fresh = flowFor(itemById(item.id)); if (fresh) result = await window.crmDomain.update("workflow-entries", fresh.id, fields, fresh.version); }
      return result?.record || null;
    }
    return (await window.crmDomain.create("workflow-entries", fields))?.record || null;
  }
  async function updateCommitment(itemId, fields, stageId = null, options = {}) {
    let item = itemById(itemId); if (!item) return false;
    let result = await window.crmDomain.update("commitments", item.id, fields, item.version);
    if (!result?.ok) { await refresh(true); item = itemById(itemId); if (!item) return false; result = await window.crmDomain.update("commitments", item.id, fields, item.version); }
    if (!result?.record) return false;
    const nextStage = stageId || stageOf(result.record); const rank = model.commitments.filter((candidate) => candidate.id !== itemId && stageOf(candidate) === nextStage).length;
    await syncFlow({ ...item, ...result.record }, nextStage, rank);
    if (options.deferRefresh) { const index = model.commitments.findIndex((candidate) => candidate.id === itemId); if (index >= 0) model.commitments[index] = result.record; return true; }
    await refresh(true); return true;
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

  const assignmentTargetPairs = () => [["", "No linked record"], ...model.tasks.map((record) => [`tasks:${record.id}`, `Task · ${recordName(record)}`]), ...model.contacts.map((record) => [`contacts:${record.id}`, `Person · ${recordName(record)}`]), ...model.tickets.map((record) => [`tickets:${record.id}`, `Ticket · ${recordName(record)}`]), ...model.workItems.map((record) => [`workItems:${record.id}`, `Pipeline · ${recordName(record)}`])];
  function targetOptions(item) {
    const records = assignmentTargetPairs();
    const link = linkOf(item); const selected = link ? `${link.entityType}:${link.recordId}` : "";
    return records.map(([value, label]) => `<option value="${esc(value)}"${selected === value ? " selected" : ""}>${esc(label)}</option>`).join("");
  }
  const dateInputValue = (value) => {
    const raw = String(value || ""); if (!raw) return ""; if (!raw.includes("T")) return raw.slice(0, 10);
    const date = new Date(raw); if (!Number.isFinite(date.getTime())) return ""; const pad = (part) => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };
  const assignmentDetailValue = (itemId, key) => {
    const item = itemById(itemId); if (!item) return "";
    if (key === "stage") return stageOf(item);
    if (key === "dueAt") return dateInputValue(item.dueAt);
    if (key === "assignedTarget") {
      if (item.assignedContactId) return String(item.assignedContactId);
      return first(item.assignee).toLowerCase() === currentUser.toLowerCase() ? "__me" : "";
    }
    if (key === "linkedTarget") { const link = linkOf(item); return link ? `${link.entityType}:${link.recordId}` : ""; }
    return item[key] ?? "";
  };
  const assignmentDetailFields = () => [
    { key:"title", label:"Assignment", q:"What needs to happen?" },
    { key:"context", label:"Definition of done", q:"What does done look like?", area:true, req:false },
    { key:"stage", label:"Stage", options:() => STAGES.map((stage) => [stage.id, stage.title]), req:false },
    { key:"dueAt", label:"Due", date:true, req:false },
    { key:"assignedTarget", label:"Owner", options:() => [["", "Unassigned"], ["__me", `Me · ${currentUser}`], ...model.contacts.map((contact) => [contact.id, contactName(contact)])], req:false },
    { key:"linkedTarget", label:"Linked to", options:assignmentTargetPairs, req:false },
    { key:"priority", label:"Priority", prio:true, req:false },
  ];
  const patchAssignmentCard = (item) => {
    if (!item) return;
    document.querySelectorAll(`[data-assignment-card="${String(item.id).replace(/["\\\]]/g, "\\$&")}"]`).forEach((card) => {
      const holder = document.createElement("div"); holder.innerHTML = cardHTML(item); const next = holder.firstElementChild;
      if (next) card.innerHTML = next.innerHTML;
      card.dataset.priority = String(item.priority || "normal").toLowerCase(); card.setAttribute("aria-label", first(item.title, "Untitled assignment"));
    });
  };
  function queueAssignmentDetailFields(itemId, fields = {}) {
    const item = itemById(itemId); if (!item) return false; const persist = {};
    if (Object.prototype.hasOwnProperty.call(fields, "title")) { const title = String(fields.title || "").trim(); if (title) item.title = persist.title = title; }
    if (Object.prototype.hasOwnProperty.call(fields, "context")) item.context = persist.context = String(fields.context || "");
    if (Object.prototype.hasOwnProperty.call(fields, "dueAt")) { const value = String(fields.dueAt || ""); item.dueAt = persist.dueAt = value ? new Date(`${value}T17:00:00`).toISOString() : null; }
    if (Object.prototype.hasOwnProperty.call(fields, "priority")) item.priority = persist.priority = String(fields.priority || "normal");
    if (Object.prototype.hasOwnProperty.call(fields, "stage")) {
      const stage = stageById(fields.stage) || STAGES[0]; item.assignmentStage = persist.assignmentStage = stage.id;
      item.status = persist.status = stage.id === "done" ? "completed" : "open"; item.completedAt = persist.completedAt = stage.id === "done" ? first(item.completedAt, nowIso()) : null;
      if (stage.id === "unassigned") { const cleared = { assignee:null, assignedContactId:null, assignedContactName:null, assignedAt:null }; Object.assign(item, cleared); Object.assign(persist, cleared); }
    }
    if (Object.prototype.hasOwnProperty.call(fields, "assignedTarget")) {
      const value = String(fields.assignedTarget || ""); const contact = model.contacts.find((candidate) => String(candidate.id) === value); const assignee = contact ? contactName(contact) : value === "__me" ? currentUser : null;
      const ownership = { assignedContactId:contact?.id || null, assignedContactName:contact ? contactName(contact) : null, assignee, assignedAt:assignee ? first(item.assignedAt, nowIso()) : null }; Object.assign(item, ownership); Object.assign(persist, ownership);
      const nextStage = assignee && stageOf(item) === "unassigned" ? "assigned" : !assignee ? "unassigned" : stageOf(item); item.assignmentStage = persist.assignmentStage = nextStage;
    }
    if (Object.prototype.hasOwnProperty.call(fields, "linkedTarget")) {
      const raw = String(fields.linkedTarget || ""); const [entityType, ...parts] = raw.split(":"); const recordId = parts.join(":"); const links = (item.links || []).filter((link) => link.entityType === "workItems" && link.relation === "regarding");
      if (raw) links.push({ entityType, recordId, relation:"assignment-context" }); item.links = persist.links = links;
    }
    patchAssignmentCard(item); pendingDetailFields.set(item.id, { ...(pendingDetailFields.get(item.id) || {}), ...persist });
    clearTimeout(detailSaveTimer); detailSaveTimer = setTimeout(flushAssignmentDetailFields, 180); return true;
  }
  function flushAssignmentDetailFields() {
    clearTimeout(detailSaveTimer); detailSaveTimer = 0; const batch = [...pendingDetailFields.entries()]; pendingDetailFields.clear(); if (!batch.length) return detailSaveTail;
    detailSaveTail = detailSaveTail.catch(() => null).then(async () => { for (const [itemId, fields] of batch) await updateCommitment(itemId, fields, fields.assignmentStage || stageOf(itemById(itemId)), { deferRefresh:true }); });
    return detailSaveTail;
  }
  const assignmentDetailSource = { list:async () => ({ records:clone(model.commitments) }), onChanged:(callback) => window.crmDomain?.onChanged?.(callback) };
  const assignmentDetailStacks = {
    stageFields:(itemId) => ({ key:stageOf(itemById(itemId)), label:stageById(stageOf(itemById(itemId)))?.title || "Assignment", fields:assignmentDetailFields() }),
    fieldValue:assignmentDetailValue, setMeta:queueAssignmentDetailFields, setPriority:(itemId, priority) => queueAssignmentDetailFields(itemId, { priority }),
    onDetailClosed:() => {
      const needsRefresh = pendingDetailFields.size > 0 || dirty;
      const flushed = flushAssignmentDetailFields();
      if (needsRefresh) flushed.finally(() => refresh(true));
    },
  };
  function ensureAssignmentDetail() {
    if (assignmentDetail) return assignmentDetail; if (typeof window.createCrmCardDetail !== "function") return null;
    assignmentDetail = window.createCrmCardDetail({ apiName:"assignmentDetail", source:assignmentDetailSource, stacks:assignmentDetailStacks, panelWidth:380,
      priorities:["normal","high","urgent"], intensityValues:["normal","high","urgent"], defaultIntensity:"normal",
      severityRgb:{ normal:"14,165,233", high:"202,138,4", urgent:"220,38,38", none:"107,114,128" }, notFoundText:"Assignment not found.", draftRequiredText:"An assignment title is required." });
    return assignmentDetail;
  }
  const openAssignmentDetail = (item, anchor) => { if (!item || !anchor) return false; closeFloating(); ensureAssignmentDetail()?.open(item, anchor); return true; };
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
      { label:"Edit", run:() => openAssignmentDetail(item, anchor) },
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
  function selectFilter(filterId, focus = false) {
    const next = FILTERS.find((filter) => filter.id === String(filterId)); if (!next) return false;
    selectedFilter = next.id; if (!window.crmHomePreviews?.isCaptureWorker) localStorage.setItem(FILTER_KEY, selectedFilter); render();
    if (focus) requestAnimationFrame(() => root?.querySelector(`.crm-assignment-filter[data-assignment-filter="${next.id}"]`)?.focus({ preventScroll:true }));
    return true;
  }
  function wire() {
    root.addEventListener("click", (event) => {
      const filter = event.target.closest("[data-assignment-filter]"); if (filter) { selectFilter(filter.dataset.assignmentFilter); return; }
      const action = event.target.closest("[data-assignment-action]"); const stageElement = action?.closest("[data-assignment-stage]");
      if (action?.dataset.assignmentAction === "new") { openEditor(null, action); return; }
      if (action?.dataset.assignmentAction === "toggle-stack" && stageElement) { setStageExpanded(stageElement.dataset.assignmentStage); return; }
      const card = event.target.closest("[data-assignment-card]"); if (card) openAssignmentDetail(itemById(card.dataset.assignmentCard), card);
    });
    root.addEventListener("keydown", (event) => {
      const current = event.target.closest(".crm-assignment-filter"); if (!current || !["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
      const tabs = [...root.querySelectorAll(".crm-assignment-filter")]; const index = tabs.indexOf(current); if (index < 0) return; event.preventDefault();
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      selectFilter(tabs[nextIndex]?.dataset.assignmentFilter, true);
    });
    root.addEventListener("contextmenu", (event) => { const card = event.target.closest("[data-assignment-card]"); if (!card) return; event.preventDefault(); event.stopPropagation(); const item = itemById(card.dataset.assignmentCard); if (item) openMenu(item, card, event.clientX, event.clientY); });
    root.addEventListener("dragstart", (event) => { const card = event.target.closest("[data-assignment-card]"); if (!card) return; dragItemId = card.dataset.assignmentCard; card.classList.add("is-dragging"); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", dragItemId); });
    root.addEventListener("dragend", (event) => { event.target.closest("[data-assignment-card]")?.classList.remove("is-dragging"); root.querySelectorAll(".is-drop-target").forEach((node) => node.classList.remove("is-drop-target")); dragItemId = ""; stopBoardAutoScroll(); });
    root.addEventListener("dragover", (event) => { if (dragItemId) updateBoardAutoScroll(event.clientX); const bucket = event.target.closest("[data-assignment-stage]"); if (!bucket || !dragItemId) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; root.querySelectorAll(".crm-assignment-bucket").forEach((node) => node.classList.toggle("is-drop-target", node === bucket)); });
    root.addEventListener("dragleave", (event) => { const bucket = event.target.closest("[data-assignment-stage]"); if (bucket && !bucket.contains(event.relatedTarget)) bucket.classList.remove("is-drop-target"); });
    root.addEventListener("drop", async (event) => { const bucket = event.target.closest("[data-assignment-stage]"); if (!bucket || !dragItemId) return; event.preventDefault(); const id = dragItemId; dragItemId = ""; stopBoardAutoScroll(); await move(id, bucket.dataset.assignmentStage); });
  }

  function mount() {
    if (root) return root; ensureStyles(); root = document.createElement("main"); root.className = "crm-assignments-surface"; root.dataset.crmTheater = "assignments"; root.hidden = true; document.body.appendChild(root); wire();
    try { window.crmDomain?.onChanged?.(schedule); } catch {} try { window.crmStore?.onChanged?.(schedule); } catch {} refresh(); return root;
  }
  const setActive = (on) => { active = !!on; mount(); root.hidden = !active; if (active && dirty) refresh(); else if (active) requestAnimationFrame(() => { boardScroll.x = boardScroll.target = clamp(boardScroll.x, boardMinimum(), 0); positionBoard(); }); if (!active) { closeFloating(); stopBoardAutoScroll(); } return api; };
  const baseline = async () => { mount(); if (dirty || !model.commitments.length) await refresh(); render(); root.hidden = !active; return root; };
  const homePreviewState = () => ({
    selectedFilter,
    expandedStages:[...expandedStages],
    scrollX:clamp(boardScroll.x, boardMinimum(), 0),
  });
  const applyHomePreviewState = async (state = {}) => {
    mount();
    if (dirty || !model.commitments.length) await refresh();
    const filter = FILTERS.find((item) => item.id === String(state.selectedFilter || ""));
    if (filter) selectedFilter = filter.id;
    if (Array.isArray(state.expandedStages)) {
      expandedStages = new Set(state.expandedStages.map(String).filter((stage) => !!stageById(stage)));
    }
    render();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const x = Number(state.scrollX);
    boardScroll.x = boardScroll.target = clamp(Number.isFinite(x) ? x : 0, boardMinimum(), 0);
    boardScroll.wheeling = false;
    positionBoard();
    return homePreviewState();
  };
  async function miniature() { await baseline(); const copy = root.cloneNode(true); copy.hidden = false; copy.removeAttribute("data-crm-theater"); Object.assign(copy.style, { position:"absolute", left:"50%", top:"50%", width:"1320px", height:"860px", transform:"translate(-50%,-50%) scale(.285)", transformOrigin:"center", pointerEvents:"none" }); return copy; }
  const open = async (id, anchor) => { if (dirty || !itemById(id)) await refresh(); const item = itemById(id); if (!item) return false; revealStage(stageOf(item)); requestAnimationFrame(() => openAssignmentDetail(item, anchor || root?.querySelector(`[data-assignment-card="${String(item.id).replace(/["\\\]]/g, "\\$&")}"]`))); return true; };
  const api = { setActive, baseline, miniature, refresh, move, assign, unassign, create:() => openEditor(), open, items:() => clone(model.commitments), stages:() => clone(STAGES), selectFilter, setStageExpanded, expandedStages:() => [...expandedStages], scrollBy:scrollBoardBy, scrollToStage:revealStage, scrollState:() => ({ x:boardScroll.x, target:boardScroll.target, min:boardMinimum() }), homePreviewState, applyHomePreviewState, isActive:() => active };
  document.addEventListener("crm:theater-switch", closeFloating);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once:true }); else mount();
  window.crmAssignments = api;
})();
