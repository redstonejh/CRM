// ticket-stacks.js — two corner "decks" of ticket cards.
//   bottom-LEFT  = unresolved tickets (active queue), fans out to the RIGHT
//   bottom-RIGHT = resolved tickets,                  fans out to the LEFT
// Cards are the SAME size/shape as the dashboard ticket widget. They stack askew; the top
// one can be clicked or dragged onto the dashboard grid — dropping it there flies it into
// the grid ticket cell ("brings it into the dashboard"). An arrow on the open side fans
// the deck out into a horizontal row along the bottom; if the row overflows, a sleek
// scrollbar appears beneath it and the wheel scrolls it side to side.
(() => {
  let CARD_W = 185, CARD_H = 279;          // matched to the grid ticket card at render time
  const MARGIN = 18, GAP_FAN = 10, RADIUS = 15;
  const ZCARD_PEEK = 42;   // height of a zone card's title that peeks above the card stacked on it
  const EASE = "cubic-bezier(.22, 1, .26, 1)";
  const SEV_RGB = { low: "34,211,238", medium: "250,204,21", high: "249,115,22", critical: "239,68,68", none: "120,130,140" };
  const sevOf = (t) => (t && ["low", "medium", "high", "critical"].includes(t.priority)) ? t.priority : (t ? "medium" : "none");

  // Persist the per-deck custom card order (from drag-to-reorder) across reloads.
  const ORDER_KEY = (side) => `tk-stack-order-${side}`;
  const loadOrder = (side) => { try { const v = JSON.parse(localStorage.getItem(ORDER_KEY(side)) || "null"); return Array.isArray(v) ? v : null; } catch { return null; } };
  const saveOrder = (side) => { try { localStorage.setItem(ORDER_KEY(side), JSON.stringify(decks[side]?.order || [])); } catch {} };

  // Pipeline stages — the glass "bucket" zones on the dashboard. A ticket dragged into a
  // zone is assigned that stage (persisted by id); unassigned tickets live in the corner
  // stacks (the inbox). cssEsc guards attribute selectors built from ticket ids.
  const cssEsc = (window.CSS && CSS.escape) ? (s) => CSS.escape(s) : (s) => String(s).replace(/["\\\]]/g, "\\$&");
  const STAGES = [
    { key: "triage", label: "Triage" },
    { key: "investigation", label: "Investigation" },
    { key: "resolution", label: "Resolution" },
  ];
  const STAGE_KEYS = STAGES.map((s) => s.key);
  const STAGE_STORE = "tk-ticket-stage";
  let stageMap = (() => { try { return JSON.parse(localStorage.getItem(STAGE_STORE) || "{}") || {}; } catch { return {}; } })();
  const stageOf = (id) => (id && STAGE_KEYS.includes(stageMap[id]) ? stageMap[id] : null);
  const setStage = (id, stage) => {
    if (!id) return;
    if (stage && STAGE_KEYS.includes(stage)) stageMap[id] = stage; else delete stageMap[id];
    try { localStorage.setItem(STAGE_STORE, JSON.stringify(stageMap)); } catch {}
  };

  // Per-stage card order = the vertical stacking order within a bucket. A drop appends to the
  // bottom by default, or inserts at the layer the cursor is over. Persisted like the stage map.
  const STAGE_ORDER_STORE = "tk-stage-order";
  let stageOrder = (() => { try { return JSON.parse(localStorage.getItem(STAGE_ORDER_STORE) || "{}") || {}; } catch { return {}; } })();
  // Place id into stage's order at index (clamped); a null stage just removes it from every order.
  const setStageAt = (id, stage, index) => {
    if (!id) return;
    for (const k of Object.keys(stageOrder)) stageOrder[k] = (stageOrder[k] || []).filter((x) => x !== id);
    if (stage && STAGE_KEYS.includes(stage)) {
      const arr = stageOrder[stage] || (stageOrder[stage] = []);
      arr.splice(clamp(index | 0, 0, arr.length), 0, id);
    }
    try { localStorage.setItem(STAGE_ORDER_STORE, JSON.stringify(stageOrder)); } catch {}
  };

  // Deleted tickets (a client-side flag, NOT tickets.remove() — they must be kept & shown in the
  // trash). The right stack shows resolved tickets normally; its trash button flips it to show
  // these instead. Persisted like the stage map.
  const DELETED_STORE = "tk-deleted";
  let deletedSet = (() => { try { return new Set(JSON.parse(localStorage.getItem(DELETED_STORE) || "[]")); } catch { return new Set(); } })();
  const isDeleted = (id) => !!id && deletedSet.has(id);
  const setDeleted = (id, on) => {
    if (!id) return;
    if (on) deletedSet.add(id); else deletedSet.delete(id);
    try { localStorage.setItem(DELETED_STORE, JSON.stringify([...deletedSet])); } catch {}
  };
  let trashMode = false;   // right stack: false → resolved/closed, true → deleted (trash)

  // Per-ticket title/subtitle overrides (e.g. for a manually-created ticket the user names in the
  // config). The ticket API can't edit companyLabel/host, so — like the stage & deleted flags —
  // these live client-side in localStorage and are applied at render.
  const META_STORE = "tk-ticket-meta";
  let metaMap = (() => { try { return JSON.parse(localStorage.getItem(META_STORE) || "{}") || {}; } catch { return {}; } })();
  const metaOf = (id) => (id && metaMap[id]) || {};
  const setMeta = (id, m) => {
    if (!id) return;
    metaMap[id] = { ...metaOf(id), ...m };
    try { localStorage.setItem(META_STORE, JSON.stringify(metaMap)); } catch {}
  };
  const titleOf = (t) => { const m = metaOf(t.id); return (m.title && m.title.trim()) || t.companyLabel || "Unknown"; };
  const subOf = (t) => { const m = metaOf(t.id); return (m.subtitle != null && m.subtitle !== "") ? m.subtitle : (t.host || "—"); };
  let pendingOpenId = null;   // a just-created ticket to fly into its config once it spawns in

  let root = null;
  const decks = { left: null, right: null };   // each: { box, arrow, bar, thumb, cards:[], scrollX, contentW, viewW }
  const fanned = { left: false, right: false };
  let tickets = [], subscribed = false;

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const human = (ms) => {
    if (!Number.isFinite(ms) || ms < 0) return "—";
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d) return `${d}d ${h % 24}h`;
    if (h) return `${h}h ${m % 60}m`;
    if (m) return `${m}m`;
    return `${s}s`;
  };

  // The REAL grid ticket card — scoped to the dashboard layout so it never matches one of
  // our stack cards (which now also carry data-widget-runtime-type="ticket").
  const gridCard = () => document.querySelector('.dashboard-layout-grid [data-widget-runtime-type="ticket"], .widget-layout [data-widget-runtime-type="ticket"]');
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
    probe.className = "widget-card ticket-widget-card db-panel-custom-color";
    probe.setAttribute("data-widget-runtime-type", "ticket");
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
  const TICKET_COLORS = ["#2563eb", "#0ea5e9", "#0891b2", "#14b8a6", "#16a34a", "#65a30d", "#ca8a04", "#d97706", "#dc2626", "#e11d48", "#db2777", "#9333ea", "#7c3aed", "#4f46e5", "#64748b", "#111827"];
  const COLOR_STORE = "tk-ticket-color", COLOR_LAST = "tk-ticket-color-last";
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
  const hasPriority = (t) => ["low", "medium", "high", "critical"].includes(t.priority);
  const isBlank = (t) => {
    const m = metaOf(t.id);
    const title = (m.title && m.title.trim()) || (t.companyLabel && !["", "Untitled", "(manual)"].includes(t.companyLabel) ? t.companyLabel : "");
    const sub = (m.subtitle != null && m.subtitle !== "") ? m.subtitle : (t.host && t.host !== "—" ? t.host : "");
    return !title && !sub && !hasPriority(t);
  };
  const colorFor = (t) => {
    if (!t || !t.id) return null;
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
    probe.className = "widget-card ticket-widget-card db-panel-custom-color";
    probe.setAttribute("data-widget-runtime-type", "ticket");
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
  const cardBg = (t) => { const c = colorFor(t); return c ? colorBg(c) : severityBg(sevOf(t)); };

  const ensureStyles = () => {
    if (document.getElementById("ticket-stacks-styles")) return;
    const style = document.createElement("style");
    style.id = "ticket-stacks-styles";
    style.textContent = `
      .tk-stacks { position: fixed; inset: auto 0 0 0; z-index: 4000; pointer-events: none; -webkit-app-region: no-drag; }
      .tk-deck { position: absolute; bottom: 0; top: 0; width: 50%; pointer-events: none; transition: opacity .25s ease; }
      .tk-deck-left { left: 0; } .tk-deck-right { right: 0; }
      .tk-deck.is-fanned { pointer-events: auto; }
      .tk-deck.is-empty { display: none; }
      .tk-deck.is-dimmed { opacity: 0.3; }   /* the idle stack while the other is fanned */
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
      .tk-deck-left .tk-card { left: ${MARGIN}px; } .tk-deck-right .tk-card { right: ${MARGIN}px; }
      .tk-card:hover { box-shadow: inset 0 0 0 9999px rgba(255,255,255,0.12), inset 0 1px 0 rgba(255,255,255,0.34), 0 8px 22px rgba(0,0,0,0.18); }
      .tk-card.tk-dragging { cursor: grabbing; transition: none; opacity: 0.94;   /* matches the dashboard's native drag ghost (.widget-dragging): a barely-translucent "picked up" look, no blur */
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.30), 0 24px 52px rgba(0,0,0,0.45); }
      .tk-card.tk-flying { transition: transform .4s ${EASE}, opacity .4s ease; pointer-events: none; }

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

      /* Deleted view: a togglable drawer that opens ABOVE the trash icon, ringed in the same blue
         as the active trash button so it reads as a temporary toggled view, not a permanent stack. */
      .tk-trash-drawer { position: fixed; z-index: 6000; box-sizing: border-box; width: 264px; max-width: calc(100vw - ${MARGIN * 2}px);
        display: flex; flex-direction: column; color: #fff; border-radius: 16px; padding: 12px;
        background: linear-gradient(180deg, rgba(22,26,36,0.62), rgba(12,16,24,0.52));
        -webkit-backdrop-filter: blur(28px) saturate(140%); backdrop-filter: blur(28px) saturate(140%);
        border: 1.5px solid rgba(125,180,255,0.85);
        box-shadow: inset 0 0 0 1px rgba(125,180,255,0.28), 0 0 26px rgba(90,150,255,0.42), 0 22px 52px rgba(0,0,0,0.46);
        transform-origin: bottom right; transition: opacity .2s ease, transform .2s cubic-bezier(.2,.9,.3,1); }
      .tk-trash-drawer.is-hidden { opacity: 0; transform: translateY(10px) scale(0.96); pointer-events: none; }
      .tk-trash-hd { display: flex; align-items: center; gap: 7px; padding: 0 2px 10px;
        font-size: 0.82rem; font-weight: 700; letter-spacing: .01em; color: rgba(180,205,255,0.95); }
      .tk-trash-hd svg { width: 15px; height: 15px; }
      .tk-trash-body { display: flex; flex-direction: column; gap: 7px; overflow-y: auto; max-height: 46vh; padding: 1px;
        scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.26) transparent; }
      .tk-trash-body::-webkit-scrollbar { width: 8px; }
      .tk-trash-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,.22); border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
      .tk-trash-item { box-sizing: border-box; cursor: pointer; color: #fff; border-radius: 11px; padding: 9px 11px; overflow: hidden;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 4px 12px rgba(0,0,0,0.2); transition: box-shadow .14s ease; }
      .tk-trash-item:hover { box-shadow: inset 0 0 0 9999px rgba(255,255,255,0.10), inset 0 1px 0 rgba(255,255,255,0.30), 0 4px 12px rgba(0,0,0,0.2); }
      .tk-trash-co { font-size: 0.86rem; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tk-trash-host { margin-top: 2px; font-size: 0.72rem; color: rgba(255,255,255,0.62); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tk-trash-empty { padding: 18px 8px; text-align: center; color: rgba(255,255,255,0.4); font-size: 0.8rem; }

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
      .tk-zones { position: fixed; left: 0; right: 0; top: 64px; z-index: 800; pointer-events: none; }
      .tk-zone { position: absolute; top: 0; bottom: 0; display: flex; flex-direction: column; pointer-events: auto;
        border-radius: 16px; padding: 12px 14px 14px; color: #fff;
        background: linear-gradient(180deg, rgba(22,26,36,0.5), rgba(12,16,24,0.42));
        -webkit-backdrop-filter: blur(28px) saturate(140%); backdrop-filter: blur(28px) saturate(140%);
        border: 1px solid rgba(255,255,255,0.14);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 18px 42px rgba(0,0,0,0.28);
        transition: border-color .18s ease, box-shadow .18s ease, background .18s ease; }
      .tk-zone.is-target { border-color: rgba(125,180,255,0.92);
        background: linear-gradient(180deg, rgba(70,110,190,0.34), rgba(40,70,130,0.26));
        box-shadow: inset 0 0 0 1px rgba(125,180,255,0.5), 0 0 30px rgba(90,150,255,0.42); }
      .tk-zone-hd { display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 2px 4px 11px; font-size: 0.98rem; font-weight: 700; line-height: 1.25; letter-spacing: .01em; color: rgba(255,255,255,0.85); }
      .tk-zone-count { flex: 0 0 auto; font-size: 0.72rem; font-weight: 600; color: rgba(255,255,255,0.62);
        background: rgba(255,255,255,0.10); border-radius: 999px; padding: 1px 8px; }
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
      .tk-zone-empty { width: 100%; margin: auto 0; padding: 14px 8px; text-align: center; color: rgba(255,255,255,0.38); font-size: 0.8rem; line-height: 1.4; }

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
        opacity: 0.94;   /* matches the native drag ghost — barely-translucent, no blur */
        padding: 14px 15px; border-radius: 15px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.3), 0 24px 52px rgba(0,0,0,0.45);
        transition: transform .3s cubic-bezier(.4,0,.2,1), opacity .3s ease; }

      /* ── Glass flow arrows: stack → triage → … → resolution → resolved stack. ─────────── */
      /* Glass: shapes are drawn OPAQUE (so the shaft/head overlap flattens with no brighter seam),
         then group-opacity on .tk-flow fades the whole thing uniformly translucent + a soft glow. */
      .tk-flow { position: fixed; inset: 0; width: 100%; height: 100%; z-index: 790; pointer-events: none; overflow: visible;
        opacity: 0.6; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4)) drop-shadow(0 0 6px rgba(150,195,255,0.55)); }
      .tk-flow-shaft { fill: none; stroke: #d2e3ff; stroke-width: 4;
        stroke-linecap: round; stroke-linejoin: round; }
      .tk-flow-head { fill: #d2e3ff; stroke: none; }
    `;
    document.head.appendChild(style);
  };

  const arrowSvg = (dir) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${
      dir === "right" ? `<polyline points="9 6 15 12 9 18"/>` : `<polyline points="15 6 9 12 15 18"/>`}</svg>`;
  const PLUS_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;
  const TRASH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;

  const ensureRoot = () => {
    if (root) return;
    ensureStyles();
    root = document.createElement("div");
    root.className = "tk-stacks";
    for (const side of ["left", "right"]) {
      const box = document.createElement("div");
      box.className = `tk-deck tk-deck-${side}`;
      const track = document.createElement("div");   // holds the cards; scroll = ONE rigid transform on this
      track.className = "tk-track";
      box.appendChild(track);
      const arrow = document.createElement("button");
      arrow.className = "tk-arrow"; arrow.type = "button";
      arrow.setAttribute("aria-label", side === "left" ? "Fan out active tickets" : "Fan out resolved tickets");
      arrow.addEventListener("click", () => toggleFan(side));
      const bar = document.createElement("div"); bar.className = "tk-bar";
      const thumb = document.createElement("div"); thumb.className = "tk-thumb";
      bar.appendChild(thumb);
      box.appendChild(arrow); box.appendChild(bar);
      box.addEventListener("wheel", (e) => onWheel(side, e), { passive: false });
      wireThumb(side, thumb);
      // Action button above the stack: LEFT "+" creates a ticket; RIGHT trash toggles the stack
      // between resolved and deleted. Lives on root (not the deck box) so it stays visible when
      // the deck is empty (the box gets display:none via .is-empty).
      const action = document.createElement("button");
      action.className = "tk-stack-btn"; action.type = "button";
      if (side === "left") {
        action.setAttribute("aria-label", "Create a ticket");
        action.innerHTML = PLUS_SVG;
        action.addEventListener("click", openCreate);
      } else {
        action.setAttribute("aria-label", "Show deleted tickets");
        action.title = "Show deleted tickets";
        action.innerHTML = TRASH_SVG;
        action.addEventListener("click", () => { trashMode = !trashMode; action.classList.toggle("is-active", trashMode); render(); });
      }
      root.appendChild(box); root.appendChild(action);
      decks[side] = { box, track, arrow, bar, thumb, action, cards: [], scrollX: 0, contentW: 0, viewW: 0, order: loadOrder(side) };
    }
    document.body.appendChild(root);
    window.addEventListener("resize", () => { matchCardSize(); sizeRoot(); syncDropFloor(); layout("left"); layout("right"); });
    // Watch native widget drags from the outside so a grid ticket can be dropped back
    // into its stack. Capture phase → these run before the native drag's own document
    // handlers, letting us read the under-cursor rect before it commits.
    document.addEventListener("pointermove", onDragWatchMove, true);
    document.addEventListener("pointerup", onDragWatchUp, true);
    document.addEventListener("pointercancel", resetDragWatch, true);
  };

  const sizeRoot = () => { if (root) root.style.height = `${CARD_H + MARGIN * 2 + 34}px`; };

  const fanViewW = () => Math.max(CARD_W, window.innerWidth - MARGIN * 2 - (CARD_W + 78));  // leave room for the opposite stack

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
    const otherSide = side === "left" ? "right" : "left";
    // Hide this side's fan arrow entirely while the OTHER stack is fanned (or with ≤1 card).
    deck.arrow.classList.toggle("is-hidden", n <= 1 || fanned[otherSide]);
    deck.arrow.style.zIndex = "5000";
    // De-emphasise the idle stack's cards + arrow while the OTHER stack is fanned — but the
    // create/trash button stays at full opacity (it's an always-available action).
    deck.box.classList.toggle("is-dimmed", fanned[otherSide]);
    // The fanned deck must paint ABOVE the idle one. The idle deck's opacity:0.3 makes it a stacking
    // context, and the cards' track is also one (its scroll transform), so the fanned cards' z-index no
    // longer lifts them across decks — without this, the dimmed idle pile shows THROUGH the fanned cards
    // where they overlap, making the fanned stack look transparent. A box-level z-index fixes the order.
    deck.box.style.zIndex = fanned[side] ? "2" : "1";
    // create/trash button: centred above the stack's top card (independent of fan state)
    if (deck.action) {
      deck.action.style[side === "left" ? "left" : "right"] = `${MARGIN + CARD_W / 2 - 17}px`;
      deck.action.style.bottom = `${MARGIN + CARD_H + 18}px`;
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
      const frac = scrollMin ? clamp(deck.scrollX, scrollMin, 0) / scrollMin : 0;   // 0..1
      deck.thumb.style.width = `${thumbW}px`;
      deck.thumb.style.left = `${frac * (barW - thumbW)}px`;
      deck.thumb.style.right = "auto";
    }
  };

  // The track carries scroll; each card's transform is its SLOT only (so a reorder's .42s collision
  // animates independently of the rigid scroll). For left the track shifts by scrollX, for right by -scrollX.
  const setTrack = (side) => { const deck = decks[side]; if (deck && deck.track) deck.track.style.transform = `translateX(${side === "left" ? deck.scrollX : -deck.scrollX}px)`; };
  const place = (card, side, i, open, step) => {
    let tx, ty, rot;
    if (open) { tx = i * step; ty = 0; rot = 0; }   // slot position only — scroll is applied to the track
    else { const d = Math.min(i, 6); tx = d * 3; ty = -d * 4; rot = (i % 2 ? 1 : -1) * Math.min(i, 3) * 1.6; }
    if (side === "right") { tx = -tx; rot = -rot; }
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
      let tx = slot * step; if (side === "right") tx = -tx;   // slot only — track carries scroll
      c._tx = tx; c._ty = 0; c._rot = 0;
      c.style.zIndex = String(3000 - slot);
      c.style.transform = `translate(${tx}px, 0) rotate(0deg)`;
      slot++;
    });
  };

  const toggleFan = (side) => {
    const open = !fanned[side];
    fanned[side] = open;
    if (!open) decks[side].scrollX = 0;
    const other = side === "left" ? "right" : "left";
    if (open && fanned[other]) { fanned[other] = false; decks[other].scrollX = 0; }  // only one fanned at a time
    layout(side); layout(other);   // re-lay BOTH: each arrow's z depends on the other side's fan state
  };

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
  // Reposition the fanned cards + thumb + arrow from the CURRENT (maybe overscrolled) scrollX — no clamp.
  const positionFan = (side) => {
    const deck = decks[side]; if (!deck) return;
    setTrack(side);   // live scroll = rigid track transform; card slots are untouched (no re-place) → collision keeps animating
    const min = scrollMinOf(deck), barW = barWidth();
    const base = Math.max(36, barW * (deck.viewW / Math.max(1, deck.contentW)));
    // Apple-style overscroll: past an end, the thumb anchors to that end and shrinks by the overscroll
    // amount (and grows back as the recoil settles, since this runs every frame of the scroll loop).
    let thumbW = base, left;
    if (deck.scrollX > 0) { thumbW = Math.max(20, base - deck.scrollX); left = 0; }                          // past the start
    else if (deck.scrollX < min) { thumbW = Math.max(20, base - (min - deck.scrollX)); left = barW - thumbW; }  // past the end
    else { left = (min ? deck.scrollX / min : 0) * (barW - thumbW); }
    deck.thumb.style.width = `${thumbW}px`;
    deck.thumb.style.left = `${left}px`;
    deck.thumb.style.right = "auto";
    placeArrow(side);   // arrow tracks the ticket edge (rigidly — its transition is off during scroll)
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
      const dxPx = (e.clientX - sx) * (side === "right" ? -1 : 1);
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
    if (!layout || typeof layout.__initWidget !== "function") { window.ticketGrid?.show(t); return null; }
    const key = `ticket-pin-${t.id}`;
    const sel = (window.CSS && CSS.escape) ? CSS.escape(key) : key;
    let card = layout.querySelector(`[data-widget-key="${sel}"]`);
    let cell = null;
    if (!card) {
      cell = preferredCell || nextCell(layout);
      card = document.createElement("div");
      card.className = "widget-card ticket-widget-card";
      // Size to its 3-row footprint INSTANTLY. .widget-card animates width/height/grid-row,
      // and the drag hand-off reads getBoundingClientRect to compute the grab offset — a
      // mid-transition (half-sized) read offsets the widget from the cursor and makes the
      // first drag look frozen until it snaps to its grid cell on release. Restored below.
      card.style.transition = "none";
      card.dataset.widgetKey = key;
      card.dataset.widgetType = "ticket";
      card.dataset.widgetRuntimeType = "ticket";
      card.dataset.widgetConfig = '{"title":"Ticket"}';
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
    if (cell) window.ticketDashboardPlacement?.size?.(card, cell.col, cell.row);
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
    document.body.appendChild(clone);
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
  const PIN = "ticket-pin-";
  // ANY ticket widget on the grid can be dragged home — the pinned ones AND the main
  // ticket-card from the template. Match on the runtime type, not the pin key.
  const draggedTicket = () => document.querySelector(
    '.dashboard-layout-grid .widget-card.widget-dragging[data-widget-runtime-type="ticket"],' +
    ' .widget-layout .widget-card.widget-dragging[data-widget-runtime-type="ticket"]');
  const ticketForWidget = (w) => {
    if (!w) return null;
    const k = String(w.dataset.widgetKey || "");
    const id = w.dataset.ticketId || (k.startsWith(PIN) ? k.slice(PIN.length) : "");
    return id ? (tickets.find((x) => x.id === id) || null) : null;
  };
  const deckSideFor = (t) => ((t && (t.state || "open") === "resolved") ? "right" : "left");
  const overStack = (e) => e.clientY >= stackTopY();
  const nativePlaceholder = () => gridLayout()?.querySelector(":scope > .widget-placeholder") || null;
  // Publish the stack cards' TOP EDGE so the grid drag clamps its placeholder to sit
  // flush above the stacks. stackTopY keeps a MARGIN of slack above the cards (they sit
  // at bottom:MARGIN), and reserving down to it left one extra empty row — the lock a
  // cell too high. The cards' real top is stackTopY + MARGIN.
  const syncDropFloor = () => { const l = gridLayout(); if (l) l.dataset.dropFloorY = String(Math.round(stackTopY() + MARGIN)); };

  let dragPinW = null, dragPinT = null;
  // Which deck the cursor is over (by viewport half) while in the stack band, else null.
  const hotSideAt = (e) => (overStack(e) ? (e.clientX < window.innerWidth / 2 ? "left" : "right") : null);
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
    for (const s of ["left", "right"]) decks[s]?.landing?.classList.remove("tk-faint", "tk-hot", "tk-bad");
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
    for (const s of ["left", "right"]) {
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
    render();
    const target = decks[side]?.cards.find((c) => c.dataset.id === t.id);
    const clone = document.createElement("div");
    clone.className = "tk-card tk-flying";
    // Snappier flight than the shared .tk-flying default so the wiggle lands quickly.
    clone.style.cssText = `position:fixed; left:${from.left}px; top:${from.top}px; width:${from.width}px; height:${from.height}px; margin:0; z-index:9999; pointer-events:none; transition: transform .2s cubic-bezier(.4,0,.2,1), opacity .2s ease;`;
    clone.style.backgroundColor = baseColor();
    clone.style.backgroundImage = cardBg(t);
    clone.innerHTML = cardInner(t);
    document.body.appendChild(clone);
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
      const along = (side === "right" ? -alongBoxX : alongBoxX) - deck.scrollX;
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
        dragging = true; dragActive = true; ranksClosed = false; card.classList.add("tk-dragging"); card.style.zIndex = "9999";
        // Lift the card OUT of the scroll track into the box, so it stays screen-fixed while the track
        // autoscrolls underneath. Fold the current scroll into baseTx (the track no longer moves it).
        const d0 = decks[side]; d0.box.appendChild(card);
        baseTx = card._tx + (side === "left" ? d0.scrollX : -d0.scrollX); baseTy = card._ty;
        dragPreviewFn = (x, y) => {              // re-run while autoscrolling so the gap follows the cursor
          if (y < stackTopY()) { flowHighlight(stackPos(side), x, y); const dt = dropTarget(stackPos(side), x, y); if (dt) previewGap(dt.stage, dt.index); else clearGap(); }
          else { clearZoneHighlight(); clearGap(); }
        };
        deckReorderFn = () => reorderTo(lastAlong);   // autoscroll re-runs the reorder at the held cursor
      }
      if (!dragging) return;
      card.style.transform = `translate(${baseTx + dx}px, ${baseTy + dy}px) rotate(0deg) scale(1.03)`;
      updateAutoScroll(e.clientX, e.clientY);   // scroll a bucket/deck if the cursor nears a scrollable edge
      // Dragged UP onto the dashboard → target a pipeline zone (highlight the one under the
      // cursor). A horizontal reorder keeps the cursor ON the cards (below stackTopY), so it
      // never reaches here — the two gestures don't collide.
      if (e.clientY < stackTopY()) {
        flowHighlight(stackPos(side), e.clientX, e.clientY);
        const dt = dropTarget(stackPos(side), e.clientX, e.clientY);
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
      dragActive = false; stopAutoScroll(); dragPreviewFn = null; deckReorderFn = null;   // always clear, even on hand-off
      if (handedOff) return;                                                // native runtime owns the drop
      const wasDrag = dragging; dragging = false; down = false;
      card.classList.remove("tk-dragging");
      // Config opens on DOUBLE click; a single click does nothing (the card never moved).
      if (!wasDrag) return;
      const dDrop = decks[side];               // back into the scroll track (it was lifted to the box for the drag) —
      if (dDrop && dDrop.track) {              // compensate for the track's transform so it doesn't jump by scrollX
        const tt = side === "left" ? dDrop.scrollX : -dDrop.scrollX;
        card.style.transform = `translate(${(baseTx + (e.clientX - startX)) - tt}px, ${baseTy + (e.clientY - startY)}px)`;
        dDrop.track.appendChild(card);
      }
      clearZoneHighlight();
      // Released up on the dashboard → drop into the pipeline zone under the cursor, if any.
      if (e.clientY < stackTopY()) {
        const dt = dropTarget(stackPos(side), e.clientX, e.clientY);
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
    // Double-click opens the ticket's config (flies to centre).
    card.addEventListener("dblclick", (e) => { e.preventDefault(); window.ticketDetail?.open(t, card); });
  };

  // The card's inner markup — shared by the stack cards and the fly-home clone so they
  // render identically. Uses the global .ticket-body/.ticket-company/etc. classes.
  const cardInner = (t) => {
    const created = t.createdAt ? Date.parse(t.createdAt) : NaN;
    const endMs = t.recoveredAt ? Date.parse(t.recoveredAt) : Date.now();
    return `<div class="ticket-body">` +
      `<div class="ticket-company">${esc(titleOf(t))}</div>` +
      `<div class="ticket-host">${esc(subOf(t))}</div>` +
      `<div class="ticket-down">Down ${esc(human(endMs - created))}</div>` +
      `</div>`;
  };

  const cardEl = (t, side) => {
    const card = document.createElement("div");
    // NOT a .widget-card (the runtime renders the grid ticket into EVERY .widget-card, which
    // is what overwrote these with "Willits Scaling"). .tk-card replicates the frame; the
    // global .ticket-body/.ticket-company/etc. classes give identical fonts/colour; and the
    // fill is an opaque copy of the grid card so the colour matches exactly.
    card.className = "tk-card";
    card.dataset.id = t.id || "";
    card.style.width = `${CARD_W}px`; card.style.height = `${CARD_H}px`;
    card.style.backgroundColor = baseColor();
    card.style.backgroundImage = cardBg(t);
    card.innerHTML = cardInner(t);
    wireCard(card, t, side);
    return card;
  };

  const buildDeck = (side, list) => {
    const deck = decks[side];
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
    if (!deck.cards.length) { fanned[side] = false; deck.scrollX = 0; }   // keep deck.order — a temporarily-empty deck shouldn't forget the saved order
    layout(side);
  };

  // Ticket ids that already live on the dashboard grid — excluded from the stacks (one
  // canonical ticket). Dragged widgets carry the id in their key (ticket-pin-<id>, set
  // synchronously on drop); every ticket widget also carries data-ticket-id once rendered.
  const onGridIds = () => {
    const ids = new Set();
    document.querySelectorAll('.dashboard-layout-grid .widget-card[data-widget-key^="ticket-pin-"]').forEach((w) => {
      const k = w.dataset.widgetKey || ""; if (k.length > 11) ids.add(k.slice(11));
    });
    document.querySelectorAll('.dashboard-layout-grid .widget-card[data-widget-runtime-type="ticket"]').forEach((w) => {
      if (w.dataset.ticketId) ids.add(w.dataset.ticketId);
    });
    return ids;
  };

  // ── Pipeline zones (glass buckets) ───────────────────────────────────────────
  let zonesRoot = null;
  let dragActive = false;     // true while a ticket is mid-drag → route wheel to the bucket under the cursor
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
      for (const side of ["left", "right"]) {
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

  // ── Glass flow arrows ─────────────────────────────────────────────────────────
  // A stylized translucent line through the pipeline: left (inbox) stack → triage, an arrow
  // between each bucket, then resolution → right (resolved) stack. Drawn as one SVG overlay,
  // each arrow a glowing glass body with a bright core + a glassy arrowhead.
  let flowRoot = null, flowShafts = [], flowHeads = [];
  const ensureFlow = () => {
    if (flowRoot) return;
    ensureStyles();
    const arrows = STAGES.length + 1;
    let lines = "";
    // Per arrow: a stroked shaft + a SOLID triangle head built forward from where the shaft ends.
    for (let i = 0; i < arrows; i++) lines += `<path class="tk-flow-shaft"></path><path class="tk-flow-head"></path>`;
    const wrap = document.createElement("div");
    wrap.innerHTML = `<svg class="tk-flow" xmlns="http://www.w3.org/2000/svg">${lines}</svg>`;
    flowRoot = wrap.firstElementChild;
    document.body.appendChild(flowRoot);
    flowShafts = [...flowRoot.querySelectorAll(".tk-flow-shaft")];
    flowHeads = [...flowRoot.querySelectorAll(".tk-flow-head")];
  };
  const HEAD_LEN = 20, HEAD_HALF = 9, CORNER = 46;
  // A solid arrowhead whose BASE CENTRE is where the shaft stops; the shaft's round cap just
  // reaches the base, so the line enters the head's centre and nothing crosses into/past it.
  // dx,dy = unit travel direction at the tip; r = rounder.
  const arrowHead = (ex, ey, dx, dy, r) => {
    const bx = ex - HEAD_LEN * dx, by = ey - HEAD_LEN * dy;             // base centre
    const sx = ex - (HEAD_LEN - 5) * dx, sy = ey - (HEAD_LEN - 5) * dy; // shaft overlaps 5px INTO the head (no gap)
    const px = -dy * HEAD_HALF, py = dx * HEAD_HALF;                    // half-width perpendicular
    return { sx, sy, d: `M${r(bx + px)},${r(by + py)} L${r(ex)},${r(ey)} L${r(bx - px)},${r(by - py)} Z` };
  };
  // lefts: bucket left xs; bw: bucket width; topY/botY: bucket bounds. Each stack connector is a
  // straight run + ONE rounded corner so the line reaches the head dead-straight and centred.
  const drawFlow = (lefts, bw, topY, botY) => {
    ensureFlow();
    const n = lefts.length, r = Math.round, midY = r(topY + (botY - topY) / 2);
    const cardTop = window.innerHeight - CARD_H - MARGIN, offStack = r(cardTop - MARGIN);
    const leftX = MARGIN + 26, rightX = window.innerWidth - (MARGIN + 26);   // mirror of leftX
    const shafts = [], heads = [];
    // 1 — rise from the inbox, early rounded corner, long HORIZONTAL run dead-centre into triage.
    { const ex = lefts[0] - MARGIN, h = arrowHead(ex, midY, 1, 0, r);
      shafts.push(`M${leftX},${offStack} L${leftX},${midY + CORNER} Q${leftX},${midY} ${leftX + CORNER},${midY} L${r(h.sx)},${midY}`);
      heads.push(h.d); }
    // 2 — straight trail across each gap into the next bucket (head points right).
    for (let i = 0; i < n - 1; i++) { const ex = lefts[i + 1] - MARGIN, h = arrowHead(ex, midY, 1, 0, r);
      shafts.push(`M${r(lefts[i] + bw + MARGIN)},${midY} L${r(h.sx)},${midY}`); heads.push(h.d); }
    // 3 — MIRROR of the left: leave resolution, early rounded corner, long VERTICAL run dead-centre
    //     down into the resolved stack (head points down).
    { const h = arrowHead(rightX, offStack, 0, 1, r);
      shafts.push(`M${r(lefts[n - 1] + bw + MARGIN)},${midY} L${r(rightX - CORNER)},${midY} Q${r(rightX)},${midY} ${r(rightX)},${midY + CORNER} L${r(rightX)},${r(h.sy)}`);
      heads.push(h.d); }
    shafts.forEach((d, i) => flowShafts[i]?.setAttribute("d", d));
    heads.forEach((d, i) => flowHeads[i]?.setAttribute("d", d));
  };
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
    if (!zonesRoot) return;
    zonesRoot.style.top = `${ZONE_TOP}px`;
    zonesRoot.style.bottom = `${CARD_H + MARGIN * 2}px`;        // a MARGIN above the stacks' top card
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
      panel.style.width = `${Math.round(bucketW)}px`;
      panel.style.left = `${Math.round(left)}px`;
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
    drawFlow(lefts, bucketW, ZONE_TOP, window.innerHeight - (CARD_H + MARGIN * 2));
  };
  const ensureZones = () => {
    if (zonesRoot) return;
    ensureStyles();
    zonesRoot = document.createElement("div");
    zonesRoot.className = "tk-zones";
    STAGES.forEach((s) => {
      const panel = document.createElement("div");
      panel.className = "tk-zone";
      panel.dataset.stage = s.key;
      panel.innerHTML = `<div class="tk-zone-hd"><span>${esc(s.label)}</span><span class="tk-zone-count">0</span></div>` +
        `<div class="tk-zone-body"><div class="tk-zone-clip"><div class="tk-zone-track"></div></div><div class="tk-zsb"><div class="tk-zth"></div></div></div>`;
      zonesRoot.appendChild(panel);
      zoneBody[s.key] = panel.querySelector(".tk-zone-body");
      zoneTrack[s.key] = panel.querySelector(".tk-zone-track");
      zoneScroll[s.key] = { sy: 0, ty: 0, raf: 0, wheeling: false, releaseT: 0 };
      zoneBody[s.key].addEventListener("wheel", (e) => onZoneWheel(s.key, e), { passive: false });
      wireZoneThumb(s.key);
    });
    document.body.appendChild(zonesRoot);
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
  const canAdvance = (from, to) => to < from || to === from + 1;
  const distToRect = (x, y, r) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
  const HL_RANGE = 260;
  const baseZoneShadow = "inset 0 1px 0 rgba(255,255,255,0.18), 0 18px 42px rgba(0,0,0,0.28)";
  const clearGlow = (p) => { p.style.borderColor = ""; p.style.boxShadow = ""; };
  // Subtle glow on every bucket that intensifies as the cursor nears it: blue where a drop is
  // allowed from `from`, red where it would skip a stage (and so is rejected on release).
  const flowHighlight = (from, x, y) => {
    STAGES.forEach((s, i) => {
      const p = zoneBody[s.key]?.parentElement; if (!p) return;
      if (i === from) { clearGlow(p); return; }                  // the ticket's own bucket → neutral
      const t = clamp(1 - distToRect(x, y, p.getBoundingClientRect()) / HL_RANGE, 0.14, 1);
      if (canAdvance(from, i)) {                                  // valid → blue
        p.style.borderColor = `rgba(125,180,255,${(0.2 + 0.72 * t).toFixed(3)})`;
        p.style.boxShadow = `inset 0 0 0 1px rgba(125,180,255,${(0.5 * t).toFixed(3)}), 0 0 ${Math.round(36 * t)}px rgba(90,150,255,${(0.5 * t).toFixed(3)}), ${baseZoneShadow}`;
      } else {                                                   // skips a stage → red (blocked)
        p.style.borderColor = `rgba(255,120,120,${(0.2 + 0.66 * t).toFixed(3)})`;
        p.style.boxShadow = `inset 0 0 0 1px rgba(255,120,120,${(0.5 * t).toFixed(3)}), 0 0 ${Math.round(32 * t)}px rgba(255,80,80,${(0.46 * t).toFixed(3)}), ${baseZoneShadow}`;
      }
    });
  };
  const clearZoneHighlight = () => STAGES.forEach((s) => { const p = zoneBody[s.key]?.parentElement; if (p) { p.classList.remove("is-target"); clearGlow(p); } });

  // A zone card is a FULL ticket card — identical layout/size to a corner-stack card.
  const zoneCardInner = (t) => cardInner(t);

  // Drag a zone card to ANOTHER zone (reassign stage), DOWN onto the corner stacks (un-assign
  // → back to the inbox), or release on its own zone / nowhere (snap back). Click opens config.
  const wireZoneCard = (card, t, stage) => {
    let down = false, dragging = false, sx = 0, sy = 0, clone = null;
    const onMove = (e) => {
      if (!down) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!dragging && Math.hypot(dx, dy) > 6) {
        dragging = true; dragActive = true;
        const r = card.getBoundingClientRect();
        clone = document.createElement("div");
        clone.className = "tk-zfly";
        clone.style.cssText = `left:${r.left}px; top:${r.top}px; width:${r.width}px; height:${r.height}px; transition:none;`;
        clone.style.backgroundColor = baseColor();
        clone.style.backgroundImage = cardBg(t);
        clone.innerHTML = zoneCardInner(t);
        document.body.appendChild(clone);
        card.classList.add("tk-zdrag");
        dragPreviewFn = (x, y) => {              // re-run while autoscrolling so the gap follows the cursor
          flowHighlight(posOfStage(stage), x, y); const dt = dropTarget(posOfStage(stage), x, y);
          if (dt) previewGap(dt.stage, dt.index); else clearGap();
        };
      }
      if (!dragging) return;
      clone.style.transform = `translate(${dx}px, ${dy}px) scale(1.04)`;
      updateAutoScroll(e.clientX, e.clientY);   // scroll a bucket if the cursor nears a scrollable edge
      flowHighlight(posOfStage(stage), e.clientX, e.clientY);
      const dt = dropTarget(posOfStage(stage), e.clientX, e.clientY);
      if (dt) previewGap(dt.stage, dt.index); else clearGap();   // open a sandwich slot under the cursor
    };
    const onUp = (e) => {
      window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
      const wasDrag = dragging; dragging = false; down = false; dragActive = false; stopAutoScroll(); dragPreviewFn = null;
      clearZoneHighlight(); clearGap();
      if (clone) { clone.remove(); clone = null; }
      card.classList.remove("tk-zdrag");
      if (!wasDrag) { window.ticketDetail?.open(t, card); return; }
      const dt = dropTarget(posOfStage(stage), e.clientX, e.clientY);   // valid bucket (reorder or legal step) + layer
      if (dt) { setStage(t.id, dt.stage); setStageAt(t.id, dt.stage, dt.index); render(); return; }
      if (e.clientY >= stackTopY()) { setStage(t.id, null); setStageAt(t.id, null); render(); return; }   // onto a stack → inbox
      // else: a blocked (red) zone / nowhere → the card just un-hides in place.
    };
    card.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      down = true; dragging = false; sx = e.clientX; sy = e.clientY;
      window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
    });
  };

  const zoneCardEl = (t, stage) => {
    const card = document.createElement("div");
    card.className = "tk-zcard";
    card.dataset.id = t.id || "";
    card.style.width = `${CARD_W}px`; card.style.height = `${CARD_H}px`;   // full ticket dimensions
    card.style.backgroundColor = baseColor();
    card.style.backgroundImage = cardBg(t);
    card.innerHTML = zoneCardInner(t);
    wireZoneCard(card, t, stage);
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
    zoneTrack[gapStage]?.querySelectorAll(".tk-zcard").forEach((c) => { c.style.transform = ""; });
    gapStage = null;
  };
  const previewGap = (stage, index) => {
    if (gapStage && gapStage !== stage) clearGap();
    gapStage = stage;
    (zoneTrack[stage]?.querySelectorAll(".tk-zcard") || []).forEach((c, i) => {
      c.style.transform = i >= index ? `translateY(${ZCARD_PEEK}px)` : "";
    });
  };
  // The droppable bucket + insert index under (x,y) for a drag from chain position `from` — or null.
  const dropTarget = (from, x, y) => {
    const z = zoneAt(x, y);
    if (!z) return null;
    const to = posOfStage(z);
    if (from !== to && !canAdvance(from, to)) return null;   // same stage = reorder; else a legal step
    return { stage: z, index: zoneInsertIndex(z, y) };
  };

  const renderZones = () => {
    ensureZones();
    const byCreated = (a, b) => (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0);
    STAGES.forEach((s) => {
      const body = zoneBody[s.key], track = zoneTrack[s.key];
      const ord = stageOrder[s.key] || [];
      const oidx = (id) => { const i = ord.indexOf(id); return i === -1 ? 1e9 : i; };   // unordered → bottom
      const list = tickets.filter((t) => stageOf(t.id) === s.key && !isDeleted(t.id))
        .sort((a, b) => oidx(a.id) - oidx(b.id) || byCreated(a, b));
      track.innerHTML = list.length ? "" : `<div class="tk-zone-empty">Drag tickets here</div>`;
      // Stack the cards with overlap: each sits ZCARD_PEEK below the previous (covering all but the
      // one-below's title) and on top of it, so only titles peek until the last, fully-shown card.
      list.forEach((t, i) => {
        const card = zoneCardEl(t, s.key);
        if (i > 0) card.style.marginTop = `-${CARD_H - ZCARD_PEEK}px`;
        card.style.zIndex = String(i + 1);
        track.appendChild(card);
      });
      const count = body.parentElement.querySelector(".tk-zone-count");
      if (count) count.textContent = String(list.length);
      const st = zoneScroll[s.key];   // re-clamp scroll to the new content height + reposition
      if (st) { st.sy = clamp(st.sy, zMin(s.key), 0); st.ty = st.sy; positionZone(s.key); }
    });
  };

  // Drop a ticket dragged from a corner stack into a zone: assign the stage, leave the stack,
  // and fly a shrinking clone from the drop point into its new card in the zone.
  const dropIntoZone = (fromCard, t, stage, index) => {
    const from = fromCard.getBoundingClientRect();
    setDeleted(t.id, false);   // entering the pipeline un-deletes (a ticket can't be both staged and trashed)
    setStage(t.id, stage);
    setStageAt(t.id, stage, index);   // bottom by default, or the layer the cursor was over
    render();
    const dest = zoneTrack[stage]?.querySelector(`.tk-zcard[data-id="${cssEsc(t.id)}"]`);
    if (!dest) return;
    const to = dest.getBoundingClientRect();
    const clone = document.createElement("div");
    clone.className = "tk-zfly";
    clone.style.cssText = `left:${from.left}px; top:${from.top}px; width:${from.width}px; height:${from.height}px; transform-origin: top left;`;
    clone.style.backgroundColor = baseColor();
    clone.style.backgroundImage = cardBg(t);
    clone.innerHTML = zoneCardInner(t);
    document.body.appendChild(clone);
    dest.style.opacity = "0";
    requestAnimationFrame(() => {
      clone.style.transform = `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`;
    });
    setTimeout(() => { clone.remove(); if (dest.isConnected) dest.style.opacity = ""; }, 300);
  };

  // The deleted view — a togglable drawer that opens above the trash icon (blue-outlined).
  let trashDrawer = null;
  const ensureTrashDrawer = () => {
    if (trashDrawer) return;
    ensureStyles();
    trashDrawer = document.createElement("div");
    trashDrawer.className = "tk-trash-drawer is-hidden";
    document.body.appendChild(trashDrawer);
  };
  const renderTrash = () => {
    ensureTrashDrawer();
    trashDrawer.style.right = `${MARGIN}px`;
    trashDrawer.style.bottom = `${MARGIN + CARD_H + 62}px`;   // just above the trash button
    trashDrawer.classList.toggle("is-hidden", !trashMode);
    if (!trashMode) return;
    const order = (a, b) => (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0);
    const list = tickets.filter((t) => isDeleted(t.id)).sort(order);
    trashDrawer.innerHTML = `<div class="tk-trash-hd">${TRASH_SVG}<span>Deleted</span></div>` +
      `<div class="tk-trash-body">${list.length ? "" : `<div class="tk-trash-empty">No deleted tickets.</div>`}</div>`;
    const body = trashDrawer.querySelector(".tk-trash-body");
    list.forEach((t) => {
      const item = document.createElement("div");
      item.className = "tk-trash-item";
      item.dataset.id = t.id || "";
      item.style.backgroundColor = baseColor();
      item.style.backgroundImage = cardBg(t);
      item.innerHTML = `<div class="tk-trash-co">${esc(titleOf(t))}</div><div class="tk-trash-host">${esc(subOf(t))}</div>`;
      item.addEventListener("click", () => window.ticketDetail?.open?.(t, item));   // open → Restore
      body.appendChild(item);
    });
  };

  const render = () => {
    ensureRoot(); ensureZones();
    matchCardSize(); sizeRoot(); layoutZones(); syncDropFloor();
    const onGrid = onGridIds();
    const order = (a, b) => (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0);
    // Staged tickets live in their zone; the rest sit in the corner stacks (the inbox). Deleted
    // tickets are hidden everywhere EXCEPT the right stack when it's flipped to trash mode.
    const avail = tickets.filter((t) => !onGrid.has(t.id) && !stageOf(t.id) && !isDeleted(t.id));
    buildDeck("left", avail.filter((t) => (t.state || "open") !== "resolved").sort(order));
    // The right stack always shows resolved/closed; deleted tickets live in the trash drawer.
    buildDeck("right", avail.filter((t) => (t.state || "open") === "resolved").sort(order));
    renderZones();
    renderTrash();
    // A just-created ticket: once its card has spawned into the left stack, let it settle, then
    // fly it to the centre and expand its config. Creating fires several re-renders that REPLACE
    // the card element, so re-query the LIVE node at fire time — a detached node has a 0-rect and
    // the flyer would grow from (0,0).
    if (pendingOpenId && decks.left?.box?.querySelector(`.tk-card[data-id="${cssEsc(pendingOpenId)}"]`)) {
      const id = pendingOpenId; pendingOpenId = null;
      const tryOpen = (tries) => {
        const card = decks.left?.box?.querySelector(`.tk-card[data-id="${cssEsc(id)}"]`);
        const tk = tickets.find((x) => x.id === id);
        if (card && card.isConnected && card.getBoundingClientRect().width > 10 && tk) window.ticketDetail?.open?.(tk, card);
        else if (tries > 0) setTimeout(() => tryOpen(tries - 1), 120);
      };
      setTimeout(() => tryOpen(8), 420);
    }
  };

  // The left "+": spawn a blank ticket into the inbox stack, then (once its card has visibly
  // landed) fly it to the centre and expand its config — where the user sets title & subtitle.
  const openCreate = async () => {
    let tk = null;
    try { const res = await window.tickets?.create?.({ companyLabel: "Untitled", host: "", severity: "medium" }); tk = res && res.ticket; } catch {}
    if (tk && tk.id) pendingOpenId = tk.id;
    load();   // re-fetch + render; render() auto-opens the config when the new card appears
  };

  const load = async () => {
    try { const r = await window.tickets?.list?.(); tickets = (r && r.tickets) || []; }
    catch { tickets = []; }
    render();
    if (!subscribed) {
      subscribed = true;
      window.tickets?.onChanged?.((payload) => { tickets = (payload && payload.tickets) || []; render(); });
    }
  };

  // delete/restore are the trash flag (NOT tickets.remove) so the ticket survives in the trash.
  window.ticketStacks = {
    reload: load,
    isDeleted,
    delete: (id) => { setDeleted(id, true); render(); },
    restore: (id) => { setDeleted(id, false); render(); },
    metaOf,
    // Persist the override and update the card's text IN PLACE (no rebuild) so live edits from
    // the open config don't detach the card the detail panel is animating from.
    setMeta: (id, m) => {
      setMeta(id, m);
      const t = tickets.find((x) => x.id === id); if (!t) return;
      document.querySelectorAll(`.tk-card[data-id="${cssEsc(id)}"], .tk-zcard[data-id="${cssEsc(id)}"]`).forEach((c) => {
        const co = c.querySelector(".ticket-company"); if (co) co.textContent = titleOf(t);
        const ho = c.querySelector(".ticket-host"); if (ho) ho.textContent = subOf(t);
      });
    },
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load);
  else load();
})();
