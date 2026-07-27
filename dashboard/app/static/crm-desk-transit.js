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
  const STATIC_CROSSFADE_MS = 64;

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
  let homeMotionState = { active:false, direction:"", startedAt:0, endedAt:0, sequence:0 };
  let ownershipFadeState = { active:false, startedAt:0, endedAt:0, duration:0, sequence:0 };
  const rasterNodeIds = new WeakMap();
  let rasterNodeSequence = 0;

  const ensureStyles = () => {
    if (document.getElementById("crm-desk-transit-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-desk-transit-styles";
    style.textContent = `
      /* Only the incoming room is held still while it is built. Camera motion
         has already ended and the decoded exact room raster remains above it. */
      html.crm-transit-materializing [data-crm-transit-destination] {
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
         grouped and painted beneath the exact full-size room raster. Raster and
         live room exchange ownership in a short compositor-only dissolve after
         both surfaces have completed covered paints. */
      html.crm-transit-materializing [data-crm-transit-layer]{
        opacity:.001!important;will-change:opacity;transition:none!important}
      html.crm-transit-materializing .crm-module-switch[data-crm-transit-layer][hidden]{
        display:grid!important}
      html.crm-transit-materializing.crm-transit-revealing [data-crm-transit-layer]{
        opacity:var(--crm-transit-rest-opacity,1)!important;
        transition:none!important}
      [data-crm-transit-retained]{transform:translate3d(-110vw,0,0)!important;pointer-events:none!important}
    `;
    document.head.appendChild(style);
  };

  const camera = () => window.crmHomeCamera;
  const commit = (key) => window.crmWorkspaces?.setActive?.(key);
  const paint = (frames = 1) => new Promise((resolve) => {
    let remaining = Math.max(1, Number(frames) || 1);
    const next = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(next);
    };
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
    });
    destinationRoot?.removeAttribute?.("data-crm-transit-destination");
    destinationRoot?.removeAttribute?.("data-crm-transit-group");
    destinationRoot?.removeAttribute?.("data-crm-transit-retained");
    destinationRoot?.removeAttribute?.("data-crm-home-precomposed");
    destinationRoot = null;
    destinationLayers = [];
  };
  const addDestinationLayer = (layer) => {
    if (!layer || destinationLayers.includes(layer)) return;
    // A retained inactive theater is intentionally .001. That is its parked
    // opacity, not its active-room opacity; the covered release must restore it
    // to one before the raster lid begins to dissolve.
    const restingOpacity = layer.hasAttribute?.("data-crm-home-precomposed")
      || layer.matches?.(".crm-module-switch")
      ? "1"
      : (getComputedStyle(layer).opacity || "1");
    layer.style.setProperty("--crm-transit-rest-opacity", restingOpacity);
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

  const roundGeometry = (value) => Math.round((Number(value) || 0) * 100) / 100;
  const compactSource = (source = "") => ({
    length:source.length,
    head:source.slice(0, 24),
    tail:source.slice(-24),
  });
  const rasterIdentity = (node) => {
    if (!node) return 0;
    if (!rasterNodeIds.has(node)) rasterNodeIds.set(node, ++rasterNodeSequence);
    return rasterNodeIds.get(node);
  };
  const inspectRasterCover = (stage) => {
    const cam = camera();
    const lid = stage?.lid || (cam?.level?.() >= 1 ? cam.layers()[1] : null);
    const host = stage?.coverHost || lid?.querySelector?.(":scope > .crm-home-preview");
    const raster = stage?.coverRaster || host?.querySelector?.(":scope > .crm-home-preview-exact");
    if (!lid || !host || !raster) {
      return {
        ready:false,
        nodeId:rasterIdentity(raster),
        frame:lid?.dataset?.fractalFrame || "",
        viewport:{ width:innerWidth, height:innerHeight },
      };
    }
    const source = raster.currentSrc || raster.src || "";
    const rect = raster.getBoundingClientRect();
    const rasterStyle = getComputedStyle(raster);
    const hostStyle = getComputedStyle(host);
    const lidStyle = lid.style;
    const signature = {
      ready:!!raster.complete && raster.naturalWidth > 0 && raster.naturalHeight > 0
        && rect.width >= innerWidth - 1 && rect.height >= innerHeight - 1,
      nodeId:rasterIdentity(raster),
      source:compactSource(source),
      complete:!!raster.complete,
      naturalWidth:raster.naturalWidth || 0,
      naturalHeight:raster.naturalHeight || 0,
      rect:{
        x:roundGeometry(rect.x),
        y:roundGeometry(rect.y),
        width:roundGeometry(rect.width),
        height:roundGeometry(rect.height),
      },
      opacity:roundGeometry(rasterStyle.opacity),
      hostOpacity:roundGeometry(hostStyle.opacity),
      display:rasterStyle.display,
      visibility:rasterStyle.visibility,
      frame:lid.dataset.fractalFrame || "",
      lidStyle:{
        left:lidStyle.left || "",
        top:lidStyle.top || "",
        width:lidStyle.width || "",
        height:lidStyle.height || "",
        transform:lidStyle.transform || "",
        opacity:lidStyle.opacity || "",
      },
      viewport:{ width:innerWidth, height:innerHeight },
    };
    if (stage) {
      stage.lid = lid;
      stage.coverHost = host;
      stage.coverRaster = raster;
      stage.coverSource = source;
    }
    return signature;
  };
  const sameGeometry = (left, right, tolerance = .25) => ["x", "y", "width", "height"]
    .every((key) => Math.abs(Number(left?.[key]) - Number(right?.[key])) <= tolerance);
  const sameRasterCover = (stage, before, after) => !!before?.ready && !!after?.ready
    && before.nodeId === after.nodeId
    && stage?.coverRaster === stage?.coverHost?.querySelector?.(":scope > .crm-home-preview-exact")
    && stage?.coverSource === (stage?.coverRaster?.currentSrc || stage?.coverRaster?.src || "")
    && before.source.length === after.source.length
    && before.source.head === after.source.head
    && before.source.tail === after.source.tail
    && before.naturalWidth === after.naturalWidth
    && before.naturalHeight === after.naturalHeight
    && sameGeometry(before.rect, after.rect)
    && before.opacity === 1 && after.opacity === 1
    && before.hostOpacity === 1 && after.hostOpacity === 1
    && before.display !== "none" && after.display !== "none"
    && before.visibility === "visible" && after.visibility === "visible"
    && before.frame === "viewport" && after.frame === "viewport"
    && before.lidStyle.left === after.lidStyle.left
    && before.lidStyle.top === after.lidStyle.top
    && before.lidStyle.width === after.lidStyle.width
    && before.lidStyle.height === after.lidStyle.height
    && before.lidStyle.transform === after.lidStyle.transform
    && before.lidStyle.opacity === after.lidStyle.opacity
    && before.viewport.width === after.viewport.width
    && before.viewport.height === after.viewport.height;
  const liveLayerState = (layers = destinationLayers) => layers.filter((layer) => layer?.isConnected).map((layer) => {
    const style = getComputedStyle(layer);
    return {
      tag:layer.tagName,
      theater:layer.dataset?.crmTheater || "",
      opacity:Math.round((Number(style.opacity) || 0) * 1000) / 1000,
      display:style.display,
      visibility:style.visibility,
    };
  });
  const phaseDetail = (stage, phase) => ({
    key:stage?.key || "",
    sequence:stage?.sequence || 0,
    phase,
    coverInvariant:stage?.coverInvariant !== false,
    cover:inspectRasterCover(stage),
    liveReady:!!stage?.liveReady,
    liveLayers:liveLayerState(stage?.finalDestinationLayers?.length
      ? stage.finalDestinationLayers
      : destinationLayers),
  });
  const holdProbePhase = async (stage, phase) => {
    const detail = phaseDetail(stage, phase);
    document.dispatchEvent(new CustomEvent("crm:desk-transit-phase", { detail }));
    const hold = window.__crmDeskTransitProbe?.hold;
    if (typeof hold !== "function") return detail;
    try { await Promise.resolve(hold(phase, detail)); } catch {}
    return detail;
  };

  const seatEndpointRaster = async (stage) => {
    const cam = camera();
    const lid = cam?.level?.() >= 1 ? cam.layers()[1] : null;
    const host = lid?.querySelector?.(":scope > .crm-home-preview");
    const raster = host?.querySelector?.(":scope > .crm-home-preview-exact");
    stage.lid = lid;
    stage.coverHost = host;
    stage.coverRaster = raster;
    if (!lid || !host || !raster) return false;
    if (!raster.complete || raster.naturalWidth <= 0) {
      try { await raster.decode?.(); } catch {}
    }
    if (stage.sequence !== activeDive?.sequence) return false;
    host.style.transition = "none";
    host.style.opacity = "1";
    lid.classList.add("crm-home-endpoint-cover");
    stage.phase = "seating-cover";
    // The exact image was decoded while the expander was built. Give its
    // compositor surface two complete endpoint paints before any destination
    // ownership changes occur.
    await paint(2);
    if (stage.sequence !== activeDive?.sequence) return false;
    stage.coverStart = inspectRasterCover(stage);
    stage.coverSeatedAt = performance.now();
    stage.coverInvariant = stage.coverStart.ready;
    stage.phase = "covered";
    await holdProbePhase(stage, "covered");
    // The two seating paints above already close a clean raster-owned refresh
    // interval before live-room ownership work begins.
    if (stage.sequence !== activeDive?.sequence) return false;
    return stage.coverInvariant;
  };

  const armDestinationReveal = (stage) => {
    if (!stage || stage.revealArmed || !stage.ready || !Number.isFinite(stage.motionStartedAt)) return false;
    stage.revealArmed = true;
    stage.revealPromise = (async () => {
      if (stage.sequence !== activeDive?.sequence) return;
      stage.coverBeforeSwap = inspectRasterCover(stage);
      stage.coverInvariant = sameRasterCover(stage, stage.coverStart, stage.coverBeforeSwap);
      const liveLayers = stage.finalDestinationLayers || [];
      stage.liveLayersBeforeSwap = liveLayerState(liveLayers);
      stage.preSwapLiveReady = liveLayers.length > 0
        && stage.settledState?.stable === true
        && stage.liveLayersBeforeSwap.every((layer) =>
          layer.display !== "none" && layer.visibility !== "hidden"
          && layer.opacity === 1);
      stage.liveReady = stage.preSwapLiveReady;
      stage.liveReadyAt = performance.now();
      stage.phase = "live-ready-covered";
      await holdProbePhase(stage, "before-swap");
      if (stage.sequence !== activeDive?.sequence) return;
      if (!stage.coverInvariant) {
        throw new Error("Endpoint raster changed while the destination was settling");
      }
      if (!stage.preSwapLiveReady) {
        throw new Error("Destination did not reach stable natural geometry under its endpoint cover");
      }

      // The active room, its natural display ownership, and all temporary
      // transit attributes were finalized before this function was armed.
      // Re-read that already-resting tree without changing it. From here to
      // arrival the exact endpoint raster's opacity is the sole moving value.
      stage.liveLayersAfterSwap = liveLayerState(liveLayers);
      stage.postSwapLiveReady = liveLayers.length > 0
        && stage.liveLayersAfterSwap.every((layer) =>
          layer.display !== "none" && layer.visibility !== "hidden" && layer.opacity === 1);
      stage.liveReady = stage.preSwapLiveReady && stage.postSwapLiveReady;
      stage.phase = "crossfade-ready";
      await holdProbePhase(stage, "crossfade-ready");
      if (stage.sequence !== activeDive?.sequence) return;
      if (!stage.postSwapLiveReady) {
        throw new Error("Destination compositor was not opaque before endpoint release");
      }

      const host = stage.coverHost;
      if (!host) throw new Error("Exact endpoint raster host is unavailable");
      stage.releaseAt = performance.now();
      stage.phase = "crossfading";
      ownershipFadeState = {
        active:true,
        startedAt:stage.releaseAt,
        endedAt:0,
        duration:STATIC_CROSSFADE_MS,
        sequence:ownershipFadeState.sequence + 1,
      };
      document.dispatchEvent(new CustomEvent("crm:desk-ownership-fade", {
        detail:{ phase:"start", ...ownershipFadeState },
      }));
      stage.coverAnimation = host.animate(
        [{ opacity:1 }, { opacity:0 }],
        { duration:STATIC_CROSSFADE_MS, easing:"linear", fill:"both" },
      );

      // The held visual-equivalence pass pauses only this already-static
      // compositor animation at its midpoint so Playwright can prove the
      // intermediate pixels are a bounded blend rather than a flash.
      if (typeof window.__crmDeskTransitProbe?.hold === "function") {
        await new Promise((resolve) => {
          const sample = async () => {
            const current = Number(stage.coverAnimation?.currentTime) || 0;
            if (current >= STATIC_CROSSFADE_MS / 2 || stage.coverAnimation?.playState === "finished") {
              stage.coverAnimation?.pause?.();
              stage.phase = "crossfade-mid";
              await holdProbePhase(stage, "crossfade-mid");
              stage.phase = "crossfading";
              stage.coverAnimation?.play?.();
              resolve();
              return;
            }
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
      }
      try { await stage.coverAnimation.finished; } catch {}
      if (stage.sequence !== activeDive?.sequence) return;
      host.style.transition = "none";
      host.style.opacity = "0";
      stage.coverAnimation?.cancel?.();
      stage.coverAnimation = null;
      stage.swappedAt = performance.now();
      stage.phase = "swapped";
      ownershipFadeState = {
        ...ownershipFadeState,
        active:false,
        endedAt:stage.swappedAt,
      };
      document.dispatchEvent(new CustomEvent("crm:desk-ownership-fade", {
        detail:{ phase:"end", ...ownershipFadeState },
      }));
      await paint(1);
      if (stage.sequence !== activeDive?.sequence) return;
      stage.revealedAt = performance.now();
      stage.coverAfterSwap = inspectRasterCover(stage);
      stage.phase = "live";
      await holdProbePhase(stage, "after-swap");
    })().catch((error) => {
      stage.revealError = String(error?.message || error || "destination reveal failed");
    }).finally(() => {
      stage.resolveReveal?.();
      stage.resolveReveal = null;
    });
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
      // Keep the completed room painted, but park its compositor group one
      // viewport offstage during the camera move. This avoids sharing the
      // visible GPU pass while preserving the exact texture for the endpoint.
      theater.setAttribute("data-crm-transit-retained", "");
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
    stage.materializeAt = performance.now();
    stage.phase = "materializing-covered";
    stage.theater?.removeAttribute?.("data-crm-transit-retained");
    primeDestinationLayers(stage.key, stage.theater || findDestinationTheater(stage.key));
    document.documentElement.classList.remove("crm-transit-revealing");
    document.documentElement.classList.add("crm-transit-materializing");
    stageDestinationLayers(stage.key, destinationRoot);
    // The exact raster remains the sole visible owner while the retained room
    // reacquires its compositor surface at .001. These are two unchanged
    // live-ready paints, not part of the camera's exposed motion cadence.
    await paint(2);
    if (stage.sequence !== activeDive?.sequence) return;
    stage.readyAt = performance.now();
    stage.ready = true;
  };

  const settleDiveDestination = async (stage) => {
    if (!stage || stage.sequence !== activeDive?.sequence) return false;

    // Activation can start a destination's dirty-data refresh. Commit and run
    // its awaited baseline while the decoded Home raster is still the only
    // visible owner, so neither a first mount nor an async rebuild can land
    // after arrival.
    if (!stage.committed) {
      stage.commitAt = performance.now();
      commit(stage.key);
      stage.committedAt = performance.now();
      stage.committed = true;
    }
    try {
      await destinationFor(stage.key)?.baseline?.({
        canRender:() => stage.sequence === activeDive?.sequence,
      });
    } catch {}
    if (stage.sequence !== activeDive?.sequence) return false;

    const theater = findDestinationTheater(stage.key) || stage.theater;
    if (theater && theater !== destinationRoot) {
      primeDestinationLayers(stage.key, theater);
      document.documentElement.classList.add("crm-transit-materializing");
    }
    stage.theater = theater;
    stageDestinationLayers(stage.key, theater);

    // First promote the complete destination under the opaque raster. Then
    // remove every transit-owned display/grouping/class attribute and measure
    // the natural resting tree. The cover remains unchanged for all of it.
    document.documentElement.classList.add("crm-transit-revealing");
    stage.phase = "live-opaque-covered";
    stage.liveOpaqueAt = performance.now();
    // One committed paint seats the promoted compositor; the natural resting
    // tree is then independently required to remain unchanged for three more.
    await paint(1);
    if (stage.sequence !== activeDive?.sequence) return false;

    stage.finalDestinationLayers = [...destinationLayers];
    document.documentElement.classList.remove("crm-transit-materializing", "crm-transit-revealing");
    clearDestinationLayers();
    stage.phase = "settling-covered";
    let geometryState = null;
    let moduleState = null;
    const destinationApi = destinationFor(stage.key);
    const geometryWaiter = typeof destinationApi?.waitForGeometrySettled === "function"
      ? () => destinationApi.waitForGeometrySettled()
      : () => Promise.resolve({ stable:true, applicable:false });
    for (let attempt = 0; attempt < 3 && stage.sequence === activeDive?.sequence; attempt += 1) {
      try {
        [geometryState, moduleState] = await Promise.all([
          geometryWaiter(),
          window.crmHome?.waitForModuleSettled?.(stage.key),
        ]);
      } catch {}
      if (geometryState?.stable === true && moduleState?.stable === true) break;
    }
    stage.geometryState = geometryState;
    stage.settledState = {
      ...(moduleState || {}),
      stable:geometryState?.stable === true && moduleState?.stable === true,
      geometryStable:geometryState?.stable === true,
      moduleStable:moduleState?.stable === true,
    };
    if (stage.sequence !== activeDive?.sequence) return false;
    // Both samplers above resolve only after repeated unchanged refreshes, so the
    // final compositor paint is already closed when they return.
    if (stage.sequence !== activeDive?.sequence) return false;
    stage.coverAfterSettlement = inspectRasterCover(stage);
    stage.coverInvariant = stage.coverInvariant !== false
      && sameRasterCover(stage, stage.coverStart, stage.coverAfterSettlement);
    return stage.settledState?.stable === true;
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
      phase:"preparing",
      coverInvariant:null,
      liveReady:false,
    };
    activeDive = stage;
    stage.preparePromise = prepareDiveDestination(stage);
    return stage;
  };

  const noteHomeTransformStart = (direction, startedAt = performance.now(), morphMs = 460) => {
    const start = Number(startedAt) || performance.now();
    homeMotionState = {
      active:true,
      direction:String(direction || ""),
      startedAt:start,
      endedAt:0,
      sequence:homeMotionState.sequence + 1,
    };
    document.dispatchEvent(new CustomEvent("crm:home-transform-phase", {
      detail:{ phase:"start", ...homeMotionState },
    }));
    if (direction !== "expand" || !activeDive || Number.isFinite(activeDive.motionStartedAt)) return true;
    activeDive.motionStartedAt = start;
    activeDive.morphMs = Math.max(1, Number(morphMs) || 460);
    return true;
  };
  const noteHomeTransformEnd = (direction, endedAt = performance.now()) => {
    const end = Number(endedAt) || performance.now();
    homeMotionState = {
      ...homeMotionState,
      active:false,
      direction:String(direction || homeMotionState.direction || ""),
      endedAt:end,
    };
    if (direction === "expand" && activeDive && !Number.isFinite(activeDive.motionEndedAt)) {
      activeDive.motionEndedAt = end;
    }
    document.dispatchEvent(new CustomEvent("crm:home-transform-phase", {
      detail:{ phase:"end", ...homeMotionState },
    }));
    return true;
  };

  // The camera reaches its exact endpoint first. Seat the decoded exact room
  // raster, commit and fully settle the live destination beneath those
  // unchanged pixels, and only then exchange visual ownership.
  const finishDiveIn = async (key, done, stage) => {
    const cam = camera();
    const surface = cam?.surface?.();
    try { await stage?.preparePromise; } catch {}
    if (!Number.isFinite(stage.motionStartedAt)) {
      stage.motionStartedAt = performance.now() - stage.morphMs;
    }
    if (!Number.isFinite(stage.motionEndedAt)) stage.motionEndedAt = performance.now();
    // First close the final moving refresh interval. Endpoint preparation may
    // be expensive, but from this point forward the viewport is deliberately
    // static and every task remains under a decoded raster owner.
    await paint(1);
    if (stage.sequence !== activeDive?.sequence) return;
    stage.maintenanceStartedAt = performance.now();
    try { await seatEndpointRaster(stage); } catch {}
    try { await materializeDiveDestination(stage); } catch {}
    if (!stage.ready) { stage.ready = true; stage.readyAt = performance.now(); }
    try { await settleDiveDestination(stage); } catch {}
    armDestinationReveal(stage);
    try { await stage.revealPromise; } catch {}
    if (stage.revealError || !stage.liveReady) {
      // Fail closed, then recover through the same canonical camera instead of
      // freezing the viewport or dropping the cover. The opaque room raster
      // contracts back into its Home tile while Home is restored beneath it.
      document.dispatchEvent(new CustomEvent("crm:desk-transit-error", {
        detail:{ key, phase:stage.phase, error:stage.revealError || "destination not ready" },
      }));
      stage.phase = "recovering-home";
      stage.coverAnimation?.cancel?.();
      stage.coverAnimation = null;
      if (stage.coverHost) {
        stage.coverHost.style.transition = "none";
        stage.coverHost.style.opacity = "1";
      }
      commit("home");
      if (surface) {
        surface.hidden = false;
        surface.style.zIndex = TRANSIT_Z;
      }
      try {
        if (cam?.level?.() >= 1 && !cam?.isTransitioning?.()) {
          cam.back();
          await cam.whenSettled?.();
          await window.crmHome?.waitForHandoff?.();
        } else if (cam?.restoreRoot) cam.restoreRoot();
        else cam?.rebuildRoot?.();
      } catch {
        if (cam?.restoreRoot) cam.restoreRoot();
        else cam?.rebuildRoot?.();
      }
      if (surface) surface.style.zIndex = "";
      if (activeDive?.sequence === stage.sequence) activeDive = null;
      done(false);
      return;
    }

    // The fade above was the only visible endpoint action. Everything below
    // is retirement of the now-transparent Home cover; the destination tree
    // and its final styling are deliberately left untouched.
    const lid = cam?.level?.() >= 1 ? cam.layers()[1] : null;
    if (cam?.restoreRoot) cam.restoreRoot();
    else cam?.rebuildRoot?.();
    try { window.crmHome?.recycleExpander?.(key, lid); } catch {}
    if (surface) {
      surface.hidden = true;
      surface.style.zIndex = "";
    }
    stage.coverAnimation?.cancel?.();
    stage.coverAnimation = null;
    if (ownershipFadeState.active) {
      ownershipFadeState = { ...ownershipFadeState, active:false, endedAt:performance.now() };
    }
    const doneAt = performance.now();
    performanceTimings.push({
      key,
      destinationState:stage.destinationState,
      homePrewarm:stage.homePrewarm,
      settled:stage.settledState?.stable === true,
      motionMs:(stage.motionEndedAt || stage.maintenanceStartedAt || doneAt) - stage.motionStartedAt,
      maintenanceMs:doneAt - (stage.maintenanceStartedAt || stage.motionEndedAt || doneAt),
      coverSeatMs:(stage.coverSeatedAt || doneAt) - (stage.maintenanceStartedAt || stage.motionEndedAt || doneAt),
      materializeMs:(stage.readyAt || doneAt) - (stage.materializeAt || stage.readyAt || doneAt),
      coveredSwapMs:(stage.revealedAt || doneAt) - (stage.liveReadyAt || stage.readyAt || doneAt),
      crossfadeMs:(stage.swappedAt || doneAt) - (stage.releaseAt || doneAt),
      crossfadeDuration:STATIC_CROSSFADE_MS,
      commitMs:(stage.committedAt || stage.commitAt || doneAt) - (stage.commitAt || stage.startedAt),
      readyMs:(stage.readyAt || doneAt) - stage.startedAt,
      frameWaitMs:Math.max(0, (stage.releaseAt || doneAt) - (stage.readyAt || doneAt)),
      releaseMs:(stage.revealedAt || doneAt) - (stage.releaseAt || doneAt),
      coverInvariant:stage.coverInvariant === true,
      liveReady:stage.liveReady === true,
      coverStart:stage.coverStart || null,
      coverBeforeSwap:stage.coverBeforeSwap || null,
      coverAfterSwap:stage.coverAfterSwap || null,
      liveLayersBeforeSwap:stage.liveLayersBeforeSwap || [],
      liveLayersAfterSwap:stage.liveLayersAfterSwap || [],
      preSwapLiveReady:stage.preSwapLiveReady === true,
      postSwapLiveReady:stage.postSwapLiveReady === true,
      revealError:stage.revealError || "",
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
    try { window.crmHomePreviews?.setInteraction?.(true, "desk-transit"); } catch {}
    announceNavigationHistory();
    const done = (success = true) => {
      busy = false;
      try { window.crmHomePreviews?.setInteraction?.(false, "desk-transit"); } catch {}
      if (recordHistory) commitCurrentViewport(); else announceNavigationHistory();
      resolve(success);
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
    try { window.crmHomePreviews?.setInteraction?.(true, "desk-transit"); } catch {}
    announceNavigationHistory();
    const surface = camera()?.surface?.();
    if (surface) surface.style.zIndex = TRANSIT_Z;
    const stage = beginDiveDestination(key);
    const done = (success = true) => {
      busy = false;
      try { window.crmHomePreviews?.setInteraction?.(false, "desk-transit"); } catch {}
      commitCurrentViewport();
      resolve(success);
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
    if (document.querySelector(".ticket-detail-overlay:not([hidden]), .tk-menu, #context-add-menu:not([hidden])")) return true;
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
    noteHomeTransformEnd,
    motionState:() => ({ ...homeMotionState }),
    ownershipFadeState:() => ({ ...ownershipFadeState }),
    visualState:() => ({
      active:homeMotionState.active || ownershipFadeState.active,
      cameraActive:homeMotionState.active,
      ownershipActive:ownershipFadeState.active,
      camera:{ ...homeMotionState },
      ownership:{ ...ownershipFadeState },
    }),
    coverState:() => activeDive ? {
      key:activeDive.key,
      sequence:activeDive.sequence,
      phase:activeDive.phase,
      coverInvariant:activeDive.coverInvariant !== false,
      rasterReady:activeDive.coverStart?.ready === true,
      rasterOpaque:activeDive.coverStart?.ready === true
        && !["crossfading", "crossfade-mid", "swapped", "live"].includes(activeDive.phase),
      liveReady:activeDive.liveReady === true,
      motionEndedAt:activeDive.motionEndedAt || 0,
      maintenanceStartedAt:activeDive.maintenanceStartedAt || 0,
      coverSeatedAt:activeDive.coverSeatedAt || 0,
      readyAt:activeDive.readyAt || 0,
      swappedAt:activeDive.swappedAt || 0,
    } : null,
    back:() => moveThroughHistory(-1),
    forward:() => moveThroughHistory(1),
    canGoBack:() => navigationStatus().canBack,
    canGoForward:() => navigationStatus().canForward,
    historyState:navigationStatus,
    noteViewportDeparture,
    noteViewportArrival,
    zoomOutToCalendar,
    temporalModules: () => [...TEMPORAL_MODULES],
    canSettleGeometry: (key = "") => {
      const target = String(key) === "tickets" ? "cases" : String(key);
      return !!activeDive
        && activeDive.key === target
        && activeDive.coverStart?.ready === true
        && !["crossfading", "crossfade-mid", "swapped", "live"].includes(activeDive.phase);
    },
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
