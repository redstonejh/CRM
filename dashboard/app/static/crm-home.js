// crm-home.js — six inert screenshot LODs hosted by the original camera.
(() => {
  if (typeof window.createFractalCamera !== "function") return;

  const MODULES = [
    { key: "desk", label: "Overview" }, { key: "people", label: "People" },
    { key: "cases", label: "Tickets" }, { key: "money", label: "Money" },
    { key: "planner", label: "Planner" }, { key: "assignments", label: "Assignments" },
  ];
  const RETRY_MS = [0, 120, 320, 700, 1400, 2800, 5000];
  const HOME_PREVIEW_VERSION = "filtered-home-v31";
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
  let handDirty = true;
  let activeRefreshPending = false;
  let motionSnapshot = null;
  let factoryPrewarmHandle = 0;
  let factoryPrewarmTimer = 0;
  let factoryPrewarmRunning = false;
  let factoryPrewarmAttempts = 0;
  let factoryPrewarmAfter = 0;
  let handoffSequence = 0;
  let handoffPromise = Promise.resolve();
  let handoffResolve = null;
  const prewarmedFactories = new Set();
  const recycledExpanders = new Map();
  const FACTORY_PREWARM_APIS = ["crmDesk", "peopleCards", "ticketStacks", "crmMoneyRoom", "crmPlanner", "crmAssignments"];
  const FACTORY_API_BY_MODULE = { desk:"crmDesk", people:"peopleCards", cases:"ticketStacks", money:"crmMoneyRoom", planner:"crmPlanner", assignments:"crmAssignments" };

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
      .crm-home-surface[hidden]{display:none}.crm-home-level{position:absolute;inset:0;transform-origin:0 0;
        will-change:transform;backface-visibility:hidden}
      .crm-home-scene-backdrop{display:none;position:absolute;inset:0;z-index:0;overflow:hidden;pointer-events:none}
      .crm-home-motion-snapshot.crm-home-preview-image{display:none;position:absolute;inset:0;z-index:2;width:100%;height:100%;object-fit:fill;
        pointer-events:none;user-select:none;backface-visibility:hidden}
      .crm-home-surface.crm-home-camera-moving .crm-home-level{isolation:isolate;contain:paint}
      .crm-home-surface.crm-home-camera-moving .crm-home-scene-backdrop{display:block}
      .crm-home-surface.crm-home-camera-moving .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-motion-snapshot{display:block}
      /* At the contract endpoint the exact Home raster remains above the live
         root for one complete paint. The real glass, previews, hand and shadows
         can therefore rejoin the compositor while still covered, eliminating
         the otherwise-visible one-frame materialization at rest. */
      .crm-home-surface.crm-home-camera-handoff .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-motion-snapshot{
        display:block;z-index:30;opacity:.999;transform:translateZ(0);will-change:opacity;transition:opacity 112ms linear}
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-releasing .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-motion-snapshot{
        opacity:0}
      /* Removing .crm-home-camera-moving restores each tile's background and
         shadow underneath the endpoint raster. Keep that restoration atomic:
         otherwise the normal 180ms hover transition rebuilds the shadow after
         the raster has already gone, which reads as a one-frame flash. */
      .crm-home-surface.crm-home-camera-handoff .crm-home-grid>.crm-home-bucket,
      .crm-home-surface.crm-home-camera-handoff .crm-home-priority-hand>.crm-home-hand-card{
        animation:none!important;transition:none!important}
      .crm-home-surface.crm-home-camera-moving .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-scene-backdrop,
      .crm-home-surface.crm-home-camera-moving .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-priority-hand{visibility:hidden}
      /* The verified raster carries the expensive previews, glass, hand and
         shadows. Keep only the live title layer above it so expanding can
         de-emphasize titles while contracting restores them continuously. */
      .crm-home-surface.crm-home-camera-moving .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-grid>.crm-home-bucket{
        background:transparent!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;box-shadow:none!important}
      .crm-home-surface.crm-home-camera-moving .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-grid>.crm-home-bucket>.crm-home-preview{
        visibility:hidden}
      .crm-home-grid{position:absolute;z-index:1;display:grid;pointer-events:auto;will-change:transform;contain:layout style;
        grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:var(--crm-object-gap,18px)}
      .crm-home-bucket{position:relative;box-sizing:border-box;display:block;min-height:0;overflow:hidden;color:#fff;
        cursor:pointer;border:0;container-type:size;border-radius:var(--home-r,16px);padding:0;will-change:transform,backdrop-filter;
        background:linear-gradient(180deg,rgba(22,26,36,.34),rgba(12,16,24,.28));
        -webkit-backdrop-filter:blur(28px) saturate(140%);backdrop-filter:blur(28px) saturate(140%);
        box-shadow:inset 0 0 0 1px rgba(255,255,255,.14),inset 0 1px 0 rgba(255,255,255,.18),0 14px 26px -16px rgba(0,0,0,.72);
        transition:box-shadow .18s ease,background .18s ease}
      /* Home consumes the canonical glass material, but its six adjacent
         surfaces cannot also consume the menu's large floating shadow. That
         shadow overlaps into a single clipped rectangle around the grid. */
      .crm-home-bucket.crm-menu-surface{box-shadow:inset 0 1px 0 var(--crm-menu-highlight),0 14px 26px -16px rgba(0,0,0,.72)!important}
      .crm-home-bucket:hover{background:linear-gradient(180deg,rgba(40,55,76,.27),rgba(18,26,38,.23));
        box-shadow:inset 0 0 0 1px rgba(166,196,236,.27),inset 0 1px rgba(255,255,255,.15),0 14px 26px -16px rgba(0,0,0,.72)}
      .crm-home-title-glass{position:absolute;z-index:4;left:17px;bottom:16px;max-width:calc(100% - 34px);
        padding:0;text-align:left;pointer-events:none;contain:layout style;opacity:.92;background:none;border:0;box-shadow:none;
        transition:opacity .16s ease;display:block}
      .crm-home-title{font:620 clamp(11px,2.9cqh,13px)/1.1 system-ui;letter-spacing:.015em;
        max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(246,249,253,.91);
        text-shadow:0 1px 2px rgba(0,0,0,.92),0 3px 12px rgba(0,0,0,.72)}
      .crm-home-bucket:is(.is-preview-hovered,:focus-visible) .crm-home-title-glass{opacity:.28}
      .crm-home-preview{position:absolute;inset:0;z-index:1;overflow:hidden;contain:paint;border-radius:inherit;color:rgba(255,255,255,.62)}
      .crm-home-preview-state{position:absolute;inset:0;display:grid;place-items:center;font-size:.68rem;font-weight:760;
        letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.38)}
      .crm-home-preview-image{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:cover;pointer-events:none;
        user-select:none;transform:translateY(var(--far-shift-y,0%));transform-origin:center;backface-visibility:hidden}
      /* Each tile is one inert raster. A small GPU filter provides the resting
         depth cue and is the only visual property released on hover. */
      .crm-home-preview-foreground{filter:blur(1.8px) saturate(.9) brightness(.82);transition:filter .18s ease}
      .crm-home-bucket:is(.is-preview-hovered,:focus-visible) .crm-home-preview-foreground{filter:blur(0) saturate(.96) brightness(.9)}
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
      .crm-home-priority-hand.is-seating>.crm-home-hand-card.tk-card{transition:none}
      .crm-home-priority-hand:is(:hover,:focus-within)>.crm-home-hand-card.tk-card{
        transform:translateX(calc(-50% + var(--hand-x,0px))) translateY(var(--hand-open-y,0px)) rotate(var(--hand-open-rot,var(--hand-rot,0deg))) scale(.9)}
      .crm-home-priority-hand:is(:hover,:focus-within)>.crm-home-hand-card.tk-card:is(:hover,:focus-visible){z-index:1000;
        transform:translateX(calc(-50% + var(--hand-x,0px))) translateY(calc(var(--hand-open-y,0px) - 6px)) rotate(var(--hand-open-rot,var(--hand-rot,0deg))) scale(.92);
        box-shadow:inset 0 0 0 9999px rgba(255,255,255,.12),inset 0 1px rgba(255,255,255,.34),0 22px 48px rgba(0,0,0,.44)}
      .crm-home-hand-empty{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);font-size:9px;letter-spacing:.1em;
        text-transform:uppercase;color:rgba(218,228,242,.25);white-space:nowrap}
      @media(prefers-reduced-motion:reduce){
        .crm-home-priority-hand>.crm-home-hand-card.tk-card,
        .crm-home-title-glass{transition-duration:.01ms}
      }
      /* The transition lid is full-viewport. It must stay neutral in Electron's
         native app-region map or its temporary rectangle can cancel (and on
         Windows, outlive) the persistent title-bar drag strip. */
      .crm-home-expander{position:absolute;z-index:5;pointer-events:none;transform-origin:0 0;
        overflow:visible;background:transparent!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;box-shadow:none!important;
        will-change:transform,opacity;backface-visibility:hidden}
      .crm-home-surface.crm-home-camera-expanding .crm-home-title-glass{visibility:hidden;opacity:0!important;transition:none!important}
      /* Freeze only the six resting tiles. The expander is also a
         .crm-home-bucket; matching it here disabled the actual zoom. */
      .crm-home-surface.crm-home-camera-moving .crm-home-grid>.crm-home-bucket{transition:none!important}
      .crm-home-surface.crm-home-camera-moving .crm-home-grid{z-index:3}
      /* Backdrop sampling is the only Home-root effect that cannot be scaled
         at camera speed. The live geometry and every source/card shadow stay
         present; the exact expander above the root carries the destination's
         glass and shadows throughout the morph. */
      .crm-home-surface.crm-home-camera-moving .crm-home-grid>.crm-home-bucket{
        -webkit-backdrop-filter:none!important;backdrop-filter:none!important}
      .crm-home-expander .crm-home-title-glass{display:none}
      .crm-home-expander .crm-home-preview{opacity:1;border-radius:0;box-shadow:none}
      .crm-home-preview-exact{opacity:0;transform:translateY(var(--far-shift-y,0%))}
      .crm-home-expander .crm-home-preview-foreground,.crm-home-expander .crm-home-preview-exact{transition:transform 460ms cubic-bezier(.22,1,.26,1)}
      .crm-home-expander .crm-home-preview-foreground{filter:none}
      .crm-home-expander .crm-home-preview-exact{opacity:1}
      .crm-home-expander.is-unwrapping .crm-home-preview-foreground{transform:none;opacity:0}
      .crm-home-expander.is-unwrapping .crm-home-preview-exact{transform:none;opacity:1}
      /* The warm expander itself is already at .001 opacity. Attenuating its
         image a second time let Chromium cull the texture and upload it on the
         first animated frame. Keep the child opaque inside the imperceptible
         parent so hover genuinely precomposes the exact room lid. */
      .crm-home-warm .crm-home-preview-exact{opacity:1!important;transform:translateZ(0);will-change:transform,opacity}
      .crm-home-surface.crm-home-motion-priming .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-motion-snapshot{
        display:block;opacity:.001;transform:translateZ(0)}
      .crm-home-warm,.crm-home-warm *{pointer-events:none!important}
    `;
    document.head.appendChild(style);
  };

  const bucketHTML = (module) => `
    <div class="crm-home-preview" data-preview-key="${esc(module.key)}" data-preview-state="waiting" aria-label="Loading preview"></div>
    <div class="crm-home-title-glass"><div class="crm-home-title">${esc(module.label)}</div></div>`;

  const farShift = (preview) => {
    const bounds = preview?.foregroundBounds;
    if (!bounds || !preview.height) return 0;
    const contentCenter = bounds.y + bounds.height / 2;
    return Math.max(-6, Math.min(6, (preview.height / 2 - contentCenter) / preview.height * 100));
  };
  const imageNode = (className, src, decoding = "async") => {
    const image = document.createElement("img");
    image.className = `crm-home-preview-image ${className}`;
    image.decoding = decoding;
    if (src) image.src = src;
    image.alt = ""; image.draggable = false;
    return image;
  };
  const mountHost = (host, preview, exact = false, exactOnly = false) => {
    if (!host || !preview?.foregroundSrc) return false;
    host.style.setProperty("--far-shift-y", `${farShift(preview).toFixed(3)}%`);
    let foreground = host.querySelector(":scope > .crm-home-preview-foreground");
    if (exactOnly) {
      foreground?.remove();
      foreground = null;
    } else if (!foreground) {
      foreground = imageNode("crm-home-preview-foreground", preview.foregroundSrc);
      host.replaceChildren(foreground);
    } else {
      if (foreground.src !== preview.foregroundSrc) foreground.src = preview.foregroundSrc;
    }
    if (foreground) {
      foreground.dataset.previewVariant = "filtered";
      host.querySelector(":scope > .crm-home-preview-sharp")?.remove();
    }
    if (exact) {
      let full = host.querySelector(":scope > .crm-home-preview-exact");
      if (!full) { full = imageNode("crm-home-preview-exact", preview.exactSrc, "sync"); host.appendChild(full); }
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
  const revealSharpPreview = (bucket) => {
    if (!bucket) return;
    bucket.classList.add("is-preview-hovered");
  };
  const restSharpPreview = (bucket) => {
    if (!bucket?.matches(":focus-visible")) bucket?.classList?.remove("is-preview-hovered");
  };
  const acceptPreview = (preview) => {
    if (preview?.version !== HOME_PREVIEW_VERSION || !preview?.foregroundSrc || !preview?.exactSrc || !MODULES.some(({ key }) => key === preview.key)) return false;
    previews.set(preview.key, preview);
    if (camera?.isActive?.() && camera.level() === 0) mountPreview(preview.key);
    return true;
  };
  const motionLayoutSignature = (root = camera?.layers?.()[0]) => {
    if (!root) return "";
    const rectOf = (node) => {
      if (!node) return [];
      return [node.offsetLeft, node.offsetTop, node.offsetWidth, node.offsetHeight];
    };
    const grid = root.querySelector(":scope > .crm-home-grid");
    const hand = root.querySelector(":scope > .crm-home-priority-hand");
    return JSON.stringify({
      viewport: [innerWidth, innerHeight, devicePixelRatio],
      grid: rectOf(grid),
      buckets: [...(grid?.querySelectorAll(":scope > .crm-home-bucket") || [])].map((bucket) => [bucket.dataset.module, ...rectOf(bucket)]),
      hand: rectOf(hand),
      cards: [...(hand?.querySelectorAll(":scope > .crm-home-hand-card") || [])].map((card) => [
        card.dataset.priorityId || "", ...rectOf(card), getComputedStyle(card).transform,
      ]),
    });
  };
  const syncMotionSnapshot = (root = camera?.layers?.()[0]) => {
    if (!root) return;
    let image = root.querySelector(":scope > .crm-home-motion-snapshot");
    if (!image) {
      image = imageNode("crm-home-motion-snapshot", "");
      root.prepend(image);
    }
    const signatureMatches = () => !!motionSnapshot?.layoutSignature
      && motionSnapshot.layoutSignature === motionLayoutSignature(root);
    if (!motionSnapshot?.src || !signatureMatches()) {
      root.dataset.motionSnapshotReady = "false";
      return;
    }
    const src = motionSnapshot.src;
    const ready = () => {
      if (motionSnapshot?.src !== src || image.src !== src || image.naturalWidth <= 0 || !signatureMatches()) {
        root.dataset.motionSnapshotReady = "false";
        return;
      }
      root.dataset.motionSnapshotReady = "true";
      const surface = camera?.surface?.();
      if (surface && !surface.classList.contains("crm-home-motion-priming")) {
        surface.classList.add("crm-home-motion-priming");
        requestAnimationFrame(() => requestAnimationFrame(() => surface.classList.remove("crm-home-motion-priming")));
      }
    };
    if (image.src !== src) {
      root.dataset.motionSnapshotReady = "false";
      image.src = src;
      image.decode?.().then(ready).catch(() => {});
    } else if (image.complete) ready();
  };
  const acceptMotionSnapshot = (snapshot) => {
    if (snapshot?.version !== HOME_PREVIEW_VERSION || !snapshot?.src || !snapshot?.layoutSignature) return false;
    motionSnapshot = snapshot;
    syncMotionSnapshot();
    return true;
  };
  const requestMotionSnapshot = async () => {
    try { acceptMotionSnapshot((await window.crmHomePreviews?.motionSnapshot?.())?.snapshot); } catch {}
  };
  const requestPreviews = async (reset = false) => {
    clearTimeout(retryTimer);
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
    const renderSignature = JSON.stringify(priorityItems.map((item) => [
      item.id, item.title, item.status, item.priority, item.dueAt, item.assignee, item.attentionLabel, item.context,
    ]));
    hand.dataset.username = priorityUsername;
    hand.dataset.renderSignature = renderSignature;
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
    const renderSignature = JSON.stringify(priorityItems.map((item) => [
      item.id, item.title, item.status, item.priority, item.dueAt, item.assignee, item.attentionLabel, item.context,
    ]));
    if (hand.dataset.renderSignature === renderSignature && hand.dataset.username === priorityUsername) {
      layoutPriorityHand(hand); camera?.layout?.(); syncMotionSnapshot(); return;
    }
    hand.classList.add("is-seating");
    fillPriorityHand(hand);
    // The hand is measured and seated in the same task that creates it. Its
    // default CSS variables therefore never reach a paint and cannot fan out
    // one frame late after Home becomes visible.
    layoutPriorityHand(hand);
    camera?.layout?.();
    syncMotionSnapshot();
    requestAnimationFrame(() => { if (hand.isConnected) hand.classList.remove("is-seating"); });
  };
  const refreshPriorityHand = async () => {
    if (!camera?.isActive?.() || !window.crmDomain?.list) return;
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
      handDirty = false;
      renderPriorityHand();
    } catch {}
  };
  const scheduleHandRefresh = () => {
    handDirty = true;
    clearTimeout(handRefreshTimer);
    if (!camera?.isActive?.() || camera?.isTransitioning?.() || window.crmDeskTransit?.isBusy?.()) return;
    handRefreshTimer = setTimeout(refreshPriorityHand, 120);
  };
  const canPrewarmFactory = () => !!camera?.isActive?.()
    && !camera?.isTransitioning?.()
    && !window.crmDeskTransit?.isBusy?.()
    && performance.now() >= factoryPrewarmAfter;
  const primeInactiveTheater = (node, api) => new Promise((resolve) => {
    if (!node || api?.isActive?.() || !canPrewarmFactory()) { resolve(); return; }
    const properties = ["display", "opacity", "z-index", "pointer-events"];
    const saved = properties.map((property) => [property, node.style.getPropertyValue(property), node.style.getPropertyPriority(property)]);
    node.hidden = true;
    node.style.setProperty("display", "block", "important");
    node.style.setProperty("opacity", ".001", "important");
    node.style.setProperty("z-index", "0", "important");
    node.style.setProperty("pointer-events", "none", "important");
    const restore = () => {
      saved.forEach(([property, value, priority]) => value ? node.style.setProperty(property, value, priority) : node.style.removeProperty(property));
      node.hidden = !api?.isActive?.();
      resolve();
    };
    requestAnimationFrame(() => {
      if (!canPrewarmFactory()) { restore(); return; }
      requestAnimationFrame(restore);
    });
  });
  const scheduleFactoryPrewarm = () => {
    if (window.crmHomePreviews?.isCaptureWorker || factoryPrewarmRunning || factoryPrewarmHandle || factoryPrewarmTimer
      || prewarmedFactories.size >= FACTORY_PREWARM_APIS.length || factoryPrewarmAttempts >= 30) return;
    const run = async () => {
      factoryPrewarmHandle = 0;
      if (!canPrewarmFactory()) {
        factoryPrewarmTimer = setTimeout(() => { factoryPrewarmTimer = 0; scheduleFactoryPrewarm(); }, 120);
        return;
      }
      const name = FACTORY_PREWARM_APIS.find((apiName) => !prewarmedFactories.has(apiName) && window[apiName]?.baseline);
      if (!name) {
        factoryPrewarmAttempts += 1;
        factoryPrewarmTimer = setTimeout(() => { factoryPrewarmTimer = 0; scheduleFactoryPrewarm(); }, 120);
        return;
      }
      factoryPrewarmRunning = true;
      try {
        const api = window[name];
        const theater = await api.baseline({ canRender: canPrewarmFactory });
        if (canPrewarmFactory()) await primeInactiveTheater(theater, api);
        if (canPrewarmFactory()) prewarmedFactories.add(name);
      } catch {}
      factoryPrewarmRunning = false;
      scheduleFactoryPrewarm();
    };
    if (typeof requestIdleCallback === "function") factoryPrewarmHandle = requestIdleCallback(run, { timeout: 700 });
    else factoryPrewarmHandle = requestAnimationFrame(run);
  };
  const subscribe = () => {
    if (subscribed) return;
    subscribed = true;
    try { window.crmHomePreviews?.onChanged?.(acceptPreview); } catch {}
    try { window.crmHomePreviews?.onMotionSnapshotChanged?.(acceptMotionSnapshot); } catch {}
    if (window.crmHomePreviews?.isCaptureWorker) { requestPreviews(true); refreshPriorityHand(); return; }
    try { window.crmDomain?.onChanged?.(scheduleHandRefresh); } catch {}
    try { window.auth?.onChanged?.(scheduleHandRefresh); } catch {}
    requestPreviews(true);
    requestMotionSnapshot();
    refreshPriorityHand();
    scheduleFactoryPrewarm();
  };

  const syncSceneBackdrop = (root) => {
    if (!root) return;
    let scene = root.querySelector(":scope > .crm-home-scene-backdrop");
    if (!scene) { scene = document.createElement("div"); scene.className = "crm-home-scene-backdrop"; root.prepend(scene); }
    const source = document.querySelector("body > .workspace-photo-backdrop:not([hidden])");
    const track = source?.querySelector(":scope > .workspace-photo-track");
    if (track) {
      // The live track intentionally carries at least three viewport panels
      // for page scrolling. Cloning that entire strip into a zooming layer
      // triples its texture height. Home only needs the panel currently under
      // this fixed viewport, represented by one equivalent background paint.
      const panels = [...track.querySelectorAll(":scope > .workspace-photo-panel")];
      const index = Math.max(0, Math.min(panels.length - 1, Math.floor(scrollY / Math.max(1, innerHeight))));
      const panelStyle = panels[index] ? getComputedStyle(panels[index]) : null;
      scene.replaceChildren();
      Object.assign(scene.style, {
        backgroundColor: panelStyle?.backgroundColor || "transparent",
        backgroundImage: panelStyle?.backgroundImage || "none",
        backgroundPosition: panelStyle?.backgroundPosition || "center center",
        backgroundSize: panelStyle?.backgroundSize || "cover",
        backgroundRepeat: panelStyle?.backgroundRepeat || "no-repeat",
      });
      return;
    }
    scene.replaceChildren();
    const style = getComputedStyle(document.body);
    Object.assign(scene.style, {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      backgroundPosition: style.backgroundPosition,
      backgroundSize: style.backgroundSize,
      backgroundRepeat: style.backgroundRepeat,
    });
  };

  const buildRoot = () => {
    const root = document.createElement("div"); root.className = "crm-home-level";
    const scene = document.createElement("div"); scene.className = "crm-home-scene-backdrop"; root.appendChild(scene);
    const snapshot = imageNode("crm-home-motion-snapshot", ""); root.appendChild(snapshot);
    const grid = document.createElement("div"); grid.className = "crm-home-grid";
    MODULES.forEach((module) => {
      const bucket = document.createElement("button"); bucket.type = "button"; bucket.className = "crm-home-bucket";
      bucket.dataset.module = module.key; bucket.dataset.enabled = "true"; bucket.innerHTML = bucketHTML(module);
      // Do not activate merely because a tile finishes loading beneath an
      // already-stationary pointer. Actual pointer movement arms the reveal.
      bucket.addEventListener("pointermove", () => {
        if (!bucket.dataset.previewReady || bucket.classList.contains("is-preview-hovered")) return;
        revealSharpPreview(bucket);
      });
      bucket.addEventListener("pointerleave", () => {
        restSharpPreview(bucket);
      });
      bucket.addEventListener("focus", () => revealSharpPreview(bucket));
      bucket.addEventListener("blur", () => restSharpPreview(bucket));
      grid.appendChild(bucket);
    });
    const hand = document.createElement("section"); hand.className = "crm-home-priority-hand"; hand.setAttribute("aria-label", "Important things coming up");
    fillPriorityHand(hand); root.append(grid, hand); syncSceneBackdrop(root); syncMotionSnapshot(root); requestAnimationFrame(mountAll); return root;
  };
  const layout = ({ expRect }) => {
    const surface = camera?.surface?.(); const grid = surface?.querySelector(".crm-home-grid"); const hand = surface?.querySelector(".crm-home-priority-hand"); if (!grid) return;
    const rootStyle = getComputedStyle(document.documentElement);
    const metric = (name, fallback) => parseFloat(rootStyle.getPropertyValue(name)) || fallback;
    const GAP = metric("--crm-object-gap", 18), OUTER = 18, full = expRect(); let controlsBottom = 42;
    document.querySelectorAll(".window-control-cluster").forEach((node) => { controlsBottom = Math.max(controlsBottom, node.getBoundingClientRect().bottom); });
    const top = Math.round(Math.max(controlsBottom + 14, metric("--crm-canvas-top", 78)));
    // Home geometry must not depend on an asynchronous priority query. Keep
    // the same hand reserve before, during, and after the cards arrive.
    const handReserve = Math.min(320, Math.max(254, innerWidth * .16 + 32));
    hand?.style.setProperty("--home-hand-reserve", `${handReserve.toFixed(1)}px`);
    const area = { x: OUTER, y: top, w: full.w - 2 * OUTER, h: Math.max(220, full.h - top - OUTER - handReserve) };
    const aspect = innerWidth / innerHeight; let cellW = (area.w - GAP * 2) / 3; let cellH = cellW / aspect;
    if (2 * cellH + GAP > area.h) { cellH = (area.h - GAP) / 2; cellW = cellH * aspect; }
    const gridW = 3 * cellW + GAP * 2, gridH = 2 * cellH + GAP;
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
    const bucket = recycledExpanders.get(module.key) || document.createElement("div");
    recycledExpanders.delete(module.key);
    bucket.className = "crm-home-bucket crm-home-expander";
    bucket.dataset.module = module.key;
    if (!bucket.querySelector(".crm-home-preview")) bucket.innerHTML = bucketHTML(module);
    // The exact room image carries stack/card shadows for every transition
    // frame. One full-resolution layer avoids the redundant matte pass that
    // previously cost a compositor frame while the root was also moving.
    mountHost(bucket.querySelector(".crm-home-preview"), previews.get(module.key), true, true);
    return bucket;
  };
  const recycleExpander = (key, expander) => {
    if (!expander || !MODULES.some((module) => module.key === key)) return;
    expander.remove();
    expander.className = "crm-home-bucket crm-home-expander";
    recycledExpanders.set(key, expander);
  };
  const finishHandoff = () => {
    camera?.surface?.()?.classList.remove("crm-home-camera-handoff", "crm-home-camera-releasing");
    const resolve = handoffResolve;
    handoffResolve = null;
    resolve?.();
  };
  const beginHomeHandoff = (context, sequence) => {
    const surface = context.surface;
    const snapshot = context.layers?.[0]?.querySelector?.(":scope > .crm-home-motion-snapshot");
    if (!surface || !snapshot || context.layers?.[0]?.dataset?.motionSnapshotReady !== "true") {
      finishHandoff();
      handoffPromise = Promise.resolve();
      return;
    }
    finishHandoff();
    handoffPromise = new Promise((resolve) => { handoffResolve = resolve; });
    surface.classList.add("crm-home-camera-handoff");
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      snapshot.removeEventListener("transitionend", onEnd);
      if (sequence === handoffSequence) finishHandoff();
      else handoffResolve?.();
    };
    const onEnd = (event) => {
      if (event.target === snapshot && event.propertyName === "opacity") finish();
    };
    const timeout = setTimeout(finish, 180);
    snapshot.addEventListener("transitionend", onEnd);
    // Two fully covered paints instantiate the live Home glass and shadows;
    // the short overlap then trades identical pixels without a hard edge.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (sequence !== handoffSequence) { finish(); return; }
      surface.classList.add("crm-home-camera-releasing");
    }));
  };

  camera = window.createFractalCamera({
    apiName:"crmHomeCamera",theater:"home",surfaceClass:"crm-home-surface",layerClass:"crm-home-level",
    warmClass:"crm-home-warm",contractingClass:"crm-home-contracting",active:false,maxLevel:1,margin:0,
    expandFadeMs:70,belowFadeMs:70,contractFadeMs:70,keepBelowVisibleDuringTransition:true,precomposeTransitions:true,lockInputDuringTransitions:true,measureTop:()=>0,ensureStyles,buildRoot,layout,targetFromEvent,targetAtPoint,buildExpander,
    contractExpanderAbove:true,holdContractEndpointFrame:true,
    keyOf:(target)=>target.dataset.module||"",sourceSelector:(target)=>`.crm-home-bucket[data-module="${target.dataset.module}"]`,
    prepareJump:(expander)=>expander.classList.add("is-unwrapping"),
    onTransitionStart:(direction,context)=>{
      finishHandoff();
      handoffSequence += 1;
      factoryPrewarmAfter = Number.POSITIVE_INFINITY;
      context.surface?.classList.remove("crm-home-motion-priming","crm-home-camera-handoff","crm-home-camera-releasing");
      syncMotionSnapshot(context.layers?.[0]);
      syncSceneBackdrop(context.layers?.[0]);
      context.surface?.classList.add("crm-home-camera-moving");
      context.surface?.classList.toggle("crm-home-camera-expanding",direction==="expand");
      context.surface?.classList.toggle("crm-home-camera-contracting",direction==="contract");
      const expander=[...(context.surface?.querySelectorAll(".crm-home-expander:not(.crm-home-warm)")||[])].pop();
      if(expander)requestAnimationFrame(()=>expander.classList.toggle("is-unwrapping",direction==="expand"));
    },
    onTransitionEnd:(direction,context)=>{
      context.surface?.classList.remove("crm-home-camera-moving","crm-home-camera-expanding","crm-home-camera-contracting");
      const sequence = ++handoffSequence;
      if (direction === "contract" && context.layers?.[0]?.dataset?.motionSnapshotReady === "true") {
        beginHomeHandoff(context, sequence);
      } else finishHandoff();
      // After returning Home, use the next idle slice to prepare the next room.
      // Expanding leaves Home inactive, so its longer guard remains appropriate.
      factoryPrewarmAfter = performance.now() + (direction === "contract" ? 60 : 250);
      scheduleFactoryPrewarm();
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
    subscribe();
    const changed = camera.isActive() !== !!on;
    if (changed) {
      camera.setActive(on);
      if (on) factoryPrewarmAfter = performance.now() + 250;
    }
    if (on) {
      mountAll();
      scheduleFactoryPrewarm();
      if (window.crmDeskTransit?.isBusy?.()) activeRefreshPending = handDirty;
      else {
        activeRefreshPending = false;
        requestPreviews(false);
        if (handDirty) refreshPriorityHand();
      }
    }
    else {
      clearTimeout(handRefreshTimer); handRefreshGeneration += 1;
      clearTimeout(factoryPrewarmTimer); factoryPrewarmTimer = 0;
      if (factoryPrewarmHandle) {
        if (typeof cancelIdleCallback === "function") cancelIdleCallback(factoryPrewarmHandle);
        else cancelAnimationFrame(factoryPrewarmHandle);
        factoryPrewarmHandle = 0;
      }
    }
    return window.crmHome;
  };
  document.addEventListener("crm:desk-transit-settled", (event) => {
    if ((!activeRefreshPending && !handDirty) || event.detail?.key !== "home" || !camera?.isActive?.()) return;
    activeRefreshPending = false;
    requestAnimationFrame(() => {
      if (!camera?.isActive?.() || window.crmDeskTransit?.isBusy?.()) { activeRefreshPending = true; return; }
      requestPreviews(false);
      if (handDirty) refreshPriorityHand();
    });
  });
  const waitForModuleSettled = (key, timeoutMs = 2200) => new Promise((resolve) => {
    const started = performance.now(); const theater = key === "cases" ? "tickets" : key === "money" ? "money-room" : key;
    const selector = {desk:".crm-overview-project,.crm-overview-ticket,.crm-overview-update",people:".tk-zone,.tk-card,.tk-zcard",cases:".tk-zone,.tk-deck",money:".tk-zone,.tk-card",planner:".crm-planner-project,.crm-planner-bucket,.crm-planner-card",assignments:".crm-assignment-bucket,.tk-card"}[key]||"*";
    let stable=0,last=""; const tick=()=>{const source=[...document.querySelectorAll(`[data-crm-theater="${theater}"]`)].find((node)=>!node.hidden);
      const samples=source?[source,...source.querySelectorAll(selector)].slice(0,64):[];
      const geometry=samples.map((node)=>{const rect=node.getBoundingClientRect();const style=getComputedStyle(node);return[
        node.dataset?.id||node.dataset?.recordId||node.dataset?.stage||node.dataset?.assignmentCommitment||node.className,
        rect.x.toFixed(2),rect.y.toFixed(2),rect.width.toFixed(2),rect.height.toFixed(2),style.transform,style.opacity,
      ].join(":")}).join("|");
      // A room can be intentionally empty (notably a new Planner). Its own
      // stable geometry is still a valid destination; requiring a child object
      // held the reveal open until the timeout and made the handoff hitch.
      const next=source?`${source.childElementCount}:${source.querySelectorAll("*").length}:${source.scrollWidth}:${source.scrollHeight}:${geometry}`:"";
      stable=next&&next===last?stable+1:0;last=next;if(stable>=3||performance.now()-started>=timeoutMs)resolve({stable:stable>=3,signature:next});else requestAnimationFrame(tick)};requestAnimationFrame(tick);
  });
  const waitForModuleReady = (key) => new Promise((resolve) => {
    const theater = key === "cases" ? "tickets" : key === "money" ? "money-room" : key;
    const selector = {desk:".crm-overview-project,.crm-overview-ticket,.crm-overview-update",people:".tk-zone,.tk-card,.tk-zcard",cases:".tk-zone,.tk-deck",money:".tk-zone,.tk-card",planner:".crm-planner-project,.crm-planner-bucket,.crm-planner-card",assignments:".crm-assignment-bucket,.tk-card"}[key]||"*";
    const source=[...document.querySelectorAll(`[data-crm-theater="${theater}"]`)].find((node)=>!node.hidden);
    if(source?.querySelector?.(selector))resolve();else requestAnimationFrame(resolve);
  });
  const captureBaseline = async (key) => {
    if (window.crmHomePreviews?.isCaptureWorker) return previews.get(key)||null;
    try { const result=await window.crmHomePreviews?.capture?.(key); if(result?.preview)acceptPreview(result.preview); } catch {}
    return previews.get(key)||null;
  };
  const noteModuleReady = (key) => {
    const apiName = FACTORY_API_BY_MODULE[key];
    if (apiName) prewarmedFactories.add(apiName);
  };
  window.addEventListener("resize",()=>{camera?.layout?.();requestAnimationFrame(()=>syncMotionSnapshot())});
  window.crmHome={setActive,isActive:()=>camera.isActive(),refresh:()=>{camera.layout();mountAll();requestPreviews(false);syncMotionSnapshot()},captureBaseline,waitForModuleSettled,waitForModuleReady,waitForHandoff:()=>handoffPromise,noteModuleReady,recycleExpander,
    previewStatus:()=>MODULES.map(({key})=>({key,state:previews.has(key)?"ready":"waiting",version:previews.get(key)?.version||null,capturedAt:previews.get(key)?.capturedAt||0,layoutSignature:previews.get(key)?.layoutSignature||null})),
    handStatus:()=>({ready:!handDirty,count:priorityItems.length,username:priorityUsername,ids:priorityItems.map((item)=>item.id)}),
    ensureHandReady:refreshPriorityHand,motionLayoutSignature,motionStatus:()=>({ready:camera?.layers?.()[0]?.dataset?.motionSnapshotReady==="true",capturedAt:motionSnapshot?.capturedAt||0,layoutSignature:motionSnapshot?.layoutSignature||""}),
    prewarmStatus:()=>({ready:[...prewarmedFactories],running:factoryPrewarmRunning,pending:FACTORY_PREWARM_APIS.filter((name)=>!prewarmedFactories.has(name))})};
})();
