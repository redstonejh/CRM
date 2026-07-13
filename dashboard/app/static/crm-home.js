// crm-home.js — six inert screenshot LODs hosted by the original camera.
(() => {
  if (typeof window.createFractalCamera !== "function") return;

  const MODULES = [
    { key: "desk", label: "Desk" }, { key: "people", label: "People" },
    { key: "cases", label: "Tickets" }, { key: "bills", label: "Bills" },
    { key: "invoices", label: "Invoices" }, { key: "calendar", label: "Calendar" },
  ];
  const RETRY_MS = [0, 120, 320, 700, 1400, 2800, 5000];
  const HOME_PREVIEW_VERSION = "financial-split-clean-v12";
  const DAY_MS = 86400000;
  const HAND_LIMIT = 7;
  const previews = new Map();
  let camera = null;
  let subscribed = false;
  let retryTimer = 0;
  let retryAttempt = 0;
  let priorityItems = [];
  let priorityUsername = "";
  let handRefreshTimer = 0;
  let handRefreshGeneration = 0;

  const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[char]));
  const firstText = (...values) => values.map((value) => String(value ?? "").trim()).find(Boolean) || "";
  const startOfToday = () => { const date = new Date(); date.setHours(0, 0, 0, 0); return date.getTime(); };
  const dueTime = (item) => { const value = Date.parse(item?.dueAt || ""); return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY; };
  const isDone = (item) => ["completed", "cancelled", "canceled"].includes(String(item?.status || "").toLowerCase());

  const ensureStyles = () => {
    if (document.getElementById("crm-home-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-home-styles";
    style.textContent = `
      .crm-home-surface{position:fixed;inset:0;z-index:820;pointer-events:none;overflow:hidden}
      .crm-home-surface[hidden]{display:none}.crm-home-level{position:absolute;inset:0;transform-origin:0 0}
      .crm-home-grid{position:absolute;display:grid;pointer-events:auto;
        grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:16px}
      .crm-home-bucket{position:relative;box-sizing:border-box;display:block;min-height:0;overflow:hidden;color:#fff;
        cursor:pointer;border:0;container-type:size;border-radius:var(--home-r,16px);padding:0;
        background:linear-gradient(180deg,rgba(22,26,36,.34),rgba(12,16,24,.28));
        -webkit-backdrop-filter:blur(28px) saturate(140%);backdrop-filter:blur(28px) saturate(140%);
        box-shadow:inset 0 0 0 1px rgba(255,255,255,.14),inset 0 1px 0 rgba(255,255,255,.18),0 18px 42px rgba(0,0,0,.28);
        transition:box-shadow .18s ease,background .18s ease}
      .crm-home-bucket:hover{background:linear-gradient(180deg,rgba(70,110,190,.34),rgba(40,70,130,.26));
        box-shadow:inset 0 0 0 1px rgba(125,180,255,.5),0 0 30px rgba(90,150,255,.42)}
      .crm-home-title-glass{position:absolute;z-index:4;left:50%;top:50%;transform:translate(-50%,-50%);width:max-content;
        max-width:80%;text-align:center;pointer-events:none;transition:opacity .18s ease}
      .crm-home-title{font:600 clamp(11px,3.2cqh,15px)/1.05 system-ui;letter-spacing:.14em;text-transform:uppercase;
        color:rgba(226,234,246,.72);text-shadow:0 1px 0 rgba(255,255,255,.19),0 -1px 0 rgba(0,0,0,.78),0 2px 8px rgba(0,0,0,.24)}
      .crm-home-bucket:hover .crm-home-title-glass{opacity:.28}
      .crm-home-preview{position:absolute;inset:0;z-index:1;overflow:hidden;contain:paint;border-radius:inherit;color:rgba(255,255,255,.62)}
      .crm-home-preview-state{position:absolute;inset:0;display:grid;place-items:center;font-size:.68rem;font-weight:760;
        letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.38)}
      .crm-home-preview-image{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:cover;pointer-events:none;
        user-select:none;transform:translateY(var(--far-shift-y,0%));transform-origin:center}
      /* Home owns six inert raster layers, so a small foreground-only filter is
         cheaper than blurring live room DOM or adding another backdrop pass. */
      .crm-home-preview-foreground{filter:blur(1.25px);transition:filter .18s ease}
      .crm-home-bucket:hover .crm-home-preview-foreground{filter:none}
      /* These are the card system's real .tk-card objects. Home contributes
         only the held-hand geometry and compositor-friendly reveal motion. */
      .crm-home-priority-hand{position:absolute;z-index:9;left:0;right:0;bottom:0;height:var(--home-hand-reserve,280px);
        overflow:visible;pointer-events:none;contain:layout style}
      .crm-home-priority-hand[hidden]{display:none}
      .crm-home-hand-trigger{position:absolute;z-index:1;left:50%;bottom:0;width:var(--home-hand-span,760px);height:92px;
        transform:translateX(-50%);pointer-events:auto}
      .crm-home-priority-hand>.crm-home-hand-card.tk-card{position:absolute;left:50%;right:auto;bottom:52px;z-index:var(--hand-z,10);
        pointer-events:auto;cursor:pointer;
        transform-origin:50% 108%;transform:translateX(calc(-50% + var(--hand-x,0px))) translateY(var(--hand-rest-y,180px)) rotate(var(--hand-rot,0deg));
        transition:transform .38s cubic-bezier(.22,1,.26,1),box-shadow .18s ease}
      .crm-home-priority-hand:is(:hover,:focus-within)>.crm-home-hand-card.tk-card{
        transform:translateX(calc(-50% + var(--hand-x,0px))) translateY(var(--hand-open-y,0px)) rotate(var(--hand-open-rot,var(--hand-rot,0deg))) scale(.9)}
      .crm-home-priority-hand:is(:hover,:focus-within)>.crm-home-hand-card.tk-card:is(:hover,:focus-visible){z-index:1000;
        transform:translateX(calc(-50% + var(--hand-x,0px))) translateY(calc(var(--hand-open-y,0px) - 6px)) rotate(var(--hand-open-rot,var(--hand-rot,0deg))) scale(.92);
        box-shadow:inset 0 0 0 9999px rgba(255,255,255,.12),inset 0 1px rgba(255,255,255,.34),0 22px 48px rgba(0,0,0,.44)}
      .crm-home-hand-empty{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);font-size:9px;letter-spacing:.1em;
        text-transform:uppercase;color:rgba(218,228,242,.25);white-space:nowrap}
      @media(prefers-reduced-motion:reduce){.crm-home-priority-hand>.crm-home-hand-card.tk-card{transition-duration:.01ms}}
      /* The transition lid is full-viewport. It must stay neutral in Electron's
         native app-region map or its temporary rectangle can cancel (and on
         Windows, outlive) the persistent title-bar drag strip. */
      .crm-home-expander{position:absolute;z-index:5;pointer-events:none;transform-origin:0 0;
        background:transparent!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;box-shadow:none!important}
      .crm-home-expander .crm-home-title-glass{display:none}.crm-home-expander .crm-home-preview{opacity:1}
      .crm-home-preview-exact{opacity:0;transform:none}
      .crm-home-expander .crm-home-preview-foreground{filter:none;transition:transform 460ms cubic-bezier(.22,1,.26,1),opacity 120ms ease 330ms}
      .crm-home-expander .crm-home-preview-exact{transition:opacity 120ms ease 330ms}
      .crm-home-expander.is-unwrapping .crm-home-preview-foreground{transform:none;opacity:0}
      .crm-home-expander.is-unwrapping .crm-home-preview-exact{opacity:1}
      .crm-home-warm,.crm-home-warm *{pointer-events:none!important}
    `;
    document.head.appendChild(style);
  };

  const bucketHTML = (module) => `
    <div class="crm-home-preview" data-preview-key="${esc(module.key)}" data-preview-state="waiting" aria-hidden="true">
      <span class="crm-home-preview-state">Preparing</span>
    </div>
    <div class="crm-home-title-glass"><div class="crm-home-title">${esc(module.label)}</div></div>`;

  const farShift = (preview) => {
    const bounds = preview?.foregroundBounds;
    if (!bounds || !preview.height) return 0;
    const contentCenter = bounds.y + bounds.height / 2;
    return Math.max(-6, Math.min(6, (preview.height / 2 - contentCenter) / preview.height * 100));
  };
  const imageNode = (className, src) => {
    const image = document.createElement("img");
    image.className = `crm-home-preview-image ${className}`;
    image.src = src; image.alt = ""; image.draggable = false; image.decoding = "async";
    return image;
  };
  const mountHost = (host, preview, exact = false) => {
    if (!host || !preview?.foregroundSrc) return false;
    host.style.setProperty("--far-shift-y", `${farShift(preview).toFixed(3)}%`);
    let foreground = host.querySelector(":scope > .crm-home-preview-foreground");
    if (!foreground) {
      foreground = imageNode("crm-home-preview-foreground", preview.foregroundSrc);
      host.replaceChildren(foreground);
    } else if (foreground.src !== preview.foregroundSrc) foreground.src = preview.foregroundSrc;
    if (exact) {
      let full = host.querySelector(":scope > .crm-home-preview-exact");
      if (!full) { full = imageNode("crm-home-preview-exact", preview.exactSrc); host.appendChild(full); }
      else if (full.src !== preview.exactSrc) full.src = preview.exactSrc;
    }
    host.dataset.previewState = "ready";
    host.dataset.previewVersion = preview.version;
    host.dataset.capturedAt = String(preview.capturedAt || 0);
    host.closest(".crm-home-bucket")?.setAttribute("data-preview-ready", "true");
    return true;
  };
  const mountPreview = (key) => {
    const host = camera?.layers?.()[0]?.querySelector(`.crm-home-bucket[data-module="${key}"] .crm-home-preview`);
    return mountHost(host, previews.get(key), false);
  };
  const mountAll = () => MODULES.forEach(({ key }) => mountPreview(key));
  const acceptPreview = (preview) => {
    if (preview?.version !== HOME_PREVIEW_VERSION || !preview?.foregroundSrc || !preview?.exactSrc || !MODULES.some(({ key }) => key === preview.key)) return false;
    previews.set(preview.key, preview);
    if (camera?.isActive?.() && camera.level() === 0) mountPreview(preview.key);
    return true;
  };
  const requestPreviews = async (reset = false) => {
    clearTimeout(retryTimer);
    if (window.crmHomePreviews?.isCaptureWorker) return;
    if (reset) retryAttempt = 0;
    try { (await window.crmHomePreviews?.list?.())?.previews?.forEach(acceptPreview); } catch {}
    if (previews.size === MODULES.length) return;
    retryTimer = setTimeout(() => requestPreviews(false), RETRY_MS[Math.min(retryAttempt++, RETRY_MS.length - 1)]);
  };
  const priorityWeight = (item) => ({ critical: 900, urgent: 800, high: 650, overdue: 620, medium: 180, normal: 0 }
    [String(item?.priority || "").toLowerCase()] || 0);
  const assignedTo = (item, username) => !!username && String(item?.assignee || "").trim().toLowerCase() === username;
  const priorityScore = (item, username) => {
    const due = dueTime(item); const today = startOfToday(); const days = Number.isFinite(due) ? (due - today) / DAY_MS : Number.POSITIVE_INFINITY;
    let score = priorityWeight(item);
    if (assignedTo(item, username)) score += 1100;
    if (days < 0) score += 1600 + Math.min(500, Math.abs(days) * 24);
    else if (days < 1) score += 1350;
    else if (days < 2) score += 980;
    else if (days < 4) score += 700;
    else if (days <= 14) score += 420 - days * 12;
    if (/reply|respond|follow|call|invoice|bill|payment/.test(`${item?.kind || ""} ${item?.title || ""}`.toLowerCase())) score += 160;
    if (firstText(item?.assignedBy, item?.assigner)) score += 90;
    return score;
  };
  const choosePriorityItems = (records, username = "") => {
    const userKey = String(username || "").trim().toLowerCase(); const horizon = startOfToday() + 15 * DAY_MS;
    return records.filter((item) => {
      if (!item || item.deletedAt || isDone(item)) return false;
      const assignee = String(item.assignee || "").trim().toLowerCase();
      if (userKey && assignee && assignee !== userKey) return false;
      const due = dueTime(item); const important = priorityWeight(item) >= 620;
      return assignedTo(item, userKey) || important || (Number.isFinite(due) && due < horizon);
    }).sort((a, b) => priorityScore(b, userKey) - priorityScore(a, userKey) || dueTime(a) - dueTime(b)).slice(0, HAND_LIMIT);
  };
  const signalKind = (reason) => ({
    "next-touch": "Needs response", "cold-front": "Relationship", "contact-touch": "Follow up",
    "invoice-overdue": "Invoice overdue", "invoice-due": "Bill due", task: "Task", calendar: "Calendar",
  }[reason] || "Priority");
  const signalPriority = (reason) => ({
    "invoice-overdue": "critical", "invoice-due": "high", "next-touch": "high", "cold-front": "high",
    "contact-touch": "high", task: "normal", calendar: "normal",
  }[reason] || "normal");
  const signalAttention = (reason) => ({
    "next-touch": "Response due", "cold-front": "Needs attention", "contact-touch": "Reach out today",
    "invoice-overdue": "Payment overdue", "invoice-due": "Payment due", task: "Due today", calendar: "Today",
  }[reason] || "Up next");
  const todaySignals = (summary) => (summary?.summary?.datasets?.todayHand || []).map((row) => {
    const entity = firstText(row.entity, row.type); const reason = String(row.reason || "").toLowerCase();
    return {
      id: `signal:${entity}:${row.id}`, title: firstText(row.title, row.name, row.companyLabel, "Important next action"),
      kind: signalKind(reason), status: "open", dueAt: firstText(row.dueAt, row.dueDate),
      assignee: firstText(row.assignee, row.owner), assignedBy: firstText(row.assignedBy), priority: signalPriority(reason),
      todayReason: reason, attentionLabel: signalAttention(reason), context: firstText(row.companyLabel, row.stageLabel, row.description),
      links: entity && row.id ? [{ entityType: entity, recordId: row.id, relation: "regarding" }] : [],
    };
  });
  const priorityLink = (item) => item?.sourceEntity && item?.sourceId
    ? { entityType: item.sourceEntity, recordId: item.sourceId, relation: "source" }
    : item?.links?.[0] || null;
  const mergePrioritySources = (commitments, signals) => {
    const merged = new Map();
    const keyOf = (item) => { const link = priorityLink(item); return link ? `${link.entityType}:${link.recordId}` : `commitment:${item.id}`; };
    commitments.forEach((item) => merged.set(keyOf(item), item));
    signals.forEach((item) => { const key = keyOf(item); if (!merged.has(key)) merged.set(key, item); });
    return [...merged.values()];
  };
  const dueLabel = (item) => {
    const due = dueTime(item); if (!Number.isFinite(due)) return firstText(item.attentionLabel, item.assignee ? "Assigned" : "Up next");
    const today = startOfToday(); const day = Math.floor((due - today) / DAY_MS);
    if (due < today) return `${Math.max(1, Math.ceil((today - due) / DAY_MS))}d overdue`;
    if (day === 0) return `Today · ${new Date(due).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    if (day === 1) return "Tomorrow";
    return new Date(due).toLocaleDateString([], { month: "short", day: "numeric" });
  };
  const contextLabel = (item, username = "") => {
    if (item.context) return item.context;
    const assignedBy = firstText(item.assignedBy, item.assigner);
    if (assignedBy) return `Assigned by ${assignedBy}`;
    if (assignedTo(item, String(username).toLowerCase())) return "Assigned to you";
    if (item.assignee) return `Assigned to ${item.assignee}`;
    const link = priorityLink(item);
    return link ? `${String(link.entityType || "CRM").replace(/s$/, "")} record` : "Important next action";
  };
  const cardReasonOf = (item) => {
    if (item.todayReason) return item.todayReason;
    const text = `${item.kind || ""} ${item.title || ""}`.toLowerCase();
    if (/invoice|bill|payment/.test(text)) return dueTime(item) < startOfToday() ? "invoice-overdue" : "invoice-due";
    if (/reply|respond/.test(text)) return "next-touch";
    if (/follow|reach out|call/.test(text)) return "contact-touch";
    return "task";
  };
  const cardPriorityOf = (item) => {
    const value = String(item.priority || "").toLowerCase();
    if (["critical", "urgent", "overdue"].includes(value)) return "critical";
    if (value === "high") return "high";
    if (["medium", "normal"].includes(value)) return "medium";
    return "none";
  };
  const cardRecordOf = (item, username = "") => {
    const link = priorityLink(item); const context = contextLabel(item, username); const reason = dueLabel(item);
    return {
      ...item,
      id: String(item.id || ""),
      title: firstText(item.title, "Important next action"),
      companyLabel: firstText(item.title, "Important next action"),
      host: context,
      description: context,
      priority: cardPriorityOf(item),
      targetEntity: link?.entityType || "",
      targetId: link?.recordId || "",
      todayReason: cardReasonOf(item),
      todayRow: { ...(item.todayRow || {}), dueDate: item.dueAt || "", stageLabel: firstText(item.attentionLabel, reason), assignee: item.assignee || "" },
    };
  };
  const openPriorityItem = (item, sourceCard) => {
    const link = priorityLink(item);
    if (link?.entityType && link?.recordId) window.crmRecordWorld?.open?.(link.entityType, link.recordId, sourceCard);
    else window.crmDeskTransit?.driveTo?.("desk") || window.crmWorkspaces?.setActive?.("desk");
  };
  const layoutPriorityHand = (hand = camera?.layers?.()[0]?.querySelector?.(".crm-home-priority-hand")) => {
    if (!hand) return; const cards = [...hand.querySelectorAll(".crm-home-hand-card.tk-card")];
    if (!cards.length) { hand.style.setProperty("--home-hand-span", "220px"); return; }
    const width = cards[0].offsetWidth || 185; const height = cards[0].offsetHeight || 279;
    const maxSpan = Math.min(innerWidth - 44, 760); const step = cards.length > 1 ? Math.min(width * .62, (maxSpan - width) / (cards.length - 1)) : 0;
    const middle = (cards.length - 1) / 2; const peek = 128; const baseBottom = 52; const openDrop = 33;
    cards.forEach((card, index) => {
      const distance = index - middle; const arc = Math.min(18, distance * distance * 2.35); const rotation = Math.max(-15, Math.min(15, distance * 4.2));
      card.style.setProperty("--hand-x", `${(distance * step).toFixed(2)}px`);
      card.style.setProperty("--hand-rot", `${rotation.toFixed(2)}deg`);
      card.style.setProperty("--hand-open-rot", `${(rotation * .72).toFixed(2)}deg`);
      card.style.setProperty("--hand-open-y", `${(openDrop + arc * .1).toFixed(2)}px`);
      card.style.setProperty("--hand-rest-y", `${(baseBottom + height - peek + arc).toFixed(2)}px`);
    });
    hand.style.setProperty("--home-hand-span", `${Math.min(innerWidth - 24, width + step * Math.max(0, cards.length - 1) + 64).toFixed(2)}px`);
  };
  const fillPriorityHand = (hand) => {
    if (!hand) return;
    hand.dataset.username = priorityUsername;
    hand.classList.toggle("is-empty", priorityItems.length === 0);
    hand.replaceChildren();
    if (!priorityItems.length) {
      const empty = document.createElement("div"); empty.className = "crm-home-hand-empty"; empty.textContent = "Nothing pressing"; hand.appendChild(empty); return;
    }
    const renderer = window.crmToday?.createCard;
    if (typeof renderer !== "function") {
      const empty = document.createElement("div"); empty.className = "crm-home-hand-empty"; empty.textContent = "Preparing priority cards"; hand.appendChild(empty); return;
    }
    const trigger = document.createElement("div"); trigger.className = "crm-home-hand-trigger"; trigger.setAttribute("aria-hidden", "true"); hand.appendChild(trigger);
    priorityItems.forEach((item, index) => {
      const link = priorityLink(item);
      const card = renderer(cardRecordOf(item, priorityUsername), {
        ariaLabel: `${firstText(item.title, "Important next action")}. ${dueLabel(item)}`,
        onOpen: (_record, sourceCard) => openPriorityItem(item, sourceCard),
      });
      card.classList.add("crm-home-hand-card");
      card.dataset.priorityId = String(item.id || "");
      if (link?.entityType) card.dataset.recordEntity = link.entityType;
      if (link?.recordId) card.dataset.recordId = link.recordId;
      if (["ticket", "tickets", "case", "cases"].includes(String(link?.entityType || "").toLowerCase())) {
        card.addEventListener("contextmenu", async (event) => {
          event.preventDefault(); event.stopPropagation();
          await window.ticketStacks?.contextMenu?.(link.recordId, card, event.clientX, event.clientY);
        });
      }
      card.style.setProperty("--hand-z", String(20 + index));
      hand.appendChild(card);
    });
  };
  const renderPriorityHand = () => {
    const hand = camera?.layers?.()[0]?.querySelector?.(".crm-home-priority-hand"); if (!hand) return;
    fillPriorityHand(hand);
    requestAnimationFrame(() => { layoutPriorityHand(hand); camera?.layout?.(); });
  };
  const refreshPriorityHand = async () => {
    if (window.crmHomePreviews?.isCaptureWorker || !camera?.isActive?.() || !window.crmDomain?.list) return;
    const generation = ++handRefreshGeneration;
    try {
      const [result, summary, session] = await Promise.all([
        window.crmDomain.list("commitments", { includeDeleted: false, limit: 300 }),
        window.crmReportsApi?.summary?.().catch?.(() => null) || null,
        window.auth?.session?.().catch?.(() => null) || null,
      ]);
      if (generation !== handRefreshGeneration) return;
      priorityUsername = session?.user?.username || "";
      priorityItems = choosePriorityItems(mergePrioritySources(result?.records || [], todaySignals(summary)), priorityUsername);
      renderPriorityHand();
    } catch {}
  };
  const scheduleHandRefresh = () => { clearTimeout(handRefreshTimer); handRefreshTimer = setTimeout(refreshPriorityHand, 120); };
  const subscribe = () => {
    if (subscribed || window.crmHomePreviews?.isCaptureWorker) return;
    subscribed = true;
    try { window.crmHomePreviews?.onChanged?.(acceptPreview); } catch {}
    try { window.crmDomain?.onChanged?.(scheduleHandRefresh); } catch {}
    try { window.auth?.onChanged?.(scheduleHandRefresh); } catch {}
    requestPreviews(true);
    refreshPriorityHand();
  };

  const buildRoot = () => {
    const root = document.createElement("div"); root.className = "crm-home-level";
    const grid = document.createElement("div"); grid.className = "crm-home-grid";
    MODULES.forEach((module) => {
      const bucket = document.createElement("button"); bucket.type = "button"; bucket.className = "crm-home-bucket";
      bucket.dataset.module = module.key; bucket.dataset.enabled = "true"; bucket.innerHTML = bucketHTML(module); grid.appendChild(bucket);
    });
    const hand = document.createElement("section"); hand.className = "crm-home-priority-hand"; hand.setAttribute("aria-label", "Important things coming up");
    fillPriorityHand(hand); root.append(grid, hand); requestAnimationFrame(mountAll); return root;
  };
  const layout = ({ expRect }) => {
    const surface = camera?.surface?.(); const grid = surface?.querySelector(".crm-home-grid"); const hand = surface?.querySelector(".crm-home-priority-hand"); if (!grid) return;
    const GAP = 16, OUTER = 16, full = expRect(); let controlsBottom = 42;
    document.querySelectorAll(".window-control-cluster").forEach((node) => { controlsBottom = Math.max(controlsBottom, node.getBoundingClientRect().bottom); });
    const top = Math.round(controlsBottom + 12); const hasCards = !!hand?.querySelector(".crm-home-hand-card.tk-card");
    const handReserve = hasCards ? Math.min(320, Math.max(254, innerWidth * .16 + 32)) : 72;
    hand?.style.setProperty("--home-hand-reserve", `${handReserve.toFixed(1)}px`);
    const area = { x: OUTER, y: top, w: full.w - 2 * OUTER, h: Math.max(220, full.h - top - OUTER - handReserve) };
    const aspect = innerWidth / innerHeight; let cellW = (area.w - 32) / 3; let cellH = cellW / aspect;
    if (2 * cellH + GAP > area.h) { cellH = (area.h - GAP) / 2; cellW = cellH * aspect; }
    const gridW = 3 * cellW + 32, gridH = 2 * cellH + GAP;
    Object.assign(grid.style, { left:`${area.x + (area.w-gridW)/2}px`, top:`${area.y + (area.h-gridH)/2}px`, width:`${gridW}px`, height:`${gridH}px` });
    surface.style.setProperty("--home-r", `${Math.min(64,Math.max(2,16/245*Math.min(cellW,cellH)*2)).toFixed(1)}px`);
    layoutPriorityHand(hand);
  };
  const targetAtPoint = (x, y, context) => context.level > 0 ? null
    : [...(context.layers[0]?.querySelectorAll('.crm-home-bucket[data-enabled="true"]') || [])].find((bucket) => {
      const rect = bucket.getBoundingClientRect(); return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }) || null;
  const targetFromEvent = (event, context) => {
    if (context.level > 0) return null;
    const target = event.target.closest?.('.crm-home-bucket[data-enabled="true"]');
    return target && context.layers[0]?.contains(target) ? target : null;
  };
  const buildExpander = (target) => {
    const module = MODULES.find(({ key }) => key === target?.dataset?.module) || MODULES[0];
    const bucket = document.createElement("div"); bucket.className = "crm-home-bucket crm-home-expander";
    bucket.dataset.module = module.key; bucket.innerHTML = bucketHTML(module);
    mountHost(bucket.querySelector(".crm-home-preview"), previews.get(module.key), true);
    return bucket;
  };

  camera = window.createFractalCamera({
    apiName:"crmHomeCamera",theater:"home",surfaceClass:"crm-home-surface",layerClass:"crm-home-level",
    warmClass:"crm-home-warm",contractingClass:"crm-home-contracting",active:false,maxLevel:1,margin:0,
    expandFadeMs:70,belowFadeMs:70,contractFadeMs:70,measureTop:()=>0,ensureStyles,buildRoot,layout,targetFromEvent,targetAtPoint,buildExpander,
    keyOf:(target)=>target.dataset.module||"",sourceSelector:(target)=>`.crm-home-bucket[data-module="${target.dataset.module}"]`,
    prepareJump:(expander)=>expander.classList.add("is-unwrapping"),
    onTransitionStart:(direction,context)=>{
      const expander=[...(context.surface?.querySelectorAll(".crm-home-expander:not(.crm-home-warm)")||[])].pop();
      if(expander)requestAnimationFrame(()=>expander.classList.toggle("is-unwrapping",direction==="expand"));
    },
    onLevelChange:(context)=>{if(context.active&&context.level===0)mountAll()},
  });

  document.addEventListener("click", (event) => {
    if (!camera?.isActive?.()) return;
    const target = event.target?.closest?.(".crm-home-bucket[data-module]");
    if (!target || !camera.surface()?.contains(target)) return;
    const key = target.dataset.module;
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    if (!camera.isTransitioning()) camera.expand(target);
    if (window.crmDeskTransit?.adoptDive) window.crmDeskTransit.adoptDive(key);
    else window.crmWorkspaces?.setActive?.(key);
  }, true);

  const setActive = (on) => {
    subscribe(); camera.setActive(on);
    if (on) { mountAll(); requestPreviews(false); refreshPriorityHand(); }
    else { clearTimeout(handRefreshTimer); handRefreshGeneration += 1; }
    return window.crmHome;
  };
  const waitForModuleSettled = (key, timeoutMs = 1800) => new Promise((resolve) => {
    const started = performance.now(); const theater = key === "cases" ? "tickets" : key === "invoices" ? "money" : key;
    const selector = {desk:".crm-desk-frame",people:".tk-zone,.tk-card,.tk-zcard",cases:".tk-zone,.tk-deck",bills:".tk-zone,.tk-deck",invoices:".tk-zone,.tk-deck",calendar:".fc-grid"}[key]||"*";
    let stable=0,last=""; const tick=()=>{const source=[...document.querySelectorAll(`[data-crm-theater="${theater}"]`)].find((node)=>!node.hidden);
      const next=source?.querySelector?.(selector)?`${source.childElementCount}:${source.querySelectorAll("*").length}`:"";
      stable=next&&next===last?stable+1:0;last=next;if(stable>=2||performance.now()-started>=timeoutMs)resolve();else requestAnimationFrame(tick)};requestAnimationFrame(tick);
  });
  const captureBaseline = async (key) => {
    if (window.crmHomePreviews?.isCaptureWorker) return previews.get(key)||null;
    try { const result=await window.crmHomePreviews?.capture?.(key); if(result?.preview)acceptPreview(result.preview); } catch {}
    return previews.get(key)||null;
  };
  window.addEventListener("resize",()=>camera?.layout?.());
  window.crmHome={setActive,isActive:()=>camera.isActive(),refresh:()=>{camera.layout();mountAll();requestPreviews(false)},captureBaseline,waitForModuleSettled,
    previewStatus:()=>MODULES.map(({key})=>({key,state:previews.has(key)?"ready":"waiting",version:previews.get(key)?.version||null,capturedAt:previews.get(key)?.capturedAt||0,layoutSignature:previews.get(key)?.layoutSignature||null})),
    handStatus:()=>({count:priorityItems.length,username:priorityUsername,ids:priorityItems.map((item)=>item.id)})};
})();
