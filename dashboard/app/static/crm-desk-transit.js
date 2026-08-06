// crm-desk-transit.js - the desk's one navigation choreographer (BLUEPRINT A1).
// The Desk is a single continuous place and the camera is how you move through
// it: every module switch is a dive through the Home bucket lids, never a cut.
// This module is a motion coordinator, not a new UI species — it drives the
// existing home fractal camera (expand/contract) and lets crm-workspaces'
// setActive remain the instant commit primitive, called only at choreography
// boundaries (and at boot/restore, which is not navigation).
(() => {
  const TEMPORAL_MODULES = new Set(["pipeline", "jobs", "cases"]);
  const TRANSIT_Z = "4500";        // above room objects, below persistent native chrome
  const ENDPOINT_BRIDGE_Z = "9500"; // above all room furniture, below transit-owned persistent chrome
  const TRANSIT_CHROME_Z = "9600";
  const ENDPOINT_MATERIAL_BLEND_MS = 180;
  const ENDPOINT_MATERIAL_LEAD_MS = 220;
  const ENDPOINT_MATERIAL_BLEND_EASE = "cubic-bezier(.4, 0, .2, 1)";
  const NAVIGATION_ENTRANCE_MS = 210;
  const NAVIGATION_ENTRANCE_LEAD_MS = 260;
  const NAVIGATION_ENTRANCE_EASE = "cubic-bezier(.16, 1, .3, 1)";
  const STATIC_CROSSFADE_MS = 120;
  const ENDPOINT_UNOCCLUDE_OPACITY = .99;
  const ENDPOINT_PARKED_OPACITY = .001;
  const ACRYLIC_WARM_FRAMES = 8;

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
  let persistentEndpointBridge = null;
  let endpointBridgeLoadSequence = 0;
  let endpointBridgeLoadIdentity = "";
  let endpointBridgeLoadPromise = null;

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
      /* Room navigation enters from below the viewport during the final part
         of the camera landing. It remains semantically hidden and inert while
         entering, but no longer pops in after the room settles. */
      .crm-module-switch[hidden]:not([data-crm-transit-nav-entering]){
        display:grid!important;opacity:1!important;
        transform:translateX(-50%) translateY(calc(100% + 36px)) translateZ(0)!important;
        pointer-events:none!important;will-change:transform}
      .crm-module-switch[data-crm-transit-nav-entering][hidden]{
        display:grid!important;opacity:1!important}
      .crm-module-switch[data-crm-transit-nav-entering]{
        z-index:${TRANSIT_CHROME_Z}!important;
        pointer-events:none!important;will-change:transform}
      html.crm-transit-materializing .crm-module-switch[data-crm-transit-layer][data-crm-transit-nav-entering]{
        opacity:1!important}
      html.crm-transit-materializing.crm-transit-revealing [data-crm-transit-layer]{
        opacity:var(--crm-transit-rest-opacity,1)!important;
        transition:none!important}
      /* Workspace activation keeps its semantic [hidden] ownership, while the
         endpoint expander remains the one visible Home child above the room
         being settled. This also covers a first launch with no capture image. */
      .crm-home-surface[data-crm-transit-cover][hidden]{
        display:block!important;visibility:visible!important;pointer-events:none!important;
        z-index:${TRANSIT_Z}!important}
      .crm-home-surface[data-crm-transit-cover][hidden]>.crm-home-level{
        visibility:hidden!important}
      .crm-home-surface[data-crm-transit-cover][hidden]>.crm-home-expander{
        visibility:visible!important}
      /* A first-run browser/Electron session may not have decoded the exact
         room capture yet. Its fallback is a real opaque copy of the unchanged
         workspace backdrop with the canonical neutral bucket tint—not the
         transparent expander box previously mislabeled as a cover. */
      .crm-home-endpoint-fallback{
        position:absolute;inset:0;z-index:3;display:block;overflow:hidden;
        pointer-events:none;opacity:1;background:var(--page-background) fixed;
        background-color:var(--bg,rgba(10,15,23,1));transform:translateZ(0);
        backface-visibility:hidden;will-change:opacity}
      .crm-home-endpoint-fallback>.workspace-photo-backdrop{
        position:absolute!important;inset:0!important;z-index:0!important;
        display:block!important;visibility:visible!important;pointer-events:none!important}
      .crm-home-endpoint-fallback-acrylic{
        position:absolute;inset:0;z-index:1;display:block;pointer-events:none;
        background:linear-gradient(180deg,rgba(52,59,70,.16),rgba(27,32,40,.12));
        box-shadow:inset 0 1px 0 rgba(255,255,255,.08)}
      /* Once the camera has reached the viewport, transfer its exact decoded
         endpoint to a body-level bridge. The source camera can then retire to
         its real inactive z-order while these unchanged pixels continue to
         cover the destination's backdrop-filter warm-up. */
      .crm-home-endpoint-bridge{
        position:fixed;inset:0;z-index:${ENDPOINT_BRIDGE_Z};display:block;overflow:hidden;
        width:100vw;height:100vh;pointer-events:none;opacity:${ENDPOINT_PARKED_OPACITY};
        background:var(--page-background);transform:translateZ(0);
        backface-visibility:hidden;will-change:opacity}
      .crm-home-endpoint-bridge-raster{
        position:absolute;inset:0;display:block;width:100%;height:100%;
        object-fit:cover;pointer-events:none;user-select:none;opacity:1;
        transform:translateZ(0);backface-visibility:hidden}
      /* The endpoint bridge sits above room furniture without rewriting the
         room's complete layer tree. Only the small persistent chrome set is
         raised over it while the bridge owns the viewport. */
      html.crm-transit-endpoint-covered :is(
        .window-control-cluster,.auth-profile-cluster,.dashboard-search-popover,
        .workspace-menu-overlay-layer
      ){z-index:${TRANSIT_CHROME_Z}!important}
      [data-crm-transit-retained]{transform:translate3d(-110vw,0,0)!important;pointer-events:none!important}
    `;
    document.head.appendChild(style);
  };

  const camera = () => window.crmHomeCamera;
  const commit = (key) => window.crmWorkspaces?.setActive?.(key);
  const commitStaged = async (key) => {
    if (typeof window.crmWorkspaces?.setActiveStaged === "function") {
      return window.crmWorkspaces.setActiveStaged(key);
    }
    return commit(key);
  };
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
    calendar: window.fractalCalendar,
    monitoring: window.crmMonitoring,
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
    const focusedPrecompose = destinationRoot?.dataset?.crmHomeFocusedPrecompose === "true";
    if (!focusedPrecompose) destinationRoot?.removeAttribute?.("data-crm-home-precomposed");
    if (focusedPrecompose) {
      if (document.body.dataset.crmModule === "home") {
        destinationRoot.hidden = true;
        destinationRoot.setAttribute("aria-hidden", "true");
      } else {
        destinationRoot.hidden = false;
        destinationRoot.removeAttribute("aria-hidden");
      }
    }
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
    const ownsSharedAcrylic = !!document.querySelector(
      `[data-crm-acrylic-owner="${key}"]`,
    );
    if (ownsSharedAcrylic) {
      // The shared card-system plane is already a canonical, precomposed
      // compositor owner. Keep its display:contents theater only as a
      // readiness sentinel; tagging it as a CSS opacity layer invalidates the
      // complete 1k+ descendant tree twice beneath an already-opaque raster.
      destinationLayers.push(theater);
      addDestinationLayer(document.querySelector(".crm-module-switch"));
      return destinationLayers;
    }
    destinationRoot.setAttribute("data-crm-transit-destination", "");
    if (!ownsSharedAcrylic
      && (destinationRoot.matches(".crm-theater,[data-crm-home-precomposed]")
        || getComputedStyle(destinationRoot).display === "contents")) {
      destinationRoot.setAttribute("data-crm-transit-group", "");
    }
    addDestinationLayer(theater);
    addDestinationLayer(document.querySelector(".crm-module-switch"));
    return destinationLayers;
  };
  const stageDestinationLayers = (key, theater = findDestinationTheater(key)) => {
    if (!theater) return destinationLayers;
    // A room with its own shared screen-space acrylic owner is already
    // precomposed through its canonical display:contents topology. Its direct
    // children must not receive temporary layer attributes: doing so both
    // changes their parked-opacity baseline and invalidates the complete card
    // tree. The theater plus native navigation remain sufficient ownership
    // sentinels for the covered handoff.
    if (document.querySelector(`[data-crm-acrylic-owner="${key}"]`)) {
      return destinationLayers;
    }
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
  const coverSourceOf = (node) => {
    if (!node) return "";
    if (node instanceof HTMLImageElement) return node.currentSrc || node.src || "";
    const style = getComputedStyle(node);
    return [
      node.tagName,
      node.className,
      style.backgroundColor,
      style.backgroundImage,
      style.backdropFilter,
      style.webkitBackdropFilter,
      style.borderColor,
      style.boxShadow,
    ].join("|");
  };
  const inspectRasterCover = (stage) => {
    const cam = camera();
    const lid = stage?.lid || (cam?.level?.() >= 1 ? cam.layers()[1] : null);
    const host = stage?.coverHost || lid?.querySelector?.(":scope > .crm-home-preview");
    const raster = stage?.coverRaster?.isConnected
      ? stage.coverRaster
      : host?.querySelector?.(":scope > .crm-home-preview-exact, :scope > .crm-home-preview-foreground");
    if (!lid || !host || !raster) {
      return {
        ready:false,
        nodeId:rasterIdentity(raster),
        mode:stage?.coverMode || lid?.dataset?.crmEndpointCover || "",
        frame:lid?.dataset?.fractalFrame || "",
        viewport:{ width:innerWidth, height:innerHeight },
      };
    }
    const bridgeOwned = stage?.coverBridge === host && host.isConnected;
    if (bridgeOwned) {
      const animatedOpacity = (animation, from, to) => {
        if (!animation) return null;
        const progress = Number(animation.effect?.getComputedTiming?.().progress);
        return Number.isFinite(progress) ? from + (to - from) * progress : null;
      };
      const liveOpacity = animatedOpacity(
        stage.coverAnimation,
        ENDPOINT_UNOCCLUDE_OPACITY,
        ENDPOINT_PARKED_OPACITY,
      ) ?? animatedOpacity(stage.endpointBlendAnimation, ENDPOINT_PARKED_OPACITY, 1)
        ?? Number(host.style.opacity || 1);
      const imageRaster = raster instanceof HTMLImageElement;
      const complete = imageRaster ? !!raster.complete : true;
      const naturalWidth = imageRaster ? raster.naturalWidth || 0 : innerWidth;
      const naturalHeight = imageRaster ? raster.naturalHeight || 0 : innerHeight;
      const source = stage?.coverSource
        || (imageRaster ? (raster.currentSrc || raster.src) : coverSourceOf(raster));
      const signature = {
        ready:complete && naturalWidth > 0 && naturalHeight > 0
          && host.isConnected && raster.isConnected,
        nodeId:rasterIdentity(raster),
        mode:stage?.coverMode || lid.dataset.fractalFrame || "",
        source:compactSource(source),
        complete,
        naturalWidth,
        naturalHeight,
        rect:{ x:0, y:0, width:innerWidth, height:innerHeight },
        opacity:1,
        hostOpacity:roundGeometry(liveOpacity),
        display:"block",
        visibility:"visible",
        frame:"viewport",
        lidStyle:{ left:"", top:"", width:"", height:"", transform:"", opacity:"" },
        viewport:{ width:innerWidth, height:innerHeight },
      };
      stage.lid = lid;
      stage.coverHost = host;
      stage.coverRaster = raster;
      stage.coverSource = source;
      return signature;
    }
    const source = coverSourceOf(raster);
    const rect = raster.getBoundingClientRect();
    const rasterStyle = getComputedStyle(raster);
    const hostStyle = getComputedStyle(host);
    const lidStyle = lid.style;
    const imageRaster = raster instanceof HTMLImageElement;
    const complete = imageRaster ? !!raster.complete : true;
    const naturalWidth = imageRaster ? raster.naturalWidth || 0 : Math.round(rect.width);
    const naturalHeight = imageRaster ? raster.naturalHeight || 0 : Math.round(rect.height);
    const signature = {
      ready:complete && naturalWidth > 0 && naturalHeight > 0
        && rect.width >= innerWidth - 1 && rect.height >= innerHeight - 1,
      nodeId:rasterIdentity(raster),
      mode:stage?.coverMode || lid.dataset.crmEndpointCover || "",
      source:compactSource(source),
      complete,
      naturalWidth,
      naturalHeight,
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
        left:lidStyle?.left || "",
        top:lidStyle?.top || "",
        width:lidStyle?.width || "",
        height:lidStyle?.height || "",
        transform:lidStyle?.transform || "",
        opacity:lidStyle?.opacity || "",
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
    && before.mode === after.mode
    && stage?.coverRaster?.isConnected
    && (stage?.coverMode === "surface"
      ? stage.coverRaster === stage.lid && stage.coverHost === stage.lid
      : stage?.coverRaster?.parentElement === stage?.coverHost)
    && stage?.coverSource === coverSourceOf(stage?.coverRaster)
    && before.source.length === after.source.length
    && before.source.head === after.source.head
    && before.source.tail === after.source.tail
    && before.naturalWidth === after.naturalWidth
    && before.naturalHeight === after.naturalHeight
    && sameGeometry(before.rect, after.rect)
    && before.opacity === 1 && after.opacity === 1
    && before.hostOpacity >= ENDPOINT_UNOCCLUDE_OPACITY
    && after.hostOpacity >= ENDPOINT_UNOCCLUDE_OPACITY
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
  const destinationAcrylicState = (stage) => {
    const root = stage?.theater || findDestinationTheater(stage?.key);
    const marked = root
      ? [...document.querySelectorAll(
        `[data-crm-acrylic-owner="${stage?.key || ""}"]`,
      )].filter((node) => node?.isConnected)
      : [];
    const candidates = stage?.acrylicCandidates?.filter?.((node) => node?.isConnected)
      || (root
        ? (marked.length
          ? marked
          : [root, ...root.querySelectorAll(
            ".tk-zone-acrylic-plane,.tk-zone-hacrylic-lens,.tk-zone,"
              + ".crm-planner-bucket,.crm-project-bucket,.crm-menu-surface",
          )])
        : []);
    if (stage) stage.acrylicCandidates = candidates;
    const owners = [];
    candidates.forEach((node) => {
      if (!node?.isConnected) return false;
      const style = getComputedStyle(node);
      const filter = style.webkitBackdropFilter || style.backdropFilter || "";
      const rect = node.getBoundingClientRect();
      if (!filter || filter === "none" || /blur\(\s*0(?:px)?\s*\)/i.test(filter)) return;
      if (!(rect.width > 2 && rect.height > 2
        && rect.right > 0 && rect.bottom > 0
        && rect.left < innerWidth && rect.top < innerHeight
        && style.display !== "none" && style.visibility === "visible"
        && Number(style.opacity) > .99)) return;
      owners.push({
        className:String(node.className || ""),
        filter,
        opacity:roundGeometry(style.opacity),
        rect:[
          roundGeometry(rect.x),
          roundGeometry(rect.y),
          roundGeometry(rect.width),
          roundGeometry(rect.height),
        ],
      });
    });
    return {
      ownerCount:owners.length,
      owners,
      signature:JSON.stringify(owners),
    };
  };
  const waitForDestinationAcrylic = async (stage) => {
    // Geometry and module settlement have already completed under the endpoint
    // cover. Let the compositor close a finite run of untouched paints, then
    // inspect the final owner set once. Re-reading computed style and layout for
    // every bucket on every frame was itself the largest endpoint stall.
    let frames = 0;
    for (; frames < ACRYLIC_WARM_FRAMES
      && stage?.sequence === activeDive?.sequence; frames += 1) {
      await paint(1);
    }
    const snapshot = destinationAcrylicState(stage);
    const stable = frames >= ACRYLIC_WARM_FRAMES && snapshot.ownerCount > 0;
    return {
      ...snapshot,
      frames,
      stableFrames:stable ? frames : 0,
      stable,
    };
  };
  const phaseDetail = (stage, phase) => ({
    key:stage?.key || "",
    sequence:stage?.sequence || 0,
    phase,
    coverInvariant:stage?.coverInvariant !== false,
    cover:inspectRasterCover(stage),
    liveReady:!!stage?.liveReady,
    sourceRetired:stage?.sourceRetired === true,
    acrylicUnderpaintExposed:stage?.acrylicUnderpaintExposed === true,
    acrylicStable:stage?.acrylicState?.stable === true,
    acrylicOwners:stage?.acrylicState?.ownerCount || 0,
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

  const buildFallbackCover = (host) => {
    if (!host) return null;
    host.querySelector(":scope > .crm-home-endpoint-fallback")?.remove();
    const fallback = document.createElement("div");
    fallback.className = "crm-home-endpoint-fallback";
    fallback.setAttribute("aria-hidden", "true");
    fallback.style.width = `${innerWidth}px`;
    fallback.style.height = `${innerHeight}px`;
    const rootStyle = getComputedStyle(document.documentElement);
    const bodyStyle = getComputedStyle(document.body);
    const backgroundStyle = rootStyle.backgroundImage !== "none" ? rootStyle : bodyStyle;
    fallback.style.backgroundImage = backgroundStyle.backgroundImage;
    fallback.style.backgroundColor = rootStyle.backgroundColor !== "rgba(0, 0, 0, 0)"
      ? rootStyle.backgroundColor
      : bodyStyle.backgroundColor;
    fallback.style.backgroundPosition = backgroundStyle.backgroundPosition;
    fallback.style.backgroundSize = backgroundStyle.backgroundSize;
    fallback.style.backgroundRepeat = backgroundStyle.backgroundRepeat;
    const backdrop = document.querySelector("body > .workspace-photo-backdrop");
    if (backdrop) {
      const copy = backdrop.cloneNode(true);
      copy.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
      fallback.appendChild(copy);
    }
    const acrylic = document.createElement("span");
    acrylic.className = "crm-home-endpoint-fallback-acrylic";
    fallback.appendChild(acrylic);
    host.appendChild(fallback);
    return fallback;
  };

  const ensureEndpointBridge = () => {
    if (persistentEndpointBridge?.isConnected) return persistentEndpointBridge;
    const existing = document.querySelector("body > .crm-home-endpoint-bridge[data-crm-persistent-bridge]");
    if (existing) {
      persistentEndpointBridge = existing;
      return existing;
    }
    const bridge = document.createElement("div");
    bridge.className = "crm-home-endpoint-bridge";
    bridge.setAttribute("aria-hidden", "true");
    bridge.setAttribute("data-crm-persistent-bridge", "");
    bridge.dataset.crmEndpointBridge = "parked";
    bridge.style.transition = "none";
    bridge.style.opacity = String(ENDPOINT_PARKED_OPACITY);
    const image = document.createElement("img");
    image.className = "crm-home-endpoint-bridge-raster";
    image.alt = "";
    image.draggable = false;
    image.decoding = "sync";
    bridge.appendChild(image);
    document.body.appendChild(bridge);
    persistentEndpointBridge = bridge;
    return bridge;
  };

  const parkEndpointBridge = (bridge = persistentEndpointBridge) => {
    if (!bridge?.isConnected) return;
    bridge.getAnimations?.().forEach((animation) => animation.cancel());
    bridge.style.transition = "none";
    bridge.style.opacity = String(ENDPOINT_PARKED_OPACITY);
    bridge.dataset.crmEndpointBridge = "parked";
  };

  const endpointImageIdentity = (source, key = "", capturedAt = "") => {
    const value = String(source || "");
    return `${key}|${capturedAt}|${value.length}|${value.slice(-24)}`;
  };

  const loadEndpointBridgeImage = (source, {
    key = "",
    capturedAt = "",
    mode = "exact",
  } = {}) => {
    const value = String(source || "");
    if (!value) return Promise.resolve(null);
    const bridge = ensureEndpointBridge();
    const identity = endpointImageIdentity(value, key, capturedAt);
    const existing = bridge.querySelector(":scope > img.crm-home-endpoint-bridge-raster");
    if (bridge.dataset.crmEndpointIdentity === identity
      && bridge.dataset.crmEndpointRasterReady === "true"
      && existing?.complete
      && existing.naturalWidth > 0) {
      parkEndpointBridge(bridge);
      bridge.dataset.crmEndpointBridge = mode;
      return Promise.resolve({ bridge, raster:existing });
    }
    if (endpointBridgeLoadIdentity === identity && endpointBridgeLoadPromise) {
      return endpointBridgeLoadPromise;
    }
    const sequence = ++endpointBridgeLoadSequence;
    endpointBridgeLoadIdentity = identity;
    endpointBridgeLoadPromise = (async () => {
      parkEndpointBridge(bridge);
      bridge.dataset.crmEndpointBridge = mode;
      bridge.dataset.crmEndpointIdentity = identity;
      bridge.dataset.crmEndpointRasterReady = "false";
      bridge.querySelectorAll(":scope > :not(img.crm-home-endpoint-bridge-raster)").forEach((node) => node.remove());
      let image = bridge.querySelector(":scope > img.crm-home-endpoint-bridge-raster");
      if (!image) {
        image = document.createElement("img");
        image.className = "crm-home-endpoint-bridge-raster";
        image.alt = "";
        image.draggable = false;
        image.decoding = "sync";
        bridge.appendChild(image);
      }
      if (image.src !== value) image.src = value;
      if (!image.complete || image.naturalWidth <= 0) {
        try { await image.decode?.(); } catch {}
      }
      // This is deliberately completed during hover or before programmatic
      // camera launch. Two parked paints upload the destination texture before
      // the transform begins, keeping the camera pass compositor-only.
      await paint(2);
      if (sequence !== endpointBridgeLoadSequence
        || bridge.dataset.crmEndpointIdentity !== identity
        || !image.isConnected
        || !image.complete
        || image.naturalWidth <= 0) return null;
      bridge.dataset.crmEndpointRasterReady = "true";
      return { bridge, raster:image };
    })();
    const promise = endpointBridgeLoadPromise;
    const clearPendingLoad = () => {
      if (endpointBridgeLoadPromise === promise) endpointBridgeLoadPromise = null;
    };
    void promise.then(clearPendingLoad, clearPendingLoad);
    return promise;
  };

  const primeEndpointRaster = async (sourceOrExpander, key = "", capturedAt = "") => {
    const host = sourceOrExpander instanceof Element
      ? (sourceOrExpander.matches?.(".crm-home-preview")
        ? sourceOrExpander
        : sourceOrExpander.querySelector?.(":scope > .crm-home-preview"))
      : null;
    const exact = host?.querySelector?.(":scope > .crm-home-preview-exact");
    const source = exact
      ? (exact.currentSrc || exact.src)
      : (typeof sourceOrExpander === "string" ? sourceOrExpander : "");
    const stamp = capturedAt || host?.dataset?.capturedAt || "";
    return !!await loadEndpointBridgeImage(source, { key, capturedAt:stamp, mode:"exact" });
  };

  const primeEndpointPreview = async (key) => {
    // Hover normally seats the retained room before a click, but keyboard,
    // history and automation routes have no pointer lead. Await the same finite
    // precompose hook before the camera starts so no destination geometry can
    // be written during visible motion.
    try { await window.crmHome?.prepareModule?.(key); } catch {}
    const preview = window.crmHome?.endpointPreview?.(key);
    if (!preview?.src) return false;
    return primeEndpointRaster(preview.src, key, preview.capturedAt);
  };

  const buildEndpointBridge = async (stage, raster) => {
    if (!stage || !raster) return false;
    let bridge = ensureEndpointBridge();
    let bridgeRaster = null;
    if (raster instanceof HTMLImageElement) {
      const source = raster.currentSrc || raster.src;
      const loaded = await loadEndpointBridgeImage(source, {
        key:stage.key,
        capturedAt:stage.originalCoverHost?.dataset?.capturedAt || "",
        mode:stage.coverMode || "exact",
      });
      bridge = loaded?.bridge;
      bridgeRaster = loaded?.raster;
    } else {
      parkEndpointBridge(bridge);
      bridge.dataset.crmEndpointBridge = stage.coverMode || "fallback";
      bridgeRaster = raster.cloneNode(true);
      bridgeRaster.querySelectorAll?.("[id]")?.forEach?.((node) => node.removeAttribute("id"));
      bridgeRaster.removeAttribute?.("id");
      bridgeRaster.removeAttribute?.("hidden");
      bridgeRaster.classList.add("crm-home-endpoint-bridge-raster");
      bridgeRaster.style.visibility = "visible";
      bridgeRaster.style.opacity = "1";
      bridge.replaceChildren(bridgeRaster);
      await paint(2);
    }
    if (!bridge?.isConnected || !bridgeRaster?.isConnected) return false;
    stage.coverBridge = bridge;
    stage.coverHost = bridge;
    stage.coverRaster = bridgeRaster;
    stage.coverSource = bridgeRaster instanceof HTMLImageElement
      ? (bridgeRaster.currentSrc || bridgeRaster.src)
      : coverSourceOf(bridgeRaster);
    if (stage.sequence !== activeDive?.sequence || !bridge.isConnected || !bridgeRaster.isConnected) return false;
    return stage.sequence === activeDive?.sequence
      && bridge.isConnected
      && bridgeRaster.isConnected;
  };

  const runEndpointMaterialBlend = async (stage) => {
    const bridge = stage?.coverBridge;
    if (!bridge?.isConnected || stage.sequence !== activeDive?.sequence) return false;
    bridge.getAnimations?.().forEach((animation) => animation.cancel());
    bridge.style.transition = "none";
    bridge.style.opacity = String(ENDPOINT_PARKED_OPACITY);
    stage.endpointBlendStartedAt = performance.now();
    stage.phase = "endpoint-material-blend";
    const animation = bridge.animate(
      [{ opacity:ENDPOINT_PARKED_OPACITY }, { opacity:1 }],
      {
        duration:ENDPOINT_MATERIAL_BLEND_MS,
        easing:ENDPOINT_MATERIAL_BLEND_EASE,
        fill:"both",
      },
    );
    stage.endpointBlendAnimation = animation;
    document.dispatchEvent(new CustomEvent("crm:desk-material-blend", {
      detail:{
        phase:"start",
        key:stage.key,
        startedAt:stage.endpointBlendStartedAt,
        duration:ENDPOINT_MATERIAL_BLEND_MS,
      },
    }));

    // Visual tests can pause the already-composited fade at its midpoint. In
    // production this branch adds no sampling work to the animation.
    if (typeof window.__crmDeskTransitProbe?.hold === "function") {
      await new Promise((resolve) => {
        const sample = async () => {
          const current = Number(animation.currentTime) || 0;
          if (current >= ENDPOINT_MATERIAL_BLEND_MS / 2 || animation.playState === "finished") {
            animation.pause();
            stage.phase = "endpoint-material-blend-mid";
            await holdProbePhase(stage, "endpoint-material-blend-mid");
            stage.phase = "endpoint-material-blend";
            animation.play();
            resolve();
            return;
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
    }

    try { await animation.finished; } catch {}
    if (stage.sequence !== activeDive?.sequence || stage.endpointBlendAnimation !== animation) return false;
    bridge.style.opacity = "1";
    animation.cancel();
    stage.endpointBlendAnimation = null;
    stage.endpointBlendFinishedAt = performance.now();
    stage.phase = "endpoint-material-blended";
    document.dispatchEvent(new CustomEvent("crm:desk-material-blend", {
      detail:{
        phase:"end",
        key:stage.key,
        startedAt:stage.endpointBlendStartedAt,
        endedAt:stage.endpointBlendFinishedAt,
        duration:ENDPOINT_MATERIAL_BLEND_MS,
      },
    }));
    // Two fully opaque paints make the bridge authoritative before any source
    // acrylic or camera child is changed beneath it.
    await paint(2);
    return stage.sequence === activeDive?.sequence
      && bridge.isConnected
      && Number(getComputedStyle(bridge).opacity) >= .999;
  };

  const blendEndpointMaterial = (stage) => {
    if (!stage) return Promise.resolve(false);
    if (stage.endpointBlendFinishedAt
      && stage.coverBridge?.isConnected
      && Number(getComputedStyle(stage.coverBridge).opacity) >= .999) {
      return Promise.resolve(true);
    }
    if (stage.endpointBlendPromise) return stage.endpointBlendPromise;
    const promise = runEndpointMaterialBlend(stage);
    stage.endpointBlendPromise = promise;
    void promise.then((ready) => {
      if (!ready && stage.endpointBlendPromise === promise) stage.endpointBlendPromise = null;
    });
    return promise;
  };

  const endpointLid = () => {
    const cam = camera();
    return cam?.surface?.()?.querySelector?.(":scope > .crm-home-expander:not(.crm-home-warm)")
      || (cam?.level?.() >= 1 ? cam.layers()?.[1] : null);
  };

  const prepareEndpointBridge = async (stage) => {
    if (!stage) return false;
    if (stage.endpointBridgeReady
      && stage.coverBridge?.isConnected
      && stage.coverRaster?.isConnected) return true;
    if (stage.endpointBridgePromise) return stage.endpointBridgePromise;
    stage.endpointBridgePromise = (async () => {
      ensureStyles();
      const lid = endpointLid();
      const host = lid?.querySelector?.(":scope > .crm-home-preview");
      const exact = host?.querySelector?.(":scope > .crm-home-preview-exact");
      if (exact && (!exact.complete || exact.naturalWidth <= 0)) {
        try { await exact.decode?.(); } catch {}
      }
      // Only the exact capture is guaranteed opaque. The foreground capture
      // has transparent wallpaper pixels, so cold sessions receive the same
      // explicit opaque fallback used at the settled endpoint.
      const imageRaster = exact?.complete && exact.naturalWidth > 0 ? exact : null;
      const fallback = imageRaster ? null : buildFallbackCover(host);
      if (fallback) fallback.style.visibility = "hidden";
      const raster = imageRaster || fallback;
      const coverMode = imageRaster ? "exact" : "fallback";
      stage.lid = lid;
      stage.originalCoverHost = host;
      stage.originalCoverRaster = raster;
      stage.coverHost = host;
      stage.coverRaster = raster;
      stage.coverMode = coverMode;
      stage.fallbackCover = fallback;
      if (!lid || !host || !raster || stage.sequence !== activeDive?.sequence) return false;
      if (raster instanceof HTMLImageElement && (!raster.complete || raster.naturalWidth <= 0)) {
        try { await raster.decode?.(); } catch {}
      }
      if (stage.sequence !== activeDive?.sequence) return false;
      const ready = await buildEndpointBridge(stage, raster);
      stage.endpointBridgeReady = ready === true;
      return stage.endpointBridgeReady;
    })();
    const promise = stage.endpointBridgePromise;
    const ready = await promise;
    if (!ready && stage.endpointBridgePromise === promise) stage.endpointBridgePromise = null;
    return ready;
  };

  const waitForMotionLead = (stage, leadMs) => new Promise((resolve) => {
    const deadline = stage.motionStartedAt + stage.morphMs - leadMs;
    const sample = (now) => {
      if (stage.sequence !== activeDive?.sequence) {
        resolve(false);
        return;
      }
      if (now >= deadline) {
        resolve(true);
        return;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  const armNavigationEntrance = (stage) => {
    if (!stage) return Promise.resolve(false);
    if (stage.navigationEntrancePromise) return stage.navigationEntrancePromise;
    stage.navigationEntrancePromise = (async () => {
      if (!await waitForMotionLead(stage, NAVIGATION_ENTRANCE_LEAD_MS)) return false;
      if (stage.sequence !== activeDive?.sequence) return false;
      const navigation = document.querySelector(".crm-module-switch");
      if (!navigation) return false;
      navigation.setAttribute("data-crm-transit-nav-entering", "");
      navigation.inert = true;
      // The control is permanently prepainted at this same offscreen transform.
      // Keeping the relative travel in CSS avoids a synchronous layout read and
      // avoids decoding its acrylic/icon resources during the camera move.
      const travel = "calc(100% + 36px)";
      stage.navigationControl = navigation;
      stage.navigationEntranceStartedAt = performance.now();
      stage.navigationEntranceTravel = 82;
      stage.navigationEntranceAnimation?.cancel?.();
      const animation = navigation.animate(
        [
          { transform:`translateX(-50%) translateY(${travel}) translateZ(0)` },
          { transform:"translateX(-50%) translateY(0px) translateZ(0)" },
        ],
        {
          duration:NAVIGATION_ENTRANCE_MS,
          easing:NAVIGATION_ENTRANCE_EASE,
          fill:"both",
        },
      );
      stage.navigationEntranceAnimation = animation;
      try { await animation.finished; } catch {}
      if (stage.sequence !== activeDive?.sequence || stage.navigationEntranceAnimation !== animation) return false;
      stage.navigationEntranceFinishedAt = performance.now();
      return true;
    })();
    return stage.navigationEntrancePromise;
  };

  const armEndpointMaterialLead = (stage) => {
    if (!stage) return Promise.resolve(false);
    if (stage.endpointLeadPromise) return stage.endpointLeadPromise;
    stage.endpointLeadPromise = (async () => {
      // Confirm the preloaded exact destination remains parked at .001 until
      // the final portion of the transform. The unchanged 180 ms dissolve then
      // overlaps the landing instead of waiting several paints after it.
      if (!await prepareEndpointBridge(stage)) return false;
      if (!await waitForMotionLead(stage, ENDPOINT_MATERIAL_LEAD_MS)) return false;
      if (stage.sequence !== activeDive?.sequence) return false;
      stage.originalCoverHost.style.transition = "none";
      stage.originalCoverHost.style.opacity = "1";
      document.documentElement.classList.add("crm-transit-endpoint-covered");
      stage.endpointLeadArmedAt = performance.now();
      return blendEndpointMaterial(stage);
    })();
    return stage.endpointLeadPromise;
  };

  const cleanupEndpointCover = (stage, { preserveOpacity = false } = {}) => {
    stage?.endpointBlendAnimation?.cancel?.();
    if (stage) stage.endpointBlendAnimation = null;
    stage?.navigationEntranceAnimation?.cancel?.();
    if (stage) stage.navigationEntranceAnimation = null;
    const navigation = stage?.navigationControl;
    if (navigation) {
      navigation.removeAttribute("data-crm-transit-nav-entering");
      navigation.inert = false;
    }
    document.documentElement.classList.remove(
      "crm-transit-materializing",
      "crm-transit-revealing",
      "crm-transit-endpoint-covered",
    );
    clearDestinationLayers();
    const surface = camera()?.surface?.();
    surface?.removeAttribute?.("data-crm-transit-cover");
    const lid = stage?.lid;
    lid?.classList?.remove("crm-home-endpoint-cover");
    if (lid?.dataset) delete lid.dataset.crmEndpointCover;
    stage?.fallbackCover?.remove?.();
    parkEndpointBridge(stage?.coverBridge);
    if (!preserveOpacity) {
      [stage?.originalCoverHost, lid].filter(Boolean).forEach((node) => {
        node.style.removeProperty("opacity");
        node.style.removeProperty("transition");
      });
    }
  };

  const seatEndpointRaster = async (stage) => {
    ensureStyles();
    const cam = camera();
    if (!await prepareEndpointBridge(stage)) return false;
    const lid = stage.lid;
    const coverMode = stage.coverMode;
    const coverHost = stage.originalCoverHost;
    if (!lid || !coverHost) return false;
    if (stage.sequence !== activeDive?.sequence) return false;
    coverHost.style.transition = "none";
    coverHost.style.opacity = "1";
    document.documentElement.classList.add("crm-transit-endpoint-covered");
    if (!stage.endpointBlendStartedAt) stage.phase = "preparing-endpoint-material";
    // The bridge was decoded during motion and its full-duration dissolve was
    // armed just before landing. Await the same animation here before retiring
    // any source acrylic; this preserves the original ownership invariant.
    if (!await blendEndpointMaterial(stage)) return false;
    if (stage.sequence !== activeDive?.sequence) return false;

    // Only after the independent bridge has held two opaque paints may the
    // camera's internal exact raster and retirement state change beneath it.
    cam?.surface?.()?.setAttribute?.("data-crm-transit-cover", coverMode);
    lid.dataset.crmEndpointCover = coverMode;
    lid.classList.add("crm-home-endpoint-cover");
    stage.coverStart = inspectRasterCover(stage);
    stage.coverSeatedAt = performance.now();
    stage.coverInvariant = stage.coverStart.ready;
    stage.phase = "covered";
    await holdProbePhase(stage, "covered");
    // The blend's final opaque paints already close a clean raster-owned
    // refresh interval before live-room ownership work begins.
    if (stage.sequence !== activeDive?.sequence) return false;
    // Close the cover-selector invalidations before retiring the moving Home
    // acrylic. Awaiting the probe alone resumes in the same microtask and used
    // to combine both full-window layer updates into one missed refresh.
    await paint(1);
    if (stage.sequence !== activeDive?.sequence) return false;
    // The camera's full-viewport acrylic stayed fully composited until this
    // independent raster had owned completed opaque paints. Retire it only
    // now, invisibly beneath that exact cover; no low-opacity material frame
    // can appear between the transform and the destination's live acrylic.
    stage.endpointAcrylicRetired = window.crmHome?.retireEndpointAcrylic?.() === true;
    stage.endpointAcrylicRetiredAt = stage.endpointAcrylicRetired ? performance.now() : 0;
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
        && stage.sourceRetired === true
        && stage.acrylicState?.stable === true
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
        throw new Error("Destination acrylic did not reach stable final composition under its endpoint cover");
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

      stage.interactionReadyAt = performance.now();
      document.dispatchEvent(new CustomEvent("crm:desk-interaction-ready", {
        detail:{ key:stage.key, sequence:stage.sequence, phase:stage.phase },
      }));
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
        [{ opacity:ENDPOINT_UNOCCLUDE_OPACITY }, { opacity:ENDPOINT_PARKED_OPACITY }],
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
      host.style.opacity = String(ENDPOINT_PARKED_OPACITY);
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
    const factoryReady = window.crmHome?.isModulePrewarmed?.(stage.key) === true;
    if (!retainedPrecompose && !factoryReady) {
      try { await destinationApi?.baseline?.({ canRender: () => stage.sequence === activeDive?.sequence }); } catch {}
      theater = findDestinationTheater(stage.key);
      retainedPrecompose = !!theater?.hasAttribute?.("data-crm-home-precomposed");
    }
    if (stage.sequence !== activeDive?.sequence) return;

    if (retainedPrecompose) {
      // Pointer intent has already painted this room at its final native
      // coordinates beneath Home. Keep that exact compositor topology in place
      // through the zoom; relocating it offscreen would force Viz to allocate
      // the room again at the endpoint.
      stage.settledState = { stable:true, signature:"retained-precompose" };
    } else {
      // baseline() resolves only after the factory has built its complete DOM.
      // Home's finite prewarm lease removes paint ownership after this work is
      // complete. Recognize that semantic readiness here instead of invoking a
      // second full factory baseline while the camera is visibly moving.
      stage.settledState = {
        stable:true,
        signature:factoryReady ? "home-prewarm-complete" : "baseline-complete",
      };
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
    if (typeof window.crmHome?.promotePrecomposedModule === "function") {
      await window.crmHome.promotePrecomposedModule(stage.key, {
        canContinue:() => stage.sequence === activeDive?.sequence,
      });
    } else {
      window.crmHome?.setPrecomposedModulePromoted?.(stage.key, true);
    }
    if (stage.sequence !== activeDive?.sequence) return;
    stage.theater?.removeAttribute?.("data-crm-transit-retained");
    primeDestinationLayers(stage.key, stage.theater || findDestinationTheater(stage.key));
    document.documentElement.classList.remove("crm-transit-revealing");
    document.documentElement.classList.add("crm-transit-materializing");
    stageDestinationLayers(stage.key, destinationRoot);
    // This retained room was already painted at native size during Home idle.
    // Do not spend another frame painting the temporary .001 grouping; the
    // final-topology acrylic warm-up below supplies every required closed paint.
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
      await commitStaged(stage.key);
      stage.committedAt = performance.now();
      stage.committed = true;
      // Close the workspace switch before the baseline starts reading final
      // geometry. Those reads must not force the whole style tree in this task.
      await paint(1);
      if (stage.sequence !== activeDive?.sequence) return false;
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
    // The natural tree is now final. Do not insert a second full-room paint
    // barrier here: geometry stability and acrylic warm-up immediately below
    // already require repeated covered paints in this exact topology.
    stage.finalDestinationLayers = [...destinationLayers];
    document.documentElement.classList.remove("crm-transit-materializing", "crm-transit-revealing");
    clearDestinationLayers();
    // Close the destination's final CSS topology in its own refresh interval.
    // Retiring the Home camera in this same BeginMainFrame previously combined
    // both full-window invalidations into a single 13–20 ms renderer task.
    await paint(2);
    if (stage.sequence !== activeDive?.sequence) return false;
    stage.phase = "settling-covered";
    // The room now owns its final natural layer topology under the opaque
    // endpoint. Warm its acrylic while geometry stability is sampled instead
    // of paying those two independent frame waits back-to-back.
    stage.sourceRetirementPromise ||= retireDiveSource(stage).catch(() => false);
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

  const retireDiveSource = async (stage) => {
    if (!stage || stage.sequence !== activeDive?.sequence) return false;
    if (stage.sourceRetired) return stage.acrylicState?.stable === true;
    const cam = camera();
    const surface = cam?.surface?.();
    const lid = stage.lid || (cam?.level?.() >= 1 ? cam.layers()[1] : null);
    stage.coverBeforeSourceRetirement = inspectRasterCover(stage);
    stage.coverInvariant = stage.coverInvariant !== false
      && sameRasterCover(stage, stage.coverStart, stage.coverBeforeSourceRetirement);
    if (!stage.coverInvariant || !stage.coverBridge?.isConnected) return false;

    // The independent opaque bridge now owns the endpoint. Put Home into the
    // exact retained state it will keep while this room is active, including
    // its final z-order, before any live destination pixel can be exposed.
    if (surface) surface.style.zIndex = "";
    stage.phase = "retiring-source-resetting-home";
    // Reset the hidden Home camera before exposing the live underpaint. The
    // destination backdrop must warm against its final, stable layer topology.
    if (cam?.restoreRoot) cam.restoreRoot();
    else cam?.rebuildRoot?.();
    // Establish the lightweight reverse-camera retention in its own covered
    // refresh. Doing this inside workspace activation forced Home and the
    // incoming room through one full-document style/layout pass.
    try { window.crmHome?.retainMotionSurface?.(); } catch {}
    stage.phase = "retiring-source-seating-home";
    // Close the retained bitmap/z-order paint before applying the inactive
    // parking state. Resolving after one rAF would run the next mutation in a
    // microtask before Chromium had painted this topology.
    await paint(2);
    if (stage.sequence !== activeDive?.sequence) return false;
    stage.phase = "retiring-source-hiding-home";
    if (!window.crmHome?.finalizeInactiveSurface?.() && surface) surface.hidden = true;
    // A one-rAF promise resumes in a microtask before that refresh is painted.
    // Close one complete Home-retirement paint before exposing destination
    // underpaint, so two full-window property-tree changes cannot coalesce.
    await paint(2);
    if (stage.sequence !== activeDive?.sequence) return false;
    surface?.removeAttribute?.("data-crm-transit-cover");
    lid?.classList?.remove("crm-home-endpoint-cover");
    if (lid?.dataset) delete lid.dataset.crmEndpointCover;
    stage.sourceRetiredAt = performance.now();
    stage.sourceRetired = true;
    stage.phase = "unoccluding-acrylic";

    // A fully opaque cover lets Chromium occlusion-cull every live blur plane,
    // even though computed styles claim the filters are ready. Preserve 99% of
    // the exact endpoint while exposing a 1% underpaint: the visual remains the
    // captured frame, but the GPU must now raster the real destination acrylic.
    stage.coverBridge.style.opacity = String(ENDPOINT_UNOCCLUDE_OPACITY);
    stage.acrylicUnderpaintExposed = true;
    stage.acrylicUnderpaintAt = performance.now();
    await paint(2);
    if (stage.sequence !== activeDive?.sequence) return false;
    stage.phase = "warming-acrylic-underpaint";

    // Backdrop filters are sensitive to the set of layers behind them. Require
    // repeated identical native paints after Home has moved behind the
    // destination and the live underpaint is actually participating.
    stage.acrylicState = await waitForDestinationAcrylic(stage);
    if (stage.sequence !== activeDive?.sequence) return false;
    stage.coverAfterSourceRetirement = inspectRasterCover(stage);
    stage.coverInvariant = stage.coverInvariant !== false
      && sameRasterCover(stage, stage.coverStart, stage.coverAfterSourceRetirement);
    stage.acrylicReadyAt = performance.now();
    return stage.coverInvariant && stage.acrylicState?.stable === true;
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
      sourceRetired:false,
      acrylicUnderpaintExposed:false,
      acrylicState:null,
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
    void armNavigationEntrance(activeDive);
    void armEndpointMaterialLead(activeDive);
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
    // A requestAnimationFrame queued by a transitionend handler can still run
    // later in that same BeginMainFrame. Two callbacks guarantee that endpoint
    // ownership work starts in a distinct refresh interval.
    await paint(2);
    if (stage.sequence !== activeDive?.sequence) return;
    stage.maintenanceStartedAt = performance.now();
    let coverReady = false;
    try { coverReady = await seatEndpointRaster(stage); } catch {}
    if (!coverReady) {
      stage.revealError = "No opaque endpoint cover was available";
      stage.resolveReveal?.();
      stage.resolveReveal = null;
    } else {
      // Source-acrylic retirement and destination promotion each affect a
      // complete viewport compositor owner. Keep them in adjacent 100 Hz
      // refreshes beneath the already-opaque endpoint bridge.
      await paint(1);
      if (stage.sequence !== activeDive?.sequence) return;
      try { await materializeDiveDestination(stage); } catch {}
      if (!stage.ready) { stage.ready = true; stage.readyAt = performance.now(); }
      // Destination promotion, workspace activation and source retirement each
      // own a bounded covered frame. Coalescing them made one 20–35 ms frame
      // even though the user still saw the same static endpoint raster.
      await paint(1);
      if (stage.sequence !== activeDive?.sequence) return;
      try { await settleDiveDestination(stage); } catch {}
      await paint(1);
      if (stage.sequence !== activeDive?.sequence) return;
      let sourceRetired = false;
      try { sourceRetired = await (stage.sourceRetirementPromise || retireDiveSource(stage)); } catch {}
      if (!sourceRetired) {
        stage.revealError = "Destination acrylic did not stabilize in its final layer topology";
        stage.resolveReveal?.();
        stage.resolveReveal = null;
      } else {
        armDestinationReveal(stage);
        try { await stage.revealPromise; } catch {}
      }
    }
    if (stage.revealError || !stage.liveReady) {
      // Fail closed, then recover through the same canonical camera instead of
      // freezing the viewport or dropping the cover. The opaque room raster
      // contracts back into its Home tile while Home is restored beneath it.
      document.dispatchEvent(new CustomEvent("crm:desk-transit-error", {
        detail:{
          key,
          phase:stage.phase,
          error:stage.revealError || "destination not ready",
          coverStart:stage.coverStart || null,
          coverBeforeSwap:stage.coverBeforeSwap || null,
          coverAfterSettlement:stage.coverAfterSettlement || null,
          settledState:stage.settledState || null,
          acrylicState:stage.acrylicState || null,
        },
      }));
      stage.phase = "recovering-home";
      stage.coverAnimation?.cancel?.();
      stage.coverAnimation = null;
      if (stage.coverHost) {
        stage.coverHost.style.transition = "none";
        stage.coverHost.style.opacity = "1";
      }
      document.documentElement.classList.remove("crm-transit-materializing", "crm-transit-revealing");
      clearDestinationLayers();
      commit("home");
      if (surface) {
        surface.hidden = false;
        surface.style.zIndex = TRANSIT_Z;
      }
      surface?.removeAttribute?.("data-crm-transit-cover");
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
      cleanupEndpointCover(stage);
      if (surface) surface.style.zIndex = "";
      if (activeDive?.sequence === stage.sequence) activeDive = null;
      done(false);
      return;
    }

    // Home was already retired beneath the opaque body-level bridge. After its
    // dissolve, leave that bridge compositor-resident at its parked opacity;
    // no layer topology changes while the live acrylic endpoint owns the frame.
    const lid = stage.lid;
    if (!stage.sourceRetired) {
      if (cam?.restoreRoot) cam.restoreRoot();
      else cam?.rebuildRoot?.();
      try { window.crmHome?.recycleExpander?.(key, lid); } catch {}
      if (surface) {
        surface.hidden = true;
        surface.style.zIndex = "";
      }
    }
    cleanupEndpointCover(stage);
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
      endpointMaterialBlendMs:(stage.endpointBlendFinishedAt || doneAt)
        - (stage.endpointBlendStartedAt || stage.endpointBlendFinishedAt || doneAt),
      endpointMaterialBlendDuration:ENDPOINT_MATERIAL_BLEND_MS,
      endpointMaterialLead:ENDPOINT_MATERIAL_LEAD_MS,
      endpointBlendStartDeltaMs:(stage.endpointBlendStartedAt || doneAt)
        - (stage.motionEndedAt || stage.maintenanceStartedAt || doneAt),
      endpointBlendStartedBeforeMotionEnd:Number(stage.endpointBlendStartedAt) > 0
        && Number(stage.endpointBlendStartedAt) <= Number(stage.motionEndedAt),
      navigationEntranceDuration:NAVIGATION_ENTRANCE_MS,
      navigationEntranceLead:NAVIGATION_ENTRANCE_LEAD_MS,
      navigationEntranceStartedAt:stage.navigationEntranceStartedAt || 0,
      navigationEntranceFinishedAt:stage.navigationEntranceFinishedAt || 0,
      navigationEntranceStartDeltaMs:(stage.navigationEntranceStartedAt || doneAt)
        - (stage.motionEndedAt || stage.maintenanceStartedAt || doneAt),
      navigationEntranceFinishDeltaMs:(stage.navigationEntranceFinishedAt || doneAt)
        - (stage.motionEndedAt || stage.maintenanceStartedAt || doneAt),
      endpointAcrylicRetired:stage.endpointAcrylicRetired === true,
      endpointAcrylicRetiredAfterBlend:stage.endpointAcrylicRetired === true
        && Number(stage.endpointAcrylicRetiredAt) >= Number(stage.endpointBlendFinishedAt),
      commitMs:(stage.committedAt || stage.commitAt || doneAt) - (stage.commitAt || stage.startedAt),
      readyMs:(stage.readyAt || doneAt) - stage.startedAt,
      frameWaitMs:Math.max(0, (stage.releaseAt || doneAt) - (stage.readyAt || doneAt)),
      releaseMs:(stage.revealedAt || doneAt) - (stage.releaseAt || doneAt),
      coverInvariant:stage.coverInvariant === true,
      liveReady:stage.liveReady === true,
      sourceRetired:stage.sourceRetired === true,
      sourceRetiredBeforeRelease:stage.sourceRetired === true
        && Number(stage.sourceRetiredAt) > 0
        && Number(stage.sourceRetiredAt) <= Number(stage.releaseAt),
      acrylicUnderpaintExposed:stage.acrylicUnderpaintExposed === true,
      acrylicUnderpaintMs:(stage.acrylicReadyAt || doneAt) - (stage.acrylicUnderpaintAt || doneAt),
      acrylicStable:stage.acrylicState?.stable === true,
      acrylicOwners:stage.acrylicState?.ownerCount || 0,
      acrylicWarmFrames:stage.acrylicState?.frames || 0,
      acrylicWarmMs:(stage.acrylicReadyAt || doneAt) - (stage.sourceRetiredAt || doneAt),
      interactionReadyMs:(stage.interactionReadyAt || doneAt) - stage.startedAt,
      interactionReadyAfterMotionMs:(stage.interactionReadyAt || doneAt)
        - (stage.motionEndedAt || doneAt),
      coverStart:stage.coverStart || null,
      coverBeforeSwap:stage.coverBeforeSwap || null,
      coverAfterSwap:stage.coverAfterSwap || null,
      coverBeforeSourceRetirement:stage.coverBeforeSourceRetirement || null,
      coverAfterSourceRetirement:stage.coverAfterSourceRetirement || null,
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
    void (async () => {
      if (expandFirst) {
        // Programmatic navigation has no pointer-hover interval. Seat the same
        // parked texture before starting its camera so cold launches retain
        // the exact compositor-only cadence of ordinary prewarmed clicks.
        try { await primeEndpointPreview(key); } catch {}
        if (stage.sequence !== activeDive?.sequence) { done(false); return; }
        if (cam.level() > 0) cam.rebuildRoot();
        cam.expand(bucket);
      }
      Promise.resolve(cam.whenSettled?.()).then(() => finishDiveIn(key, done, stage));
    })();
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
    // The full-size return lid is now the exact visible room. Retaining the
    // complete outgoing .001 module underneath only asks Viz to raster both
    // scenes during the first reverse frame.
    void (async () => {
      if (!window.crmHome?.releasePrecomposedModule?.(fromKey)) {
        window.crmHome?.setPrecomposedModulePromoted?.(fromKey, false);
      }
      // The exact full-size return lid is already authoritative. Retire the
      // large outgoing room, route state, API activation and theater topology
      // in their own covered paints just as the forward endpoint does.
      await paint(1);
      await commitStaged("home");
      await paint(1);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          cam.back();     // 460ms house contract into the Home slot
          Promise.resolve(cam.whenSettled?.()).then(() => window.crmHome?.waitForHandoff?.()).then(() => {
            if (surface) surface.style.zIndex = "";
            done();
          });
        });
      });
    })();
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
    let interactionReady = null;
    try { interactionReady = window.crmHomePreviews?.setInteraction?.(true, "desk-transit"); } catch {}
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
    void Promise.resolve(interactionReady).catch(() => null).then(() => {
      try {
        if (current === "home") diveIn(key, done);
        else if (key === "home") diveOut(current, done);
        else diveOut(current, () => diveIn(key, done));   // neighbors on the desk: out through Home, in again
      } catch {
        commit(key);   // motion failed — state must still be correct
        done();
      }
    });
  });

  // A dive the home camera already started (a bucket click — the camera's own
  // onClick ran expand): adopt its ending instead of starting a second one.
  const adoptDive = (key) => new Promise((resolve) => {
    const ws = window.crmWorkspaces;
    if (!ws || busy) { resolve(false); return; }
    noteViewportDeparture();
    busy = true;
    let interactionReady = null;
    try { interactionReady = window.crmHomePreviews?.setInteraction?.(true, "desk-transit"); } catch {}
    announceNavigationHistory();
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
    void Promise.resolve(interactionReady).catch(() => null).then(() => {
      const surface = camera()?.surface?.();
      if (surface) surface.style.zIndex = TRANSIT_Z;
      const stage = beginDiveDestination(key);
      Promise.resolve(camera()?.whenSettled?.()).then(() => finishDiveIn(key, done, stage));
    });
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
    primeEndpointRaster,
    noteHomeTransformStart,
    noteHomeTransformEnd,
    motionState:() => ({ ...homeMotionState }),
    ownershipFadeState:() => ({ ...ownershipFadeState }),
    visualState:() => {
      const material = window.crmHome?.acrylicState?.() || null;
      return {
        active:homeMotionState.active || ownershipFadeState.active || material?.active === true,
        cameraActive:homeMotionState.active,
        ownershipActive:ownershipFadeState.active,
        materialActive:material?.active === true,
        camera:{ ...homeMotionState },
        ownership:{ ...ownershipFadeState },
        material,
      };
    },
    coverState:() => activeDive ? {
      key:activeDive.key,
      sequence:activeDive.sequence,
      phase:activeDive.phase,
      coverInvariant:activeDive.coverInvariant !== false,
      rasterReady:activeDive.coverStart?.ready === true,
      rasterOpaque:activeDive.coverStart?.ready === true
        && !["crossfading", "crossfade-mid", "swapped", "live"].includes(activeDive.phase),
      liveReady:activeDive.liveReady === true,
      motionStartedAt:Number.isFinite(activeDive.motionStartedAt) ? activeDive.motionStartedAt : 0,
      motionEndedAt:activeDive.motionEndedAt || 0,
      motionDuration:activeDive.morphMs || 0,
      expectedMotionEndAt:Number.isFinite(activeDive.motionStartedAt)
        ? activeDive.motionStartedAt + activeDive.morphMs
        : 0,
      maintenanceStartedAt:activeDive.maintenanceStartedAt || 0,
      endpointBlendStartedAt:activeDive.endpointBlendStartedAt || 0,
      endpointBlendFinishedAt:activeDive.endpointBlendFinishedAt || 0,
      endpointBlendDuration:ENDPOINT_MATERIAL_BLEND_MS,
      endpointMaterialLead:ENDPOINT_MATERIAL_LEAD_MS,
      endpointBlendStartDeltaMs:activeDive.endpointBlendStartedAt && activeDive.motionEndedAt
        ? activeDive.endpointBlendStartedAt - activeDive.motionEndedAt
        : 0,
      endpointBlendStartedBeforeMotionEnd:Number(activeDive.endpointBlendStartedAt) > 0
        && Number(activeDive.endpointBlendStartedAt) <= Number(activeDive.motionEndedAt),
      navigationEntranceStartedAt:activeDive.navigationEntranceStartedAt || 0,
      navigationEntranceFinishedAt:activeDive.navigationEntranceFinishedAt || 0,
      navigationEntranceDuration:NAVIGATION_ENTRANCE_MS,
      navigationEntranceLead:NAVIGATION_ENTRANCE_LEAD_MS,
      coverSeatedAt:activeDive.coverSeatedAt || 0,
      readyAt:activeDive.readyAt || 0,
      swappedAt:activeDive.swappedAt || 0,
      interactionReadyAt:activeDive.interactionReadyAt || 0,
      sourceRetired:activeDive.sourceRetired === true,
      sourceRetiredAt:activeDive.sourceRetiredAt || 0,
      acrylicUnderpaintExposed:activeDive.acrylicUnderpaintExposed === true,
      acrylicStable:activeDive.acrylicState?.stable === true,
      acrylicOwners:activeDive.acrylicState?.ownerCount || 0,
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
    pendingDestination: (key = "") => {
      const target = String(key) === "tickets" ? "cases" : String(key);
      return !!activeDive && activeDive.key === target;
    },
    canInteractWith: (key = "") => {
      const target = String(key) === "tickets" ? "cases" : String(key);
      if (!activeDive) return !busy && !navigationRestoring;
      return activeDive.key === target
        && activeDive.liveReady === true
        && ["crossfade-ready", "crossfading", "swapped", "live"].includes(activeDive.phase);
    },
    canSettleGeometry: (key = "") => {
      const target = String(key) === "tickets" ? "cases" : String(key);
      return !!activeDive
        && activeDive.key === target
        && (
          // The destination's retained .001 room may finish canonical layout
          // before the first transform frame. Once motion has started, only
          // the opaque endpoint-cover phase may write destination geometry.
          (!Number.isFinite(activeDive.motionStartedAt)
            && activeDive.phase === "preparing")
          || (
            activeDive.coverStart?.ready === true
            && !["crossfading", "crossfade-mid", "swapped", "live"].includes(activeDive.phase)
          )
        );
    },
    isBusy: () => busy || navigationRestoring,
    performanceTimings: () => performanceTimings.map((item) => ({ ...item })),
  };
  const initializeNavigation = () => {
    ensureStyles();
    ensureEndpointBridge();
    syncTemporalContext();
    requestAnimationFrame(() => requestAnimationFrame(() => seedNavigationHistory()));
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initializeNavigation, { once: true });
  else initializeNavigation();
})();
