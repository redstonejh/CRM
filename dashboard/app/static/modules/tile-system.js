// Canonical tile records and adaptive, equal-cell geometry shared by every
// viewport that presents a collection of tiles.
const TILE_SCHEMA_VERSION = 1;
const TILE_OBJECT_KIND = "crm-tile-object";
const tileObjectByElement = new WeakMap();

const text = (...values) => values
  .map((value) => String(value ?? "").trim())
  .find(Boolean) || "";
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function normalizeTileRecord(source = {}, defaults = {}) {
  const nested = source?.tile && typeof source.tile === "object" ? source.tile : {};
  const id = text(nested.id, source.id, source.key, defaults.id, defaults.key);
  const key = text(nested.key, source.key, defaults.key, id);
  const title = text(nested.title, source.title, source.label, defaults.title, defaults.label, "Untitled tile");
  const kind = text(nested.kind, source.tileKind, source.kind, defaults.kind, "tile");
  const targetType = text(
    nested.target?.type,
    source.target?.type,
    source.targetType,
    defaults.targetType,
    kind,
  );
  const targetId = text(
    nested.target?.id,
    source.target?.id,
    source.targetId,
    source.module,
    defaults.targetId,
    id,
  );
  return {
    schemaVersion:TILE_SCHEMA_VERSION,
    id,
    key,
    title,
    label:text(nested.label, source.label, defaults.label, title),
    kind,
    rank:number(nested.rank ?? source.rank, number(defaults.rank, 0)),
    target:{ type:targetType, id:targetId },
  };
}

export function normalizeTileCollection(records = [], defaults = {}) {
  const seen = new Set();
  return (Array.isArray(records) ? records : []).map((record, index) => {
    const tile = normalizeTileRecord(record, {
      ...defaults,
      rank:index,
      id:typeof defaults.id === "function" ? defaults.id(record, index) : defaults.id,
      key:typeof defaults.key === "function" ? defaults.key(record, index) : defaults.key,
    });
    let uniqueId = tile.id || `${tile.kind}-${index + 1}`;
    if (seen.has(uniqueId)) {
      const base = uniqueId;
      let suffix = 2;
      while (seen.has(`${base}-${suffix}`)) suffix += 1;
      uniqueId = `${base}-${suffix}`;
    }
    seen.add(uniqueId);
    return { ...record, tile:{ ...tile, id:uniqueId }, id:record?.id || uniqueId };
  });
}

export function bindTileElement(element, source = {}, options = {}) {
  if (!element) return null;
  const tile = normalizeTileRecord(source, options.defaults || {});
  if (options.canonicalClass !== false) {
    element.classList.add("crm-tile", "crm-home-bucket");
  }
  element.dataset.crmTile = tile.id;
  element.dataset.tileId = tile.id;
  element.dataset.tileKey = tile.key;
  element.dataset.tileKind = tile.kind;
  element.dataset.tileSchemaVersion = String(tile.schemaVersion);
  if (options.targetType !== false) element.dataset.tileTargetType = tile.target.type;
  if (options.targetId !== false) element.dataset.tileTargetId = tile.target.id;
  if (options.ariaLabel !== false) {
    element.setAttribute("aria-label", text(options.ariaLabel, tile.label, tile.title));
  }
  return tile;
}

export function createTileElement(source = {}, options = {}) {
  const tagName = text(options.tagName, "button").toLowerCase();
  const element = document.createElement(tagName);
  if (tagName === "button") element.type = text(options.type, "button");
  text(options.className).split(/\s+/).filter(Boolean).forEach((name) => element.classList.add(name));
  bindTileElement(element, source, options);
  if (options.tabIndex != null) element.tabIndex = Number(options.tabIndex);
  return element;
}

const tileRecordOf = (object) => (
  object?.tile && typeof object.tile === "object" ? object.tile : object
);

// Every interactive viewport object uses this one semantic shape. Domain
// modules may add their own payload fields, but a Home room, Calendar month,
// and Calendar day are all the same canonical tile object with the same tile
// record and child collection.
export function createTileObject(source = {}, options = {}) {
  const input = source && typeof source === "object" ? source : {};
  const object = input.objectKind === TILE_OBJECT_KIND ? input : { ...input };
  object.objectKind = TILE_OBJECT_KIND;
  object.tile = normalizeTileRecord(tileRecordOf(input), options.defaults || {});
  if (!Array.isArray(object.children)) {
    object.children = Array.isArray(options.children) ? options.children : [];
  }
  if (!Number.isFinite(Number(object.revision))) object.revision = 0;
  return object;
}

