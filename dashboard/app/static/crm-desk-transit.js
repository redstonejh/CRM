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
  const RELEASE_HOLD = .86;
  const RELEASE_EASE = "cubic-bezier(.37, 0, .63, 1)";

  let busy = false;
  let queued = null;
  const performanceTimings = [];
  const HISTORY_LIMIT = 48;
  const HISTORY_CAMERAS = new Set(["crmProjectsCamera", "fractalCalendarCamera"]);
  let navigationEntries = [];
  let navigationIndex = -1;
  let navigationSeeded = false;
  let navigationRestoring = false;
  let navigationCaptureToken = 0;
  let lastPhysicalDirection = 0;
  let lastPhysicalAt = 0;
  let lastPhysicalSource = "";
  let diveSequence = 0;
  let activeDive = null;

  const ensureStyles = () => {
    if (document.getElementById("crm-desk-transit-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-desk-transit-styles";
    style.textContent = `
      /* Only the incoming room is held still while it is built. Home remains a
         live camera above it; no full-viewport veil or endpoint image exists. */
      html.crm-transit-materializing [data-crm-transit-destination],
      html.crm-transit-materializing [data-crm-transit-destination] * {
        animation: none !important; transition: none !important; scroll-behavior: auto !important;
      }
      /* Card-system theaters intentionally use display:contents at rest. During
         transit that would promote every acrylic bucket independently at the
         reveal boundary. A temporary viewport box groups those unchanged fixed
         children into one compositor surface; it adds no transform or new
         fixed-position containing block. */
      html.crm-transit-materializing [data-crm-transit-group]{
        display:block!important;position:fixed!important;inset:0!important;
        width:100vw!important;height:100vh!important;pointer-events:none!important}
      /* The destination stays out of the moving GPU pass. At the endpoint it is
         grouped, painted beneath the full-size foreground, and only then takes
         ownership through the short material release. */
      html.crm-transit-materializing [data-crm-transit-layer]{
        opacity:.001!important;will-change:opacity;transition:none!important}
      html.crm-transit-materializing .crm-module-switch[data-crm-transit-layer][hidden]{
        display:grid!important}
      html.crm-transit-materializing.crm-transit-revealing [data-crm-transit-layer]{
        opacity:var(--crm-transit-rest-opacity,1)!important;
        transition:opacity var(--crm-transit-reveal-ms,64ms) ${RELEASE_EASE} var(--crm-transit-reveal-delay,0ms)!important}
    `;
    document.head.appendChild(style);
  };

  const camera = () => window.crmHomeCamera;
  const commit = (key) => window.crmWorkspaces?.setActive?.(key);
  const paint = (frames = 1) => new Promise((resolve) => {
    const next = () => frames-- > 0 ? requestAnimationFrame(next) : resolve();
    requestAnimationFrame(next);
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
  let destinationLayers = [];
  let destinationRoot = null;
  const clearDestinationLayers = () => {
    destinationLayers.forEach((layer) => {
      layer.removeAttribute("data-crm-transit-layer");
      layer.style.removeProperty("--crm-transit-rest-opacity");
      layer.style.removeProperty("--crm-transit-reveal-ms");
      layer.style.removeProperty("--crm-transit-reveal-delay");
    });
    destinationRoot?.removeAttribute?.("data-crm-transit-destination");
    destinationRoot?.removeAttribute?.("data-crm-transit-group");
    destinationRoot?.removeAttribute?.("data-crm-home-precomposed");
    destinationRoot = null;
    destinationLayers = [];
  };
  const addDestinationLayer = (layer) => {
    if (!layer || destinationLayers.includes(layer)) return;
    layer.style.setProperty("--crm-transit-rest-opacity", getComputedStyle(layer).opacity || "1");
    layer.setAttribute("data-crm-transit-layer", "");
    destinationLayers.push(layer);
  };
  const findDestinationTheater = (key) => {
    const theaterName = key === "cases" ? "tickets" : key;
    return [...document.querySelectorAll(`[data-crm-theater="${theaterName}"]`)].find((node) => !node.hidden)
      || document.querySelector(`[data-crm-theater="${theaterName}"]`);
  };
  const primeDestinationLayers = (key, theater = findDestinationTheater(key)) => {
    clearDestinationLayers();
    if (!theater) return destinationLayers;
    destinationRoot = theater;
    destinationRoot.setAttribute("data-crm-transit-destination", "");
    if (destinationRoot.matches(".crm-theater,[data-crm-home-precomposed]") || getComputedStyle(destinationRoot).display === "contents") {
      destinationRoot.setAttribute("data-crm-transit-group", "");
    }
    addDestinationLayer(theater);
    addDestinationLayer(document.querySelector(".crm-module-switch"));
    return destinationLayers;
  };
  const stageDestinationLayers = (key, theater = findDestinationTheater(key)) => {
    if (!theater) return destinationLayers;
    const boxesOf = (node) => {
      if (!node || node.hidden || getComputedStyle(node).display === "none") return [];
      if (getComputedStyle(node).display === "contents") return [...node.children].flatMap(boxesOf);
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? [node] : [...node.children].flatMap(boxesOf);
    };
    if (theater.hasAttribute("data-crm-transit-group")) addDestinationLayer(theater);
    else if (getComputedStyle(theater).display === "contents") [...theater.children].flatMap(boxesOf).forEach(addDestinationLayer);
    else addDestinationLayer(theater);
    return destinationLayers;
  };
  const viewportApiFor = (key) => ({
    people:window.peopleCards,
    pipeline:window.dealPipeline,
    jobs:window.jobPipeline,
    planner:window.crmPlanner,
    assignments:window.crmAssignments,
    calendar:window.fractalCalendar,
    cases:window.ticketStacks,
  })[key] || null;
  const viewportCameraFor = (key) => ({
    planner:window.crmProjectsCamera,
    calendar:window.fractalCalendarCamera,
  })[key] || null;
  const safeClone = (value) => {
    if (value == null) return value;
    try { return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
    catch { return null; }
  };
  const captureViewport = () => {
    const module = window.crmWorkspaces?.active?.() || document.body.dataset.crmModule || "home";
    const moduleApi = viewportApiFor(module);
    const moduleCamera = viewportCameraFor(module);
    let state = null; let cameraState = null;
    try { state = safeClone(moduleApi?.homePreviewState?.() || null); } catch {}
    try { cameraState = safeClone(moduleCamera?.historyState?.() || null); } catch {}
    return { module, state, camera:cameraState };
  };
  const viewportSignature = (viewport) => {
    try { return JSON.stringify(viewport || null); } catch { return ""; }
  };
  const navigationStatus = () => ({
    index:navigationIndex,
    length:navigationEntries.length,
    canBack:!busy && !navigationRestoring && navigationIndex > 0,
    canForward:!busy && !navigationRestoring && navigationIndex >= 0 && navigationIndex < navigationEntries.length - 1,
    busy:busy || navigationRestoring,
    module:navigationEntries[navigationIndex]?.module || window.crmWorkspaces?.active?.() || "home",
  });
  const announceNavigationHistory = () => document.dispatchEvent(new CustomEvent("crm:navigation-history-changed", { detail:navigationStatus() }));
  const seedNavigationHistory = () => {
    if (navigationSeeded || !window.crmWorkspaces?.active) return navigationSeeded;
    const current = captureViewport();
    navigationEntries = current.module === "home" ? [current] : [{ module:"home", state:null, camera:null }, current];
    navigationIndex = navigationEntries.length - 1;
    navigationSeeded = true;
    announceNavigationHistory();
    return true;
  };
  const replaceCurrentViewport = (viewport = captureViewport()) => {
    if (!seedNavigationHistory()) return false;
    navigationEntries[navigationIndex] = safeClone(viewport);
    announceNavigationHistory();
    return true;
  };
  const commitCurrentViewport = (viewport = captureViewport()) => {
    if (!seedNavigationHistory()) return false;
    const next = safeClone(viewport);
    if (viewportSignature(navigationEntries[navigationIndex]) === viewportSignature(next)) navigationEntries[navigationIndex] = next;
    else {
      navigationEntries.splice(navigationIndex + 1);
      navigationEntries.push(next);
      if (navigationEntries.length > HISTORY_LIMIT) navigationEntries.splice(0, navigationEntries.length - HISTORY_LIMIT);
      navigationIndex = navigationEntries.length - 1;
    }
    announceNavigationHistory();
    return true;
  };
  const noteViewportDeparture = () => {
    if (busy || navigationRestoring) return false;
    return replaceCurrentViewport();
  };
  const noteViewportArrival = () => {
    if (busy || navigationRestoring) return false;
    const token = ++navigationCaptureToken;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (token === navigationCaptureToken && !busy && !navigationRestoring) commitCurrentViewport();
    }));
    return true;
  };

  const armDestinationReveal = (stage) => {
    if (!stage || stage.revealArmed || !stage.ready || !Number.isFinite(stage.motionStartedAt)) return false;
    stage.revealArmed = true;
    const duration = Math.max(32, stage.morphMs * (1 - RELEASE_HOLD));
    const revealAt = stage.motionStartedAt + stage.morphMs * RELEASE_HOLD;
    const delay = Math.max(0, revealAt - performance.now());
    stage.releaseAt = revealAt;
    const beginReveal = () => {
      if (stage.sequence !== activeDive?.sequence) return;
      destinationLayers.forEach((layer) => {
        layer.style.setProperty("--crm-transit-reveal-ms", `${duration.toFixed(2)}ms`);
        layer.style.setProperty("--crm-transit-reveal-delay", "0ms");
      });
      // The retained destination has already painted at .001 for the entire
      // camera move. Reading offsetWidth here used to force a viewport-wide
      // layout exactly at the reveal boundary and could drop a native frame.
      document.documentElement.classList.add("crm-transit-revealing");

      // The moving foreground and the already-composited live room exchange
      // ownership on the same timeline. No delayed transition remains active
      // during the preceding camera frames.
      const lid = camera()?.layers?.()[1];
      const foreground = lid?.querySelector?.(".crm-home-preview-foreground");
      if (foreground) {
        stage.foregroundAnimation = foreground.animate(
          [{ opacity:1 }, { opacity:0 }],
          { duration, easing:RELEASE_EASE, fill:"both" },
        );
      }
      stage.revealTimer = setTimeout(() => {
        if (stage.sequence !== activeDive?.sequence) return;
        requestAnimationFrame(() => {
          stage.revealedAt = performance.now();
          stage.resolveReveal?.();
          stage.resolveReveal = null;
        });
      }, duration + 20);
    };
    stage.revealTimer = setTimeout(beginReveal, delay);
    return true;
  };

  const prepareDiveDestination = async (stage) => {
    const destinationApi = destinationFor(stage.key);
    stage.destinationState = destinationApi?.performanceState?.() || null;
    stage.homePrewarm = window.crmHome?.prewarmStatus?.() || null;
    let theater = findDestinationTheater(stage.key);
    let retainedPrecompose = !!theater?.hasAttribute?.("data-crm-home-precomposed");
    if (!retainedPrecompose) {
      try { await destinationApi?.baseline?.({ canRender: () => stage.sequence === activeDive?.sequence }); } catch {}
      theater = findDestinationTheater(stage.key);
      retainedPrecompose = !!theater?.hasAttribute?.("data-crm-home-precomposed");
    }
    if (stage.sequence !== activeDive?.sequence) return;

    if (retainedPrecompose) {
      // The room has already completed layout and at least one covered paint.
      // Return it to [hidden] for the transform itself: keeping its many live
      // backdrop surfaces in the same GPU pass as the moving screen-space lens
      // is measurably slower than restoring the retained group at the endpoint.
      theater.removeAttribute("data-crm-home-precomposed");
      stage.settledState = { stable:true, signature:"retained-precompose" };
    } else {
      // baseline() resolves only after the factory has built its complete DOM.
      // Measuring that hidden tree would require making it paint during motion,
      // which is precisely the competing GPU work this endpoint bridge avoids.
      stage.settledState = { stable:true, signature:"baseline-complete" };
      window.crmHome?.noteModuleReady?.(stage.key);
    }
    stage.theater = theater;
    stage.preparedAt = performance.now();
    stage.prepared = true;
  };

  const materializeDiveDestination = async (stage) => {
    if (!stage || stage.ready || stage.sequence !== activeDive?.sequence) return;
    ensureStyles();
    primeDestinationLayers(stage.key, stage.theater || findDestinationTheater(stage.key));
    document.documentElement.classList.remove("crm-transit-revealing");
    document.documentElement.classList.add("crm-transit-materializing");
    stageDestinationLayers(stage.key, destinationRoot);
    // The full-size foreground remains the visible owner while the retained
    // room reacquires its compositor surfaces. Two complete paints make the
    // following opacity exchange a reveal, never first-frame instantiation.
    await paint(2);
    if (stage.sequence !== activeDive?.sequence) return;
    stage.readyAt = performance.now();
    stage.ready = true;
    armDestinationReveal(stage);
  };

  const beginDiveDestination = (key) => {
    let resolveReveal = null;
    const revealPromise = new Promise((resolve) => { resolveReveal = resolve; });
    const stage = {
      key,
      sequence:++diveSequence,
      startedAt:performance.now(),
      morphMs:460,
      motionStartedAt:Number.NaN,
      ready:false,
      revealArmed:false,
      committed:false,
      resolveReveal,
      revealPromise,
      foregroundAnimation:null,
    };
    activeDive = stage;
    stage.preparePromise = prepareDiveDestination(stage);
    return stage;
  };

  const noteHomeTransformStart = (direction, startedAt = performance.now(), morphMs = 460) => {
    if (direction !== "expand" || !activeDive || Number.isFinite(activeDive.motionStartedAt)) return false;
    activeDive.motionStartedAt = Number(startedAt) || performance.now();
    activeDive.morphMs = Math.max(1, Number(morphMs) || 460);
    armDestinationReveal(activeDive);
    return true;
  };

  // The transparent room foreground reaches its exact endpoint first. Restore
  // the live destination beneath those unchanged pixels, let it complete
  // covered paints, and only then exchange ownership and commit the route.
  const finishDiveIn = async (key, done, stage) => {
    const cam = camera();
    const surface = cam?.surface?.();
    try { await stage?.preparePromise; } catch {}
    if (!Number.isFinite(stage.motionStartedAt)) {
      stage.motionStartedAt = performance.now() - stage.morphMs;
    }
    try { await materializeDiveDestination(stage); } catch {}
    if (!stage.ready) { stage.ready = true; stage.readyAt = performance.now(); }
    armDestinationReveal(stage);
    try { await stage.revealPromise; } catch {}

    // The destination is already the visible full-strength owner. Commit only
    // now, after camera motion and material exchange, so router/API activation
    // cannot steal frames from the zoom. Hidden/display ownership changes, but
    // the rendered destination pixels do not.
    if (!stage.committed) {
      stage.commitAt = performance.now();
      commit(key);
      stage.committedAt = performance.now();
      stage.committed = true;
    }
    const lid = cam?.level?.() >= 1 ? cam.layers()[1] : null;
    if (cam?.restoreRoot) cam.restoreRoot();
    else cam?.rebuildRoot?.();
    try { window.crmHome?.recycleExpander?.(key, lid); } catch {}
    if (surface) {
      surface.hidden = true;
      surface.style.zIndex = "";
    }
    stage.foregroundAnimation?.cancel?.();
    document.documentElement.classList.remove("crm-transit-materializing", "crm-transit-revealing");
    clearDestinationLayers();
    const doneAt = performance.now();
    performanceTimings.push({
      key,
      destinationState:stage.destinationState,
      homePrewarm:stage.homePrewarm,
      settled:stage.settledState?.stable === true,
      commitMs:(stage.committedAt || stage.commitAt || doneAt) - (stage.commitAt || stage.startedAt),
      readyMs:(stage.readyAt || doneAt) - stage.startedAt,
      frameWaitMs:Math.max(0, (stage.releaseAt || doneAt) - (stage.readyAt || doneAt)),
      releaseMs:doneAt - (stage.releaseAt || doneAt),
      totalMs:doneAt - stage.startedAt,
    });
    if (performanceTimings.length > 24) performanceTimings.shift();
    if (activeDive?.sequence === stage.sequence) activeDive = null;
    done();
  };

  // Home (active, level 0) → module: play the home camera's own dive, commit at
  // completion — the 180ms mid-flight cut this replaces was the build failure.
  const diveIn = (key, done, expandFirst = true) => {
    const cam = camera();
    const bucket = bucketFor(key);
    if (!cam || !bucket) { commit(key); done(); return; }
    const stage = beginDiveDestination(key);
    const surface = cam.surface();
    if (surface) surface.style.zIndex = TRANSIT_Z;
    if (expandFirst) {
      if (cam.level() > 0) cam.rebuildRoot();
      cam.expand(bucket);
    }
    Promise.resolve(cam.whenSettled?.()).then(() => finishDiveIn(key, done, stage));
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

  const restoreViewport = async (viewport) => {
    const ws = window.crmWorkspaces;
    const targetModule = String(viewport?.module || "home");
    if (!ws?.modules?.().some((module) => module.key === targetModule)) return false;
    const changedModule = ws.active?.() !== targetModule;
    if (changedModule) {
      const moved = await driveTo(targetModule, { history:false });
      if (!moved) return false;
    }
    const moduleApi = viewportApiFor(targetModule);
    const moduleCamera = viewportCameraFor(targetModule);
    if (changedModule && viewport?.state && moduleApi?.applyHomePreviewState) {
      try { await moduleApi.applyHomePreviewState(safeClone(viewport.state)); } catch {}
    }
    if (viewport?.camera && moduleCamera?.restoreHistoryState) {
      try { await moduleCamera.restoreHistoryState(safeClone(viewport.camera)); } catch {}
    } else if (!changedModule && viewport?.state && moduleApi?.applyHomePreviewState) {
      try { await moduleApi.applyHomePreviewState(safeClone(viewport.state)); } catch {}
    }
    return ws.active?.() === targetModule;
  };
  const moveThroughHistory = async (delta) => {
    if (busy || navigationRestoring) return false;
    if (!seedNavigationHistory()) return false;
    replaceCurrentViewport();
    const targetIndex = navigationIndex + (delta < 0 ? -1 : 1);
    if (targetIndex < 0 || targetIndex >= navigationEntries.length) return false;
    const previousIndex = navigationIndex;
    const target = safeClone(navigationEntries[targetIndex]);
    navigationRestoring = true;
    navigationCaptureToken += 1;
    announceNavigationHistory();
    let restored = false;
    try { restored = await restoreViewport(target); }
    finally {
      navigationIndex = restored ? targetIndex : previousIndex;
      if (restored) navigationEntries[navigationIndex] = captureViewport();
      navigationRestoring = false;
      announceNavigationHistory();
    }
    return restored;
  };

  const driveTo = (key, options = {}) => new Promise((resolve) => {
    const ws = window.crmWorkspaces;
    if (!ws || !(ws.modules?.() || []).some((module) => module.key === key)) { resolve(false); return; }
    const current = ws.active?.();
    if (busy) { queued = { key, options, resolve }; return; }
    if (key === current) { resolve(true); return; }
    const recordHistory = options.history !== false && !navigationRestoring;
    if (recordHistory) noteViewportDeparture();
    busy = true;
    announceNavigationHistory();
    const done = () => {
      busy = false;
      if (recordHistory) commitCurrentViewport(); else announceNavigationHistory();
      resolve(true);
      document.dispatchEvent(new CustomEvent("crm:desk-transit-settled", { detail: { key: ws.active?.() || key } }));
      const next = queued;
      queued = null;
      if (next) driveTo(next.key, next.options).then(next.resolve);
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
    noteViewportDeparture();
    busy = true;
    announceNavigationHistory();
    const surface = camera()?.surface?.();
    if (surface) surface.style.zIndex = TRANSIT_Z;
    const stage = beginDiveDestination(key);
    const done = () => {
      busy = false;
      commitCurrentViewport();
      resolve(true);
      document.dispatchEvent(new CustomEvent("crm:desk-transit-settled", { detail: { key: ws.active?.() || key } }));
      const next = queued;
      queued = null;
      if (next) driveTo(next.key, next.options).then(next.resolve);
    };
    Promise.resolve(camera()?.whenSettled?.()).then(() => finishDiveIn(key, done, stage));
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
    noteViewportDeparture();
    window.crmWorkspaces?.setActive?.("calendar");
    requestAnimationFrame(() => {
      window.fractalCalendar?.openMonthFor?.(today());
      noteViewportArrival();
    });
    return true;
  };
  document.addEventListener("crm:theater-switch", (event) => {
    syncTemporalContext(event.detail?.key);
    if (!busy && !navigationRestoring) noteViewportArrival();
  });
  document.addEventListener("crm:camera-navigation", (event) => {
    if (!HISTORY_CAMERAS.has(event.detail?.apiName) || busy || navigationRestoring) return;
    if (event.detail?.phase === "start") noteViewportDeparture();
    if (event.detail?.phase === "settled") noteViewportArrival();
  });
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

  const physicalHistory = (direction, event, source = "dom") => {
    event?.preventDefault?.();
    event?.stopImmediatePropagation?.();
    const now = performance.now();
    if (direction === lastPhysicalDirection && source !== lastPhysicalSource && now - lastPhysicalAt < 220) return true;
    lastPhysicalDirection = direction;
    lastPhysicalAt = now;
    lastPhysicalSource = source;
    void moveThroughHistory(direction);
    return true;
  };
  window.addEventListener("mousedown", (event) => {
    if (event.button === 3) physicalHistory(-1, event);
    if (event.button === 4) physicalHistory(1, event);
  }, true);
  window.addEventListener("auxclick", (event) => {
    if (event.button === 3 || event.button === 4) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  try {
    window.crmNavigationInput?.onCommand?.((command) => {
      if (command === "back") physicalHistory(-1, null, "native");
      if (command === "forward") physicalHistory(1, null, "native");
    });
  } catch {}

  window.crmDeskTransit = {
    driveTo,
    adoptDive,
    noteHomeTransformStart,
    back:() => moveThroughHistory(-1),
    forward:() => moveThroughHistory(1),
    canGoBack:() => navigationStatus().canBack,
    canGoForward:() => navigationStatus().canForward,
    historyState:navigationStatus,
    noteViewportDeparture,
    noteViewportArrival,
    zoomOutToCalendar,
    temporalModules: () => [...TEMPORAL_MODULES],
    isBusy: () => busy || navigationRestoring,
    performanceTimings: () => performanceTimings.map((item) => ({ ...item })),
  };
  const initializeNavigation = () => {
    syncTemporalContext();
    requestAnimationFrame(() => requestAnimationFrame(() => seedNavigationHistory()));
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initializeNavigation, { once: true });
  else initializeNavigation();
})();
