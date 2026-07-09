// card-system.js — reusable corner-deck / bucket-zone card choreography.
//
// The original ticket stacks proved the mechanics: two corner decks, a trash deck,
// staged bucket zones, drag-to-grid, drag-back-to-stack, reorder, and context-aware
// detail opens. This factory keeps that choreography intact while lifting the
// entity seams into config.
((global) => {
global.createCrmCardSystem = function createCrmCardSystem(config = {}) {
  const source = config.source || global.tickets;
  const detail = config.detail || global.ticketDetail;
  const apiName = config.apiName || "ticketStacks";
  const widgetType = config.widgetType || "ticket";
  const widgetTitle = config.widgetTitle || "Ticket";
  const widgetCardClass = config.widgetCardClass || "ticket-widget-card";
  const pinPrefix = config.pinPrefix || `${widgetType}-pin-`;
  const gridFallback = config.gridFallback || global.ticketGrid;
  const dashboardPlacement = config.dashboardPlacement || global.ticketDashboardPlacement;
  const resolvedState = config.resolvedState || "resolved";
  const isResolved = config.isResolved || ((record) => !!record && (record.state || "open") === resolvedState);
  const recordsFromList = config.recordsFromList || ((result) => (result && (result.tickets || result.records)) || []);
  const recordFromCreate = config.recordFromCreate || ((result) => result && (result.ticket || result.record));
  const createDraftFields = config.createDraftFields || (() => ({ companyLabel: "Untitled", host: "", severity: "medium" }));
  const createStageLabel = config.createStageLabel || "New ticket";
  const intensityValues = config.intensityValues || ["low", "medium", "high", "critical"];
  const defaultIntensity = config.defaultIntensity || intensityValues[1] || "medium";
  const onLinkDrop = typeof config.onLinkDrop === "function" ? config.onLinkDrop : null;
  const onCalendarDrop = typeof config.onCalendarDrop === "function" ? config.onCalendarDrop : null;
  const onHomeStageDrop = typeof config.onHomeStageDrop === "function" ? config.onHomeStageDrop : null;
  const deckOnly = config.deckOnly === true;
  const rightDeckEnabled = !deckOnly && config.rightDeckEnabled !== false;
  const trashEnabled = !deckOnly && config.trashEnabled !== false;
  const createEnabled = config.createEnabled !== false;
  const showProgressBars = config.showProgressBars !== false;
  const showDateUnder = config.showDateUnder !== false;
  const stageMovement = config.stageMovement || "gated";
  const stageUpdateFields = typeof config.stageUpdateFields === "function" ? config.stageUpdateFields : null;
  const configuredCardBg = typeof config.cardBackground === "function" ? config.cardBackground : null;
  const configuredStaleness = typeof config.stalenessOf === "function" ? config.stalenessOf : null;
  const attentionDeckFilter = typeof config.attentionDeckFilter === "function" ? config.attentionDeckFilter : null;
  const faceBadges = typeof config.faceBadges === "function" ? config.faceBadges : null;
  const bucketSummary = typeof config.bucketSummary === "function" ? config.bucketSummary : null;
  const resolvedPulse = config.resolvedPulse === true;
  const autoFanOncePerDayKey = String(config.autoFanOncePerDayKey || "");
  const leftDeckFilter = typeof config.leftDeckFilter === "function" ? config.leftDeckFilter : ((record) => !isResolved(record));
  const rightDeckFilter = typeof config.rightDeckFilter === "function" ? config.rightDeckFilter : ((record) => isResolved(record));
  const deckCopy = {
    leftFanAria: `Fan out active ${widgetTitle.toLowerCase()}s`,
    rightFanAria: `Fan out resolved ${widgetTitle.toLowerCase()}s`,
    trashFanAria: `Fan out deleted ${widgetTitle.toLowerCase()}s`,
    createAria: `Create a ${widgetTitle.toLowerCase()}`,
    trashAria: `Recycle bin (deleted ${widgetTitle.toLowerCase()}s)`,
    trashTitle: "Recycle bin",
    ...(config.deckCopy || {}),
  };
  const intensityOf = config.intensityOf || ((record) => {
    const p = priorityOf(record);
    return intensityValues.includes(p) ? p : (record ? "medium" : "none");
  });
  const storageKeys = {
    order: (side) => `tk-stack-order-${side}`,
    stage: "tk-ticket-stage",
    stageOrder: "tk-stage-order",
    deleted: "tk-deleted",
    meta: "tk-ticket-meta",
    color: "tk-ticket-color",
    colorLast: "tk-ticket-color-last",
    ...(config.storageKeys || {}),
  };
  const instanceGlobal = apiName ? String(apiName) : "";
  const theaterKey = String(config.theater || apiName);
  let active = config.active !== false;
  let started = false;
  let publicApi = null;
  let CARD_W = 185, CARD_H = 279;          // matched to the grid ticket card at render time
  const MARGIN = 18, GAP_FAN = 10, RADIUS = 15;
  const ZCARD_PEEK = 42;   // height of a zone card's title that peeks above the card stacked on it
  const EASE = "cubic-bezier(.22, 1, .26, 1)";
  const SEV_RGB = config.severityRgb || { low: "34,211,238", medium: "250,204,21", high: "249,115,22", critical: "234,88,12", none: "120,130,140" };
  const sevOf = (t) => {
    const key = intensityOf(t);
    return Object.prototype.hasOwnProperty.call(SEV_RGB, key) ? key : (t ? defaultIntensity : "none");
  };

  // Persist the per-deck custom card order (from drag-to-reorder) across reloads.
  const ORDER_KEY = (side) => typeof storageKeys.order === "function" ? storageKeys.order(side) : `${storageKeys.order}-${side}`;
  const loadOrder = (side) => { try { const v = JSON.parse(localStorage.getItem(ORDER_KEY(side)) || "null"); return Array.isArray(v) ? v : null; } catch { return null; } };
  const saveOrder = (side) => { try { localStorage.setItem(ORDER_KEY(side), JSON.stringify(decks[side]?.order || [])); } catch {} };

  // Pipeline stages — the glass "bucket" zones on the dashboard. A ticket dragged into a
  // zone is assigned that stage (persisted by id); unassigned tickets live in the corner
  // stacks (the inbox). cssEsc guards attribute selectors built from ticket ids.
  const cssEsc = (window.CSS && CSS.escape) ? (s) => CSS.escape(s) : (s) => String(s).replace(/["\\\]]/g, "\\$&");
  const STAGES = Array.isArray(config.stages) ? config.stages : [
    { key: "triage", label: "Triage" },
    { key: "investigation", label: "Investigation" },
    { key: "resolution", label: "Resolution" },
  ];
  const STAGE_KEYS = STAGES.map((s) => s.key);
  const zonesEnabled = !deckOnly && config.zonesEnabled !== false && STAGE_KEYS.length > 0;
  const STAGE_STORE = storageKeys.stage;
  let stageMap = (() => { try { return JSON.parse(localStorage.getItem(STAGE_STORE) || "{}") || {}; } catch { return {}; } })();
  const ticketById = (id) => tickets.find((x) => x && x.id === id) || null;
  const patchTicketDoc = (id, fields) => {
    if (!id || !fields || !Object.keys(fields).length) return;
    try { source?.update?.(id, fields); } catch {}
  };
  const stageOf = (id) => {
    if (!zonesEnabled) return null;
    const docStage = ticketById(id)?.stage;
    if (STAGE_KEYS.includes(docStage)) return docStage;
    return id && STAGE_KEYS.includes(stageMap[id]) ? stageMap[id] : null;
  };
  const setStage = (id, stage) => {
    if (!zonesEnabled) return;
    if (!id) return;
    const nextStage = stage && STAGE_KEYS.includes(stage) ? stage : null;
    if (nextStage) stageMap[id] = nextStage; else delete stageMap[id];
    try { localStorage.setItem(STAGE_STORE, JSON.stringify(stageMap)); } catch {}
    const t = ticketById(id);
    const extra = stageUpdateFields ? (stageUpdateFields(id, nextStage, t) || {}) : {};
    if (t) {
      t.stage = nextStage;
      Object.assign(t, extra);
    }
    patchTicketDoc(id, { stage: nextStage, ...extra });
  };

  // Per-stage card order = the vertical stacking order within a bucket. A ticket ENTERING a bucket
  // always APPENDS to the bottom — the visually-lowest card, which (cards fan downward) is the
  // z-TOPMOST, fully-visible one. Only a reorder within the same bucket inserts at the layer the
  // cursor is over. Persisted like the stage map.
  const STAGE_ORDER_STORE = storageKeys.stageOrder;
  let stageOrder = (() => { try { return JSON.parse(localStorage.getItem(STAGE_ORDER_STORE) || "{}") || {}; } catch { return {}; } })();
  // Place id into stage's order at index (clamped); a null stage just removes it from every order.
  const setStageAt = (id, stage, index) => {
    if (!zonesEnabled) return;
    if (!id) return;
    for (const k of Object.keys(stageOrder)) stageOrder[k] = (stageOrder[k] || []).filter((x) => x !== id);
    if (stage && STAGE_KEYS.includes(stage)) {
      const arr = stageOrder[stage] || (stageOrder[stage] = []);
      arr.splice(clamp(index | 0, 0, arr.length), 0, id);
      arr.forEach((rankedId, rank) => {
        const t = ticketById(rankedId);
        const extra = stageUpdateFields ? (stageUpdateFields(rankedId, stage, t) || {}) : {};
        if (t) { t.stage = stage; t.stageRank = rank; Object.assign(t, extra); }
        patchTicketDoc(rankedId, { stage, stageRank: rank, ...extra });
      });
    } else {
      const t = ticketById(id);
      const extra = stageUpdateFields ? (stageUpdateFields(id, null, t) || {}) : {};
      if (t) { t.stageRank = null; Object.assign(t, extra); }
      patchTicketDoc(id, { stageRank: null, ...extra });
    }
    try { localStorage.setItem(STAGE_ORDER_STORE, JSON.stringify(stageOrder)); } catch {}
  };

  // Deleted tickets (a client-side flag, NOT tickets.remove() — they must be kept & shown in the
  // trash). The right stack shows resolved tickets normally; its trash button flips it to show
  // these instead. Persisted like the stage map.
  const DELETED_STORE = storageKeys.deleted;
  let deletedSet = (() => { try { return new Set(JSON.parse(localStorage.getItem(DELETED_STORE) || "[]")); } catch { return new Set(); } })();
  const isDeleted = (id) => {
    const t = ticketById(id);
    return !!(id && (deletedSet.has(id) || t?.deletedAt));
  };
  const setDeleted = (id, on) => {
    if (!id) return;
    if (on) deletedSet.add(id); else deletedSet.delete(id);
    try { localStorage.setItem(DELETED_STORE, JSON.stringify([...deletedSet])); } catch {}
    const t = ticketById(id);
    const deletedAt = on ? new Date().toISOString() : null;
    if (t) t.deletedAt = deletedAt;
    patchTicketDoc(id, { deletedAt });
  };
  let trashMode = false;   // right stack: false → resolved/closed, true → deleted (trash)
  let trashShowEmpty = false;   // true while the user has DELIBERATELY opened the empty bin — keep it open to show its placeholder instead of auto-closing

  // Per-ticket title/subtitle overrides (e.g. for a manually-created ticket the user names in the
  // config). The ticket API can't edit companyLabel/host, so — like the stage & deleted flags —
  // these live client-side in localStorage and are applied at render.
  const META_STORE = storageKeys.meta;
  let metaMap = (() => { try { return JSON.parse(localStorage.getItem(META_STORE) || "{}") || {}; } catch { return {}; } })();
  const metaOf = (id) => ({ ...((id && ticketById(id)?.meta) || {}), ...((id && metaMap[id]) || {}) });
  // Effective severity/priority. A meta-stored value (persisted in localStorage, exactly like every other
  // stage field) wins over the ticket store's copy — so a chosen severity survives a refresh even if the
  // auth-gated store round-trip didn't take. This is what keeps triage's progress from resetting.
  const priorityOf = (t) => { if (!t) return ""; const mp = metaOf(t.id).priority; return (mp != null && mp !== "") ? mp : (t.priority || ""); };
  // Keys that are genuinely client-local bookkeeping and never belong on the
  // record itself; everything else a config edit writes is promoted to a
  // top-level record field too, so the face (which reads ONLY the record)
  // always shows the edit. This is the write-through half of the face contract.
  const LOCAL_META_KEYS = new Set(["activity", "delStage", "color", "durationMin", "overtimeMin"]);
  const setMeta = (id, m) => {
    if (!id) return;
    // The effort fields keep their natural-language text AND a parsed minutes value ("the data
    // understands it") — durationMin is 8h-day work time, overtimeMin the extra beyond that.
    if ("duration" in m) m = { ...m, durationMin: parseDuration(m.duration) };
    if ("overtime" in m) m = { ...m, overtimeMin: parseDuration(m.overtime) };
    metaMap[id] = { ...metaOf(id), ...m };
    try { localStorage.setItem(META_STORE, JSON.stringify(metaMap)); } catch {}
    const t = ticketById(id);
    if (t) t.meta = { ...(t.meta || {}), ...metaMap[id] };
    const promoted = {};
    for (const [key, value] of Object.entries(m)) if (!LOCAL_META_KEYS.has(key)) promoted[key] = value;
    if (t) Object.assign(t, promoted);
    patchTicketDoc(id, { ...promoted, meta: metaMap[id] });
  };
  // One-time write-through migration: a record whose face would be empty but
  // whose legacy meta override holds a title/description gets those PATCHed
  // onto the record — after which the meta store is never read for a face.
  let facesMigrated = false;
  const migrateLegacyFaces = () => {
    if (facesMigrated) return;
    facesMigrated = true;
    tickets.forEach((t) => {
      const m = (t && metaMap[t.id]) || null;
      if (!m) return;
      const fields = {};
      if (!firstFaceText(t.title, t.name, t.client, t.companyLabel) && firstFaceText(m.client, m.title)) {
        fields.title = firstFaceText(m.client, m.title);
      }
      if (!firstFaceText(t.description, t.host) && firstFaceText(m.description, m.subtitle)) {
        fields.description = firstFaceText(m.description, m.subtitle);
      }
      if (Object.keys(fields).length) {
        Object.assign(t, fields);
        patchTicketDoc(t.id, fields);
      }
    });
  };
  // Client-side activity trail (stage moves, trash/restore, severity…) — the store's own history
  // (created / edited / resolved / …) covers the backend events; the right-click Activity view merges both.
  const logActivity = (id, text) => {
    if (!id || !text) return;
    const a = [...(metaOf(id).activity || []), { at: Date.now(), text }].slice(-100);   // keep the last 100
    setMeta(id, { activity: a });
  };
  // ── The face contract ─────────────────────────────────────────────────────────
  // A card's title/subtitle/body rows derive EXCLUSIVELY from the record through
  // the per-config contract below (config.face) — never from the legacy
  // localStorage meta-override store. That store double-booked identity per
  // surface, which is how the same deal read "Unknown" here and "Harbor & Lane
  // retainer" there. Records that only had a title in legacy meta get it
  // PATCHed onto the record once at load (see migrateLegacyFaces), then meta is
  // never consulted for a face again.
  const face = config.face || null;
  const firstFaceText = (...values) => {
    for (const value of values) {
      const text = String(value ?? "").trim();
      if (text && !isNA(text)) return text;
    }
    return "";
  };
  const titleOf = (t) => {
    if (!t) return "Unknown";
    const custom = face?.title ? firstFaceText(face.title(t)) : "";
    return custom || firstFaceText(t.title, t.name, t.client, t.companyLabel) || "Unknown";
  };
  const subOf = (t) => {
    if (!t) return "";
    if (face?.subtitle) return firstFaceText(face.subtitle(t));
    return firstFaceText(t.description, t.host);
  };
  let pendingOpenId = null;   // a just-created ticket to fly into its config once it spawns in
  let draftId = null;         // a just-created ticket that isn't "real" yet — it only commits once its
                              // create fields (client/date/description) are saved; cancelling discards it
  let pendingRender = false;  // a render arrived while the detail config was open → run it once it closes

  let root = null, stackScrim = null, theater = null;
  const decks = { left: null, right: null, trash: null };   // each: { box, arrow, bar, thumb, cards:[], scrollX, contentW, viewW }
  const fanned = { left: false, right: false, trash: false };
  const CONTROL_SIDES = ["left", ...(rightDeckEnabled || trashEnabled ? ["right"] : [])];
  const DECK_SIDES = ["left", ...(rightDeckEnabled || trashEnabled ? ["right"] : []), ...(trashEnabled ? ["trash"] : [])];   // trash = the recycle bin, a right-hand stack lifted above the icon
  const CORNER_SIDES = rightDeckEnabled ? ["left", "right"] : ["left"];
  let tickets = [], subscribed = false;
  let linkHighlightEl = null;

  // ONE owned root per instance. Everything this factory creates — stacks,
  // scrim, zones, flow arrows, menus, drag flyers — lives inside it, so hiding
  // the theater hides the whole module in one move. (The old per-element
  // `hidden` toggles silently failed on .tk-zones: its author-level
  // `display: contents` overrode the UA [hidden] rule, which is exactly how
  // the Triage/Investigation/Resolution buckets bled through every surface.)
  const ensureTheater = () => {
    if (theater) return theater;
    ensureStyles();
    theater = document.createElement("section");
    theater.className = "crm-theater";
    theater.dataset.crmTheater = theaterKey;
    theater.hidden = !active;
    document.body.appendChild(theater);
    return theater;
  };
  const applyActiveVisibility = () => {
    if (theater) theater.hidden = !active;
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const isNA = (v) => String(v ?? "").trim().toLowerCase() === "n/a";   // "n/a" = field satisfied, but shows nothing
  const human = (ms) => {
    if (!Number.isFinite(ms) || ms < 0) return "—";
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d) return `${d}d ${h % 24}h`;
    if (h) return `${h}h ${m % 60}m`;
    if (m) return `${m}m`;
    return `${s}s`;
  };
  const localDate = (date = new Date()) => {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };

  // The REAL grid ticket card — scoped to the dashboard layout so it never matches one of
  // our stack cards (which now also carry data-widget-runtime-type="ticket").
  const gridCard = () => document.querySelector(`.dashboard-layout-grid [data-widget-runtime-type="${cssEsc(widgetType)}"], .widget-layout [data-widget-runtime-type="${cssEsc(widgetType)}"]`);
  const matchCardSize = () => {
    const g = gridCard();
    if (g) { const r = g.getBoundingClientRect(); if (r.width > 40 && r.height > 40) { CARD_W = Math.round(r.width); CARD_H = Math.round(r.height); } }
  };

  // The opaque colour the (translucent) ticket fill sits over. A ticket's final colour = fill ⊕ this
  // backdrop, so if this tracked the LIVE dashboard background, a dark background would show through
  // and darken the ticket. Pin it to the "Dark grey" tone (#1f2937 — the default background), so every
  // ticket renders EXACTLY as it does on the grey background (the source of truth), regardless of the
  // active background. Change GRAY_BACKDROP if a different grey is the reference.
  const GRAY_BACKDROP = "rgb(107, 114, 128)";   // tone-grey #6b7280 (the "Grey" background)
  const baseColor = () => GRAY_BACKDROP;
  // Per-severity OPAQUE fill matching the grid card exactly. Probe a hidden ticket card IN
  // THE GRID'S CONTEXT (so the db-panel white-mix var resolves identically — a probe on
  // <body> inherits a different mix and renders faded) and copy its resolved background.
  // Opaque (vs glass) so stacked cards never blur/brighten each other.
  const sevBgCache = {};
  const severityBg = (sev) => {
    if (sevBgCache[sev]) return sevBgCache[sev];
    const fallback = `linear-gradient(180deg, rgba(${SEV_RGB[sev]},0.4), rgba(${SEV_RGB[sev]},0.2))`;
    // The probe needs the ticket widget's severity→accent palette (#ticket-widget-styles,
    // injected by widget-registry at load). If it isn't present yet, use the gradient
    // fallback WITHOUT caching so a later render probes the exact db-panel fill instead of
    // poisoning the cache with the default (blue) accent.
    if (!document.getElementById("ticket-widget-styles")) return fallback;
    // Probe in the grid's own context so the db-panel white-mix var resolves identically.
    // With no ticket on the grid, fall back to the builder-chart layout (NOT <body>, which
    // inherits a different mix and renders faded).
    const host = (gridCard() && gridCard().parentElement)
      || document.querySelector('.widget-layout[data-widget-layout-key="builder-chart"]')
      || document.querySelector('.dashboard-layout-grid')
      || document.body;
    const probe = document.createElement("div");
    probe.className = `widget-card ${widgetCardClass} db-panel-custom-color`;
    probe.setAttribute("data-widget-runtime-type", widgetType);
    probe.dataset.severity = sev;
    probe.style.cssText = "position:absolute; left:-9999px; top:0; width:160px; height:200px;";
    host.appendChild(probe);
    const cs = getComputedStyle(probe);
    const layers = [];
    if (cs.backgroundImage && cs.backgroundImage !== "none") layers.push(cs.backgroundImage);
    if (cs.backgroundColor && !/^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(cs.backgroundColor)) layers.push(`linear-gradient(${cs.backgroundColor}, ${cs.backgroundColor})`);
    probe.remove();
    if (layers.length) return (sevBgCache[sev] = layers.join(", "));
    return fallback;
  };

  // ── Blank-ticket colours ──────────────────────────────────────────────────────
  // A ticket with no information yet (no title/subtitle/priority) is painted a random colour
  // from the EXISTING widget palette (panelThemePresets in modules/panel-appearance-runtime.js),
  // minus white/"clear" — never the same colour twice in a row. The colour sticks (persisted)
  // until a priority is set, when the severity colour takes over. Applies to new AND existing
  // blank tickets (assigned lazily on render).
  const TICKET_COLORS = config.cardColors || ["#2563eb", "#0ea5e9", "#0891b2", "#14b8a6", "#16a34a", "#65a30d", "#ca8a04", "#d97706", "#dc2626", "#e11d48", "#db2777", "#9333ea", "#7c3aed", "#4f46e5", "#64748b", "#111827"];
  const COLOR_STORE = storageKeys.color, COLOR_LAST = storageKeys.colorLast;
  let colorMap = (() => { try { return JSON.parse(localStorage.getItem(COLOR_STORE) || "{}") || {}; } catch { return {}; } })();
  let lastColor = (() => { try { return localStorage.getItem(COLOR_LAST) || null; } catch { return null; } })();
  const hexToRgb = (hex) => { const h = String(hex).replace("#", ""); return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }; };
  const assignColor = (id) => {
    const pool = TICKET_COLORS.filter((c) => c !== lastColor);          // never the same colour twice in a row
    const c = (pool.length ? pool : TICKET_COLORS)[Math.floor(Math.random() * (pool.length || TICKET_COLORS.length))];
    colorMap[id] = c; lastColor = c;
    try { localStorage.setItem(COLOR_STORE, JSON.stringify(colorMap)); localStorage.setItem(COLOR_LAST, c); } catch {}
    return c;
  };
  const hasPriority = (t) => intensityValues.includes(priorityOf(t));
  // "Blank" mirrors the face contract: a card whose face shows a placeholder
  // title, no subtitle, and no priority gets a random palette colour until it
  // earns an identity.
  const PLACEHOLDER_TITLES = new Set(["", "Unknown", "Untitled", "(manual)", "Untitled deal", "New contact", "New invoice"]);
  const isBlank = (t) => PLACEHOLDER_TITLES.has(titleOf(t)) && !subOf(t) && !hasPriority(t);
  const colorFor = (t) => {
    if (!t || !t.id) return null;
    const oc = metaOf(t.id).color;              // appearance-menu override: an explicit colour wins over EVERYTHING
    if (oc) return oc;                          // (absent/"" → "match severity", the default: fall through)
    if (hasPriority(t)) return null;            // explicit priority → use the severity colour
    if (colorMap[t.id]) return colorMap[t.id];  // already coloured → keep it (sticky)
    if (isBlank(t)) return assignColor(t.id);   // blank & unassigned (new OR retroactive) → assign one
    return null;
  };
  // Render a palette colour through the SAME db-panel fill as the severity colours, so it gets the
  // same muted/mature look (the accent mixed into the dark surface) rather than the raw bright hex.
  const colorBgCache = {};
  const colorBg = (hex) => {
    if (colorBgCache[hex]) return colorBgCache[hex];
    const { r, g, b } = hexToRgb(hex);
    const fallback = `linear-gradient(180deg, rgba(${r},${g},${b},0.4), rgba(${r},${g},${b},0.2))`;
    if (!document.getElementById("ticket-widget-styles")) return fallback;
    const host = (gridCard() && gridCard().parentElement) || document.querySelector('.widget-layout[data-widget-layout-key="builder-chart"]') || document.querySelector(".dashboard-layout-grid") || document.body;
    const probe = document.createElement("div");
    probe.className = `widget-card ${widgetCardClass} db-panel-custom-color`;
    probe.setAttribute("data-widget-runtime-type", widgetType);
    probe.style.cssText = `position:absolute; left:-9999px; top:0; width:160px; height:200px; --panel-accent:${hex}; --panel-accent-rgb:${r}, ${g}, ${b};`;
    host.appendChild(probe);
    const cs = getComputedStyle(probe);
    const layers = [];
    if (cs.backgroundImage && cs.backgroundImage !== "none") layers.push(cs.backgroundImage);
    if (cs.backgroundColor && !/^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(cs.backgroundColor)) layers.push(`linear-gradient(${cs.backgroundColor}, ${cs.backgroundColor})`);
    probe.remove();
    return layers.length ? (colorBgCache[hex] = layers.join(", ")) : fallback;
  };
  // The card fill: a random widget colour for a blank ticket, else its severity colour.
  const cardBg = (t) => {
    if (configuredCardBg) {
      const custom = configuredCardBg(t, { metaOf, colorBg, severityBg, sevOf, priorityOf });
      if (custom) return custom;
    }
    const c = colorFor(t);
    return c ? colorBg(c) : severityBg(sevOf(t));
  };
  const stalenessOf = (t) => {
    if (!configuredStaleness || !t) return 0;
    const value = Number(configuredStaleness(t, { metaOf, stageOf, isResolved }));
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  };
  const applyStaleness = (el, t) => {
    if (!el) return;
    const value = stalenessOf(t);
    if (value > 0.005) el.style.setProperty("--crm-staleness", value.toFixed(3));
    else el.style.removeProperty("--crm-staleness");
  };
  const inAttentionDeck = (t) => {
    if (!attentionDeckFilter || !t || isDeleted(t.id)) return false;
    try { return !!attentionDeckFilter(t, { metaOf, stageOf, isResolved, stalenessOf }); }
    catch { return false; }
  };

  // ── Stage progress bars (3 segments, one per bucket) ──────────────────────────────────────
  // Each bucket "owns" one segment (its identity). A ticket fills segments as it advances: passed
  // stages green, current stage yellow→green once that stage's required fields are filled, future
  // stages grey; a deleted ticket shows the bucket it was deleted from red. Per-stage required
  // fields (the config menu shows only the current bucket's, each with its question) — a field is
  // satisfied when it has any value, and "n/a" counts as satisfied while showing nothing on the card.
  // Client name, date of incident and the short description are collected UP FRONT (the create form,
  // openCreate) — they're preconditions for the ticket existing, so they're not stage fields. Triage is
  // then just severity + who's on it; resolution additionally records the date it was resolved.
  const STAGE_FIELDS = config.stageFields || {
    triage:        [ { key: "priority",    label: "Severity",    q: "How severe is it?", prio: true },
                     { key: "assignee",    label: "Assignee",    q: "Who's handling it?" } ],
    investigation: [ { key: "investigation", label: "Cause", q: "What caused the issue?", area: true },
                     { key: "fix",           label: "Fix",   q: "What's the fix?", area: true } ],
    resolution:    [ { key: "resolution", label: "Proof", q: "How do you know it's resolved? (you confirmed it / it auto-resolved / a client confirmed…)", area: true, big: true },
                     { key: "resolutionDate", label: "Date resolved", date: true },
                     { key: "duration", label: "Time taken", q: "e.g. 15 minutes, 2 hours, 1 week — a day is 8 working hours" },
                     { key: "overtime", label: "Overtime", q: "any extra hours beyond 8/day? (or “none”)" } ],
  };
  // Required up-front to create a ticket at all. Client → the card title; incident date → the header.
  const CREATE_FIELDS = config.createFields || [
    { key: "client",       label: "Client",           q: "Client name" },
    { key: "incidentDate", label: "Date of incident", date: true },
    { key: "description",  label: "Description",       q: "What's the issue?", area: true },
  ];
  // ISO date (yyyy-mm-dd, from <input type=date>) → mm-dd-yy (month-day-year) for the compact header/card display.
  const fmtDate = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || "")); return m ? `${m[2]}-${m[3]}-${m[1].slice(2)}` : String(v || ""); };
  // Natural-language work-effort → MINUTES. A "day" is 8 working hours and a "week" is 5 of those days,
  // so "1 week" = 40h; overtime beyond that is captured separately. Sums every "<n> <unit>" it finds
  // ("1 hour 30 min", "2d 4h"…); returns null if nothing parseable (e.g. "none").
  const DUR_UNIT = { s: 1 / 60, sec: 1 / 60, second: 1 / 60, m: 1, min: 1, minute: 1, hr: 60, hour: 60, h: 60,
                     day: 480, d: 480, week: 2400, wk: 2400, w: 2400, month: 9600, mo: 9600, year: 124800, yr: 124800, y: 124800 };
  const parseDuration = (s) => {
    if (!s || isNA(s)) return null;
    let total = 0, found = false, mm; const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/gi;
    while ((mm = re.exec(s))) { const n = parseFloat(mm[1]); const u = mm[2].toLowerCase(); const f = DUR_UNIT[u] ?? (u.endsWith("s") ? DUR_UNIT[u.slice(0, -1)] : undefined);
      if (f != null) { total += n * f; found = true; } }
    return found ? Math.round(total) : null;
  };
  const fieldRaw = (t, key) => {
    const m = metaOf(t.id);
    if (key === "title") return titleOf(t);
    if (key === "subtitle") return m.subtitle != null ? m.subtitle : (t.host ?? "");
    if (key === "description") return m.description != null ? m.description : (t.description ?? "");
    if (key === "assignee") return m.assignee != null ? m.assignee : (t.assignee ?? "");
    if (key === "priority") return priorityOf(t);
    return m[key] != null ? m[key] : (t[key] ?? "");   // stage fields can come from local meta or the shared record doc
  };
  const fieldSatisfied = (t, key) => key === "priority" ? hasPriority(t) : String(fieldRaw(t, key) ?? "").trim() !== "";
  const stageComplete = (t, i) => (STAGE_FIELDS[STAGE_KEYS[i]] || []).every((f) => fieldSatisfied(t, f.key));
  // The FURTHEST stage a ticket has actually completed (that stage's fields all filled), or the last stage
  // if it's already resolved. This is a property of the ticket's DATA — not which bucket/stack it sits in
  // — so progress survives being thrown back into a stack, and it's what earns the ticket permission to
  // traverse buckets (see canAdvance). Contiguous: reaching a later stage greens all the ones before it.
  const progressOf = (t) => {
    if (!t) return -1;
    if (isResolved(t)) return STAGE_KEYS.length - 1;
    let p = -1;
    for (let i = 0; i < STAGE_KEYS.length; i++) if (stageComplete(t, i)) p = i;
    return p;
  };
  const canResolveRecord = (t) => (
    typeof config.canResolve === "function"
      ? !!config.canResolve(t, { progressOf, stageOf, metaOf })
      : progressOf(t) >= STAGE_KEYS.length - 1
  );
  const ticketBarClasses = (t) => {
    const furthest = progressOf(t);                              // green up to here, wherever the ticket goes
    const cur = STAGE_KEYS.indexOf(stageOf(t.id) || "");         // the bucket it's currently in (-1 = a stack)
    if (isDeleted(t.id)) {
      const d = STAGE_KEYS.indexOf(metaOf(t.id).delStage || "");  // the stage it was deleted from
      return STAGE_KEYS.map((_, i) => (i <= furthest ? "g" : i === d ? "r" : ""));   // completed green; died-in-unfinished red
    }
    // Completed stages stay green no matter where the ticket lives; the stage it's currently IN, if not
    // yet finished, shows amber "in progress"; the rest are empty.
    return STAGE_KEYS.map((_, i) => (i <= furthest ? "g" : i === cur ? "y" : ""));
  };
  // A bucket's bars fill green CUMULATIVELY up to (and including) its own stage — Triage = [g,·,·],
  // Investigation = [g,g,·], Resolution = [g,g,g] — so the bucket reads as "progress up to here".
  const bucketBarClasses = (j) => STAGE_KEYS.map((_, i) => (i <= j ? "g" : ""));
  const barsHTML = (classes, onCard) => showProgressBars
    ? `<div class="tk-bars${onCard ? " tk-bars-card" : ""}">${classes.map((c) => `<span class="tk-seg${c ? " " + c : ""}"></span>`).join("")}</div>`
    : "";

  const ensureStyles = () => {
    if (document.getElementById("ticket-stacks-styles")) return;
    const style = document.createElement("style");
    style.id = "ticket-stacks-styles";
    style.textContent = `
      /* Text in the ticket UI is never selectable — dragging/clicking must not highlight or capture text.
         (The only place selection is allowed is the config menu's editable fields — see ticket-detail.js.) */
      /* The theater: one owned root per card-system instance. display:contents so it adds NO box
         or stacking context (its fixed-position children keep behaving exactly as before) — and the
         [hidden] rule is author-level + !important so it actually wins over display:contents (the UA
         [hidden] rule does not, which is how zones used to bleed through hidden). */
      .crm-theater { display: contents; }
      .crm-theater[hidden] { display: none !important; }
      .tk-stacks, .tk-zones { -webkit-user-select: none; user-select: none; }
      .tk-stacks { position: fixed; inset: auto 0 0 0; z-index: 4000; pointer-events: none; -webkit-app-region: no-drag; }
      /* Depth-of-field: a full-screen blur layer BETWEEN the focused stack (z 3) and everything else
         (idle decks z 1, and the whole dashboard/buckets behind .tk-stacks). Shown when a stack is
         fanned or the recycle bin is open — that stack stays sharp, the rest goes soft. No dimming. */
      /* Depth-of-field scrim. It lives at BODY level (not inside .tk-stacks) at a z BELOW the stacks
         (4000) but ABOVE the resting buckets/arrows — so it blurs the dashboard + idle buckets, the
         stacks stay sharp above it, and a focused bucket can rise above it (3950) yet still below the
         stacks. That ordering is what keeps an open recycle bin from hiding behind the Resolution panel. */
      .tk-scrim { position: fixed; inset: 0; z-index: 3900; pointer-events: none;
        -webkit-backdrop-filter: blur(0px); backdrop-filter: blur(0px);
        transition: backdrop-filter .42s cubic-bezier(.4,0,.2,1), -webkit-backdrop-filter .42s cubic-bezier(.4,0,.2,1); }
      .tk-deck { position: absolute; bottom: 0; top: 0; width: 50%; pointer-events: none; transition: opacity .25s ease, transform .3s cubic-bezier(.2,.9,.3,1); }
      .tk-deck-left { left: 0; } .tk-deck-right, .tk-deck-trash { right: 0; }
      .tk-deck.is-fanned { pointer-events: auto; }
      .tk-deck.is-empty { display: none; }
      .tk-deck.is-dimmed { opacity: 0.3; }   /* the idle stack while the other is fanned */
      /* FIX_PASS_2 F2: the dashed empty-stack placeholders are gone. An empty
         deck is the "+" button alone; an empty bucket is an empty glass bucket. */
      .tk-deck.tk-drop-ok .tk-card { box-shadow: 0 0 0 2px rgba(125,180,255,0.7), 0 10px 26px rgba(0,0,0,0.42) !important; }
      /* The cards live in this track; horizontal scroll is ONE rigid transform on the track, decoupled
         from each card's own transform (slot/collision, which keeps its .42s transition). pointer-events
         none so the full-size track never blocks clicks above the deck — the cards re-enable it. */
      .tk-track { position: absolute; inset: 0; pointer-events: none; will-change: transform; }
      /* A stack card IS a real ticket card (same widget-card / ticket / db-panel-custom-color
         classes + .ticket-body markup) so its colour, glass, fonts and shape are IDENTICAL to
         the dashboard widget. .tk-card ONLY adds positioning + the fan/drag motion — no visual
         overrides, no will-change (which rasterised/blurred the text). */
      /* .tk-card replicates the ticket-card FRAME (padding/radius/shadow/flex) so cards look
         identical to the grid widget — but it is NOT a .widget-card, so the widget runtime's
         "render into every .widget-card" loop never overwrites them. The inner .ticket-body /
         .ticket-company / .ticket-host / .ticket-down classes are global, so content matches. */
      .tk-card { position: absolute; bottom: ${MARGIN}px; box-sizing: border-box; pointer-events: auto; cursor: grab;
        user-select: none; -webkit-user-select: none;   /* drag/double-click must not highlight the card text */
        padding: 14px 15px; border-radius: 15px; color: #fff; display: flex; flex-direction: column; overflow: hidden;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.22), 0 8px 22px rgba(0,0,0,0.18);
        transform-origin: bottom center; transition: transform .42s ${EASE}, box-shadow .2s ease; }
      .tk-deck-left .tk-card { left: ${MARGIN}px; } .tk-deck-right .tk-card, .tk-deck-trash .tk-card { right: ${MARGIN}px; }
      .tk-card:hover { box-shadow: inset 0 0 0 9999px rgba(255,255,255,0.12), inset 0 1px 0 rgba(255,255,255,0.34), 0 8px 22px rgba(0,0,0,0.18); }
      .tk-card.tk-link-target, .tk-zcard.tk-link-target { box-shadow: inset 0 0 0 2px rgba(125,180,255,0.95), 0 0 24px rgba(90,150,255,0.48), inset 0 1px 0 rgba(255,255,255,0.34), 0 8px 22px rgba(0,0,0,0.2) !important; }
      .tk-card.tk-dragging { cursor: grabbing; transition: none; opacity: 0.72;   /* see-through while dragging so the cards/slots underneath stay visible */
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.30), 0 24px 52px rgba(0,0,0,0.45); }
      .tk-card.tk-flying { transition: transform .4s ${EASE}, opacity .4s ease; pointer-events: none; }
      /* Recycle bin: its cards are ringed in the same transient blue as the active bin button, so the
         lifted trash stack reads clearly as the deleted-tickets view (distinct from the resolved pile). */
      .tk-deck-trash .tk-card { box-shadow: inset 0 0 0 2px rgba(125,180,255,0.85), 0 0 18px rgba(90,150,255,0.30), inset 0 1px 0 rgba(255,255,255,0.24), 0 8px 22px rgba(0,0,0,0.18); }
      .tk-deck-trash .tk-card:hover { box-shadow: inset 0 0 0 9999px rgba(255,255,255,0.10), inset 0 0 0 2px rgba(125,180,255,0.95), 0 0 22px rgba(90,150,255,0.42), inset 0 1px 0 rgba(255,255,255,0.34), 0 8px 22px rgba(0,0,0,0.18); }
      /* "restore" action on a trash card — plain text, bottom-right, same look as the config menu's buttons. */
      .tk-restore { position: absolute; bottom: 11px; right: 14px; z-index: 8; pointer-events: auto; -webkit-appearance: none; appearance: none;
        background: transparent; border: 0; padding: 0; margin: 0; cursor: pointer; font: inherit; font-size: 0.8rem; font-weight: 700;
        color: rgba(255,255,255,0.78); transition: color .14s ease; }
      .tk-restore:hover { color: #fff; }
      /* Right-click ticket menu — the config-menu recipe (frosted glass, flat plain-text items). */
      .tk-menu { position: fixed; z-index: 7000; display: flex; flex-direction: column; gap: 1px; padding: 6px; border-radius: 12px; color: #fff;
        background: linear-gradient(180deg, rgba(22,26,36,0.62), rgba(12,16,24,0.55));
        -webkit-backdrop-filter: blur(26px) saturate(140%); backdrop-filter: blur(26px) saturate(140%);
        border: 1px solid rgba(255,255,255,0.22); box-shadow: inset 0 1px 0 rgba(255,255,255,0.24), 0 18px 42px rgba(0,0,0,0.42); }
      .tk-menu-item { -webkit-appearance: none; appearance: none; background: transparent; border: 0; cursor: pointer; text-align: left; white-space: nowrap;
        padding: 6px 22px 6px 12px; border-radius: 8px; font: inherit; font-size: 0.85rem; font-weight: 600; color: rgba(255,255,255,0.72); transition: background .12s ease, color .12s ease; }
      .tk-menu-item:hover { background: rgba(255,255,255,0.08); color: #fff; }
      .tk-menu-danger { color: rgba(255,135,135,0.85); }
      .tk-menu-danger:hover { background: rgba(255,90,90,0.14); color: #ff8a8a; }
      /* Appearance submenu: the widget palette as swatches + a "match severity" check item. */
      .tk-swatches { display: grid; grid-template-columns: repeat(8, 20px); gap: 7px; padding: 8px 12px 6px; }
      .tk-swatch { -webkit-appearance: none; appearance: none; width: 20px; height: 20px; border-radius: 50%; cursor: pointer;
        border: 1px solid rgba(255,255,255,0.30); padding: 0; box-shadow: inset 0 1px 0 rgba(255,255,255,0.25);
        transition: transform .12s ease, box-shadow .12s ease; }
      .tk-swatch:hover { transform: scale(1.18); }
      .tk-swatch.is-active { box-shadow: 0 0 0 2px rgba(255,255,255,0.95), inset 0 1px 0 rgba(255,255,255,0.25); }
      .tk-menu-check { display: flex; align-items: center; gap: 7px; }
      .tk-menu-check .tk-tick { width: 13px; flex: 0 0 auto; font-weight: 800; color: rgba(140,255,180,0.95); }
      /* Activity view — a scrollable trail in the same frosted shell. */
      .tk-activity { width: 285px; max-height: 330px; overflow-y: auto; overscroll-behavior: contain;
        scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.5) transparent; }
      .tk-act-hd { font-size: 0.82rem; font-weight: 700; color: rgba(255,255,255,0.88); padding: 4px 8px 7px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tk-act-row { display: flex; flex-direction: column; gap: 1px; padding: 5px 8px; border-radius: 8px; }
      .tk-act-row:hover { background: rgba(255,255,255,0.05); }
      .tk-act-when { font-size: 0.68rem; color: rgba(255,255,255,0.45); font-variant-numeric: tabular-nums; }
      .tk-act-text { font-size: 0.8rem; line-height: 1.35; color: rgba(255,255,255,0.82); }
      .tk-act-by { color: rgba(255,255,255,0.5); }
      .tk-act-none { color: rgba(255,255,255,0.45); font-size: 0.8rem; }

      .tk-arrow { position: absolute; width: 34px; height: 34px; border-radius: 50%; -webkit-appearance: none; appearance: none; z-index: 5000;
        border: 1px solid rgba(255,255,255,0.22); cursor: pointer; pointer-events: auto;
        background: linear-gradient(180deg, rgba(22,26,36,0.62), rgba(12,16,24,0.55));
        -webkit-backdrop-filter: blur(26px) saturate(140%); backdrop-filter: blur(26px) saturate(140%);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.24), 0 10px 26px rgba(0,0,0,0.34);
        color: #fff; display: flex; align-items: center; justify-content: center;
        transition: left .42s ${EASE}, right .42s ${EASE}, transform .2s ease, opacity .2s ease; }
      .tk-arrow:hover { transform: scale(1.08); }
      .tk-arrow svg { width: 15px; height: 15px; } .tk-arrow.is-hidden { opacity: 0; pointer-events: none; }

      /* Create (+) / trash buttons centred above each corner stack — same glass pill as .tk-arrow. */
      .tk-stack-btn { position: absolute; width: 34px; height: 34px; border-radius: 50%; -webkit-appearance: none; appearance: none; z-index: 5000;
        border: 1px solid rgba(255,255,255,0.22); cursor: pointer; pointer-events: auto;
        background: linear-gradient(180deg, rgba(22,26,36,0.62), rgba(12,16,24,0.55));
        -webkit-backdrop-filter: blur(26px) saturate(140%); backdrop-filter: blur(26px) saturate(140%);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.24), 0 10px 26px rgba(0,0,0,0.34);
        color: #fff; display: flex; align-items: center; justify-content: center;
        transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease, opacity .25s ease; }
      .tk-stack-btn:hover { transform: scale(1.08); }
      .tk-stack-btn svg { width: 16px; height: 16px; }
      .tk-stack-btn.is-active { border-color: rgba(125,180,255,0.85);
        box-shadow: inset 0 0 0 1px rgba(125,180,255,0.45), 0 0 18px rgba(90,150,255,0.45), inset 0 1px 0 rgba(255,255,255,0.24); }
      /* "Hold to open the bin" ring: a blue stroke that draws a full trip AROUND the icon while a
         dragged ticket rests on it (completing the trip opens the bin — the JS timer matches the .72s).
         Centred on the button and sized just outside its edge; blue matches the toggled (.is-active) glow. */
      /* NB: qualified with .tk-stack-btn to outrank ".tk-stack-btn svg { width:16px }" (the icon rule),
         which would otherwise shrink the ring to 16px (smaller than + offset from the button). */
      .tk-stack-btn .tk-ring { position: absolute; top: 50%; left: 50%; width: 44px; height: 44px; pointer-events: none; opacity: 0;
        transform: translate(-50%, -50%) rotate(-90deg); }
      .tk-stack-btn .tk-ring circle { fill: none; stroke: rgba(125,180,255,0.9); stroke-width: 2.5; stroke-linecap: round;
        filter: drop-shadow(0 0 5px rgba(90,150,255,0.5)); stroke-dasharray: 125.7; stroke-dashoffset: 125.7; }
      .tk-stack-btn.tk-ringing .tk-ring { opacity: 1; }
      .tk-stack-btn.tk-ringing .tk-ring circle { stroke-dashoffset: 0; transition: stroke-dashoffset .72s linear; }
      /* Delete "suck-in": the ring fills as the shrinking ticket is drawn into the icon, then fades out. */
      .tk-stack-btn.tk-suck .tk-ring { opacity: 1; }
      .tk-stack-btn.tk-suck .tk-ring circle { stroke-dashoffset: 0; transition: stroke-dashoffset .5s ease-out; }
      .tk-stack-btn.tk-suck-done .tk-ring { opacity: 0; transition: opacity .3s ease; }

      /* Full-width, high-contrast horizontal scrollbar across the bottom under a fanned stack. */
      .tk-bar { position: absolute; height: 8px; border-radius: 999px; background: rgba(255,255,255,0.16);
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06); pointer-events: auto; opacity: 0; transition: opacity .2s ease; }
      .tk-bar.is-on { opacity: 1; }
      .tk-thumb { position: absolute; top: 0; height: 8px; border-radius: 999px; background: rgba(255,255,255,0.66); cursor: grab;
        box-shadow: 0 1px 4px rgba(0,0,0,0.4); transition: background .15s ease; }
      .tk-thumb:hover { background: rgba(255,255,255,0.88); }
      .tk-thumb:active { cursor: grabbing; background: #fff; }

      /* Quantum-tunnel wiggle when a ticket dragged off the grid re-inserts into a
         stack. Animates the individual translate/scale/filter props (NOT transform) so
         it composes with the resting transform that place() writes inline. */
      @keyframes tk-tunnel {
        0%   { translate: 0 -4px; scale: 1.03; filter: brightness(1.12); opacity: .85; }
        30%  { translate: -3px 0; scale: 1.006; filter: none; opacity: 1; }
        55%  { translate: 2px 0; }
        78%  { translate: -1px 0; }
        100% { translate: 0 0; scale: 1; filter: none; opacity: 1; }
      }
      .tk-card.tk-tunneling { animation: tk-tunnel .32s cubic-bezier(.25, 1, .35, 1) both; }

      /* Drop outlines on the corner decks during a ticket drag. BOTH decks show a faint
         outline (.tk-faint); the hovered deck intensifies (.tk-hot). The deck that does
         not match the ticket's state turns red (.tk-bad) and rejects the drop — an open
         ticket may enter only the left (active) deck, a resolved one only the right. */
      .tk-landing { position: absolute; bottom: ${MARGIN}px; border-radius: ${RADIUS}px; opacity: 0;
        pointer-events: none; border: 2px dashed rgba(125,180,255,0.9); background: rgba(95,150,255,0.10);
        transition: opacity .18s ease, border-color .18s ease, background .18s ease; z-index: 600; }
      .tk-landing.tk-left { left: ${MARGIN}px; } .tk-landing.tk-right { right: ${MARGIN}px; }
      .tk-landing.tk-faint { opacity: 0.32; }
      .tk-landing.tk-hot { opacity: 1; animation: tk-landing-pulse 1.05s ease-in-out infinite; }
      .tk-landing.tk-bad { border-color: rgba(255,120,120,0.92); background: rgba(255,90,90,0.10); }
      .tk-landing.tk-bad.tk-hot { animation: tk-landing-pulse-bad 1.05s ease-in-out infinite; }
      @keyframes tk-landing-pulse {
        0%, 100% { box-shadow: 0 0 0 3px rgba(80,140,255,0.10), inset 0 0 18px rgba(95,150,255,0.30); }
        50%      { box-shadow: 0 0 0 7px rgba(80,140,255,0.16), inset 0 0 34px rgba(95,150,255,0.6); }
      }
      @keyframes tk-landing-pulse-bad {
        0%, 100% { box-shadow: 0 0 0 3px rgba(255,80,80,0.12), inset 0 0 18px rgba(255,90,90,0.30); }
        50%      { box-shadow: 0 0 0 7px rgba(255,80,80,0.20), inset 0 0 34px rgba(255,90,90,0.6); }
      }

      /* ── Pipeline zones (glass buckets) — each panel snaps to dashboard grid columns. ─── */
      /* display:contents so .tk-zones creates NO box / stacking context — each .tk-zone (position:fixed)
         then participates in the body's stacking order and can cross the DoF scrim (3900) on its OWN:
         resting BELOW it (z 800) so the scrim blurs it cleanly, or lifted ABOVE it (z 3950, .tk-sharp)
         to go sharp — while still below the stacks (4000) so an open bin never hides behind a bucket.
         No per-element filter blur → the blur is always the crisp scrim one, never a scuffed filter. */
      .tk-zones { display: contents; }
      .tk-zone { position: fixed; z-index: 800; display: flex; flex-direction: column; pointer-events: auto;
        border-radius: 16px; padding: 12px 14px 14px; color: #fff;
        background: linear-gradient(180deg, rgba(22,26,36,0.5), rgba(12,16,24,0.42));
        -webkit-backdrop-filter: blur(28px) saturate(140%); backdrop-filter: blur(28px) saturate(140%);
        border: 1px solid rgba(255,255,255,0.14);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 18px 42px rgba(0,0,0,0.28);
        transition: border-color .18s ease, box-shadow .18s ease, background .18s ease; }
      /* In focus: lift the bucket above the scrim (sharp). Out of focus it simply rests below the scrim
         and the scrim blurs it — the same crisp depth-of-field whether the bin is closed, a stack is
         fanned, or a drag is in flight (the valid target lifts, the rest stay scrim-blurred). */
      .tk-zone.tk-sharp { z-index: 3950; }
      .tk-zone.is-target { border-color: rgba(125,180,255,0.92);
        background: linear-gradient(180deg, rgba(70,110,190,0.34), rgba(40,70,130,0.26));
        box-shadow: inset 0 0 0 1px rgba(125,180,255,0.5), 0 0 30px rgba(90,150,255,0.42); }
      .tk-zone-hd { display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 2px 4px 11px; font-size: 0.98rem; font-weight: 700; line-height: 1.25; letter-spacing: .01em; color: rgba(255,255,255,0.85); }
      .tk-zone-count { flex: 0 0 auto; font-size: 0.72rem; font-weight: 600; color: rgba(255,255,255,0.62);
        background: rgba(255,255,255,0.10); border-radius: 999px; padding: 1px 8px; }
      .tk-zone-count[hidden] { display: none; }
      .tk-zone-hd-r { display: inline-flex; align-items: center; gap: 8px; flex: 0 0 auto; }
      /* Stage progress bars — 3 segments. On a bucket header (battery ID) and on each ticket (top-right). */
      .tk-bars { display: inline-flex; gap: 3px; align-items: center; }
      .tk-bars-card { position: absolute; top: 11px; right: 13px; z-index: 7; pointer-events: none; }
      .tk-seg { width: 9px; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.20); box-shadow: inset 0 0 0 1px rgba(0,0,0,0.12); }
      .tk-seg.g { background: #2fd16b; } .tk-seg.y { background: #ecc94b; } .tk-seg.r { background: #ef5350; }
      /* Incident date: pinned right under the top-right stage bars, right-aligned to them. A fixed spot that
         never moves with the card's content, in a smaller, quieter font. */
      /* Snug under the bars (bars: top 11 + 4 tall) and tight-leaded so BOTH lines (incident date +
         resolution date/time) sit inside the ${ZCARD_PEEK}px header band a stacked card leaves visible. */
      .tk-date-under { position: absolute; top: 16px; right: 13px; z-index: 7; pointer-events: none;
        font-size: 0.6rem; font-weight: 600; line-height: 1.3; letter-spacing: .02em; white-space: nowrap;
        text-align: right; color: rgba(255,255,255,0.6); }
      /* On the stack/zone cards the client name is a single ellipsised line, leaving the top-right column
         (bars + date) clear so they never collide with a long name. */
      .tk-card .ticket-company, .tk-zcard .ticket-company { -webkit-line-clamp: 1; padding-right: 56px; }
      .tk-card .ticket-body, .tk-zcard .ticket-body, .tk-zfly .ticket-body {
        filter: saturate(calc(1 - (var(--crm-staleness, 0) * .56))) opacity(calc(1 - (var(--crm-staleness, 0) * .22)));
      }
      .tk-card::after, .tk-zcard::after, .tk-zfly::after {
        content: ""; position: absolute; inset: 0; pointer-events: none; border-radius: inherit;
        background: rgba(180,190,205, calc(var(--crm-staleness, 0) * .14));
        mix-blend-mode: screen;
      }
      /* Live config-menu info on the card face (replaces the old "Down <time>" line). Each entered
         field is one compact, ellipsised line: a muted label + the value. */
      .ticket-fields { display: flex; flex-direction: column; gap: 1px; margin-top: 4px; min-height: 0; overflow: hidden; }
      /* Smart-fit: entries WRAP to show their full text by default; fitCardFields() clamps the longest
         one (line by line, gaining an ellipsis) only once the card's content overflows its fixed height. */
      .ticket-field { font-size: 0.75rem; line-height: 1.35; color: rgba(255,255,255,0.82);
        flex: 0 0 auto;   /* keep the natural height — rows must OVERFLOW (measurably), not silently squash */
        white-space: normal; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }
      .ticket-field-l { color: rgba(255,255,255,0.42); font-weight: 600; margin-right: 5px; }
      .ticket-face-badges { margin-top: auto; display: flex; flex-wrap: wrap; gap: 4px; align-items: flex-end; }
      .ticket-face-chip { display: inline-flex; align-items: center; max-width: 100%; min-width: 0; border-radius: 999px;
        padding: 3px 8px; font-size: 0.68rem; line-height: 1.15; font-weight: 800; color: rgba(255,255,255,0.72);
        background: rgba(255,255,255,0.10); border: 1px solid rgba(255,255,255,0.10);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ticket-face-chip[data-tone="warn"] { color: rgba(255,230,180,0.88); background: rgba(234,88,12,0.18); border-color: rgba(234,88,12,0.22); }
      .ticket-face-chip[data-tone="overdue"] { color: rgba(255,210,210,0.9); background: rgba(239,68,68,0.20); border-color: rgba(239,68,68,0.24); }
      /* The description line joins the smart-fit too (scoped to OUR cards — the grid widget keeps its own look). */
      .tk-card .ticket-host, .tk-zcard .ticket-host, .tk-zfly .ticket-host, .td-flyer .ticket-host {
        display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
      /* body no longer clips — an inner .tk-zone-clip clips the scrolling track, so the scrollbar can sit
         in the bucket's right gutter (breathing room) without being cut off. */
      .tk-zone-body { flex: 1 1 auto; min-height: 0; position: relative; overflow: visible; padding: 2px; }
      .tk-zone-clip { position: absolute; inset: 0; overflow: hidden; border-radius: inherit; }
      .tk-zone-track { display: flex; flex-direction: column; align-items: center; width: 100%; min-height: 100%; will-change: transform; }
      /* Bucket scrollbar — same look as the deck's, vertical on the right. */
      .tk-zsb { position: absolute; top: 4px; bottom: 4px; right: 4px; width: 8px; border-radius: 999px;
        background: rgba(255,255,255,0.16); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06);
        opacity: 0; transition: opacity .2s ease; pointer-events: auto; }
      .tk-zsb.is-on { opacity: 1; }
      .tk-zth { position: absolute; left: 0; width: 8px; border-radius: 999px; background: rgba(255,255,255,0.66);
        box-shadow: 0 1px 4px rgba(0,0,0,0.4); cursor: grab; transition: background .15s ease; }
      .tk-zth:hover { background: rgba(255,255,255,0.88); } .tk-zth:active { cursor: grabbing; background: #fff; }
      /* Scroll-edge shadow lives INSIDE each clipped ticket (a child div). The ticket's own overflow:hidden
         + border-radius clip it, so it's a square 90° band through the ticket body but follows the REAL
         rounded corners exactly where the viewport edge nears a corner — and it can never land in the gaps
         between fanned tickets (it's inside a ticket, not the gap). Fully positioned/sized per frame in JS. */
      .tk-edge-shade { position: absolute; pointer-events: none; z-index: 6; }   /* size/offsets set in JS (explicit, so they don't fight the box model) */

      /* A FULL-size ticket card living in a zone — same dimensions + look as a stack card. They
         stack vertically with overlap (position+z-index set in renderZones) so only each card's
         title peeks above the one on top of it. */
      .tk-zcard { box-sizing: border-box; flex: 0 0 auto; position: relative; cursor: grab; color: #fff; display: flex; flex-direction: column; overflow: hidden;
        user-select: none; -webkit-user-select: none; padding: 14px 15px; border-radius: 15px;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.22), 0 14px 18px -14px rgba(0,0,0,0.5);  /* neg. spread → shadow projects only downward, no horizontal bleed to compound across the stack */
        transition: transform .2s cubic-bezier(.2,.8,.3,1), box-shadow .15s ease; }   /* transform → collision/sandwich slide */
      .tk-zcard:hover { box-shadow: inset 0 0 0 9999px rgba(255,255,255,0.12), inset 0 1px 0 rgba(255,255,255,0.34), 0 14px 18px -14px rgba(0,0,0,0.5); }
      .tk-zcard.tk-zdrag { opacity: 0; }                 /* hidden while its floating clone is dragged */
      .tk-zfly { position: fixed; z-index: 9999; pointer-events: none; box-sizing: border-box; color: #fff; display: flex; flex-direction: column; overflow: hidden;
        opacity: 0.72;   /* see-through while dragging so the cards/slots underneath stay visible */
        padding: 14px 15px; border-radius: 15px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.3), 0 24px 52px rgba(0,0,0,0.45);
        transition: transform .3s cubic-bezier(.4,0,.2,1), opacity .3s ease; }
      .tk-card.tk-resolved-pulse, .tk-stack-btn.tk-resolved-pulse { animation: tk-resolved-pulse .82s cubic-bezier(.22,1,.26,1) 1; }
      @keyframes tk-resolved-pulse {
        0% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.22), 0 8px 22px rgba(0,0,0,0.18), 0 0 0 rgba(234,179,8,0); }
        38% { box-shadow: inset 0 0 0 1px rgba(255,245,190,0.42), inset 0 1px 0 rgba(255,255,255,0.34), 0 8px 22px rgba(0,0,0,0.18), 0 0 28px rgba(234,179,8,0.46); }
        100% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.22), 0 8px 22px rgba(0,0,0,0.18), 0 0 0 rgba(234,179,8,0); }
      }

      /* FIX_PASS_2 F2: the guide/flow arrows are gone — the pipeline reads
         through the buckets themselves. */
      /* The round window/page controls at the top — AND their dropdowns (background/effects picker, the
         search popover) and the account button + its menu — stay in PERMANENT focus and take z-precedence
         over EVERYTHING: lifted above the DoF scrim (3900) and the whole ticket UI so nothing ever blurs
         or covers them. (Injected late, so this wins over themes.css / auth-ui.js by order.) */
      .window-control-cluster, .auth-profile-cluster, .dashboard-search-popover { z-index: 4600 !important; }
      /* Every top-menu dropdown (background picker, dash switcher, panel-add, status, account, etc.) is
         PORTALED out of its trigger into the body-level .workspace-menu-overlay-layer, which has
         isolation:isolate — so it's one self-contained stacking context capped at its own z (default 2600),
         BELOW the ticket stacks (4000) and the "+" create button. That's why the "+" showed on top of an
         open dropdown. Lift the whole isolated layer above the stacks and the DoF scrim in a single move;
         its children keep their internal order, so the dropdowns now sit sharp above everything. */
      .workspace-menu-overlay-layer { z-index: 4600 !important; }
      /* "| date of incident" beside the client name in the header — a lighter, non-bold secondary tone. */
      .ticket-date { color: rgba(255,255,255,0.55); font-weight: 400; white-space: nowrap; }
    `;
    document.head.appendChild(style);
  };

  const arrowSvg = (dir) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${
      dir === "right" ? `<polyline points="9 6 15 12 9 18"/>` : `<polyline points="15 6 9 12 15 18"/>`}</svg>`;
  const PLUS_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;
  // Recycle symbol (three chasing arrows) — the trash stack is a recycle bin you can dig back through.
  const RECYCLE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 19H4.815a1.83 1.83 0 0 1-1.57-.881 1.785 1.785 0 0 1-.004-1.784L7.196 9.5"/><path d="M11 19h8.203a1.83 1.83 0 0 0 1.556-.89 1.784 1.784 0 0 0 0-1.775l-1.226-2.12"/><path d="m14 16-3 3 3 3"/><path d="M8.293 13.596 7.196 9.5 3.1 10.598"/><path d="m9.344 5.811 1.093-1.892A1.83 1.83 0 0 1 11.985 3a1.784 1.784 0 0 1 1.546.888l3.943 6.843"/><path d="m13.378 9.633 4.096 1.098 1.097-4.096"/></svg>`;

  // Open/close the recycle bin. Closing it ALSO un-fans the bin's stack — otherwise fanned.trash stays
  // true and the "only one fanned at a time" rule keeps the other stacks' fan buttons hidden.
  const setTrashMode = (on, showEmpty = false) => {
    if (!trashEnabled) return;
    trashMode = on;
    if (on) trashShowEmpty = showEmpty;   // opened deliberately? let an empty bin stay open to show its placeholder
    else { trashShowEmpty = false; if (decks.trash) { fanned.trash = false; decks.trash.scrollX = 0; } }
    decks.right?.action?.classList.toggle("is-active", on);
    render();
  };

  // Right-click menu on a ticket — a small frosted-glass menu (config-menu styling) with plain-text
  // actions: edit (opens the config), appearance (placeholder), delete (animated into the recycle bin).
  let ticketMenu = null;
  const hideTicketMenu = () => { if (ticketMenu) { ticketMenu.remove(); ticketMenu = null; } };
  const showTicketMenu = (t, card, x, y) => {
    hideTicketMenu();
    const trashed = isDeleted(t.id);
    const m = document.createElement("div");
    m.className = "tk-menu";
    // State-aware items: a live ticket can be MOVED TO TRASH (reversible); a trashed one can be
    // RESTORED or DELETED PERMANENTLY (the only truly destructive action → the lone red item).
    m.innerHTML = `<button class="tk-menu-item" data-act="edit">edit</button>` +
      `<button class="tk-menu-item" data-act="appearance">appearance</button>` +
      `<button class="tk-menu-item" data-act="activity">activity</button>` +
      (trashEnabled && trashed
        ? `<button class="tk-menu-item" data-act="restore">restore</button>` +
          `<button class="tk-menu-item tk-menu-danger" data-act="purge">delete permanently</button>`
        : trashEnabled
          ? `<button class="tk-menu-item" data-act="trash">move to trash</button>`
          : "");
    ensureTheater().appendChild(m);
    m.style.left = `${Math.round(Math.min(x, window.innerWidth - m.offsetWidth - 8))}px`;
    m.style.top = `${Math.round(Math.min(y, window.innerHeight - m.offsetHeight - 8))}px`;
    ticketMenu = m;
    const on = (act, fn) => { const b = m.querySelector(`[data-act="${act}"]`); if (b) b.onclick = () => { hideTicketMenu(); fn(); }; };
    on("edit", () => detail?.open(t, card));
    on("appearance", () => showAppearanceMenu(t, x, y));
    on("activity", () => showActivityMenu(t, x, y));
    on("trash", () => deleteToBin(t, card));
    on("restore", () => publicApi?.restore?.(t.id));
    on("purge", () => purgeTicket(t, card));
  };
  const wireContextMenu = (card, t) => card.addEventListener("contextmenu", (e) => { e.preventDefault(); showTicketMenu(t, card, e.clientX, e.clientY); });

  // Appearance: an explicit palette colour (meta.color, persisted) or "match severity" (the default —
  // no override, the card follows its severity colour and tracks live severity changes). Recolours every
  // card instance IN PLACE (no rebuild), the same pattern as setPriority.
  const setAppearance = (t, hex) => {
    setMeta(t.id, { color: hex || "" });
    document.querySelectorAll(`.tk-card[data-id="${cssEsc(t.id)}"], .tk-zcard[data-id="${cssEsc(t.id)}"]`).forEach((c) => {
      c.style.backgroundImage = cardBg(t);
      applyStaleness(c, t);
    });
  };
  // The appearance submenu — same frosted .tk-menu shell: the widget palette as a swatch grid, then a
  // "match severity" check item. The current state reads back: the active swatch rings white, or the
  // check shows when no override is set.
  const showAppearanceMenu = (t, x, y) => {
    hideTicketMenu();
    const cur = metaOf(t.id).color || "";
    const m = document.createElement("div");
    m.className = "tk-menu";
    m.innerHTML =
      `<div class="tk-swatches">${TICKET_COLORS.map((c) =>
        `<button class="tk-swatch${c === cur ? " is-active" : ""}" data-color="${c}" style="background:${c}" aria-label="${c}"></button>`).join("")}</div>` +
      `<button class="tk-menu-item tk-menu-check" data-act="match"><span class="tk-tick">${cur ? "" : "&#10003;"}</span><span>match severity</span></button>`;
    ensureTheater().appendChild(m);
    m.style.left = `${Math.round(Math.min(x, window.innerWidth - m.offsetWidth - 8))}px`;
    m.style.top = `${Math.round(Math.min(y, window.innerHeight - m.offsetHeight - 8))}px`;
    ticketMenu = m;   // reuse the main menu's dismiss wiring (outside press / Escape / wheel)
    // Selections apply LIVE but keep the menu open (so you can try colours) — the active ring / check
    // moves in place. Clicking off, Escape, or scrolling still dismisses it.
    const sync = () => {
      const now = metaOf(t.id).color || "";
      m.querySelectorAll(".tk-swatch").forEach((b) => b.classList.toggle("is-active", b.dataset.color === now));
      const tick = m.querySelector(".tk-tick"); if (tick) tick.innerHTML = now ? "" : "&#10003;";
    };
    m.querySelectorAll(".tk-swatch").forEach((b) => { b.onclick = () => { setAppearance(t, b.dataset.color); sync(); }; });
    const mb = m.querySelector('[data-act="match"]'); if (mb) mb.onclick = () => { setAppearance(t, ""); sync(); };
  };

  // Activity view: the ticket's full trail — the STORE's history (created / edited / resolved / …,
  // stamped with who) merged with the CLIENT trail (stage moves, trash/restore, severity), newest first.
  const showActivityMenu = (t, x, y) => {
    hideTicketMenu();
    const when = (ms) => { try { return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return ""; } };
    const entries = [
      ...((t.history || []).map((h) => ({ at: Date.parse(h.at) || 0, text: h.detail || h.action || "", by: h.by || "" }))),
      ...((metaOf(t.id).activity || []).map((a) => ({ at: a.at || 0, text: a.text || "", by: "" }))),
    ].filter((e) => e.text).sort((a, b) => b.at - a.at);
    const m = document.createElement("div");
    m.className = "tk-menu tk-activity";
    m.innerHTML = `<div class="tk-act-hd">Activity — ${esc(titleOf(t))}</div>` +
      (entries.length
        ? entries.map((e) => `<div class="tk-act-row"><span class="tk-act-when">${esc(when(e.at))}</span><span class="tk-act-text">${esc(e.text)}${e.by ? ` <span class="tk-act-by">— ${esc(e.by)}</span>` : ""}</span></div>`).join("")
        : `<div class="tk-act-row tk-act-none">No activity yet</div>`);
    ensureTheater().appendChild(m);
    m.style.left = `${Math.round(Math.min(x, window.innerWidth - m.offsetWidth - 8))}px`;
    m.style.top = `${Math.round(Math.min(y, window.innerHeight - m.offsetHeight - 8))}px`;
    ticketMenu = m;   // same dismiss wiring: outside press / Escape (wheel INSIDE it scrolls the list)
  };

  // Wipe every CLIENT-SIDE trace of a ticket id — stage, stage-order, trash flag, title/date/desc
  // overrides, its blank-ticket colour, and its slot in every deck order. Used by "delete permanently"
  // so a purged ticket leaves nothing behind in localStorage.
  const forgetClientState = (id) => {
    setDeleted(id, false); setStage(id, null); setStageAt(id, null);
    if (metaMap[id]) { delete metaMap[id]; try { localStorage.setItem(META_STORE, JSON.stringify(metaMap)); } catch {} }
    if (colorMap[id]) { delete colorMap[id]; try { localStorage.setItem(COLOR_STORE, JSON.stringify(colorMap)); } catch {} }
    DECK_SIDES.forEach((s) => { const d = decks[s]; if (d && Array.isArray(d.order)) { d.order = d.order.filter((x) => x !== id); saveOrder(s); } });
  };
  // Permanently delete a trashed ticket: implode the card into nothing, then hard-remove it from the
  // backend store AND forget all its client state, so it can never come back.
  const purgeTicket = (t, card) => {
    const doPurge = () => {
      forgetClientState(t.id);
      try { source?.remove?.(t.id); } catch {}
      tickets = tickets.filter((x) => x.id !== t.id);   // drop locally so the re-render is instant
      render();
    };
    const r = card && card.isConnected ? card.getBoundingClientRect() : null;
    if (!r || r.width < 4) { doPurge(); return; }
    card.style.opacity = "0";
    const clone = document.createElement("div");
    clone.className = "tk-zfly";
    clone.style.cssText = `left:${r.left}px; top:${r.top}px; width:${Math.round(r.width)}px; height:${Math.round(r.height)}px; transform-origin: center center; z-index: 6000; opacity: 1; transition: transform .3s cubic-bezier(.4,0,1,1), opacity .3s ease;`;
    clone.style.backgroundColor = baseColor();
    clone.style.backgroundImage = cardBg(t);
    applyStaleness(clone, t);
    clone.innerHTML = cardInner(t);
    ensureTheater().appendChild(clone);
    fitCardFields(clone);
    requestAnimationFrame(() => { clone.style.transform = "scale(0.12)"; clone.style.opacity = "0"; });
    setTimeout(() => { clone.remove(); doPurge(); }, 320);
  };

  // Fly a clone of a ticket from `fromRect` into its freshly-rendered resting card `destEl`, then run
  // onLanded. (destEl must already exist — the target deck/bucket has been rendered.)
  const flyCloneTo = (t, fromRect, destEl, onLanded) => {
    const to = (destEl && destEl.isConnected) ? destEl.getBoundingClientRect() : null;
    if (!fromRect || !to || to.width < 4) { if (onLanded) setTimeout(onLanded, 260); return; }
    destEl.style.opacity = "0";
    const clone = document.createElement("div");
    clone.className = "tk-zfly";
    clone.style.cssText = `left:${fromRect.left}px; top:${fromRect.top}px; width:${Math.round(fromRect.width)}px; height:${Math.round(fromRect.height)}px; transform-origin: top left; z-index: 6000; opacity: 1; transition: transform .46s cubic-bezier(.4,0,.2,1);`;
    clone.style.backgroundColor = baseColor();
    clone.style.backgroundImage = cardBg(t);
    applyStaleness(clone, t);
    clone.innerHTML = cardInner(t);
    ensureTheater().appendChild(clone);
    fitCardFields(clone);
    requestAnimationFrame(() => { clone.style.transform = `translate(${Math.round(to.left - fromRect.left)}px, ${Math.round(to.top - fromRect.top)}px) scale(${(to.width / fromRect.width).toFixed(4)}, ${(to.height / fromRect.height).toFixed(4)})`; });
    setTimeout(() => { clone.remove(); if (destEl.isConnected) destEl.style.opacity = ""; if (onLanded) onLanded(); }, 470);
  };
  const pulseResolvedPile = (id) => {
    if (!resolvedPulse || !rightDeckEnabled) return;
    requestAnimationFrame(() => {
      const target = (id && decks.right?.box?.querySelector(`.tk-card[data-id="${cssEsc(id)}"]`)) || decks.right?.box?.querySelector(".tk-card") || decks.right?.action;
      if (!target) return;
      target.classList.remove("tk-resolved-pulse");
      void target.offsetWidth;
      target.classList.add("tk-resolved-pulse");
      setTimeout(() => target.classList.remove("tk-resolved-pulse"), 900);
    });
  };
  // A corner stack (left/right) under the cursor — fanned OR closed — for dragging a card OUT of the bin
  // back into a stack. Uses the visible cards' bounds so a closed corner pile counts too.
  const overCornerStack = (x, y) => CORNER_SIDES.find((s) => {
    const r = deckCardsRect(s) || actionRect(s);   // empty stacks have no cards → the action button marks the corner
    return !!r && x >= r.left - 16 && x <= r.right + 16 && y >= r.top - 16 && y <= r.bottom + 16;
  }) || null;
  // Which corner stack may a trashed ticket be dragged back INTO: everything EXCEPT a literally-resolved
  // ticket may enter the LEFT (active) stack; only a resolved one may enter the RIGHT (resolved) stack.
  const stackEligible = (side, t) => {
    const resolved = isResolved(t);
    return side === "left" ? !resolved || !rightDeckEnabled : side === "right" ? rightDeckEnabled && resolved : false;
  };
  // The corner stack under the cursor that this ticket is ALLOWED to restore into (eligibility-gated);
  // hovering/dropping over an ineligible stack returns null → the drag springs back to the bin.
  const eligibleCornerStack = (x, y, t) => { const s = overCornerStack(x, y); return s && stackEligible(s, t) ? s : null; };
  // A ticket ENTERING a corner pile (created via "+", dropped back from a bucket, resolved, tunneled
  // home from the grid, deleted into the bin) always lands as the pile's TOP card: front of the order
  // = the z-topmost card of the closed stack. (A drop into a FANNED row still picks the cursor slot.)
  const deckToTop = (side, id) => {
    const deck = decks[side]; if (!deck || !id) return;
    const base = (deck.order && deck.order.length) ? deck.order : deck.cards.map((c) => c.dataset.id);
    deck.order = [id, ...base.filter((x) => x && x !== id)];
    saveOrder(side);
  };
  // Restore a deleted ticket by dragging it onto a corner stack: un-delete and send it into the stack it
  // was dropped on (already eligibility-checked), inserted at the cursor slot if that stack is fanned,
  // else at the TOP (front card). Then slide the clone home.
  const restoreToDeck = (t, x, fromRect, side) => {
    setDeleted(t.id, false);
    logActivity(t.id, "Restored from the trash");
    const fd = side || deckSideFor(t);                             // the stack it was dropped on, else its home by state
    const deck = decks[fd];
    const ids = deck.cards.map((c) => c.dataset.id).filter((id) => id && id !== t.id);
    ids.splice(fanned[fd] ? clamp(fanInsertIndex(fd, x), 0, ids.length) : 0, 0, t.id);
    deck.order = ids; saveOrder(fd);
    setStage(t.id, null); setStageAt(t.id, null);
    render();
    flyCloneTo(t, fromRect, deck.box.querySelector(`.tk-card[data-id="${cssEsc(t.id)}"]`));
  };
  const markDeleted = (t) => {
    setMeta(t.id, { delStage: stageOf(t.id) || "" });
    logActivity(t.id, "Moved to trash");
    setDeleted(t.id, true);
    // Newest deletion goes to the TOP of the pile (front card, index 0) — not sorted to the bottom by age.
    if (decks.trash) deckToTop("trash", t.id);
  };
  // Delete animation: the trash pile appears with the ticket as its NEW top card, a clone slides from the
  // drag point and settles into that card (it "incorporates" as a real member) while the bin's blue ring
  // fills. If the bin wasn't already open, the pile then closes — leaving the ticket on top for next time.
  const flyIntoBin = (t, fromRect) => {
    const wasOpen = trashMode;
    markDeleted(t);
    setTrashMode(true);                                   // render the (closed) pile with t as its front card
    const btn = decks.right?.action;
    if (btn) { btn.classList.remove("tk-suck-done"); btn.classList.add("tk-suck"); }
    flyCloneTo(t, fromRect, decks.trash?.box?.querySelector(`.tk-card[data-id="${cssEsc(t.id)}"]`), () => {
      if (btn) { btn.classList.remove("tk-suck"); btn.classList.add("tk-suck-done"); setTimeout(() => btn.classList.remove("tk-suck-done"), 320); }
      if (!wasOpen) setTimeout(() => setTrashMode(false), 380);   // incorporated → let the stack close
    });
  };
  const deleteToBin = (t, card) => flyIntoBin(t, card.getBoundingClientRect());   // right-click menu delete
  // Delete by DRAGGING onto the bin (icon or open pile). Shared by the deck + bucket drag handlers.
  const dropTicketToTrash = (t, fromRect) => { stopTrashRing(); flyIntoBin(t, fromRect); };

  // ── Drag-into-bin targeting + the "hold on the icon to open it" ring ──────────
  const overTrashBtn = (x, y) => { const b = decks.right?.action; if (!b) return false; const r = b.getBoundingClientRect();
    const pad = dragActive ? 24 : 7;   // generous catch area while dragging — esp. for an EMPTY bin, whose only drop target is this icon
    return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad; };
  const overOpenTrash = (x, y) => trashMode && !!decks.trash?.cards.some((c) => { const r = c.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; });
  const overTrashTarget = (x, y) => overTrashBtn(x, y) || overOpenTrash(x, y);
  // Resting the cursor on the CLOSED bin icon while dragging draws a blue ring around it; when the ring
  // completes its trip the bin opens automatically so you can drop into it.
  let ringTimer = 0;
  const startTrashRing = () => {
    const b = decks.right?.action; if (!b || trashMode || b.classList.contains("tk-ringing")) return;
    b.classList.add("tk-ringing");
    ringTimer = setTimeout(() => { b.classList.remove("tk-ringing"); ringTimer = 0; setTrashMode(true, true); }, 720);   // showEmpty: an EMPTY bin opens to its placeholder (a big drop target) instead of auto-closing
  };
  function stopTrashRing() { const b = decks.right?.action; if (b) b.classList.remove("tk-ringing"); if (ringTimer) { clearTimeout(ringTimer); ringTimer = 0; } }
  // While dragging: ring the closed bin when hovering it; report whether the bin is the drag target.
  const trashDragMove = (x, y) => { const over = overTrashTarget(x, y); if (over && !trashMode && overTrashBtn(x, y)) startTrashRing(); else stopTrashRing(); return over; };

  const ensureRoot = () => {
    if (root) return;
    ensureStyles();
    ensureTheater();
    root = document.createElement("div");
    root.className = "tk-stacks";
    // Depth-of-field scrim — a theater-level layer (z 3900), NOT a child of .tk-stacks, so it sits below
    // the stacks (which stay sharp) yet above the resting buckets/dashboard (which it blurs).
    stackScrim = document.createElement("div"); stackScrim.className = "tk-scrim"; theater.appendChild(stackScrim);
    for (const side of CONTROL_SIDES) {
      const box = document.createElement("div");
      box.className = `tk-deck tk-deck-${side}`;
      const track = document.createElement("div");   // holds the cards; scroll = ONE rigid transform on this
      track.className = "tk-track";
      box.appendChild(track);
      const arrow = document.createElement("button");
      arrow.className = "tk-arrow"; arrow.type = "button";
      arrow.setAttribute("aria-label", side === "left" ? deckCopy.leftFanAria : deckCopy.rightFanAria);
      arrow.addEventListener("click", () => toggleFan(side));
      const bar = document.createElement("div"); bar.className = "tk-bar";
      const thumb = document.createElement("div"); thumb.className = "tk-thumb";
      bar.appendChild(thumb);
      box.appendChild(arrow); box.appendChild(bar);
      wireThumb(side, thumb);
      // Action button above the stack: LEFT "+" creates a ticket; RIGHT trash toggles the stack
      // between resolved and deleted. Lives on root (not the deck box) so it stays visible when
      // the deck is empty (the box gets display:none via .is-empty).
      const action = document.createElement("button");
      action.className = "tk-stack-btn"; action.type = "button";
      if (side === "left") {
        action.setAttribute("aria-label", deckCopy.createAria);
        action.innerHTML = PLUS_SVG;
        action.hidden = !createEnabled;
        if (createEnabled) action.addEventListener("click", openCreate);
      } else {
        action.setAttribute("aria-label", deckCopy.trashAria);
        action.title = deckCopy.trashTitle;
        action.innerHTML = RECYCLE_SVG + '<svg class="tk-ring" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="20"/></svg>';
        action.hidden = !trashEnabled;
        if (trashEnabled) action.addEventListener("click", () => setTrashMode(!trashMode, true));
      }
      // FIX_PASS_2 F2: no empty-stack placeholder — an empty deck is the action button alone.
      root.appendChild(box); root.appendChild(action);
      decks[side] = { box, track, arrow, bar, thumb, action, cards: [], scrollX: 0, contentW: 0, viewW: 0, order: loadOrder(side) };
    }
    // The recycle bin: a THIRD stack on the right, lifted above the trash icon (positioned in render),
    // shown only in trash mode. Same machinery as the right deck (fans left) — no action button of its own.
    if (trashEnabled) {
      const box = document.createElement("div");
      box.className = "tk-deck tk-deck-trash";
      const track = document.createElement("div"); track.className = "tk-track"; box.appendChild(track);
      const arrow = document.createElement("button"); arrow.className = "tk-arrow"; arrow.type = "button";
      arrow.setAttribute("aria-label", deckCopy.trashFanAria);
      arrow.addEventListener("click", () => toggleFan("trash"));
      const bar = document.createElement("div"); bar.className = "tk-bar";
      const thumb = document.createElement("div"); thumb.className = "tk-thumb"; bar.appendChild(thumb);
      box.appendChild(arrow); box.appendChild(bar);
      wireThumb("trash", thumb);
      // FIX_PASS_2 F2: no empty-bin placeholder — the bin icon is the drop target.
      root.appendChild(box);
      decks.trash = { box, track, arrow, bar, thumb, action: null, cards: [], scrollX: 0, contentW: 0, viewW: 0, order: loadOrder("trash") };
    }
    theater.appendChild(root);
    window.addEventListener("resize", () => { matchCardSize(); sizeRoot(); syncDropFloor(); DECK_SIDES.forEach(layout); });
    // Watch native widget drags from the outside so a grid ticket can be dropped back
    // into its stack. Capture phase → these run before the native drag's own document
    // handlers, letting us read the under-cursor rect before it commits.
    document.addEventListener("pointermove", onDragWatchMove, true);
    document.addEventListener("pointerup", onDragWatchUp, true);
    document.addEventListener("pointercancel", resetDragWatch, true);
    // Dismiss the right-click menu on an outside press, Escape, or scroll.
    document.addEventListener("pointerdown", (e) => { if (ticketMenu && !ticketMenu.contains(e.target)) hideTicketMenu(); }, true);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { hideTicketMenu(); if (trashMode) setTrashMode(false); } });
    window.addEventListener("wheel", (e) => { if (!ticketMenu || !ticketMenu.contains(e.target)) hideTicketMenu(); }, true);   // wheel INSIDE a menu (activity list) scrolls it instead
    // Scroll a fanned deck whenever the cursor is anywhere over its card band — INCLUDING the gaps
    // between fanned cards. The deck box is pointer-events:none, so a wheel in a gap never reaches it;
    // routing by cursor position here catches those gaps (and replaces the old per-box wheel handlers).
    window.addEventListener("wheel", (e) => {
      if (dragActive) return;                                   // drags route their own wheel (onDragWheel)
      const side = DECK_SIDES.find((s) => fanned[s]); if (!side) return;
      const d = decks[side]; if (!d || d.contentW <= d.viewW) return;
      const r = deckCardsRect(side); if (!r) return;
      const pad = 18;
      if (e.clientX >= r.left - pad && e.clientX <= r.right + pad && e.clientY >= r.top - pad && e.clientY <= r.bottom + pad) onWheel(side, e);
    }, { passive: false });
    // Clicking anywhere OFF the open bin (its stack or its icon) closes it.
    document.addEventListener("click", (e) => {
      if (!trashMode || dragActive) return;
      // Test the event's propagation PATH, not the live e.target: clicking the bin's fan arrow re-runs
      // layout() mid-dispatch, which rewrites the arrow's inner <svg> — orphaning the very node that was
      // clicked. By the time this bubbles up, decks.trash.box.contains(e.target) would be false and the
      // bin would wrongly close. composedPath() is captured at dispatch and keeps the real ancestors.
      const path = (e.composedPath && e.composedPath()) || [];
      const hit = (el) => !!el && (path.includes(el) || el.contains(e.target));
      // Clicking the bin, OR either corner stack (so you can fan/interact with one while the bin is
      // open — they can be out together), keeps it open. Un-fanning a corner still closes it (toggleFan).
      if (hit(decks.trash?.box) || hit(decks.right?.action) || hit(decks.left?.box) || hit(decks.right?.box)) return;
      setTrashMode(false);
    });
    // Co-focus the buckets when the cursor drifts up toward them off a fanned stack.
    document.addEventListener("pointermove", onFanHover);
  };

  const sizeRoot = () => { if (root) root.style.height = `${CARD_H + MARGIN * 2 + 34}px`; };

  const fanViewW = () => Math.max(CARD_W, window.innerWidth - MARGIN * 2 - (CARD_W + 78));  // leave room for the opposite stack

  // Which stacks are in focus — any fanned deck, PLUS the recycle bin whenever it's open. Focused decks
  // stack ABOVE the idle ones (z 3 vs 1) and stay sharp; the idle ones blur via their OWN filter (the
  // whole .tk-stacks now sits above the scrim, so the scrim can't do it for us). A fanned stack + an
  // open bin are BOTH sharp at once.
  const isFocused = (s) => !!(decks[s] && (fanned[s] || (s === "trash" && trashMode && (decks.trash.cards.length || trashShowEmpty))));
  const updateStackFocus = () => {
    const focus = {}; let any = false;
    DECK_SIDES.forEach((s) => { const d = decks[s]; if (!d) return; focus[s] = isFocused(s); if (focus[s]) any = true; });
    DECK_SIDES.forEach((s) => { const d = decks[s]; if (!d) return;
      const dim = any && !focus[s];
      d.box.style.zIndex = focus[s] ? "3" : "1";
      d.box.style.filter = dim ? "blur(4px)" : "";   // idle decks go soft while another is focused
    });
    if (stackScrim) {
      stackScrim.style.backdropFilter = stackScrim.style.webkitBackdropFilter = any ? "blur(4px)" : "blur(0px)";
      // While the bin is open it's MODAL: the scrim eats clicks so the blurred dashboard isn't
      // interactable. Clicking the scrim still bubbles to the "click off the bin closes it" handler.
      stackScrim.style.pointerEvents = trashMode ? "auto" : "none";
    }
    if (!DECK_SIDES.some((s) => fanned[s])) bucketsFocused = false;   // no fanned stack → buckets can't be co-focused
    applyBucketFocus();
  };

  // ── Cursor-driven co-focus of the buckets (+ the flow arrows) while a stack is fanned ───────────────
  // Moving the cursor UP off the fanned stack toward the buckets lifts them AND the flow arrows into
  // focus alongside the stack; moving back down to the stack — or toward the +/bin buttons — drops them
  // back out. Focus is a clean z-flip across the scrim, PER bucket: a sharp bucket lifts above the scrim
  // (.tk-sharp), an out-of-focus one rests below it and the scrim blurs it — always the crisp scrim blur,
  // never a filter. Gaps between fanned cards count as "on the stack", so hovering one doesn't pull them in.
  let bucketsFocused = false;
  const setBucketSharp = (fn) => STAGES.forEach((s, i) => zoneBody[s.key]?.parentElement?.classList.toggle("tk-sharp", fn(i)));
  const setArrowSharp = (fn) => flowSvgs.forEach((svg, i) => svg.classList.toggle("tk-cofocus", fn(i)));   // per-arrow lift across the scrim
  const applyBucketFocus = () => {
    if (!zonesEnabled) return;
    if (dragActive) return;   // during a drag, focusDropTargets owns the per-bucket focus
    // Co-focus: lift ALL buckets/arrows above the scrim (sharp) ONLY while the cursor is drifting up to
    // co-focus them; otherwise leave them below it so the SCRIM blurs them — the crisp un-fanned-bin look.
    const sharp = DECK_SIDES.some((s) => fanned[s]) && bucketsFocused;
    setBucketSharp(() => sharp);
    setArrowSharp(() => sharp);
  };
  const setBucketsFocus = (on) => { if (on !== bucketsFocused) { bucketsFocused = on; applyBucketFocus(); } };
  const deckCardsRect = (side) => {
    const d = decks[side]; if (!d || !d.cards.length) return null;
    let L = Infinity, T = Infinity, R = -Infinity, B = -Infinity;
    d.cards.forEach((c) => { const r = c.getBoundingClientRect(); if (r.width < 1) return; L = Math.min(L, r.left); T = Math.min(T, r.top); R = Math.max(R, r.right); B = Math.max(B, r.bottom); });
    return L === Infinity ? null : { left: L, top: T, right: R, bottom: B };
  };
  // The drop region of an EMPTY corner stack = its "add here" placeholder box (shown only when the stack
  // has no cards). Lets a trashed card be dragged back into a stack that's currently empty.
  const actionRect = (side) => { const el = decks[side]?.action; return el && el.isConnected && !el.hidden ? el.getBoundingClientRect() : null; };
  // Highlight the corner stack (its cards' box AND its empty placeholder) a trashed card would restore
  // into, so the eligible drop target reads clearly while dragging out of the bin.
  let stackDropSide = null;
  const setStackDrop = (side) => {
    if (side === stackDropSide) return;
    CORNER_SIDES.forEach((s) => { decks[s]?.box?.classList.remove("tk-drop-ok"); });
    stackDropSide = side || null;
    if (side) { decks[side]?.box?.classList.add("tk-drop-ok"); }
  };
  const nearRect = (x, y, r, pad) => !!r && x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
  const inFocusDeadzone = (x, y) => {
    if (nearRect(x, y, decks.left?.action?.getBoundingClientRect(), 18)) return true;    // the "+" button
    if (nearRect(x, y, decks.right?.action?.getBoundingClientRect(), 18)) return true;   // the bin icon
    if (trashMode) {   // the empty gap between the lifted bin stack and its icon
      const tr = deckCardsRect("trash"), ir = decks.right?.action?.getBoundingClientRect();
      if (tr && ir && x >= Math.min(tr.left, ir.left) - 18 && x <= Math.max(tr.right, ir.right) + 18 && y >= tr.bottom - 10 && y <= ir.bottom + 10) return true;
    }
    return false;
  };
  // Topmost ticket card under the cursor that lives in a FANNED deck (any of them), + its ticket.
  const hoveredFanCard = (x, y) => {
    const card = document.elementFromPoint(x, y)?.closest?.(".tk-card");
    if (!card) return null;
    const side = DECK_SIDES.find((s) => fanned[s] && decks[s]?.box?.contains(card));
    return side ? { side, t: tickets.find((tk) => tk.id === card.dataset.id) } : null;
  };
  // Steady blue outline on every bucket THIS ticket may legally land in (no proximity fade — it's a hover
  // preview, not a live drag). Pairs with focusDropTargets, which also lifts them into focus + the arrows.
  const hoverHighlight = (from, t) => STAGES.forEach((s, i) => { const p = zoneBody[s.key]?.parentElement; if (!p) return;
    if (i !== from && canAdvance(from, i, t)) { p.style.borderColor = "rgba(125,180,255,0.85)"; p.style.boxShadow = `inset 0 0 0 1px rgba(125,180,255,0.45), 0 0 30px rgba(90,150,255,0.4), ${baseZoneShadow}`; }
    else clearGlow(p); });
  let hoverPrev = null;   // "side:id" of the ticket currently previewed on hover (dedupe re-applies)
  const showHoverPreview = (side, t) => {
    const key = `${side}:${t.id}`; if (hoverPrev === key) return;
    hoverPrev = key; const from = stackPos(side);
    focusDropTargets(from, t);   // eligible buckets + their arrow chain go sharp
    hoverHighlight(from, t);     // …and the eligible buckets get the blue outline
  };
  const clearHoverPreview = () => { if (!hoverPrev) return; hoverPrev = null; clearDropFocus(); clearZoneHighlight(); };
  const onFanHover = (e) => {
    if (!zonesEnabled) return;
    if (dragActive) return;                        // drags do their own targeting
    const side = DECK_SIDES.find((s) => fanned[s]);
    const sr = side ? deckCardsRect(side) : null;
    if (!sr || inFocusDeadzone(e.clientX, e.clientY)) { clearHoverPreview(); setBucketsFocus(false); return; }   // nothing fanned / heading to +/bin
    // Hovering a specific card → auto-focus the buckets THAT ticket can enter (+ blue outline + arrows).
    // EXCEPT trashed cards: a ticket in the bin doesn't preview eligible buckets on hover.
    const hov = hoveredFanCard(e.clientX, e.clientY);
    if (hov && hov.t) { setBucketsFocus(false); if (hov.side === "trash") { clearHoverPreview(); return; } showHoverPreview(hov.side, hov.t); return; }
    // Deadzone: between cards but still within the fanned row's band → HOLD the last ticket's preview. The
    // focus only changes when the cursor reaches a NEW ticket, not while crossing the gaps between them.
    // Trash rows never preview (kept focus-free), so there's nothing to hold there.
    if (side !== "trash" && hoverPrev &&
        e.clientY >= sr.top && e.clientY <= sr.bottom + 12 &&
        e.clientX >= sr.left - 12 && e.clientX <= sr.right + 12) return;
    clearHoverPreview();
    setBucketsFocus(side !== "trash" && e.clientY < sr.top - 10);   // above a fanned (non-trash) stack → co-focus ALL buckets
  };

  const layout = (side) => {
    const deck = decks[side];
    if (!deck) return;
    const cards = deck.cards, n = cards.length;
    deck.box.classList.toggle("is-empty", n === 0);
    deck.box.classList.toggle("is-fanned", fanned[side] && n > 0);
    const open = fanned[side];
    const step = CARD_W + GAP_FAN;
    const viewW = fanViewW();
    const contentW = open ? (CARD_W + step * (n - 1)) : CARD_W;
    deck.viewW = viewW; deck.contentW = contentW;
    const scrollMin = Math.min(0, viewW - contentW);
    deck.scrollX = clamp(deck.scrollX, scrollMin, 0);
    cards.forEach((c, i) => place(c, side, i, open, step));
    setTrack(side);     // apply scroll to the track (cards hold only their slot transform)
    placeArrow(side);   // horizontal position follows the fan edge (updated live during scroll too)
    deck.arrow.style.bottom = `${MARGIN + CARD_H / 2 - 17}px`;
    deck.arrow.innerHTML = arrowSvg(side === "left" ? (open ? "left" : "right") : (open ? "right" : "left"));
    // Only the two CORNERS are mutually exclusive; the trash fans independently and can be open alongside
    // one of them. So hide a corner's fan arrow only while the OTHER corner is fanned (and this one isn't);
    // the trash arrow shows whenever the bin holds ≥2 cards, regardless of a fanned corner.
    const otherCornerFanned = side !== "trash" && CORNER_SIDES.some((o) => o !== side && decks[o] && fanned[o]);
    deck.arrow.classList.toggle("is-hidden", n <= 1 || (otherCornerFanned && !fanned[side]));
    deck.arrow.style.zIndex = "5000";
    // Focus (which deck rides above the depth-of-field scrim, which are behind it) is set globally.
    updateStackFocus();
    // create/trash button: centred above the stack's top card (independent of fan state)
    if (deck.action) {
      deck.action.style[side === "left" ? "left" : "right"] = `${MARGIN + CARD_W / 2 - 17}px`;
      deck.action.style.bottom = `${MARGIN + CARD_H + 18}px`;
      if (side === "left") deck.action.hidden = !createEnabled;
    }
    // Full-width scrollbar across the bottom, only when the fan overflows.
    const overflow = open && contentW > viewW + 1;
    deck.bar.classList.toggle("is-on", overflow);
    if (overflow) {
      const barW = window.innerWidth - MARGIN * 2;
      deck.bar.style.bottom = `${MARGIN - 12}px`;
      deck.bar.style.width = `${barW}px`;
      deck.bar.style[side === "left" ? "left" : "right"] = `${MARGIN}px`;
      deck.bar.style[side === "left" ? "right" : "left"] = "auto";
      const thumbW = Math.max(36, barW * (viewW / contentW));
      let frac = scrollMin ? clamp(deck.scrollX, scrollMin, 0) / scrollMin : 0;   // 0..1
      if (side !== "left") frac = 1 - frac;   // mirror for the left-fanning decks (right/trash)
      deck.thumb.style.width = `${thumbW}px`;
      deck.thumb.style.left = `${frac * (barW - thumbW)}px`;
      deck.thumb.style.right = "auto";
    }
    updateDeckEdges();   // refresh the screen-edge scroll shadows after a relayout / fan toggle
  };

  // The track carries scroll; each card's transform is its SLOT only (so a reorder's .42s collision
  // animates independently of the rigid scroll). For left the track shifts by scrollX, for right by -scrollX.
  const setTrack = (side) => { const deck = decks[side]; if (deck && deck.track) deck.track.style.transform = `translateX(${side === "left" ? deck.scrollX : -deck.scrollX}px)`; };
  const place = (card, side, i, open, step) => {
    let tx, ty, rot;
    if (open) { tx = i * step; ty = 0; rot = 0; }   // slot position only — scroll is applied to the track
    else { const d = Math.min(i, 6); tx = d * 3; ty = -d * 4; rot = (i % 2 ? 1 : -1) * Math.min(i, 3) * 1.6; }
    if (side !== "left") { tx = -tx; rot = -rot; }   // right + trash decks fan LEFT
    card._tx = tx; card._ty = ty; card._rot = rot;
    // Leave the dragged card alone — keep its on-top z-index (9999, set at drag start) and
    // its follow transform. Otherwise a reorder re-layout drops it BEHIND its neighbours, so
    // it looks frozen (it's still following the cursor, just hidden) until release.
    if (!card.classList.contains("tk-dragging")) {
      card.style.zIndex = String((open ? 3000 : 500) - i);   // a fanned stack rides above the closed one
      card.style.transform = `translate(${tx}px, ${ty}px) rotate(${rot}deg)`;
    }
  };

  // While a card is dragged OUT of the fan (lifted toward a bucket), re-flow the cards left behind so
  // they slide together and close the hole it left — a smooth collision, not a frozen gap. The dragged
  // card is skipped (it follows the cursor); the others fill consecutive slots via their .42s transition.
  const closeFanRanks = (side, dragged) => {
    const deck = decks[side]; if (!deck) return;
    const step = CARD_W + GAP_FAN;
    let slot = 0;
    deck.cards.forEach((c) => {
      if (c === dragged) return;
      let tx = slot * step; if (side !== "left") tx = -tx;   // slot only — track carries scroll (right/trash fan left)
      c._tx = tx; c._ty = 0; c._rot = 0;
      c.style.zIndex = String(3000 - slot);
      c.style.transform = `translate(${tx}px, 0) rotate(0deg)`;
      slot++;
    });
  };

  // Mirror of closeFanRanks for an INCOMING card (one dragged from a bucket toward the fanned
  // row): open an empty slot at `gapIdx` so the cards at/after it slide one step over (the same
  // .42s collision) to show exactly where the ticket would land. layout(side) closes it again.
  const previewFanGap = (side, gapIdx) => {
    const deck = decks[side]; if (!deck || !fanned[side]) return;
    const step = CARD_W + GAP_FAN;
    deck.cards.forEach((c, i) => {
      const slot = i < gapIdx ? i : i + 1;   // cards at/after the gap shove one slot over
      let tx = slot * step; if (side === "right") tx = -tx;
      c._tx = tx; c._ty = 0; c._rot = 0;
      c.style.zIndex = String(3000 - slot);
      c.style.transform = `translate(${tx}px, 0) rotate(0deg)`;
    });
  };
  // The slot a cursor at viewport-x would insert into within the fanned row (0..n; n = append).
  // Inverts the layout maths in place(): left slots grow rightward from MARGIN, right slots grow
  // leftward from the deck's right edge; both ride the track scroll (deck.scrollX).
  const fanInsertIndex = (side, x) => {
    const deck = decks[side]; const n = deck ? deck.cards.length : 0; if (!n) return 0;
    const step = CARD_W + GAP_FAN;
    const idx = side === "left"
      ? Math.round((x - deck.scrollX - MARGIN - CARD_W / 2) / step)
      : Math.round((window.innerWidth - MARGIN - deck.scrollX - CARD_W / 2 - x) / step);
    return clamp(idx, 0, n);
  };

  const setFan = (side, open) => {
    if (!decks[side]) return;
    open = !!open;
    fanned[side] = open;
    if (!open) decks[side].scrollX = 0;
    // The two CORNERS are mutually exclusive, but the trash can fan out ALONGSIDE a corner (so you can
    // drag cards between them). Opening a corner collapses the other corner; opening the trash collapses
    // nothing; and opening a corner leaves a fanned trash open.
    if (open && side !== "trash") CORNER_SIDES.forEach((o) => { if (o !== side && decks[o] && fanned[o]) { fanned[o] = false; decks[o].scrollX = 0; } });
    // Collapsing a CORNER closes the bin too (they came into focus together); collapsing the trash leaves
    // the corner alone.
    if (!open && side !== "trash" && trashMode) { setTrashMode(false); return; }   // setTrashMode() re-renders
    DECK_SIDES.forEach(layout);   // re-lay ALL: each arrow's z + dimming depend on which deck is fanned
    trackFanEdges();               // edge shadows appear as the cards animate out (not on next scroll)
  };
  const toggleFan = (side) => setFan(side, !fanned[side]);

  // ── Overscroll: Apple-style rubber-band at the ends of a fanned scroll ──────────
  const MAX_OVER = 92;                                   // furthest the fan can be pulled past an end
  const scrollMinOf = (deck) => Math.min(0, deck.viewW - deck.contentW);
  const barWidth = () => window.innerWidth - MARGIN * 2;
  // Past a bound, the shown overscroll asymptotes to ±MAX_OVER (diminishing resistance).
  const damp = (x, min) => {
    if (x > 0) return MAX_OVER * Math.tanh(x / MAX_OVER);
    if (x < min) return min - MAX_OVER * Math.tanh((min - x) / MAX_OVER);
    return x;
  };
  // The collapse arrow rides the open-edge ticket while it's on-screen, and clamps to the screen
  // edge once that edge scrolls off. It tracks RIGIDLY (its left/right transition is turned off
  // during scroll — see runScroll/wireThumb) so it locks to the ticket instead of floating.
  const placeArrow = (side) => {
    const deck = decks[side]; if (!deck) return;
    const screenEdge = window.innerWidth - MARGIN - 34;
    const inset = !fanned[side] ? (MARGIN + CARD_W + 10)               // closed pile edge
      : Math.min(MARGIN + deck.contentW + deck.scrollX + 10, screenEdge);
    deck.arrow.style[side === "left" ? "left" : "right"] = `${Math.round(inset)}px`;
    deck.arrow.style[side === "left" ? "right" : "left"] = "auto";
  };
  // Screen-edge scroll shadows for the fanned deck: a shade INSIDE the card that straddles a viewport
  // edge (clipped to the card's rounded shape) — square through the body, the real corner curve only near
  // a corner, and never over the inter-card gaps (only a straddling card gets one).
  const updateDeckEdges = () => {
    const side = fanned.left ? "left" : fanned.right ? "right" : fanned.trash ? "trash" : null;
    const VW = window.innerWidth, MAXW = 34, SH = "rgba(0,0,0,0.45)";
    const hide = (c) => { const sh = c.querySelector(":scope > .tk-edge-shade"); if (sh) sh.style.cssText = "position:absolute;width:0;height:0;"; };
    DECK_SIDES.forEach((sd) => { const d = decks[sd]; if (d) d.cards.forEach(hide); });
    if (!side) return;
    // Treat the whole fanned row as ONE clipped object: the shadow's depth tracks how far the LIST
    // extends past the viewport edge (not an individual ticket), and it leaps inter-ticket gaps by
    // sitting on the trailing ticket's edge — so it never blinks off just because a gap is at the edge.
    const info = [];
    decks[side].cards.forEach((card) => {
      if (card.classList.contains("tk-dragging")) return;
      const r = card.getBoundingClientRect();
      if (r.width > 1) info.push({ card, r });
    });
    if (!info.length) return;
    let listLeft = Infinity, listRight = -Infinity;
    info.forEach(({ r }) => { if (r.left < listLeft) listLeft = r.left; if (r.right > listRight) listRight = r.right; });
    // ONE continuous band fixed at each viewport edge (depth = how far the LIST extends past it). Every
    // ticket renders the SAME band, positioned in its own coords, and its overflow:hidden clips it to its
    // slice — so the shadow reads as a single band the tickets slide under: continuous across gaps (you
    // just can't see the slice that lands in a gap), never jumping or vanishing at a ticket edge.
    const wR = listRight > VW + 0.5 ? Math.min(MAXW, listRight - VW) : 0;
    const wL = listLeft < -0.5 ? Math.min(MAXW, -listLeft) : 0;
    const gradR = `linear-gradient(to right, rgba(0,0,0,0), ${SH})`;   // dark at the right viewport edge
    const gradL = `linear-gradient(to right, ${SH}, rgba(0,0,0,0))`;   // dark at the left viewport edge
    info.forEach(({ card, r }) => {
      const sh = card.querySelector(":scope > .tk-edge-shade"); if (!sh) return;
      if (wR && r.right > VW - wR - 0.5 && r.left < VW + 0.5) {        // ticket overlaps the RIGHT-edge band
        sh.style.cssText = `position:absolute;top:0;height:${r.height}px;left:${(VW - wR) - r.left}px;width:${wR}px;background:${gradR};pointer-events:none;z-index:6;`;
      } else if (wL && r.left < wL + 0.5 && r.right > -0.5) {          // ticket overlaps the LEFT-edge band
        sh.style.cssText = `position:absolute;top:0;height:${r.height}px;left:${-r.left}px;width:${wL}px;background:${gradL};pointer-events:none;z-index:6;`;
      }
    });
  };
  // Fanning out animates the cards over .42s, so their rects only reach the viewport edge mid-transition —
  // run the edge shadows each frame for the duration so they appear as the cards arrive, not on next scroll.
  let fanEdgeRaf = 0;
  const trackFanEdges = () => {
    cancelAnimationFrame(fanEdgeRaf);
    const end = performance.now() + 480;
    const tick = () => { updateDeckEdges(); if (performance.now() < end) fanEdgeRaf = requestAnimationFrame(tick); else fanEdgeRaf = 0; };
    fanEdgeRaf = requestAnimationFrame(tick);
  };
  // Reposition the fanned cards + thumb + arrow from the CURRENT (maybe overscrolled) scrollX — no clamp.
  const positionFan = (side) => {
    const deck = decks[side]; if (!deck) return;
    setTrack(side);   // live scroll = rigid track transform; card slots are untouched (no re-place) → collision keeps animating
    const min = scrollMinOf(deck), barW = barWidth();
    const base = Math.max(36, barW * (deck.viewW / Math.max(1, deck.contentW)));
    // Apple-style overscroll: past an end, the thumb anchors to that end and shrinks by the overscroll
    // amount (and grows back as the recoil settles, since this runs every frame of the scroll loop).
    let thumbW = base, frac;
    if (deck.scrollX > 0) { thumbW = Math.max(20, base - deck.scrollX); frac = 0; }                          // past the start
    else if (deck.scrollX < min) { thumbW = Math.max(20, base - (min - deck.scrollX)); frac = 1; }             // past the end
    else { frac = min ? deck.scrollX / min : 0; }
    if (side !== "left") frac = 1 - frac;   // right/trash fan LEFT → mirror so the thumb tracks the cursor, not against it
    deck.thumb.style.width = `${thumbW}px`;
    deck.thumb.style.left = `${frac * (barW - thumbW)}px`;
    deck.thumb.style.right = "auto";
    placeArrow(side);   // arrow tracks the ticket edge (rigidly — its transition is off during scroll)
    updateDeckEdges();  // screen-edge scroll shadows track the live card positions
  };
  // One easing loop: each frame glide scrollX toward the target (smooth wheel), then ease it back
  // inside the bounds once the gesture ends (rubber-band settle). Restores card transitions at rest.
  const runScroll = (side) => {
    const deck = decks[side]; if (!deck || deck._raf) return;   // already animating → loop reads targetX live
    deck.arrow.style.transition = "none";                       // track the edge rigidly while scrolling
    const tick = () => {                                        // scroll rides the track (rigid); cards keep their .42s
      const min = scrollMinOf(deck);
      const goal = deck._wheeling ? deck.targetX : clamp(deck.targetX, min, 0);
      deck.scrollX += (goal - deck.scrollX) * 0.22;
      if (!deck._wheeling && Math.abs(goal - deck.scrollX) < 0.4) {
        deck.scrollX = goal; deck.targetX = goal; positionFan(side);
        deck.arrow.style.transition = "";                       // restore (CSS .42s) so a fan-toggle glides
        deck._raf = 0; return;
      }
      positionFan(side);
      deck._raf = requestAnimationFrame(tick);
    };
    deck._raf = requestAnimationFrame(tick);
  };

  const onWheel = (side, e) => {
    if (!fanned[side]) return;
    const deck = decks[side];
    if (deck.contentW <= deck.viewW) return;
    e.preventDefault();
    const min = scrollMinOf(deck);
    // Normalise wheel units to pixels (mice report lines/pages) so every device scrolls evenly,
    // then accumulate into a target the loop eases toward — no per-event jumps.
    const raw = e.deltaY + e.deltaX;
    const px = e.deltaMode === 1 ? raw * 16 : e.deltaMode === 2 ? raw * deck.viewW : raw;
    if (!deck._raf) deck.targetX = deck.scrollX;   // new gesture → resync target to the live position
    deck.targetX = damp(deck.targetX - px, min);   // rubber-band-bounded target
    deck._wheeling = true;
    clearTimeout(deck._releaseT);
    deck._releaseT = setTimeout(() => { deck._wheeling = false; runScroll(side); }, 90);   // settle after wheel stops
    runScroll(side);
  };

  const wireThumb = (side, thumb) => {
    let sx = 0, startScroll = 0, drag = false;
    const move = (e) => {
      if (!drag) return;
      const deck = decks[side], min = scrollMinOf(deck), barW = barWidth();
      const thumbW = Math.max(36, barW * (deck.viewW / deck.contentW));
      const dxPx = (e.clientX - sx) * (side !== "left" ? -1 : 1);
      const dFrac = dxPx / Math.max(1, barW - thumbW);
      deck.scrollX = damp(startScroll + dFrac * min, min);   // rubber-band past the ends
      deck.arrow.style.transition = "none";                  // track the edge rigidly while dragging
      positionFan(side);                                     // scroll = track transform; cards untouched
    };
    const up = () => {
      drag = false; window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      const deck = decks[side]; deck._wheeling = false; deck.targetX = deck.scrollX; runScroll(side);   // settle / bounce back
    };
    thumb.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); drag = true; sx = e.clientX;
      const deck = decks[side];
      cancelAnimationFrame(deck._raf); deck._raf = 0; clearTimeout(deck._releaseT); deck._wheeling = false;
      startScroll = deck.scrollX;
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    });
  };

  // Next free grid cell in a 6-col layout for a 1-col × 3-row ticket widget.
  const nextCell = (layout) => {
    const occ = new Set([...layout.querySelectorAll(".widget-card")].map((w) => `${w.dataset.gridCol || 1}:${w.dataset.gridRow || 1}`));
    for (let row = 1; row <= 90; row += 3)
      for (let col = 1; col <= 6; col++) if (!occ.has(`${col}:${row}`)) return { col, row };
    return { col: 1, row: 1 };
  };

  // The grid cell under the cursor (1-col × 3-row footprint), clamped to the rows ABOVE the
  // stack band. A ticket dragged out of a stack spawns here so the blue placeholder is born
  // right where the card crossed in (down by the stack) and rides up onto the grid — instead
  // of flying in from the next-free corner cell.
  const cursorCell = (clientX, clientY) => {
    const host = document.querySelector(".dashboard-layout-grid");
    const rect = host && host.getBoundingClientRect();
    if (!rect || !rect.width) return null;
    const cs = getComputedStyle(host);
    const cols = 6;
    const gap = parseFloat(cs.rowGap || cs.gap) || 18;
    const rowH = parseFloat(cs.getPropertyValue("--dashboard-grid-row-height")) || 81;
    const step = rowH + gap;
    const colW = (rect.width - gap * (cols - 1)) / cols;
    const itemH = rowH * 3 + gap * 2;   // 3-row ticket footprint
    const col = Math.max(1, Math.min(cols, Math.round((clientX - rect.left - colW / 2) / (colW + gap)) + 1));
    const maxStart = Math.max(1, Math.floor(1 + (stackTopY() + MARGIN - rect.top - rowH) / step) - 2);
    const row = Math.max(1, Math.min(maxStart, Math.round((clientY - rect.top - itemH / 2) / step) + 1));
    return { col, row };
  };

  // Add the dropped ticket to the dashboard grid as its OWN BARE ticket widget (identical to
  // the static one — no shell), keyed uniquely, sized to 3 rows via the runtime, and fed its
  // specific ticket. Many can coexist; if already present, just refresh it.
  const addTicketToGrid = (t, preferredCell = null) => {
    if (!t || !t.id) return null;
    const layout = document.querySelector('.widget-layout[data-widget-layout-key="builder-chart"]');
    if (!layout || typeof layout.__initWidget !== "function") { gridFallback?.show?.(t); return null; }
    const key = `${pinPrefix}${t.id}`;
    const sel = (window.CSS && CSS.escape) ? CSS.escape(key) : key;
    let card = layout.querySelector(`[data-widget-key="${sel}"]`);
    let cell = null;
    if (!card) {
      cell = preferredCell || nextCell(layout);
      card = document.createElement("div");
      card.className = `widget-card ${widgetCardClass}`;
      // Size to its 3-row footprint INSTANTLY. .widget-card animates width/height/grid-row,
      // and the drag hand-off reads getBoundingClientRect to compute the grab offset — a
      // mid-transition (half-sized) read offsets the widget from the cursor and makes the
      // first drag look frozen until it snaps to its grid cell on release. Restored below.
      card.style.transition = "none";
      card.dataset.widgetKey = key;
      card.dataset.widgetType = widgetType;
      card.dataset.widgetRuntimeType = widgetType;
      card.dataset.widgetConfig = JSON.stringify({ title: widgetTitle });
      card.dataset.defaultSpan = "1";
      card.dataset.defaultGridCol = String(cell.col); card.dataset.defaultGridRow = String(cell.row);
      card.dataset.gridCol = String(cell.col); card.dataset.gridRow = String(cell.row); card.dataset.gridRowSpan = "3";
      card.style.gridColumn = `${cell.col} / span 1`;
      card.style.gridRow = `${cell.row} / span 3`;
      layout.appendChild(card);
      layout.__initWidget(card);
    }
    // Feed its data FIRST, then register the 3-row span so the re-render re-resolves the
    // ticket (full-size immediately, no 1-row spawn, no blank).
    window.dashboardWidgetDataRuntime?.ingest?.({ widgets: { [key]: { rows: [t] } } });
    if (cell) dashboardPlacement?.size?.(card, cell.col, cell.row);
    window.dashboardWidgetDataRuntime?.ingest?.({ widgets: { [key]: { rows: [t] } } });
    // Flush the instant sizing, then restore normal motion (the drag's panel-interaction-active
    // suppresses transitions anyway, so this only matters once the widget is at rest).
    if (cell) { void card.offsetWidth; requestAnimationFrame(() => { card.style.transition = ""; }); }
    return card;
  };

  // Drop onto the dashboard → add a new grid widget for it (at `cell`, the drop target),
  // remove it from its stack (one canonical ticket), and fly a clone into the new cell.
  const flyIntoGrid = (card, t, cell = null) => {
    // Clone the source card NOW — re-render below drops it from the stack.
    const cr = card.getBoundingClientRect();
    const clone = card.cloneNode(true);
    clone.className = "tk-card tk-flying";
    clone.style.cssText = `position:fixed; left:${cr.left}px; top:${cr.top}px; width:${cr.width}px; height:${cr.height}px; margin:0; z-index:9999;`;
    ensureTheater().appendChild(clone);
    const placed = addTicketToGrid(t, cell);
    render();   // the ticket now has a grid widget → it leaves its stack
    requestAnimationFrame(() => {
      const gr = placed && placed.getBoundingClientRect();
      if (gr && gr.width) {
        clone.style.transformOrigin = "top left";
        clone.style.transform = `translate(${gr.left - cr.left}px, ${gr.top - cr.top}px) scale(${gr.width / cr.width}, ${gr.height / cr.height})`;
      }
      clone.style.opacity = "0";
    });
    setTimeout(() => clone.remove(), 440);
  };

  // ── Lift a stack card onto the dashboard ─────────────────────────────────────
  // Once a card is lifted up out of the stack zone we hand the gesture off to the REAL
  // widget-move runtime (handOffToGrid), so the rest of the drag is the native one: a
  // glass widget gliding under the cursor + the blue placeholder reflowing between cells.
  const gridLayout = () => document.querySelector('.widget-layout[data-widget-layout-key="builder-chart"]');
  const stackTopY = () => window.innerHeight - (CARD_H + MARGIN * 2);

  // ── Drag a grid ticket BACK into its stack ───────────────────────────────────
  // The bottom band belongs to the stacks. The grid drag is taught to RESERVE it via
  // data-drop-floor-y, so the native blue placeholder can never enter band rows — only
  // the dragged glass widget follows the cursor down. When the cursor is over the stack
  // band we tuck that (clamped) placeholder away and light a landing pad ("the blue
  // preview enters the stack"); releasing there cancels the native drop and re-homes the
  // ticket as a real stack member with the quantum-tunnel wiggle.
  const PIN = pinPrefix;
  // ANY ticket widget on the grid can be dragged home — the pinned ones AND the main
  // ticket-card from the template. Match on the runtime type, not the pin key.
  const draggedTicket = () => document.querySelector(
    `.dashboard-layout-grid .widget-card.widget-dragging[data-widget-runtime-type="${cssEsc(widgetType)}"],` +
    ` .widget-layout .widget-card.widget-dragging[data-widget-runtime-type="${cssEsc(widgetType)}"]`);
  const ticketForWidget = (w) => {
    if (!w) return null;
    const k = String(w.dataset.widgetKey || "");
    const id = w.dataset.ticketId || (k.startsWith(PIN) ? k.slice(PIN.length) : "");
    return id ? (tickets.find((x) => x.id === id) || null) : null;
  };
  const deckSideFor = (t) => (rightDeckEnabled && isResolved(t) ? "right" : "left");
  const overStack = (e) => e.clientY >= stackTopY();
  const nativePlaceholder = () => gridLayout()?.querySelector(":scope > .widget-placeholder") || null;
  // Publish the stack cards' TOP EDGE so the grid drag clamps its placeholder to sit
  // flush above the stacks. stackTopY keeps a MARGIN of slack above the cards (they sit
  // at bottom:MARGIN), and reserving down to it left one extra empty row — the lock a
  // cell too high. The cards' real top is stackTopY + MARGIN.
  const syncDropFloor = () => { const l = gridLayout(); if (l) l.dataset.dropFloorY = String(Math.round(stackTopY() + MARGIN)); };

  let dragPinW = null, dragPinT = null;
  // Which deck the cursor is over (by viewport half) while in the stack band, else null.
  const hotSideAt = (e) => {
    if (!overStack(e)) return null;
    if (!rightDeckEnabled) return "left";
    return e.clientX < window.innerWidth / 2 ? "left" : "right";
  };
  // Landing pads live on the ROOT (not the deck boxes): an empty deck box is display:none,
  // which would hide a pad nested inside it — but we still want to show (and red-flag) an
  // empty deck as a drop target. Positioned at the deck's top-card slot via a side class.
  const landingPad = (side) => {
    const deck = decks[side];
    if (!deck.landing) { deck.landing = document.createElement("div"); deck.landing.className = `tk-landing tk-${side}`; root.appendChild(deck.landing); }
    deck.landing.style.width = `${CARD_W}px`; deck.landing.style.height = `${CARD_H}px`;
    return deck.landing;
  };
  const clearLandings = () => {
    for (const s of CORNER_SIDES) decks[s]?.landing?.classList.remove("tk-faint", "tk-hot", "tk-bad");
    const ph = nativePlaceholder(); if (ph) ph.style.visibility = "";
  };
  const resetDragWatch = () => { clearLandings(); dragPinW = null; dragPinT = null; };

  const onDragWatchMove = (e) => {
    if (!document.body.classList.contains("panel-interaction-active")) { if (dragPinW) resetDragWatch(); return; }
    const w = draggedTicket();
    if (!w) { if (dragPinW) resetDragWatch(); return; }
    dragPinW = w; dragPinT = ticketForWidget(w);
    if (!dragPinT) { clearLandings(); return; }
    // Faint outline on BOTH decks; red (.tk-bad) on the one that rejects this ticket's
    // state; the hovered deck intensifies (.tk-hot). Over the VALID deck the grid
    // placeholder gives way (it would "enter the stack"); otherwise it stays visible.
    const validSide = deckSideFor(dragPinT);
    const hot = hotSideAt(e);
    for (const s of CORNER_SIDES) {
      const pad = landingPad(s);
      pad.classList.add("tk-faint");
      pad.classList.toggle("tk-bad", s !== validSide);
      pad.classList.toggle("tk-hot", s === hot);
    }
    const ph = nativePlaceholder();
    if (ph) ph.style.visibility = (hot === validSide) ? "hidden" : "";
  };
  const onDragWatchUp = (e) => {
    const w = dragPinW || draggedTicket();
    const t = dragPinT || ticketForWidget(w);
    const hot = hotSideAt(e);
    const validSide = t ? deckSideFor(t) : null;
    resetDragWatch();
    // Only a release over the ticket's OWN stack absorbs it. Over the wrong (red) stack —
    // or not over a stack at all — the native drop stands and it stays on the grid.
    if (!w || !t || !hot || hot !== validSide) return;
    const from = w.getBoundingClientRect();                     // under-cursor rect, before native commits
    // Let native's drop COMMIT normally (it is clamped ABOVE the band by data-drop-floor-y,
    // so it never lands behind the stacks), then pull the widget out on the next frame —
    // requestAnimationFrame runs before paint, so the committed cell never shows. We do NOT
    // block the pointerup or fire a synthetic cancel: doing so left native's teardown to a
    // fragile synthetic path that could wedge the drag state on rapid in/out dragging.
    requestAnimationFrame(() => tunnelToStack(w, t, validSide, from));
  };

  const tunnelToStack = (w, t, side, from) => {
    w.remove();              // leave the grid → render() hands the ticket back to its deck
    deckToTop(side, t.id);   // re-enters the pile as its TOP card (highest z)
    render();
    const target = decks[side]?.cards.find((c) => c.dataset.id === t.id);
    const clone = document.createElement("div");
    clone.className = "tk-card tk-flying";
    // Snappier flight than the shared .tk-flying default so the wiggle lands quickly.
    clone.style.cssText = `position:fixed; left:${from.left}px; top:${from.top}px; width:${from.width}px; height:${from.height}px; margin:0; z-index:9999; pointer-events:none; transition: transform .2s cubic-bezier(.4,0,.2,1), opacity .2s ease;`;
    clone.style.backgroundColor = baseColor();
    clone.style.backgroundImage = cardBg(t);
    applyStaleness(clone, t);
    clone.innerHTML = cardInner(t);
    ensureTheater().appendChild(clone);
    fitCardFields(clone);
    if (!target) { requestAnimationFrame(() => { clone.style.opacity = "0"; }); setTimeout(() => clone.remove(), 420); return; }
    // Measure the card's resting slot with its transition suppressed, then hide it
    // behind the flying clone until the clone lands.
    const prevTransition = target.style.transition;
    target.style.transition = "none";
    const to = target.getBoundingClientRect();
    target.style.opacity = "0";
    void target.offsetWidth;
    target.style.transition = prevTransition;
    requestAnimationFrame(() => {
      clone.style.transformOrigin = "top left";
      clone.style.transform = `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`;
    });
    setTimeout(() => {
      clone.remove();
      target.style.opacity = "";
      target.classList.add("tk-tunneling");
      target.addEventListener("animationend", () => target.classList.remove("tk-tunneling"), { once: true });
    }, 180);
  };

  const wireCard = (card, t, side) => {
    let startX = 0, startY = 0, dragging = false, down = false, handedOff = false;
    let pointerId = null, pointerType = "mouse", baseTx = 0, baseTy = 0, ranksClosed = false, lastAlong = 0;
    // Move THIS card to the slot under it (box-space x) and let the others slide to fill — factored so the
    // autoscroll loop can re-run it at the held cursor (so the collision keeps following the scroll).
    const reorderTo = (alongBoxX) => {
      if (!fanned[side]) return;
      const deck = decks[side];
      if (deck.cards.length <= 1) return;
      const step = CARD_W + GAP_FAN;
      const along = (side !== "left" ? -alongBoxX : alongBoxX) - deck.scrollX;
      const idx = clamp(Math.round(along / step), 0, deck.cards.length - 1);
      const cur = deck.cards.indexOf(card);
      if (cur !== -1 && idx !== cur) {
        deck.cards.splice(cur, 1);
        deck.cards.splice(idx, 0, card);
        deck.order = deck.cards.map((c) => c.dataset.id);   // remember the custom order…
        saveOrder(side);                                    // …and persist it across reloads
        layout(side); ranksClosed = false;                  // others slide to their new slots (.42s collision)
      } else if (ranksClosed) {
        layout(side); ranksClosed = false;                  // re-entered the row after a lift-out → reopen the gap
      }
    };

    // Materialise the ticket as a real grid widget, drop the source card from its
    // stack, then "pick up" the new widget mid-drag with the native widget-move runtime.
    const handOffToGrid = (e) => {
      handedOff = true; down = false; dragging = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      card.classList.remove("tk-dragging");
      if (isDeleted(t.id)) setDeleted(t.id, false);   // dragging a card OUT of the recycle bin restores it
      const placed = addTicketToGrid(t, cursorCell(e.clientX, e.clientY));
      render();                            // ticket now lives on the grid → leaves its stack
      if (!placed || typeof placed.__beginWidgetMoveFromDragRuntime !== "function") return;
      const cx = e.clientX, cy = e.clientY;
      placed.style.opacity = "0";
      let released = false;
      const onGapUp = () => { released = true; };
      window.addEventListener("pointerup", onGapUp, { once: true, capture: true });
      requestAnimationFrame(() => {
        window.removeEventListener("pointerup", onGapUp, true);
        placed.style.opacity = "";
        if (released || !placed.isConnected || typeof placed.__beginWidgetMoveFromDragRuntime !== "function") return;
        const r = placed.getBoundingClientRect();
        placed.__beginWidgetMoveFromDragRuntime({
          button: 0, pointerId, pointerType, currentTarget: placed, target: placed,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
          timeStamp: performance.now(), preventDefault() {}, stopPropagation() {},
        });
        document.dispatchEvent(new PointerEvent("pointermove", {
          pointerId, pointerType, bubbles: true, clientX: cx, clientY: cy,
        }));
      });
    };

    const onMove = (e) => {
      if (!down || handedOff) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) > 6) {
        dragging = true; dragActive = true; draggingSide = side; ranksClosed = false; card.classList.add("tk-dragging"); card.style.zIndex = "9999";
        if (zonesEnabled) {
          focusDropTargets(stackPos(side), t);   // show ONLY the eligible bucket(s) for the WHOLE drag — from the
                                                 // moment it's lifted, even while the cursor is still on the stack
        }
        // Lift the card OUT of the scroll track into the box, so it stays screen-fixed while the track
        // autoscrolls underneath. Fold the current scroll into baseTx (the track no longer moves it).
        const d0 = decks[side]; d0.box.appendChild(card);
        baseTx = card._tx + (side === "left" ? d0.scrollX : -d0.scrollX); baseTy = card._ty;
        dragPreviewFn = zonesEnabled
          ? ((x, y) => {              // re-run while autoscrolling so the gap follows the cursor
              if (y < stackTopY()) { flowHighlight(stackPos(side), x, y, t); const dt = dropTarget(stackPos(side), x, y, t); if (dt) previewGap(dt.stage, dt.index); else clearGap(); }
              else { clearZoneHighlight(); clearGap(); }
            })
          : null;
        deckReorderFn = () => reorderTo(lastAlong);   // autoscroll re-runs the reorder at the held cursor
      }
      if (!dragging) return;
      card.style.transform = `translate(${baseTx + dx}px, ${baseTy + dy}px) rotate(0deg) scale(1.03)`;
      updateAutoScroll(e.clientX, e.clientY);   // scroll a bucket/deck if the cursor nears a scrollable edge
      if (previewCalendarTarget(e.clientX, e.clientY, card)) { clearHomeStageHighlight(); clearZoneHighlight(); clearGap(); return; }
      if (previewHomeStageTarget(e.clientX, e.clientY, t, card)) { clearCalendarHighlight(); clearZoneHighlight(); clearGap(); return; }
      clearCalendarHighlight(); clearHomeStageHighlight();
      // Over the recycle bin (icon or open stack) → ring it open / target it, and skip the zone preview.
      if (trashDragMove(e.clientX, e.clientY)) { clearZoneHighlight(); clearGap(); return; }
      if (previewLinkTarget(e.clientX, e.clientY, t, card)) { clearZoneHighlight(); clearGap(); return; }
      // Dragging a TRASH card over an ELIGIBLE corner stack → it'll restore there; highlight it and
      // don't reorder the bin. Over an ineligible stack, no highlight → it'll spring back on release.
      if (side === "trash") { const es = eligibleCornerStack(e.clientX, e.clientY, t); setStackDrop(es); if (es) { clearZoneHighlight(); clearGap(); return; } }
      // A fully-completed LEFT-stack card over the RIGHT (resolved) pile → light the pile it would resolve into.
      if (rightDeckEnabled && side === "left") setStackDrop(e.clientY >= stackTopY() && canResolveRecord(t) && overCornerStack(e.clientX, e.clientY) === "right" ? "right" : null);
      // Dragged UP onto the dashboard → target a pipeline zone (highlight the one under the
      // cursor). A horizontal reorder keeps the cursor ON the cards (below stackTopY), so it
      // never reaches here — the two gestures don't collide.
      if (e.clientY < stackTopY()) {
        flowHighlight(stackPos(side), e.clientX, e.clientY, t);
        const dt = dropTarget(stackPos(side), e.clientX, e.clientY, t);
        if (dt) previewGap(dt.stage, dt.index); else clearGap();   // open a sandwich slot under the cursor
        if (fanned[side]) { closeFanRanks(side, card); ranksClosed = true; }  // remaining fan cards slide together to close the hole
        return;
      }
      clearZoneHighlight(); clearGap();
      // Fanned out → dragging reorders the row: the others slide to fill the gap (.42s collision),
      // while the scroll rides the track rigidly, so the two never fight even during autoscroll.
      if (fanned[side]) { lastAlong = baseTx + dx; reorderTo(lastAlong); }
    };
    const onUp = (e) => {
      window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
      // Evaluate the trash target BEFORE dragActive resets — the generous drag-time catch pad (and the
      // open placeholder) must still count at the moment of release.
      const overTrash = dragging && overTrashTarget(e.clientX, e.clientY);
      dragActive = false; draggingSide = null; stopAutoScroll(); dragPreviewFn = null; deckReorderFn = null; stopTrashRing(); clearDropFocus(); setStackDrop(null); clearLinkHighlight(); clearCalendarHighlight(); clearHomeStageHighlight();   // always clear
      if (handedOff) return;                                                // native runtime owns the drop
      const wasDrag = dragging; dragging = false; down = false;
      card.classList.remove("tk-dragging");
      // A plain click opens its config — EXCEPT trash cards, which have no config (their restore button does the work).
      if (!wasDrag) { if (side !== "trash") detail?.open(t, card); return; }
      if (tryLinkDrop(e.clientX, e.clientY, t, card)) return;
      // Dropped on the recycle bin (icon, open stack, or empty placeholder) → delete it into the bin (except trash cards).
      if (side !== "trash" && overTrash) { dropTicketToTrash(t, card.getBoundingClientRect()); return; }
      // A trash card dropped on an ELIGIBLE corner stack → restore it into THAT stack; over an
      // ineligible one it falls through and springs back into the bin.
      if (side === "trash") { const es = eligibleCornerStack(e.clientX, e.clientY, t); setStackDrop(null); if (es) { restoreToDeck(t, e.clientX, card.getBoundingClientRect(), es); return; } }
      // A fully-completed (3-green) LEFT-stack card dropped on the RIGHT (resolved) pile → resolve it there.
      if (rightDeckEnabled && side === "left" && overCornerStack(e.clientX, e.clientY) === "right" && canResolveRecord(t)) {
        const fromRect = card.getBoundingClientRect();
        t.state = resolvedState; const live = tickets.find((x) => x.id === t.id); if (live) live.state = resolvedState;
        try { source?.resolve?.(t.id); } catch {}
        deckToTop("right", t.id);   // newest resolve → TOP of the pile (highest z)
        render();
        flyCloneTo(t, fromRect, decks.right?.box?.querySelector(`.tk-card[data-id="${cssEsc(t.id)}"]`), () => pulseResolvedPile(t.id));
        return;
      }
      const dDrop = decks[side];               // back into the scroll track (it was lifted to the box for the drag) —
      if (dDrop && dDrop.track) {              // compensate for the track's transform so it doesn't jump by scrollX
        const tt = side === "left" ? dDrop.scrollX : -dDrop.scrollX;
        card.style.transform = `translate(${(baseTx + (e.clientX - startX)) - tt}px, ${baseTy + (e.clientY - startY)}px)`;
        dDrop.track.appendChild(card);
      }
      clearZoneHighlight();
      if (tryCalendarDrop(e.clientX, e.clientY, t, card)) { layout(side); return; }
      if (tryHomeStageDrop(e.clientX, e.clientY, t, card)) { layout(side); return; }
      // Released up on the dashboard → drop into the pipeline zone under the cursor, if any.
      if (e.clientY < stackTopY()) {
        const dt = dropTarget(stackPos(side), e.clientX, e.clientY, t);
        clearGap();
        if (dt) { dropIntoZone(card, t, dt.stage, dt.index); return; }
        layout(side); return;   // not over a VALID zone (none, or a red one) → spring back
      }
      clearGap();
      // Released back in the stack (incl. after a reorder) → settle into the slot + restore z.
      layout(side);
    };
    card.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      down = true; handedOff = false; dragging = false;
      startX = e.clientX; startY = e.clientY;
      pointerId = e.pointerId; pointerType = e.pointerType || "mouse";
      window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
    });
  };

  // The config-menu info entered for this ticket's CURRENT stage, shown on the card face and kept in
  // sync as you type (see ticketStacks.setMeta). Severity is the card colour, so its field is skipped;
  // blank / "n/a" fields show nothing.
  const cardFieldsHTML = (t) => {
    // Show EVERY filled-in field across ALL stages (not just the current bucket's), so a ticket that has
    // triage + investigation done shows both stages' work — mirroring its green progress bars.
    const seen = new Set();
    return STAGE_KEYS.flatMap((k) => STAGE_FIELDS[k] || []).filter((f) => {
      if (f.prio || seen.has(f.key)) return false;
      seen.add(f.key);
      return true;
    }).map((f) => {
      const raw = fieldRaw(t, f.key);
      if (!raw || isNA(raw) || !String(raw).trim()) return "";
      const v = f.date ? fmtDate(raw) : raw;
      return `<div class="ticket-field"><span class="ticket-field-l">${esc(f.label)}</span><span class="ticket-field-v">${esc(v)}</span></div>`;
    }).join("");
  };
  const faceBadgesHTML = (t) => {
    if (!faceBadges) return "";
    let badges = [];
    try { badges = faceBadges(t, { metaOf, stageOf, isResolved, stalenessOf }) || []; } catch { badges = []; }
    if (!Array.isArray(badges) || !badges.length) return "";
    const html = badges.map((badge) => {
      const item = typeof badge === "string" ? { label: badge } : badge;
      const label = String(item?.label || "").trim();
      if (!label) return "";
      const tone = String(item?.tone || "neutral").replace(/[^a-z0-9_-]/gi, "");
      return `<span class="ticket-face-chip" data-tone="${esc(tone)}">${esc(label)}</span>`;
    }).filter(Boolean).join("");
    return html ? `<div class="ticket-face-badges">${html}</div>` : "";
  };

  // The card's inner markup — shared by the stack cards and the fly-home clone so they render
  // identically. Header = CLIENT (title) + " | date of incident" (the date in a secondary colour); the
  // short description sits on the sub-line; then the live stage-field info.
  // The pinned date block under the top-right bars: the incident date, and — once a resolution date is
  // entered — a second line: resolved SAME day → the time it took ("15 minutes"); a LATER day → the
  // resolution date. (Both stay in the card's detail rows too; this is just the at-a-glance header.)
  const dateUnderHTML = (t) => {
    if (!showDateUnder) return "";
    const m = metaOf(t.id);
    const dateS = fmtDate(m.incidentDate);
    if (!dateS) return "";
    const ok = (v) => v && !isNA(v) && String(v).trim() ? String(v).trim() : "";
    const resD = ok(m.resolutionDate) ? fmtDate(m.resolutionDate) : "";
    const second = resD ? (resD === dateS ? ok(m.duration) : resD) : "";
    return `<div class="tk-date-under">${esc(dateS)}${second ? `<br>${esc(second)}` : ""}</div>`;
  };

  // Entity-specific body rows from the face contract. Each row fn returns a
  // string (one line), a {label, value} pair, or nothing (row skipped). With no
  // contract the body falls back to the original stage-field rows (tickets).
  const faceRowsHTML = (t) => {
    if (!face?.rows || !Array.isArray(face.rows)) return cardFieldsHTML(t);
    return face.rows.map((fn) => {
      let row = null;
      try { row = fn(t); } catch { row = null; }
      if (!row) return "";
      if (typeof row === "string") {
        const v = firstFaceText(row);
        return v ? `<div class="ticket-field"><span class="ticket-field-v">${esc(v)}</span></div>` : "";
      }
      const value = firstFaceText(row.value);
      if (!value) return "";
      const label = firstFaceText(row.label);
      return `<div class="ticket-field">${label ? `<span class="ticket-field-l">${esc(label)}</span>` : ""}<span class="ticket-field-v">${esc(value)}</span></div>`;
    }).join("");
  };

  const cardInner = (t) => {
    const sub = subOf(t);
    return `<div class="ticket-body">` +
      `<div class="ticket-company">${esc(titleOf(t))}</div>` +      // face title (ellipsised); date lives pinned under the bars
      (sub ? `<div class="ticket-host">${esc(sub)}</div>` : "") +   // face subtitle; empty → no line
      `<div class="ticket-fields">${faceRowsHTML(t)}</div>` +       // entity field rows from the face contract
      faceBadgesHTML(t) +
      `</div>` +
      barsHTML(ticketBarClasses(t), true) +
      dateUnderHTML(t);   // incident date (+ resolution info), fixed snugly under the top-right bars
  };

  // Smart-fit the card's detail lines. Every entry renders FULL (wrapped) by default; only when the
  // body overflows the card's fixed height does the LONGEST entry lose one line at a time (gaining an
  // ellipsis via line-clamp) until everything fits — so a card with room never truncates anything.
  // Runs after the card is in the DOM (it measures real layout); re-run whenever the text changes.
  const fitCardFields = (card) => {
    const body = card.querySelector(".ticket-body"); if (!body) return;
    const rows = [...card.querySelectorAll(".ticket-host, .ticket-field")]; if (!rows.length) return;
    rows.forEach((r) => { r.style.webkitLineClamp = ""; });   // reset → fully expanded
    const fields = card.querySelector(".ticket-fields");
    const over = () => body.scrollHeight > body.clientHeight + 1 || (fields && fields.scrollHeight > fields.clientHeight + 1);
    for (let guard = 0; guard < 40 && over(); guard++) {
      let tallest = null, h = 0;
      for (const r of rows) { const rh = r.getBoundingClientRect().height; if (rh > h) { h = rh; tallest = r; } }
      if (!tallest) return;
      const cs = getComputedStyle(tallest);
      const lineH = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 12) * 1.35;
      const lines = Math.max(1, Math.round(h / lineH));
      if (lines <= 1) return;   // every entry is single-line already — the container's clip takes the rest
      tallest.style.webkitLineClamp = String(lines - 1);
    }
  };

  const cardEl = (t, side) => {
    const card = document.createElement("div");
    // NOT a .widget-card (the runtime renders the grid ticket into EVERY .widget-card, which
    // is what overwrote these with "Willits Scaling"). .tk-card replicates the frame; the
    // global .ticket-body/.ticket-company/etc. classes give identical fonts/colour; and the
    // fill is an opaque copy of the grid card so the colour matches exactly.
    card.className = `tk-card tk-card-${widgetType}`;
    card.dataset.id = t.id || "";
    card.style.width = `${CARD_W}px`; card.style.height = `${CARD_H}px`;
    card.style.backgroundColor = baseColor();
    card.style.backgroundImage = cardBg(t);
    applyStaleness(card, t);
    card.innerHTML = cardInner(t);
    card.insertAdjacentHTML("beforeend", '<div class="tk-edge-shade"></div>');   // viewport-edge scroll shadow (clipped to this card)
    wireCard(card, t, side);
    wireContextMenu(card, t);   // right-click menu (state-aware: trash cards get restore + delete-permanently)
    // Trash cards carry their own "restore" action bottom-right (no config menu for deleted tickets).
    if (side === "trash") {
      card.insertAdjacentHTML("beforeend", '<button class="tk-restore" type="button">restore</button>');
      const rb = card.querySelector(".tk-restore");
      rb.addEventListener("pointerdown", (e) => e.stopPropagation());   // don't start a card drag
      rb.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); publicApi?.restore?.(t.id); });
    }
    return card;
  };

  const buildDeck = (side, list) => {
    const deck = decks[side];
    if (!deck) return;
    // NEVER rebuild the deck that owns the card currently in hand: a render fired mid-drag (e.g. the bin
    // opening as you hover its icon) would c.remove() the dragged element out from under the pointer —
    // the card "snaps" away and a fresh duplicate is rebuilt in the stack. Leave it be; the drop's own
    // render (drag already ended) rebuilds it correctly. Other decks (incl. the bin) still build.
    if (dragActive && side === draggingSide) return;
    // Honour a user-defined order (from dragging cards around the fanned row); tickets not
    // in that order (new arrivals) keep their incoming order and fall to the end.
    if (deck.order && deck.order.length) {
      const pos = new Map(deck.order.map((id, i) => [id, i]));
      list = list.slice().sort((a, b) =>
        (pos.has(a.id) ? pos.get(a.id) : Infinity) - (pos.has(b.id) ? pos.get(b.id) : Infinity));
    }
    deck.cards.forEach((c) => c.remove());
    deck.cards = list.map((t) => cardEl(t, side));
    deck.cards.forEach((c) => deck.track.appendChild(c));
    deck.cards.forEach(fitCardFields);   // measure in the DOM → expand entries, clamp only on overflow
    // Fresh elements must MATERIALISE in their pile slots, not animate into them from (0,0) — otherwise
    // every render (a ticket moved anywhere, the bin opening…) makes the whole pile jump and resettle.
    // Suppress the transform transition for the initial placement; restore it once that's committed.
    const fresh = deck.cards;
    fresh.forEach((c) => { c.style.transition = "none"; });
    requestAnimationFrame(() => requestAnimationFrame(() => fresh.forEach((c) => { if (c.isConnected) c.style.transition = ""; })));
    // ≤1 card can't be fanned (the fan arrow hides at n≤1), so drop the fan state — otherwise a fanned
    // stack dragged down to its last card stays fanned with no arrow to collapse it, stuck in focus/blur.
    if (deck.cards.length <= 1) { fanned[side] = false; deck.scrollX = 0; }   // keep deck.order (a temporarily-small deck shouldn't forget it)
    layout(side);
  };

  // Ticket ids that already live on the dashboard grid — excluded from the stacks (one
  // canonical ticket). Dragged widgets carry the id in their key (ticket-pin-<id>, set
  // synchronously on drop); every ticket widget also carries data-ticket-id once rendered.
  const onGridIds = () => {
    const ids = new Set();
    document.querySelectorAll(`.dashboard-layout-grid .widget-card[data-widget-key^="${cssEsc(pinPrefix)}"]`).forEach((w) => {
      const k = w.dataset.widgetKey || ""; if (k.length > pinPrefix.length) ids.add(k.slice(pinPrefix.length));
    });
    document.querySelectorAll(`.dashboard-layout-grid .widget-card[data-widget-runtime-type="${cssEsc(widgetType)}"]`).forEach((w) => {
      if (w.dataset.ticketId) ids.add(w.dataset.ticketId);
    });
    return ids;
  };

  // ── Pipeline zones (glass buckets) ───────────────────────────────────────────
  let zonesRoot = null;
  let dragActive = false;     // true while a ticket is mid-drag → route wheel to the bucket under the cursor
  let draggingSide = null;    // which deck owns the in-flight card → its deck is NOT rebuilt mid-drag
  let dragPreviewFn = null;   // (x,y) => recompute the current drag's highlight + sandwich gap (re-run while autoscrolling)
  let deckReorderFn = null;   // () => re-run the fanned-deck reorder at the held cursor (re-run while autoscrolling the deck)
  const zoneBody = {};    // stage key → body element (the scroll viewport)
  const zoneTrack = {};   // stage key → the translated track holding the card stack
  const zoneScroll = {};  // stage key → { sy, ty, raf, wheeling, releaseT } (custom smooth/recoil scroll)

  // ── Bucket scroll (same smooth + rubber-band recoil as the fanned decks, but vertical) ──────
  const zViewH = (s) => zoneBody[s]?.clientHeight || 0;
  const zContentH = (s) => zoneTrack[s]?.offsetHeight || 0;
  const zMin = (s) => Math.min(0, zViewH(s) - zContentH(s));
  const positionZone = (s) => {
    const tr = zoneTrack[s], st = zoneScroll[s], body = zoneBody[s]; if (!tr || !st || !body) return;
    tr.style.transform = `translateY(${Math.round(st.sy)}px)`;
    const view = zViewH(s), content = zContentH(s), min = zMin(s);
    const sb = body.querySelector(".tk-zsb"), th = body.querySelector(".tk-zth");
    const over = content > view + 1;
    sb.classList.toggle("is-on", over);
    if (over) {
      const trackH = view - 8;                                  // the thumb lives INSIDE the inset bar → no extra +4
      const base = Math.max(28, trackH * (view / content));
      // Apple-style overscroll: past an end, the thumb anchors to that end and shrinks by the overscroll
      // amount (and grows back as the recoil settles, since this runs every frame of the scroll loop).
      let thumbH = base, top;
      if (st.sy > 0) { thumbH = Math.max(14, base - st.sy); top = 0; }                       // past the top
      else if (st.sy < min) { thumbH = Math.max(14, base - (min - st.sy)); top = trackH - thumbH; }  // past the bottom
      else { top = (min ? st.sy / min : 0) * (trackH - thumbH); }
      th.style.height = `${Math.round(thumbH)}px`;
      th.style.top = `${Math.round(top)}px`;
    }
    // Edge shadow lives INSIDE each clipped card (a child clipped by the card's overflow+radius): 90°
    // through the body, the card's real corner curve only where the boundary nears a corner, never in gaps.
    const clipR = tr.parentElement.getBoundingClientRect();
    const VT = clipR.top, VB = clipR.bottom, MAXH = 30, SH = "rgba(0,0,0,0.45)";
    tr.querySelectorAll(":scope > .tk-zcard").forEach((card) => {
      const shTop = card.querySelector(":scope > .tk-zs-t"), shBot = card.querySelector(":scope > .tk-zs-b");
      const r = card.getBoundingClientRect();
      if (shTop) {
        if (over && r.top < VT - 0.5 && r.bottom > VT + 0.5) {                    // straddles the clip top
          const ycut = VT - r.top, h = Math.min(MAXH, ycut);
          shTop.style.cssText = `position:absolute;left:0;width:${r.width}px;top:${ycut}px;height:${h}px;background:linear-gradient(to bottom, ${SH}, rgba(0,0,0,0));pointer-events:none;z-index:6;`;
        } else shTop.style.cssText = "position:absolute;width:0;height:0;";
      }
      if (shBot) {
        if (over && r.bottom > VB + 0.5 && r.top < VB - 0.5) {                    // straddles the clip bottom
          const ycut = VB - r.top, h = Math.min(MAXH, r.bottom - VB);
          shBot.style.cssText = `position:absolute;left:0;width:${r.width}px;top:${ycut - h}px;height:${h}px;background:linear-gradient(to bottom, rgba(0,0,0,0), ${SH});pointer-events:none;z-index:6;`;
        } else shBot.style.cssText = "position:absolute;width:0;height:0;";
      }
    });
  };
  const runZoneScroll = (s) => {
    const st = zoneScroll[s]; if (!st || st.raf) return;
    const tick = () => {
      const min = zMin(s), goal = st.wheeling ? st.ty : clamp(st.ty, min, 0);
      st.sy += (goal - st.sy) * 0.22;
      if (!st.wheeling && Math.abs(goal - st.sy) < 0.4) { st.sy = goal; st.ty = goal; positionZone(s); st.raf = 0; return; }
      positionZone(s); st.raf = requestAnimationFrame(tick);
    };
    st.raf = requestAnimationFrame(tick);
  };
  // Kick a smooth scroll that brings `card` fully inside bucket `s`'s clip viewport (e.g. a card just
  // APPENDED below the fold of an overflowing bucket). Returns the y-distance the card will travel —
  // so an in-flight clone can aim at the card's POST-scroll resting rect — or 0 if no scroll is needed.
  const revealZoneShift = (s, card) => {
    const clip = zoneTrack[s]?.parentElement, st = zoneScroll[s];   // .tk-zone-clip
    if (!clip || !st) return 0;
    const cr = card.getBoundingClientRect(), vr = clip.getBoundingClientRect(), PAD = 6;
    let delta = 0;
    if (cr.top < vr.top + PAD) delta = (vr.top + PAD) - cr.top;              // above view → scroll content down
    else if (cr.bottom > vr.bottom - PAD) delta = (vr.bottom - PAD) - cr.bottom;   // below view → scroll up
    const target = clamp(st.sy + delta, zMin(s), 0);
    if (Math.abs(target - st.sy) < 1) return 0;                             // already visible / nowhere to scroll
    st.ty = target; st.wheeling = false; runZoneScroll(s);
    return target - st.sy;
  };
  // Smoothly scroll bucket `s` until `card` is fully inside the clip viewport, then run cb(). If the
  // card is already fully visible (or can't be revealed any further), cb() runs straight away. Used so
  // a click on a partly/entirely scrolled-off ticket brings it into view BEFORE its open animation.
  const revealZoneCard = (s, card, cb) => {
    const st = zoneScroll[s];
    if (!st || !revealZoneShift(s, card)) return cb();
    const target = st.ty;   // revealZoneShift just set the scroll goal
    const waitFor = () => { if (!st.raf || Math.abs(st.sy - target) < 0.8) cb(); else requestAnimationFrame(waitFor); };
    requestAnimationFrame(waitFor);
  };
  const onZoneWheel = (s, e) => {
    if (zContentH(s) <= zViewH(s) + 1) return;   // nothing to scroll
    e.preventDefault();
    const st = zoneScroll[s], min = zMin(s);
    const raw = e.deltaY + e.deltaX;
    const px = e.deltaMode === 1 ? raw * 16 : e.deltaMode === 2 ? raw * zViewH(s) : raw;
    if (!st.raf) st.ty = st.sy;
    st.ty = damp(st.ty - px, min);
    st.wheeling = true;
    clearTimeout(st.releaseT);
    st.releaseT = setTimeout(() => { st.wheeling = false; runZoneScroll(s); }, 90);
    runZoneScroll(s);
  };
  // While a ticket is dragged, the dragged element stays in the DECK's DOM subtree, so wheel events
  // bubble to the deck — never to the bucket the cursor is spatially over (DOM bubbling follows the
  // tree, not z-stacking). This capture-phase router redirects the wheel to the bucket under the
  // cursor so you can scroll a tall bucket to reach a drop slot mid-drag, just like the deck already
  // scrolls while dragging. It only acts during a drag and only over a bucket; otherwise it's a no-op
  // and the deck's own onWheel handles it via bubbling.
  const bucketAtPoint = (x, y) => {
    for (const s of STAGES) {
      const p = zoneBody[s.key]?.parentElement;   // the .tk-zone panel
      if (!p) continue;
      const r = p.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return s.key;
    }
    return null;
  };
  const onDragWheel = (e) => {
    if (!dragActive) return;
    const key = bucketAtPoint(e.clientX, e.clientY);
    if (!key) return;                          // over the deck / elsewhere → its own handler takes it
    e.preventDefault(); e.stopPropagation();   // this wheel belongs to the bucket, not the deck
    onZoneWheel(key, e);
  };
  window.addEventListener("wheel", onDragWheel, { capture: true, passive: false });

  // ── Drag-to-edge autoscroll ──────────────────────────────────────────────────
  // While dragging a ticket, if the cursor enters the hot band near a scrollable edge, keep scrolling
  // that container smoothly to reveal the off-screen drop space — buckets vertically, the fanned deck
  // horizontally. A standalone rAF loop does the scrolling so it continues even when the pointer holds
  // still; speed ramps up the closer the cursor gets to the edge.
  const EDGE_ZONE = 74;   // px from an edge where autoscroll engages
  const EDGE_MAX = 13;    // px/frame at the very edge
  let autoRaf = 0, autoTarget = null, autoVel = 0, autoX = 0, autoY = 0;
  const autoTick = () => {
    autoRaf = 0;
    if (!autoTarget || !autoVel) return;
    if (autoTarget.kind === "zone") {
      const s = autoTarget.key, st = zoneScroll[s];
      if (st) { const min = zMin(s), next = clamp(st.sy + autoVel, min, 0);
        if (next !== st.sy) { st.sy = next; st.ty = next; positionZone(s); } }
    } else {
      const deck = decks[autoTarget.side];
      if (deck) { const min = scrollMinOf(deck), next = clamp(deck.scrollX + autoVel, min, 0);
        if (next !== deck.scrollX) {
          deck.scrollX = next; deck.targetX = next;
          deck.arrow.style.transition = "none";
          positionFan(autoTarget.side);   // scroll = rigid track transform; card .42s transitions untouched → collision keeps animating
          if (deckReorderFn) deckReorderFn();   // re-run the reorder at the held cursor so the gap follows the scroll
        } }
    }
    if (dragPreviewFn) dragPreviewFn(autoX, autoY);   // keep the sandwich gap / highlight under the cursor as content scrolls
    autoRaf = requestAnimationFrame(autoTick);
  };
  const updateAutoScroll = (x, y) => {
    autoX = x; autoY = y; autoTarget = null; autoVel = 0;
    let overBucket = false;
    for (const sdef of STAGES) {
      const p = zoneBody[sdef.key]?.parentElement; if (!p) continue;
      const r = p.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;   // not over this bucket
      overBucket = true;
      const st = zoneScroll[sdef.key], min = zMin(sdef.key);
      if (st && min < 0) {
        if (y < r.top + EDGE_ZONE && st.sy < 0)            // near top → reveal earlier cards (sy → 0)
          { autoTarget = { kind: "zone", key: sdef.key }; autoVel = clamp((r.top + EDGE_ZONE - y) / EDGE_ZONE, 0, 1) * EDGE_MAX; }
        else if (y > r.bottom - EDGE_ZONE && st.sy > min)  // near bottom → reveal later cards (sy → min)
          { autoTarget = { kind: "zone", key: sdef.key }; autoVel = -clamp((y - (r.bottom - EDGE_ZONE)) / EDGE_ZONE, 0, 1) * EDGE_MAX; }
      }
      break;   // cursor is over this bucket → don't also consider the deck
    }
    if (!overBucket) {
      for (const side of DECK_SIDES) {
        const deck = decks[side]; if (!deck || !fanned[side]) continue;
        const min = scrollMinOf(deck); if (min >= 0) continue;
        const nearL = x < EDGE_ZONE, nearR = x > window.innerWidth - EDGE_ZONE;
        const fwd = side === "left" ? nearR : nearL;       // toward the far end → reveal later cards (scrollX → min)
        const bwd = side === "left" ? nearL : nearR;       // toward the anchor → reveal earlier cards (scrollX → 0)
        if (fwd && deck.scrollX > min) {
          const f = nearR ? (x - (window.innerWidth - EDGE_ZONE)) / EDGE_ZONE : (EDGE_ZONE - x) / EDGE_ZONE;
          autoTarget = { kind: "deck", side }; autoVel = -clamp(f, 0, 1) * EDGE_MAX;
        } else if (bwd && deck.scrollX < 0) {
          const f = nearL ? (EDGE_ZONE - x) / EDGE_ZONE : (x - (window.innerWidth - EDGE_ZONE)) / EDGE_ZONE;
          autoTarget = { kind: "deck", side }; autoVel = clamp(f, 0, 1) * EDGE_MAX;
        }
        if (autoTarget) break;
      }
    }
    if (autoTarget && !autoRaf) autoRaf = requestAnimationFrame(autoTick);
  };
  const stopAutoScroll = () => {
    const deckSide = autoTarget && autoTarget.kind === "deck" ? autoTarget.side : null;
    autoTarget = null; autoVel = 0;
    if (autoRaf) { cancelAnimationFrame(autoRaf); autoRaf = 0; }
    if (deckSide) { const deck = decks[deckSide]; if (deck) {   // restore the arrow's transition autoscroll switched off
      deck.arrow.style.transition = ""; deck.targetX = deck.scrollX; } }
  };

  const wireZoneThumb = (s) => {
    const th = zoneBody[s].querySelector(".tk-zth");
    let y0 = 0, start = 0, drag = false;
    const move = (e) => {
      if (!drag) return;
      const st = zoneScroll[s], min = zMin(s), view = zViewH(s), content = zContentH(s);
      const trackH = view - 8, thumbH = Math.max(28, trackH * (view / content));
      const dFrac = (e.clientY - y0) / Math.max(1, trackH - thumbH);
      st.sy = damp(start + dFrac * min, min);
      positionZone(s);
    };
    const up = () => {
      drag = false; window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      const st = zoneScroll[s]; st.wheeling = false; st.ty = st.sy; runZoneScroll(s);
    };
    th.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); drag = true; y0 = e.clientY;
      const st = zoneScroll[s]; cancelAnimationFrame(st.raf); st.raf = 0; clearTimeout(st.releaseT); st.wheeling = false; start = st.sy;
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    });
  };

  // ── Flow arrows: DELETED (FIX_PASS_2 F2). ────────────────────────────────────
  // The stack→bucket→…→resolved guide arrows are tutorial furniture the vision
  // rejects; the empty arrays keep the co-focus plumbing inert.
  let flowSvgs = [];
  // Measure the dashboard grid so the buckets can snap to its columns instead of free-floating.
  const gridGeom = () => {
    const grid = document.querySelector(".dashboard-layout-grid");
    if (!grid) return null;
    const r = grid.getBoundingClientRect();
    if (!r.width) return null;
    const cs = getComputedStyle(grid);
    const parsed = (cs.gridTemplateColumns || "").split(/\s+/).filter((v) => v && v !== "none").length;
    const cols = parsed >= STAGES.length ? parsed : 6;       // dashboard is a 6-column grid
    const gap = parseFloat(cs.columnGap || cs.gap) || MARGIN;
    const colW = (r.width - gap * (cols - 1)) / cols;
    return { left: r.left, colW, gap, cols };
  };
  const ZONE_TOP = 64;        // fixed gap below the round nav buttons
  // Three compact buckets — each just wide enough for one full ticket card — spread across the
  // dashboard grid's extent with EQUAL empty space between them (and at both ends). Vertically
  // they fill from just under the nav buttons down to a MARGIN above the corner stacks.
  const layoutZones = () => {
    if (!zonesEnabled) return;
    if (!zonesRoot) return;
    const zTop = ZONE_TOP, zBottom = CARD_H + MARGIN * 2;      // a MARGIN above the stacks' top card
    const n = STAGES.length, g = gridGeom();
    // Distribute across the grid's horizontal extent (fallback: the viewport minus margins).
    const region = g
      ? { left: g.left, width: g.colW * g.cols + g.gap * (g.cols - 1) }
      : { left: MARGIN, width: window.innerWidth - MARGIN * 2 };
    const bucketW = Math.min(CARD_W + 60, (region.width - MARGIN * (n + 1)) / n);  // one full card + room for the scrollbar
    const gap = (region.width - bucketW * n) / (n + 1);          // equal gap incl. both ends
    const lefts = [];
    STAGES.forEach((s, i) => {
      const left = region.left + gap * (i + 1) + bucketW * i;
      lefts.push(left);
      const panel = zoneBody[s.key]?.parentElement;
      if (!panel) return;
      panel.style.top = `${zTop}px`;                            // fixed panels position themselves now
      panel.style.bottom = `${zBottom}px`;
      panel.style.width = `${Math.round(bucketW)}px`;
      panel.style.left = `${Math.round(left)}px`;
      // Slide the header's bars left so they sit directly above the CENTRED ticket cards' bars (which are
      // at right:13 of a CARD_W-wide card) → the header + every ticket's bars line up in one column. The
      // header's hd-r rests 18px in from the panel edge (14 panel pad + 4 header pad); a centred card's bars
      // rest 13px in → slide by (gap/2 − 5). When a ticket is present, measure its real bars and correct any
      // residual box-model drift (the same measured approach as the scrollbar centring below).
      const hdR = panel.querySelector(".tk-zone-hd-r");
      if (hdR) {
        const base = (bucketW - CARD_W) / 2 - 5;
        hdR.style.marginRight = `${Math.round(base)}px`;
        const cardBars = zoneBody[s.key]?.querySelector(".tk-zcard .tk-bars-card");
        if (cardBars) {
          const delta = hdR.getBoundingClientRect().right - cardBars.getBoundingClientRect().right;
          if (Math.abs(delta) > 0.5) hdR.style.marginRight = `${Math.round(base + delta)}px`;
        }
      }
      // Centre the scrollbar in the gap between the ticket's right edge and the bucket's right edge,
      // letting it sit in the right gutter (the body no longer clips it) for breathing room.
      const body = zoneBody[s.key], sb = body.querySelector(".tk-zsb");
      if (sb) {
        const gutter = panel.getBoundingClientRect().right - body.getBoundingClientRect().right;  // body edge → bucket edge
        const ticketGap = Math.max(0, (body.clientWidth - CARD_W) / 2);                            // ticket edge → body edge
        const center = (ticketGap - gutter) / 2;                                                    // midpoint, left of body's right edge
        sb.style.right = `${Math.round(Math.max(-(gutter - 3), center - 4))}px`;                    // 8px bar centred there, kept inside the bucket
      }
    });
    // Recompute every bucket's scroll edges AND re-clamp its scroll for the new geometry — the deck does
    // the same via updateDeckEdges() at the end of layout(). Without the re-clamp a bucket scrolled to
    // the bottom stays pinned there after the window grows past being scrollable (no way back up).
    STAGES.forEach((s) => clampZoneScroll(s.key));
  };
  // Pull a bucket's scroll back inside [zMin, 0] for the current viewport height, then reposition. Skips
  // while a scroll animation owns st.sy (its own loop clamps). Runs on every resize/reflow → live update.
  const clampZoneScroll = (s) => {
    const st = zoneScroll[s];
    if (st && !st.raf) { st.sy = clamp(st.sy, zMin(s), 0); st.ty = st.sy; }
    positionZone(s);
  };
  const ensureZones = () => {
    if (!zonesEnabled) return;
    if (zonesRoot) return;
    ensureStyles();
    zonesRoot = document.createElement("div");
    zonesRoot.className = "tk-zones";
    STAGES.forEach((s, i) => {
      const panel = document.createElement("div");
      panel.className = "tk-zone";
      panel.dataset.stage = s.key;
      panel.innerHTML = `<div class="tk-zone-hd"><span>${esc(s.label)}</span><span class="tk-zone-hd-r"><span class="tk-zone-count" hidden></span>${barsHTML(bucketBarClasses(i), false)}</span></div>` +
        `<div class="tk-zone-body"><div class="tk-zone-clip"><div class="tk-zone-track"></div></div><div class="tk-zsb"><div class="tk-zth"></div></div></div>`;
      zonesRoot.appendChild(panel);
      zoneBody[s.key] = panel.querySelector(".tk-zone-body");
      zoneTrack[s.key] = panel.querySelector(".tk-zone-track");
      zoneScroll[s.key] = { sy: 0, ty: 0, raf: 0, wheeling: false, releaseT: 0 };
      zoneBody[s.key].addEventListener("wheel", (e) => onZoneWheel(s.key, e), { passive: false });
      // Any change to this bucket's viewport size (window resize, grid reflow, bucket resize) re-runs
      // its edge-shadow math AND re-clamps its scroll live — so growing the window past scrollable
      // never strands the viewport pinned at the old bottom.
      if (window.ResizeObserver) new ResizeObserver(() => clampZoneScroll(s.key)).observe(zoneBody[s.key]);
      wireZoneThumb(s.key);
    });
    ensureTheater().appendChild(zonesRoot);
    layoutZones();
    requestAnimationFrame(layoutZones);              // re-measure once the grid has laid out
    window.addEventListener("resize", layoutZones);
  };

  // Which stage zone (if any) is under the point — the drop target for a ticket drag.
  const zoneAt = (x, y) => {
    for (const s of STAGES) {
      const r = zoneBody[s.key]?.parentElement?.getBoundingClientRect();
      if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return s.key;
    }
    return null;
  };
  // ── Pipeline chain rules ──────────────────────────────────────────────────────
  // A ticket may move FORWARD only one stage at a time, but BACKWARD to ANY earlier stage.
  // Chain positions: inbox/left stack = -1, stages 0…n-1, resolved/right stack = n.
  const stackPos = (side) => (side === "right" ? STAGES.length : -1);
  const posOfStage = (key) => STAGE_KEYS.indexOf(key);
  // A ticket may land anywhere it has EARNED: any bucket at/behind its current position (backward is
  // always fine), or forward up to ONE past its furthest COMPLETED stage. That reach comes from the
  // ticket's data (progressOf), NOT its location — so a ticket that finished triage + investigation keeps
  // the right to drop straight into resolution even after it's thrown back into the left stack.
  const canAdvance = (from, to, t) => {
    if (stageMovement === "free") return to !== from;
    return to < from || to <= progressOf(t) + 1;
  };
  const distToRect = (x, y, r) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
  const HL_RANGE = 260;
  const baseZoneShadow = "inset 0 1px 0 rgba(255,255,255,0.18), 0 18px 42px rgba(0,0,0,0.28)";
  const clearGlow = (p) => { p.style.borderColor = ""; p.style.boxShadow = ""; };
  // Subtle glow on every bucket that intensifies as the cursor nears it: blue where a drop is
  // allowed from `from`, red where it would skip a stage (and so is rejected on release).
  const flowHighlight = (from, x, y, tk) => {
    if (!zonesEnabled) return;
    STAGES.forEach((s, i) => {
      const p = zoneBody[s.key]?.parentElement; if (!p) return;
      if (i === from) { clearGlow(p); return; }                  // the ticket's own bucket → neutral
      const t = clamp(1 - distToRect(x, y, p.getBoundingClientRect()) / HL_RANGE, 0.14, 1);
      if (canAdvance(from, i, tk)) {                             // valid → blue (incl. stage-complete gate)
        p.style.borderColor = `rgba(125,180,255,${(0.2 + 0.72 * t).toFixed(3)})`;
        p.style.boxShadow = `inset 0 0 0 1px rgba(125,180,255,${(0.5 * t).toFixed(3)}), 0 0 ${Math.round(36 * t)}px rgba(90,150,255,${(0.5 * t).toFixed(3)}), ${baseZoneShadow}`;
      } else {                                                   // skips a stage → red (blocked)
        p.style.borderColor = `rgba(255,120,120,${(0.2 + 0.66 * t).toFixed(3)})`;
        p.style.boxShadow = `inset 0 0 0 1px rgba(255,120,120,${(0.5 * t).toFixed(3)}), 0 0 ${Math.round(32 * t)}px rgba(255,80,80,${(0.46 * t).toFixed(3)}), ${baseZoneShadow}`;
      }
    });
  };
  const clearZoneHighlight = () => { if (!zonesEnabled) return; STAGES.forEach((s) => { const p = zoneBody[s.key]?.parentElement; if (p) { p.classList.remove("is-target"); clearGlow(p); } }); };

  const clearLinkHighlight = () => {
    if (linkHighlightEl) linkHighlightEl.classList.remove("tk-link-target");
    linkHighlightEl = null;
  };
  const cardAtPoint = (x, y, ignoreEl = null) => {
    if (!onLinkDrop) return null;
    const oldPointer = ignoreEl ? ignoreEl.style.pointerEvents : "";
    if (ignoreEl) ignoreEl.style.pointerEvents = "none";
    const el = document.elementFromPoint(x, y)?.closest?.(".tk-card, .tk-zcard") || null;
    if (ignoreEl) ignoreEl.style.pointerEvents = oldPointer;
    return el;
  };
  const linkTargetAt = (x, y, record, ignoreEl = null) => {
    const el = cardAtPoint(x, y, ignoreEl);
    const id = el?.dataset?.id || "";
    if (!id || !record || id === record.id) return null;
    const target = tickets.find((x) => x.id === id);
    return target ? { el, target } : null;
  };
  const previewLinkTarget = (x, y, record, ignoreEl = null) => {
    const hit = linkTargetAt(x, y, record, ignoreEl);
    if (hit?.el !== linkHighlightEl) {
      clearLinkHighlight();
      if (hit?.el) {
        linkHighlightEl = hit.el;
        linkHighlightEl.classList.add("tk-link-target");
      }
    }
    return hit;
  };
  const tryLinkDrop = (x, y, record, ignoreEl = null) => {
    const hit = previewLinkTarget(x, y, record, ignoreEl);
    clearLinkHighlight();
    if (!hit) return false;
    onLinkDrop(record, hit.target);
    logActivity(record.id, `Linked to ${titleOf(hit.target)}`);
    render();
    return true;
  };
  let calendarHighlightEl = null;
  let homeStageHighlightEl = null;
  const pointElement = (x, y, ignoreEl = null) => {
    const oldPointer = ignoreEl ? ignoreEl.style.pointerEvents : "";
    if (ignoreEl) ignoreEl.style.pointerEvents = "none";
    const el = document.elementFromPoint(x, y);
    if (ignoreEl) ignoreEl.style.pointerEvents = oldPointer;
    return el;
  };
  const clearCalendarHighlight = () => {
    if (calendarHighlightEl) calendarHighlightEl.classList.remove("is-drop-target");
    calendarHighlightEl = null;
  };
  const calendarTargetAt = (x, y, ignoreEl = null) => {
    if (!onCalendarDrop) return null;
    const el = pointElement(x, y, ignoreEl)?.closest?.(".fc-day[data-date], .fc-day-detail[data-date], .fc-empty[data-date]") || null;
    const date = el?.dataset?.date || "";
    return date ? { el, date } : null;
  };
  const previewCalendarTarget = (x, y, ignoreEl = null) => {
    const hit = calendarTargetAt(x, y, ignoreEl);
    const mark = hit?.el?.closest?.(".fc-day") || hit?.el || null;
    if (mark !== calendarHighlightEl) {
      clearCalendarHighlight();
      calendarHighlightEl = mark;
      if (calendarHighlightEl) calendarHighlightEl.classList.add("is-drop-target");
    }
    return !!hit;
  };
  const tryCalendarDrop = (x, y, record, ignoreEl = null) => {
    const hit = calendarTargetAt(x, y, ignoreEl);
    clearCalendarHighlight();
    if (!hit) return false;
    Promise.resolve(onCalendarDrop(record, hit.date, hit.el)).then((result) => {
      if (result !== false) load();
    }).catch(() => {});
    return true;
  };
  const clearHomeStageHighlight = () => {
    if (homeStageHighlightEl) homeStageHighlightEl.classList.remove("is-target");
    homeStageHighlightEl = null;
  };
  const homeStageTargetAt = (x, y, ignoreEl = null) => {
    if (!onHomeStageDrop) return null;
    const el = pointElement(x, y, ignoreEl)?.closest?.(".tk-zone[data-stage]") || null;
    const stage = el?.dataset?.stage || "";
    return stage ? { el, stage } : null;
  };
  const previewHomeStageTarget = (x, y, record, ignoreEl = null) => {
    if (!record) return false;
    const hit = homeStageTargetAt(x, y, ignoreEl);
    if (hit?.el !== homeStageHighlightEl) {
      clearHomeStageHighlight();
      homeStageHighlightEl = hit?.el || null;
      if (homeStageHighlightEl) homeStageHighlightEl.classList.add("is-target");
    }
    return !!hit;
  };
  const tryHomeStageDrop = (x, y, record, ignoreEl = null) => {
    const hit = homeStageTargetAt(x, y, ignoreEl);
    clearHomeStageHighlight();
    if (!hit) return false;
    Promise.resolve(onHomeStageDrop(record, hit.stage, hit.el)).then((result) => {
      if (result !== false) load();
    }).catch(() => {});
    return true;
  };

  // Depth-of-field for a drag OUT of a fanned stack: bring ONLY the buckets this ticket may legally land
  // in (per canAdvance) into focus — they lift ABOVE the scrim (sharp); the rest rest below it and the
  // scrim blurs them cleanly. Each on-path arrow lifts above the scrim (sharp) too, the off-path ones
  // rest below it (scrim-blurred) — so every arrow's blur MATCHES its bucket and none morph or vanish.
  // Chain nodes are [inbox, …buckets…, resolved]; arrow k joins node k→k+1, so the on-path segments are
  // the run [min,max) between the stack's node and a reachable bucket's node.
  const focusDropTargets = (from, t) => {
    if (!zonesEnabled) return;
    const fromNode = from < 0 ? 0 : from + 1;
    const liveArrows = new Set();
    setBucketSharp((i) => {
      const ok = canAdvance(from, i, t);
      if (ok) { const to = i + 1, lo = Math.min(fromNode, to), hi = Math.max(fromNode, to); for (let a = lo; a < hi; a++) liveArrows.add(a); }
      return ok;
    });
    setArrowSharp((i) => liveArrows.has(i));   // on-path arrows lift sharp; the rest stay scrim-blurred
  };
  const clearDropFocus = () => {
    if (!zonesEnabled) return;
    hoverPrev = null;     // a drag just ended → let the next hover re-preview from scratch
    setBucketSharp(() => false);
    setArrowSharp(() => false);
    applyBucketFocus();   // hand focus back to the normal (cursor-driven) co-focus
  };

  // A zone card is a FULL ticket card — identical layout/size to a corner-stack card.
  const zoneCardInner = (t) => cardInner(t);

  // Drag a zone card to ANOTHER zone (reassign stage), DOWN onto the corner stacks (un-assign
  // → back to the inbox), or release on its own zone / nowhere (snap back). Click opens config.
  const wireZoneCard = (card, t, stage) => {
    let down = false, dragging = false, sx = 0, sy = 0, clone = null, fanGap = null, r0 = null;
    // The fanned deck this ticket would re-join (its own side, when that side is the open fan), else null.
    const fanTarget = () => { const fs = fanned.left ? "left" : (rightDeckEnabled && fanned.right ? "right" : null); return fs && fs === deckSideFor(t) ? fs : null; };
    // Pick the right preview for the cursor: over the matching fanned stack → part its cards at the
    // insert slot (the deck's own .42s collision); otherwise the bucket "sandwich" gap + zone glow.
    const preview = (x, y) => {
      const ft = (y >= stackTopY()) ? fanTarget() : null;
      if (ft) { clearZoneHighlight(); clearGap(); fanGap = ft; previewFanGap(ft, fanInsertIndex(ft, x)); return; }
      if (fanGap) { layout(fanGap); fanGap = null; }   // moved off the stack → close the fan gap
      // A fully-completed ticket hovering the RIGHT (resolved) pile → light it as the eligible drop target.
      setStackDrop(rightDeckEnabled && y >= stackTopY() && canResolveRecord(t) && overCornerStack(x, y) === "right" ? "right" : null);
      flowHighlight(posOfStage(stage), x, y, t);
      const dt = dropTarget(posOfStage(stage), x, y, t);
      if (dt) previewGap(dt.stage, dt.index); else clearGap();
    };
    const onMove = (e) => {
      if (!down) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!dragging && Math.hypot(dx, dy) > 6) {
        dragging = true; dragActive = true;
        // Depth-of-field for the WHOLE drag: eligible buckets (+ their arrow chain) lift above the scrim
        // (sharp), everything else rests below it — and the scrim engages even with no stack fanned.
        focusDropTargets(posOfStage(stage), t);
        if (stackScrim) stackScrim.style.backdropFilter = stackScrim.style.webkitBackdropFilter = "blur(4px)";
        r0 = card.getBoundingClientRect();
        clone = document.createElement("div");
        clone.className = "tk-zfly";
        // `translate` follows the cursor instantly; `scale` is the ONLY transitioned property → a smooth
        // lift-off (and, on drop, a smooth settle). Using the individual props keeps the two independent.
        clone.style.cssText = `left:${r0.left}px; top:${r0.top}px; width:${r0.width}px; height:${r0.height}px; translate:0px 0px; scale:1; transition: scale .16s ease;`;
        clone.style.backgroundColor = baseColor();
        clone.style.backgroundImage = cardBg(t);
        applyStaleness(clone, t);
        clone.innerHTML = zoneCardInner(t);
        ensureTheater().appendChild(clone);
        fitCardFields(clone);
        card.classList.add("tk-zdrag");
        dragPreviewFn = preview;                 // re-run while autoscrolling so the gap follows the cursor
        requestAnimationFrame(() => { if (clone) clone.style.scale = "1.04"; });   // ease up off the bucket
      }
      if (!dragging) return;
      clone.style.translate = `${dx}px ${dy}px`;   // instant follow (translate isn't transitioned)
      updateAutoScroll(e.clientX, e.clientY);   // scroll a bucket/deck if the cursor nears a scrollable edge
      // Over the recycle bin → ring it open / target it, and skip the bucket/fan preview.
      if (trashDragMove(e.clientX, e.clientY)) { clearZoneHighlight(); clearGap(); if (fanGap) { layout(fanGap); fanGap = null; } return; }
      if (previewLinkTarget(e.clientX, e.clientY, t, clone || card)) { clearZoneHighlight(); clearGap(); if (fanGap) { layout(fanGap); fanGap = null; } return; }
      preview(e.clientX, e.clientY);
    };
    // Settle the dragged clone smoothly into the ticket's resting card (its new slot after a drop, or
    // back home on a snap-back), then swap to the real card — scale eases back to fit, opacity → solid.
    const settleClone = (id) => {
      const cl = clone; clone = null;
      if (!cl) return;
      const dest = document.querySelector(`.tk-zcard[data-id="${cssEsc(id)}"], .tk-card[data-id="${cssEsc(id)}"]`);
      const to = (dest && dest.isConnected) ? dest.getBoundingClientRect() : null;
      if (!to || to.width < 4 || !r0) { cl.remove(); return; }
      // Landed in a bucket (appended below the fold?) → smooth-scroll it fully into view, and aim
      // the settle at the card's POST-scroll rect so clone and card meet where the scroll ends.
      const zs = dest.classList.contains("tk-zcard") ? STAGE_KEYS.find((k) => zoneTrack[k]?.contains(dest)) : null;
      const shift = zs ? revealZoneShift(zs, dest) : 0;
      dest.style.opacity = "0";   // hide the real card until the clone lands on it
      cl.style.transition = "translate .2s cubic-bezier(.4,0,.2,1), scale .2s cubic-bezier(.4,0,.2,1), opacity .2s ease";
      requestAnimationFrame(() => {
        cl.style.translate = `${Math.round(to.left - r0.left)}px ${Math.round(to.top + shift - r0.top)}px`;
        cl.style.scale = `${(to.width / r0.width).toFixed(4)} ${(to.height / r0.height).toFixed(4)}`;
        cl.style.opacity = "1";
      });
      setTimeout(() => { cl.remove(); if (dest.isConnected) dest.style.opacity = ""; }, shift ? 440 : 220);   // shifted → wait for the scroll to settle under the clone
    };
    const onUp = (e) => {
      window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
      // Trash target BEFORE dragActive resets (keeps the drag-time catch pad live at release).
      const overTrash = dragging && overTrashTarget(e.clientX, e.clientY);
      const wasDrag = dragging; dragging = false; down = false; dragActive = false; stopAutoScroll(); dragPreviewFn = null; stopTrashRing(); setStackDrop(null); clearLinkHighlight();
      if (wasDrag) { clearDropFocus(); updateStackFocus(); }   // drop the drag DoF: focus back to normal, scrim back to fan/bin state
      clearZoneHighlight(); clearGap();
      if (fanGap) { layout(fanGap); fanGap = null; }
      if (!wasDrag) {   // a plain click — no drag clone to settle
        if (clone) { clone.remove(); clone = null; }
        card.classList.remove("tk-zdrag");
        revealZoneCard(stage, card, () => detail?.open(t, card));   // scroll into view, then open
        return;
      }
      // Dropped on the recycle bin (icon, open stack, or empty placeholder) → delete it into the bin.
      if (overTrash) { const r = clone ? clone.getBoundingClientRect() : card.getBoundingClientRect(); if (clone) { clone.remove(); clone = null; } card.classList.remove("tk-zdrag"); dropTicketToTrash(t, r); return; }
      if (tryLinkDrop(e.clientX, e.clientY, t, clone || card)) { if (clone) { clone.remove(); clone = null; } card.classList.remove("tk-zdrag"); return; }
      // A real drag → apply the drop, render, then SETTLE the clone into the ticket's resting card.
      // Released over the matching fanned stack → splice into its row at the cursor slot, un-assigning
      // the stage so the ticket re-joins the inbox deck exactly there.
      const ft = (e.clientY >= stackTopY()) ? fanTarget() : null;
      if (ft) {
        const deck = decks[ft];
        const ids = deck.cards.map((c) => c.dataset.id).filter((id) => id && id !== t.id);
        ids.splice(clamp(fanInsertIndex(ft, e.clientX), 0, ids.length), 0, t.id);
        deck.order = ids; saveOrder(ft);
        setStage(t.id, null); setStageAt(t.id, null); render(); settleClone(t.id); return;
      }
      const dt = dropTarget(posOfStage(stage), e.clientX, e.clientY, t);   // valid bucket (reorder or legal step) + layer
      if (dt) {
        if (dt.stage !== stage) logActivity(t.id, `Moved to ${STAGES.find((s) => s.key === dt.stage)?.label || dt.stage}`);
        setStage(t.id, dt.stage); setStageAt(t.id, dt.stage, dt.index); render(); settleClone(t.id); return;
      }
      if (e.clientY >= stackTopY()) {
        // Dropped on the RIGHT (resolved) pile with EVERY stage complete (3 green bars) → RESOLVE it:
        // flip the state (locally for the instant render + in the store) so the render routes it into
        // the resolved pile — without this, the state-gated left/right split sent it to the inbox.
        if (rightDeckEnabled && overCornerStack(e.clientX, e.clientY) === "right" && canResolveRecord(t)) {
          t.state = resolvedState; const live = tickets.find((x) => x.id === t.id); if (live) live.state = resolvedState;
          try { source?.resolve?.(t.id); } catch {}
          setStage(t.id, null); setStageAt(t.id, null);
          deckToTop("right", t.id);   // newest resolve → TOP of the pile (highest z)
          render(); settleClone(t.id); setTimeout(() => pulseResolvedPile(t.id), 240); return;
        }
        if (stageOf(t.id)) logActivity(t.id, "Moved back to the new-tickets stack");
        setStage(t.id, null); setStageAt(t.id, null);
        deckToTop(deckSideFor(t), t.id);   // re-enters the pile as its TOP card (highest z)
        render(); settleClone(t.id); return;
      }
      render(); settleClone(t.id);   // a blocked (red) zone / nowhere → rebuild in place + settle home
    };
    card.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      down = true; dragging = false; sx = e.clientX; sy = e.clientY;
      window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
    });
  };

  const zoneCardEl = (t, stage) => {
    const card = document.createElement("div");
    card.className = `tk-zcard tk-zcard-${widgetType}`;
    card.dataset.id = t.id || "";
    card.style.width = `${CARD_W}px`; card.style.height = `${CARD_H}px`;   // full ticket dimensions
    card.style.backgroundColor = baseColor();
    card.style.backgroundImage = cardBg(t);
    applyStaleness(card, t);
    card.innerHTML = zoneCardInner(t);
    card.insertAdjacentHTML("beforeend", '<div class="tk-edge-shade tk-zs-t"></div><div class="tk-edge-shade tk-zs-b"></div>');   // top/bottom scroll shadows (clipped to this card)
    wireZoneCard(card, t, stage);
    wireContextMenu(card, t);   // right-click menu (edit / appearance / delete)
    return card;
  };

  // Which layer a drop at viewport-y lands on within a bucket: the peek band under the cursor,
  // or the bottom (== card count) when it's below the stack — so an indiscriminate drop appends.
  const zoneInsertIndex = (stage, y) => {
    const body = zoneBody[stage], track = zoneTrack[stage]; if (!body || !track) return 0;
    const r = body.getBoundingClientRect();
    const count = track.querySelectorAll(".tk-zcard").length;
    const sy = zoneScroll[stage]?.sy || 0;   // track is translated by sy → undo it to get content-y
    return clamp(Math.floor((y - r.top - sy) / ZCARD_PEEK), 0, count);
  };
  // Live "sandwich" preview: while dragging over a bucket, cards at/after the insert layer slide
  // down (collision) to open a gap where the ticket will drop. No gap when appending to the bottom.
  let gapStage = null;
  const clearGap = () => {
    if (!gapStage) return;
    const s = gapStage;
    zoneTrack[s]?.querySelectorAll(".tk-zcard").forEach((c) => { c.style.transform = ""; });
    gapStage = null;
    positionZone(s);   // cards moved back → refresh this bucket's edge shadows
  };
  const previewGap = (stage, index) => {
    if (gapStage && gapStage !== stage) clearGap();
    gapStage = stage;
    (zoneTrack[stage]?.querySelectorAll(".tk-zcard") || []).forEach((c, i) => {
      c.style.transform = i >= index ? `translateY(${ZCARD_PEEK}px)` : "";
    });
    positionZone(stage);   // sandwich gap shifted cards → shadows track the reorder live
  };
  // The droppable bucket + insert index under (x,y) for a drag from chain position `from` — or null.
  // A ticket ENTERING a bucket (from a stack or another bucket) always APPENDS: it becomes the
  // visually-bottom card, which is the z-TOPMOST, fully-shown one. Only a same-bucket reorder
  // inserts at the layer under the cursor.
  const dropTarget = (from, x, y, tk) => {
    if (!zonesEnabled) return null;
    const z = zoneAt(x, y);
    if (!z) return null;
    const to = posOfStage(z);
    if (from !== to && !canAdvance(from, to, tk)) return null;   // same stage = reorder; else a legal (gated) step
    // 1e9 = "after everything": setStageAt clamps to the PERSISTED order's length, which can hold
    // stale ids (trashed / off-board tickets keep their slot) beyond the rendered cards — a rendered
    // count would splice in front of those and the entering card wouldn't render last.
    const index = from === to ? zoneInsertIndex(z, y) : 1e9;
    return { stage: z, index };
  };

  const renderZones = () => {
    if (!zonesEnabled) return;
    ensureZones();
    const byCreated = (a, b) => (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0);
    STAGES.forEach((s) => {
      const body = zoneBody[s.key], track = zoneTrack[s.key];
      const ord = stageOrder[s.key] || [];
      const oidx = (t) => {
        const i = ord.indexOf(t.id);
        if (i !== -1) return i;
        return Number.isFinite(t.stageRank) ? t.stageRank : 1e9;
      };   // unordered → bottom
      const list = tickets.filter((t) => stageOf(t.id) === s.key && !isDeleted(t.id) && !inAttentionDeck(t))
        .sort((a, b) => oidx(a) - oidx(b) || byCreated(a, b));
      const count = body.parentElement.querySelector(".tk-zone-count");
      if (count) {
        let summary = "";
        try { summary = bucketSummary ? bucketSummary(s, list, { metaOf, stageOf, isResolved, stalenessOf }) : ""; } catch { summary = ""; }
        count.textContent = String(summary || "");
        count.hidden = !summary;
      }
      track.innerHTML = "";   // FIX_PASS_2 F2: an empty bucket is an empty glass bucket — no watermark
      // Stack the cards with overlap: each sits ZCARD_PEEK below the previous (covering all but the
      // one-below's title) and on top of it, so only titles peek until the last, fully-shown card.
      list.forEach((t, i) => {
        const card = zoneCardEl(t, s.key);
        if (i > 0) card.style.marginTop = `-${CARD_H - ZCARD_PEEK}px`;
        card.style.zIndex = String(i + 1);
        track.appendChild(card);
        fitCardFields(card);   // measure in the DOM → expand entries, clamp only on overflow
      });
      const st = zoneScroll[s.key];   // re-clamp scroll to the new content height + reposition
      if (st) { st.sy = clamp(st.sy, zMin(s.key), 0); st.ty = st.sy; positionZone(s.key); }
    });
  };

  // Drop a ticket dragged from a corner stack into a zone: assign the stage, leave the stack,
  // and fly a shrinking clone from the drop point into its new card in the zone.
  const dropIntoZone = (fromCard, t, stage, index) => {
    const from = fromCard.getBoundingClientRect();
    setDeleted(t.id, false);   // entering the pipeline un-deletes (a ticket can't be both staged and trashed)
    if (stageOf(t.id) !== stage) logActivity(t.id, `Moved to ${STAGES.find((s) => s.key === stage)?.label || stage}`);
    setStage(t.id, stage);
    setStageAt(t.id, stage, index);   // entering → appended to the bottom (z-topmost, fully-shown card)
    render();
    const dest = zoneTrack[stage]?.querySelector(`.tk-zcard[data-id="${cssEsc(t.id)}"]`);
    if (!dest) return;
    // The appended card may land below the bucket's fold — smooth-scroll it into view while the clone
    // flies, and aim the flight at the card's POST-scroll resting rect so the two meet exactly.
    const shift = revealZoneShift(stage, dest);
    const to = dest.getBoundingClientRect();
    const clone = document.createElement("div");
    clone.className = "tk-zfly";
    clone.style.cssText = `left:${from.left}px; top:${from.top}px; width:${from.width}px; height:${from.height}px; transform-origin: top left;`;
    clone.style.backgroundColor = baseColor();
    clone.style.backgroundImage = cardBg(t);
    applyStaleness(clone, t);
    clone.innerHTML = zoneCardInner(t);
    ensureTheater().appendChild(clone);
    fitCardFields(clone);
    dest.style.opacity = "0";
    requestAnimationFrame(() => {
      clone.style.transform = `translate(${to.left - from.left}px, ${to.top + shift - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`;
    });
    setTimeout(() => { clone.remove(); if (dest.isConnected) dest.style.opacity = ""; }, shift ? 460 : 300);   // shifted → wait for the scroll to settle under the clone
  };
  const autoFanDue = (count) => {
    if (!autoFanOncePerDayKey || !count) return false;
    const today = localDate();
    try {
      if (localStorage.getItem(autoFanOncePerDayKey) === today) return false;
      localStorage.setItem(autoFanOncePerDayKey, today);
      return true;
    } catch {
      return false;
    }
  };

  const render = () => {
    if (!active) { applyActiveVisibility(); return; }
    ensureRoot(); ensureZones();
    applyActiveVisibility();
    matchCardSize(); sizeRoot(); layoutZones(); syncDropFloor();
    const onGrid = onGridIds();
    const order = (a, b) => (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0);
    // Staged tickets live in their zone; the rest sit in the corner stacks (the inbox). Deleted
    // tickets are hidden everywhere EXCEPT the right stack when it's flipped to trash mode.
    const avail = tickets.filter((t) => !onGrid.has(t.id) && !isDeleted(t.id) && (!stageOf(t.id) || inAttentionDeck(t)));
    const leftList = avail.filter(leftDeckFilter).sort(order);
    if (autoFanDue(leftList.length)) fanned.left = true;
    buildDeck("left", leftList);
    // The right stack is the recycle bin when toggled (its DELETED tickets, blue-outlined), else the
    // resolved/closed pile — same stack mechanics either way (fan, scroll, drag, reorder).
    if (decks.right) buildDeck("right", rightDeckEnabled ? avail.filter(rightDeckFilter).sort(order) : []);   // resolved pile ALWAYS stays when enabled
    // The recycle bin is its OWN stack, lifted above the icon and shown only when toggled — the resolved
    // pile below it never disappears. It fans/scrolls/drags exactly like the corner stacks.
    const deleted = trashEnabled ? tickets.filter((t) => isDeleted(t.id)).sort(order) : [];
    if (decks.trash) buildDeck("trash", trashMode ? deleted : []);
    if (decks.trash?.box) decks.trash.box.style.transform = `translateY(-${Math.round(CARD_H + 62)}px)`;
    // Once the bin actually holds cards, the deliberate-empty intent is spent — so emptying it later
    // (restoring the last card) falls back to the normal auto-close below.
    if (deleted.length) trashShowEmpty = false;
    // An empty bin closes itself (e.g. after restoring the last deleted ticket).
    // FIX_PASS_2 F2: the "get added here" placeholder is gone — the bin icon
    // (with its blue active ring) is all the empty-bin state there is.
    if (trashMode && !deleted.length && !trashShowEmpty) { trashMode = false; fanned.trash = false; decks.right?.action?.classList.remove("is-active"); }
    updateStackFocus();
    renderZones();
    // A just-created ticket: once its card has spawned into the left stack, let it settle, then
    // fly it to the centre and expand its config. Creating fires several re-renders that REPLACE
    // the card element, so re-query the LIVE node at fire time — a detached node has a 0-rect and
    // the flyer would grow from (0,0).
    if (pendingOpenId && decks.left?.box?.querySelector(`.tk-card[data-id="${cssEsc(pendingOpenId)}"]`)) {
      const id = pendingOpenId; pendingOpenId = null;
      const tryOpen = (tries) => {
        const card = decks.left?.box?.querySelector(`.tk-card[data-id="${cssEsc(id)}"]`);
        const tk = tickets.find((x) => x.id === id);
        if (card && card.isConnected && card.getBoundingClientRect().width > 10 && tk) {
          // A brand-new ticket opens as a DRAFT: its config must be saved (all create fields filled) to
          // commit it; closing/cancelling flies the card back INTO the "+" and discards it entirely.
          const opts = id === draftId ? {
            draft: true,
            homeRect: () => decks.left?.action?.getBoundingClientRect() || null,
            onCommit: () => { if (draftId === id) draftId = null; },
            onAbandon: () => { if (draftId === id) draftId = null; discardDraft(id); },
          } : undefined;
          detail?.open?.(tk, card, opts);
        } else if (tries > 0) setTimeout(() => tryOpen(tries - 1), 120);
      };
      setTimeout(() => tryOpen(8), 420);
    }
  };

  // The left "+": spawn the real ticket into the inbox stack, then (once its card has landed) fly it to
  // the centre and expand its config — where the client, incident date and description are filled in (the
  // "new ticket" stage of the config; see stageFields). No pre-baked modal.
  const openCreate = async () => {
    if (!createEnabled) return;
    if (draftId) return;   // one draft at a time
    let tk = null;
    try { const res = await source?.create?.(createDraftFields()); tk = recordFromCreate(res); } catch {}
    if (tk && tk.id) { pendingOpenId = tk.id; draftId = tk.id; deckToTop("left", tk.id); }   // new ticket → TOP of the inbox pile
    load();   // re-fetch + render; render() flies the new card out and opens its config as a draft
  };
  // Abandon a never-completed draft: hard-remove the backend ticket and forget every client-side trace,
  // so a cancelled create leaves nothing behind. The card has already flown back into the "+" by now.
  const discardDraft = (id) => {
    forgetClientState(id);
    try { source?.remove?.(id); } catch {}
    tickets = tickets.filter((x) => x.id !== id);   // drop locally so the re-render is instant
    render();
  };

  const load = async () => {
    try { const r = await source?.list?.(); tickets = recordsFromList(r); }
    catch { tickets = []; }
    migrateLegacyFaces();
    render();
    if (!subscribed) {
      subscribed = true;
      // While the config is open, the card the detail panel is animating from must NOT be rebuilt
      // (that detaches it → a copy snaps back to the stack). Defer the render until the panel closes.
      source?.onChanged?.((payload) => {
        tickets = recordsFromList(payload);
        if (detail?.isOpen?.()) { pendingRender = true; return; }
        render();
      });
    }
  };

  // delete/restore are the trash flag (NOT tickets.remove) so the ticket survives in the trash.
  publicApi = {
    reload: load,
    fan: setFan,
    create: openCreate,
    openCreate,
    isDeleted,
    delete: (id) => { setMeta(id, { delStage: stageOf(id) || "" }); setDeleted(id, true); render(); },   // remember which bucket it died in (red bar)
    // Send the ticket back to exactly where it was deleted from: its bucket (as the visual-TOP card, i.e.
    // bottom-most z / index 0), or the corner stack it lived in (left inbox / right resolved, by state).
    // It SLIDES there from the bin, and the depth-of-field opens up to keep the bin AND the destination
    // in focus during the flight, then settles back onto just the bin.
    restore: (id) => {
      const t = tickets.find((x) => x.id === id);
      const ds = (metaOf(id) || {}).delStage || "";
      const fromCard = decks.trash?.box?.querySelector(`.tk-card[data-id="${cssEsc(id)}"]`);
      const from = fromCard ? fromCard.getBoundingClientRect() : null;
      setDeleted(id, false);
      logActivity(id, "Restored from the trash");
      if (ds && STAGE_KEYS.includes(ds)) { setStage(id, ds); setStageAt(id, ds, 0); }
      else { setStage(id, null); setStageAt(id, null); }
      render();
      const dest = document.querySelector(`.tk-zcard[data-id="${cssEsc(id)}"], .tk-deck-left .tk-card[data-id="${cssEsc(id)}"], .tk-deck-right .tk-card[data-id="${cssEsc(id)}"]`);
      const to = dest ? dest.getBoundingClientRect() : null;
      if (!t || !from || !to || to.width < 4) return;   // can't animate → it's already placed
      // Focus shift: bring the destination above the DoF scrim so it's sharp alongside the bin.
      const destZone = dest.classList.contains("tk-zcard"), destDeck = destZone ? null : dest.closest(".tk-deck");
      const destPanel = destZone ? dest.closest(".tk-zone") : null;
      if (destPanel) destPanel.classList.add("tk-sharp"); else if (destDeck) destDeck.style.zIndex = "3";
      dest.style.opacity = "0";   // hide the real card until the slide lands on it
      const clone = document.createElement("div");
      clone.className = "tk-zfly";
      clone.style.cssText = `left:${from.left}px; top:${from.top}px; width:${Math.round(from.width)}px; height:${Math.round(from.height)}px; transform-origin: top left; z-index: 6000; opacity: 1; transition: transform .46s cubic-bezier(.4,0,.2,1);`;
      clone.style.backgroundColor = baseColor();
      clone.style.backgroundImage = cardBg(t);
      applyStaleness(clone, t);
      clone.innerHTML = cardInner(t);
      ensureTheater().appendChild(clone);
      fitCardFields(clone);
      requestAnimationFrame(() => {
        clone.style.transform = `translate(${Math.round(to.left - from.left)}px, ${Math.round(to.top - from.top)}px) scale(${(to.width / from.width).toFixed(4)}, ${(to.height / from.height).toFixed(4)})`;
      });
      setTimeout(() => {
        clone.remove();
        if (dest.isConnected) dest.style.opacity = "";
        if (destPanel) destPanel.classList.remove("tk-sharp"); else if (destDeck) destDeck.style.zIndex = "";
        updateStackFocus();   // settle the focus back onto just the bin
      }, 480);
    },
    metaOf,
    stageOf: (id) => stageOf(id),
    // The current bucket's fields (config shows only these) — default to triage for an inbox ticket.
    stageFields: (id) => {
      const key = stageOf(id);
      if (!key) return { key: "new", label: createStageLabel, fields: CREATE_FIELDS };   // inbox / not yet staged → the creation details
      const st = STAGES.find((s) => s.key === key);
      return { key, label: st ? st.label : key, fields: STAGE_FIELDS[key] || [] };
    },
    fieldValue: (id, key) => { const t = tickets.find((x) => x.id === id); return t ? fieldRaw(t, key) : ((metaOf(id) || {})[key] || ""); },
    // Persist the override and update the card's text + PROGRESS BARS IN PLACE (no rebuild) so live edits
    // from the open config don't detach the card the detail panel is animating from.
    setMeta: (id, m) => {
      setMeta(id, m);
      const t = tickets.find((x) => x.id === id); if (!t) return;
      document.querySelectorAll(`.tk-card[data-id="${cssEsc(id)}"], .tk-zcard[data-id="${cssEsc(id)}"]`).forEach((c) => {
        const co = c.querySelector(".ticket-company");
        if (co) co.textContent = titleOf(t);   // client only; the date lives in its own pinned element
        const du = c.querySelector(".tk-date-under"), duh = dateUnderHTML(t);   // date (+ resolution info) under the bars
        if (du) du.remove();
        if (duh) c.insertAdjacentHTML("beforeend", duh);
        const body = c.querySelector(".ticket-body"); let ho = c.querySelector(".ticket-host");
        const sub = subOf(t);
        if (sub) { if (!ho && body) { ho = document.createElement("div"); ho.className = "ticket-host"; body.insertBefore(ho, body.querySelector(".ticket-fields")); } if (ho) ho.textContent = sub; }
        else if (ho) ho.remove();   // n/a / empty → drop the line entirely (no placeholder)
        let ff = c.querySelector(".ticket-fields"); const fh = faceRowsHTML(t);   // entity field rows from the face contract
        if (ff) ff.innerHTML = fh; else if (body) body.insertAdjacentHTML("beforeend", `<div class="ticket-fields">${fh}</div>`);
        const oldBadges = c.querySelector(".ticket-face-badges");
        const newBadges = faceBadgesHTML(t);
        if (oldBadges) oldBadges.outerHTML = newBadges;
        else if (newBadges && body) body.insertAdjacentHTML("beforeend", newBadges);
        const bars = c.querySelector(".tk-bars-card"), html = barsHTML(ticketBarClasses(t), true);
        if (bars) bars.outerHTML = html; else c.insertAdjacentHTML("beforeend", html);
        fitCardFields(c);   // re-fit: the text just changed (expand what fits, clamp the longest if not)
      });
    },
    // Severity → recolour + refresh the card(s) IN PLACE (like setMeta) and persist the priority,
    // WITHOUT a rebuild — so the open config's source card stays put (no snap-back copy). The persist
    // fires onChanged, which is deferred while the config is open (see the subscription above).
    setPriority: (id, val) => {
      const t = tickets.find((x) => x.id === id); if (!t || priorityOf(t) === val) return;
      logActivity(id, `Severity set to ${val}`);
      setMeta(id, { priority: val });   // persist in localStorage meta (survives refresh, like every other stage field)
      t.priority = val;                 // keep the in-memory store copy in sync (colour + cross-app)
      document.querySelectorAll(`.tk-card[data-id="${cssEsc(id)}"], .tk-zcard[data-id="${cssEsc(id)}"]`).forEach((c) => {
        c.style.backgroundImage = cardBg(t);
        applyStaleness(c, t);
        const bars = c.querySelector(".tk-bars-card"), html = barsHTML(ticketBarClasses(t), true);
        if (bars) bars.outerHTML = html; else c.insertAdjacentHTML("beforeend", html);
      });
      try { source?.update?.(id, { priority: val }); } catch {}
    },
    // The detail panel closed → run any render that was deferred while it was open.
    onDetailClosed: () => { if (pendingRender) { pendingRender = false; render(); } },
  };
  publicApi.setActive = (on) => {
    active = !!on;
    if (active) {
      if (!started) {
        started = true;
        load();
      } else {
        render();
      }
    } else {
      applyActiveVisibility();
      hideTicketMenu();
      clearDropFocus();
      clearGap();
      if (detail?.isOpen?.()) detail.close?.();
    }
    return publicApi;
  };
  publicApi.isActive = () => active;
  if (instanceGlobal) global[instanceGlobal] = publicApi;
  const start = () => {
    if (started || !active) return;
    started = true;
    load();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
  return publicApi;
};
})(window);
