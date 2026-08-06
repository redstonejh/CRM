import {
  applyAdaptiveTileGrid,
  bindTileObject,
  createTileObject,
  indexTileTree,
  mountTileChildren,
  normalizeTileRecord,
  tileDataOf,
} from "./modules/tile-system.js";
import { changed as contextAddChanged, register as registerContextAddProvider } from "./modules/context-add-registry.js";

// crm-home.js — adaptive inert screenshot LODs hosted by the original camera.
(() => {
  if (typeof window.createFractalCamera !== "function") return;

  const HOME_TILE_STORE_KEY = "crm-home-tiles-v3";
  const LEGACY_HOME_TILE_STORES = [
    { key:"crm-home-tiles-v2", additions:["monitoring"] },
    { key:"crm-home-tiles-v1", additions:["calendar", "monitoring"] },
  ];
  const MODULES = [
    { key: "people", label: "People" }, { key: "cases", label: "Tickets" },
    { key: "planner", label: "Projects" }, { key: "assignments", label: "Assignments" },
    { key: "calendar", label: "Calendar" }, { key: "monitoring", label: "Monitoring" },
  ];
  const CANONICAL_HOME_TILE_IDS = new Set(MODULES.map(({ key }) => key));
  const RETRY_MS = [0, 120, 320, 700, 1400, 2800, 5000];
  const HOME_PREVIEW_VERSION = "filtered-home-v49";
  const HOME_RETURN_INGRESS_MS = 110;
  const HOME_ACRYLIC_RELEASE_MS = 110;
  const HOME_RETURN_HANDOFF_EASE = "cubic-bezier(.4, 0, .2, 1)";
  const DAY_MS = 86400000;
  const HOME_HAND_WINDOW_DAYS = 7;
  const HAND_LIMIT = 7;
  const previews = new Map();
  const pendingPreviews = new Map();
  const decodedPreviewSources = new Map();
  const pendingDisplayedPreviewRefreshes = new Map();
  const previewSyncKeys = new Set();
  const previewSyncs = new Set();
  let camera = null;
  let subscribed = false;
  let retryTimer = 0;
  let retryAttempt = 0;
  let priorityItems = [];
  let priorityUsername = "";
  let handRefreshTimer = 0;
  let handRefreshGeneration = 0;
  let handDirty = true;
  let activeRefreshPending = false;
  let inactiveCommitDeferred = false;
  let motionSnapshot = null;
  let pendingMotionSnapshot = null;
  let motionCommitTimer = 0;
  let motionSnapshotSettleTimer = 0;
  let factoryPrewarmHandle = 0;
  let factoryPrewarmTimer = 0;
  let factoryPrewarmRunning = false;
  let factoryPrewarmAttempts = 0;
  let factoryPrewarmAfter = 0;
  let handoffSequence = 0;
  let handoffPromise = Promise.resolve();
  let handoffResolve = null;
  let homeEndpointSettling = false;
  let todoPopover = null;
  let todoOutsideClose = null;
  let homeTileMenu = null;
  let homeTileMenuOutsideClose = null;
  let previewCommitTimer = 0;
  let previewDecodeSequence = 0;
  let priorityTicketOpen = null;
  let transitionMaintenanceTimer = 0;
  let transitionMaintenanceIdle = 0;
  let homeLayoutEpoch = 0;
  const prewarmedFactories = new Set();
  const TODO_LINK_ENTITIES = new Set(["tasks", "contacts", "tickets", "workItems"]);
  const recycledExpanders = new Map();
  const prebuiltExpanders = new Map();
  let prebuiltExpanderFrame = 0;
  const FACTORY_PREWARM_APIS = [
    "peopleCards",
    "ticketStacks",
    "crmPlanner",
    "crmAssignments",
    "fractalCalendar",
    "crmMonitoring",
  ];
  const FACTORY_API_BY_MODULE = {
    people:"peopleCards",
    cases:"ticketStacks",
    planner:"crmPlanner",
    assignments:"crmAssignments",
    calendar:"fractalCalendar",
    monitoring:"crmMonitoring",
  };
  const clone = (value) => typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  const homeTileData = (tile) => tileDataOf(tile) || {};
  const homeTileModuleKey = (tile) => String(homeTileData(tile).moduleKey || "");
  const homeTileLabel = (tile) => String(homeTileData(tile).label || tile?.tile?.label || "");
  const normalizeHomeTile = (source = {}, rank = 0) => {
    const sourceData = source.data && typeof source.data === "object" ? source.data : {};
    const moduleKey = String(
      sourceData.moduleKey || source.moduleKey || source.key || source.tile?.target?.id || "",
    );
    const module = MODULES.find((candidate) => candidate.key === moduleKey);
    if (!module) return null;
    const tileId = String(source.tile?.id || source.id || module.key);
    const label = [sourceData.label, source.label, source.tile?.title, module.label]
      .map((value) => String(value ?? "").trim())
      .find(Boolean) || module.label;
    return createTileObject({
      data:{
        domain:"home",
        unit:"workspace",
        moduleKey:module.key,
        key:module.key,
        label,
      },
      tile:normalizeTileRecord({ ...source, id:tileId, key:tileId, title:label, label, tile:{ ...source.tile, id:tileId, key:tileId, title:label, label } }, {
        id:tileId,
        key:tileId,
        title:label,
        label,
        kind:"home-viewport",
        targetType:"workspace",
        targetId:module.key,
        rank,
      }),
    });
  };
  const defaultHomeTiles = () => MODULES.map((module, rank) => normalizeHomeTile({ ...module, id:module.key }, rank));
  const readHomeTiles = () => {
    let parsed = null;
    let migrationAdditions = [];
    let migrated = false;
    try {
      const current = localStorage.getItem(HOME_TILE_STORE_KEY);
      migrated = current == null;
      let source = current;
      if (source == null) {
        const legacy = LEGACY_HOME_TILE_STORES.find(
          ({ key }) => localStorage.getItem(key) != null,
        );
        if (legacy) {
          source = localStorage.getItem(legacy.key);
          migrationAdditions = legacy.additions;
        }
      }
      parsed = JSON.parse(source || "null");
    } catch {}
    if (!Array.isArray(parsed)) return defaultHomeTiles();
    const seen = new Set();
    const records = parsed.map(normalizeHomeTile).filter((tile) => {
      if (!tile || seen.has(tile.tile.id)) return false;
      seen.add(tile.tile.id);
      return true;
    });
    // Each store generation adds only the modules that did not exist in that
    // generation. Migrate once while preserving custom order, labels,
    // duplicates, and any removals made after the v3 layout has been written.
    migrationAdditions.forEach((moduleKey) => {
      if (records.some((tile) => homeTileModuleKey(tile) === moduleKey)) return;
      records.push(normalizeHomeTile(
        { key:moduleKey, id:moduleKey },
        records.length,
      ));
    });
    if (migrated && !window.crmHomePreviews?.isCaptureWorker) {
      try { localStorage.setItem(HOME_TILE_STORE_KEY, JSON.stringify(records)); } catch {}
    }
    return records;
  };
  const homeRootObject = createTileObject({
    data:{ domain:"home", unit:"root", moduleKey:"", key:"home", label:"Home" },
    tile:normalizeTileRecord({
      id:"home-root",
      key:"home",
      title:"Home",
      label:"Home",
      tileKind:"home-root",
      targetType:"home-root",
      targetId:"home",
    }),
    children:readHomeTiles(),
  });
  let homeTreeIndex = indexTileTree(homeRootObject);
  let homeTileRecords = homeRootObject.children;
  const isCanonicalHomeTile = (tile) => !!tile
    && CANONICAL_HOME_TILE_IDS.has(String(tile.tile?.id || ""))
    && homeTileModuleKey(tile) === String(tile.tile?.id || "");
  const homeTileForId = (tileId) => homeTileRecords.find(
    (tile) => tile.tile.id === String(tileId || ""),
  ) || null;
  const canRemoveHomeTile = (tileId) => {
    const tile = homeTileForId(tileId);
    return !!tile && !isCanonicalHomeTile(tile);
  };
  const replaceHomeTileRecords = (records) => {
    homeRootObject.children = records;
    homeTreeIndex = indexTileTree(homeRootObject);
    homeTileRecords = homeRootObject.children;
    return homeTileRecords;
  };
  // A workspace may be represented by several independently placed Home
  // tiles. Remember the exact physical tile that opened it: desk transit still
  // resolves its return lid through data-module, while data-viewport-module
  // remains the stable semantic workspace identity for every duplicate.
  const returnTileByModule = new Map();
  const moduleKeyOf = (node) => String(node?.dataset?.viewportModule || node?.dataset?.module || "");
  const returnTileFor = (moduleKey) => {
    const key = String(moduleKey || "");
    const remembered = returnTileByModule.get(key);
    const tile = homeTileRecords.find((candidate) => homeTileModuleKey(candidate) === key && candidate.tile.id === remembered)
      || homeTileRecords.find((candidate) => homeTileModuleKey(candidate) === key)
      || null;
    if (tile) returnTileByModule.set(key, tile.tile.id);
    else returnTileByModule.delete(key);
    return tile;
  };
  const routeModuleReturnTo = (root, moduleKey, tileId) => {
    const key = String(moduleKey || "");
    const buckets = [...(root?.querySelectorAll?.(":scope > .crm-home-grid > .crm-home-bucket[data-viewport-module]") || [])]
      .filter((bucket) => moduleKeyOf(bucket) === key);
    const target = buckets.find((bucket) => bucket.dataset.tileId === String(tileId || "")) || buckets[0] || null;
    buckets.forEach((bucket) => {
      if (bucket === target) bucket.dataset.module = key;
      else bucket.removeAttribute("data-module");
    });
    if (target) {
      returnTileByModule.set(key, target.dataset.tileId);
      root.dataset.returnModule = key;
      root.dataset.returnTileId = target.dataset.tileId;
    }
    return target;
  };
  const restoreModuleRouting = (root) => {
    [...(root?.querySelectorAll?.(":scope > .crm-home-grid > .crm-home-bucket[data-viewport-module]") || [])]
      .forEach((bucket) => { bucket.dataset.module = moduleKeyOf(bucket); });
    if (root) {
      delete root.dataset.returnModule;
      delete root.dataset.returnTileId;
    }
  };

  const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[char]));
  const cssValue = (value) => window.CSS?.escape?.(String(value ?? "")) || String(value ?? "").replace(/["\\]/g, "\\$&");
  const firstText = (...values) => values.map((value) => String(value ?? "").trim()).find(Boolean) || "";
  const closeHomeTileMenu = () => {
    if (homeTileMenuOutsideClose) {
      document.removeEventListener("pointerdown", homeTileMenuOutsideClose, true);
      homeTileMenuOutsideClose = null;
    }
    homeTileMenu?.remove();
    homeTileMenu = null;
  };
  const writeHomeTiles = () => {
    if (window.crmHomePreviews?.isCaptureWorker) return;
    try { localStorage.setItem(HOME_TILE_STORE_KEY, JSON.stringify(homeTileRecords)); } catch {}
  };
  const rebuildHomeTiles = (refreshKey = MODULES[0]?.key || "people") => {
    closeHomeTileMenu();
    const rebuild = () => {
      camera?.rebuildRoot?.();
      camera?.layout?.();
      mountAll();
      requestAnimationFrame(() => syncMotionSnapshot());
      requestMotionSnapshot();
      // A tile mutation changes both Home geometry and the physical ids used
      // by per-tile cutouts. Queue one canonical room refresh immediately; its
      // existing capture pipeline finishes by publishing a new Home motion
      // snapshot, and captureBaseline registers that work with previewSyncs.
      // Navigation can therefore await the exact new layout instead of racing
      // an unrelated background refresh.
      if (!window.crmHomePreviews?.isCaptureWorker) void captureBaseline(refreshKey);
      contextAddChanged("home-tiles");
    };
    if (camera?.isTransitioning?.()) camera.whenSettled?.().then(rebuild);
    else rebuild();
  };
  const createHomeTile = (moduleKey, options = {}) => {
    const module = MODULES.find((candidate) => candidate.key === String(moduleKey || ""));
    if (!module) return null;
    const suffix = crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const id = String(options.id || `home-${module.key}-${suffix}`);
    if (homeTileRecords.some((tile) => tile.tile.id === id)) return null;
    const tile = normalizeHomeTile({ id, moduleKey:module.key, label:firstText(options.label, module.label) }, homeTileRecords.length);
    if (!tile) return null;
    replaceHomeTileRecords([...homeTileRecords, tile]);
    writeHomeTiles(); rebuildHomeTiles(module.key);
    return clone(tile);
  };
  const removeHomeTile = (tileId) => {
    const removedId = String(tileId || "");
    const removed = homeTileForId(removedId);
    if (!removed || isCanonicalHomeTile(removed)) return false;
    const next = homeTileRecords.filter((tile) => tile.tile.id !== removedId);
    replaceHomeTileRecords(next.map((tile, rank) => normalizeHomeTile(tile, rank)));
    const removedModuleKey = homeTileModuleKey(removed);
    if (removed && returnTileByModule.get(removedModuleKey) === removedId) {
      returnTileByModule.delete(removedModuleKey);
    }
    writeHomeTiles(); rebuildHomeTiles(removedModuleKey);
    return true;
  };
  const openHomeTileMenu = (tileId, bucket, x, y) => {
    closeHomeTileMenu();
    if (!canRemoveHomeTile(tileId) || !bucket?.isConnected) return null;
    const id = String(tileId);
    const menu = document.createElement("div");
    menu.className = "crm-home-tile-menu crm-menu-surface";
    menu.dataset.homeTileMenu = id;
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Home tile options");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "crm-menu-action tk-menu-danger";
    remove.dataset.homeTileDelete = id;
    remove.setAttribute("role", "menuitem");
    remove.textContent = "Delete tile";
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeHomeTileMenu();
      removeHomeTile(id);
    });
    menu.appendChild(remove);
    document.body.appendChild(menu);
    homeTileMenu = menu;
    const menuRect = menu.getBoundingClientRect();
    const bucketRect = bucket.getBoundingClientRect();
    const anchorX = Number.isFinite(Number(x)) && Number(x) > 0
      ? Number(x)
      : bucketRect.right - 18;
    const anchorY = Number.isFinite(Number(y)) && Number(y) > 0
      ? Number(y)
      : bucketRect.top + 18;
    menu.style.left = `${Math.max(8, Math.min(innerWidth - menuRect.width - 8, anchorX))}px`;
    menu.style.top = `${Math.max(48, Math.min(innerHeight - menuRect.height - 8, anchorY))}px`;
    homeTileMenuOutsideClose = (event) => {
      if (homeTileMenu?.contains(event.target)) return;
      closeHomeTileMenu();
    };
    document.addEventListener("pointerdown", homeTileMenuOutsideClose, true);
    requestAnimationFrame(() => remove.focus({ preventScroll:true }));
    return menu;
  };
  const resetHomeTiles = () => {
    replaceHomeTileRecords(defaultHomeTiles());
    returnTileByModule.clear();
    writeHomeTiles(); rebuildHomeTiles();
    return clone(homeTileRecords);
  };
  const startOfToday = () => { const date = new Date(); date.setHours(0, 0, 0, 0); return date.getTime(); };
  const dueTime = (item) => { const value = Date.parse(item?.dueAt || ""); return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY; };
  const dayKey = (value) => {
    const raw = String(value || ""); const prefix = /^\d{4}-\d{2}-\d{2}/.exec(raw)?.[0] || "";
    if (!prefix || !raw.includes("T") || /T00:00:00(?:\.000)?Z$/i.test(raw)) return prefix;
    const date = new Date(raw); return Number.isFinite(date.getTime()) ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` : prefix;
  };
  const dayNumber = (key) => { const [year, month, day] = String(key).split("-").map(Number); return year && month && day ? Date.UTC(year, month - 1, day) / DAY_MS : Number.POSITIVE_INFINITY; };
  const todayKey = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
  const plateDayOffset = (item) => dayNumber(dayKey(item?.dueAt)) - dayNumber(todayKey());
  const isOnHomePlate = (item) => Number.isFinite(plateDayOffset(item)) && plateDayOffset(item) <= HOME_HAND_WINDOW_DAYS;
  const isDone = (item) => ["completed", "cancelled", "canceled"].includes(String(item?.status || "").toLowerCase());

  const ensureStyles = () => {
    if (document.getElementById("crm-home-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-home-styles";
    style.textContent = `
      .crm-home-surface{position:fixed;inset:0;z-index:820;pointer-events:none;overflow:hidden}
      .crm-home-surface[hidden]{display:none}.crm-home-level{position:absolute;inset:0;transform-origin:0 0;
        isolation:isolate;contain:paint;will-change:transform;backface-visibility:hidden}
      /* Keep exactly one decoded Home camera texture resident while another
         workspace is active. The semantic [hidden] state and inert z-order are
         preserved, but avoiding display:none prevents Windows/Viz from cold-
         allocating Home's render surface during the first reverse frame. */
      .crm-home-surface[data-crm-home-retained]{
        display:block!important;
        pointer-events:none!important;visibility:visible!important}
      .crm-home-surface[data-crm-home-retained][data-crm-home-inactive-retained]{z-index:0!important}
      .crm-home-surface[data-crm-home-retained]:not([data-crm-home-inactive-retained]){z-index:4500!important}
      .crm-home-surface[data-crm-home-retained] .crm-home-level>:is(.crm-home-grid,.crm-home-title-layer,.crm-home-priority-hand){
        visibility:hidden!important;pointer-events:none!important}
      .crm-home-surface[data-crm-home-retained] .crm-home-level>.crm-home-motion-snapshot{
        display:none!important}
      .crm-home-surface[data-crm-home-retained] .crm-home-level>.crm-home-motion-variant{
        display:none!important}
      .crm-home-surface[data-crm-home-retained][data-crm-home-inactive-retained]
        .crm-home-level>.crm-home-motion-variant.is-active-motion-variant{
        display:block!important;visibility:visible!important;opacity:.001!important;
        transform:translateZ(0)!important;will-change:transform,opacity;
        pointer-events:none!important}
      .crm-home-surface[data-crm-home-retained]:not([data-crm-home-inactive-retained])
        .crm-home-level>.crm-home-motion-variant.is-active-motion-variant{
        display:block!important;visibility:visible!important;opacity:1!important;
        transform:translateZ(0)!important;will-change:transform,opacity;
        pointer-events:none!important}
      /* The retained reverse-camera bitmap is the only Home layer needed
         while another workspace owns the viewport. Leaving the two fixed
         screen-space blur planes mounted at .001 still makes Viz execute both
         full-viewport backdrop passes on every active-room frame. They are
         shown again automatically when the camera removes [hidden] before a
         contraction, so this changes no transition pixels. */
      .crm-home-surface[data-crm-home-retained]>
        :is(.crm-home-screen-acrylic-clip,.crm-home-peripheral-acrylic-clip){
        display:none!important}
      /* Inactive rooms that finished their idle baseline stay rasterized behind
         Home instead of returning to display:none and paying their first paint
         during a camera move. The attribute is semantic-only: [hidden] remains
         present, the room is one .001 compositor group, and no descendant can
         enter hit testing. */
      html body [data-crm-home-precomposed]:not(.crm-theater){
        display:block!important;position:fixed!important;inset:0!important;
        width:100vw!important;height:100vh!important;opacity:.001!important;
        z-index:0!important;pointer-events:none!important;transition:none!important}
      html body [data-crm-home-precomposed]:not(.crm-theater)[data-crm-home-precompose-promoted]{
        opacity:var(--crm-home-precompose-opacity,1)!important;
        z-index:var(--crm-home-precompose-z,836)!important;
        pointer-events:var(--crm-home-precompose-pointer,auto)!important}
      html body [data-crm-home-precomposed]:not(.crm-theater)[data-crm-home-precompose-seated]:not([data-crm-home-precompose-promoted]){
        visibility:hidden!important}
      html body [data-crm-home-precomposed]:not(.crm-theater)[data-crm-home-precompose-seated][data-crm-home-precompose-promoted]{
        visibility:visible!important}
      /* Card-system rooms canonically use display:contents so their fixed
         buckets keep body-level stacking. Preserve that topology while parked;
         only the finite set of actual top-level paint owners is dimmed. A
         block wrapper here would remove and re-add the entire card tree to
         layout at the endpoint. */
      html body .crm-theater[data-crm-home-precomposed]{
        display:contents!important;position:static!important;inset:auto!important;
        width:auto!important;height:auto!important;opacity:1!important;
        pointer-events:auto!important}
      html body .crm-theater[data-crm-home-precomposed]>
        :not(.tk-zones){opacity:.001!important;pointer-events:none!important;transition:none!important}
      html body .crm-theater[data-crm-home-precomposed]>
        .tk-zones>*{opacity:.001!important;pointer-events:none!important;transition:none!important}
      /* pointer-events:none on a retained display:contents paint owner does
         not fence descendants that explicitly opt back into auto. Card rails
         do that for their clip, track, buckets and controls, so an inactive
         transparent rail could remain above the next room and steal its clicks.
         Gate only those finite interactive owners from the semantic [hidden]
         state; the retained compositor tree and its .001 warm paint stay intact. */
      html body .crm-theater[hidden][data-crm-home-precomposed] :is(
        .tk-deck.is-fanned,.tk-card,.tk-restore,.tk-arrow,.tk-stack-btn,.tk-bar,
        .tk-zone,.tk-zone-hd-r,.tk-zsb,
        .tk-zone-hclip,.tk-zone-htrack,.tk-zone-hsb,.tk-zone-hth,
        .tk-zone-vclip,.tk-zone-vtrack,.tk-zone-vsb,.tk-zone-vth
      ){pointer-events:none!important}
      html body .crm-theater[data-crm-home-precomposed]>
        [data-crm-home-precompose-promoted],
      html body .crm-theater[data-crm-home-precomposed]>
        .tk-zones>[data-crm-home-precompose-promoted]{
        opacity:var(--crm-home-precompose-opacity,1)!important;
        pointer-events:var(--crm-home-precompose-pointer,auto)!important}
      /* A focused room has already completed its native-size factory/layout
         pass. Cull only its finite paint owners while Home is visibly moving:
         a large card room can contain 1,200+ descendants, and retaining that
         second scene at .001 still makes Viz composite every descendant layer.
         The zero-area clip preserves geometry without an inherited visibility
         change; promotion removes it beneath the opaque endpoint raster. */
      html body [data-crm-home-motion-parked-owner]{
        clip-path:inset(50%)!important;pointer-events:none!important;transition:none!important}
      /* Returning Home retires only each room's finite compositor owners.
         Keeping the precomposed root selector stable avoids restyling the
         complete canonical tree; opacity zero culls every retired paint and
         backdrop pass. */
      html body [data-crm-home-precomposed]:not(.crm-theater)[data-crm-home-released-owner],
      html body .crm-theater[data-crm-home-precomposed]>
        [data-crm-home-released-owner],
      html body .crm-theater[data-crm-home-precomposed]>
        .tk-zones>[data-crm-home-released-owner]{
        opacity:0!important;pointer-events:none!important;transition:none!important}
      .crm-home-motion-snapshot.crm-home-preview-image,
      .crm-home-motion-variant.crm-home-preview-image{display:none;position:absolute;inset:0;z-index:2;width:100%;height:100%;object-fit:fill;
        pointer-events:none;user-select:none;backface-visibility:hidden}
      .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-motion-variant.is-active-motion-variant{display:block;opacity:.001;transform:translateZ(0)}
      .crm-home-surface.crm-home-camera-moving.crm-home-bitmap-motion .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-motion-variant.is-active-motion-variant,
      .crm-home-surface.crm-home-camera-handoff .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-motion-variant.is-active-motion-variant{display:block;opacity:1}
      /* During camera motion the decoded cut-out raster is the sole Home
         owner. Keeping the live grid/hand/title tree beneath that identical
         image still asks Chromium to composite every backdrop surface on its
         first transformed frame. Hide those live owners until the covered
         endpoint exchange; their geometry and state remain resident. */
      .crm-home-surface.crm-home-camera-moving.crm-home-bitmap-motion .crm-home-level>:is(.crm-home-grid,.crm-home-title-layer,.crm-home-priority-hand){
        visibility:hidden!important}
      /* Home geometry remains resident throughout the return. Never blend two
         translucent acrylic scenes: complementary opacity creates a light
         trough, while overlapping complete scenes creates a dark double-glass
         pulse. Keep the moving scene fully owned while its sharp preview
         morphs to the resting filter and the live scene precomposites beneath
         it, then exchange the pixel-matched owners in one covered update. */
      .crm-home-surface.crm-home-camera-handoff .crm-home-grid{z-index:1;opacity:1!important;transition:none!important}
      .crm-home-surface.crm-home-camera-handoff .crm-home-priority-hand{z-index:1}
      .crm-home-surface.crm-home-camera-handoff .crm-home-grid>.crm-home-bucket,
      .crm-home-surface.crm-home-camera-handoff .crm-home-priority-hand>.crm-home-hand-card{
        animation:none!important;transition:none!important}
      .crm-home-surface.crm-home-camera-handoff .crm-home-grid>.crm-home-bucket,
      .crm-home-surface.crm-home-camera-handoff .crm-home-priority-hand{
        visibility:visible;opacity:.001!important;transition:none!important}
      .crm-home-surface.crm-home-camera-handoff .crm-home-title-layer{
        visibility:visible;opacity:.001;transition:none!important}
      .crm-home-surface.crm-home-camera-handoff .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-motion-variant.is-active-motion-variant,
      .crm-home-surface.crm-home-camera-handoff>.crm-home-expander:not(.crm-home-warm){
        opacity:1!important;transition:none!important}
      .crm-home-surface.crm-home-camera-handoff>.crm-home-expander:not(.crm-home-warm) .crm-home-preview-foreground{
        filter:none;opacity:1!important;transition:none!important}
      .crm-home-expander .crm-home-preview-resting-filter{
        z-index:2;filter:blur(.65px) saturate(.95) brightness(.88);
        opacity:0;transform:translateZ(0);transition:none;will-change:opacity}
      .crm-home-warm .crm-home-preview-resting-filter,
      .crm-home-recycled-expander .crm-home-preview-resting-filter{
        opacity:1!important}
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-releasing .crm-home-title-layer{
        opacity:.001!important;transition:none!important}
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-releasing .crm-home-grid>.crm-home-bucket,
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-releasing .crm-home-priority-hand{
        opacity:.001!important;transition:none!important}
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-releasing
        .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-motion-variant.is-active-motion-variant,
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-releasing>.crm-home-expander:not(.crm-home-warm){
        opacity:1!important;transition:none!important}
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-releasing>
        .crm-home-expander:not(.crm-home-warm) .crm-home-preview-foreground{
        filter:none!important;opacity:0!important;
        transition:opacity ${HOME_RETURN_INGRESS_MS}ms ${HOME_RETURN_HANDOFF_EASE}!important}
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-releasing>
        .crm-home-expander:not(.crm-home-warm) .crm-home-preview-resting-filter{
        opacity:1!important;
        transition:opacity ${HOME_RETURN_INGRESS_MS}ms ${HOME_RETURN_HANDOFF_EASE}!important}
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-committing .crm-home-title-layer,
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-committing .crm-home-grid>.crm-home-bucket,
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-committing .crm-home-priority-hand{
        opacity:1!important;transition:none!important}
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-committing .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-motion-variant.is-active-motion-variant,
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-committing>.crm-home-expander:not(.crm-home-warm){
        opacity:.001!important;
        transition:none!important}
      /* The expander owns the selected room during travel. One precomposed
         variant carries every other Home object with the selected tile cut
         transparent and remains the covered owner while Home prepares for the
         endpoint exchange. */
      .crm-home-surface.crm-home-camera-moving.crm-home-bitmap-motion .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-grid>.crm-home-bucket:not(.is-camera-target)>.crm-home-preview{
        visibility:hidden}
      /* The motion cut-out carries the peripheral tiles' translucent coats,
         edges and contents, but a bitmap cannot carry backdrop-filter. One
         fixed, full-screen blur plane sits beneath that texture and is clipped
         to every moving tile silhouette. The selected lens keeps its tint and
         frame but delegates its backdrop to this same plane, so only one
         full-screen blur pass exists while the clip moves. */
      .crm-home-peripheral-acrylic-clip{position:absolute;inset:0;z-index:1;box-sizing:border-box;
        pointer-events:none;overflow:hidden;transform:translateZ(0);backface-visibility:hidden}
      .crm-home-peripheral-acrylic-defs{position:absolute;inset:0;width:100%;height:100%;
        overflow:visible;pointer-events:none}
      .crm-home-peripheral-screen-acrylic{position:absolute;inset:0;box-sizing:border-box;pointer-events:none;
        background:transparent;opacity:.001;transform:translateZ(0);
        will-change:opacity,backdrop-filter;backface-visibility:hidden}
      .crm-home-surface.crm-home-peripheral-acrylic-active>.crm-home-level:first-child{z-index:2!important}
      /* At rest the same union-clipped plane owns the Home tiles' backdrop.
         Their individual nodes retain every tint, edge and shadow but do not
         each schedule another full-screen blur pass. Besides making Home a
         one-pass scene, this keeps the exact transition surface genuinely
         resident before the first click instead of relying on an opacity
         prewarm that Viz is allowed to elide. */
      .crm-home-surface.crm-home-shared-resting-acrylic
        >.crm-home-level:first-child>.crm-home-grid>.crm-home-bucket{
        -webkit-backdrop-filter:none!important;backdrop-filter:none!important}
      /* The real selected tile and the full-size lid trade opacity while their
         geometry is identical. Its acrylic, preview and shadow therefore have
         one continuous owner instead of disappearing and being rebuilt. */
      .crm-home-surface[data-level="1"] .crm-home-level:first-child>.crm-home-grid>.crm-home-bucket.is-camera-target{opacity:0}
      .crm-home-surface.crm-home-camera-expanding .crm-home-level:first-child>.crm-home-grid>.crm-home-bucket.is-camera-target{
        opacity:0;transition:opacity 70ms ease!important}
      .crm-home-surface.crm-home-camera-contracting .crm-home-level:first-child>.crm-home-grid>.crm-home-bucket.is-camera-target{
        opacity:0;transition:none!important}
      .crm-home-grid{position:absolute;z-index:1;display:grid;pointer-events:auto;will-change:transform;contain:layout style;
        grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:var(--crm-object-gap,18px)}
      .crm-home-title-layer{position:absolute;z-index:4;display:grid;pointer-events:none;contain:layout style;
        grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:var(--crm-object-gap,18px)}
      .crm-home-title-slot{position:relative;min-width:0;min-height:0}
      .crm-home-bucket{position:relative;box-sizing:border-box;display:block;min-height:0;overflow:hidden;color:#fff;
        cursor:pointer;border:0;container-type:size;border-radius:var(--home-r,16px);padding:0;will-change:transform;
        background:linear-gradient(180deg,rgba(22,26,36,.34),rgba(12,16,24,.28));
        -webkit-backdrop-filter:blur(28px) saturate(140%);backdrop-filter:blur(28px) saturate(140%);
        box-shadow:inset 0 0 0 1px rgba(255,255,255,.14),inset 0 1px 0 rgba(255,255,255,.18),0 14px 26px -16px rgba(0,0,0,.72);
        transition:box-shadow .18s ease,background .18s ease}
      /* Home consumes the canonical glass material, but its adjacent
         surfaces cannot also consume the menu's large floating shadow. That
         shadow overlaps into a single clipped rectangle around the grid. */
      .crm-home-bucket.crm-menu-surface{box-shadow:inset 0 1px 0 var(--crm-menu-highlight),0 14px 26px -16px rgba(0,0,0,.72)!important}
      .crm-home-bucket:hover{background:linear-gradient(180deg,rgba(40,55,76,.27),rgba(18,26,38,.23));
        box-shadow:inset 0 0 0 1px rgba(166,196,236,.27),inset 0 1px rgba(255,255,255,.15),0 14px 26px -16px rgba(0,0,0,.72)}
      .crm-home-title-glass{position:absolute;z-index:4;left:17px;bottom:30px;max-width:calc(100% - 34px);
        padding:0;text-align:left;pointer-events:none;opacity:.94;background:none;border:0;box-shadow:none;
        transition:opacity .16s ease;display:block}
      .crm-home-title{font:650 clamp(15px,1.25vw,16px)/1.2 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;letter-spacing:.008em;
        max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(246,249,253,.91);
        text-rendering:geometricPrecision;font-synthesis:none;text-shadow:0 1px 1px rgba(0,0,0,.86)}
      .crm-home-title-slot.is-deemphasized .crm-home-title-glass{opacity:.28}
      .crm-home-preview{position:absolute;inset:0;z-index:1;overflow:hidden;contain:paint;border-radius:inherit;color:rgba(255,255,255,.62)}
      .crm-home-preview-state{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;gap:9px;
        pointer-events:none;opacity:1;visibility:visible;transition:opacity .18s ease,visibility 0s linear 0s;
        font:600 10px/1 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;letter-spacing:.075em;text-transform:uppercase;
        color:rgba(225,234,246,.6)}
      .crm-home-preview-state-mark{position:relative;width:14px;height:14px;border:1px solid rgba(224,235,249,.26);border-radius:50%}
      .crm-home-preview-state-mark::after{content:"";position:absolute;inset:-1px;border:1px solid transparent;border-top-color:rgba(229,239,252,.68);
        border-radius:inherit;animation:crm-home-preview-turn 1.05s linear infinite}
      .crm-home-preview[data-preview-state="ready"]>.crm-home-preview-state,
      .crm-home-preview[data-preview-state="stale"]>.crm-home-preview-state{opacity:0;visibility:hidden;transition:opacity .18s ease,visibility 0s linear .18s}
      @keyframes crm-home-preview-turn{to{transform:rotate(1turn)}}
      .crm-home-preview-image{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:cover;pointer-events:none;
        z-index:1;user-select:none;transform:none;transform-origin:center;backface-visibility:hidden}
      /* Each tile is one inert raster. Keep the resting depth cue genuinely
         subtle: the prior 1.8px filter obscured the canonical objects enough
         to make a fully-settled Home look like an unfinished loading state. */
      .crm-home-preview-foreground{filter:blur(.65px) saturate(.95) brightness(.88);transition:filter .18s ease}
      .crm-home-bucket:is(.is-preview-hovered,:focus-visible) .crm-home-preview-foreground{filter:blur(0) saturate(.96) brightness(.9)}
      /* These are the card system's real .tk-card objects. Home contributes
         only the held-hand geometry and compositor-friendly reveal motion. */
      .crm-home-priority-hand{position:absolute;z-index:9;left:0;right:0;bottom:0;height:var(--home-hand-reserve,280px);
        overflow:visible;pointer-events:none;contain:layout style}
      .crm-home-priority-hand[hidden]{display:none}
      .crm-home-todo-popover{position:fixed;z-index:9360;width:min(340px,calc(100vw - 28px));padding:10px;display:grid;gap:8px}
      .crm-home-todo-fields{display:grid;grid-template-columns:minmax(0,1fr) 112px;gap:7px}.crm-home-todo-fields>.crm-menu-input:first-child{grid-column:1/-1}
      .crm-home-todo-actions{display:flex;justify-content:flex-end;gap:2px;padding-top:1px}
      .crm-home-todo-popover .crm-menu-action{height:32px;font-size:var(--crm-type-body,12px)!important}
      .crm-home-todo-menu{position:fixed;z-index:9365;width:166px;padding:6px;display:grid;gap:1px}.crm-home-todo-menu .crm-menu-action{height:33px;text-align:left;font-size:var(--crm-type-body,12px)!important}
      .crm-home-tile-menu{position:fixed;z-index:9368;width:158px;padding:6px;display:grid;gap:1px}
      .crm-home-tile-menu .crm-menu-action{height:33px;text-align:left;font-size:var(--crm-type-body,12px)!important}
      .crm-home-hand-trigger{position:absolute;z-index:1;left:50%;bottom:0;width:var(--home-hand-span,760px);height:92px;
        transform:translateX(-50%);pointer-events:auto}
      .crm-home-priority-hand>.crm-home-hand-card.tk-card{position:absolute;left:50%;right:auto;bottom:52px;z-index:var(--hand-z,10);
        pointer-events:auto;cursor:pointer;
        transform-origin:50% 108%;transform:translateX(calc(-50% + var(--hand-x,0px))) translateY(var(--hand-rest-y,180px)) rotate(var(--hand-rot,0deg));
        transition:transform .38s cubic-bezier(.22,1,.26,1),box-shadow .18s ease}
      .crm-home-priority-hand.is-seating>.crm-home-hand-card.tk-card{transition:none}
      .crm-home-priority-hand:is(:hover,:focus-within)>.crm-home-hand-card.tk-card{
        transform:translateX(calc(-50% + var(--hand-x,0px))) translateY(var(--hand-open-y,0px)) rotate(var(--hand-open-rot,var(--hand-rot,0deg))) scale(.9)}
      .crm-home-priority-hand:is(:hover,:focus-within)>.crm-home-hand-card.tk-card:is(:hover,:focus-visible){z-index:1000;
        transform:translateX(calc(-50% + var(--hand-x,0px))) translateY(calc(var(--hand-open-y,0px) - 6px)) rotate(var(--hand-open-rot,var(--hand-rot,0deg))) scale(.92);
        box-shadow:inset 0 0 0 9999px rgba(255,255,255,.12),inset 0 1px rgba(255,255,255,.34),0 22px 48px rgba(0,0,0,.44)}
      .crm-home-hand-empty{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);font-size:9px;letter-spacing:.1em;
        text-transform:uppercase;color:rgba(218,228,242,.25);white-space:nowrap}
      @media(prefers-reduced-motion:reduce){
        .crm-home-priority-hand>.crm-home-hand-card.tk-card,
        .crm-home-title-glass{transition-duration:.01ms}
        .crm-home-preview-state-mark::after{animation:none}
      }
      /* The transition lid is full-viewport. It must stay neutral in Electron's
         native app-region map or its temporary rectangle can cancel (and on
         Windows, outlive) the persistent title-bar drag strip. */
      .crm-home-bucket.crm-home-expander{position:absolute;z-index:5;pointer-events:none;transform-origin:0 0;
        overflow:visible;border:0!important;background:transparent!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;box-shadow:none!important;
        will-change:transform,opacity;backface-visibility:hidden}
      .crm-home-transition-acrylic{position:absolute;inset:0;z-index:0;box-sizing:border-box;pointer-events:none;
        border:1px solid var(--crm-menu-border,rgba(255,255,255,.22));border-radius:var(--fractal-source-radius-x,28px) / var(--fractal-source-radius-y,28px);
        background:transparent;-webkit-backdrop-filter:none;backdrop-filter:none;
        box-shadow:inset 0 1px 0 var(--crm-menu-highlight,rgba(255,255,255,.24)),0 14px 26px -16px rgba(0,0,0,.72);
        opacity:0;transform:translateZ(0);will-change:opacity,transform}
      .crm-home-expander[data-fractal-frame="source"]>.crm-home-transition-acrylic{opacity:1}
      .crm-home-surface.crm-home-camera-expanding .crm-home-title-glass{visibility:hidden;opacity:0!important;transition:none!important}
      /* Freeze only the resting tiles. The expander is also a
         .crm-home-bucket; matching it here disabled the actual zoom. */
      /* The selected tile's acrylic is a fixed screen-space lens whose clip
         follows the transformed tile. Do not flatten or disable its backdrop:
         the live blur/saturation is the material the user sees during travel,
         while the transformed child owns only the matching edge and shadow. */
      .crm-home-expander .crm-home-title-glass{display:none}
      .crm-home-expander .crm-home-preview{opacity:1;border-radius:0;box-shadow:none}
      .crm-home-expander .crm-home-preview-foreground{filter:none;transform:none;opacity:1;transition:none}
      /* The exact room capture is decoded with every expander but does not
         participate in camera motion. Desk transit seats it only after the
         transform has completed, giving destination materialization one
         opaque, pixel-stable raster lid instead of a translucent foreground
         cutout that could double-paint acrylic objects. */
      .crm-home-expander .crm-home-preview-exact{display:none;filter:none;transform:none;opacity:1;transition:none}
      .crm-home-expander.crm-home-endpoint-cover[data-crm-endpoint-cover="exact"] .crm-home-preview-exact{display:block;z-index:3}
      .crm-home-expander.crm-home-endpoint-cover[data-crm-endpoint-cover="exact"] .crm-home-preview-foreground{visibility:hidden}
      .crm-home-expander.crm-home-endpoint-cover[data-crm-endpoint-cover="foreground"] .crm-home-preview-exact{display:none}
      .crm-home-expander.crm-home-endpoint-cover[data-crm-endpoint-cover="foreground"] .crm-home-preview-foreground{visibility:visible;z-index:3}
      .crm-home-expander.crm-home-endpoint-cover[data-crm-endpoint-cover="surface"] .crm-home-preview-state-mark::after{animation-play-state:paused}
      /* The warm expander itself is already at .001 opacity. Keep its one
         transparent room texture composited so the first camera frame never
         performs a wallpaper-sized upload. */
      .crm-home-warm .crm-home-preview-foreground{opacity:1!important;transform:translateZ(0);will-change:transform,opacity}
      .crm-home-warm>.crm-home-transition-acrylic{opacity:1!important;animation:none!important}
      .crm-home-surface.crm-home-motion-priming .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-motion-snapshot{
        display:block;opacity:.001;transform:translateZ(0)}
      .crm-home-surface.crm-home-motion-priming .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-motion-variant{
        display:block;opacity:.001;transform:translateZ(0)}
      .crm-home-warm,.crm-home-warm *{pointer-events:none!important}
      /* The one room lid needed for the next reverse camera remains attached
         to Home at a compositor-only opacity while that room is active. Its
         transparent foreground was already uploaded during the forward dive;
         detaching the element discarded that upload and made the first return
         frame recreate a viewport-sized texture. */
      .crm-home-recycled-expander{
        z-index:0!important;opacity:.001!important;visibility:visible!important;
        pointer-events:none!important;transition:none!important;
        transform:translateZ(0)!important}
      .crm-home-recycled-expander .crm-home-preview-foreground{
        display:block!important;visibility:visible!important;opacity:1!important;
        transform:translateZ(0)!important}
      .crm-home-recycled-expander .crm-home-preview-exact{display:none!important}
    `;
    document.head.appendChild(style);
  };

  const previewStateHTML = () => `<div class="crm-home-preview-state" role="status" aria-live="polite">
    <i class="crm-home-preview-state-mark" aria-hidden="true"></i><span>Preparing view</span></div>`;
  const bucketHTML = (module) => `<div class="crm-home-preview" data-preview-key="${esc(homeTileModuleKey(module))}" data-preview-state="waiting" aria-label="Loading preview">${previewStateHTML()}</div>`;
  const titleHTML = (module) => `<div class="crm-home-title-slot" data-module="${esc(homeTileModuleKey(module))}" data-tile-id="${esc(module.tile?.id || homeTileModuleKey(module))}">
    <div class="crm-home-title-glass"><div class="crm-home-title">${esc(homeTileLabel(module))}</div></div></div>`;

  const imageNode = (className, src, decoding = "async") => {
    const image = document.createElement("img");
    image.className = `crm-home-preview-image ${className}`;
    image.decoding = decoding;
    if (src) image.src = src;
    image.alt = ""; image.draggable = false;
    return image;
  };
  const ensurePreviewState = (host) => {
    if (!host || host.querySelector(":scope > .crm-home-preview-state")) return;
    host.insertAdjacentHTML("afterbegin", previewStateHTML());
  };
  const isRenderablePreview = (preview) => !!preview?.foregroundSrc && !!preview?.exactSrc
    && MODULES.some(({ key }) => key === preview.key);
  const isCurrentPreview = (preview) => preview?.version === HOME_PREVIEW_VERSION;
  const mountHost = (host, preview, exact = false, exactOnly = false) => {
    if (!host || !isRenderablePreview(preview)) return false;
    const stamp = String(preview.capturedAt || 0);
    const previewState = isCurrentPreview(preview) ? "ready" : "stale";
    const mountedForeground = host.querySelector(":scope > .crm-home-preview-foreground");
    const mountedExact = host.querySelector(":scope > .crm-home-preview-exact");
    if (host.dataset.capturedAt === stamp
      && (exactOnly ? !mountedForeground : !!mountedForeground)
      && (!exact || !!mountedExact)
      && host.dataset.previewVersion === String(preview.version || "")
      && host.dataset.previewState === previewState) return true;
    ensurePreviewState(host);
    host.style.removeProperty("--far-shift-y");
    let foreground = host.querySelector(":scope > .crm-home-preview-foreground");
    if (exactOnly) {
      foreground?.remove();
      foreground = null;
    } else if (!foreground) {
      foreground = imageNode("crm-home-preview-foreground", preview.foregroundSrc);
      host.appendChild(foreground);
    } else {
      if (foreground.src !== preview.foregroundSrc) foreground.src = preview.foregroundSrc;
    }
    if (foreground) {
      foreground.dataset.previewVariant = "filtered";
      host.querySelector(":scope > .crm-home-preview-sharp")?.remove();
    }
    if (exact) {
      let full = host.querySelector(":scope > .crm-home-preview-exact");
      if (!full) { full = imageNode("crm-home-preview-exact", preview.exactSrc, "sync"); host.appendChild(full); }
      else if (full.src !== preview.exactSrc) full.src = preview.exactSrc;
    }
    host.dataset.previewState = previewState;
    host.dataset.previewVersion = String(preview.version || "");
    host.dataset.capturedAt = stamp;
    host.dataset.previewWidth = String(preview.width || 0);
    host.dataset.previewHeight = String(preview.height || 0);
    host.closest(".crm-home-bucket")?.setAttribute("data-preview-ready", "true");
    return true;
  };
  const mountPreview = (key) => {
    const hosts = [...(camera?.layers?.()[0]?.querySelectorAll(`.crm-home-bucket[data-viewport-module="${cssValue(key)}"] .crm-home-preview`) || [])];
    return hosts.reduce((mounted, host) => mountHost(host, previews.get(key), false) || mounted, false);
  };
  const mountAll = () => MODULES.forEach(({ key }) => mountPreview(key));
  const revealSharpPreview = (bucket) => {
    if (!bucket) return;
    bucket.classList.add("is-preview-hovered");
    bucket.closest(".crm-home-level")?.querySelector(`:scope > .crm-home-title-layer > .crm-home-title-slot[data-tile-id="${cssValue(bucket.dataset.tileId)}"]`)?.classList.add("is-deemphasized");
  };
  const restSharpPreview = (bucket) => {
    if (!bucket || bucket.matches(":focus-visible")) return;
    bucket.classList.remove("is-preview-hovered");
    bucket.closest(".crm-home-level")?.querySelector(`:scope > .crm-home-title-layer > .crm-home-title-slot[data-tile-id="${cssValue(bucket.dataset.tileId)}"]`)?.classList.remove("is-deemphasized");
  };
  const previewCommitBlocked = () => !camera?.isActive?.()
    || (!homeEndpointSettling && (
      !!camera?.isTransitioning?.()
      || !!camera?.surface?.()?.classList.contains("crm-home-camera-moving")
      || !!camera?.surface?.()?.classList.contains("crm-home-camera-handoff")
      || !!window.crmDeskTransit?.isBusy?.()
    ));
  const preloadSource = (src, cacheKey = "") => {
    const cached = cacheKey ? decodedPreviewSources.get(cacheKey) : null;
    if (cached?.src === src) return cached.promise;
    const image = new Image();
    image.alt = "";
    image.draggable = false;
    image.decoding = "sync";
    let settled = false;
    let resolveReady = null;
    const entry = {
      src,
      image,
      ready:false,
      promise:new Promise((resolve) => { resolveReady = resolve; }),
    };
    if (cacheKey) decodedPreviewSources.set(cacheKey, entry);
    const finish = () => {
      if (settled) return;
      settled = true;
      entry.ready = image.complete && image.naturalWidth > 0;
      resolveReady(image);
    };
    image.onload = finish;
    image.onerror = finish;
    image.src = src;
    image.decode?.().then(finish).catch(() => {});
    return entry.promise;
  };
  const commitPreview = (preview) => {
    const existing = previews.get(preview.key);
    const existingAspect = Number(existing?.width) > 0 && Number(existing?.height) > 0 ? existing.width / existing.height : 0;
    const nextAspect = Number(preview.width) > 0 && Number(preview.height) > 0 ? preview.width / preview.height : 0;
    previews.set(preview.key, preview);
    prebuiltExpanders.delete(preview.key);
    if (camera?.isActive?.() && camera.level() === 0) {
      mountPreview(preview.key);
      if (nextAspect && Math.abs(nextAspect - existingAspect) > .0005 && !camera.isTransitioning?.()) {
        camera.layout();
        requestAnimationFrame(() => syncMotionSnapshot());
      }
      schedulePrebuiltExpanders();
    }
    return true;
  };
  const flushPendingPreviews = () => {
    clearTimeout(previewCommitTimer); previewCommitTimer = 0;
    if (previewCommitBlocked()) {
      // Inactive Home deliberately retains its last decoded composition for
      // the return camera. Do not poll from a live room; activation/settlement
      // explicitly flushes the queued replacement.
      if (camera?.isActive?.()) previewCommitTimer = setTimeout(flushPendingPreviews, 48);
      return;
    }
    pendingPreviews.forEach((entry, key) => {
      if (!entry.ready) return;
      pendingPreviews.delete(key);
      commitPreview(entry.preview);
    });
  };
  const acceptPreview = (preview, replaceCurrent = false) => {
    if (!isRenderablePreview(preview)) return false;
    const existing = previews.get(preview.key);
    const pending = pendingPreviews.get(preview.key)?.preview;
    const newest = pending && Number(pending.capturedAt || 0) >= Number(existing?.capturedAt || 0) ? pending : existing;
    // Renderer-only reloads can briefly straddle Electron host versions. Keep a
    // current image when one exists, but render an older valid image instead of
    // turning the tile into an empty rectangle while the host catches up.
    if (!replaceCurrent && isCurrentPreview(newest) && !isCurrentPreview(preview)) return true;
    if (newest?.version === preview.version && newest?.capturedAt === preview.capturedAt
      && newest?.foregroundSrc === preview.foregroundSrc && newest?.exactSrc === preview.exactSrc) return true;
    if (!pending && existing?.foregroundSrc === preview.foregroundSrc && existing?.exactSrc === preview.exactSrc) {
      return commitPreview(preview);
    }
    const sequence = ++previewDecodeSequence;
    const entry = { preview, sequence, ready:false };
    pendingPreviews.set(preview.key, entry);
    Promise.all([
      preloadSource(preview.foregroundSrc, `${preview.key}:foreground`),
      preloadSource(preview.exactSrc, `${preview.key}:exact`),
    ]).then(() => {
      if (pendingPreviews.get(preview.key)?.sequence !== sequence) return;
      entry.ready = true;
      flushPendingPreviews();
    });
    return true;
  };
  const acceptPreviewBatch = (batch, replaceCurrent = false) => {
    const staged = [];
    (Array.isArray(batch) ? batch : []).forEach((preview) => {
      if (!isRenderablePreview(preview)) return;
      const existing = previews.get(preview.key);
      const pending = pendingPreviews.get(preview.key)?.preview;
      const newest = pending
        && Number(pending.capturedAt || 0) >= Number(existing?.capturedAt || 0)
        ? pending
        : existing;
      if (!replaceCurrent && isCurrentPreview(newest) && !isCurrentPreview(preview)) return;
      if (newest?.version === preview.version
        && newest?.capturedAt === preview.capturedAt
        && newest?.foregroundSrc === preview.foregroundSrc
        && newest?.exactSrc === preview.exactSrc) return;
      if (!pending && existing?.foregroundSrc === preview.foregroundSrc
        && existing?.exactSrc === preview.exactSrc) {
        commitPreview(preview);
        return;
      }
      const sequence = ++previewDecodeSequence;
      const entry = { preview, sequence, ready:false };
      pendingPreviews.set(preview.key, entry);
      staged.push(entry);
    });
    if (!staged.length) return false;
    // Decode the complete room set behind one barrier. The former independent
    // promises made Home visibly populate in capture order even though main
    // had prepared one semantic batch.
    Promise.all(staged.flatMap(({ preview }) => [
      preloadSource(preview.foregroundSrc, `${preview.key}:foreground`),
      preloadSource(preview.exactSrc, `${preview.key}:exact`),
    ])).then(() => {
      staged.forEach((entry) => {
        if (pendingPreviews.get(entry.preview.key)?.sequence === entry.sequence) {
          entry.ready = true;
        }
      });
      flushPendingPreviews();
    });
    return true;
  };
  const motionLayoutSignature = (root = camera?.layers?.()[0]) => {
    if (!root) return "";
    const rectOf = (node) => {
      if (!node) return [];
      return [node.offsetLeft, node.offsetTop, node.offsetWidth, node.offsetHeight];
    };
    const grid = root.querySelector(":scope > .crm-home-grid");
    const hand = root.querySelector(":scope > .crm-home-priority-hand");
    return JSON.stringify({
      viewport: [innerWidth, innerHeight, devicePixelRatio],
      grid: rectOf(grid),
      buckets: [...(grid?.querySelectorAll(":scope > .crm-home-bucket") || [])].map((bucket) => [bucket.dataset.tileId || moduleKeyOf(bucket), moduleKeyOf(bucket), ...rectOf(bucket)]),
      hand: rectOf(hand),
      cards: [...(hand?.querySelectorAll(":scope > .crm-home-hand-card") || [])].map((card) => [
        card.dataset.priorityId || "", ...rectOf(card), getComputedStyle(card).transform,
      ]),
    });
  };
  const selectMotionVariant = (root, key = "") => {
    if (!root) return false;
    let selected = false;
    root.querySelectorAll(":scope > .crm-home-motion-variant").forEach((image) => {
      const active = !!key && (image.dataset.motionTileId || image.dataset.motionVariant) === key;
      image.classList.toggle("is-active-motion-variant", active);
      selected ||= active;
    });
    root.dataset.motionVariant = selected ? key : "";
    return selected;
  };
  const syncMotionSnapshot = (root = camera?.layers?.()[0]) => {
    if (!root) return;
    let image = root.querySelector(":scope > .crm-home-motion-snapshot");
    if (!image) {
      image = imageNode("crm-home-motion-snapshot", "");
      root.prepend(image);
    }
    const signatureMatches = () => !!motionSnapshot?.layoutSignature
      && motionSnapshot.layoutSignature === motionLayoutSignature(root);
    const tileKeys = new Set([...(root.querySelectorAll(":scope > .crm-home-grid > .crm-home-bucket") || [])]
      .map((bucket) => bucket.dataset.tileId || moduleKeyOf(bucket))
      .filter(Boolean));
    const variants = Object.entries(motionSnapshot?.variants || {}).filter(([key, src]) => tileKeys.has(key) && !!src);
    if (!motionSnapshot?.src || variants.length !== tileKeys.size || !signatureMatches()) {
      root.dataset.motionSnapshotReady = "false";
      return;
    }
    const stamp = String(motionSnapshot.capturedAt || "");
    if (image.dataset.motionCapturedAt !== stamp) {
      image.dataset.motionCapturedAt = stamp;
      image.src = motionSnapshot.src;
    }
    const expectedKeys = new Set(variants.map(([key]) => key));
    root.querySelectorAll(":scope > .crm-home-motion-variant").forEach((node) => {
      if (!expectedKeys.has(node.dataset.motionTileId || node.dataset.motionVariant || "")) node.remove();
    });
    const variantImages = variants.map(([key, src]) => {
      let variant = root.querySelector(`:scope > .crm-home-motion-variant[data-motion-tile-id="${cssValue(key)}"]`);
      if (!variant) {
        variant = imageNode("crm-home-motion-variant", "", "sync");
        variant.dataset.motionTileId = key;
        root.insertBefore(variant, image.nextSibling);
      }
      // Keep the legacy module label for diagnostics and motion-contract
      // consumers while selecting duplicate viewport tiles by unique id.
      const bucket = root.querySelector(`:scope > .crm-home-grid > .crm-home-bucket[data-tile-id="${cssValue(key)}"]`);
      variant.dataset.motionVariant = moduleKeyOf(bucket) || key;
      if (variant.dataset.motionCapturedAt !== stamp) {
        variant.dataset.motionCapturedAt = stamp;
        variant.src = src;
      }
      return variant;
    });
    const images = [image, ...variantImages];
    const selectedReady = () => {
      const selected = root.querySelector(":scope > .crm-home-motion-variant.is-active-motion-variant");
      return !!root.dataset.motionVariant
        && selected?.dataset?.motionCapturedAt === stamp
        && selected.complete
        && selected.naturalWidth > 0;
    };
    const ready = () => {
      // A superseded decode may finish after a newer snapshot has already
      // seated its complete cutouts. It no longer owns root readiness and must
      // never overwrite the newer true state with a stale false result.
      if (String(motionSnapshot?.capturedAt || "") !== stamp) return;
      if (root !== camera?.layers?.()[0] || !root.isConnected) return;
      const signatureReady = signatureMatches();
      const allReady = images.every((node) => node.complete && node.naturalWidth > 0);
      // Camera motion consumes the one selected cutout. Preserve its exact,
      // stamp-matched readiness while an unrelated dormant tile finishes
      // decoding instead of demoting the return path for that boundary frame.
      root.dataset.motionSnapshotReady = String(signatureReady && (allReady || selectedReady()));
      if (!allReady || !signatureReady) {
        return;
      }
      const target = root.querySelector(".crm-home-bucket.is-camera-target");
      selectMotionVariant(root, target?.dataset?.tileId || target?.dataset?.module || "");
      const surface = camera?.surface?.();
      if (surface && root.dataset.motionPrimedAt !== stamp && !surface.classList.contains("crm-home-motion-priming")) {
        root.dataset.motionPrimedAt = stamp;
        surface.classList.add("crm-home-motion-priming");
        requestAnimationFrame(() => requestAnimationFrame(() => surface.classList.remove("crm-home-motion-priming")));
      }
    };
    if (images.every((node) => node.complete && node.naturalWidth > 0)) ready();
    else {
      root.dataset.motionSnapshotReady = String(selectedReady());
      Promise.all(images.map((node) => node.decode?.().catch(() => null) || Promise.resolve())).then(ready);
    }
  };
  const commitMotionSnapshot = (snapshot) => {
    if (!snapshot?.src || !snapshot?.layoutSignature) return false;
    if (motionSnapshot?.version === HOME_PREVIEW_VERSION && snapshot.version !== HOME_PREVIEW_VERSION) return true;
    motionSnapshot = snapshot;
    clearTimeout(motionSnapshotSettleTimer);
    const settle = (attempt = 0) => {
      motionSnapshotSettleTimer = 0;
      const root = camera?.layers?.()[0];
      syncMotionSnapshot(root);
      if (root?.dataset?.motionSnapshotReady === "true" || attempt >= 10) return;
      // A resize can deliver the new raster in the same task that lays out the
      // hand. Recheck across the short seating window instead of permanently
      // rejecting an otherwise exact snapshot on that boundary frame.
      motionSnapshotSettleTimer = setTimeout(() => settle(attempt + 1), 48);
    };
    settle();
    return true;
  };
  const flushPendingMotionSnapshot = () => {
    clearTimeout(motionCommitTimer); motionCommitTimer = 0;
    if (!pendingMotionSnapshot) return;
    if (previewCommitBlocked()) {
      if (camera?.isActive?.()) motionCommitTimer = setTimeout(flushPendingMotionSnapshot, 48);
      return;
    }
    const snapshot = pendingMotionSnapshot;
    pendingMotionSnapshot = null;
    commitMotionSnapshot(snapshot);
  };
  const acceptMotionSnapshot = (snapshot) => {
    if (!snapshot?.src || !snapshot?.layoutSignature) return false;
    if (previewCommitBlocked()) {
      if (!pendingMotionSnapshot || Number(snapshot.capturedAt || 0) >= Number(pendingMotionSnapshot.capturedAt || 0)) pendingMotionSnapshot = snapshot;
      if (camera?.isActive?.() && !motionCommitTimer) motionCommitTimer = setTimeout(flushPendingMotionSnapshot, 48);
      return true;
    }
    return commitMotionSnapshot(snapshot);
  };
  const requestMotionSnapshot = async () => {
    try { acceptMotionSnapshot((await window.crmHomePreviews?.motionSnapshot?.())?.snapshot); } catch {}
  };
  const requestPreviews = async (reset = false) => {
    clearTimeout(retryTimer);
    retryTimer = 0;
    if (reset) retryAttempt = 0;
    const captureWorker = !!window.crmHomePreviews?.isCaptureWorker;
    if (!captureWorker && previewCommitBlocked()) {
      // Home owns no visible pixels while another room is active. Polling its
      // multi-megabyte preview bundle there can deserialize on the renderer in
      // the middle of Calendar/Planner motion. Activation and preview-change
      // subscriptions are authoritative restart points; only a still-active
      // Home camera needs a short deferred retry.
      if (camera?.isActive?.()) {
        retryTimer = setTimeout(() => requestPreviews(false), 180);
      }
      return;
    }
    try { acceptPreviewBatch((await window.crmHomePreviews?.list?.())?.previews || []); } catch {}
    if (MODULES.every(({ key }) => isCurrentPreview(previews.get(key)))) return;
    retryTimer = setTimeout(() => requestPreviews(false), RETRY_MS[Math.min(retryAttempt++, RETRY_MS.length - 1)]);
  };
  const priorityWeight = (item) => ({ critical: 900, urgent: 800, high: 650, overdue: 620, medium: 180, normal: 0 }
    [String(item?.priority || "").toLowerCase()] || 0);
  const assignedTo = (item, username) => !!username && String(item?.assignee || "").trim().toLowerCase() === username;
  const priorityScore = (item, username) => {
    const days = plateDayOffset(item);
    let score = priorityWeight(item);
    if (assignedTo(item, username)) score += 1100;
    if (days < 0) score += 1600 + Math.min(500, Math.abs(days) * 24);
    else if (days < 1) score += 1350;
    else if (days < 2) score += 980;
    else if (days < 4) score += 700;
    else if (days <= 14) score += 420 - days * 12;
    if (/reply|respond|follow|call|invoice|bill|payment/.test(`${item?.kind || ""} ${item?.title || ""}`.toLowerCase())) score += 160;
    if (firstText(item?.assignedBy, item?.assigner)) score += 90;
    return score;
  };
  const choosePriorityItems = (records, username = "") => {
    const userKey = String(username || "").trim().toLowerCase();
    return records.filter((item) => {
      if (!item || item.deletedAt || isDone(item) || !priorityLink(item) || !isOnHomePlate(item)) return false;
      const assignee = String(item.assignee || "").trim().toLowerCase();
      if (userKey && assignee && assignee !== userKey) return false;
      return true;
    }).sort((a, b) => priorityScore(b, userKey) - priorityScore(a, userKey) || dueTime(a) - dueTime(b)).slice(0, HAND_LIMIT);
  };
  const priorityLink = (item) => {
    const links = Array.isArray(item?.links) ? item.links : [];
    const explicit = ["workItems", "tickets", "contacts", "tasks"]
      .map((entityType) => links.find((link) => link?.entityType === entityType && link?.recordId))
      .find(Boolean) || null;
    if (explicit) return explicit;
    if (item?.sourceEntity && item?.sourceId && TODO_LINK_ENTITIES.has(item.sourceEntity)) {
      return { entityType: item.sourceEntity, recordId: item.sourceId, relation: "source" };
    }
    return null;
  };
  const dueLabel = (item) => {
    const due = dueTime(item); if (!Number.isFinite(due)) return firstText(item.attentionLabel, item.assignee ? "Assigned" : "Up next");
    const day = plateDayOffset(item);
    if (day < 0) return `${Math.abs(day)}d overdue`;
    if (day === 0) {
      const raw = String(firstText(item.dueAt, item.dueDate, item.date) || "");
      const calendarDay = /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z)?$/i.test(raw);
      if (calendarDay) return "Today";
      const time = new Date(due);
      return time.getHours() || time.getMinutes() ? `Today · ${time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Today";
    }
    if (day === 1) return "Tomorrow";
    return new Date(due).toLocaleDateString([], { month: "short", day: "numeric" });
  };
  const contextLabel = (item, username = "") => {
    if (item.context) return item.context;
    const assignedBy = firstText(item.assignedBy, item.assigner);
    if (assignedBy) return `Assigned by ${assignedBy}`;
    if (assignedTo(item, String(username).toLowerCase())) return "Assigned to you";
    if (item.assignee) return `Assigned to ${item.assignee}`;
    const link = priorityLink(item);
    if (link?.entityType === "workItems") return firstText(item.projectTitle, item.stageLabel, "Pipeline card");
    if (link?.entityType === "contacts") return "Person follow-up";
    if (link?.entityType === "tickets") return "Ticket work";
    if (link?.entityType === "tasks") return "Task";
    return "Personal task";
  };
  const cardReasonOf = (item) => {
    const linkType = priorityLink(item)?.entityType;
    if (linkType === "workItems") return "pipeline-work";
    if (linkType === "tickets") return "ticket-work";
    if (linkType === "contacts") return "person-work";
    if (linkType === "tasks") return "task-work";
    if (item.todayReason) return item.todayReason;
    const text = `${item.kind || ""} ${item.title || ""}`.toLowerCase();
    if (/invoice|bill|payment/.test(text)) return dueTime(item) < startOfToday() ? "invoice-overdue" : "invoice-due";
    if (/reply|respond/.test(text)) return "next-touch";
    if (/follow|reach out|call/.test(text)) return "contact-touch";
    return "task";
  };
  const cardPriorityOf = (item) => {
    const value = String(item.priority || "").toLowerCase();
    if (["critical", "urgent", "overdue"].includes(value)) return "critical";
    if (value === "high") return "high";
    if (["medium", "normal"].includes(value)) return "medium";
    return "none";
  };
  const cardRecordOf = (item, username = "") => {
    const link = priorityLink(item); const context = contextLabel(item, username); const reason = dueLabel(item);
    return {
      ...item,
      id: String(item.id || ""),
      title: firstText(item.title, "Important next action"),
      companyLabel: firstText(item.title, "Important next action"),
      host: context,
      description: context,
      priority: cardPriorityOf(item),
      targetEntity: link?.entityType || "",
      targetId: link?.recordId || "",
      todayReason: cardReasonOf(item),
      todayRow: { ...(item.todayRow || {}), dueDate: "", stageLabel: reason, assignee: item.assignee || "" },
    };
  };
  const prioritySignature = (item) => {
    const link = priorityLink(item);
    return [item.id, item.title, item.status, item.priority, item.dueAt, item.assignee, item.attentionLabel, item.context, link?.entityType || "", link?.recordId || ""];
  };
  const openPriorityTicket = (ticketId) => {
    if (priorityTicketOpen) return priorityTicketOpen;
    priorityTicketOpen = (async () => {
      const moved = window.crmWorkspaces?.active?.() === "cases"
        || await (window.crmDeskTransit?.driveTo?.("cases") || Promise.resolve(window.crmWorkspaces?.setActive?.("cases")));
      if (!moved && window.crmWorkspaces?.active?.() !== "cases") return false;
      // The Home card has left the viewport by this point. Let the ticket
      // subsystem choose and reveal its real stack/bucket card so the detail
      // animation has one stable source in the active Tickets world.
      await window.crmHome?.waitForModuleSettled?.("cases");
      return window.ticketStacks?.open?.(ticketId) || false;
    })().finally(() => { priorityTicketOpen = null; });
    return priorityTicketOpen;
  };
  const openPriorityItem = (item, sourceCard) => {
    const link = priorityLink(item);
    if (link?.entityType === "workItems" && link.recordId) window.crmPlanner?.openItem?.(link.recordId);
    else if (link?.entityType === "tickets" && link.recordId) openPriorityTicket(link.recordId);
    else if (link?.entityType && link?.recordId) window.crmRecordWorld?.open?.(link.entityType, link.recordId, sourceCard);
    else Promise.resolve(window.crmDeskTransit?.driveTo?.("assignments") || window.crmWorkspaces?.setActive?.("assignments"))
      .then(() => window.crmAssignments?.open?.(item.id));
  };
  const closeTodoPopover = () => {
    if (todoOutsideClose) document.removeEventListener("pointerdown", todoOutsideClose, true);
    todoOutsideClose = null; todoPopover?.remove(); todoPopover = null;
  };
  const placeTodoPopover = (element, anchor, x, y) => {
    document.body.appendChild(element);
    const anchorRect = anchor?.getBoundingClientRect(); const bounds = element.getBoundingClientRect();
    const left = Math.max(10, Math.min(innerWidth - bounds.width - 10, Number.isFinite(x) ? x : (anchorRect?.left || innerWidth / 2) - bounds.width / 2));
    const top = Math.max(48, Math.min(innerHeight - bounds.height - 12, Number.isFinite(y) ? y : (anchorRect?.top || innerHeight / 2) - bounds.height - 7));
    element.style.left = `${left}px`; element.style.top = `${top}px`;
  };
  const armTodoOutsideClose = (element) => setTimeout(() => {
    if (todoPopover !== element) return;
    todoOutsideClose = (event) => {
      if (element.contains(event.target)) return;
      closeTodoPopover();
    };
    document.addEventListener("pointerdown", todoOutsideClose, true);
  }, 0);
  const openTodoComposer = async (anchor, item = null) => {
    closeTodoPopover();
    // Home is a projection of linked work, never an authoring surface. The
    // relationship is owned by the source object and cannot be changed here.
    if (!item || !priorityLink(item)) return false;
    const dueValue = item?.dueAt && Number.isFinite(Date.parse(item.dueAt)) ? new Date(item.dueAt).toISOString().slice(0, 10) : "";
    const rawPriority = String(item?.priority || "normal").toLowerCase();
    const priorityValue = ["critical","overdue"].includes(rawPriority) ? "urgent" : ["urgent","high","normal"].includes(rawPriority) ? rawPriority : "normal";
    todoPopover = document.createElement("form"); todoPopover.className = "crm-home-todo-popover crm-menu-surface"; todoPopover.setAttribute("aria-label", "Edit linked task");
    todoPopover.innerHTML = `<div class="crm-home-todo-fields">
      <input class="crm-menu-input" name="title" value="${esc(item?.title || "")}" placeholder="What needs doing?" autocomplete="off" required>
      <input class="crm-menu-input" name="dueAt" type="date" value="${esc(dueValue)}" aria-label="Due date"><select class="crm-menu-input" name="priority" aria-label="Priority">${["normal","high","urgent"].map((value) => `<option value="${value}"${priorityValue === value ? " selected" : ""}>${value[0].toUpperCase() + value.slice(1)}</option>`).join("")}</select>
      </div><div class="crm-home-todo-actions"><button type="button" class="crm-menu-action" data-todo-cancel>Cancel</button><button type="submit" class="crm-menu-action">Save</button></div>`;
    todoPopover.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(todoPopover);
      const due = String(data.get("dueAt") || ""); const fields = { title:String(data.get("title") || "").trim(), dueAt:due ? new Date(`${due}T17:00:00`).toISOString() : null, priority:String(data.get("priority") || "normal") };
      const saved = await updateTodo(item, fields);
      if (saved) closeTodoPopover();
    });
    todoPopover.querySelector("[data-todo-cancel]")?.addEventListener("click", closeTodoPopover);
    placeTodoPopover(todoPopover, anchor); armTodoOutsideClose(todoPopover);
    requestAnimationFrame(() => todoPopover?.elements?.title?.focus());
  };
  const updateTodo = async (item, fields) => {
    if (!item?.id || String(item.id).startsWith("signal:")) return false;
    let result = await window.crmDomain?.update?.("commitments", item.id, fields, item.version);
    if (!result?.record) {
      const latest = (await window.crmDomain?.list?.("commitments", { includeDeleted:false, limit:300 }))?.records?.find((record) => String(record.id) === String(item.id));
      if (latest) result = await window.crmDomain?.update?.("commitments", item.id, fields, latest.version);
    }
    if (result?.record) { scheduleHandRefresh(); return true; }
    return false;
  };
  const openTodoMenu = (item, card, x, y) => {
    closeTodoPopover(); todoPopover = document.createElement("div"); todoPopover.className = "crm-home-todo-menu crm-menu-surface";
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(17, 0, 0, 0);
    const link = priorityLink(item);
    [
      { key:"open", label:"Open", run:() => openPriorityItem(item, card) },
      link?.entityType !== "workItems" && { key:"edit", label:"Edit", run:() => openTodoComposer(card, item) },
      { key:"tomorrow", label:"Due tomorrow", run:() => updateTodo(item, { dueAt:tomorrow.toISOString() }) },
      { key:"complete", label:"Complete", run:() => updateTodo(item, { status:"completed", completedAt:new Date().toISOString(), outcome:"Completed from Home" }) },
    ].filter(Boolean).forEach((action) => {
      const button = document.createElement("button"); button.type = "button"; button.className = "crm-menu-action"; button.textContent = action.label;
      button.dataset.todoAction = action.key;
      button.addEventListener("click", () => { closeTodoPopover(); action.run(); }); todoPopover.appendChild(button);
    });
    placeTodoPopover(todoPopover, card, x, y); armTodoOutsideClose(todoPopover);
  };
  const layoutPriorityHand = (hand = camera?.layers?.()[0]?.querySelector?.(".crm-home-priority-hand")) => {
    if (!hand) return; const cards = [...hand.querySelectorAll(".crm-home-hand-card.tk-card")];
    if (!cards.length) { hand.style.setProperty("--home-hand-span", "220px"); return; }
    const width = cards[0].offsetWidth || 185; const height = cards[0].offsetHeight || 279;
    const maxSpan = Math.min(innerWidth - 44, 760); const step = cards.length > 1 ? Math.min(width * .62, (maxSpan - width) / (cards.length - 1)) : 0;
    const middle = (cards.length - 1) / 2; const peek = 128; const baseBottom = 52; const openDrop = 33;
    cards.forEach((card, index) => {
      const distance = index - middle; const arc = Math.min(18, distance * distance * 2.35); const rotation = Math.max(-15, Math.min(15, distance * 4.2));
      card.style.setProperty("--hand-x", `${(distance * step).toFixed(2)}px`);
      card.style.setProperty("--hand-rot", `${rotation.toFixed(2)}deg`);
      card.style.setProperty("--hand-open-rot", `${(rotation * .72).toFixed(2)}deg`);
      card.style.setProperty("--hand-open-y", `${(openDrop + arc * .1).toFixed(2)}px`);
      card.style.setProperty("--hand-rest-y", `${(baseBottom + height - peek + arc).toFixed(2)}px`);
    });
    hand.style.setProperty("--home-hand-span", `${Math.min(innerWidth - 24, width + step * Math.max(0, cards.length - 1) + 64).toFixed(2)}px`);
  };
  const fillPriorityHand = (hand) => {
    if (!hand) return;
    const renderSignature = JSON.stringify(priorityItems.map(prioritySignature));
    hand.dataset.username = priorityUsername;
    hand.dataset.renderSignature = renderSignature;
    hand.classList.toggle("is-empty", priorityItems.length === 0);
    hand.replaceChildren();
    if (!priorityItems.length) {
      const empty = document.createElement("div"); empty.className = "crm-home-hand-empty"; empty.textContent = "Nothing due today"; hand.appendChild(empty); return;
    }
    const renderer = window.crmToday?.createCard;
    if (typeof renderer !== "function") {
      const empty = document.createElement("div"); empty.className = "crm-home-hand-empty"; empty.textContent = "Preparing priority cards"; hand.appendChild(empty); return;
    }
    const trigger = document.createElement("div"); trigger.className = "crm-home-hand-trigger"; trigger.setAttribute("aria-hidden", "true"); hand.appendChild(trigger);
    priorityItems.forEach((item, index) => {
      const link = priorityLink(item);
      const card = renderer(cardRecordOf(item, priorityUsername), {
        ariaLabel: `${firstText(item.title, "Important next action")}. ${dueLabel(item)}`,
        onOpen: (_record, sourceCard) => openPriorityItem(item, sourceCard),
      });
      card.classList.add("crm-home-hand-card");
      card.dataset.priorityId = String(item.id || "");
      if (link?.entityType) card.dataset.recordEntity = link.entityType;
      if (link?.recordId) card.dataset.recordId = link.recordId;
      card.dataset.commitmentId = String(item.id || "");
      card.addEventListener("pointerenter", () => {
        const target = link?.entityType === "tickets" ? "cases"
          : link?.entityType === "workItems" ? "planner" : "assignments";
        void preparePrecomposedModule(target);
      });
      card.addEventListener("contextmenu", (event) => { event.preventDefault(); event.stopPropagation(); openTodoMenu(item, card, event.clientX, event.clientY); });
      card.style.setProperty("--hand-z", String(20 + index));
      hand.appendChild(card);
    });
  };
  const renderPriorityHand = () => {
    const hand = camera?.layers?.()[0]?.querySelector?.(".crm-home-priority-hand"); if (!hand) return;
    const renderSignature = JSON.stringify(priorityItems.map(prioritySignature));
    if (hand.dataset.renderSignature === renderSignature && hand.dataset.username === priorityUsername) {
      layoutPriorityHand(hand); camera?.layout?.(); syncMotionSnapshot(); return;
    }
    hand.classList.add("is-seating");
    fillPriorityHand(hand);
    // The hand is measured and seated in the same task that creates it. Its
    // default CSS variables therefore never reach a paint and cannot fan out
    // one frame late after Home becomes visible.
    layoutPriorityHand(hand);
    camera?.layout?.();
    syncMotionSnapshot();
    requestAnimationFrame(() => { if (hand.isConnected) hand.classList.remove("is-seating"); });
  };
  const refreshPriorityHand = async () => {
    if (!camera?.isActive?.() || !window.crmDomain?.list) return;
    const generation = ++handRefreshGeneration;
    try {
      const [result, session] = await Promise.all([
        window.crmDomain.list("commitments", { includeDeleted: false, limit: 300 }),
        window.auth?.session?.().catch?.(() => null) || null,
      ]);
      if (generation !== handRefreshGeneration) return;
      priorityUsername = session?.user?.username || "";
      priorityItems = choosePriorityItems(result?.records || [], priorityUsername);
      handDirty = false;
      renderPriorityHand();
    } catch {}
  };
  const scheduleHandRefresh = () => {
    handDirty = true;
    clearTimeout(handRefreshTimer);
    if (!camera?.isActive?.() || camera?.isTransitioning?.() || window.crmDeskTransit?.isBusy?.()) return;
    handRefreshTimer = setTimeout(refreshPriorityHand, 120);
  };
  const canPrewarmFactory = () => !!camera?.isActive?.()
    && camera.level() === 0
    && !camera?.isTransitioning?.()
    && !window.crmDeskTransit?.isBusy?.()
    && performance.now() >= factoryPrewarmAfter;
  const moduleKeyForTheater = (node) => node?.dataset?.crmTheater === "tickets" ? "cases" : String(node?.dataset?.crmTheater || "");
  const precomposeOwnersOf = (node) => {
    if (!node?.matches?.(".crm-theater")) return [];
    return [
      ...[...node.children].filter((child) => !child.matches(".tk-zones")),
      ...node.querySelectorAll(":scope > .tk-zones > *"),
    ];
  };
  const motionPaintOwnersOf = (node) => {
    if (!node?.matches?.(".crm-theater")) return node ? [node] : [];
    const granular = [
      ...node.querySelectorAll(":scope > .tk-zones .tk-zone"),
      ...node.querySelectorAll(":scope > .tk-zones .tk-zone-hacrylic-lens"),
      ...node.querySelectorAll(":scope [data-crm-acrylic-owner]"),
      ...node.querySelectorAll(":scope > .tk-stacks"),
      ...node.querySelectorAll(":scope > .tk-scrim"),
    ];
    return granular.length ? [...new Set(granular)] : precomposeOwnersOf(node);
  };
  const clearMotionPaintParking = (node) => {
    if (!node) return false;
    node.removeAttribute("data-crm-home-motion-parked");
    // Acrylic prewarm temporarily exempts real shared blur planes from their
    // root's zero-area paint clip, then parks those planes explicitly when the
    // finite warm pass ends. A boxed camera surface is itself the normal paint
    // owner, so its nested exemptions are not returned by
    // motionPaintOwnersOf(). Clear every actual parked descendant when that
    // surface is promoted; otherwise its room becomes visible while the one
    // real acrylic plane remains clipped by the !important parking selector.
    const parkedOwners = new Set([
      ...motionPaintOwnersOf(node),
      ...node.querySelectorAll("[data-crm-home-motion-parked-owner]"),
    ]);
    parkedOwners.forEach((owner) => {
      owner.removeAttribute("data-crm-home-motion-parked-owner");
    });
    return true;
  };
  const parkMotionPaint = (node) => {
    if (!node) return false;
    node.setAttribute("data-crm-home-motion-parked", "");
    motionPaintOwnersOf(node).forEach((owner) => {
      owner.setAttribute("data-crm-home-motion-parked-owner", "");
    });
    return true;
  };
  const rememberPrecomposeOwners = (node) => {
    if (node && !node.matches?.(".crm-theater")) {
      if (node.dataset.crmHomePrecomposeOwner !== "true") {
        const style = getComputedStyle(node);
        node.style.setProperty("--crm-home-precompose-opacity", style.opacity || "1");
        node.style.setProperty("--crm-home-precompose-z", style.zIndex || "836");
        node.style.setProperty("--crm-home-precompose-pointer", style.pointerEvents || "auto");
        node.dataset.crmHomePrecomposeOwner = "true";
      }
      return;
    }
    precomposeOwnersOf(node).forEach((owner) => {
      if (owner.dataset.crmHomePrecomposeOwner === "true") return;
      const style = getComputedStyle(owner);
      owner.style.setProperty("--crm-home-precompose-opacity", style.opacity || "1");
      owner.style.setProperty("--crm-home-precompose-z", style.zIndex || "auto");
      owner.style.setProperty("--crm-home-precompose-pointer", style.pointerEvents || "auto");
      owner.dataset.crmHomePrecomposeOwner = "true";
    });
  };
  const setPrecomposedModulePromoted = (key, promoted) => {
    const theater = key === "cases" ? "tickets" : key;
    const node = document.querySelector(
      `[data-crm-theater="${theater}"][data-crm-home-precomposed]`,
    );
    if (!node) return false;
    node.removeAttribute("data-crm-home-released-owner");
    clearMotionPaintParking(node);
    rememberPrecomposeOwners(node);
    node.hidden = false;
    if (!node.matches?.(".crm-theater")) {
      node.toggleAttribute("data-crm-home-precompose-promoted", !!promoted);
      node.inert = !promoted;
      if (promoted) node.removeAttribute("aria-hidden");
      else node.setAttribute("aria-hidden", "true");
      return true;
    }
    node.removeAttribute("data-crm-home-precompose-promoted");
    precomposeOwnersOf(node).forEach((owner) => {
      owner.removeAttribute("data-crm-home-released-owner");
      owner.toggleAttribute("data-crm-home-precompose-promoted", !!promoted);
    });
    if (promoted) {
      node.hidden = false;
      node.removeAttribute("aria-hidden");
    } else {
      node.setAttribute("aria-hidden", "true");
    }
    return true;
  };
  const releasePrecomposedModule = (key) => {
    const theater = key === "cases" ? "tickets" : key;
    const node = document.querySelector(
      `[data-crm-theater="${theater}"][data-crm-home-precomposed]`,
    );
    if (!node) return false;
    delete node.__crmHomeFactoryPrewarmLease;
    node.removeAttribute("data-crm-home-precompose-promoted");
    if (node.matches?.(".crm-theater")) {
      precomposeOwnersOf(node).forEach((owner) => {
        owner.removeAttribute("data-crm-home-precompose-promoted");
        owner.setAttribute("data-crm-home-released-owner", "");
      });
    } else {
      node.setAttribute("data-crm-home-released-owner", "");
    }
    node.hidden = true;
    clearMotionPaintParking(node);
    node.inert = false;
    node.removeAttribute("aria-hidden");
    return true;
  };
  const focusPrecomposedModule = (key) => {
    const theater = key === "cases" ? "tickets" : key;
    const focused = document.querySelector(
      `[data-crm-theater="${theater}"][data-crm-home-focused-precompose="true"]`,
    );
    if (focused) {
      focused.removeAttribute("data-crm-home-released-owner");
      precomposeOwnersOf(focused).forEach((owner) => owner.removeAttribute("data-crm-home-released-owner"));
      focused.hidden = false;
      focused.removeAttribute("aria-hidden");
      return focused;
    }
    const node = document.querySelector(
      `[data-crm-theater="${theater}"][data-crm-home-precomposed]`,
    ) || [...document.querySelectorAll(`[data-crm-theater="${theater}"]`)]
      .find((candidate) => candidate.hidden);
    document.querySelectorAll("[data-crm-home-precomposed]").forEach((node) => {
      delete node.__crmHomeFactoryPrewarmLease;
      if (node.dataset.crmHomeFocusedPrecompose === "true") {
        node.hidden = true;
        node.inert = false;
        node.setAttribute("aria-hidden", "true");
        delete node.dataset.crmHomeFocusedPrecompose;
      }
      node.removeAttribute("data-crm-home-precompose-promoted");
      // Completed factories retain their native layout but no paint. Keeping
      // the released-owner selector stable means pointer intent never
      // re-styles the room's complete descendant tree just to select it.
      if (!node.hasAttribute("data-crm-home-motion-parked")) parkMotionPaint(node);
      if (node.matches?.(".crm-theater")) {
        precomposeOwnersOf(node).forEach((owner) => {
          owner.removeAttribute("data-crm-home-precompose-promoted");
          owner.setAttribute("data-crm-home-released-owner", "");
        });
      } else {
        node.setAttribute("data-crm-home-released-owner", "");
      }
    });
    // Pointer intent gives the already-built room one finite native-size paint
    // lease before navigation starts. The complete destination remains below
    // Home at .001, but its card/text surfaces and compositor resources no
    // longer cold-start after the camera has landed.
    if (node) {
      node.removeAttribute("data-crm-home-released-owner");
      precomposeOwnersOf(node).forEach((owner) => owner.removeAttribute("data-crm-home-released-owner"));
      rememberPrecomposeOwners(node);
      node.setAttribute("data-crm-home-precomposed", moduleKeyForTheater(node));
      node.dataset.crmHomeFocusedPrecompose = "true";
      node.setAttribute("aria-hidden", "true");
      // Keep the real module tree in layout. Boxed camera surfaces use `inert`
      // to exclude their complete subtree; display:contents card rooms already
      // suppress their finite top-level paint owners in CSS and avoid an
      // expensive inert accessibility-tree walk at endpoint promotion.
      node.hidden = false;
      node.inert = !node.matches?.(".crm-theater");
    }
    return node;
  };
  const preparePrecomposedModule = async (key) => {
    const node = focusPrecomposedModule(key);
    if (!node) return null;
    if (node.hasAttribute("data-crm-home-motion-parked")) return node;
    const api = window[FACTORY_API_BY_MODULE[key]] || null;
    // Idle factory prewarm has already completed this exact canonical layout.
    // Pointer intent only needs to cull its retained paint and close that
    // selector change; rerunning the geometry stability sampler can otherwise
    // spill into the click's pre-motion interval on the first large room.
    if (prewarmedFactories.has(FACTORY_API_BY_MODULE[key])) {
      parkMotionPaint(node);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return node;
    }
    if (!node.matches?.(".crm-theater")) node.removeAttribute("data-crm-home-precompose-seated");
    let settled = null;
    try { settled = await api?.waitForGeometrySettled?.(); } catch {}
    if (!node.matches?.(".crm-theater") && settled?.stable === true) {
      node.setAttribute("data-crm-home-precompose-seated", "true");
    }
    // The geometry/data factory is retained; only its offscreen paint is
    // culled. Close that non-inherited clip change before a click can begin the
    // camera so no material initialization lands in the first motion frame.
    parkMotionPaint(node);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return node;
  };
  const promotePrecomposedModule = async (key, options = {}) => {
    const theater = key === "cases" ? "tickets" : key;
    const node = document.querySelector(
      `[data-crm-theater="${theater}"][data-crm-home-precomposed]`,
    );
    if (!node) return false;
    const canContinue = typeof options.canContinue === "function"
      ? options.canContinue
      : () => true;
    node.removeAttribute("data-crm-home-released-owner");
    rememberPrecomposeOwners(node);
    node.hidden = false;
    node.inert = false;
    if (!node.matches?.(".crm-theater")) {
      node.setAttribute("data-crm-home-precompose-promoted", "");
      node.removeAttribute("aria-hidden");
      clearMotionPaintParking(node);
      // Promise continuations from a single rAF still run before that frame's
      // style/layout/paint. Two callbacks guarantee the promoted boxed room has
      // owned one complete covered paint before endpoint staging continues.
      await new Promise((resolve) => requestAnimationFrame(() =>
        requestAnimationFrame(resolve)));
      return canContinue();
    }
    node.removeAttribute("data-crm-home-precompose-promoted");
    const owners = precomposeOwnersOf(node);
    owners.forEach((owner) => {
      owner.removeAttribute("data-crm-home-released-owner");
      owner.setAttribute("data-crm-home-precompose-promoted", "");
    });
    node.removeAttribute("aria-hidden");
    // First close the cheap outer rail/deck promotion while every heavy card
    // subtree is still culled. Then reveal one independently-contained bucket
    // per native paint. A 160-person room previously instantiated all 1,232
    // descendants in one 40 ms frame despite being safely raster-covered.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (!canContinue()) return false;
    const parkedOwners = motionPaintOwnersOf(node).filter((owner) =>
      owner.hasAttribute("data-crm-home-motion-parked-owner"));
    await new Promise((resolve) => {
      let index = 0;
      const promoteNext = () => {
        if (!canContinue() || index >= parkedOwners.length) {
          resolve();
          return;
        }
        const owner = parkedOwners[index];
        if (window.__crmDeskPerformanceTrace === true) {
          const ownerName = [...owner.classList].slice(0, 2).join(".") || owner.tagName.toLowerCase();
          performance.mark(`crm-home-promote:${key}:${index}:${ownerName}`);
        }
        index += 1;
        owner.removeAttribute("data-crm-home-motion-parked-owner");
        requestAnimationFrame(promoteNext);
      };
      requestAnimationFrame(promoteNext);
    });
    if (!canContinue()) return false;
    node.removeAttribute("data-crm-home-motion-parked");
    return true;
  };
  let factoryAcrylicCover = null;
  const prepareFactoryAcrylicCover = async () => {
    const deadline = performance.now() + 20_000;
    while (!motionSnapshot?.src && canPrewarmFactory() && performance.now() < deadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    if (!motionSnapshot?.src || !canPrewarmFactory()) return null;
    if (!factoryAcrylicCover?.isConnected) {
      factoryAcrylicCover = imageNode("crm-home-factory-acrylic-cover", "", "sync");
      Object.assign(factoryAcrylicCover.style, {
        position:"fixed",
        inset:"0",
        zIndex:"819",
        width:"100vw",
        height:"100vh",
        objectFit:"fill",
        pointerEvents:"none",
        opacity:"0",
        visibility:"hidden",
      });
      factoryAcrylicCover.setAttribute("aria-hidden", "true");
      document.body.appendChild(factoryAcrylicCover);
    }
    if (factoryAcrylicCover.src !== motionSnapshot.src) {
      factoryAcrylicCover.src = motionSnapshot.src;
    }
    if (!factoryAcrylicCover.complete || factoryAcrylicCover.naturalWidth <= 0) {
      try { await factoryAcrylicCover.decode?.(); } catch {}
    }
    return factoryAcrylicCover.complete && factoryAcrylicCover.naturalWidth > 0
      ? factoryAcrylicCover
      : null;
  };
  const prewarmFactoryAcrylic = async (node) => {
    const acrylicOwners = [...(node?.querySelectorAll?.("[data-crm-acrylic-owner]") || [])];
    if (!node || !acrylicOwners.length || !canPrewarmFactory()) return true;
    const cover = await prepareFactoryAcrylicCover();
    if (!cover || !canPrewarmFactory()) return false;
    parkMotionPaint(node);
    const boxedRoom = !node.matches?.(".crm-theater");
    const outerOwners = precomposeOwnersOf(node);
    if (boxedRoom) node.setAttribute("data-crm-home-precompose-promoted", "");
    else outerOwners.forEach((owner) => {
      owner.setAttribute("data-crm-home-precompose-promoted", "");
    });
    // A boxed camera surface is its own paint owner. parkMotionPaint therefore
    // marks the root (rather than its finite child owners) as hidden; clear that
    // root marker for this covered lease or none of its real blur planes can
    // actually reach the compositor.
    if (boxedRoom) node.removeAttribute("data-crm-home-motion-parked-owner");
    acrylicOwners.forEach((owner) => owner.removeAttribute("data-crm-home-motion-parked-owner"));
    // Home itself remains the top visible surface. This matching raster sits
    // directly below it and above the inactive room, exactly mirroring the
    // endpoint's 99% cover/1% live-underpaint topology without changing a
    // visible pixel. Four closed paints allocate and raster the real blur.
    cover.style.visibility = "visible";
    cover.style.opacity = ".99";
    await new Promise((resolve) => requestAnimationFrame(() =>
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    cover.style.opacity = "0";
    cover.style.visibility = "hidden";
    acrylicOwners.forEach((owner) => owner.setAttribute("data-crm-home-motion-parked-owner", ""));
    if (boxedRoom) node.setAttribute("data-crm-home-motion-parked-owner", "");
    if (boxedRoom) node.removeAttribute("data-crm-home-precompose-promoted");
    else outerOwners.forEach((owner) => {
      owner.removeAttribute("data-crm-home-precompose-promoted");
    });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return canPrewarmFactory();
  };
  const primeInactiveTheater = async (node, api) => {
    if (!node || api?.isActive?.() || !canPrewarmFactory()) return;
    const lease = {};
    node.removeAttribute("data-crm-home-released-owner");
    clearMotionPaintParking(node);
    precomposeOwnersOf(node).forEach((owner) => owner.removeAttribute("data-crm-home-released-owner"));
    node.hidden = false;
    node.inert = !node.matches?.(".crm-theater");
    node.__crmHomeFactoryPrewarmLease = lease;
    // Capture each finite owner's native routing once while the idle factory is
    // still in its ordinary style context. Pointer intent must never interleave
    // repeated getComputedStyle reads with owner mutations.
    rememberPrecomposeOwners(node);
    node.setAttribute("data-crm-home-precomposed", moduleKeyForTheater(node));
    try {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!canPrewarmFactory()) return;
      // Finish the factory's retained native-size geometry during idle prewarm.
      // Activation can then reuse those exact values rather than writing the
      // first bucket positions under (or after) the endpoint handoff.
      if (!node.matches?.(".crm-theater")) node.removeAttribute("data-crm-home-precompose-seated");
      let settled = null;
      try { settled = await api?.waitForGeometrySettled?.(); } catch {}
      if (!node.matches?.(".crm-theater") && settled?.stable === true) {
        node.setAttribute("data-crm-home-precompose-seated", "true");
      }
      if (!await prewarmFactoryAcrylic(node)) return;
    } finally {
      // Prewarming is a finite paint/upload operation, not permanent visual
      // ownership. Retain the completed native layout, but park every finite
      // paint owner behind a zero-area, non-inherited clip. Unlike the former
      // .001 surfaces this executes no descendant backdrop passes; unlike
      // display:none it also preserves the canonical geometry.
      if (node.__crmHomeFactoryPrewarmLease === lease) {
        delete node.__crmHomeFactoryPrewarmLease;
        if (!camera?.isTransitioning?.() && !window.crmDeskTransit?.isBusy?.()) {
          node.removeAttribute("data-crm-home-precompose-promoted");
          parkMotionPaint(node);
          if (node.matches?.(".crm-theater")) {
            precomposeOwnersOf(node).forEach((owner) => {
              owner.setAttribute("data-crm-home-released-owner", "");
            });
          } else {
            node.setAttribute("data-crm-home-released-owner", "");
          }
          node.hidden = true;
          node.inert = false;
          node.setAttribute("aria-hidden", "true");
        }
      }
    }
  };
  const scheduleFactoryPrewarm = () => {
    if (window.crmHomePreviews?.isCaptureWorker || factoryPrewarmRunning || factoryPrewarmHandle || factoryPrewarmTimer
      || prewarmedFactories.size >= FACTORY_PREWARM_APIS.length || factoryPrewarmAttempts >= 30) return;
    const run = async () => {
      factoryPrewarmHandle = 0;
      if (!canPrewarmFactory()) {
        factoryPrewarmTimer = setTimeout(() => { factoryPrewarmTimer = 0; scheduleFactoryPrewarm(); }, 120);
        return;
      }
      const name = FACTORY_PREWARM_APIS.find((apiName) => !prewarmedFactories.has(apiName) && window[apiName]?.baseline);
      if (!name) {
        factoryPrewarmAttempts += 1;
        factoryPrewarmTimer = setTimeout(() => { factoryPrewarmTimer = 0; scheduleFactoryPrewarm(); }, 120);
        return;
      }
      factoryPrewarmRunning = true;
      try {
        const api = window[name];
        const theater = await api.baseline({ canRender: canPrewarmFactory });
        if (canPrewarmFactory()) await primeInactiveTheater(theater, api);
        if (canPrewarmFactory()) prewarmedFactories.add(name);
      } catch {}
      factoryPrewarmRunning = false;
      scheduleFactoryPrewarm();
    };
    if (typeof requestIdleCallback === "function") factoryPrewarmHandle = requestIdleCallback(run, { timeout: 700 });
    else factoryPrewarmHandle = requestAnimationFrame(run);
  };
  const subscribe = () => {
    if (subscribed) return;
    subscribed = true;
    try { window.crmHomePreviews?.onChanged?.(acceptPreview); } catch {}
    try { window.crmHomePreviews?.onBatchChanged?.(acceptPreviewBatch); } catch {}
    try { window.crmHomePreviews?.onMotionSnapshotChanged?.(acceptMotionSnapshot); } catch {}
    if (window.crmHomePreviews?.isCaptureWorker) { requestPreviews(true); refreshPriorityHand(); return; }
    try { window.crmDomain?.onChanged?.(scheduleHandRefresh); } catch {}
    try { window.auth?.onChanged?.(scheduleHandRefresh); } catch {}
    requestPreviews(true);
    requestMotionSnapshot();
    refreshPriorityHand();
    scheduleFactoryPrewarm();
  };

  const buildRoot = () => {
    const root = document.createElement("div"); root.className = "crm-home-level";
    const snapshot = imageNode("crm-home-motion-snapshot", ""); root.appendChild(snapshot);
    const grid = document.createElement("div"); grid.className = "crm-home-grid"; grid.dataset.crmAdaptiveTiles = "manual";
    const titleLayer = document.createElement("div"); titleLayer.className = "crm-home-title-layer";
    titleLayer.innerHTML = homeTileRecords.map(titleHTML).join("");
    mountTileChildren(grid, homeRootObject, {
      elementOptions:(module) => ({
        ariaLabel:`Open ${homeTileLabel(module)}`,
        view:"preview",
        previewKey:homeTileModuleKey(module),
        previewState:"waiting",
        previewAriaLabel:"Loading preview",
        previewHTML:previewStateHTML(),
      }),
      update:(bucket, module, _index, { created }) => {
        const key = homeTileModuleKey(module);
        bucket.dataset.module = key;
        bucket.dataset.viewportModule = key;
        bucket.dataset.enabled = "true";
        bucket.dataset.homeTileRemovable = String(!isCanonicalHomeTile(module));
        if (!created) return;
        // Do not activate merely because a tile finishes loading beneath an
        // already-stationary pointer. Actual pointer movement arms the reveal.
        bucket.addEventListener("pointermove", () => {
          if (!bucket.dataset.previewReady || bucket.classList.contains("is-preview-hovered")) return;
          revealSharpPreview(bucket);
        });
        bucket.addEventListener("pointerleave", () => {
          restSharpPreview(bucket);
        });
        bucket.addEventListener("focus", () => revealSharpPreview(bucket));
        bucket.addEventListener("blur", () => restSharpPreview(bucket));
      },
    });
    const hand = document.createElement("section"); hand.className = "crm-home-priority-hand"; hand.setAttribute("aria-label", "Important linked work due today");
    fillPriorityHand(hand); root.append(grid, titleLayer, hand);
    const activeModule = String(document.body.dataset.crmModule || "");
    const returnTile = returnTileFor(activeModule);
    if (activeModule !== "home" && returnTile) routeModuleReturnTo(root, activeModule, returnTile.tile.id);
    syncMotionSnapshot(root); requestAnimationFrame(mountAll); return root;
  };
  const layout = ({ expRect }) => {
    const surface = camera?.surface?.(); const grid = surface?.querySelector(".crm-home-grid"); const hand = surface?.querySelector(".crm-home-priority-hand"); if (!grid) return;
    homeLayoutEpoch += 1;
    const rootStyle = getComputedStyle(document.documentElement);
    const metric = (name, fallback) => parseFloat(rootStyle.getPropertyValue(name)) || fallback;
    const GAP = metric("--crm-object-gap", 18), OUTER = 18, full = expRect(); let controlsBottom = 42;
    document.querySelectorAll(".window-control-cluster").forEach((node) => { controlsBottom = Math.max(controlsBottom, node.getBoundingClientRect().bottom); });
    const top = Math.round(Math.max(controlsBottom + 14, metric("--crm-canvas-top", 78)));
    // Home geometry must not depend on an asynchronous priority query. Keep
    // the same hand reserve before, during, and after the cards arrive.
    const handReserve = Math.min(320, Math.max(254, innerWidth * .16 + 32));
    hand?.style.setProperty("--home-hand-reserve", `${handReserve.toFixed(1)}px`);
    const area = { x: OUTER, y: top, w: full.w - 2 * OUTER, h: Math.max(220, full.h - top - OUTER - handReserve) };
    // Every tile is a geometrically faithful viewport of the room it opens.
    // Artificially widening the 2x2 cells made the cached room look stretched
    // and guaranteed a scale change at the camera endpoint.
    const captured = homeTileRecords
      .map((tile) => previews.get(homeTileModuleKey(tile)))
      .find((preview) => Number(preview?.width) > 0 && Number(preview?.height) > 0);
    const aspect = captured ? captured.width / captured.height : innerWidth / innerHeight;
    const titleLayer = surface?.querySelector(".crm-home-title-layer");
    const geometry = applyAdaptiveTileGrid({
      grid,
      mirror:titleLayer,
      bounds:{ x:area.x, y:area.y, width:area.w, height:area.h },
      count:homeTileRecords.length,
      gap:GAP,
      aspect,
    });
    const centeredFive = homeTileRecords.length === 5
      && geometry?.columns === 3
      && geometry?.rows === 2;
    const tileNodes = [...grid.querySelectorAll(":scope > .crm-home-bucket")];
    const titleNodes = [...(titleLayer?.querySelectorAll(
      ":scope > .crm-home-title-slot",
    ) || [])];
    if (centeredFive) {
      // Six half-width tracks preserve the exact adaptive cell dimensions
      // while centering the incomplete second row. This is real grid geometry
      // (not a visual transform), so camera measurements and motion cut-outs
      // retain the same coordinates the user sees.
      const halfTrack = Math.max(1, (geometry.cellWidth - GAP) / 2);
      const columns = `repeat(6,minmax(0,${halfTrack}px))`;
      grid.style.gridTemplateColumns = columns;
      if (titleLayer) titleLayer.style.gridTemplateColumns = columns;
      const starts = [1, 3, 5, 2, 4];
      [...tileNodes, ...titleNodes].forEach((node, index) => {
        const tileIndex = index % 5;
        node.style.gridColumn = `${starts[tileIndex]} / span 2`;
        node.style.gridRow = tileIndex < 3 ? "1" : "2";
      });
    } else {
      [...tileNodes, ...titleNodes].forEach((node) => {
        node.style.removeProperty("grid-column");
        node.style.removeProperty("grid-row");
      });
    }
    surface.style.setProperty("--home-r", `${Math.min(64,Math.max(2,16/245*Math.min(geometry?.cellWidth || 1,geometry?.cellHeight || 1)*2)).toFixed(1)}px`);
    layoutPriorityHand(hand);
  };
  const targetAtPoint = (x, y, context) => context.level > 0 ? null
    : [...(context.layers[0]?.querySelectorAll('.crm-home-bucket[data-enabled="true"]') || [])].find((bucket) => {
      const rect = bucket.getBoundingClientRect(); return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }) || null;
  const targetFromEvent = (event, context) => {
    if (context.level > 0) return null;
    const target = event.target.closest?.('.crm-home-bucket[data-enabled="true"]');
    return target && context.layers[0]?.contains(target) ? target : null;
  };
  const homeAcrylicLens = window.createFractalAcrylicLens({
    frameSelector:":scope > .crm-home-transition-acrylic",
    lensClass:"crm-home-screen-acrylic",
    holdThroughMotion:true,
    releaseMs:HOME_ACRYLIC_RELEASE_MS,
    releaseEase:HOME_RETURN_HANDOFF_EASE,
  });
  let delegatedAcrylicLens = null;
  let delegatedAcrylicBackdrop = null;
  const delegateSelectedAcrylicBackdrop = (enabled) => {
    const selectedLens = homeAcrylicLens.element?.();
    const sharedLens = homePeripheralAcrylic?.element?.();
    const shouldDelegate = !!enabled && !!selectedLens && !!sharedLens;
    if (shouldDelegate) {
      if (delegatedAcrylicLens && delegatedAcrylicLens !== selectedLens) {
        delegatedAcrylicLens.style.webkitBackdropFilter = delegatedAcrylicBackdrop?.webkit || "";
        delegatedAcrylicLens.style.backdropFilter = delegatedAcrylicBackdrop?.standard || "";
        delete delegatedAcrylicLens.dataset.crmAcrylicBackdropOwner;
      }
      if (delegatedAcrylicLens !== selectedLens) {
        delegatedAcrylicLens = selectedLens;
        delegatedAcrylicBackdrop = {
          webkit:selectedLens.style.webkitBackdropFilter,
          standard:selectedLens.style.backdropFilter,
        };
      }
      selectedLens.style.webkitBackdropFilter = "none";
      selectedLens.style.backdropFilter = "none";
      selectedLens.dataset.crmAcrylicBackdropOwner = "shared";
      return true;
    }
    if (delegatedAcrylicLens) {
      delegatedAcrylicLens.style.webkitBackdropFilter = delegatedAcrylicBackdrop?.webkit || "";
      delegatedAcrylicLens.style.backdropFilter = delegatedAcrylicBackdrop?.standard || "";
      delete delegatedAcrylicLens.dataset.crmAcrylicBackdropOwner;
    }
    delegatedAcrylicLens = null;
    delegatedAcrylicBackdrop = null;
    return false;
  };
  const discardDelegatedAcrylicBackdrop = () => {
    delegatedAcrylicLens = null;
    delegatedAcrylicBackdrop = null;
  };
  const createPeripheralAcrylic = () => {
    let clipHost = null;
    let lens = null;
    let clipSvg = null;
    let clipGroup = null;
    let clipId = "";
    let surface = null;
    let state = null;
    let clipAnimation = null;
    let releaseAnimation = null;

    const stop = () => {
      clipAnimation?.cancel?.();
      releaseAnimation?.cancel?.();
      clipAnimation = null;
      releaseAnimation = null;
    };
    const finish = () => {
      stop();
      clipHost?.remove?.();
      clipSvg?.remove?.();
      surface?.classList?.remove("crm-home-peripheral-acrylic-active","crm-home-shared-resting-acrylic");
      clipHost = null;
      lens = null;
      clipSvg = null;
      clipGroup = null;
      clipId = "";
      surface = null;
      state = null;
    };
    const park = () => {
      if (!lens) return false;
      stop();
      lens.style.opacity = "0";
      lens.dataset.crmPeripheralAcrylicPhase = "parked";
      surface?.classList?.remove("crm-home-peripheral-acrylic-active","crm-home-shared-resting-acrylic");
      return true;
    };
    const number = (value) => {
      const finite = Number(value);
      return (Number.isFinite(finite) ? finite : 0).toFixed(2);
    };
    const transformFor = (sourceRect, destinationRect) => {
      const scaleX = destinationRect.width / Math.max(.01, sourceRect.width);
      const scaleY = destinationRect.height / Math.max(.01, sourceRect.height);
      const translateX = destinationRect.left - sourceRect.left * scaleX;
      const translateY = destinationRect.top - sourceRect.top * scaleY;
      return `matrix(${scaleX.toFixed(6)}, 0, 0, ${scaleY.toFixed(6)}, ${translateX.toFixed(3)}, ${translateY.toFixed(3)})`;
    };
    const setClipTransform = (value) => {
      if (!clipGroup) return;
      clipGroup.style.transform = value;
    };
    const radiusOf = (node) => {
      const style = getComputedStyle(node);
      const parts = String(style.borderTopLeftRadius || "0").split(/\s+/).map(parseFloat);
      return {
        x:Math.max(0, parts[0] || 0),
        y:Math.max(0, parts[1] || parts[0] || 0),
      };
    };
    const prepare = (_expander, target, context = {}) => {
      const root = context.layers?.[0];
      if (!target || !root || !context.surface || !context.layoutRect || !context.expRect) {
        finish();
        return null;
      }
      const selectedId = target.dataset?.tileId || moduleKeyOf(target);
      const buckets = [...root.querySelectorAll(":scope > .crm-home-grid > .crm-home-bucket")];
      const tileIds = buckets.map((bucket) => bucket.dataset?.tileId || moduleKeyOf(bucket));
      const neighbors = buckets
        .filter((bucket) => (bucket.dataset?.tileId || moduleKeyOf(bucket)) !== selectedId);
      if (!neighbors.length) {
        finish();
        return null;
      }

      const geometryReusable = state?.root === root
        && state?.surface === context.surface
        && state?.layoutEpoch === homeLayoutEpoch
        && state?.tileIds?.length === tileIds.length
        && state.tileIds.every((id, index) => id === tileIds[index])
        && state?.sourceRects?.length === buckets.length;
      const surfaceRect = geometryReusable
        ? state.surfaceRect
        : context.surface.getBoundingClientRect();
      const destination = context.expRect();
      const sourceRects = geometryReusable ? state.sourceRects : [];
      // One real backdrop plane owns every moving tile, including the focused
      // tile. Two overlapping 26 px blur passes are individually within budget
      // but exceed a 10 ms GPU deadline together as their masks expand.
      if (!geometryReusable) {
        buckets.forEach((bucket) => {
          const rect = bucket.getBoundingClientRect();
          const radius = radiusOf(bucket);
          sourceRects.push({
            left:rect.left - surfaceRect.left,
            top:rect.top - surfaceRect.top,
            width:rect.width,
            height:rect.height,
            radiusX:radius.x,
            radiusY:radius.y,
          });
        });
      }
      const selectedIndex = buckets.indexOf(target);
      const sourceTransform = "matrix(1, 0, 0, 1, 0, 0)";
      const destinationTransform = selectedIndex >= 0
        ? transformFor(sourceRects[selectedIndex], {
          left:destination.x - surfaceRect.left,
          top:destination.y - surfaceRect.top,
          width:destination.w,
          height:destination.h,
        })
        : sourceTransform;
      stop();
      if (!clipHost || clipHost.parentElement !== context.surface) {
        finish();
        surface = context.surface;
        clipHost = document.createElement("span");
        clipHost.className = "crm-home-peripheral-acrylic-clip";
        clipHost.setAttribute("aria-hidden", "true");
        clipSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        clipSvg.classList.add("crm-home-peripheral-acrylic-defs");
        clipSvg.setAttribute("aria-hidden", "true");
        clipSvg.setAttribute("focusable", "false");
        const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
        const svgClip = document.createElementNS("http://www.w3.org/2000/svg", "clipPath");
        clipId = `crm-home-peripheral-clip-${Math.random().toString(36).slice(2)}`;
        svgClip.id = clipId;
        svgClip.setAttribute("clipPathUnits", "userSpaceOnUse");
        clipGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
        clipGroup.style.transformBox = "view-box";
        clipGroup.style.transformOrigin = "0 0";
        clipGroup.style.willChange = "transform";
        svgClip.appendChild(clipGroup);
        defs.appendChild(svgClip);
        clipSvg.appendChild(defs);
        lens = document.createElement("span");
        lens.className = "crm-home-peripheral-screen-acrylic";
        lens.setAttribute("aria-hidden", "true");
        clipHost.appendChild(lens);
        surface.appendChild(clipSvg);
        surface.appendChild(clipHost);
      }
      if (!geometryReusable) {
        clipSvg.setAttribute("viewBox", `0 0 ${surfaceRect.width} ${surfaceRect.height}`);
        clipGroup.replaceChildren(...sourceRects.map((rect) => {
          const shape = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          shape.setAttribute("x", number(rect.left));
          shape.setAttribute("y", number(rect.top));
          shape.setAttribute("width", number(rect.width));
          shape.setAttribute("height", number(rect.height));
          shape.setAttribute("rx", number(rect.radiusX));
          shape.setAttribute("ry", number(rect.radiusY));
          return shape;
        }));
      }
      const material = geometryReusable ? null : getComputedStyle(neighbors[0]);
      const computedBackdrop = material
        ? material.webkitBackdropFilter || material.backdropFilter
        : state?.backdrop;
      // Resting ownership deliberately removes backdrop-filter from each
      // bucket. Preserve the already-captured canonical material when a hover
      // reconfigures this same persistent plane.
      const backdrop = computedBackdrop && computedBackdrop !== "none"
        ? computedBackdrop
        : (state?.backdrop || "blur(28px) saturate(140%)");
      lens.style.webkitBackdropFilter = backdrop;
      lens.style.backdropFilter = backdrop;
      lens.style.opacity = ".001";
      const direction = context.direction || "prewarm";
      clipHost.style.clipPath = `url("#${clipId}")`;
      clipHost.style.webkitClipPath = `url("#${clipId}")`;
      setClipTransform(direction === "contract" ? destinationTransform : sourceTransform);
      lens.dataset.crmPeripheralAcrylicPhase = direction === "prewarm" ? "prewarm" : "prepared";
      lens.dataset.crmPeripheralAcrylicDirection = direction;
      state = {
        root,
        surface:context.surface,
        surfaceRect,
        sourceRects,
        tileIds,
        layoutEpoch:homeLayoutEpoch,
        direction,
        sourceTransform,
        destinationTransform,
        neighborCount:neighbors.length,
        tileCount:buckets.length,
        backdrop,
        duration:Number(context.morphMs) || 460,
        easing:context.ease || "cubic-bezier(.22, 1, .26, 1)",
      };
      return lens;
    };
    const setEnabled = (enabled) => {
      if (!lens || !state) return false;
      surface?.classList?.toggle("crm-home-peripheral-acrylic-active", !!enabled);
      surface?.classList?.toggle("crm-home-shared-resting-acrylic", !!enabled);
      lens.style.opacity = enabled ? "1" : ".001";
      lens.dataset.crmPeripheralAcrylicPhase = enabled ? "prepared" : "standby";
      return !!enabled;
    };
    const arm = (direction = "expand") => {
      if (!lens || !state || !["expand", "contract"].includes(direction)) return null;
      stop();
      state.direction = direction;
      setClipTransform(direction === "expand" ? state.sourceTransform : state.destinationTransform);
      lens.dataset.crmPeripheralAcrylicDirection = direction;
      setEnabled(true);
      return lens;
    };
    const start = (direction, enabled = true) => {
      if (!lens || !state || state.direction !== direction || !enabled) {
        setEnabled(false);
        return null;
      }
      stop();
      setEnabled(true);
      lens.dataset.crmPeripheralAcrylicPhase = "motion";
      const from = direction === "expand" ? state.sourceTransform : state.destinationTransform;
      const to = direction === "expand" ? state.destinationTransform : state.sourceTransform;
      clipAnimation = clipGroup.animate(
        [{ transform:from }, { transform:to }],
        { duration:state.duration, easing:state.easing, fill:"forwards" },
      );
      return lens;
    };
    const sync = (transformAnimation, startTime) => {
      const initialAnchor = Number(startTime);
      const syncedAnimation = clipAnimation;
      const syncedLens = lens;
      if (!Number.isFinite(initialAnchor) || !syncedAnimation || !syncedLens?.isConnected) return false;
      const align = () => {
        if (clipAnimation !== syncedAnimation || lens !== syncedLens || !syncedLens.isConnected
          || surface?.dataset?.fractalCameraProbeHold === "true"
          || syncedAnimation.playState === "paused" || syncedAnimation.playState === "idle"
          || syncedAnimation.replaceState === "removed") return false;
        const liveStart = Number(transformAnimation?.startTime);
        const liveTime = Number(transformAnimation?.currentTime);
        try {
          syncedAnimation.startTime = Number.isFinite(liveStart) ? liveStart : initialAnchor;
          if (Number.isFinite(liveTime)) syncedAnimation.currentTime = liveTime;
          return true;
        } catch {
          return false;
        }
      };
      const aligned = align();
      if (transformAnimation) {
        Promise.allSettled([transformAnimation.ready, syncedAnimation.ready]).then(align);
      }
      return aligned;
    };
    const prime = () => {
      if (!lens || !state || state.direction !== "prewarm") return null;
      stop();
      // Own the exact resting silhouettes at full material strength. Chromium
      // may elide a .001 backdrop entirely, which left the first click paying
      // for a cold blur surface late in the animation. This is pixel-identical
      // to the individual tile backdrops but keeps one real GPU plane resident.
      setClipTransform(state.sourceTransform);
      lens.style.opacity = "1";
      surface?.classList?.add("crm-home-peripheral-acrylic-active","crm-home-shared-resting-acrylic");
      lens.dataset.crmPeripheralAcrylicPhase = "prewarm";
      return lens;
    };
    const rest = () => {
      if (!lens || !state) return false;
      stop();
      setClipTransform(state.sourceTransform);
      lens.style.opacity = "1";
      lens.dataset.crmPeripheralAcrylicPhase = "resting";
      surface?.classList?.add("crm-home-peripheral-acrylic-active","crm-home-shared-resting-acrylic");
      return true;
    };
    const release = () => {
      if (!lens || !state) return Promise.resolve(false);
      const releaseLens = lens;
      stop();
      setClipTransform(state.direction === "contract" ? state.sourceTransform : state.destinationTransform);
      releaseLens.style.opacity = "1";
      releaseLens.dataset.crmPeripheralAcrylicPhase = "release";
      const animation = releaseLens.animate(
        [{ opacity:1 }, { opacity:0 }],
        { duration:HOME_ACRYLIC_RELEASE_MS, easing:HOME_RETURN_HANDOFF_EASE, fill:"forwards" },
      );
      releaseAnimation = animation;
      return animation.finished.then(() => {
        if (lens !== releaseLens || releaseAnimation !== animation) return false;
        releaseLens.style.opacity = "0";
        animation.cancel();
        releaseAnimation = null;
        releaseLens.dataset.crmPeripheralAcrylicPhase = "released";
        return true;
      }).catch(() => false);
    };
    const holdEndpoint = () => {
      if (!lens || !state) return false;
      stop();
      setClipTransform(state.direction === "contract" ? state.sourceTransform : state.destinationTransform);
      lens.style.opacity = "1";
      lens.dataset.crmPeripheralAcrylicPhase = "endpoint-held";
      return true;
    };
    const status = () => ({
      active:!!lens && ["motion", "endpoint-held", "release"].includes(lens.dataset.crmPeripheralAcrylicPhase || ""),
      phase:lens?.dataset?.crmPeripheralAcrylicPhase || "",
      direction:lens?.dataset?.crmPeripheralAcrylicDirection || state?.direction || "",
      neighborCount:state?.neighborCount || 0,
      tileCount:state?.tileCount || 0,
      backdropFilter:state?.backdrop || "",
      screenSpace:!!lens && getComputedStyle(lens).transform !== "",
    });
    return { prepare, arm, setEnabled, start, sync, prime, rest, release, holdEndpoint, park, finish, element:() => lens, status };
  };
  const homePeripheralAcrylic = createPeripheralAcrylic();
  let restingAcrylicFrame = 0;
  const primeRestingPeripheralAcrylic = () => {
    restingAcrylicFrame = 0;
    if (window.crmHomePreviews?.isCaptureWorker || !camera?.isActive?.()
      || camera.level() !== 0 || camera.isTransitioning()) return false;
    const surfaceNode = camera.surface();
    const root = camera.layers()?.[0];
    const target = root?.querySelector?.(":scope > .crm-home-grid > .crm-home-bucket");
    if (!surfaceNode || !root || !target) return false;
    const sourceRect = camera.layoutRect(target, root);
    homePeripheralAcrylic.prepare(null, target, {
      active:true,
      direction:"prewarm",
      level:0,
      layers:[root],
      surface:surfaceNode,
      sourceRect,
      layoutRect:(node, layer) => camera.layoutRect(node, layer),
      expRect:() => camera.expRect(),
    });
    const sharedLens = homePeripheralAcrylic.prime();
    delegateSelectedAcrylicBackdrop(!!homeAcrylicLens.element?.() && !!sharedLens);
    return !!sharedLens;
  };
  const primeRestingAcrylic = () => {
    restingAcrylicFrame = 0;
    if (window.crmHomePreviews?.isCaptureWorker || !camera?.isActive?.()
      || camera.level() !== 0 || camera.isTransitioning()) return false;
    const root = camera.layers()?.[0];
    const target = root?.querySelector?.(":scope > .crm-home-grid > .crm-home-bucket");
    if (!root || !target) return false;
    // The camera's normal warm path prepares both the selected and shared
    // acrylic geometry. Its shell has already been built in prior 100 Hz slices;
    // create the two real material owners in separate refreshes.
    camera.prefetch(target, { mode:"selected-material" });
    restingAcrylicFrame = requestAnimationFrame(primeRestingPeripheralAcrylic);
    return homeAcrylicLens.status().phase === "prewarm";
  };
  const scheduleRestingAcrylic = () => {
    if (restingAcrylicFrame) cancelAnimationFrame(restingAcrylicFrame);
    restingAcrylicFrame = requestAnimationFrame(() => {
      // Layout and decoded tile coats must both own a completed native paint
      // before the shared plane samples them.
      restingAcrylicFrame = requestAnimationFrame(() => {
        restingAcrylicFrame = 0;
        schedulePrebuiltExpanders();
      });
    });
  };
  const buildExpander = (target) => {
    const targetModuleKey = moduleKeyOf(target);
    const tile = homeTileRecords.find((candidate) => candidate.tile.id === target?.dataset?.tileId)
      || homeTileRecords.find((candidate) => homeTileModuleKey(candidate) === targetModuleKey)
      || homeTileRecords[0];
    const module = MODULES.find(({ key }) => key === homeTileModuleKey(tile)) || MODULES[0];
    const bucket = recycledExpanders.get(module.key)
      || prebuiltExpanders.get(module.key)
      || document.createElement("div");
    recycledExpanders.delete(module.key);
    prebuiltExpanders.delete(module.key);
    bucket.className = "crm-home-bucket crm-home-expander";
    bucket.style.removeProperty("visibility");
    bucket.style.removeProperty("transform");
    bindTileObject(bucket, tile, {
      ariaLabel:`Open ${homeTileLabel(tile) || module.label}`,
      view:"expanded-preview",
    });
    bucket.dataset.module = module.key;
    bucket.dataset.viewportModule = module.key;
    bucket.dataset.tileId = tile?.tile?.id || target?.dataset?.tileId || module.key;
    if (!bucket.querySelector(".crm-home-preview")) bucket.innerHTML = bucketHTML(tile);
    if (!bucket.querySelector(":scope > .crm-home-transition-acrylic")) {
      const acrylic = document.createElement("span");
      acrylic.className = "crm-home-transition-acrylic";
      acrylic.setAttribute("aria-hidden", "true");
      bucket.prepend(acrylic);
    }
    // One transparent, full-resolution room texture carries its objects and
    // shadows above a live acrylic lens. The fixed workspace wallpaper remains
    // the only background paint throughout the camera move.
    const previewHost = bucket.querySelector(".crm-home-preview");
    mountHost(previewHost, previews.get(module.key), true);
    const foreground = previewHost?.querySelector(":scope > .crm-home-preview-foreground");
    if (foreground) {
      let restingFilter = previewHost.querySelector(":scope > .crm-home-preview-resting-filter");
      if (!restingFilter) {
        restingFilter = imageNode("crm-home-preview-resting-filter", "", "sync");
        previewHost.appendChild(restingFilter);
      }
      const foregroundSource = foreground.currentSrc || foreground.src;
      if (foregroundSource && restingFilter.src !== foregroundSource) restingFilter.src = foregroundSource;
    }
    return bucket;
  };
  const prebuildNextExpander = () => {
    prebuiltExpanderFrame = 0;
    if (window.crmHomePreviews?.isCaptureWorker || !camera?.isActive?.()
      || camera.level() !== 0 || camera.isTransitioning()
      || window.crmDeskTransit?.isBusy?.()) return false;
    const root = camera.layers()?.[0];
    const next = MODULES.find(({ key }) =>
      !prebuiltExpanders.has(key)
      && !recycledExpanders.has(key)
      && isRenderablePreview(previews.get(key))
      && root?.querySelector?.(`.crm-home-bucket[data-module="${cssValue(key)}"]`));
    if (next) {
      const target = root.querySelector(`.crm-home-bucket[data-module="${cssValue(next.key)}"]`);
      const expander = buildExpander(target);
      expander.classList.add("crm-home-prebuilt-expander");
      prebuiltExpanders.set(next.key, expander);
      // Build only one decoded viewport shell per native refresh. Six shells
      // formerly arrived as one large "ready" burst or were rebuilt on hover.
      prebuiltExpanderFrame = requestAnimationFrame(prebuildNextExpander);
      return true;
    }
    // Configure the persistent selected/shared acrylic owners in a separate
    // refresh from the final shell build.
    restingAcrylicFrame = requestAnimationFrame(primeRestingAcrylic);
    return true;
  };
  const schedulePrebuiltExpanders = () => {
    if (prebuiltExpanderFrame) cancelAnimationFrame(prebuiltExpanderFrame);
    prebuiltExpanderFrame = requestAnimationFrame(prebuildNextExpander);
  };
  const recycleExpander = (key, expander) => {
    if (!expander || !MODULES.some((module) => module.key === key)) return;
    const previous = recycledExpanders.get(key);
    if (previous && previous !== expander) previous.remove();
    const preview = expander.querySelector(":scope > .crm-home-preview");
    preview?.style.removeProperty("opacity");
    preview?.style.removeProperty("transition");
    expander.style.removeProperty("opacity");
    expander.style.removeProperty("transition");
    expander.classList.remove("crm-home-endpoint-cover");
    preview?.querySelector(":scope > .crm-home-endpoint-fallback")?.remove();
    const foreground = preview?.querySelector(":scope > .crm-home-preview-foreground");
    foreground?.style.removeProperty("visibility");
    foreground?.style.removeProperty("will-change");
    delete expander.dataset.crmEndpointCover;
    expander.className = "crm-home-bucket crm-home-expander crm-home-recycled-expander";
    Object.assign(expander.style, {
      zIndex:"0",
      pointerEvents:"none",
      transition:"none",
      opacity:".001",
      transform:"translateZ(0)",
      visibility:"visible",
    });
    const surface = camera?.surface?.();
    if (surface && expander.parentElement !== surface) surface.appendChild(expander);
    recycledExpanders.set(key, expander);
  };
  const markCameraTarget = (target, context) => {
    const root = context?.layers?.[0];
    root?.querySelectorAll?.(".crm-home-bucket.is-camera-target")?.forEach?.((bucket) => bucket.classList.remove("is-camera-target"));
    target?.classList?.add?.("is-camera-target");
    const key = target?.dataset?.tileId || moduleKeyOf(target);
    const moduleKey = moduleKeyOf(target);
    if (root && moduleKey && key) routeModuleReturnTo(root, moduleKey, key);
    let selected = selectMotionVariant(root, key);
    // Busy activation normally reuses the already-seated composition. If an
    // obsolete decode completion cleared its flag, repair that exact root
    // under the full-screen lid before the reverse camera begins.
    if (root && (root.dataset.motionSnapshotReady !== "true" || !selected)) {
      syncMotionSnapshot(root);
      selected = selectMotionVariant(root, key);
    }
    const activeVariant = root?.querySelector?.(":scope > .crm-home-motion-variant.is-active-motion-variant");
    const stamp = String(motionSnapshot?.capturedAt || "");
    // Snapshot validity is invalidated when Home geometry or data changes.
    // Re-reading every offset here forced a full style/layout pass after the
    // retained surface was unhidden, immediately before reverse motion.
    const targetReady = root?.dataset?.motionSnapshotReady === "true"
      && !!selected && !!motionSnapshot?.src
      && activeVariant?.dataset?.motionCapturedAt === stamp
      && activeVariant.complete && activeVariant.naturalWidth > 0;
    // Camera motion consumes one selected cutout, not every possible Home
    // destination. An unrelated late image must not force the decoded target
    // back onto the multi-backdrop fallback path.
    if (root) root.dataset.motionSnapshotReady = String(targetReady);
    return selected;
  };
  const clearCameraTarget = () => {
    const root = camera?.layers?.()[0];
    root?.querySelectorAll?.(".crm-home-bucket.is-camera-target")?.forEach?.((bucket) => bucket.classList.remove("is-camera-target"));
    selectMotionVariant(root, "");
    if ((camera?.level?.() || 0) === 0) restoreModuleRouting(root);
  };
  const setInactiveMotionRetention = (retain) => {
    const surface = camera?.surface?.();
    if (!surface || window.crmHomePreviews?.isCaptureWorker) return false;
    if (!retain) {
      surface.removeAttribute("data-crm-home-retained");
      surface.removeAttribute("data-crm-home-retained-tile");
      surface.removeAttribute("data-crm-home-inactive-retained");
      return true;
    }
    const root = camera?.layers?.()[0];
    // Workspace deactivation can run before the desk coordinator publishes the
    // destination on <body>. The camera root already owns the authoritative
    // source route, including which physical duplicate tile was clicked.
    const routedModule = String(root?.dataset?.returnModule || "");
    const moduleKey = routedModule || String(document.body.dataset.crmModule || "");
    const routedTileId = String(root?.dataset?.returnTileId || "");
    const tile = homeTileRecords.find((candidate) =>
      homeTileModuleKey(candidate) === moduleKey && candidate.tile.id === routedTileId)
      || returnTileFor(moduleKey);
    const key = tile?.tile?.id || routedTileId || moduleKey;
    if (tile) routeModuleReturnTo(root, moduleKey, key);
    const selected = root?.dataset?.motionSnapshotReady === "true" && selectMotionVariant(root, key);
    if (!selected) {
      surface.removeAttribute("data-crm-home-retained");
      surface.removeAttribute("data-crm-home-retained-tile");
      return false;
    }
    surface.setAttribute("data-crm-home-retained", moduleKey);
    surface.setAttribute("data-crm-home-retained-tile", key);
    return true;
  };
  const flushDisplayedPreviewRefreshes = () => {
    if (previewCommitBlocked() || !pendingDisplayedPreviewRefreshes.size) return false;
    const refreshes = [...pendingDisplayedPreviewRefreshes.entries()];
    pendingDisplayedPreviewRefreshes.clear();
    refreshes.forEach(([key, viewState]) => { void captureBaseline(key, viewState); });
    return true;
  };
  const cancelTransitionMaintenance = () => {
    clearTimeout(transitionMaintenanceTimer);
    transitionMaintenanceTimer = 0;
    if (!transitionMaintenanceIdle) return;
    if (typeof cancelIdleCallback === "function") cancelIdleCallback(transitionMaintenanceIdle);
    else cancelAnimationFrame(transitionMaintenanceIdle);
    transitionMaintenanceIdle = 0;
  };
  const scheduleTransitionMaintenance = (delay = 72) => {
    cancelTransitionMaintenance();
    transitionMaintenanceTimer = setTimeout(() => {
      transitionMaintenanceTimer = 0;
      const run = () => {
        transitionMaintenanceIdle = 0;
        if (previewCommitBlocked()) {
          // Inactive Home intentionally freezes its queued preview/motion
          // commits. Activation and the next desk settlement re-arm this work;
          // do not wake the renderer every 96ms behind another workspace.
          if (camera?.isActive?.()) scheduleTransitionMaintenance(96);
          return;
        }
        flushPendingPreviews();
        flushPendingMotionSnapshot();
        flushDisplayedPreviewRefreshes();
      };
      if (typeof requestIdleCallback === "function") {
        transitionMaintenanceIdle = requestIdleCallback(run, { timeout:420 });
      } else {
        transitionMaintenanceIdle = requestAnimationFrame(run);
      }
    }, delay);
  };
  const finishHandoff = (clearTarget = true, deferMaintenance = true) => {
    camera?.surface?.()?.classList.remove(
      "crm-home-camera-handoff",
      "crm-home-camera-releasing",
      "crm-home-camera-committing",
    );
    if (clearTarget) clearCameraTarget();
    const resolve = handoffResolve;
    handoffResolve = null;
    resolve?.();
    // Preview replacement and motion-raster validation can touch every Home
    // tile. They are maintenance, never part of the camera endpoint. Keep them
    // out of the ownership exchange and run them only after desk transit has
    // completely released its retained destination.
    if (deferMaintenance) scheduleTransitionMaintenance();
  };
  const waitForHomeRestingScene = (context, maxFrames = 72) => new Promise((resolve) => {
    let frame = 0; let stable = 0; let previous = "";
    const tick = () => {
      const root = context.layers?.[0];
      const samples = root
        ? [root, ...root.querySelectorAll(".crm-home-bucket,.crm-home-title-slot,.crm-home-hand-card")].slice(0, 64)
        : [];
      const geometry = samples.map((node) => {
        const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
        return [
          node.dataset?.tileId || node.dataset?.priorityId || node.className,
          rect.x.toFixed(2), rect.y.toFixed(2), rect.width.toFixed(2), rect.height.toFixed(2),
          style.display, style.visibility, style.opacity, style.transform,
        ].join(":");
      }).join("|");
      const next = root
        ? `${root.childElementCount}:${root.querySelectorAll("*").length}:${root.scrollWidth}:${root.scrollHeight}:${geometry}`
        : "";
      stable = next && next === previous ? stable + 1 : 0;
      previous = next;
      frame += 1;
      if (stable >= 3 || frame >= maxFrames) {
        resolve({ stable:stable >= 3, frames:frame, signature:next });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const settleHomeEndpoint = async (context) => {
    homeEndpointSettling = true;
    try {
      // The retained motion cut-out and selected expander cover these writes.
      // Mount every already-decoded viewport and finish the priority hand's
      // pending data refresh before Home becomes the visible owner.
      mountAll();
      flushPendingPreviews();
      if (activeRefreshPending || handDirty) await refreshPriorityHand();
      activeRefreshPending = false;
      // A decoded preview that was already queued before the return must not
      // auto-commit one frame after the handoff. Give those finite image
      // decodes a covered window, then mount every ready result now.
      for (let frame = 0; frame < 48
        && [...pendingPreviews.values()].some((entry) => !entry.ready); frame += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      flushPendingPreviews();
      const settled = await waitForHomeRestingScene(context);
      if (context.surface) {
        context.surface.dataset.endpointSettled = String(settled.stable);
        context.surface.dataset.endpointSettleFrames = String(settled.frames);
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return settled;
    } finally {
      homeEndpointSettling = false;
    }
  };
  const waitForHomeHandoffOwners = (context, phase, maxFrames = 48) => new Promise((resolve) => {
    let frames = 0;
      const tick = () => {
        const root = context.layers?.[0];
        const surface = context.surface;
        const expander = surface?.querySelector?.(".crm-home-expander:not(.crm-home-warm)");
        const foreground = expander?.querySelector?.(".crm-home-preview-foreground");
      let ready = false;
      if (phase === "matched") {
        const buckets = root
          ? [...root.querySelectorAll(":scope > .crm-home-grid > .crm-home-bucket")]
          : [];
        const title = root?.querySelector?.(":scope > .crm-home-title-layer");
        const restingFilter = expander?.querySelector?.(".crm-home-preview-resting-filter");
        ready = buckets.length === homeTileRecords.length
          && buckets.every((node) => Number(getComputedStyle(node).opacity) <= .002)
          && !!title
          && Number(getComputedStyle(title).opacity) <= .002
          && (!expander || Number(getComputedStyle(expander).opacity) >= .999)
          && (!foreground || Number(getComputedStyle(foreground).opacity) <= .002)
          && (!foreground || (!!restingFilter && Number(getComputedStyle(restingFilter).opacity) >= .999));
      } else {
        const outgoing = [
          root?.querySelector?.(":scope > .crm-home-motion-variant.is-active-motion-variant"),
          expander,
        ].filter(Boolean);
        ready = outgoing.length === 2
          && outgoing.every((node) => Number(getComputedStyle(node).opacity) <= .002);
      }
      frames += 1;
      if (ready || frames >= maxFrames) {
        resolve({ ready, frames });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const beginHomeHandoff = (context, sequence, settle = null) => {
    const surface = context.surface;
    if (!surface) {
      homeAcrylicLens.finish();
      homePeripheralAcrylic.finish();
      discardDelegatedAcrylicBackdrop();
      finishHandoff();
      handoffPromise = Promise.resolve();
      return handoffPromise;
    }
    finishHandoff(false, false);
    handoffPromise = new Promise((resolve) => { handoffResolve = resolve; });
    surface.classList.add("crm-home-camera-handoff");
    // Keep the complete moving scene visible while its selected preview reaches
    // the resting filter. The real Home materials stay composited at .001
    // beneath it. Once both representations match, exchange them atomically;
    // there is never a translucent midpoint or a double-acrylic interval.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      void (async () => {
        try { await settle?.(); } catch {}
        if (sequence !== handoffSequence) {
          handoffResolve?.();
          return;
        }
        surface.classList.add("crm-home-camera-releasing");
        await waitForHomeHandoffOwners(context, "matched");
        if (sequence !== handoffSequence) {
          handoffResolve?.();
          return;
        }
        surface.classList.add("crm-home-camera-committing");
        homeAcrylicLens.park();
        homePeripheralAcrylic.rest();
        discardDelegatedAcrylicBackdrop();
        await waitForHomeHandoffOwners(context, "outgoing");
        if (sequence !== handoffSequence) {
          handoffResolve?.();
          return;
        }
        // Keep the selected shell parked and the shared Home backdrop at its
        // exact resting union. Destroying/recreating that GPU surface would
        // make the next forward transition cold again.
        context.retireOutgoingLayer?.();
        finishHandoff();
      })();
    }));
    return handoffPromise;
  };
  const syncBitmapMotion = (context) => {
    const motionRoot = context?.layers?.[0];
    const motionVariant = motionRoot?.querySelector?.(":scope > .crm-home-motion-variant.is-active-motion-variant");
    const ownsMotion = motionRoot?.dataset?.motionSnapshotReady === "true"
      && !!motionRoot?.dataset?.motionVariant
      && motionVariant?.dataset?.motionCapturedAt === String(motionSnapshot?.capturedAt || "")
      && !!motionVariant?.complete
      && motionVariant.naturalWidth > 0;
    context?.surface?.classList.toggle("crm-home-bitmap-motion", ownsMotion);
    return ownsMotion;
  };

  camera = window.createFractalCamera({
    apiName:"crmHomeCamera",theater:"home",surfaceClass:"crm-home-surface",layerClass:"crm-home-level",
    warmClass:"crm-home-warm",contractingClass:"crm-home-contracting",active:false,maxLevel:1,margin:0,
    preserveSurfaceOnDeactivate:true,stagePrefetchPrime:true,
    ignoreSelector:".window-control-cluster,.background-tone-menu,.auth-shell,.auth-modal-backdrop,.crm-home-todo-popover,.crm-home-todo-menu",
    expandFadeMs:70,belowFadeMs:70,contractFadeMs:70,keepBelowVisibleDuringTransition:true,keepBelowVisibleDuringJump:true,precomposeTransitions:true,lockInputDuringTransitions:true,delegateClickToOwner:true,measureTop:()=>0,ensureStyles,buildRoot,layout,layoutOnActivate:()=>!window.crmDeskTransit?.isBusy?.(),targetFromEvent,targetAtPoint,buildExpander,
    configureExpander:(expander,target,context)=>{
      expander.__crmHomeRestingFilterPrime?.cancel?.();
      expander.__crmHomeRestingFilterPrime = null;
      // Hover already measured this exact expander and built both persistent
      // screen-space acrylic owners. Re-arming those retained owners is a
      // handful of compositor writes; rebuilding their viewport geometry and
      // SVG masks on click consumed two refresh intervals before motion.
      if (context.reusedWarmExpander && context.direction === "expand") {
        const selectedLens = homeAcrylicLens.arm("expand");
        const sharedLens = homePeripheralAcrylic.arm("expand");
        delegateSelectedAcrylicBackdrop(!!selectedLens && !!sharedLens);
        return;
      }
      // Read the canonical bucket material before returning its backdrop to
      // the shared owner. Removing this class and restoring it below happen in
      // one task, so no intermediate double-filter frame can be presented.
      context.surface?.classList.remove("crm-home-shared-resting-acrylic");
      delegateSelectedAcrylicBackdrop(false);
      homeAcrylicLens.prepare(expander,target,context);
      if (context.prefetchMode === "selected-material") return;
      homePeripheralAcrylic.prepare(expander,target,context);
    },
    primeExpander:(expander,target,context)=>{
      const key = moduleKeyOf(target);
      const restingFilter = expander.querySelector?.(":scope > .crm-home-preview > .crm-home-preview-resting-filter");
      try { void restingFilter?.decode?.(); } catch {}
      homeAcrylicLens.prime();
      if (context.prefetchMode === "selected-material") return;
      const ownsSharedBackdrop = !!homePeripheralAcrylic.prime();
      delegateSelectedAcrylicBackdrop(ownsSharedBackdrop);
      selectMotionVariant(context.layers?.[0],target?.dataset?.tileId || key);
      // Pointer intent is also the destination's pre-motion geometry lease.
      // The room remains below Home at .001, but its canonical layout can
      // settle before the transit lock closes over visible camera motion.
      void preparePrecomposedModule(key);
      // Hover precomposition also uploads the exact endpoint into the parked
      // body bridge. A subsequent click only animates compositor opacity near
      // landing; it never uploads a viewport-sized image during camera motion.
      void window.crmDeskTransit?.primeEndpointRaster?.(expander, key);
    },
    contractExpanderAbove:true,holdContractEndpointFrame:true,keepExpanderOpaqueDuringTransition:true,
    keyOf:(target)=>target.dataset.tileId||moduleKeyOf(target),sourceSelector:(target)=>`.crm-home-bucket[data-tile-id="${cssValue(target.dataset.tileId || moduleKeyOf(target))}"]`,
    restoreLayer:(layer)=>{
      const key = moduleKeyOf(layer);
      if (!key || !layer?.classList?.contains("crm-home-expander")) return false;
      recycleExpander(key, layer);
      return true;
    },
    retainSurfaceChildOnRestore:(child)=>child?.matches?.(
      ".crm-home-recycled-expander,.crm-home-screen-acrylic-clip,.crm-home-peripheral-acrylic-clip,.crm-home-peripheral-acrylic-defs",
    ) === true,
    prepareTarget:(target,context)=>markCameraTarget(target,context),
    prepareJump:(_expander,target,context)=>markCameraTarget(target,context),
    onTransitionStart:(direction,context)=>{
      cancelTransitionMaintenance();
      finishHandoff(false, false);
      handoffSequence += 1;
      factoryPrewarmAfter = Number.POSITIVE_INFINITY;
      context.surface?.classList.remove(
        "crm-home-motion-priming",
        "crm-home-camera-handoff",
        "crm-home-camera-releasing",
        "crm-home-camera-committing",
      );
      const ownsBitmapMotion = syncBitmapMotion(context);
      const ownsSharedBackdrop = homePeripheralAcrylic.setEnabled(ownsBitmapMotion);
      delegateSelectedAcrylicBackdrop(ownsSharedBackdrop);
      // Snapshot validity is maintained on data/layout changes. Recomputing its
      // complete geometry signature here forced style/layout immediately before
      // the first transform frame and made an otherwise compositor-only move
      // inherit a main-thread reaction hitch.
      context.surface?.classList.add("crm-home-camera-moving");
      context.surface?.classList.toggle("crm-home-camera-expanding",direction==="expand");
      context.surface?.classList.toggle("crm-home-camera-contracting",direction==="contract");
      // Reverse navigation first promotes the one retained bitmap, then hands
      // it to the normal bitmap-motion selectors. Releasing this lease before
      // the moving class exists would briefly raster every live Home tile.
      setInactiveMotionRetention(false);
    },
    onTransformPrepare:(direction,context)=>{
      // The contract path deliberately spends two covered frames precomposing
      // Home. A selected cutout can finish decoding in that window, so make
      // this last pre-transform ownership decision authoritative.
      const ownsBitmapMotion = syncBitmapMotion(context);
      const ownsSharedBackdrop = homePeripheralAcrylic.setEnabled(ownsBitmapMotion);
      delegateSelectedAcrylicBackdrop(ownsSharedBackdrop);
      homeAcrylicLens.start(direction);
      homePeripheralAcrylic.start(direction, ownsSharedBackdrop);
      context.surface?.classList.toggle("crm-home-acrylic-expanding",direction==="expand");
      context.surface?.classList.toggle("crm-home-acrylic-contracting",direction==="contract");
    },
    onTransformReady:(_direction,context)=>{
      homeAcrylicLens.sync(context.transformAnimation, context.transformStartTime);
      homePeripheralAcrylic.sync(context.transformAnimation, context.transformStartTime);
    },
    onTransformStart:(direction,context)=>{
      window.crmDeskTransit?.noteHomeTransformStart?.(
        direction,
        context.motionStartedAt || performance.now(),
        context.morphMs,
      );
    },
    onTransitionEnd:async(direction,context)=>{
      window.crmDeskTransit?.noteHomeTransformEnd?.(direction, performance.now());
      let endpointAcrylicHeld = false;
      const sharedBackdropOwned = delegatedAcrylicLens === homeAcrylicLens.element?.();
      if (direction === "expand") {
        // The destination coordinator cannot begin seating its exact endpoint
        // raster until this camera settles. Keep the real screen-space acrylic
        // fully owned while that cover is prepared instead of fading it first
        // and exposing the transparent room foreground over the wallpaper.
        if (window.crmDeskTransit?.isBusy?.()) {
          endpointAcrylicHeld = homeAcrylicLens.holdEndpoint();
          if (sharedBackdropOwned) homePeripheralAcrylic.holdEndpoint();
        } else {
          await Promise.all([
            homeAcrylicLens.release(),
            sharedBackdropOwned ? homePeripheralAcrylic.release() : Promise.resolve(false),
          ]);
          discardDelegatedAcrylicBackdrop();
        }
        if (!endpointAcrylicHeld) homePeripheralAcrylic.finish();
      }
      if (!endpointAcrylicHeld) {
        context.surface?.classList.remove("crm-home-camera-moving","crm-home-camera-expanding","crm-home-camera-contracting","crm-home-acrylic-expanding","crm-home-acrylic-contracting","crm-home-bitmap-motion");
      }
      const sequence = ++handoffSequence;
      let endpointPromise = null;
      if (direction === "contract" && context.layers?.[0]?.dataset?.motionSnapshotReady === "true") {
        endpointPromise = beginHomeHandoff(context, sequence, () => settleHomeEndpoint(context));
      } else {
        if (!endpointAcrylicHeld) {
          homeAcrylicLens.finish();
          homePeripheralAcrylic.finish();
          discardDelegatedAcrylicBackdrop();
        }
        if (direction === "contract") context.retireOutgoingLayer?.();
        finishHandoff();
      }
      // After returning Home, use the next idle slice to prepare the next room.
      // Expanding leaves Home inactive, so its longer guard remains appropriate.
      factoryPrewarmAfter = performance.now() + (direction === "contract" ? 60 : 250);
      scheduleFactoryPrewarm();
      if (endpointPromise) await endpointPromise;
    },
    onLevelChange:(context)=>{
      if (context.active && context.level === 0 && !window.crmDeskTransit?.isBusy?.()) {
        mountAll();
        scheduleRestingAcrylic();
      }
    },
  });

  document.addEventListener("click", (event) => {
    if (!camera?.isActive?.()) return;
    const target = event.target?.closest?.(".crm-home-bucket[data-viewport-module]");
    if (!target || !camera.surface()?.contains(target)) return;
    const key = moduleKeyOf(target);
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    if (camera.isTransitioning()) return;
    if (window.crmDeskTransit?.driveTo) void window.crmDeskTransit.driveTo(key);
    else {
      camera.expand(target);
      window.crmWorkspaces?.setActive?.(key);
    }
  }, true);
  document.addEventListener("contextmenu", (event) => {
    if (!camera?.isActive?.() || camera.level() !== 0) return;
    const target = event.target?.closest?.(".crm-home-bucket[data-tile-id]");
    if (!target || !camera.surface()?.contains(target)) return;
    event.preventDefault();
    event.stopPropagation();
    closeHomeTileMenu();
    if (target.dataset.homeTileRemovable !== "true") return;
    openHomeTileMenu(
      target.dataset.tileId,
      target,
      event.clientX,
      event.clientY,
    );
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeHomeTileMenu();
  });
  document.addEventListener("crm:theater-switch", closeHomeTileMenu);
  window.addEventListener("resize", closeHomeTileMenu);

  const setActive = (on) => {
    subscribe();
    const requestedActive = !!on;
    const transitBusy = !!window.crmDeskTransit?.isBusy?.();
    const logicalActive = camera.isActive() && !inactiveCommitDeferred;
    const changed = logicalActive !== requestedActive;
    if (changed) {
      // Forward transit still owns an opaque endpoint bridge and asks the
      // camera to restore its root a few covered frames later. Applying the
      // retained-tree selectors here would combine that full Home topology
      // change with the destination workspace commit.
      if (!requestedActive && transitBusy) {
        inactiveCommitDeferred = true;
      } else {
        if (!requestedActive) {
          setInactiveMotionRetention(true);
          camera.surface()?.setAttribute?.("data-crm-home-inactive-retained", "");
        } else {
          const surface = camera.surface?.();
          // Forward retirement applies the theater's semantic [hidden] only
          // after its retained bitmap owns the scene. Reverse navigation must
          // restore that same surface before jumpTo() measures the source tile;
          // workspace routing follows under the already-seated return lid.
          if (surface) surface.hidden = false;
          surface?.removeAttribute?.("data-crm-home-inactive-retained");
        }
        inactiveCommitDeferred = false;
        camera.setActive(requestedActive);
        if (requestedActive && !transitBusy) setInactiveMotionRetention(false);
      }
      if (requestedActive) factoryPrewarmAfter = performance.now() + 250;
    }
    if (requestedActive) {
      if (!transitBusy) mountAll();
      // The decoded transition texture survives while Home is inactive, but a
      // layout/camera boundary can leave its readiness flag cleared. Re-seat
      // that existing composition immediately so the next dive never begins
      // with a late material upload.
      if (!transitBusy) {
        flushPendingPreviews();
        flushPendingMotionSnapshot();
        flushDisplayedPreviewRefreshes();
        requestAnimationFrame(() => syncMotionSnapshot());
        requestMotionSnapshot();
        scheduleFactoryPrewarm();
        scheduleRestingAcrylic();
      }
      if (transitBusy) activeRefreshPending = handDirty;
      else {
        activeRefreshPending = false;
        requestPreviews(false);
        if (handDirty) refreshPriorityHand();
      }
    }
    else {
      clearTimeout(retryTimer); retryTimer = 0;
      clearTimeout(handRefreshTimer); handRefreshGeneration += 1;
      clearTimeout(factoryPrewarmTimer); factoryPrewarmTimer = 0;
      if (factoryPrewarmHandle) {
        if (typeof cancelIdleCallback === "function") cancelIdleCallback(factoryPrewarmHandle);
        else cancelAnimationFrame(factoryPrewarmHandle);
        factoryPrewarmHandle = 0;
      }
    }
    return window.crmHome;
  };
  const finalizeInactiveSurface = () => {
    if (!inactiveCommitDeferred && !camera?.isActive?.()) return true;
    inactiveCommitDeferred = false;
    const surface = camera?.surface?.();
    surface?.setAttribute?.("data-crm-home-inactive-retained", "");
    camera?.setActive?.(false);
    // Workspace routing deliberately defers this semantic boundary until the
    // retained-bitmap selectors have removed the complete Home object tree.
    // The retained surface's author display rule keeps that one reverse-camera
    // texture compositor-resident while [hidden] excludes Home from routing.
    if (surface) surface.hidden = true;
    return !camera?.isActive?.();
  };
  document.addEventListener("crm:desk-transit-settled", (event) => {
    scheduleTransitionMaintenance();
    if (event.detail?.key === "home" && camera?.isActive?.() && camera.level() === 0) {
      scheduleRestingAcrylic();
    }
    if (!activeRefreshPending || event.detail?.key !== "home" || !camera?.isActive?.()) return;
    activeRefreshPending = false;
    requestAnimationFrame(() => {
      if (!camera?.isActive?.() || window.crmDeskTransit?.isBusy?.()) { activeRefreshPending = true; return; }
      requestPreviews(false);
      if (handDirty) refreshPriorityHand();
    });
  });
  const waitForModuleSettled = (key, timeoutMs = 2200) => new Promise((resolve) => {
    const started = performance.now(); const theater = key === "cases" ? "tickets" : key;
    const selector = {
      people:".tk-zone,.tk-card,.tk-zcard",
      cases:".tk-zone,.tk-deck",
      planner:".crm-project-bucket,.crm-planner-bucket,.crm-planner-card",
      assignments:".tk-zone,.tk-zcard",
      // Calendar's own geometry waiter validates the unified tile graph and
      // synchronized previews in parallel. Re-sampling every fake day renderer
      // here forced 64 style/layout reads into each covered endpoint frame.
      calendar:".fc-month",
      monitoring:".crm-monitoring-tile",
    }[key]||"*";
    let stable=0,last=""; const tick=()=>{const source=[...document.querySelectorAll(`[data-crm-theater="${theater}"]`)].find((node)=>!node.hidden||node.hasAttribute("data-crm-transit-destination"));
      // This runs beneath the retained endpoint cover, not during camera
      // motion. Sample the complete leading viewport population so a lower
      // card, font, decoded image, or delayed text refresh cannot arrive after
      // visual ownership has already changed.
      const samples=source?[source,...source.querySelectorAll(selector)].slice(0,64):[];
      const geometry=samples.map((node)=>{const rect=node.getBoundingClientRect();const style=getComputedStyle(node);return[
        node.dataset?.id||node.dataset?.recordId||node.dataset?.stage||node.className,
        rect.x.toFixed(2),rect.y.toFixed(2),rect.width.toFixed(2),rect.height.toFixed(2),style.transform,style.opacity,
        String(node.textContent||"").trim().slice(0,160),
      ].join(":")}).join("|");
      const assetsReady=!source||[...source.querySelectorAll("img")].every((image)=>image.complete&&image.naturalWidth>0);
      const fontsReady=!document.fonts||document.fonts.status!=="loading";
      // A room can be intentionally empty (notably a new Projects world). Its own
      // stable geometry is still a valid destination; requiring a child object
      // held the reveal open until the timeout and made the handoff hitch.
      const next=source?`${source.childElementCount}:${source.querySelectorAll("*").length}:${source.scrollWidth}:${source.scrollHeight}:${geometry}`:"";
      stable=assetsReady&&fontsReady&&next&&next===last?stable+1:0;last=next;if(stable>=3||performance.now()-started>=timeoutMs)resolve({stable:stable>=3,signature:next,assetsReady,fontsReady});else requestAnimationFrame(tick)};requestAnimationFrame(tick);
  });
  const waitForModuleReady = (key) => new Promise((resolve) => {
    const theater = key === "cases" ? "tickets" : key;
    const selector = {
      people:".tk-zone,.tk-card,.tk-zcard",
      cases:".tk-zone,.tk-deck",
      planner:".crm-project-bucket,.crm-planner-bucket,.crm-planner-card",
      assignments:".tk-zone,.tk-zcard",
      calendar:".crm-calendar-tile,.fc-month,.fc-day",
      monitoring:".crm-monitoring-tile",
    }[key]||"*";
    const source=[...document.querySelectorAll(`[data-crm-theater="${theater}"]`)].find((node)=>!node.hidden);
    if(source?.querySelector?.(selector))resolve();else requestAnimationFrame(resolve);
  });
  const previewApiFor = (key) => window[FACTORY_API_BY_MODULE[key]] || null;
  const captureDisplayedState = (key) => {
    const api = previewApiFor(key);
    let state = null;
    try { state = api?.homePreviewState?.() || null; } catch {}
    try { return JSON.parse(JSON.stringify({ revision:1, ...(state || {}) })); }
    catch { return { revision:1 }; }
  };
  const applyCaptureState = async (key, state = {}) => {
    const api = previewApiFor(key);
    if (!api) return false;
    try {
      await api.baseline?.();
      await api.applyHomePreviewState?.(state);
      await waitForModuleSettled(key);
      return true;
    } catch { return false; }
  };
  const captureBaseline = (key, viewState = captureDisplayedState(key)) => {
    if (window.crmHomePreviews?.isCaptureWorker) return Promise.resolve(previews.get(key)||null);
    previewSyncKeys.add(key);
    const request = (async () => {
      try { const result=await window.crmHomePreviews?.capture?.(key, viewState); if(result?.preview)acceptPreview(result.preview); } catch {}
      return previews.get(key)||null;
    })();
    previewSyncs.add(request);
    request.finally(() => { previewSyncs.delete(request); previewSyncKeys.delete(key); }).catch(() => {});
    return request;
  };
  const refreshDisplayedPreview = (key) => {
    const viewState = captureDisplayedState(key);
    // Leaving a live room used to launch its offscreen capture immediately
    // before the reverse camera started. The worker's first capture paint could
    // then contend with the first 60ms of an otherwise compositor-only return.
    // Preserve the room state synchronously, but perform the raster refresh in
    // the post-transit idle slice.
    if (window.crmDeskTransit?.isBusy?.() || camera?.isTransitioning?.()) {
      pendingDisplayedPreviewRefreshes.set(key, viewState);
      scheduleTransitionMaintenance();
      return Promise.resolve(previews.get(key)||null);
    }
    return captureBaseline(key, viewState);
  };
  const waitForPreviewSync = async () => {
    const paint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (!previewCommitBlocked()) {
        cancelTransitionMaintenance();
        flushPendingPreviews();
        flushPendingMotionSnapshot();
        flushDisplayedPreviewRefreshes();
      }
      if (previewSyncs.size) await Promise.allSettled([...previewSyncs]);
      const result = await window.crmHomePreviews?.waitForIdle?.().catch?.(() => null);
      if (result?.ok === false) throw new Error(result.error || "Preview synchronization failed");
      await paint();
      const rendererBusy = previewSyncs.size || pendingDisplayedPreviewRefreshes.size
        || pendingPreviews.size || pendingMotionSnapshot || previewCommitTimer
        || motionCommitTimer || motionSnapshotSettleTimer
        || transitionMaintenanceTimer || transitionMaintenanceIdle;
      const previewsReady = MODULES.every(({ key }) => {
        const preview = previews.get(key);
        return !!preview && isCurrentPreview(preview) && !previewSyncKeys.has(key);
      });
      if (!previewCommitBlocked() && !rendererBusy && previewsReady) return true;
    }
    throw new Error("Preview renderer did not reach semantic idle");
  };
  const noteModuleReady = (key) => {
    const apiName = FACTORY_API_BY_MODULE[key];
    if (apiName) prewarmedFactories.add(apiName);
  };
  registerContextAddProvider("home", {
    contextKey:"home",
    label:"Home",
    actions:[{
      id:"home-tiles",
      label:"Tiles",
      kind:"tile",
      children:MODULES.map((module) => ({
        id:`home-tile-${module.key}`,
        label:`${module.label} tile`,
        description:`Add another ${module.label} viewport tile`,
        group:"Tiles",
        kind:"tile",
        execute:({ label } = {}) => !!createHomeTile(module.key, { label }),
      })),
    }],
  });
  window.addEventListener("resize",()=>{
    camera?.layout?.();
    requestAnimationFrame(()=>{
      syncMotionSnapshot();
      scheduleRestingAcrylic();
    });
  });
  window.crmHome={setActive,isActive:()=>camera.isActive()&&!inactiveCommitDeferred,refresh:()=>{camera.layout();mountAll();requestPreviews(false);syncMotionSnapshot()},captureBaseline,captureDisplayedState,applyCaptureState,refreshDisplayedPreview,waitForPreviewSync,waitForModuleSettled,waitForModuleReady,waitForHandoff:()=>handoffPromise,noteModuleReady,recycleExpander,acceptPreview,setPrecomposedModulePromoted,promotePrecomposedModule,prepareModule:preparePrecomposedModule,
    endpointPreview:(key)=>{
      const preview=previews.get(key);
      const decoded=decodedPreviewSources.get(`${key}:exact`);
      return isRenderablePreview(preview)?{
        key,
        src:preview.exactSrc,
        raster:decoded?.src===preview.exactSrc&&decoded.ready?decoded.image:null,
        capturedAt:preview.capturedAt||0,
        width:preview.width||0,
        height:preview.height||0,
      }:null;
    },
    acrylicState:()=>homeAcrylicLens.status(),
    retireEndpointAcrylic:()=>{
      if (homeAcrylicLens.status().phase !== "endpoint-held") return false;
      camera?.surface?.()?.classList.remove(
        "crm-home-camera-moving",
        "crm-home-camera-expanding",
        "crm-home-camera-contracting",
        "crm-home-acrylic-expanding",
        "crm-home-acrylic-contracting",
        "crm-home-bitmap-motion",
      );
      homeAcrylicLens.park();
      homePeripheralAcrylic.park();
      discardDelegatedAcrylicBackdrop();
      return true;
    },
    peripheralAcrylicState:()=>homePeripheralAcrylic.status(),
    tiles:()=>clone(homeTileRecords),_objectGraph:()=>homeRootObject,_objectIndex:()=>homeTreeIndex,
    createTile:createHomeTile,removeTile:removeHomeTile,canRemoveTile:canRemoveHomeTile,resetTiles:resetHomeTiles,
    releasePrecomposedModule,
    retainMotionSurface:()=>setInactiveMotionRetention(true),
    finalizeInactiveSurface,
    previewStatus:()=>MODULES.map(({key})=>{const preview=previews.get(key);const pending=pendingPreviews.get(key);return{key,state:(pending||previewSyncKeys.has(key)||pendingDisplayedPreviewRefreshes.has(key))?"updating":preview?(isCurrentPreview(preview)?"ready":"stale"):"waiting",version:preview?.version||null,capturedAt:preview?.capturedAt||0,layoutSignature:preview?.layoutSignature||null}}),
    handStatus:()=>({ready:!handDirty,count:priorityItems.length,username:priorityUsername,day:todayKey(),ids:priorityItems.map((item)=>item.id),targets:priorityItems.map((item)=>priorityLink(item))}),
    ensureHandReady:refreshPriorityHand,motionLayoutSignature,motionStatus:()=>({ready:camera?.layers?.()[0]?.dataset?.motionSnapshotReady==="true",capturedAt:motionSnapshot?.capturedAt||0,layoutSignature:motionSnapshot?.layoutSignature||"",backgroundMode:motionSnapshot?.backgroundMode||"",materialMode:motionSnapshot?.materialMode||""}),
    isModulePrewarmed:(key)=>prewarmedFactories.has(FACTORY_API_BY_MODULE[key]),
    prewarmStatus:()=>({ready:[...prewarmedFactories],running:factoryPrewarmRunning,pending:FACTORY_PREWARM_APIS.filter((name)=>!prewarmedFactories.has(name))})};
})();
