// fractal-calendar.js — FRACTAL BUCKETS, click-driven.
//
// ONE bucket style — the ticketing pipeline zone — at every level of the fractal: the year is
// 12 month buckets; a month is a bucket of day buckets; a day is a bucket of (future) cards.
// Interior geometry is proportional (k-scaled trim, fraction bands, %-gaps), so a mini and its
// expanded view are the SAME OBJECT at different sizes, and corners follow the zone's radius
// proportion at every scale.
//
// Interaction: CLICK a month → the whole world dives smoothly into it while the real month view
// grows out of its slot (one camera move, uniform scale — the grid is sized so bucket aspect ==
// expanded aspect, so nothing can stretch). Click a day → same, one level deeper. Press B (or
// Escape) to step back out. No scroll-zoom. Hovering a bucket pre-builds its view, so the morph
// starts warm.
//
// Settled layers carry no forced compositing (no will-change): Chromium paints them into tiles
// at device resolution — sharp at any depth and any display scale — and promotes only while a
// transition runs.
(() => {
  const YEAR = 2026;                          // one year for now
  const EASE = "cubic-bezier(.22, 1, .26, 1)";
  const MORPH_MS = 460;                       // the click-zoom camera move
  const EXP_M = 16;                           // equal spacing to the window edges…
  let expTop = 58;                            // …and the SAME spacing beneath the circular buttons
  const measureTop = () => {
    let b = 42;
    document.querySelectorAll(".window-control-cluster").forEach((el) => { b = Math.max(b, el.getBoundingClientRect().bottom); });
    expTop = Math.round(b + EXP_M);
  };
  // The DEFINED viewport: where an expanded bucket lives, and the region the year grid fits in.
  const expRect = () => ({ x: EXP_M, y: expTop, w: window.innerWidth - 2 * EXP_M, h: window.innerHeight - expTop - EXP_M });
  const RADIUS_F = 16 / 245;                  // the ticketing zone's corner PROPORTION — perceived
                                              // roundness is relative to size, so radius scales with each bucket
  const MONTHS = ["January", "February", "March", "April", "May", "June",
                  "July", "August", "September", "October", "November", "December"];
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const DOW_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  let surface = null;
  let level = 0;                              // 0 = year, 1 = a month, 2 = a day
  let layers = [null, null, null];            // the live element per level (year layer persists)
  let srcSel = [null, null];                  // how to find the slot each expander contracts back into
  let transitioning = false;
  let transitionSeq = 0;

  const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const daysIn = (m) => new Date(YEAR, m + 1, 0).getDate();
  const firstDow = (m) => new Date(YEAR, m, 1).getDay();
  const iso = (m, d) => `${YEAR}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  const ensureStyles = () => {
    if (document.getElementById("fractal-calendar-styles")) return;
    const style = document.createElement("style");
    style.id = "fractal-calendar-styles";
    style.textContent = `
      /* Full-window surface. It passes pointer events AND the window-drag region through (no
         app-region here — a full-window no-drag would geometrically erase the shell's drag
         strip); the interactive children opt out of dragging themselves. */
      .fc-surface { position: fixed; inset: 0; z-index: 800; pointer-events: none; overflow: hidden; }
      .fc-level { position: absolute; inset: 0; transform-origin: 0 0; }
      /* The grid is sized in JS so every bucket has EXACTLY the expanded view's aspect ratio —
         the click-zoom morph is a UNIFORM scale: nothing ever stretches. */
      .fc-grid { position: absolute; display: grid; pointer-events: auto; -webkit-app-region: no-drag;
        grid-template-columns: repeat(4, 1fr); grid-template-rows: repeat(3, 1fr); gap: 14px; }
      /* ONE frost pass for the whole year layer, clipped to the 12 bucket shapes. */
      .fc-frost { position: absolute; inset: 0; pointer-events: none;
        -webkit-backdrop-filter: blur(28px) saturate(140%); backdrop-filter: blur(28px) saturate(140%); }

      /* ── THE bucket — the ticketing zone at k=1, the SAME OBJECT grown at every level: trim is
         calc(base × --kx/--ky), bands are height fractions, gaps/insets are axis-safe fractions —
         a mini and its expanded view have interiors in IDENTICAL relative positions. ── */
      .fc-bucket { position: relative; box-sizing: border-box; display: flex; flex-direction: column; min-height: 0;
        overflow: hidden; color: #fff; border: 0;
        container-type: size;
        border-radius: calc(var(--mon-r, 16px) * var(--kx, 1)) / calc(var(--mon-r, 16px) * var(--ky, 1));
        padding: calc(8px * var(--ky, 1)) calc(10px * var(--kx, 1)) calc(10px * var(--ky, 1));
        background: linear-gradient(180deg, rgba(22,26,36,0.5), rgba(12,16,24,0.42));
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.14),
          inset 0 1px 0 rgba(255,255,255,0.18), 0 18px 42px rgba(0,0,0,0.28);
        transition: box-shadow .18s ease, background .18s ease; }
      /* The zone header: a fixed FRACTION band. */
      .fc-hd { flex: 0 0 9%; display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 0 1%; font-size: clamp(0.98rem, 8cqh, 1.15rem); font-weight: 700; line-height: 1.05;
        color: rgba(255,255,255,0.85); white-space: nowrap; min-height: 0; }
      .fc-expander .fc-hd { font-size: clamp(1.15rem, 3.2cqh, 1.7rem); }
      .fc-expander[data-kind="day"] .fc-hd { font-size: clamp(1.05rem, 2.8cqh, 1.45rem); }
      .fc-dowrow { flex: 0 0 5%; display: grid; grid-template-columns: repeat(7, 1fr); column-gap: 1.6%;
        align-items: center; min-height: 0; }
      .fc-dowrow span { text-align: center; font-size: 0.72rem; font-weight: 700; color: rgba(255,255,255,0.4);
        white-space: nowrap; overflow: hidden; }
      .fc-days { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: repeat(7, 1fr);
        grid-template-rows: repeat(6, 1fr); column-gap: 1.6%; row-gap: 2%; }
      .fc-day-spacer { min-height: 0; visibility: hidden; pointer-events: none; }
      /* A day bucket: the same family — trim scales by the SAME k, so cells coincide too. */
      .fc-day { position: relative; min-height: 0; overflow: hidden; border: 0;
        border-radius: calc(var(--day-r, 3px) * var(--kx, 1)) / calc(var(--day-r, 3px) * var(--ky, 1));
        background: linear-gradient(180deg, rgba(255,255,255,0.075), rgba(255,255,255,0.035));
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10),
          inset 0 1px 0 rgba(255,255,255,0.08);
        transition: box-shadow .18s ease, background .18s ease; }
      .fc-day-num { position: absolute; top: 6%; left: 7%; font-size: 0.85rem; font-weight: 700;
        color: rgba(255,255,255,0.78); line-height: 1; }
      .fc-day-body { position: absolute; inset: 24% 5% 5%; }
      /* The zone empty-state, verbatim. */
      .fc-empty { width: 100%; margin: auto 0; padding: 14px 8px; text-align: center;
        color: rgba(255,255,255,0.38); font-size: 0.8rem; line-height: 1.4; }

      /* LOD is per LEVEL: the year's day grid is quiet texture (numbers/weekday labels belong to
         the month level, where they're legible). Bands keep their space — geometry twins. */
      .fc-level .fc-day-num { display: none; }
      .fc-level .fc-dowrow span { visibility: hidden; }
      /* At the YEAR the month is the object; inside a month the day buckets are — with the
         pipeline's is-target glow on hover. */
      .fc-surface[data-level="0"] .fc-day { pointer-events: none; }
      .fc-surface[data-level="0"] .fc-month { cursor: pointer; }
      .fc-surface[data-level="0"] .fc-month:hover {
        background: linear-gradient(180deg, rgba(70,110,190,0.34), rgba(40,70,130,0.26));
        box-shadow: inset 0 0 0 1px rgba(125,180,255,0.5), 0 0 30px rgba(90,150,255,0.42); }
      .fc-expander[data-kind="month"] .fc-day { cursor: pointer; pointer-events: auto; }
      .fc-expander[data-kind="month"] .fc-day:hover {
        background: linear-gradient(180deg, rgba(70,110,190,0.34), rgba(40,70,130,0.26));
        box-shadow: inset 0 0 0 1px rgba(125,180,255,0.5), 0 0 30px rgba(90,150,255,0.42); }

      /* The expander: the SAME bucket at its final size from frame one, travelling between its
         slot and the defined viewport on a composited transform. One backdrop pass. */
      .fc-expander { position: absolute; z-index: 5; pointer-events: auto; -webkit-app-region: no-drag;
        transform-origin: 0 0;
        -webkit-backdrop-filter: blur(28px) saturate(140%); backdrop-filter: blur(28px) saturate(140%); }
      .fc-contracting-expander {
        background: transparent;
        box-shadow: none;
        -webkit-backdrop-filter: none;
        backdrop-filter: none;
      }
      /* A WARM (prefetched, invisible) expander must be completely inert — its day cells'
         pointer-events:auto would otherwise eat the hover/clicks meant for the grid beneath. */
      .fc-warm, .fc-warm * { pointer-events: none !important; }
    `;
    document.head.appendChild(style);
  };

  // ── Builders — the same structure at every size ─────────────────────────────────────────
  const dayCellHTML = (m, d) => {
    const date = iso(m, d);
    return `<div class="fc-day" data-date="${date}"><span class="fc-day-num">${d}</span><div class="fc-day-body"></div></div>`;
  };
  const monthDaysHTML = (m) => {
    const leading = firstDow(m);
    const dayCount = daysIn(m);
    const trailing = 42 - leading - dayCount;
    return `${'<div class="fc-day-spacer"></div>'.repeat(leading)}` +
      `${Array.from({ length: dayCount }, (_, i) => dayCellHTML(m, i + 1)).join("")}` +
      `${'<div class="fc-day-spacer"></div>'.repeat(trailing)}`;
  };
  const monthInnerHTML = (m) =>
    `<div class="fc-hd"><span>${MONTHS[m]}</span></div>` +
    `<div class="fc-dowrow">${DOW.map((d) => `<span>${d}</span>`).join("")}</div>` +
    `<div class="fc-days">${monthDaysHTML(m)}</div>`;
  const dayInnerHTML = (date) => {
    const [, mo, da] = date.split("-").map(Number);
    const d = new Date(YEAR, mo - 1, da);
    return `<div class="fc-hd"><span>${DOW_FULL[d.getDay()]}, ${MONTHS[mo - 1]} ${da}</span></div>` +
      `<div class="fc-empty" data-date="${date}">Drag cards here</div>`;
  };

  const buildYear = () => {
    const el = document.createElement("div");
    el.className = "fc-level";
    const frost = document.createElement("div");
    frost.className = "fc-frost";
    el.appendChild(frost);
    const grid = document.createElement("div");
    grid.className = "fc-grid";
    for (let m = 0; m < 12; m++) {
      const month = document.createElement("div");
      month.className = "fc-bucket fc-month";
      month.dataset.month = String(m + 1);
      month.innerHTML = monthInnerHTML(m);
      grid.appendChild(month);
    }
    el.appendChild(grid);
    return el;
  };

  // Size the 4×3 grid so each bucket's aspect EQUALS the expanded view's — uniform morphs.
  const layoutGrid = (grid) => {
    const GAP = 14;
    const E = expRect();
    const A = E.w / E.h;
    let cw = (E.w - 3 * GAP) / 4, ch = cw / A;
    if (3 * ch + 2 * GAP > E.h) { ch = (E.h - 2 * GAP) / 3; cw = ch * A; }
    const gw = 4 * cw + 3 * GAP, gh = 3 * ch + 2 * GAP;
    Object.assign(grid.style, {
      left: `${(E.x + (E.w - gw) / 2).toFixed(2)}px`,
      top: `${(E.y + (E.h - gh) / 2).toFixed(2)}px`,
      width: `${gw.toFixed(2)}px`,
      height: `${gh.toFixed(2)}px`,
    });
  };

  // Corner proportions measured off the minis; the frost clip follows the bucket shapes.
  const radiusFor = (w, h) => clampN(RADIUS_F * Math.min(w, h), 2, 64);
  const layoutFrost = () => {
    const yearEl = layers[0]; if (!yearEl) return;
    const frost = yearEl.querySelector(":scope > .fc-frost");
    const grid = yearEl.querySelector(":scope > .fc-grid");
    if (!frost || !grid) return;
    layoutGrid(grid);
    const m0 = grid.firstElementChild, c0 = grid.querySelector(".fc-day");
    const monR = radiusFor(m0.offsetWidth, m0.offsetHeight);
    surface.style.setProperty("--mon-r", `${monR.toFixed(1)}px`);
    if (c0) surface.style.setProperty("--day-r", `${radiusFor(c0.offsetWidth, c0.offsetHeight).toFixed(1)}px`);
    const gx = grid.offsetLeft, gy = grid.offsetTop;
    const parts = [...grid.children].map((m) => {
      const w = m.offsetWidth, h = m.offsetHeight;
      const x = gx + m.offsetLeft, y = gy + m.offsetTop;
      const r = monR;
      return `M ${x + r} ${y} L ${x + w - r} ${y} A ${r} ${r} 0 0 1 ${x + w} ${y + r} ` +
        `L ${x + w} ${y + h - r} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} L ${x + r} ${y + h} ` +
        `A ${r} ${r} 0 0 1 ${x} ${y + h - r} L ${x} ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`;
    });
    frost.style.clipPath = `path('${parts.join(" ")}')`;
  };

  // Sub-pixel layout rect of an element within its layer.
  const layoutRect = (el, layer) => {
    const lr = layer.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const sx = lr.width / layer.offsetWidth, sy = lr.height / layer.offsetHeight;
    return { x: (er.left - lr.left) / sx, y: (er.top - lr.top) / sy, w: er.width / sx, h: er.height / sy };
  };

  // ── Expander lifecycle ──────────────────────────────────────────────────────────────────
  const buildExpander = (targetEl) => {
    const isMonth = level === 0;
    const exp = document.createElement("div");
    exp.className = "fc-bucket fc-expander";
    exp.dataset.kind = isMonth ? "month" : "day";
    if (isMonth) { exp.dataset.month = targetEl.dataset.month; exp.innerHTML = monthInnerHTML(+targetEl.dataset.month - 1); }
    else { exp.dataset.date = targetEl.dataset.date; exp.innerHTML = dayInnerHTML(targetEl.dataset.date); }
    const E = expRect();
    Object.assign(exp.style, { left: `${E.x}px`, top: `${E.y}px`, width: `${E.w}px`, height: `${E.h}px` });
    // The parity factors: the expander IS its source bucket grown by (final ÷ slot) per axis.
    const b = layoutRect(targetEl, layers[level]);
    exp.style.setProperty("--kx", (E.w / b.w).toFixed(4));
    exp.style.setProperty("--ky", (E.h / b.h).toFixed(4));
    return exp;
  };
  const keyOf = (el) => (el.dataset.month ? "m" + el.dataset.month : "d" + el.dataset.date);
  // Hover = intent: pre-build (and pre-raster) the bucket's view so the click morph starts warm.
  let warm = null;
  const prefetch = (targetEl) => {
    const key = keyOf(targetEl);
    if (warm && warm.key === key) return;
    if (warm) { warm.el.remove(); warm = null; }
    const exp = buildExpander(targetEl);
    exp.classList.add("fc-warm");
    Object.assign(exp.style, { opacity: "0.001", zIndex: "1" });
    surface.appendChild(exp);
    warm = { key, el: exp };
  };
  const dropWarm = () => { if (warm) { warm.el.remove(); warm = null; } };
  const once = (fn) => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      fn();
    };
  };
  const afterTransform = (el, fn) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener("transitionend", onEnd);
      clearTimeout(fallback);
      fn();
    };
    const onEnd = (e) => {
      if (e.target === el && e.propertyName === "transform") finish();
    };
    const fallback = setTimeout(finish, MORPH_MS + 25);
    el.addEventListener("transitionend", onEnd);
  };
  // ── Expand: ONE camera move — the world dives INTO the bucket on the same trajectory the
  //    real view rides out of its slot. Uniform scale (matched aspects): nothing stretches. ──
  const expand = (targetEl) => {
    const seq = ++transitionSeq;
    transitioning = true;
    surface.querySelectorAll(".fc-contracting-expander").forEach((el) => el.remove());
    const E = expRect();
    const r = targetEl.getBoundingClientRect();
    const key = keyOf(targetEl);
    let exp;
    if (warm && warm.key === key) { exp = warm.el; exp.classList.remove("fc-warm"); warm = null; }
    else { dropWarm(); exp = buildExpander(targetEl); surface.appendChild(exp); }
    srcSel[level] = level === 0 ? `.fc-month[data-month="${targetEl.dataset.month}"]` : `.fc-day[data-date="${targetEl.dataset.date}"]`;
    Object.assign(exp.style, { zIndex: "5", pointerEvents: "auto", transition: "none", opacity: "0",
      transform: `translate(${(r.left - E.x).toFixed(2)}px, ${(r.top - E.y).toFixed(2)}px) scale(${(r.width / E.w).toFixed(5)}, ${(r.height / E.h).toFixed(5)})` });
    const below = layers[level];
    below.style.zIndex = "0";
    below.style.pointerEvents = "none";
    const b = layoutRect(targetEl, below);
    const KX = E.w / b.w, KY = E.h / b.h;
    const dive = `translate(${(E.x - below.offsetLeft - b.x * KX).toFixed(2)}px, ${(E.y - below.offsetTop - b.y * KY).toFixed(2)}px) scale(${KX.toFixed(4)}, ${KY.toFixed(4)})`;
    void exp.offsetWidth;
    requestAnimationFrame(() => {                 // one frame for the (warm) raster to commit
      exp.style.transition = `transform ${MORPH_MS}ms ${EASE}, opacity 140ms ease`;
      exp.style.transform = "none";
      exp.style.opacity = "1";
      below.style.transition = `transform ${MORPH_MS}ms ${EASE}, opacity ${MORPH_MS}ms ease`;
      below.style.transform = dive;
      below.style.opacity = "0";
    });
    const commitExpand = once(() => {
      level += 1;
      layers[level] = exp;
      surface.dataset.level = String(level);
      transitioning = false;
    });
    commitExpand();
    afterTransform(exp, () => {
      if (seq !== transitionSeq) return;
      commitExpand();
      exp.style.transition = "none";
      below.style.transition = "none";
      below.style.visibility = "hidden";
      below.style.transform = "none"; below.style.opacity = "1";   // parked at identity for the return
      below.style.pointerEvents = "";
    });
  };

  // ── Contract (B / Escape): the reverse camera move, landing at rest. ────────────────────
  const contract = () => {
    if (level === 0 || transitioning) return;
    const seq = ++transitionSeq;
    transitioning = true;
    const exp = layers[level];
    const below = layers[level - 1];
    const E = expRect();
    const src = below.querySelector(srcSel[level - 1]);
    const b = layoutRect(src, below);
    const KX = E.w / b.w, KY = E.h / b.h;
    const dive = `translate(${(E.x - below.offsetLeft - b.x * KX).toFixed(2)}px, ${(E.y - below.offsetTop - b.y * KY).toFixed(2)}px) scale(${KX.toFixed(4)}, ${KY.toFixed(4)})`;
    const rx = below.offsetLeft + b.x, ry = below.offsetTop + b.y;
    below.style.transition = "none";
    below.style.zIndex = "5";
    below.style.pointerEvents = "auto";
    below.style.transform = dive;
    below.style.opacity = "1";
    below.style.visibility = "";
    exp.style.transition = "none";
    exp.style.zIndex = "4";
    exp.style.pointerEvents = "none";
    exp.style.opacity = "1";
    exp.classList.add("fc-contracting-expander");
    const oldLevel = level;
    const commitContract = once(() => {
      layers[oldLevel] = null;
      level -= 1;
      surface.dataset.level = String(level);
      dropWarm();
      transitioning = false;
    });
    commitContract();
    void below.offsetWidth;
    requestAnimationFrame(() => {
      if (seq !== transitionSeq) return;
      below.style.transition = `transform ${MORPH_MS}ms ${EASE}`;
      below.style.transform = "none";
      exp.style.transition = `transform ${MORPH_MS}ms ${EASE}, opacity ${Math.round(MORPH_MS * 0.35)}ms ease ${Math.round(MORPH_MS * 0.65)}ms`;
      exp.style.transform = `translate(${(rx - E.x).toFixed(2)}px, ${(ry - E.y).toFixed(2)}px) scale(${(b.w / E.w).toFixed(5)}, ${(b.h / E.h).toFixed(5)})`;
      exp.style.opacity = "0";
    });
    afterTransform(exp, () => {
      if (seq !== transitionSeq) {
        exp.remove();
        return;
      }
      commitContract();
      below.style.zIndex = "";
      exp.remove();
    });
  };

  // ── Boot ────────────────────────────────────────────────────────────────────────────────
  const init = () => {
    if (surface) return;
    ensureStyles();
    surface = document.createElement("div");
    surface.className = "fc-surface";
    surface.dataset.level = "0";
    layers[0] = buildYear();
    surface.appendChild(layers[0]);
    document.body.appendChild(surface);
    measureTop();
    // Buckets that glow are buttons: click zooms in; B / Escape steps back out. Hover pre-warms.
    const clickTarget = (e) => {
      if (level >= 2) return null;
      const t = level === 0 ? e.target.closest?.(".fc-month") : e.target.closest?.(".fc-day");
      return t && layers[level]?.contains(t) ? t : null;
    };
    const bucketAt = (x, y) => {
      if (level >= 2) return null;
      const layer = layers[level];
      if (!layer) return null;
      const selector = level === 0 ? ".fc-month" : ".fc-day";
      return [...layer.querySelectorAll(selector)].find((bucket) => {
        const r = bucket.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      }) || null;
    };
    document.addEventListener("click", (e) => {
      if (e.target && e.target.closest?.(".window-control-cluster, .background-tone-menu, .auth-shell, .auth-modal-backdrop")) return;
      const t = clickTarget(e) || bucketAt(e.clientX, e.clientY);
      if (t) { e.preventDefault(); expand(t); }
    }, true);
    document.addEventListener("mousemove", (e) => {
      const t = bucketAt(e.clientX, e.clientY);
      if (t) prefetch(t);
    }, true);
    document.addEventListener("keydown", (e) => {
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.key === "b" || e.key === "B" || e.key === "Escape") contract();
    });
    window.addEventListener("resize", () => {
      measureTop();
      dropWarm();
      const E = expRect();
      for (let i = 1; i <= level; i++) if (layers[i]) Object.assign(layers[i].style, { left: `${E.x}px`, top: `${E.y}px`, width: `${E.w}px`, height: `${E.h}px` });
      layoutFrost();
    });
    layoutFrost();
  };

  window.fractalCalendar = {
    year: YEAR,
    level: () => level,
    back: () => contract(),
    dayEl: (date) => surface?.querySelector(`.fc-day[data-date="${date}"], .fc-empty[data-date="${date}"]`) || null,
    monthEl: (m) => surface?.querySelector(`.fc-expander[data-month="${m}"], .fc-month[data-month="${m}"]`) || null,
    // Parity harness: stage the month view over its mini exactly as expand() would; diff cells.
    _parity: (mIdx, opacity = 1) => {
      const mini = layers[0].querySelector(`.fc-month[data-month="${mIdx}"]`);
      const r = mini.getBoundingClientRect();
      const E = expRect();
      const exp = document.createElement("div");
      exp.className = "fc-bucket fc-expander fc-parity";
      exp.dataset.kind = "month";
      exp.innerHTML = monthInnerHTML(mIdx - 1);
      const b = layoutRect(mini, layers[0]);
      exp.style.setProperty("--kx", (E.w / b.w).toFixed(4));
      exp.style.setProperty("--ky", (E.h / b.h).toFixed(4));
      Object.assign(exp.style, { left: `${E.x}px`, top: `${E.y}px`, width: `${E.w}px`, height: `${E.h}px`, opacity: String(opacity),
        transformOrigin: "0 0",
        transform: `translate(${(r.left - E.x).toFixed(2)}px, ${(r.top - E.y).toFixed(2)}px) scale(${(r.width / E.w).toFixed(5)}, ${(r.height / E.h).toFixed(5)})` });
      surface.appendChild(exp);
      const mc = [...mini.querySelectorAll(".fc-day")], sc = [...exp.querySelectorAll(".fc-day")];
      const deltas = mc.map((a, i) => {
        const ra = a.getBoundingClientRect(), rb = sc[i].getBoundingClientRect();
        return [rb.left - ra.left, rb.top - ra.top, rb.right - ra.right, rb.bottom - ra.bottom].map((v) => +v.toFixed(2));
      });
      const worst = Math.max(...deltas.flat().map(Math.abs));
      return { worst, day1: deltas[0], day31: deltas[deltas.length - 1] };
    },
    _parityClear: () => surface.querySelectorAll(".fc-parity").forEach((el) => el.remove()),
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