export function isTileObject(object) {
  return !!object
    && object.objectKind === TILE_OBJECT_KIND
    && object.tile?.schemaVersion === TILE_SCHEMA_VERSION
    && Array.isArray(object.children);
}

export function tileKindOf(object) {
  return isTileObject(object) ? object.tile.kind : "";
}

// A tile object is the persistent semantic object. Any number of visual LODs
// may be bound to it without promoting an inert preview into an interactive
// tile. This is how a preview and its entered viewport retain strict object
// identity while owning different DOM representations.
export function bindTileObject(element, object, options = {}) {
  if (!element || !object) return null;
  const record = tileRecordOf(object);
  const tile = options.bindSchema === false
    ? normalizeTileRecord(record, options.defaults || {})
    : bindTileElement(element, record, options);
  tileObjectByElement.set(element, object);
  element.dataset.tileObjectId = tile.id;
  if (options.view != null) element.dataset.tileObjectView = text(options.view);
  return object;
}

export function createTileObjectElement(object, options = {}) {
  const tagName = text(options.tagName, "button").toLowerCase();
  const element = document.createElement(tagName);
  if (tagName === "button") element.type = text(options.type, "button");
  text(options.className).split(/\s+/).filter(Boolean).forEach((name) => {
    element.classList.add(name);
  });
  bindTileObject(element, object, options);
  if (options.tabIndex != null) element.tabIndex = Number(options.tabIndex);
  return element;
}

// This is the concrete viewport-tile primitive. It owns the canonical button
// and the preview surface together so modules cannot quietly substitute a
// look-alike component that only carries tile-shaped data attributes.
export function createTileInstance(object, options = {}) {
  const element = createTileObjectElement(object, options);
  element.dataset.crmTileInstance = "viewport";
  if (options.preview === false) return element;

  const preview = document.createElement("div");
  preview.className = [
    "crm-home-preview",
    text(options.previewClassName),
  ].filter(Boolean).join(" ");
  preview.dataset.previewKey = text(
    options.previewKey,
    object?.tile?.id,
    object?.tile?.key,
  );
  preview.dataset.previewState = text(options.previewState, "waiting");
  if (options.previewAriaLabel) {
    preview.setAttribute("aria-label", text(options.previewAriaLabel));
  } else if (options.previewAriaHidden !== false) {
    preview.setAttribute("aria-hidden", "true");
  }
  if (options.previewHTML != null) preview.innerHTML = String(options.previewHTML);
  element.appendChild(preview);
  return element;
}

export function tilePreviewHostFor(element) {
  return element?.querySelector?.(":scope > .crm-home-preview") || null;
}

export function tileObjectForElement(element) {
  return element ? tileObjectByElement.get(element) || null : null;
}

function roundedTilePath(box) {
  const x = number(box?.x);
  const y = number(box?.y);
  const width = Math.max(0, number(box?.width));
  const height = Math.max(0, number(box?.height));
  const radius = Math.min(width / 2, height / 2, Math.max(0, number(box?.radius)));
  const fixed = (value) => Number(value).toFixed(2);
  return [
    `M ${fixed(x + radius)} ${fixed(y)}`,
    `L ${fixed(x + width - radius)} ${fixed(y)}`,
    `A ${fixed(radius)} ${fixed(radius)} 0 0 1 ${fixed(x + width)} ${fixed(y + radius)}`,
    `L ${fixed(x + width)} ${fixed(y + height - radius)}`,
    `A ${fixed(radius)} ${fixed(radius)} 0 0 1 ${fixed(x + width - radius)} ${fixed(y + height)}`,
    `L ${fixed(x + radius)} ${fixed(y + height)}`,
    `A ${fixed(radius)} ${fixed(radius)} 0 0 1 ${fixed(x)} ${fixed(y + height - radius)}`,
    `L ${fixed(x)} ${fixed(y + radius)}`,
    `A ${fixed(radius)} ${fixed(radius)} 0 0 1 ${fixed(x + radius)} ${fixed(y)} Z`,
  ].join(" ");
}

