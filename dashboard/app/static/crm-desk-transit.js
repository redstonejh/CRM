// crm-desk-transit.js - the desk's one navigation choreographer (BLUEPRINT A1).
// The Desk is a single continuous place and the camera is how you move through
// it: every module switch is a dive through the Home bucket lids, never a cut.
// This module is a motion coordinator, not a new UI species — it drives the
// existing home fractal camera (expand/contract) and lets crm-workspaces'
// setActive remain the instant commit primitive, called only at choreography
// boundaries (and at boot/restore, which is not navigation).
(() => {
  const TEMPORAL_MODULES = new Set(["pipeline", "jobs", "cases"]);
  const TRANSIT_Z = "2500";        // below the untouched native drag strip/chrome

  let busy = false;
  let queued = null;
  const performanceTimings = [];

  const ensureStyles = () => {
    if (document.getElementById("crm-desk-transit-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-desk-transit-styles";
    style.textContent = `
      /* The veil carries the fully-dived bucket lid for one beat while the
         destination theater takes the stage beneath its frost, then fades. */
      .crm-transit-veil { position: fixed; inset: 0; z-index: ${TRANSIT_Z}; pointer-events: none;
        opacity: .999; transform: translateZ(0); will-change: opacity; contain: paint;
        transition: opacity 96ms linear; }
      .crm-transit-veil.is-releasing { opacity: 0; }
      /* A destination appears behind the camera lid in its final visual state.
         Its own entrance transitions must not restart shadows or geometry when
         the lid is removed one frame later. */
      html.crm-transit-materializing [data-crm-theater]:not([hidden]),
      html.crm-transit-materializing [data-crm-theater]:not([hidden]) * {
        animation: none !important; transition: none !important; scroll-behavior: auto !important;
      }
    `;
    document.head.appendChild(style);
  };

  const camera = () => window.crmHomeCamera;
  const commit = (key) => window.crmWorkspaces?.setActive?.(key);
  const paint = (frames = 1) => new Promise((resolve) => {
    const next = () => frames-- > 0 ? requestAnimationFrame(next) : resolve();
    requestAnimationFrame(next);
  });
  const afterOpacity = (element, timeoutMs = 150) => new Promise((resolve) => {
    if (!element?.isConnected) { resolve(); return; }
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      element.removeEventListener("transitionend", onEnd);
      resolve();
    };
    const onEnd = (event) => {
      if (event.target === element && event.propertyName === "opacity") done();
    };
    const timeout = setTimeout(done, timeoutMs);
    element.addEventListener("transitionend", onEnd);
  });
  const bucketFor = (key) => {
    const layer = camera()?.layers?.()[0];
    return layer?.querySelector?.(`.crm-home-bucket[data-module="${key}"]`) || null;
  };
  const destinationFor = (key) => ({
    people: window.peopleCards,
    cases: window.ticketStacks,
    planner: window.crmPlanner,
    assignments: window.crmAssignments,
  })[key];

  // The dive-in ending: the expanded lid keeps covering the stage while the
  // destination theater is committed beneath it, then unfrosts away. The swap
  // happens behind blur(28px) glass — continuous to the eye, never a cut.
  const finishDiveIn = async (key, done) => {
    const startedAt = performance.now();
    const destinationApi = destinationFor(key);
    const destinationState = destinationApi?.performanceState?.() || null;
    const homePrewarm = window.crmHome?.prewarmStatus?.() || null;
    const cam = camera();
    const surface = cam?.surface?.();
    const lid = cam?.level?.() >= 1 ? cam.layers()[1] : null;
    let veil = null;
    if (lid) {
      ensureStyles();
      veil = document.createElement("div");
      veil.className = "crm-transit-veil";
      veil.appendChild(lid);   // adopt the lid out of the camera so the theater toggle can't hide it
      document.body.appendChild(veil);
    }
    document.documentElement.classList.add("crm-transit-materializing");
    // Build the destination while the fully expanded lid still covers the
    // viewport. This consumes async data and every factory's first layout
    // before the destination can contribute a visible frame.
    try { await destinationApi?.baseline?.({ canRender: () => true }); } catch {}
    const commitAt = performance.now();
    commit(key);
    const committedAt = performance.now();
    // Presence is not readiness: several card factories perform measured
    // layout after inserting their nodes. Keep the lid in place until sampled
    // geometry remains identical across consecutive frames.
    let settledState = null;
    try {
      settledState = await window.crmHome?.waitForModuleSettled?.(key);
    } catch {}
    if (settledState?.stable) window.crmHome?.noteModuleReady?.(key);
    const readyAt = performance.now();
    // A fully opaque lid lets Chromium cull the live theater beneath it. The
    // veil's .999 opacity keeps the picture visually exact while requiring the
    // destination to composite. Give it one complete covered paint before the
    // lid is retired, then keep entrance motion disabled for the first exposed
    // paint. This is a handoff between already-painted layers, not a reveal that
    // asks shadows and backdrop filters to instantiate on screen.
    await paint(2);
    const releaseAt = performance.now();
    if (veil) {
      // The exact lid and the final live room now occupy the same pixels. Fade
      // between them while both remain composited so backdrop filters and
      // shadows cannot first materialize on the uncovered frame.
      void veil.offsetWidth;
      veil.classList.add("is-releasing");
      await afterOpacity(veil);
      veil.remove();
    }
    if (cam?.restoreRoot) cam.restoreRoot();
    else cam?.rebuildRoot?.();
    try { window.crmHome?.recycleExpander?.(key, lid); } catch {}
    if (surface) surface.style.zIndex = "";
    await paint(2);
    document.documentElement.classList.remove("crm-transit-materializing");
    const doneAt = performance.now();
    performanceTimings.push({ key, destinationState, homePrewarm, settled: settledState?.stable === true,
      commitMs: committedAt - commitAt, readyMs: readyAt - committedAt,
      frameWaitMs: releaseAt - readyAt, releaseMs: doneAt - releaseAt, totalMs: doneAt - startedAt });
    if (performanceTimings.length > 24) performanceTimings.shift();
    done();
  };

  // Home (active, level 0) → module: play the home camera's own dive, commit at
  // completion — the 180ms mid-flight cut this replaces was the build failure.
  const diveIn = (key, done, expandFirst = true) => {
    const cam = camera();
    const bucket = bucketFor(key);
    if (!cam || !bucket) { commit(key); done(); return; }
    const surface = cam.surface();
    if (surface) surface.style.zIndex = TRANSIT_Z;
    if (expandFirst) {
      if (cam.level() > 0) cam.rebuildRoot();
      cam.expand(bucket);
    }
    Promise.resolve(cam.whenSettled?.()).then(() => finishDiveIn(key, done));
  };

  // Module → Home: seat the module's own bucket lid over the stage at full
  // size (jumpTo), commit Home behind its frost, then contract() flies the lid
  // back into its Home slot — the identical camera move, reversed.
  const diveOut = (fromKey, done) => {
    const cam = camera();
    // Snapshot the room's actual selected tab, expansion and scroll state while
    // it is still visible. The hidden preview renderer receives this state and
    // replaces the Home raster only after the return handoff has completed.
    try { window.crmHome?.refreshDisplayedPreview?.(fromKey); } catch {}
    try { window.crmHome?.setActive?.(true); } catch {}
    if (!cam) { commit("home"); done(); return; }
    if (cam.level() > 0) cam.rebuildRoot();
    const bucket = bucketFor(fromKey);
    const surface = cam.surface();
    if (!bucket || !cam.jumpTo?.(bucket)) { commit("home"); done(); return; }
    if (surface) surface.style.zIndex = TRANSIT_Z;
    commit("home");   // the module vanishes behind the full-screen lid, same frame
    requestAnimationFrame(() => {
      cam.back();     // 460ms house contract into the Home slot
      Promise.resolve(cam.whenSettled?.()).then(() => window.crmHome?.waitForHandoff?.()).then(() => {
        if (surface) surface.style.zIndex = "";
        done();
      });
    });
  };

  const driveTo = (key) => new Promise((resolve) => {
    const ws = window.crmWorkspaces;
    if (!ws || !(ws.modules?.() || []).some((module) => module.key === key)) { resolve(false); return; }
    const current = ws.active?.();
    if (busy) { queued = { key, resolve }; return; }
    if (key === current) { resolve(true); return; }
    busy = true;
    const done = () => {
      busy = false;
      resolve(true);
      document.dispatchEvent(new CustomEvent("crm:desk-transit-settled", { detail: { key: ws.active?.() || key } }));
      const next = queued;
      queued = null;
      if (next) driveTo(next.key).then(next.resolve);
    };
    try {
      if (current === "home") diveIn(key, done);
      else if (key === "home") diveOut(current, done);
      else diveOut(current, () => diveIn(key, done));   // neighbors on the desk: out through Home, in again
    } catch {
      commit(key);   // motion failed — state must still be correct
      done();
    }
  });

  // A dive the home camera already started (a bucket click — the camera's own
  // onClick ran expand): adopt its ending instead of starting a second one.
  const adoptDive = (key) => new Promise((resolve) => {
    const ws = window.crmWorkspaces;
    if (!ws || busy) { resolve(false); return; }
    busy = true;
    const surface = camera()?.surface?.();
    if (surface) surface.style.zIndex = TRANSIT_Z;
    const done = () => {
      busy = false;
      resolve(true);
      document.dispatchEvent(new CustomEvent("crm:desk-transit-settled", { detail: { key: ws.active?.() || key } }));
      const next = queued;
      queued = null;
      if (next) driveTo(next.key).then(next.resolve);
    };
    Promise.resolve(camera()?.whenSettled?.()).then(() => finishDiveIn(key, done));
  });

  // B / Esc backs out to Home from any camera-less module. Camera surfaces
  // (calendar) chain through their own onRootBack; overlays that own the key
  // (detail panel, menus, search deck, company dive, an open trash
  // bin) always win — the desk never navigates out from under an open hand.
  const overlayOwnsKeys = (key) => {
    if (window.crmCompanyDive?.isActive?.()) return true;
    if (window.crmSearchDeck?.isOpen?.()) return true;
    if (window.crmRecordWorld?.isOpen?.()) return true;
    if (document.querySelector(".ticket-detail-overlay:not([hidden]), .tk-menu")) return true;
    if (key === "Escape" && document.querySelector("section[data-crm-theater]:not([hidden]) .tk-stack-btn.is-active")) return true;
    return false;
  };
  const today = () => {
    const date = window.__CRM_NOW__ ? new Date(window.__CRM_NOW__) : new Date();
    return Number.isFinite(date.getTime()) ? date : new Date();
  };
  const localDateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const syncTemporalContext = (key = document.body.dataset.crmModule || "home") => {
    const on = TEMPORAL_MODULES.has(key);
    if (on) {
      const date = today();
      document.body.dataset.crmTemporalDate = localDateKey(date);
    } else delete document.body.dataset.crmTemporalDate;
  };
  const zoomOutToCalendar = (fromKey = document.body.dataset.crmModule || "") => {
    if (!TEMPORAL_MODULES.has(fromKey)) return false;
    window.crmWorkspaces?.setActive?.("calendar");
    requestAnimationFrame(() => window.fractalCalendar?.openMonthFor?.(today()));
    return true;
  };
  document.addEventListener("crm:theater-switch", (event) => syncTemporalContext(event.detail?.key));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "b" && event.key !== "B" && event.key !== "Escape") return;
    if (event.defaultPrevented) return;
    const target = event.target;
    if (target && (/INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable)) return;
    const current = document.body.dataset.crmModule || "home";
    if (current === "home" || current === "calendar" || current === "planner") return;   // nested cameras own their own chain
    if (busy || overlayOwnsKeys(event.key)) return;
    if (TEMPORAL_MODULES.has(current)) {
      // Calendar becomes active synchronously. Consume this originating key so
      // its own camera does not also interpret it as a second zoom-out step.
      event.preventDefault();
      event.stopImmediatePropagation();
      zoomOutToCalendar(current);
      return;
    }
    driveTo("home");
  }, true);

  window.crmDeskTransit = {
    driveTo,
    adoptDive,
    zoomOutToCalendar,
    temporalModules: () => [...TEMPORAL_MODULES],
    isBusy: () => busy,
    performanceTimings: () => performanceTimings.map((item) => ({ ...item })),
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => syncTemporalContext(), { once: true });
  else syncTemporalContext();
})();
