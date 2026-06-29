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
    { key: "triage", label: "Triage and Assignment" },
    { key: "investigation", label: "Investigation and Diagnosis" },
    { key: "resolution", label: "Resolution and Closure" },
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

  // The dark dashboard colour behind the grid card (its opaque ancestor) — the base the
  // glass card sits over, so an opaque copy of the card matches.
  const baseColor = () => {
    let el = gridCard(); el = el ? el.parentElement : (document.querySelector(".dashboard-layout-grid") || document.body);
    while (el) { const c = getComputedStyle(el).backgroundColor; if (c && c !== "transparent" && !/^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(c)) return c; el = el.parentElement; }
    return "rgb(26, 34, 51)";
  };
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

  const ensureStyles = () => {
    if (document.getElementById("ticket-stacks-styles")) return;
    const style = document.createElement("style");
    style.id = "ticket-stacks-styles";
    style.textContent = `
      .tk-stacks { position: fixed; inset: auto 0 0 0; z-index: 4000; pointer-events: none; -webkit-app-region: no-drag; }
      .tk-deck { position: absolute; bottom: 0; top: 0; width: 50%; pointer-events: none; }
      .tk-deck-left { left: 0; } .tk-deck-right { right: 0; }
      .tk-deck.is-fanned { pointer-events: auto; }
      .tk-deck.is-empty { display: none; }
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
      .tk-card.tk-dragging { cursor: grabbing; transition: none;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.30), 0 24px 52px rgba(0,0,0,0.45); }
      .tk-card.tk-flying { transition: transform .4s ${EASE}, opacity .4s ease; pointer-events: none; }

      .tk-arrow { position: absolute; width: 34px; height: 34px; border-radius: 50%; -webkit-appearance: none; appearance: none;
        border: 1px solid rgba(255,255,255,0.22); cursor: pointer; pointer-events: auto;
        background: linear-gradient(180deg, rgba(22,26,36,0.62), rgba(12,16,24,0.55));
        -webkit-backdrop-filter: blur(26px) saturate(140%); backdrop-filter: blur(26px) saturate(140%);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.24), 0 10px 26px rgba(0,0,0,0.34);
        color: #fff; display: flex; align-items: center; justify-content: center;
        transition: left .42s ${EASE}, right .42s ${EASE}, transform .2s ease, opacity .2s ease; }
      .tk-arrow:hover { transform: scale(1.08); }
      .tk-arrow svg { width: 15px; height: 15px; } .tk-arrow.is-hidden { opacity: 0; pointer-events: none; }

      /* Sleek horizontal scrollbar beneath an overflowing fan (same recipe as the menus). */
      .tk-bar { position: absolute; height: 6px; border-radius: 999px; background: rgba(255,255,255,0.10);
        pointer-events: auto; opacity: 0; transition: opacity .2s ease; }
      .tk-bar.is-on { opacity: 1; }
      .tk-thumb { position: absolute; top: 0; height: 6px; border-radius: 999px; background: rgba(255,255,255,0.32); cursor: grab; }
      .tk-thumb:hover { background: rgba(255,255,255,0.5); }

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
        padding: 2px 4px 11px; font-size: 0.82rem; font-weight: 700; letter-spacing: .01em; color: rgba(255,255,255,0.85); }
      .tk-zone-count { flex: 0 0 auto; font-size: 0.72rem; font-weight: 600; color: rgba(255,255,255,0.62);
        background: rgba(255,255,255,0.10); border-radius: 999px; padding: 1px 8px; }
      .tk-zone-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;
        display: flex; flex-flow: row wrap; align-content: flex-start; justify-content: center; gap: ${MARGIN}px; padding: 2px;
        scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.26) transparent; }
      .tk-zone-body::-webkit-scrollbar { width: 8px; }
      .tk-zone-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,.22); border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
      .tk-zone-empty { width: 100%; margin: auto 0; padding: 14px 8px; text-align: center; color: rgba(255,255,255,0.38); font-size: 0.8rem; line-height: 1.4; }

      /* A FULL-size ticket card living in a zone — same dimensions + look as a stack card. */
      .tk-zcard { box-sizing: border-box; flex: 0 0 auto; cursor: grab; color: #fff; display: flex; flex-direction: column; overflow: hidden;
        user-select: none; -webkit-user-select: none; padding: 14px 15px; border-radius: 15px;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.22), 0 8px 22px rgba(0,0,0,0.18); transition: box-shadow .15s ease; }
      .tk-zcard:hover { box-shadow: inset 0 0 0 9999px rgba(255,255,255,0.12), inset 0 1px 0 rgba(255,255,255,0.34), 0 8px 22px rgba(0,0,0,0.18); }
      .tk-zcard.tk-zdrag { opacity: 0; }                 /* hidden while its floating clone is dragged */
      .tk-zfly { position: fixed; z-index: 9999; pointer-events: none; box-sizing: border-box; color: #fff; display: flex; flex-direction: column; overflow: hidden;
        padding: 14px 15px; border-radius: 15px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.3), 0 24px 52px rgba(0,0,0,0.45);
        transition: transform .3s cubic-bezier(.4,0,.2,1), opacity .3s ease; }

      /* ── Glass flow arrows: stack → triage → … → resolution → resolved stack. ─────────── */
      .tk-flow { position: fixed; inset: 0; width: 100%; height: 100%; z-index: 790; pointer-events: none; overflow: visible;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.32)); }
      .tk-flow-arrow path { fill: none; stroke: rgba(255,255,255,0.66); stroke-width: 2.5;
        stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
    `;
    document.head.appendChild(style);
  };

  const arrowSvg = (dir) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${
      dir === "right" ? `<polyline points="9 6 15 12 9 18"/>` : `<polyline points="15 6 9 12 15 18"/>`}</svg>`;

  const ensureRoot = () => {
    if (root) return;
    ensureStyles();
    root = document.createElement("div");
    root.className = "tk-stacks";
    for (const side of ["left", "right"]) {
      const box = document.createElement("div");
      box.className = `tk-deck tk-deck-${side}`;
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
      root.appendChild(box);
      decks[side] = { box, arrow, bar, thumb, cards: [], scrollX: 0, contentW: 0, viewW: 0, order: loadOrder(side) };
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
    // arrow rides the open edge of the deck and flips when fanned
    const edge = (open ? Math.min(contentW, viewW) : CARD_W) + 10;
    deck.arrow.style[side === "left" ? "left" : "right"] = `${MARGIN + edge}px`;
    deck.arrow.style.bottom = `${MARGIN + CARD_H / 2 - 17}px`;
    deck.arrow.innerHTML = arrowSvg(side === "left" ? (open ? "left" : "right") : (open ? "right" : "left"));
    deck.arrow.classList.toggle("is-hidden", n <= 1);
    // scrollbar beneath the fan, only when overflowing
    const overflow = open && contentW > viewW + 1;
    deck.bar.classList.toggle("is-on", overflow);
    if (overflow) {
      deck.bar.style.width = `${viewW}px`;
      deck.bar.style.bottom = `${MARGIN - 12}px`;
      deck.bar.style[side === "left" ? "left" : "right"] = `${MARGIN}px`;
      const thumbW = Math.max(36, viewW * (viewW / contentW));
      const frac = scrollMin ? (deck.scrollX / scrollMin) : 0;   // 0..1
      deck.thumb.style.width = `${thumbW}px`;
      deck.thumb.style[side === "left" ? "left" : "right"] = `${frac * (viewW - thumbW)}px`;
    }
  };

  const place = (card, side, i, open, step) => {
    let tx, ty, rot;
    if (open) { tx = i * step + decks[side].scrollX; ty = 0; rot = 0; }
    else { const d = Math.min(i, 6); tx = d * 3; ty = -d * 4; rot = (i % 2 ? 1 : -1) * Math.min(i, 3) * 1.6; }
    if (side === "right") { tx = -tx; rot = -rot; }
    card._tx = tx; card._ty = ty; card._rot = rot;
    // Leave the dragged card alone — keep its on-top z-index (9999, set at drag start) and
    // its follow transform. Otherwise a reorder re-layout drops it BEHIND its neighbours, so
    // it looks frozen (it's still following the cursor, just hidden) until release.
    if (!card.classList.contains("tk-dragging")) {
      card.style.zIndex = String(500 - i);
      card.style.transform = `translate(${tx}px, ${ty}px) rotate(${rot}deg)`;
    }
  };

  const toggleFan = (side) => { fanned[side] = !fanned[side]; if (!fanned[side]) decks[side].scrollX = 0; layout(side); };

  const onWheel = (side, e) => {
    if (!fanned[side]) return;
    const deck = decks[side];
    if (deck.contentW <= deck.viewW) return;
    e.preventDefault();
    deck.scrollX = clamp(deck.scrollX - (e.deltaY + e.deltaX), Math.min(0, deck.viewW - deck.contentW), 0);
    deck.cards.forEach((c) => { c.style.transition = "none"; });
    layout(side);
    requestAnimationFrame(() => deck.cards.forEach((c) => { c.style.transition = ""; }));
  };

  const wireThumb = (side, thumb) => {
    let sx = 0, startScroll = 0, drag = false;
    const move = (e) => {
      if (!drag) return;
      const deck = decks[side], scrollMin = Math.min(0, deck.viewW - deck.contentW);
      const thumbW = Math.max(36, deck.viewW * (deck.viewW / deck.contentW));
      const dxPx = (e.clientX - sx) * (side === "right" ? -1 : 1);
      const dFrac = dxPx / Math.max(1, deck.viewW - thumbW);
      deck.scrollX = clamp(startScroll + dFrac * scrollMin, scrollMin, 0);
      deck.cards.forEach((c) => { c.style.transition = "none"; });
      layout(side);
      requestAnimationFrame(() => deck.cards.forEach((c) => { c.style.transition = ""; }));
    };
    const up = () => { drag = false; window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    thumb.addEventListener("pointerdown", (e) => { e.stopPropagation(); drag = true; sx = e.clientX; startScroll = decks[side].scrollX; window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); });
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
    clone.style.backgroundImage = severityBg(sevOf(t));
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
    let pointerId = null, pointerType = "mouse", baseTx = 0, baseTy = 0;

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
        dragging = true; card.classList.add("tk-dragging"); card.style.zIndex = "9999";
        baseTx = card._tx; baseTy = card._ty;   // capture the resting slot ONCE — reorder re-lays-out the rest
      }
      if (!dragging) return;
      card.style.transform = `translate(${baseTx + dx}px, ${baseTy + dy}px) rotate(0deg) scale(1.03)`;
      // Dragged UP onto the dashboard → target a pipeline zone (highlight the one under the
      // cursor). A horizontal reorder keeps the cursor ON the cards (below stackTopY), so it
      // never reaches here — the two gestures don't collide.
      if (e.clientY < stackTopY()) { highlightZoneAt(e.clientX, e.clientY); return; }
      clearZoneHighlight();
      // Fanned out → dragging reorders the row: move this card to the slot under it and let
      // the others slide to fill the gap (the .tk-card transform transition animates it).
      if (fanned[side]) {
        const deck = decks[side];
        if (deck.cards.length > 1) {
          const step = CARD_W + GAP_FAN;
          const along = (side === "right" ? -(baseTx + dx) : (baseTx + dx)) - deck.scrollX;
          const idx = clamp(Math.round(along / step), 0, deck.cards.length - 1);
          const cur = deck.cards.indexOf(card);
          if (cur !== -1 && idx !== cur) {
            deck.cards.splice(cur, 1);
            deck.cards.splice(idx, 0, card);
            deck.order = deck.cards.map((c) => c.dataset.id);   // remember the custom order…
            saveOrder(side);                                    // …and persist it across reloads
            layout(side);                                       // animate the OTHER cards (this one is skipped while dragging)
          }
        }
      }
    };
    const onUp = (e) => {
      window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
      if (handedOff) return;                                                // native runtime owns the drop
      const wasDrag = dragging; dragging = false; down = false;
      card.classList.remove("tk-dragging");
      // Config opens on DOUBLE click; a single click does nothing (the card never moved).
      if (!wasDrag) return;
      clearZoneHighlight();
      // Released up on the dashboard → drop into the pipeline zone under the cursor, if any.
      if (e.clientY < stackTopY()) {
        const z = zoneAt(e.clientX, e.clientY);
        if (z) { dropIntoZone(card, t, z); return; }
        layout(side); return;   // not over a zone → spring back to the stack
      }
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
      `<div class="ticket-company">${esc(t.companyLabel || "Unknown")}</div>` +
      `<div class="ticket-host">${esc(t.host || "—")}</div>` +
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
    card.style.backgroundImage = severityBg(sevOf(t));
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
    deck.cards.forEach((c) => deck.box.appendChild(c));
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
  const zoneBody = {};   // stage key → body element

  // ── Glass flow arrows ─────────────────────────────────────────────────────────
  // A stylized translucent line through the pipeline: left (inbox) stack → triage, an arrow
  // between each bucket, then resolution → right (resolved) stack. Drawn as one SVG overlay,
  // each arrow a glowing glass body with a bright core + a glassy arrowhead.
  // Real arrow icons from Lucide (ISC licensed, https://lucide.dev), 24×24 viewBox each.
  const FLOW_ICON = {
    inLeft: `<path d="m15 14 5-5-5-5"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>`,        // corner-up-right
    mid: `<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>`,                            // arrow-right
    outRight: `<path d="m10 15 5 5 5-5"/><path d="M4 4h7a4 4 0 0 1 4 4v12"/>`,       // corner-right-down
  };
  let flowRoot = null, flowArrows = [];
  const ensureFlow = () => {
    if (flowRoot) return;
    ensureStyles();
    const n = STAGES.length;
    let g = `<g class="tk-flow-arrow">${FLOW_ICON.inLeft}</g>`;     // inbox stack → triage
    for (let i = 0; i < n - 1; i++) g += `<g class="tk-flow-arrow">${FLOW_ICON.mid}</g>`;
    g += `<g class="tk-flow-arrow">${FLOW_ICON.outRight}</g>`;      // resolution → resolved stack
    const wrap = document.createElement("div");
    wrap.innerHTML = `<svg class="tk-flow" xmlns="http://www.w3.org/2000/svg">${g}</svg>`;
    flowRoot = wrap.firstElementChild;
    document.body.appendChild(flowRoot);
    flowArrows = [...flowRoot.querySelectorAll(".tk-flow-arrow")];
  };
  // Place each 24×24 icon by uniform scale + translate (no distortion); stroke stays crisp via
  // non-scaling-stroke. lefts: bucket left xs; bw: bucket width; topY/botY: bucket top/bottom.
  const drawFlow = (lefts, bw, topY, botY) => {
    ensureFlow();
    const n = lefts.length, r = Math.round, bucketH = botY - topY, midY = topY + bucketH / 2;
    const lStackX = MARGIN + CARD_W / 2, rStackX = window.innerWidth - MARGIN - CARD_W / 2;
    const gap = n > 1 ? lefts[1] - lefts[0] - bw : MARGIN * 4;
    const leftRoom = (lefts[0] - MARGIN) - lStackX;                // stack → triage horizontal room
    const rightRoom = rStackX - (lefts[n - 1] + bw + MARGIN);      // resolution → stack room
    const place = (i, S, tx, ty) =>
      flowArrows[i]?.setAttribute("transform", `translate(${r(tx)},${r(ty)}) scale(${(S / 24).toFixed(4)})`);
    // 1 — corner-up-right: tail a MARGIN above the inbox stack, head pointing right into triage.
    { const S = Math.max(40, Math.min(92, bucketH * 0.45, leftRoom * 1.5)), s = S / 24;
      place(0, S, lStackX - 4 * s, botY - 20 * s); }
    // 2 — arrow-right centred in each gap between buckets.
    for (let i = 0; i < n - 1; i++) {
      const S = Math.max(34, Math.min(58, gap * 0.55, bucketH * 0.4)), s = S / 24;
      const cx = (lefts[i] + bw + lefts[i + 1]) / 2;
      place(1 + i, S, cx - 12 * s, midY - 12 * s);
    }
    // 3 — corner-right-down: head a MARGIN above the resolved stack, tail out of resolution.
    { const S = Math.max(40, Math.min(92, bucketH * 0.45, rightRoom * 1.5)), s = S / 24;
      place(n, S, rStackX - 15 * s, botY - 20 * s); }
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
    const bucketW = Math.min(CARD_W + 44, (region.width - MARGIN * (n + 1)) / n);  // one full card, snug
    const gap = (region.width - bucketW * n) / (n + 1);          // equal gap incl. both ends
    const lefts = [];
    STAGES.forEach((s, i) => {
      const left = region.left + gap * (i + 1) + bucketW * i;
      lefts.push(left);
      const panel = zoneBody[s.key]?.parentElement;
      if (!panel) return;
      panel.style.width = `${Math.round(bucketW)}px`;
      panel.style.left = `${Math.round(left)}px`;
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
      panel.innerHTML = `<div class="tk-zone-hd"><span>${esc(s.label)}</span><span class="tk-zone-count">0</span></div><div class="tk-zone-body"></div>`;
      zonesRoot.appendChild(panel);
      zoneBody[s.key] = panel.querySelector(".tk-zone-body");
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
  const highlightZoneAt = (x, y) => {
    const hit = zoneAt(x, y);
    STAGES.forEach((s) => zoneBody[s.key]?.parentElement?.classList.toggle("is-target", s.key === hit));
    return hit;
  };
  const clearZoneHighlight = () => STAGES.forEach((s) => zoneBody[s.key]?.parentElement?.classList.remove("is-target"));

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
        dragging = true;
        const r = card.getBoundingClientRect();
        clone = document.createElement("div");
        clone.className = "tk-zfly";
        clone.style.cssText = `left:${r.left}px; top:${r.top}px; width:${r.width}px; height:${r.height}px; transition:none;`;
        clone.style.backgroundColor = baseColor();
        clone.style.backgroundImage = severityBg(sevOf(t));
        clone.innerHTML = zoneCardInner(t);
        document.body.appendChild(clone);
        card.classList.add("tk-zdrag");
      }
      if (!dragging) return;
      clone.style.transform = `translate(${dx}px, ${dy}px) scale(1.04)`;
      highlightZoneAt(e.clientX, e.clientY);
    };
    const onUp = (e) => {
      window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
      const wasDrag = dragging; dragging = false; down = false;
      clearZoneHighlight();
      if (clone) { clone.remove(); clone = null; }
      card.classList.remove("tk-zdrag");
      if (!wasDrag) { window.ticketDetail?.open(t, card); return; }
      const z = zoneAt(e.clientX, e.clientY);
      if (z && z !== stage) { setStage(t.id, z); render(); return; }                  // → another stage
      if (!z && e.clientY >= stackTopY()) { setStage(t.id, null); render(); return; }  // → back to the inbox stack
      // else: same zone / nowhere → the card just un-hides in place.
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
    card.style.backgroundImage = severityBg(sevOf(t));
    card.innerHTML = zoneCardInner(t);
    wireZoneCard(card, t, stage);
    return card;
  };

  const renderZones = () => {
    ensureZones();
    const order = (a, b) => (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0);
    STAGES.forEach((s) => {
      const body = zoneBody[s.key];
      const list = tickets.filter((t) => stageOf(t.id) === s.key).sort(order);
      body.innerHTML = list.length ? "" : `<div class="tk-zone-empty">Drag tickets here</div>`;
      list.forEach((t) => body.appendChild(zoneCardEl(t, s.key)));
      const count = body.parentElement.querySelector(".tk-zone-count");
      if (count) count.textContent = String(list.length);
    });
  };

  // Drop a ticket dragged from a corner stack into a zone: assign the stage, leave the stack,
  // and fly a shrinking clone from the drop point into its new card in the zone.
  const dropIntoZone = (fromCard, t, stage) => {
    const from = fromCard.getBoundingClientRect();
    setStage(t.id, stage);
    render();
    const dest = zoneBody[stage]?.querySelector(`.tk-zcard[data-id="${cssEsc(t.id)}"]`);
    if (!dest) return;
    const to = dest.getBoundingClientRect();
    const clone = document.createElement("div");
    clone.className = "tk-zfly";
    clone.style.cssText = `left:${from.left}px; top:${from.top}px; width:${from.width}px; height:${from.height}px; transform-origin: top left;`;
    clone.style.backgroundColor = baseColor();
    clone.style.backgroundImage = severityBg(sevOf(t));
    clone.innerHTML = zoneCardInner(t);
    document.body.appendChild(clone);
    dest.style.opacity = "0";
    requestAnimationFrame(() => {
      clone.style.transform = `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`;
    });
    setTimeout(() => { clone.remove(); if (dest.isConnected) dest.style.opacity = ""; }, 300);
  };

  const render = () => {
    ensureRoot(); ensureZones();
    matchCardSize(); sizeRoot(); layoutZones(); syncDropFloor();
    const onGrid = onGridIds();
    const order = (a, b) => (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0);
    // Staged tickets live in their zone; the rest sit in the corner stacks (the inbox).
    const avail = tickets.filter((t) => !onGrid.has(t.id) && !stageOf(t.id));
    buildDeck("left", avail.filter((t) => (t.state || "open") !== "resolved").sort(order));
    buildDeck("right", avail.filter((t) => (t.state || "open") === "resolved").sort(order));
    renderZones();
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

  window.ticketStacks = { reload: load };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load);
  else load();
})();