function localTileBox(tile, root, options = {}) {
  if (!tile || !root) return null;
  const rootRect = root.getBoundingClientRect();
  const scaleX = root.offsetWidth ? rootRect.width / root.offsetWidth : 1;
  const scaleY = root.offsetHeight ? rootRect.height / root.offsetHeight : 1;
  let x = 0;
  let y = 0;
  let width = tile.offsetWidth;
  let height = tile.offsetHeight;
  if (options.precise === true) {
    const tileRect = tile.getBoundingClientRect();
    x = (tileRect.left - rootRect.left) / Math.max(.0001, scaleX);
    y = (tileRect.top - rootRect.top) / Math.max(.0001, scaleY);
    width = tileRect.width / Math.max(.0001, scaleX);
    height = tileRect.height / Math.max(.0001, scaleY);
  } else {
    let cursor = tile;
    while (cursor && cursor !== root) {
      x += cursor.offsetLeft || 0;
      y += cursor.offsetTop || 0;
      cursor = cursor.offsetParent;
    }
    if (cursor !== root) {
      const tileRect = tile.getBoundingClientRect();
      x = (tileRect.left - rootRect.left) / Math.max(.0001, scaleX);
      y = (tileRect.top - rootRect.top) / Math.max(.0001, scaleY);
      width = tileRect.width / Math.max(.0001, scaleX);
      height = tileRect.height / Math.max(.0001, scaleY);
    }
  }
  const measuredRadius = parseFloat(getComputedStyle(tile).borderTopLeftRadius) || 0;
  const configuredRadius = typeof options.radius === "function"
    ? options.radius(tile, measuredRadius)
    : options.radius;
  return {
    x,
    y,
    width,
    height,
    radius:Number.isFinite(Number(configuredRadius)) ? Number(configuredRadius) : measuredRadius,
  };
}

export function tileUnionPath(tiles = [], root, options = {}) {
  const parts = [...tiles]
    .map((tile) => localTileBox(tile, root, options))
    .filter((box) => box && box.width > 0 && box.height > 0)
    .map(roundedTilePath);
  return parts.length ? `path('${parts.join(" ")}')` : "none";
}

const materialPlanes = new WeakMap();

export function syncTileMaterialPlane(planeOrHost, options = {}) {
  const plane = planeOrHost?.classList?.contains("crm-tile-material-plane")
    ? planeOrHost
    : planeOrHost?.querySelector?.(":scope > .crm-tile-material-plane");
  if (!plane) return null;
  const state = materialPlanes.get(plane) || {};
  const host = state.host || plane.parentElement;
  const selector = options.tileSelector || state.tileSelector || ":scope [data-crm-tile]";
  const excluded = new Set(options.exclude || state.exclude || []);
  const tiles = [...(host?.querySelectorAll?.(selector) || [])]
    .filter((tile) => !excluded.has(tile));
  const value = tileUnionPath(tiles, host);
  plane.style.clipPath = value;
  plane.style.webkitClipPath = value;
  plane.dataset.crmTileMaterialCount = String(tiles.length);
  plane.dataset.crmTileMaterialReady = String(value !== "none");
  materialPlanes.set(plane, { ...state, host, tileSelector:selector, exclude:excluded });
  return plane;
}

export function ensureTileMaterialPlane(host, options = {}) {
  if (!host) return null;
  let plane = host.querySelector?.(":scope > .crm-tile-material-plane") || null;
  if (!plane) {
    plane = document.createElement("span");
    plane.className = "crm-tile-material-plane";
    plane.setAttribute("aria-hidden", "true");
    host.prepend(plane);
  }
  text(options.className).split(/\s+/).filter(Boolean).forEach((name) => plane.classList.add(name));
  materialPlanes.set(plane, {
    host,
    tileSelector:options.tileSelector || ":scope [data-crm-tile]",
    exclude:new Set(options.exclude || []),
  });
  syncTileMaterialPlane(plane);
  return plane;
}

