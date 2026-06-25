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
    const host = (gridCard() && gridCard().parentElement) || document.body;
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
    return `linear-gradient(180deg, rgba(${SEV_RGB[sev]},0.4), rgba(${SEV_RGB[sev]},0.2))`;
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
      decks[side] = { box, arrow, bar, thumb, cards: [], scrollX: 0, contentW: 0, viewW: 0 };
    }
    document.body.appendChild(root);
    window.addEventListener("resize", () => { matchCardSize(); sizeRoot(); layout("left"); layout("right"); });
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
    card.style.zIndex = String(500 - i);
    if (!card.classList.contains("tk-dragging")) card.style.transform = `translate(${tx}px, ${ty}px) rotate(${rot}deg)`;
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

  // Add the dropped ticket to the dashboard grid as its OWN BARE ticket widget (identical to
  // the static one — no shell), keyed uniquely, sized to 3 rows via the runtime, and fed its
  // specific ticket. Many can coexist; if already present, just refresh it.
  const addTicketToGrid = (t) => {
    if (!t || !t.id) return null;
    const layout = document.querySelector('.widget-layout[data-widget-layout-key="builder-chart"]');
    if (!layout || typeof layout.__initWidget !== "function") { window.ticketGrid?.show(t); return null; }
    const key = `ticket-pin-${t.id}`;
    const sel = (window.CSS && CSS.escape) ? CSS.escape(key) : key;
    let card = layout.querySelector(`[data-widget-key="${sel}"]`);
    let cell = null;
    if (!card) {
      cell = nextCell(layout);
      card = document.createElement("div");
      card.className = "widget-card ticket-widget-card";
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
    return card;
  };

  // Drop onto the dashboard → add a new grid widget for it, remove it from its stack (one
  // canonical ticket), and fly a clone into the new cell for a seamless hand-off.
  const flyIntoGrid = (card, t) => {
    // Clone the source card NOW — re-render below drops it from the stack.
    const cr = card.getBoundingClientRect();
    const clone = card.cloneNode(true);
    clone.className = "tk-card tk-flying";
    clone.style.cssText = `position:fixed; left:${cr.left}px; top:${cr.top}px; width:${cr.width}px; height:${cr.height}px; margin:0; z-index:9999;`;
    document.body.appendChild(clone);
    const placed = addTicketToGrid(t);
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

  // ── Native-style drop preview ────────────────────────────────────────────────
  // While dragging a stack card over the dashboard, show the SAME blue dashed
  // .widget-placeholder the native widget drag uses, snapped to the target grid cell,
  // so you can see where the ticket will land.
  const gridLayout = () => document.querySelector('.widget-layout[data-widget-layout-key="builder-chart"]');
  const stackTopY = () => window.innerHeight - (CARD_H + MARGIN * 2);
  let dropPh = null;
  // Show the placeholder at the cell the widget will ACTUALLY land in (the runtime compacts
  // to the next free cell, so previewing the cursor cell would be a lie).
  const showDropPreview = () => {
    const layout = gridLayout(); if (!layout) return;
    const cell = nextCell(layout);
    if (!dropPh) { dropPh = document.createElement("div"); dropPh.className = "widget-placeholder tk-drop-preview"; }
    dropPh.style.gridColumn = `${cell.col} / span 1`;
    dropPh.style.gridRow = `${cell.row} / span 3`;
    if (dropPh.parentElement !== layout) layout.appendChild(dropPh);
  };
  const clearDropPreview = () => { if (dropPh) dropPh.remove(); };

  const wireCard = (card, t) => {
    let startX = 0, startY = 0, dragging = false, down = false;
    const onMove = (e) => {
      if (!down) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) > 6) { dragging = true; card.classList.add("tk-dragging"); card.style.zIndex = "9999"; }
      if (dragging) {
        card.style.transform = `translate(${card._tx + dx}px, ${card._ty + dy}px) rotate(0deg) scale(1.03)`;
        if (e.clientY < stackTopY()) showDropPreview(); else clearDropPreview();
      }
    };
    const onUp = (e) => {
      window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
      const wasDrag = dragging; dragging = false; down = false;
      card.classList.remove("tk-dragging");
      card.style.transform = `translate(${card._tx}px, ${card._ty}px) rotate(${card._rot}deg)`;   // spring back
      clearDropPreview();
      if (!wasDrag) { flyIntoGrid(card, t); return; }                      // click → into the grid cell
      // Dropped up in the dashboard area (above the bottom stack zone) → bring it in.
      if (e.clientY < stackTopY()) flyIntoGrid(card, t);
    };
    card.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      down = true; startX = e.clientX; startY = e.clientY;
      window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
    });
  };

  const cardEl = (t) => {
    const created = t.createdAt ? Date.parse(t.createdAt) : NaN;
    const endMs = t.recoveredAt ? Date.parse(t.recoveredAt) : Date.now();
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
    card.innerHTML =
      `<div class="ticket-body">` +
      `<div class="ticket-company">${esc(t.companyLabel || "Unknown")}</div>` +
      `<div class="ticket-host">${esc(t.host || "—")}</div>` +
      `<div class="ticket-down">Down ${esc(human(endMs - created))}</div>` +
      `</div>`;
    wireCard(card, t);
    return card;
  };

  const buildDeck = (side, list) => {
    const deck = decks[side];
    deck.cards.forEach((c) => c.remove());
    deck.cards = list.map(cardEl);
    deck.cards.forEach((c) => deck.box.appendChild(c));
    if (!deck.cards.length) { fanned[side] = false; deck.scrollX = 0; }
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

  const render = () => {
    ensureRoot();
    matchCardSize(); sizeRoot();
    const onGrid = onGridIds();
    const order = (a, b) => (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0);
    const avail = tickets.filter((t) => !onGrid.has(t.id));
    buildDeck("left", avail.filter((t) => (t.state || "open") !== "resolved").sort(order));
    buildDeck("right", avail.filter((t) => (t.state || "open") === "resolved").sort(order));
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
