// ticket-detail.js — the ticket "open" view, with a choreographed open:
//   left-click a ticket card → a clone of the card flies smoothly to screen centre
//   → the config panel expands outward from the card's RIGHT edge.
//   close → the panel collapses back in, then the card flies back to its place.
//
// Each field is a collapsible dropdown section (control stacked under the header).
//
// STYLING (DESIGN_SYSTEM.md §6): a MENU — the search/account/background sub-menu
// recipe (frosted glass, flat colour-only items, no borders/blue/focus rings,
// search-input fields). Portals to <body> so backdrop-filter isn't flattened.
(() => {
  const PRIORITIES = ["low", "medium", "high", "critical"];
  const GAP = 16;            // gap between the card and the panel
  const PANEL_W = 300;       // panel width (matches .ticket-detail width)
  // Tuck distance: the panel must hide FAR enough left that even its drop shadow
  // (blur 42px ⇒ ~60px reach) clears the clip-path's left edge — otherwise the
  // shadow peeks past the clip and sits frozen mid-screen while the card flies.
  const TUCK = PANEL_W + GAP + 96;          // 412px — panel + gap + shadow reach
  const SEV_RGB = { low: "34,211,238", medium: "250,204,21", high: "249,115,22", critical: "239,68,68", none: "120,130,140" };
  const EASE = "cubic-bezier(.4, 0, .2, 1)"; // balanced glide (no front-loaded snap)
  const FLY_MS = 420, SLIDE_MS = 360, SLIDE_DELAY = 270, SETTLE_MS = 700;
  const CLOSE_SLIDE_MS = 190, CLOSE_FLY_MS = 280;   // close is snappier than open; panel fully retracts THEN card returns
  let overlay = null, panel = null, flyCard = null, wrap = null;
  let currentId = null, sourceEl = null, backTransform = "", subscribed = false, closing = false;
  let geo = null, settleTimer = null;
  const SLIDE_BACK = `translateX(-${TUCK}px)`;
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
      .ticket-detail-overlay { position: fixed; inset: 0; z-index: 5000; background: transparent; -webkit-app-region: no-drag; }
      .ticket-detail-overlay[hidden] { display: none; }

      /* The flyer that glides from the grid spot to centre (and back). It is a PLAIN,
         OPAQUE card built from scratch — NOT a clone of the live widget — so:
           • no widget/db-panel/surface class can ever wash it brighter than hover, and
           • no backdrop-filter ⇒ no saturate() compositing bloom mid-flight.
         Opaque also means it genuinely OCCLUDES the panel sliding out from behind it. */
      .td-card { z-index: 2; margin: 0 !important; cursor: default !important;
        pointer-events: none !important;   /* inert: cursor passes through to the overlay */
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
        transition: transform ${SLIDE_MS}ms ${EASE}; will-change: transform; }
      .td-wrap.is-open .ticket-detail { transform: translateX(0); transition-delay: ${SLIDE_DELAY}ms; }  /* slide out AFTER the card centres */

      /* THE MENU shell — the .dashboard-search-popover / .auth-profile-menu recipe.
         Drop shadow alpha starts at 0 (invisible) so it can be transitioned in at settle —
         two matching shadow layers keep the box-shadow transition smooth. */
      .ticket-detail { width: ${PANEL_W}px; box-sizing: border-box; overflow: auto;
        padding: 11px 10px; border-radius: 14px; color: #fff;
        display: flex; flex-direction: column; gap: 9px;
        background: linear-gradient(180deg, rgba(22,26,36,0.62), rgba(12,16,24,0.55));
        -webkit-backdrop-filter: blur(26px) saturate(140%); backdrop-filter: blur(26px) saturate(140%);
        border: 1px solid rgba(255,255,255,0.22);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.24), 0 18px 42px rgba(0,0,0,0); }
      .td-wrap.is-settled .ticket-detail { box-shadow: inset 0 1px 0 rgba(255,255,255,0.24), 0 18px 42px rgba(0,0,0,0.4); }
      .ticket-detail :focus, .ticket-detail :focus-visible { outline: none !important; box-shadow: none !important; }
      /* Sleek overlay scrollbar — same recipe as the search sub-menu. */
      .ticket-detail, .td-log { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.26) transparent; }
      .ticket-detail::-webkit-scrollbar, .td-log::-webkit-scrollbar { width: 10px; }
      .ticket-detail::-webkit-scrollbar-track, .td-log::-webkit-scrollbar-track { background: transparent; }
      .ticket-detail::-webkit-scrollbar-thumb, .td-log::-webkit-scrollbar-thumb { background: rgba(255,255,255,.22); border-radius: 999px; border: 3px solid transparent; background-clip: padding-box; }
      .ticket-detail::-webkit-scrollbar-thumb:hover, .td-log::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.42); background-clip: padding-box; }

      /* Header: "name | ip" on top, then "Down <time> | <opened timestamp>". */
      .td-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 0 4px; }
      .td-title { display: flex; align-items: baseline; gap: 6px; min-width: 0; font-size: 0.95rem; font-weight: 700; line-height: 1.2; }
      .td-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .td-ip { font-size: 0.8rem; font-weight: 500; color: rgba(255,255,255,0.55); font-variant-numeric: tabular-nums; white-space: nowrap; }
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
      .td-meta { padding: 0 4px; font-size: 0.78rem; color: rgba(255,255,255,0.6); }
      .td-time { padding: 0 4px; margin-top: -4px; font-size: 0.74rem; color: rgba(255,255,255,0.4); font-variant-numeric: tabular-nums; }

      /* Accordion section: dropdown header + a body that animates open below it. */
      .td-acc { display: flex; flex-direction: column; }
      .td-acc-head { -webkit-appearance: none; appearance: none; display: flex; align-items: center; justify-content: flex-start; gap: 8px;
        width: 100%; border: 0; background: transparent; cursor: pointer; padding: 0 4px; margin: 0; text-align: left;
        font: inherit; font-size: 0.9rem; font-weight: 600; color: rgba(255,255,255,0.6); transition: color .14s ease; }
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

      .td-in { width: 100%; border: 1px solid rgba(255,255,255,0.18); border-radius: 9px;
        background: rgba(255,255,255,0.06); color: #fff; font: inherit; font-size: 0.85rem; padding: 7px 10px; }
      .td-in:focus { border-color: rgba(255,255,255,0.34); }
      .td-ta { resize: vertical; min-height: 0; height: auto; line-height: 1.4; }

      /* Claim + Resolve share one row, pinned to the bottom of the card-height panel. */
      .td-acts { display: flex; flex-direction: row; gap: 20px; margin-top: auto; padding-top: 6px; }
      .td-act { -webkit-appearance: none; appearance: none; display: inline-flex; align-items: center; justify-content: flex-start;
        text-align: left; width: auto; border: 0; background: transparent; cursor: pointer; border-radius: 8px;
        padding: 0 4px; margin: 0; font: inherit; font-size: 0.9rem; font-weight: 600; color: rgba(255,255,255,0.62); transition: color .14s ease; }
      .td-act:hover { color: #fff; }
      .td-act.td-danger { color: rgba(255,135,135,0.85); margin-left: auto; }   /* Delete/Restore sits at the far end */
      .td-act.td-danger:hover { color: #ff8a8a; }

      .td-log { display: flex; flex-direction: column; gap: 7px; max-height: 160px; overflow: auto;
        background: rgba(255,255,255,0.05); border-radius: 9px; padding: 8px 9px; }
      .td-ev { font-size: 0.8rem; color: rgba(255,255,255,0.78); }
      .td-ev b { font-weight: 700; }
      .td-ev .td-at { color: rgba(255,255,255,0.4); }
      .td-ev-note { color: rgba(255,255,255,0.6); margin-top: 1px; }
      .td-log-empty, .td-empty { color: rgba(255,255,255,0.45); font-size: 0.82rem; }
    `;
    document.head.appendChild(style);
  };

  const ensureOverlay = () => {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "ticket-detail-overlay";
    overlay.hidden = true;
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && overlay && !overlay.hidden) close(); });
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

  // Build the centred flyer card + the (collapsed) config panel, positioned for the
  // fly-in. Returns once the DOM is laid out at the START of the animation.
  const buildStage = (ticket) => {
    overlay.innerHTML = "";
    const vw = window.innerWidth, vh = window.innerHeight;
    const sr = sourceEl ? sourceEl.getBoundingClientRect() : { left: vw / 2 - 93, top: vh / 2 - 140, width: 186, height: 279 };
    const cardW = sr.width, cardH = sr.height;
    // Card target: centred. Shift left only if the panel would overflow the right edge.
    const targetTop = Math.round((vh - cardH) / 2);
    const fitLeft = vw - 10 - PANEL_W - GAP - cardW;
    const targetLeft = Math.max(10, Math.min(Math.round((vw - cardW) / 2), fitLeft));
    geo = { targetLeft, targetTop, cardW, cardH };

    // Build the flyer FRESH (not a clone). A clone drags along every widget class +
    // backdrop-filter, which is what washed it brighter-than-hover mid-flight. A plain
    // opaque div with only the visual styles can't be highlighted by anything.
    const prio = (ticket && ["low", "medium", "high", "critical"].includes(ticket.priority)) ? ticket.priority : (ticket ? "medium" : "none");
    const body = sourceEl ? sourceEl.querySelector(".ticket-body, [data-ticket-mount]") : null;
    flyCard = document.createElement("div");
    flyCard.className = "td-card td-flyer";
    flyCard.innerHTML = `<div class="ticket-body">${body ? body.innerHTML : ""}</div>`;
    backTransform = `translate(${Math.round(sr.left - targetLeft)}px, ${Math.round(sr.top - targetTop)}px)`;
    flyCard.style.cssText = `position:fixed; left:${targetLeft}px; top:${targetTop}px; width:${cardW}px; height:${cardH}px; transform:${backTransform};`;
    paintFlyer(SEV_RGB[prio]);
    overlay.appendChild(flyCard);

    wrap = document.createElement("div");
    wrap.className = "td-wrap";
    wrap.style.left = `${targetLeft + cardW}px`;   // clip window starts at the card's RIGHT edge
    wrap.style.top = `${targetTop + cardH / 2}px`;
    wrap.style.transform = "translateY(-50%)";
    panel = document.createElement("div");
    panel.className = "ticket-detail";
    panel.style.height = `${Math.round(cardH)}px`;   // same vertical height as the ticket card
    wrap.appendChild(panel);
    overlay.appendChild(wrap);

    render(ticket);
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
  };

  const render = (t) => {
    if (!panel) return;
    if (!t) { panel.innerHTML = `<div class="td-empty">Ticket not found.</div>`; wire(null); return; }
    const created = t.createdAt ? new Date(t.createdAt) : null;
    const endMs = t.recoveredAt ? Date.parse(t.recoveredAt) : Date.now();
    const downMs = created ? endMs - created.getTime() : NaN;
    const state = t.state || "open";
    const prio = t.priority || "medium";
    const acts = [];
    if (state !== "claimed" && state !== "resolved") acts.push(`<button class="td-act" data-act="claim">Claim</button>`);
    if (state !== "resolved") acts.push(`<button class="td-act" data-act="resolve">Resolve</button>`);
    if (state === "resolved") acts.push(`<button class="td-act" data-act="reopen">Reopen</button>`);
    // Delete sends the ticket to the trash (right stack, trash view); Restore brings it back.
    if (window.ticketStacks?.isDeleted?.(t.id)) acts.push(`<button class="td-act td-danger" data-act="restore">Restore</button>`);
    else acts.push(`<button class="td-act td-danger" data-act="delete">Delete</button>`);
    const log = (t.history || []).slice().reverse().map((h) =>
      `<div class="td-ev"><b>${esc(h.by)}</b> ${esc(h.action)} <span class="td-at">${shortTime(h.at)}</span>${h.action === "comment" && h.detail ? `<div class="td-ev-note">${esc(h.detail)}</div>` : ""}</div>`
    ).join("");

    const meta = (window.ticketStacks?.metaOf?.(t.id)) || {};
    const titleVal = meta.title != null ? meta.title : (t.companyLabel || "");
    const subVal = meta.subtitle != null ? meta.subtitle : (t.host || "");
    panel.innerHTML = `
      <div class="td-head">
        <div class="td-title">
          <input class="td-name td-edit" data-meta="title" value="${esc(titleVal)}" placeholder="Title" aria-label="Title" />
          <span class="td-sep">|</span>
          <input class="td-ip td-edit" data-meta="subtitle" value="${esc(subVal)}" placeholder="Subtitle" aria-label="Subtitle" />
        </div>
        <button class="td-x" data-act="close" aria-label="Close">&times;</button>
      </div>
      <div class="td-meta">Down ${esc(human(downMs))}${t.recoveredAt ? " &middot; recovered" : ""}</div>
      ${created ? `<div class="td-time">${esc(created.toLocaleString())}</div>` : ""}

      ${section("priority", "Priority", `<span class="td-prio">${PRIORITIES.map((p) => `<button class="td-prio-opt${p === prio ? " is-active" : ""}" data-prio="${p}">${p}</button>`).join("")}</span>`)}
      ${section("assignee", "Assignee", `<input class="td-in" data-field="assignee" value="${esc(t.assignee || "")}" placeholder="unassigned" />`)}
      ${section("description", "Description", `<textarea class="td-in td-ta" rows="1" data-field="description" placeholder="Add details…">${esc(t.description || "")}</textarea>`)}
      ${section("note", "Note", `<input class="td-in td-note" id="td-note" placeholder="Add a note…" />`)}
      ${section("activity", "Activity", `<div class="td-log">${log || `<div class="td-log-empty">No activity.</div>`}</div>`)}

      <div class="td-acts">${acts.join("")}</div>`;
    wire(t);
  };

  const refresh = async () => {
    if (!currentId || !overlay || overlay.hidden || closing) return;
    const a = document.activeElement;
    if (a && panel && panel.contains(a) && a.matches("input, textarea")) return;
    render(await ticketById(currentId));
  };

  const wire = (t) => {
    if (!panel) return;
    panel.querySelectorAll("[data-act='close']").forEach((b) => (b.onclick = close));
    panel.querySelectorAll("[data-sec-toggle]").forEach((el) => {
      el.onclick = () => {
        const key = el.dataset.secToggle;
        const acc = panel.querySelector(`.td-acc[data-sec="${key}"]`);
        if (acc.classList.toggle("is-open")) openSections.add(key); else openSections.delete(key);
      };
    });
    if (!t) return;
    // Title / subtitle: live-saved as client-side overrides (the card updates in place as you type).
    panel.querySelectorAll(".td-edit").forEach((el) => {
      el.oninput = () => window.ticketStacks?.setMeta?.(t.id, { [el.dataset.meta]: el.value });
      el.onkeydown = (e) => { if (e.key === "Enter") el.blur(); e.stopPropagation(); };
    });
    panel.querySelectorAll(".td-act").forEach((el) => {
      el.onclick = async () => {
        const a = el.dataset.act;
        if (a === "delete") { window.ticketStacks?.delete?.(t.id); close(); return; }   // → trash
        if (a === "restore") { window.ticketStacks?.restore?.(t.id); refresh(); return; }
        if (a === "claim") await window.tickets.claim(t.id);
        else if (a === "resolve") await window.tickets.resolve(t.id);
        else if (a === "reopen") await window.tickets.reopen(t.id);
        refresh();
      };
    });
    // Picking a priority advances the flow to Assignee (and persists the choice).
    panel.querySelectorAll(".td-prio-opt").forEach((el) => {
      el.onclick = async () => {
        const val = el.dataset.prio;
        panel.querySelectorAll(".td-prio-opt").forEach((o) => o.classList.toggle("is-active", o === el));
        if (sourceEl) sourceEl.dataset.severity = val;   // recolour the (hidden) source so its computed bg matches
        paintFlyer(SEV_RGB[val] || SEV_RGB.medium);       // → repaint the flying card LIVE, not just on close
        advanceSection("priority", "assignee", '[data-field="assignee"]');   // focus next NOW → refresh stays skipped
        if (val !== (t.priority || "medium")) { t.priority = val; await window.tickets.update(t.id, { priority: val }); }
      };
    });
    // Assignee → Description → Note. Enter commits (via the blur from focusing the next field)
    // and advances; Shift+Enter still inserts a newline in the description.
    const nextField = { assignee: "description", description: "note" };
    const nextFocus = { description: '[data-field="description"]', note: "#td-note" };
    panel.querySelectorAll("[data-field]").forEach((el) => {
      el.onblur = async () => {
        const field = el.dataset.field, val = el.value;
        if ((t[field] || "") === val) return;
        t[field] = val;
        const r = await window.tickets.update(t.id, { [field]: val });
        if (r && r.ok === false) el.value = t[field] || "";
      };
      el.onkeydown = (e) => {
        if (e.key !== "Enter" || e.shiftKey) return;
        e.preventDefault();
        const next = nextField[el.dataset.field];
        if (next) advanceSection(el.dataset.field, next, nextFocus[next]);   // blurs this field → onblur commits
        else el.blur();
      };
    });
    // Note is the last step: post the comment, then collapse every section (nothing open).
    const note = panel.querySelector("#td-note");
    if (note) note.onkeydown = async (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const v = (note.value || "").trim();
      note.value = "";
      note.blur();
      ["priority", "assignee", "description", "note", "activity"].forEach((k) => setAcc(k, false));
      if (v) await window.tickets.comment(t.id, v);
    };
  };

  const open = (ticket, srcEl) => {
    if (overlay && !overlay.hidden) return;
    ensureStyles(); ensureOverlay();
    closing = false;
    openSections.clear(); openSections.add("priority");   // guided flow always starts on Priority
    currentId = ticket && ticket.id ? ticket.id : null;
    sourceEl = srcEl || null;
    overlay.hidden = false;
    buildStage(ticket);
    if (sourceEl) sourceEl.style.visibility = "hidden";   // looks like the card lifted out
    if (flyCard) void flyCard.offsetWidth;                 // commit the START transform so the transition runs
    requestAnimationFrame(() => {
      if (flyCard) flyCard.style.transform = "translate(0, 0)";  // card flies smoothly to centre
      if (wrap) wrap.classList.add("is-open");                   // panel slides out from behind (delayed in CSS)
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
      wrap.style.top = `${Math.round(geo.targetTop + geo.cardH / 2 - panel.offsetHeight / 2)}px`;
    }, SETTLE_MS);
    if (!subscribed) { subscribed = true; window.tickets?.onChanged?.(() => refresh()); }
  };

  const close = () => {
    if (!overlay || overlay.hidden || closing) return;
    closing = true;
    clearTimeout(settleTimer);
    // Un-settle: re-clip + restore the centring transform, then tuck the panel back behind
    // the card. Removing .is-settled instantly drops the drop shadow (back to alpha 0) so
    // there's no shadow being dragged/clipped while it slides home, and re-enables the clip.
    if (wrap && panel && geo) {
      wrap.classList.remove("is-settled");
      wrap.style.top = `${geo.targetTop + geo.cardH / 2}px`;
      wrap.style.transform = "translateY(-50%)";
      panel.style.willChange = "transform";
      panel.style.transition = "none";
      panel.style.transform = "translateX(0)";
      void panel.offsetWidth;                 // commit current position
      panel.style.transition = `transform ${CLOSE_SLIDE_MS}ms ${EASE}`;
      panel.style.transform = SLIDE_BACK;     // retract fully behind the card (fast)
    }
    if (wrap) wrap.classList.remove("is-open");
    const fc = flyCard;
    if (fc) { fc.classList.add("returning"); fc.style.transform = backTransform; }  // card returns after the panel
    // Tear everything down the INSTANT the card lands on its spot — no lingering animation
    // layer / inert flyer sitting over the real card. transitionend fires exactly on arrival;
    // the timeout is just a safety net if it doesn't.
    let done = false;
    const finish = () => {
      if (done || !overlay) return; done = true;
      overlay.hidden = true; overlay.innerHTML = "";
      if (sourceEl) { sourceEl.style.visibility = ""; sourceEl = null; }
      flyCard = wrap = panel = null; currentId = null; closing = false; geo = null;
    };
    if (fc) fc.addEventListener("transitionend", (ev) => { if (ev.propertyName === "transform") finish(); });
    setTimeout(finish, CLOSE_SLIDE_MS + CLOSE_FLY_MS + 90);
  };

  window.ticketDetail = { open, close };
})();