function candidateScore(candidate, count, width, height) {
  const occupied = candidate.cellWidth * candidate.cellHeight * count;
  const coverage = occupied / Math.max(1, width * height);
  const empty = candidate.columns * candidate.rows - count;
  // Cell area is the primary objective. A small coverage/empty-cell bias keeps
  // equally useful arrangements stable as the collection crosses a boundary.
  return candidate.cellWidth * candidate.cellHeight
    + coverage * 10
    - empty * Math.max(1, candidate.cellWidth * candidate.cellHeight) * .012;
}

export function calculateAdaptiveTileGrid(options = {}) {
  const count = Math.max(0, Math.floor(number(options.count, 0)));
  const width = Math.max(1, number(options.width, 1));
  const height = Math.max(1, number(options.height, 1));
  const gap = Math.max(0, number(options.gap, 0));
  const aspect = Math.max(.05, number(options.aspect, width / height || 1));
  const maxColumns = clamp(Math.floor(number(options.maxColumns, count || 1)), 1, Math.max(1, count));
  const maxRows = clamp(Math.floor(number(options.maxRows, count || 1)), 1, Math.max(1, count));
  if (!count) {
    return {
      count:0, columns:0, rows:0, cellWidth:0, cellHeight:0,
      gridWidth:0, gridHeight:0, left:width / 2, top:height / 2, gap, aspect,
    };
  }

  let best = null;
  for (let columns = 1; columns <= Math.min(count, maxColumns); columns += 1) {
    const rows = Math.ceil(count / columns);
    if (rows > maxRows) continue;
    const widthBound = Math.max(1, (width - gap * (columns - 1)) / columns);
    const heightBound = Math.max(1, (height - gap * (rows - 1)) / rows);
    const cellWidth = Math.max(1, Math.min(widthBound, heightBound * aspect));
    const cellHeight = Math.max(1, cellWidth / aspect);
    const candidate = {
      count, columns, rows, cellWidth, cellHeight,
      gridWidth:cellWidth * columns + gap * (columns - 1),
      gridHeight:cellHeight * rows + gap * (rows - 1),
      gap, aspect,
    };
    const score = candidateScore(candidate, count, width, height);
    if (!best || score > best.score + .001 || (Math.abs(score - best.score) <= .001 && columns < best.columns)) {
      best = { ...candidate, score };
    }
  }
  // A restrictive maxRows/maxColumns pair may not have admitted a candidate.
  if (!best) return calculateAdaptiveTileGrid({ ...options, maxRows:count, maxColumns:count });
  const alignX = options.alignX === "start" ? 0 : options.alignX === "end" ? 1 : .5;
  const alignY = options.alignY === "start" ? 0 : options.alignY === "end" ? 1 : .5;
  return {
    ...best,
    left:Math.max(0, (width - best.gridWidth) * alignX),
    top:Math.max(0, (height - best.gridHeight) * alignY),
  };
}

export function applyAdaptiveTileGrid(options = {}) {
  const grid = options.grid;
  if (!grid) return null;
  const bounds = options.bounds || {
    x:0,
    y:0,
    width:grid.parentElement?.clientWidth || grid.clientWidth || 1,
    height:grid.parentElement?.clientHeight || grid.clientHeight || 1,
  };
  const count = Math.max(0, Math.floor(number(
    options.count,
    options.tileSelector ? grid.querySelectorAll(options.tileSelector).length : grid.children.length,
  )));
  const geometry = calculateAdaptiveTileGrid({
    ...options,
    count,
    width:bounds.width ?? bounds.w,
    height:bounds.height ?? bounds.h,
  });
  const styles = geometry.count ? {
    left:`${number(bounds.x, 0) + geometry.left}px`,
    top:`${number(bounds.y, 0) + geometry.top}px`,
    width:`${geometry.gridWidth}px`,
    height:`${geometry.gridHeight}px`,
    gridTemplateColumns:`repeat(${geometry.columns},minmax(0,${geometry.cellWidth}px))`,
    gridTemplateRows:`repeat(${geometry.rows},minmax(0,${geometry.cellHeight}px))`,
  } : {
    left:`${number(bounds.x, 0)}px`,
    top:`${number(bounds.y, 0)}px`,
    width:"0px",
    height:"0px",
    gridTemplateColumns:"none",
    gridTemplateRows:"none",
  };
  Object.assign(grid.style, styles);
  grid.dataset.crmTileColumns = String(geometry.columns);
  grid.dataset.crmTileRows = String(geometry.rows);
  grid.dataset.crmTileCount = String(geometry.count);
  grid.style.setProperty("--crm-adaptive-tile-width", `${geometry.cellWidth}px`);
  grid.style.setProperty("--crm-adaptive-tile-height", `${geometry.cellHeight}px`);
  grid.style.setProperty("--crm-adaptive-tile-gap", `${geometry.gap}px`);
  (Array.isArray(options.mirrors) ? options.mirrors : [options.mirror]).filter(Boolean).forEach((mirror) => {
    Object.assign(mirror.style, styles);
    mirror.dataset.crmTileColumns = String(geometry.columns);
    mirror.dataset.crmTileRows = String(geometry.rows);
    mirror.dataset.crmTileCount = String(geometry.count);
  });
  return geometry;
}

