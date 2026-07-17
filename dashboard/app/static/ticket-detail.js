// ticket-detail.js — the guided ticket work screen, with a context-aware choreographed open:
//   left-click a ticket card → a flat opaque clone glides from the card's spot in a
//   direction that depends on WHERE the card lives, then the config panel slides out.
//   The panel ALWAYS prefers the card's LEFT side, flipping to the right only at a screen
//   edge where a left panel wouldn't fit (so almost always left). The card's MOTION:
//     • fanned-deck card     → rises so its bottom edge meets the top of the resting row.
//     • bucket card, occluded → slides right until its left edge clears the column (sits
//                              BESIDE the others, never on top of them).
//     • closed-pile top card / front-most bucket card → stays put (already fully visible).
//   (A bucket card that's scrolled out of view is first smoothly scrolled into the bucket
//   by ticket-stacks.js before this open runs.)
//   close → the panel collapses back in, then the card flies back to its place.
//
// The work screen preserves the original guided flow: identity, priority, assignee,
// description, note, activity, and state actions. It portals to <body> so the card
// flight and the glass work surface are not flattened by a parent transform.
(() => {
  const PRIORITIES = ["low", "medium", "high", "critical"];
  const GAP = 10;            // gap between the card and the panel — matches GAP_FAN (the fanned-stack gap)
  const PANEL_W = 360;
  // Tuck distance: the panel must hide FAR enough left that even its drop shadow
  // (blur 42px ⇒ ~60px reach) clears the clip-path's left edge — otherwise the
  // shadow peeks past the clip and sits frozen mid-screen while the card flies.
  const TUCK = PANEL_W + GAP + 96;          // 412px — panel + gap + shadow reach
  const SEV_RGB = { low: "34,211,238", medium: "250,204,21", high: "249,115,22", critical: "239,68,68", none: "120,130,140" };
  const EASE = "cubic-bezier(.4, 0, .2, 1)"; // balanced glide (no front-loaded snap)
  const FLY_MS = 420, SLIDE_MS = 360, SLIDE_DELAY = 270, SETTLE_MS = 700;
  const CLOSE_SLIDE_MS = 190, CLOSE_FLY_MS = 280;   // close is snappier than open; panel fully retracts THEN card returns
  const DOF_BLUR = 4, DOF_OUT_MS = 320;             // depth-of-field: peak blur of the world behind the open ticket + its detransition
  let overlay = null, panel = null, flyCard = null, wrap = null;
  let currentId = null, sourceEl = null, backTransform = "", subscribed = false, closing = false;
  let geo = null, settleTimer = null, panelFitRaf = 0, panelSide = "right";   // which side the panel emerges from
  let cardStays = false;     // true when the card doesn't move (front/closed-pile card) → panel opens with no delay
  let scrim = null;          // full-screen backdrop-blur layer behind the flyer/panel (depth-of-field)
  const slideBack = () => `translateX(${panelSide === "left" ? "" : "-"}${TUCK}px)`;  // retract direction (mirrors per side)
  const openSections = new Set();

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const human = (ms) => {
    if (!Number.isFinite(ms) || ms < 0) return "—";
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d) return `${d}d ${h % 24}h`;
    if (h) return `${h}h ${m % 60}m`;
    if (m) return `${m}m`;
    return `${s}s`;
  };
  const shortTime = (iso) => { try { return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return ""; } };

  const ensureStyles = () => {
    if (document.getElementById("ticket-detail-styles")) return;
    const style = document.createElement("style");
    style.id = "ticket-detail-styles";
    style.textContent = `
      /* No scrim — background not dimmed; the panel's backdrop-filter blurs the real bg. */
      .ticket-detail-overlay { position: fixed; inset: 0; z-index: 5000; background: transparent; -webkit-app-region: no-drag;
        -webkit-user-select: none; user-select: none; }
      /* The ONLY place text selection / a text caret is allowed: the guided screen's editable fields. */
      .ticket-detail .td-edit, .ticket-detail .td-in { -webkit-user-select: text; user-select: text; cursor: text; }
      .ticket-detail-overlay[hidden] { display: none; }
      /* Depth-of-field: a full-screen layer UNDER the flyer + panel whose backdrop-filter blurs
         everything behind the overlay (dashboard, stacks, buckets). The flyer/panel paint above it
         so they stay tack-sharp. Blur ramps 0→peak during the open and back to 0 on close (set in JS). */
      .td-scrim { position: fixed; inset: 0; z-index: 0; pointer-events: none;
        -webkit-backdrop-filter: blur(0px); backdrop-filter: blur(0px); }

      /* The flyer that glides from the grid spot to centre (and back). It is a PLAIN,
         OPAQUE card built from scratch — NOT a clone of the live widget — so:
           • no widget/db-panel/surface class can ever wash it brighter than hover, and
           • no backdrop-filter ⇒ no saturate() compositing bloom mid-flight.
         Opaque also means it genuinely OCCLUDES the panel sliding out from behind it. */
      .td-card { z-index: 2; margin: 0 !important; cursor: default !important; box-sizing: border-box;
        pointer-events: none !important;   /* inert: cursor passes through to the overlay */
        /* border-box so width/height === the source card's border-box rect — the clone is a
           pixel-exact stand-in (no size-pop on open) and targetLeft+cardW is the TRUE edge. */
        transition: transform ${FLY_MS}ms ${EASE} !important; will-change: transform; }
      /* On close the card returns ONLY after the panel has fully retracted (delay = the
         panel's retract time), and faster. !important to beat the base .td-card transition. */
      .td-card.returning { transition: transform ${CLOSE_FLY_MS}ms ${EASE} ${CLOSE_SLIDE_MS}ms !important; }
      .td-flyer { padding: 14px 15px; border-radius: 15px; color: #fff;
        display: flex; flex-direction: column; overflow: hidden;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.22), 0 8px 22px rgba(0,0,0,0.18); }
      .td-flyer .ticket-body { display: flex; flex-direction: column; gap: 4px; height: 100%; }

      /* Clip window: left edge at the card's RIGHT edge; the panel slides out of it from
         behind the opaque card. DURING the slide the panel has NO drop shadow (so there is
         never a clipped / "baked-in" shadow edge on the left); once it is fully out we drop
         the clip and FADE the real shadow in. */
      .td-wrap { position: fixed; z-index: 1; clip-path: inset(-260px -260px -260px 0); }
      .td-wrap.is-settled { clip-path: none; }
      .td-wrap .ticket-detail { margin-left: ${GAP}px; transform: translateX(-${TUCK}px);
        transition: transform ${SLIDE_MS}ms ${EASE}, width ${SLIDE_MS}ms ${EASE}, height ${SLIDE_MS}ms ${EASE}; will-change: transform, width, height; }
      .td-wrap.is-open .ticket-detail { transform: translateX(0); transition-delay: ${SLIDE_DELAY}ms; }  /* slide out AFTER the card centres */
      /* LEFT-side panel (mirror image): the panel sits to the card's LEFT, tucks to the RIGHT
         behind the card, and slides out leftward. The wrap anchor + clip-path are set inline
         per-side in buildStage(); these rules just flip the gap + tuck direction. */
      .td-wrap.td-left .ticket-detail { margin-left: 0; margin-right: ${GAP}px; transform: translateX(${TUCK}px); }
      .td-wrap.td-left.is-open .ticket-detail { transform: translateX(0); transition-delay: ${SLIDE_DELAY}ms; }
      /* Card that doesn't move (front bucket card / closed-pile top) → the panel has nothing to wait
         for, so it slides immediately (no fly delay) on open. */
      .td-wrap.td-instant.is-open .ticket-detail, .td-wrap.td-instant.td-left.is-open .ticket-detail { transition-delay: 0ms; }

      /* THE MENU shell — the .dashboard-search-popover / .auth-profile-menu recipe.
         Drop shadow alpha starts at 0 (invisible) so it can be transitioned in at settle —
         two matching shadow layers keep the box-shadow transition smooth. */
      .ticket-detail { width: ${PANEL_W}px; box-sizing: border-box; overflow: hidden;
        padding: 11px 10px; border-radius: 14px; color: #fff;
        display: flex; flex-direction: column; gap: 9px;
        background: linear-gradient(180deg, rgba(22,26,36,0.62), rgba(12,16,24,0.55));
        -webkit-backdrop-filter: blur(26px) saturate(140%); backdrop-filter: blur(26px) saturate(140%);
        border: 1px solid rgba(255,255,255,0.22);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.24), 0 18px 42px rgba(0,0,0,0); }
      .td-wrap.is-settled .ticket-detail { box-shadow: inset 0 1px 0 rgba(255,255,255,0.24), 0 18px 42px rgba(0,0,0,0.4); }
      .ticket-detail :focus, .ticket-detail :focus-visible { outline: none !important; box-shadow: none !important; }
      /* Header: "name | ip" on top, then "Down <time> | <opened timestamp>". */
      .td-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 0 4px; }
      .td-title { display: flex; align-items: baseline; gap: 6px; min-width: 0; font-size: var(--crm-type-object,14px); font-weight: 700; line-height: 1.2; }
      .td-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .td-ip { font-size: var(--crm-type-caption,11px); font-weight: 500; color: rgba(255,255,255,0.55); font-variant-numeric: tabular-nums; white-space: nowrap; }
      .td-sep { color: rgba(255,255,255,0.28); font-weight: 400; }
      /* Editable title/subtitle inputs styled to read like the header text until focused. */
      .td-edit { font: inherit; color: inherit; background: transparent; border: 0; border-radius: 6px;
        padding: 1px 4px; margin: 0; outline: none; min-width: 0; transition: background .14s ease, box-shadow .14s ease; }
      .td-edit::placeholder { color: rgba(255,255,255,0.32); font-weight: 600; }
      .td-edit:hover { background: rgba(255,255,255,0.06); }
      .td-edit:focus { background: rgba(255,255,255,0.10); box-shadow: inset 0 0 0 1px rgba(125,180,255,0.55); }
      input.td-name { flex: 1 1 auto; }
      input.td-ip { flex: 0 1 auto; width: 9ch; }
      input.td-ip:focus { width: 16ch; }
      .td-x { -webkit-appearance: none; appearance: none; background: transparent; border: 0; padding: 0 2px; margin: 0;
        color: rgba(255,255,255,0.5); font-size: 17px; line-height: 1; cursor: pointer; transition: color .14s ease; }
      .td-x:hover { color: #fff; }
      .td-meta { padding: 0 4px; font-size: var(--crm-type-caption,11px); color: rgba(255,255,255,0.6); }
      .td-time { padding: 0 4px; margin-top: -4px; font-size: var(--crm-type-meta,10px); color: rgba(255,255,255,0.4); font-variant-numeric: tabular-nums; }

      /* Accordion section: dropdown header + a body that animates open below it. */
      .td-acc { display: flex; flex-direction: column; }
      .td-acc-head { -webkit-appearance: none; appearance: none; display: flex; align-items: center; justify-content: flex-start; gap: 8px;
        width: 100%; border: 0; background: transparent; cursor: pointer; padding: 0 4px; margin: 0; text-align: left;
        font: inherit; font-size: var(--crm-type-control,13px); font-weight: 600; color: rgba(255,255,255,0.6); transition: color .14s ease; }
      .td-acc-head:hover { color: #fff; }
      .td-acc.is-open > .td-acc-head { color: #fff; }
      .td-acc-caret { display: inline-block; width: 9px; font-size: 0.72rem; color: rgba(255,255,255,0.4); transition: transform .14s ease; }
      .td-acc.is-open > .td-acc-head .td-acc-caret { transform: rotate(90deg); }
      .td-acc-body { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .24s ease; }
      .td-acc.is-open > .td-acc-body { grid-template-rows: 1fr; }
      .td-acc-inner { overflow: hidden; min-height: 0; }
      .td-acc-pad { padding: 3px 4px 7px 21px; }

      .td-prio { display: flex; gap: 12px; }
      .td-prio-opt { -webkit-appearance: none; appearance: none; background: transparent; border: 0; padding: 0; margin: 0; cursor: pointer;
        font: inherit; font-size: 0.85rem; color: rgba(255,255,255,0.45); transition: color .14s ease; }
      .td-prio-opt:hover { color: rgba(255,255,255,0.8); }
      .td-prio-opt.is-active { color: #fff; font-weight: 700; }

      .td-in { width: 100%; box-sizing: border-box; border: 1px solid rgba(255,255,255,0.18); border-radius: 9px;
        background: rgba(255,255,255,0.06); color: #fff; font: inherit; font-size: var(--crm-type-body,12px); padding: 7px 10px; }
      .td-in:focus { border-color: rgba(255,255,255,0.34); }
      .td-ta { resize: none; min-height: 0; height: auto; line-height: 1.4; overflow:hidden; }

      /* Claim + Resolve share one row, pinned to the bottom of the card-height panel. */
      .td-acts { display: flex; flex-direction: row; gap: 20px; margin-top: auto; padding-top: 6px; }
      .td-act { -webkit-appearance: none; appearance: none; display: inline-flex; align-items: center; justify-content: flex-start;
        text-align: left; width: auto; border: 0; background: transparent; cursor: pointer; border-radius: 8px;
        padding: 0 4px; margin: 0; font: inherit; font-size: 0.9rem; font-weight: 600; color: rgba(255,255,255,0.62); transition: color .14s ease; }
      .td-act:hover { color: #fff; }
      .td-act.td-danger { color: rgba(255,135,135,0.85); margin-left: auto; }   /* Delete/Restore sits at the far end */
      .td-act.td-danger:hover { color: #ff8a8a; }

      .td-log { display: flex; flex-direction: column; gap: 7px; max-height: none; overflow: visible;
        background: rgba(255,255,255,0.05); border-radius: 9px; padding: 8px 9px; }
      .td-ev { font-size: var(--crm-type-caption,11px); color: rgba(255,255,255,0.78); }
      .td-ev b { font-weight: 700; }
      .td-ev .td-at { color: rgba(255,255,255,0.4); }
      .td-ev-note { color: rgba(255,255,255,0.6); margin-top: 1px; }
      .td-log-empty, .td-empty { color: rgba(255,255,255,0.45); font-size: var(--crm-type-caption,11px); }
    `;
    document.head.appendChild(style);
  };

  const ensureOverlay = () => {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "ticket-detail-overlay";
    overlay.hidden = true;
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) requestClose(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && overlay && !overlay.hidden) requestClose(); });
    document.body.appendChild(overlay);
  };

  // Opaque colour of whatever sits behind the ticket card (the dashboard surface), used
  // as the flyer's solid base so it matches the resting glass card without transparency.
  const dashboardColor = () => {
    let el = sourceEl ? sourceEl.parentElement : null;
    while (el) {
      const c = getComputedStyle(el).backgroundColor;
      if (c && c !== "transparent" && !/^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(c)) return c;
      el = el.parentElement;
    }
    return "rgb(108, 114, 128)";
  };

  // Paint the flyer to match the resting card EXACTLY: copy the source card's ALREADY-
  // RESOLVED computed background (db-panel-custom-color accent + ~20% white mix, for its
  // current data-severity) over an opaque dashboard base. Re-callable so the flying card
  // can be recoloured LIVE when the severity changes mid-edit.
  const paintFlyer = (fallbackRgb) => {
    if (!flyCard) return;
    flyCard.style.backgroundColor = dashboardColor();
    const cs = sourceEl ? getComputedStyle(sourceEl) : null;
    const layers = [];
    if (cs && cs.backgroundImage && cs.backgroundImage !== "none") layers.push(cs.backgroundImage);
    if (cs && cs.backgroundColor && !/^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(cs.backgroundColor)) layers.push(`linear-gradient(${cs.backgroundColor}, ${cs.backgroundColor})`);
    flyCard.style.backgroundImage = layers.length ? layers.join(", ") : `linear-gradient(180deg, rgba(${fallbackRgb},0.16), rgba(${fallbackRgb},0.05))`;
  };

  // A static, opaque copy of a bucket card pinned over its real position on the overlay. Used for the
  // cards IN FRONT of an opening one: stacked ABOVE the flyer so the flyer slides out from UNDER them
  // (keeping its z-order) instead of jumping on top. Torn down with the overlay (innerHTML cleared).
  const cloneFrontCard = (card, z) => {
    const r = card.getBoundingClientRect();
    const el = card.cloneNode(true);           // keeps the card's inline background + body markup
    el.removeAttribute("id");
    el.classList.add("td-frontclone");         // so the depth-of-field ramp can blur it like the rest of the world
    Object.assign(el.style, {
      position: "fixed", boxSizing: "border-box", margin: "0",
      left: `${Math.round(r.left)}px`, top: `${Math.round(r.top)}px`,
      width: `${Math.round(r.width)}px`, height: `${Math.round(r.height)}px`,
      transform: "none", transition: "none", zIndex: String(z), pointerEvents: "none", filter: "blur(0px)",
    });
    // The real card is clipped by the bucket's scroll viewport (.tk-zone-clip, overflow:hidden); the
    // overlay clone isn't, so clip it to the SAME rect — otherwise the part of a front card that's
    // scrolled past the bucket's edge spills out below/above the bucket.
    const clipEl = card.closest(".tk-zone-clip");
    if (clipEl) {
      const vr = clipEl.getBoundingClientRect();
      const t = Math.max(0, vr.top - r.top), b = Math.max(0, r.bottom - vr.bottom);
      const l = Math.max(0, vr.left - r.left), rt = Math.max(0, r.right - vr.right);
      if (t || b || l || rt) el.style.clipPath = `inset(${Math.round(t)}px ${Math.round(rt)}px ${Math.round(b)}px ${Math.round(l)}px)`;
    }
    overlay.appendChild(el);
  };

  // The flyer's inner markup = the source card's body PLUS its progress-bar "battery" (a SIBLING of
  // the body on the real card, so the old body-only copy dropped it). Shared by build + live sync.
  const flyerInner = () => {
    const body = sourceEl ? sourceEl.querySelector(".ticket-body, [data-ticket-mount]") : null;
    const bars = sourceEl ? sourceEl.querySelector(".tk-bars-card") : null;
    return `<div class="ticket-body">${body ? body.innerHTML : ""}</div>` + (bars ? bars.outerHTML : "");
  };
  // Mirror the (live-patched) source card onto the flyer: refresh its bars + body and recolour it, so
  // the flying card tracks edits in real time (a filled field greening a segment; a severity recolour).
  const syncFlyer = () => {
    if (!flyCard || !sourceEl) return;
    flyCard.innerHTML = flyerInner();
    const active = panel && panel.querySelector(".td-prio-opt.is-active");
    paintFlyer(SEV_RGB[active ? active.dataset.prio : "medium"] || SEV_RGB.medium);
  };

  // For a FANNED-stack card: does the config panel fit beside it at its CURRENT height — clear of the
  // other fanned cards AND on-screen? Prefer left. Returns "left" | "right" | null (null → no room).
  const fannedSideRoom = (srcEl, deck) => {
    const sr = srcEl.getBoundingClientRect(), vw = window.innerWidth;
    const others = Array.from(deck.querySelectorAll(".tk-card"))
      .filter((c) => c !== srcEl).map((c) => c.getBoundingClientRect());
    const clear = (a, b) => !others.some((o) => o.right > a + 0.5 && o.left < b - 0.5);   // no card overlaps [a,b]
    if (sr.left - GAP - PANEL_W >= 10 && clear(sr.left - GAP - PANEL_W, sr.left - GAP)) return "left";
    if (sr.right + GAP + PANEL_W <= vw - 10 && clear(sr.right + GAP, sr.right + GAP + PANEL_W)) return "right";
    return null;
  };

  // Map the clicked card to its OPEN MOTION (how the flyer travels) and an optional forced panel side.
  // The side is otherwise UNIFORM (buildStage prefers LEFT, flipping right only at a screen edge):
  //   • fanned-deck card     → if the config fits beside it at its current height (clear of the row,
  //     on-screen) → STAY and open on that side; otherwise RISE (bottom edge meets the row's top).
  //   • closed-pile top card → STAY (it's already fully visible).
  //   • bucket card, occluded → SLIDE right until its left edge clears the column, so it sits BESIDE
  //     the others (never gaining z-order over them); the front-most (visible) card → STAY.
  //   • anything else (grid widget / trash drawer) → fly to CENTRE.
  const contextOf = (srcEl) => {
    if (!srcEl || !srcEl.closest) return { motion: "center" };
    if (srcEl.closest(".tk-zone")) {
      const track = srcEl.closest(".tk-zone-track");
      const cards = track ? track.querySelectorAll(".tk-zcard") : [];
      return { motion: cards.length && cards[cards.length - 1] === srcEl ? "stay" : "slide" };
    }
    const deck = srcEl.closest(".tk-deck");
    if (deck) {
      if (!deck.classList.contains("is-fanned")) return { motion: "stay" };   // closed pile top card
      const side = fannedSideRoom(srcEl, deck);
      return side ? { motion: "stay", side } : { motion: "rise" };
    }
    return { motion: "center" };
  };

  // Build the flyer card + the (collapsed) config panel, positioned for the context-aware
  // open. Returns once the DOM is laid out at the START of the animation.
  const buildStage = (ticket) => {
    overlay.innerHTML = "";
    scrim = document.createElement("div");   // depth-of-field layer, behind everything else on the overlay
    scrim.className = "td-scrim";
    overlay.appendChild(scrim);
    const vw = window.innerWidth, vh = window.innerHeight;
    const sr = sourceEl ? sourceEl.getBoundingClientRect() : { left: vw / 2 - 93, top: vh / 2 - 140, width: 186, height: 279 };
    const sourceW = sr.width, sourceH = sr.height, cardW = sr.width, cardH = sr.height;
    const ctx = contextOf(sourceEl);
    const motion = ctx.motion;
    cardStays = motion === "stay";

    // Flyer destination from the motion; its shared vertical center is finalized
    // after the complete panel content has been measured.
    let tT = sr.top, tL = sr.left;
    if (motion === "rise") tT = sr.top - cardH;          // bottom edge meets the resting row's top edge
    else if (motion === "slide") tL = sr.left + cardW;   // left edge clears the column's right edge
    else if (motion === "center") { tL = (vw - cardW) / 2; tT = (vh - cardH) / 2; }
    let targetLeft = Math.round(Math.max(10, Math.min(tL, vw - 10 - cardW)));

    // Panel side: prefer LEFT; flip to RIGHT only when a left panel would fall off-screen (edges
    // only — almost always left). A card that actually moves may still overflow its chosen side,
    // so nudge just that card back on-screen; a stationary card (rise/stay) is left untouched.
    const fits = (left, side) => side === "left"
      ? left - GAP - PANEL_W >= 10
      : left + cardW + GAP + PANEL_W <= vw - 10;
    let side = ctx.side || "left";   // ctx.side is forced for a fanned card with verified room beside it
    if (!ctx.side && !fits(targetLeft, "left") && fits(targetLeft, "right")) side = "right";
    if (!fits(targetLeft, side)) {
      targetLeft = side === "left"
        ? Math.round(Math.max(10 + GAP + PANEL_W, Math.min(targetLeft, vw - 10 - cardW)))
        : Math.round(Math.max(10, Math.min(targetLeft, vw - 10 - cardW - GAP - PANEL_W)));
      cardStays = false;
    }
    panelSide = side;

    panel = document.createElement("div");
    panel.className = "ticket-detail crm-menu-surface";
    panel.style.cssText = `position:fixed;left:-10000px;top:0;width:${PANEL_W}px;height:auto;transition:none;`;
    overlay.appendChild(panel);
    render(ticket);
    const naturalPanelH = Math.ceil(panel.scrollHeight + Math.max(0, panel.offsetHeight - panel.clientHeight));
    const panelH = Math.max(naturalPanelH, Math.min(vh - 20, sourceH + 34));
    const sharedHalf = Math.max(cardH, panelH) / 2;
    const centerY = Math.round(Math.max(10 + sharedHalf, Math.min(tT + cardH / 2, vh - 10 - sharedHalf)));
    const targetTop = Math.round(centerY - cardH / 2);
    geo = { targetLeft, targetTop, cardW, cardH, sourceW, sourceH, panelW:PANEL_W, panelH, panelSourceW:Math.min(sourceW, PANEL_W), panelSourceH:sourceH, centerY };

    // Build the flyer FRESH (not a clone). A clone drags along every widget class +
    // backdrop-filter, which is what washed it brighter-than-hover mid-flight. A plain
    // opaque div with only the visual styles can't be highlighted by anything.
    const pv = ticket ? (window.ticketStacks?.fieldValue?.(ticket.id, "priority") || "") : "";   // meta-aware saved severity
    const prio = ["low", "medium", "high", "critical"].includes(pv) ? pv : (ticket ? "medium" : "none");
    flyCard = document.createElement("div");
    flyCard.className = "td-card td-flyer";
    flyCard.innerHTML = flyerInner();   // body + progress bars
    backTransform = `translate(${Math.round(sr.left - targetLeft)}px, ${Math.round(sr.top - targetTop)}px)`;
    flyCard.style.cssText = `position:fixed; left:${targetLeft}px; top:${targetTop}px; width:${cardW}px; height:${cardH}px; transform:${backTransform};`;
    paintFlyer(SEV_RGB[prio]);
    overlay.appendChild(flyCard);

    // Occluded bucket card (slide): clone the cards IN FRONT of it ABOVE the flyer so it slides out
    // from UNDER them (and back under, on close) — it never jumps over the rest of the stack. The
    // panel then sits above those clones so it still covers the column once it's out.
    let panelZ = 0;   // 0 → leave the CSS default (panel below the flyer)
    if (motion === "slide" && sourceEl) {
      const track = sourceEl.closest(".tk-zone-track");
      const sibs = track ? Array.from(track.querySelectorAll(".tk-zcard")) : [];
      const fronts = sibs.slice(sibs.indexOf(sourceEl) + 1);
      fronts.forEach((c, i) => cloneFrontCard(c, 3 + i));   // flyer is z-index 2 → clones ride above it
      if (fronts.length) panelZ = 3 + fronts.length;        // panel above every front clone
    }

    wrap = document.createElement("div");
    wrap.className = panelSide === "left" ? "td-wrap td-left" : "td-wrap";
    if (cardStays) wrap.classList.add("td-instant");        // no fly → panel opens with no delay
    if (panelZ) wrap.style.zIndex = String(panelZ);
    if (panelSide === "left") {
      wrap.style.right = `${Math.round(vw - targetLeft)}px`;   // wrap RIGHT edge sits at the card's LEFT edge
      wrap.style.clipPath = "inset(-260px 0 -260px -260px)";   // hide everything RIGHT of the card's left edge
    } else {
      wrap.style.left = `${targetLeft + cardW}px`;             // wrap LEFT edge sits at the card's RIGHT edge
      wrap.style.clipPath = "inset(-260px -260px -260px 0)";   // hide everything LEFT of the card's right edge
    }
    wrap.style.top = `${targetTop + cardH / 2}px`;
    wrap.style.transform = "translateY(-50%)";
    panel.style.cssText = `width:${Math.round(geo.panelSourceW)}px;height:${Math.round(geo.panelSourceH)}px;overflow:hidden;`;
    wrap.appendChild(panel);
    overlay.appendChild(wrap);
  };

  const fitPanelToContent = () => {
    if (!panel || !wrap || !geo || closing) return;
    cancelAnimationFrame(panelFitRaf);
    panelFitRaf = requestAnimationFrame(() => {
      panelFitRaf = 0; if (!panel || !wrap || !geo || closing) return;
      const required = Math.ceil(panel.scrollHeight + Math.max(0, panel.offsetHeight - panel.clientHeight));
      if (required <= geo.panelH + 1) return;
      geo.panelH = required;
      const sharedHalf = Math.max(geo.cardH, geo.panelH) / 2;
      geo.centerY = Math.round(Math.max(10 + sharedHalf, Math.min(geo.targetTop + geo.cardH / 2, innerHeight - 10 - sharedHalf)));
      panel.style.transition = `height 240ms ${EASE}, box-shadow .25s ease`;
      panel.style.height = `${geo.panelH}px`;
      if (wrap.classList.contains("is-settled")) wrap.style.top = `${Math.round(geo.centerY - geo.panelH / 2)}px`;
      else wrap.style.top = `${geo.centerY}px`;
    });
  };

  const ticketById = async (id) => {
    try { const r = await window.tickets?.list?.(); return ((r && r.tickets) || []).find((t) => t.id === id) || null; }
    catch { return null; }
  };

  const section = (key, label, bodyHtml) =>
    `<div class="td-acc${openSections.has(key) ? " is-open" : ""}" data-sec="${key}">
      <button class="td-acc-head" data-sec-toggle="${key}"><span class="td-acc-caret">&rsaquo;</span><span>${label}</span></button>
      <div class="td-acc-body"><div class="td-acc-inner"><div class="td-acc-pad">${bodyHtml}</div></div></div>
    </div>`;

  // Open/close one accordion section (keeps openSections in sync so a re-render preserves it).
  const setAcc = (key, open) => {
    const acc = panel && panel.querySelector(`.td-acc[data-sec="${key}"]`);
    if (!acc) return null;
    acc.classList.toggle("is-open", open);
    if (open) openSections.add(key); else openSections.delete(key);
    return acc;
  };
  // Guided flow: close the current section, open the next, focus its field, scroll it in.
  const advanceSection = (fromKey, toKey, focusSel) => {
    setAcc(fromKey, false);
    const acc = setAcc(toKey, true);
    if (!acc) return;
    if (focusSel) { const f = panel.querySelector(focusSel); if (f) f.focus(); }
    requestAnimationFrame(() => { try { acc.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch {} });
    setTimeout(fitPanelToContent, 260);
  };

  const render = (t) => {
    if (!panel) return;
    if (!t) { panel.innerHTML = `<div class="td-empty">Ticket not found.</div>`; wire(null); window.crmInterfaceParity?.scan?.(panel); return; }
    const created = t.createdAt ? new Date(t.createdAt) : null;
    const endMs = t.recoveredAt ? Date.parse(t.recoveredAt) : Date.now();
    const downMs = created ? endMs - created.getTime() : NaN;
    const state = t.state || "open";
    const priority = window.ticketStacks?.fieldValue?.(t.id, "priority") || t.priority || "medium";
    const actions = [];
    if (state !== "claimed" && state !== "resolved") actions.push(`<button class="td-act" data-act="claim">Claim</button>`);
    if (state !== "resolved") actions.push(`<button class="td-act" data-act="resolve">Resolve</button>`);
    if (state === "resolved") actions.push(`<button class="td-act" data-act="reopen">Reopen</button>`);
    if (window.ticketStacks?.isDeleted?.(t.id)) actions.push(`<button class="td-act td-danger" data-act="restore">Restore</button>`);
    else actions.push(`<button class="td-act td-danger" data-act="delete">Delete</button>`);
    const activity = (t.history || []).slice().reverse().map((item) =>
      `<div class="td-ev"><b>${esc(item.by)}</b> ${esc(item.action)} <span class="td-at">${shortTime(item.at)}</span>${item.action === "comment" && item.detail ? `<div class="td-ev-note">${esc(item.detail)}</div>` : ""}</div>`
    ).join("");
    const meta = window.ticketStacks?.metaOf?.(t.id) || {};
    const titleValue = meta.title != null ? meta.title : (t.companyLabel || "");
    const subtitleValue = meta.subtitle != null ? meta.subtitle : (t.host || "");

    panel.innerHTML = `
      <div class="td-head">
        <div class="td-title">
          <input class="td-name td-edit" data-meta="title" value="${esc(titleValue)}" placeholder="Title" aria-label="Title" />
          <span class="td-sep">|</span>
          <input class="td-ip td-edit" data-meta="subtitle" value="${esc(subtitleValue)}" placeholder="Subtitle" aria-label="Subtitle" />
        </div>
        <button class="td-x" data-act="close" aria-label="Close">&times;</button>
      </div>
      <div class="td-meta">Down ${esc(human(downMs))}${t.recoveredAt ? " &middot; recovered" : ""}</div>
      ${created ? `<div class="td-time">${esc(created.toLocaleString())}</div>` : ""}

      ${section("priority", "Priority", `<span class="td-prio">${PRIORITIES.map((value) => `<button class="td-prio-opt${value === priority ? " is-active" : ""}" data-prio="${value}">${value}</button>`).join("")}</span>`)}
      ${section("assignee", "Assignee", `<input class="td-in" data-field="assignee" value="${esc(t.assignee || "")}" placeholder="unassigned" />`)}
      ${section("description", "Description", `<textarea class="td-in td-ta" rows="1" data-field="description" placeholder="Add details…">${esc(t.description || "")}</textarea>`)}
      ${section("note", "Note", `<input class="td-in td-note" id="td-note" placeholder="Add a note…" />`)}
      ${section("activity", "Activity", `<div class="td-log">${activity || `<div class="td-log-empty">No activity.</div>`}</div>`)}

      <div class="td-acts">${actions.join("")}</div>`;
    wire(t);
    window.crmInterfaceParity?.scan?.(panel);
    fitPanelToContent();
  };

  const refresh = async () => {
    if (!currentId || !overlay || overlay.hidden || closing) return;
    const a = document.activeElement;
    if (a && panel && panel.contains(a) && a.matches("input, textarea")) return;
    render(await ticketById(currentId));
  };

  const wire = (t) => {
    if (!panel) return;
    panel.querySelectorAll("[data-act='close']").forEach((b) => (b.onclick = requestClose));
    panel.querySelectorAll("[data-sec-toggle]").forEach((element) => {
      element.onclick = () => {
        const key = element.dataset.secToggle;
        const accordion = panel.querySelector(`.td-acc[data-sec="${key}"]`);
        if (accordion.classList.toggle("is-open")) openSections.add(key); else openSections.delete(key);
        setTimeout(fitPanelToContent, 260);
      };
    });
    if (!t) return;
    panel.querySelectorAll(".td-edit").forEach((element) => {
      element.oninput = () => { window.ticketStacks?.setMeta?.(t.id, { [element.dataset.meta]: element.value }); syncFlyer(); };
      element.onkeydown = (event) => { if (event.key === "Enter") element.blur(); event.stopPropagation(); };
    });
    panel.querySelectorAll(".td-act").forEach((element) => {
      element.onclick = async () => {
        const action = element.dataset.act;
        if (action === "delete") { window.ticketStacks?.delete?.(t.id); close(); return; }
        if (action === "restore") { window.ticketStacks?.restore?.(t.id); refresh(); return; }
        if (action === "claim") await window.tickets?.claim?.(t.id);
        else if (action === "resolve") await window.tickets?.resolve?.(t.id);
        else if (action === "reopen") await window.tickets?.reopen?.(t.id);
        refresh();
      };
    });
    // The original guided path advances Priority → Assignee → Description → Note.
    panel.querySelectorAll(".td-prio-opt").forEach((el) => {
      el.onclick = () => {
        const val = el.dataset.prio;
        panel.querySelectorAll(".td-prio-opt").forEach((o) => o.classList.toggle("is-active", o === el));
        if (sourceEl) sourceEl.dataset.severity = val;
        t.priority = val;
        window.ticketStacks?.setPriority?.(t.id, val);
        syncFlyer();
        advanceSection("priority", "assignee", '[data-field="assignee"]');
      };
    });
    const nextSection = { assignee: "description", description: "note" };
    const nextFocus = { description: '[data-field="description"]', note: "#td-note" };
    panel.querySelectorAll("[data-field]").forEach((el) => {
      el.onblur = async () => {
        const field = el.dataset.field, value = el.value;
        if ((t[field] || "") === value) return;
        t[field] = value;
        const result = await window.tickets?.update?.(t.id, { [field]: value });
        if (result && result.ok === false) el.value = t[field] || "";
      };
      el.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key !== "Enter" || e.shiftKey) return;
        e.preventDefault();
        const next = nextSection[el.dataset.field];
        if (next) advanceSection(el.dataset.field, next, nextFocus[next]);
        else el.blur();
      };
    });
    const note = panel.querySelector("#td-note");
    if (note) note.onkeydown = async (event) => {
      event.stopPropagation();
      if (event.key !== "Enter") return;
      event.preventDefault();
      const value = (note.value || "").trim();
      note.value = ""; note.blur();
      ["priority", "assignee", "description", "note", "activity"].forEach((key) => setAcc(key, false));
      if (value) await window.tickets?.comment?.(t.id, value);
    };
  };

  // Drive the depth-of-field blur (with a matching transition) — ramp in on open, out on close. The
  // scrim blurs the whole world BEHIND the overlay; the front-card clones live ON the overlay (above
  // the scrim), so they're blurred individually to the same depth — otherwise they'd stay sharp.
  const setBlur = (px, ms, ease) => {
    const tr = `${ms}ms ${ease}`;
    if (scrim) {
      scrim.style.transition = `backdrop-filter ${tr}, -webkit-backdrop-filter ${tr}`;
      scrim.style.backdropFilter = scrim.style.webkitBackdropFilter = `blur(${px}px)`;
    }
    if (overlay) overlay.querySelectorAll(".td-frontclone").forEach((c) => {
      c.style.transition = `filter ${tr}`;
      c.style.filter = `blur(${px}px)`;
    });
  };

  const open = (ticket, srcEl) => {
    if (overlay && !overlay.hidden) return;
    ensureStyles(); ensureOverlay();
    closing = false;
    openSections.clear(); openSections.add("priority");
    currentId = ticket && ticket.id ? ticket.id : null;
    sourceEl = srcEl || null;
    overlay.hidden = false;
    buildStage(ticket);
    if (sourceEl) sourceEl.style.visibility = "hidden";   // looks like the card lifted out
    if (flyCard) void flyCard.offsetWidth;                 // commit the START transform so the transition runs
    // Depth-of-field ramps in lock-step with the open: blur grows from 0 and PEAKS exactly when the
    // panel locks in (settle), then holds. ease-out so it builds smoothly rather than snapping on.
    const dofMs = cardStays ? SLIDE_MS : SETTLE_MS;
    requestAnimationFrame(() => {
      if (flyCard) flyCard.style.transform = "translate(0, 0)";  // card flies smoothly to centre
      if (panel) { panel.style.width = `${geo.panelW}px`; panel.style.height = `${geo.panelH}px`; }
      if (wrap) wrap.classList.add("is-open");                   // panel slides out from behind (delayed in CSS)
      setBlur(DOF_BLUR, dofMs, "ease-out");
    });
    // Once the panel is fully out, SETTLE it: add .is-settled (drops the clip so the shadow
    // is no longer cut off, and FADES the real drop shadow in — it carried none while behind
    // the card), drop the transform + will-change (crisp text, not a blurry rasterised
    // layer), and re-centre with an INTEGER top so nothing is sub-pixel blurred.
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (!wrap || !panel || !geo || closing) return;
      wrap.classList.add("is-settled");
      panel.style.transition = "box-shadow .25s ease";   // let the shadow fade in; transform is already at rest
      panel.style.transform = "none";
      panel.style.willChange = "auto";
      wrap.style.transform = "none";
      wrap.style.top = `${Math.round(geo.centerY - panel.offsetHeight / 2)}px`;
    }, cardStays ? SLIDE_MS + 40 : SETTLE_MS);   // no fly → the panel is out a beat sooner
    if (!subscribed) { subscribed = true; window.tickets?.onChanged?.(() => refresh()); }
  };

  const requestClose = () => close();

  const close = () => {
    if (!overlay || overlay.hidden || closing) return;
    closing = true;
    clearTimeout(settleTimer);
    cancelAnimationFrame(panelFitRaf); panelFitRaf = 0;
    setBlur(0, DOF_OUT_MS, "ease-in");   // smoothly pull the world back into focus as the panel leaves
    // Un-settle: re-clip + restore the centring transform, then tuck the panel back behind
    // the card. Removing .is-settled instantly drops the drop shadow (back to alpha 0) so
    // there's no shadow being dragged/clipped while it slides home, and re-enables the clip.
    if (wrap && panel && geo) {
      wrap.classList.remove("is-settled");
      wrap.style.top = `${geo.centerY}px`;
      wrap.style.transform = "translateY(-50%)";
      panel.style.willChange = "transform, width, height";
      panel.style.transition = "none";
      panel.style.transform = "translateX(0)";
      void panel.offsetWidth;                 // commit current position
      panel.style.transition = `transform ${CLOSE_SLIDE_MS}ms ${EASE}, width ${CLOSE_SLIDE_MS}ms ${EASE}, height ${CLOSE_SLIDE_MS}ms ${EASE}`;
      panel.style.transform = slideBack();    // retract fully behind the card (fast, mirrored per side)
      panel.style.width = `${geo.panelSourceW}px`;
      panel.style.height = `${geo.panelSourceH}px`;
    }
    if (wrap) wrap.classList.remove("is-open");
    const fc = flyCard;
    if (fc) { fc.classList.add("returning"); fc.style.transform = backTransform; }
    // Tear everything down the INSTANT the card lands. transitionend fires exactly on arrival;
    // the timeout is just a safety net if it doesn't.
    let done = false;
    const finish = () => {
      if (done || !overlay) return; done = true;
      overlay.hidden = true; overlay.innerHTML = "";
      if (sourceEl) { sourceEl.style.visibility = ""; sourceEl = null; }
      flyCard = wrap = panel = scrim = null; currentId = null; closing = false; geo = null;
      try { window.ticketStacks?.onDetailClosed?.(); } catch {}   // flush any render deferred while open
    };
    if (fc) fc.addEventListener("transitionend", (ev) => { if (ev.propertyName === "transform" || ev.propertyName === "opacity") finish(); });
    setTimeout(finish, cardStays ? CLOSE_SLIDE_MS + 60 : CLOSE_SLIDE_MS + CLOSE_FLY_MS + 90);   // no card fly to wait on
  };

  window.ticketDetail = { open, close, isOpen: () => !!(overlay && !overlay.hidden) };
})();
