import {
  applyAdaptiveTileGrid,
  bindTileObject,
  createTileInstance,
  createTileObject,
  normalizeTileRecord,
} from "./modules/tile-system.js";
import { changed as contextAddChanged, register as registerContextAddProvider } from "./modules/context-add-registry.js";

// crm-home.js — adaptive inert screenshot LODs hosted by the original camera.
(() => {
  if (typeof window.createFractalCamera !== "function") return;

  const HOME_TILE_STORE_KEY = "crm-home-tiles-v1";
  const MODULES = [
    { key: "people", label: "People" }, { key: "cases", label: "Tickets" },
    { key: "planner", label: "Projects" }, { key: "assignments", label: "Assignments" },
  ].map((module, rank) => createTileObject({
    ...module,
    tile:normalizeTileRecord(module, {
      id:module.key,
      key:module.key,
      title:module.label,
      label:module.label,
      kind:"home-viewport",
      targetType:"workspace",
      targetId:module.key,
      rank,
    }),
  }));
  const RETRY_MS = [0, 120, 320, 700, 1400, 2800, 5000];
  const HOME_PREVIEW_VERSION = "filtered-home-v46";
  const HOME_RETURN_INGRESS_MS = 110;
  const HOME_ACRYLIC_RELEASE_MS = 110;
  const HOME_RETURN_HANDOFF_EASE = "cubic-bezier(.4, 0, .2, 1)";
  const DAY_MS = 86400000;
  const HOME_HAND_WINDOW_DAYS = 7;
  const HAND_LIMIT = 7;
  const previews = new Map();
  const pendingPreviews = new Map();
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
  let previewCommitTimer = 0;
  let previewDecodeSequence = 0;
  let priorityTicketOpen = null;
  let transitionMaintenanceTimer = 0;
  let transitionMaintenanceIdle = 0;
  const prewarmedFactories = new Set();
  const TODO_LINK_ENTITIES = new Set(["tasks", "contacts", "tickets", "workItems"]);
  const recycledExpanders = new Map();
  const FACTORY_PREWARM_APIS = ["peopleCards", "ticketStacks", "crmPlanner", "crmAssignments"];
  const FACTORY_API_BY_MODULE = { people:"peopleCards", cases:"ticketStacks", planner:"crmPlanner", assignments:"crmAssignments" };
  const clone = (value) => typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  const normalizeHomeTile = (source = {}, rank = 0) => {
    const moduleKey = String(source.moduleKey || source.key || source.tile?.target?.id || "");
    const module = MODULES.find((candidate) => candidate.key === moduleKey);
    if (!module) return null;
    const tileId = String(source.tile?.id || source.id || module.key);
    const label = [source.label, source.tile?.title, module.label].map((value) => String(value ?? "").trim()).find(Boolean) || module.label;
    return createTileObject({
      moduleKey:module.key,
      key:module.key,
      label,
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
    try { parsed = JSON.parse(localStorage.getItem(HOME_TILE_STORE_KEY) || "null"); } catch {}
    if (!Array.isArray(parsed)) return defaultHomeTiles();
    const seen = new Set();
    return parsed.map(normalizeHomeTile).filter((tile) => {
      if (!tile || seen.has(tile.tile.id)) return false;
      seen.add(tile.tile.id);
      return true;
    });
  };
  let homeTileRecords = readHomeTiles();
  // A workspace may be represented by several independently placed Home
  // tiles. Remember the exact physical tile that opened it: desk transit still
  // resolves its return lid through data-module, while data-viewport-module
  // remains the stable semantic workspace identity for every duplicate.
  const returnTileByModule = new Map();
  const moduleKeyOf = (node) => String(node?.dataset?.viewportModule || node?.dataset?.module || "");
  const returnTileFor = (moduleKey) => {
    const key = String(moduleKey || "");
    const remembered = returnTileByModule.get(key);
    const tile = homeTileRecords.find((candidate) => candidate.key === key && candidate.tile.id === remembered)
      || homeTileRecords.find((candidate) => candidate.key === key)
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
  const writeHomeTiles = () => {
    if (window.crmHomePreviews?.isCaptureWorker) return;
    try { localStorage.setItem(HOME_TILE_STORE_KEY, JSON.stringify(homeTileRecords)); } catch {}
  };
  const rebuildHomeTiles = (refreshKey = MODULES[0]?.key || "people") => {
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
    homeTileRecords = [...homeTileRecords, tile];
    writeHomeTiles(); rebuildHomeTiles(module.key);
    return clone(tile);
  };
  const removeHomeTile = (tileId) => {
    const removedId = String(tileId || "");
    const removed = homeTileRecords.find((tile) => tile.tile.id === removedId);
    const next = homeTileRecords.filter((tile) => tile.tile.id !== removedId);
    if (next.length === homeTileRecords.length) return false;
    homeTileRecords = next.map((tile, rank) => normalizeHomeTile(tile, rank));
    if (removed && returnTileByModule.get(removed.key) === removedId) returnTileByModule.delete(removed.key);
    writeHomeTiles(); rebuildHomeTiles(removed?.key);
    return true;
  };
  const resetHomeTiles = () => {
    homeTileRecords = defaultHomeTiles();
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
      .crm-home-surface[data-crm-home-retained][hidden]{
        display:block!important;z-index:0!important;
        pointer-events:none!important;visibility:visible!important}
      .crm-home-surface[data-crm-home-retained][hidden] .crm-home-level>:is(.crm-home-grid,.crm-home-title-layer,.crm-home-priority-hand){
        visibility:hidden!important;pointer-events:none!important}
      .crm-home-surface[data-crm-home-retained][hidden] .crm-home-level>.crm-home-motion-snapshot{
        display:none!important}
      .crm-home-surface[data-crm-home-retained][hidden] .crm-home-level>.crm-home-motion-variant{
        display:none!important}
      .crm-home-surface[data-crm-home-retained][hidden] .crm-home-level>.crm-home-motion-variant.is-active-motion-variant{
        display:block!important;visibility:visible!important;opacity:.001!important;
        transform:translateZ(0)!important;will-change:transform,opacity;
        pointer-events:none!important}
      /* Inactive rooms that finished their idle baseline stay rasterized behind
         Home instead of returning to display:none and paying their first paint
         during a camera move. The attribute is semantic-only: [hidden] remains
         present, the room is one .001 compositor group, and no descendant can
         enter hit testing. */
      html body [data-crm-home-precomposed][hidden]{
        display:block!important;position:fixed!important;inset:0!important;
        width:100vw!important;height:100vh!important;opacity:.001!important;
        z-index:0!important;pointer-events:none!important;transition:none!important}
      html body [data-crm-home-precomposed][hidden] *{pointer-events:none!important}
      .crm-home-motion-snapshot.crm-home-preview-image,
      .crm-home-motion-variant.crm-home-preview-image{display:none;position:absolute;inset:0;z-index:2;width:100%;height:100%;object-fit:fill;
        pointer-events:none;user-select:none;backface-visibility:hidden}
      .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-motion-variant.is-active-motion-variant{display:block;opacity:.001;transform:translateZ(0)}
      .crm-home-surface.crm-home-camera-moving.crm-home-bitmap-motion .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-motion-variant.is-active-motion-variant,
      .crm-home-surface.crm-home-camera-handoff .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-motion-variant.is-active-motion-variant{display:block;opacity:1}
      /* During camera motion the decoded cut-out raster is the sole Home
         owner. Keeping the live grid/hand/title tree beneath that identical
         image still asks Chromium to composite four backdrop surfaces on its
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
        filter:none;transition:none!important}
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-releasing .crm-home-title-layer{
        opacity:1!important;
        transition:opacity ${HOME_RETURN_INGRESS_MS}ms ${HOME_RETURN_HANDOFF_EASE}!important}
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-committing .crm-home-grid>.crm-home-bucket,
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-committing .crm-home-priority-hand{
        opacity:1!important;transition:none!important}
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-committing .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-motion-variant.is-active-motion-variant,
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-committing>.crm-home-expander:not(.crm-home-warm){
        opacity:.001!important;
        transition:none!important}
      .crm-home-surface.crm-home-camera-handoff.crm-home-camera-releasing>.crm-home-expander:not(.crm-home-warm) .crm-home-preview-foreground{
        filter:blur(.65px) saturate(.95) brightness(.88);
        transition:filter ${HOME_RETURN_INGRESS_MS}ms ${HOME_RETURN_HANDOFF_EASE}!important}
      /* The expander owns the selected room during travel. One precomposed
         variant carries every other Home object with the selected tile cut
         transparent and remains the covered owner while Home prepares for the
         endpoint exchange. */
      .crm-home-surface.crm-home-camera-moving.crm-home-bitmap-motion .crm-home-level[data-motion-snapshot-ready="true"]>.crm-home-grid>.crm-home-bucket:not(.is-camera-target)>.crm-home-preview{
        visibility:hidden}
      /* The motion cut-out carries the peripheral tiles' translucent coats,
         edges and contents, but a bitmap cannot carry backdrop-filter. One
         fixed, full-screen blur plane sits beneath that texture and is clipped
         to the three non-selected tile silhouettes. Only the clip moves, so
         Chromium never scales the acrylic radius with the camera root. */
      .crm-home-peripheral-acrylic-clip{position:absolute;inset:0;z-index:1;box-sizing:border-box;
        pointer-events:none;overflow:hidden;transform:translateZ(0);will-change:clip-path;backface-visibility:hidden}
      .crm-home-peripheral-screen-acrylic{position:absolute;inset:0;box-sizing:border-box;pointer-events:none;
        background:transparent;opacity:.001;transform:translateZ(0);
        will-change:opacity,backdrop-filter;backface-visibility:hidden}
      .crm-home-surface.crm-home-peripheral-acrylic-active>.crm-home-level:first-child{z-index:2!important}
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
      /* Home consumes the canonical glass material, but its four adjacent
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
      /* Freeze only the four resting tiles. The expander is also a
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
    `;
    document.head.appendChild(style);
  };

  const previewStateHTML = () => `<div class="crm-home-preview-state" role="status" aria-live="polite">
    <i class="crm-home-preview-state-mark" aria-hidden="true"></i><span>Preparing view</span></div>`;
  const bucketHTML = (module) => `<div class="crm-home-preview" data-preview-key="${esc(module.key)}" data-preview-state="waiting" aria-label="Loading preview">${previewStateHTML()}</div>`;
  const titleHTML = (module) => `<div class="crm-home-title-slot" data-module="${esc(module.key)}" data-tile-id="${esc(module.tile?.id || module.key)}">
    <div class="crm-home-title-glass"><div class="crm-home-title">${esc(module.label)}</div></div></div>`;

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
  const preloadSource = (src) => new Promise((resolve) => {
    const image = new Image(); let settled = false;
    const finish = () => { if (settled) return; settled = true; resolve(); };
    image.onload = finish; image.onerror = finish; image.src = src;
    image.decode?.().then(finish).catch(() => {});
  });
  const commitPreview = (preview) => {
    const existing = previews.get(preview.key);
    const existingAspect = Number(existing?.width) > 0 && Number(existing?.height) > 0 ? existing.width / existing.height : 0;
    const nextAspect = Number(preview.width) > 0 && Number(preview.height) > 0 ? preview.width / preview.height : 0;
    previews.set(preview.key, preview);
    if (camera?.isActive?.() && camera.level() === 0) {
      mountPreview(preview.key);
      if (nextAspect && Math.abs(nextAspect - existingAspect) > .0005 && !camera.isTransitioning?.()) {
        camera.layout();
        requestAnimationFrame(() => syncMotionSnapshot());
      }
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
    Promise.all([preloadSource(preview.foregroundSrc), preloadSource(preview.exactSrc)]).then(() => {
      if (pendingPreviews.get(preview.key)?.sequence !== sequence) return;
      entry.ready = true;
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
    if (reset) retryAttempt = 0;
    try { (await window.crmHomePreviews?.list?.())?.previews?.forEach(acceptPreview); } catch {}
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
        focusPrecomposedModule(target);
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
    && !camera?.isTransitioning?.()
    && !window.crmDeskTransit?.isBusy?.()
    && performance.now() >= factoryPrewarmAfter;
  const moduleKeyForTheater = (node) => node?.dataset?.crmTheater === "tickets" ? "cases" : String(node?.dataset?.crmTheater || "");
  const focusPrecomposedModule = (key) => {
    const theater = key === "cases" ? "tickets" : key;
    document.querySelectorAll("[data-crm-home-precomposed]").forEach((node) => {
      if (node.dataset.crmTheater !== theater) node.removeAttribute("data-crm-home-precomposed");
    });
    const node = [...document.querySelectorAll(`[data-crm-theater="${theater}"]`)].find((candidate) => candidate.hidden);
    if (node) node.setAttribute("data-crm-home-precomposed", key);
    return node;
  };
  const primeInactiveTheater = async (node, api) => {
    if (!node || api?.isActive?.() || !canPrewarmFactory()) return;
    node.hidden = true;
    node.setAttribute("data-crm-home-precomposed", moduleKeyForTheater(node));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!canPrewarmFactory()) {
      node.removeAttribute("data-crm-home-precomposed");
      return;
    }
    // Finish the factory's retained native-size geometry during idle prewarm.
    // Activation can then reuse those exact values rather than writing the
    // first bucket positions under (or after) the endpoint handoff.
    try { await api?.waitForGeometrySettled?.(); } catch {}
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
    homeTileRecords.forEach((module) => {
      const bucket = createTileInstance(module, {
        ariaLabel:`Open ${module.label}`,
        view:"preview",
        previewKey:module.key,
        previewState:"waiting",
        previewAriaLabel:"Loading preview",
        previewHTML:previewStateHTML(),
      });
      bucket.dataset.module = module.key;
      bucket.dataset.viewportModule = module.key;
      bucket.dataset.enabled = "true";
      // Do not activate merely because a tile finishes loading beneath an
      // already-stationary pointer. Actual pointer movement arms the reveal.
      bucket.addEventListener("pointermove", () => {
        focusPrecomposedModule(module.key);
        if (!bucket.dataset.previewReady || bucket.classList.contains("is-preview-hovered")) return;
        revealSharpPreview(bucket);
      });
      bucket.addEventListener("pointerleave", () => {
        restSharpPreview(bucket);
      });
      bucket.addEventListener("focus", () => revealSharpPreview(bucket));
      bucket.addEventListener("blur", () => restSharpPreview(bucket));
      grid.appendChild(bucket);
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
    const captured = homeTileRecords.map(({ key }) => previews.get(key)).find((preview) => Number(preview?.width) > 0 && Number(preview?.height) > 0);
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
  const createPeripheralAcrylic = () => {
    let clipHost = null;
    let lens = null;
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
      surface?.classList?.remove("crm-home-peripheral-acrylic-active");
      clipHost = null;
      lens = null;
      surface = null;
      state = null;
    };
    const park = () => {
      if (!lens) return false;
      stop();
      lens.style.opacity = "0";
      lens.dataset.crmPeripheralAcrylicPhase = "parked";
      surface?.classList?.remove("crm-home-peripheral-acrylic-active");
      return true;
    };
    const number = (value) => {
      const finite = Number(value);
      return (Number.isFinite(finite) ? finite : 0).toFixed(2);
    };
    const roundedRectCommands = ({ left, top, width, height, radiusX, radiusY }) => {
      const x = Number(left) || 0;
      const y = Number(top) || 0;
      const w = Math.max(.01, Number(width) || 0);
      const h = Math.max(.01, Number(height) || 0);
      const rx = Math.max(.01, Math.min(w / 2, Number(radiusX) || 0));
      const ry = Math.max(.01, Math.min(h / 2, Number(radiusY) || 0));
      return [
        `M ${number(x + rx)} ${number(y)}`,
        `H ${number(x + w - rx)}`,
        `A ${number(rx)} ${number(ry)} 0 0 1 ${number(x + w)} ${number(y + ry)}`,
        `V ${number(y + h - ry)}`,
        `A ${number(rx)} ${number(ry)} 0 0 1 ${number(x + w - rx)} ${number(y + h)}`,
        `H ${number(x + rx)}`,
        `A ${number(rx)} ${number(ry)} 0 0 1 ${number(x)} ${number(y + h - ry)}`,
        `V ${number(y + ry)}`,
        `A ${number(rx)} ${number(ry)} 0 0 1 ${number(x + rx)} ${number(y)}`,
        "Z",
      ].join(" ");
    };
    const pathFor = (rects) => `path("${rects.map(roundedRectCommands).join(" ")}")`;
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
      const neighbors = [...root.querySelectorAll(":scope > .crm-home-grid > .crm-home-bucket")]
        .filter((bucket) => (bucket.dataset?.tileId || moduleKeyOf(bucket)) !== selectedId);
      if (!neighbors.length) {
        finish();
        return null;
      }

      const surfaceRect = context.surface.getBoundingClientRect();
      const selectedLayout = context.sourceRect || context.layoutRect(target, root);
      const destination = context.expRect();
      const scaleX = destination.w / Math.max(1, selectedLayout.w);
      const scaleY = destination.h / Math.max(1, selectedLayout.h);
      const sourceRects = [];
      const destinationRects = [];
      neighbors.forEach((bucket) => {
        const rect = bucket.getBoundingClientRect();
        const layoutRect = context.layoutRect(bucket, root);
        const radius = radiusOf(bucket);
        sourceRects.push({
          left:rect.left - surfaceRect.left,
          top:rect.top - surfaceRect.top,
          width:rect.width,
          height:rect.height,
          radiusX:radius.x,
          radiusY:radius.y,
        });
        destinationRects.push({
          left:destination.x - surfaceRect.left + (layoutRect.x - selectedLayout.x) * scaleX,
          top:destination.y - surfaceRect.top + (layoutRect.y - selectedLayout.y) * scaleY,
          width:layoutRect.w * scaleX,
          height:layoutRect.h * scaleY,
          radiusX:radius.x * scaleX,
          radiusY:radius.y * scaleY,
        });
      });
      const sourcePath = pathFor(sourceRects);
      const destinationPath = pathFor(destinationRects);
      if (!CSS.supports("clip-path", sourcePath) || !CSS.supports("clip-path", destinationPath)) {
        finish();
        return null;
      }

      stop();
      if (!clipHost || clipHost.parentElement !== context.surface) {
        finish();
        surface = context.surface;
        clipHost = document.createElement("span");
        clipHost.className = "crm-home-peripheral-acrylic-clip";
        clipHost.setAttribute("aria-hidden", "true");
        lens = document.createElement("span");
        lens.className = "crm-home-peripheral-screen-acrylic";
        lens.setAttribute("aria-hidden", "true");
        clipHost.appendChild(lens);
        surface.appendChild(clipHost);
      }
      const material = getComputedStyle(neighbors[0]);
      const backdrop = material.webkitBackdropFilter || material.backdropFilter;
      lens.style.webkitBackdropFilter = backdrop;
      lens.style.backdropFilter = backdrop;
      lens.style.opacity = ".001";
      const direction = context.direction || "prewarm";
      const initialPath = direction === "contract" ? destinationPath : sourcePath;
      clipHost.style.clipPath = initialPath;
      clipHost.style.webkitClipPath = initialPath;
      lens.dataset.crmPeripheralAcrylicPhase = direction === "prewarm" ? "prewarm" : "prepared";
      lens.dataset.crmPeripheralAcrylicDirection = direction;
      state = {
        direction,
        sourcePath,
        destinationPath,
        neighborCount:neighbors.length,
        backdrop,
        duration:Number(context.morphMs) || 460,
        easing:context.ease || "cubic-bezier(.22, 1, .26, 1)",
      };
      return lens;
    };
    const setEnabled = (enabled) => {
      if (!lens || !state) return false;
      surface?.classList?.toggle("crm-home-peripheral-acrylic-active", !!enabled);
      lens.style.opacity = enabled ? "1" : ".001";
      lens.dataset.crmPeripheralAcrylicPhase = enabled ? "prepared" : "standby";
      return !!enabled;
    };
    const start = (direction, enabled = true) => {
      if (!lens || !state || state.direction !== direction || !enabled) {
        setEnabled(false);
        return null;
      }
      stop();
      setEnabled(true);
      lens.dataset.crmPeripheralAcrylicPhase = "motion";
      const from = direction === "expand" ? state.sourcePath : state.destinationPath;
      const to = direction === "expand" ? state.destinationPath : state.sourcePath;
      clipAnimation = clipHost.animate(
        [{ clipPath:from }, { clipPath:to }],
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
      clipHost.style.clipPath = state.sourcePath;
      clipHost.style.webkitClipPath = state.sourcePath;
      lens.style.opacity = ".001";
      lens.dataset.crmPeripheralAcrylicPhase = "prewarm";
      return lens;
    };
    const release = () => {
      if (!lens || !state) return Promise.resolve(false);
      const releaseLens = lens;
      const endpointPath = state.direction === "contract" ? state.sourcePath : state.destinationPath;
      stop();
      clipHost.style.clipPath = endpointPath;
      clipHost.style.webkitClipPath = endpointPath;
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
    const status = () => ({
      active:!!lens && ["motion", "release"].includes(lens.dataset.crmPeripheralAcrylicPhase || ""),
      phase:lens?.dataset?.crmPeripheralAcrylicPhase || "",
      direction:lens?.dataset?.crmPeripheralAcrylicDirection || state?.direction || "",
      neighborCount:state?.neighborCount || 0,
      backdropFilter:state?.backdrop || "",
      screenSpace:!!lens && getComputedStyle(lens).transform !== "",
    });
    return { prepare, setEnabled, start, sync, prime, release, park, finish, element:() => lens, status };
  };
  const homePeripheralAcrylic = createPeripheralAcrylic();
  const buildExpander = (target) => {
    const tile = homeTileRecords.find((candidate) => candidate.tile.id === target?.dataset?.tileId);
    const module = MODULES.find(({ key }) => key === (tile?.key || moduleKeyOf(target))) || MODULES[0];
    const bucket = recycledExpanders.get(module.key) || document.createElement("div");
    recycledExpanders.delete(module.key);
    bucket.className = "crm-home-bucket crm-home-expander";
    bindTileObject(bucket, tile || module, {
      ariaLabel:`Open ${tile?.label || module.label}`,
      view:"expanded-preview",
    });
    bucket.dataset.module = module.key;
    bucket.dataset.viewportModule = module.key;
    bucket.dataset.tileId = tile?.tile?.id || target?.dataset?.tileId || module.tile.id;
    if (!bucket.querySelector(".crm-home-preview")) bucket.innerHTML = bucketHTML(module);
    if (!bucket.querySelector(":scope > .crm-home-transition-acrylic")) {
      const acrylic = document.createElement("span");
      acrylic.className = "crm-home-transition-acrylic";
      acrylic.setAttribute("aria-hidden", "true");
      bucket.prepend(acrylic);
    }
    // One transparent, full-resolution room texture carries its objects and
    // shadows above a live acrylic lens. The fixed workspace wallpaper remains
    // the only background paint throughout the camera move.
    mountHost(bucket.querySelector(".crm-home-preview"), previews.get(module.key), true);
    return bucket;
  };
  const recycleExpander = (key, expander) => {
    if (!expander || !MODULES.some((module) => module.key === key)) return;
    const preview = expander.querySelector(":scope > .crm-home-preview");
    preview?.style.removeProperty("opacity");
    preview?.style.removeProperty("transition");
    expander.style.removeProperty("opacity");
    expander.style.removeProperty("transition");
    expander.classList.remove("crm-home-endpoint-cover");
    preview?.querySelector(":scope > .crm-home-endpoint-fallback")?.remove();
    delete expander.dataset.crmEndpointCover;
    expander.remove();
    expander.className = "crm-home-bucket crm-home-expander";
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
    const targetReady = !!selected && !!motionSnapshot?.src
      && motionSnapshot.layoutSignature === motionLayoutSignature(root)
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
      candidate.key === moduleKey && candidate.tile.id === routedTileId)
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
        const filter = foreground ? getComputedStyle(foreground).filter : "";
        const blur = Number(filter.match(/blur\(([\d.]+)px\)/)?.[1] || 0);
        ready = buckets.length === 4
          && buckets.every((node) => {
            const style = getComputedStyle(node);
            const backdrop = style.webkitBackdropFilter || style.backdropFilter;
            return Number(style.opacity) <= .01 && backdrop.includes("blur(");
          })
          && !!title
          && Number(getComputedStyle(title).opacity) >= .999
          && blur >= .649;
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
        homePeripheralAcrylic.park();
        await waitForHomeHandoffOwners(context, "outgoing");
        if (sequence !== handoffSequence) {
          handoffResolve?.();
          return;
        }
        // Keep the two zero-opacity backdrop planes mounted and reuse them on
        // the next trip; destroying both GPU surfaces here makes Chromium drop
        // unrelated acrylic layers for one native frame.
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
    ignoreSelector:".window-control-cluster,.background-tone-menu,.auth-shell,.auth-modal-backdrop,.crm-home-todo-popover,.crm-home-todo-menu",
    expandFadeMs:70,belowFadeMs:70,contractFadeMs:70,keepBelowVisibleDuringTransition:true,keepBelowVisibleDuringJump:true,precomposeTransitions:true,lockInputDuringTransitions:true,delegateClickToOwner:true,measureTop:()=>0,ensureStyles,buildRoot,layout,targetFromEvent,targetAtPoint,buildExpander,
    configureExpander:(expander,target,context)=>{homeAcrylicLens.prepare(expander,target,context);homePeripheralAcrylic.prepare(expander,target,context)},
    primeExpander:(expander,target,context)=>{
      const key = moduleKeyOf(target);
      selectMotionVariant(context.layers?.[0],target?.dataset?.tileId || key);
      homeAcrylicLens.prime();
      homePeripheralAcrylic.prime();
      // Hover precomposition also uploads the exact endpoint into the parked
      // body bridge. A subsequent click only animates compositor opacity near
      // landing; it never uploads a viewport-sized image during camera motion.
      void window.crmDeskTransit?.primeEndpointRaster?.(expander, key);
    },
    contractExpanderAbove:true,holdContractEndpointFrame:true,keepExpanderOpaqueDuringTransition:true,
    keyOf:(target)=>target.dataset.tileId||moduleKeyOf(target),sourceSelector:(target)=>`.crm-home-bucket[data-tile-id="${cssValue(target.dataset.tileId || moduleKeyOf(target))}"]`,
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
      homePeripheralAcrylic.setEnabled(ownsBitmapMotion);
      // Snapshot validity is maintained on data/layout changes. Recomputing its
      // complete geometry signature here forced style/layout immediately before
      // the first transform frame and made an otherwise compositor-only move
      // inherit a main-thread reaction hitch.
      context.surface?.classList.add("crm-home-camera-moving");
      context.surface?.classList.toggle("crm-home-camera-expanding",direction==="expand");
      context.surface?.classList.toggle("crm-home-camera-contracting",direction==="contract");
    },
    onTransformPrepare:(direction,context)=>{
      // The contract path deliberately spends two covered frames precomposing
      // Home. A selected cutout can finish decoding in that window, so make
      // this last pre-transform ownership decision authoritative.
      const ownsBitmapMotion = syncBitmapMotion(context);
      homeAcrylicLens.start(direction);
      homePeripheralAcrylic.start(direction, ownsBitmapMotion);
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
      if (direction === "expand") {
        // The destination coordinator cannot begin seating its exact endpoint
        // raster until this camera settles. Keep the real screen-space acrylic
        // fully owned while that cover is prepared instead of fading it first
        // and exposing the transparent room foreground over the wallpaper.
        if (window.crmDeskTransit?.isBusy?.()) {
          endpointAcrylicHeld = homeAcrylicLens.holdEndpoint();
        } else {
          await homeAcrylicLens.release();
        }
        homePeripheralAcrylic.finish();
      }
      context.surface?.classList.remove("crm-home-camera-moving","crm-home-camera-expanding","crm-home-camera-contracting","crm-home-acrylic-expanding","crm-home-acrylic-contracting","crm-home-bitmap-motion");
      const sequence = ++handoffSequence;
      let endpointPromise = null;
      if (direction === "contract" && context.layers?.[0]?.dataset?.motionSnapshotReady === "true") {
        endpointPromise = beginHomeHandoff(context, sequence, () => settleHomeEndpoint(context));
      } else {
        if (!endpointAcrylicHeld) homeAcrylicLens.finish();
        homePeripheralAcrylic.finish();
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
      if (context.active && context.level === 0 && !window.crmDeskTransit?.isBusy?.()) mountAll();
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

  const setActive = (on) => {
    subscribe();
    const changed = camera.isActive() !== !!on;
    if (changed) {
      if (!on) setInactiveMotionRetention(true);
      camera.setActive(on);
      if (on) setInactiveMotionRetention(false);
      if (on) factoryPrewarmAfter = performance.now() + 250;
    }
    if (on) {
      const transitBusy = !!window.crmDeskTransit?.isBusy?.();
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
      }
      if (transitBusy) activeRefreshPending = handDirty;
      else {
        activeRefreshPending = false;
        requestPreviews(false);
        if (handDirty) refreshPriorityHand();
      }
    }
    else {
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
  document.addEventListener("crm:desk-transit-settled", (event) => {
    scheduleTransitionMaintenance();
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
    const selector = {people:".tk-zone,.tk-card,.tk-zcard",cases:".tk-zone,.tk-deck",planner:".crm-project-bucket,.crm-planner-bucket,.crm-planner-card",assignments:".tk-zone,.tk-zcard"}[key]||"*";
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
    const selector = {people:".tk-zone,.tk-card,.tk-zcard",cases:".tk-zone,.tk-deck",planner:".crm-project-bucket,.crm-planner-bucket,.crm-planner-card",assignments:".tk-zone,.tk-zcard"}[key]||"*";
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
  window.addEventListener("resize",()=>{camera?.layout?.();requestAnimationFrame(()=>syncMotionSnapshot())});
  window.crmHome={setActive,isActive:()=>camera.isActive(),refresh:()=>{camera.layout();mountAll();requestPreviews(false);syncMotionSnapshot()},captureBaseline,captureDisplayedState,applyCaptureState,refreshDisplayedPreview,waitForPreviewSync,waitForModuleSettled,waitForModuleReady,waitForHandoff:()=>handoffPromise,noteModuleReady,recycleExpander,acceptPreview,
    endpointPreview:(key)=>{const preview=previews.get(key);return isRenderablePreview(preview)?{key,src:preview.exactSrc,capturedAt:preview.capturedAt||0,width:preview.width||0,height:preview.height||0}:null},
    acrylicState:()=>homeAcrylicLens.status(),
    retireEndpointAcrylic:()=>{
      if (homeAcrylicLens.status().phase !== "endpoint-held") return false;
      homeAcrylicLens.finish();
      return true;
    },
    peripheralAcrylicState:()=>homePeripheralAcrylic.status(),
    tiles:()=>clone(homeTileRecords),createTile:createHomeTile,removeTile:removeHomeTile,resetTiles:resetHomeTiles,
    previewStatus:()=>MODULES.map(({key})=>{const preview=previews.get(key);const pending=pendingPreviews.get(key);return{key,state:(pending||previewSyncKeys.has(key)||pendingDisplayedPreviewRefreshes.has(key))?"updating":preview?(isCurrentPreview(preview)?"ready":"stale"):"waiting",version:preview?.version||null,capturedAt:preview?.capturedAt||0,layoutSignature:preview?.layoutSignature||null}}),
    handStatus:()=>({ready:!handDirty,count:priorityItems.length,username:priorityUsername,day:todayKey(),ids:priorityItems.map((item)=>item.id),targets:priorityItems.map((item)=>priorityLink(item))}),
    ensureHandReady:refreshPriorityHand,motionLayoutSignature,motionStatus:()=>({ready:camera?.layers?.()[0]?.dataset?.motionSnapshotReady==="true",capturedAt:motionSnapshot?.capturedAt||0,layoutSignature:motionSnapshot?.layoutSignature||"",backgroundMode:motionSnapshot?.backgroundMode||"",materialMode:motionSnapshot?.materialMode||""}),
    prewarmStatus:()=>({ready:[...prewarmedFactories],running:factoryPrewarmRunning,pending:FACTORY_PREWARM_APIS.filter((name)=>!prewarmedFactories.has(name))})};
})();