const observers = new WeakMap();

export function observeAdaptiveTileContainer(container, options = {}) {
  if (!container) return () => {};
  observers.get(container)?.disconnect?.();
  const layout = () => {
    const bounds = options.bounds?.() || {
      x:0, y:0,
      width:container.parentElement?.clientWidth || container.clientWidth || 1,
      height:container.parentElement?.clientHeight || container.clientHeight || 1,
    };
    return applyAdaptiveTileGrid({
      ...options,
      grid:container,
      bounds,
      count:typeof options.count === "function" ? options.count() : options.count,
      mirror:typeof options.mirror === "function" ? options.mirror() : options.mirror,
    });
  };
  const mutation = new MutationObserver(layout);
  mutation.observe(container, { childList:true });
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(layout) : null;
  resize?.observe(container.parentElement || container);
  const observer = {
    layout,
    disconnect() { mutation.disconnect(); resize?.disconnect(); observers.delete(container); },
  };
  observers.set(container, observer);
  requestAnimationFrame(layout);
  return observer.disconnect;
}

export function installAdaptiveTileArchitecture(root = document) {
  const scan = (scope = root) => {
    scope.querySelectorAll?.('[data-crm-adaptive-tiles="auto"]').forEach((container) => {
      if (observers.has(container)) return;
      observeAdaptiveTileContainer(container, {
        gap:number(container.dataset.crmTileGap, 18),
        aspect:number(container.dataset.crmTileAspect, 1.5),
        tileSelector:container.dataset.crmTileSelector || ":scope > [data-crm-tile]",
      });
    });
  };
  scan();
  const mutation = new MutationObserver((entries) => entries.forEach((entry) => entry.addedNodes.forEach((node) => {
    if (node.nodeType !== 1) return;
    if (node.matches?.('[data-crm-adaptive-tiles="auto"]')) scan(node.parentElement || root);
    else scan(node);
  })));
  mutation.observe(root.documentElement || root, { childList:true, subtree:true });
  return () => mutation.disconnect();
}

export const crmTileSystem = {
  schemaVersion:TILE_SCHEMA_VERSION,
  objectKind:TILE_OBJECT_KIND,
  normalize:normalizeTileRecord,
  normalizeAll:normalizeTileCollection,
  createObjectRecord:createTileObject,
  isObject:isTileObject,
  kindOf:tileKindOf,
  bind:bindTileElement,
  create:createTileElement,
  bindObject:bindTileObject,
  createObject:createTileObjectElement,
  createInstance:createTileInstance,
  previewHostFor:tilePreviewHostFor,
  objectFor:tileObjectForElement,
  tileUnionPath,
  ensureMaterial:ensureTileMaterialPlane,
  syncMaterial:syncTileMaterialPlane,
  calculate:calculateAdaptiveTileGrid,
  apply:applyAdaptiveTileGrid,
  observe:observeAdaptiveTileContainer,
  install:installAdaptiveTileArchitecture,
};

if (typeof window !== "undefined") {
  window.crmTileSystem = Object.assign(window.crmTileSystem || {}, crmTileSystem);
  const install = () => {
    if (window.__crmAdaptiveTileArchitectureInstalled) return;
    window.__crmAdaptiveTileArchitectureInstalled = true;
    window.__crmAdaptiveTileArchitectureDispose = installAdaptiveTileArchitecture(document);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once:true });
  else install();
}
