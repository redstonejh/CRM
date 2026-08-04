import {
  applyAdaptiveTileGrid,
  createTileObject,
  indexTileTree,
  mountTileChildren,
  tileObjectForElement,
} from "./modules/tile-system.js";

// Monitoring is a canonical tile world. Its two intentionally empty children
// are real tile objects mounted through the same collection primitive as Home,
// Projects, Calendar months, and Calendar days.
(() => {
  const GAP = 18;
  const INSET_X = 64;
  const TOP = 78;
  const BOTTOM = 96;
  let active = false;
  let root = null;
  let grid = null;
  let lastGeometry = null;

  const monitoringObject = createTileObject({
    tile:{
      id:"monitoring-root",
      key:"monitoring",
      title:"Monitoring",
      label:"Monitoring",
      kind:"monitoring-root",
      target:{ type:"workspace", id:"monitoring" },
    },
    data:{ domain:"monitoring", unit:"root" },
    children:[1, 2].map((index) => createTileObject({
      tile:{
        id:`monitoring-tile-${index}`,
        key:`monitoring-tile-${index}`,
        title:`Empty monitoring tile ${index}`,
        label:`Empty monitoring tile ${index}`,
        kind:"monitoring-tile",
        rank:index - 1,
        target:{ type:"monitoring-panel", id:`monitoring-panel-${index}` },
      },
      data:{
        domain:"monitoring",
        unit:"panel",
        index,
        empty:true,
      },
    })),
  });
  const monitoringIndex = indexTileTree(monitoringObject);

  const ensureStyles = () => {
    if (document.getElementById("crm-monitoring-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-monitoring-styles";
    style.textContent = `
      .crm-monitoring-surface{position:fixed;inset:0;z-index:800;
        overflow:hidden;pointer-events:none}
      .crm-monitoring-surface[hidden]{display:none}
      .crm-monitoring-grid{position:absolute;z-index:1;display:grid;
        gap:var(--crm-object-gap,18px);pointer-events:auto;
        contain:layout style;-webkit-app-region:no-drag}
      .crm-monitoring-tile{pointer-events:auto;cursor:default;
        -webkit-app-region:no-drag}
      .crm-monitoring-tile:hover{
        background:linear-gradient(180deg,rgba(22,26,36,.34),rgba(12,16,24,.28));
        box-shadow:inset 0 0 0 1px rgba(255,255,255,.14),
          inset 0 1px 0 rgba(255,255,255,.18),
          0 14px 26px -16px rgba(0,0,0,.72)}
    `;
    document.head.appendChild(style);
  };

  const layout = () => {
    if (!grid) return null;
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    lastGeometry = applyAdaptiveTileGrid({
      grid,
      bounds:{
        x:INSET_X,
        y:TOP,
        width:Math.max(1, width - INSET_X * 2),
        height:Math.max(1, height - TOP - BOTTOM),
      },
      count:monitoringObject.children.length,
      gap:GAP,
      aspect:width / height,
      maxRows:1,
    });
    root?.style.setProperty(
      "--home-r",
      `${Math.min(
        64,
        Math.max(
          2,
          16 / 245 * Math.min(
            lastGeometry?.cellWidth || 1,
            lastGeometry?.cellHeight || 1,
          ) * 2,
        ),
      ).toFixed(1)}px`,
    );
    return lastGeometry;
  };

  const mountTiles = () => {
    if (!grid) return [];
    return mountTileChildren(grid, monitoringObject, {
      elementOptions:(object) => ({
        tagName:"section",
        className:"crm-monitoring-tile crm-menu-surface",
        preview:false,
        view:"viewport",
        ariaLabel:object.tile.label,
      }),
      update:(element, object) => {
        element.dataset.monitoringTile = object.tile.id;
        element.dataset.monitoringEmpty = "true";
        element.replaceChildren();
      },
    });
  };

  const mount = () => {
    if (root) return root;
    ensureStyles();
    root = document.createElement("main");
    root.className = "crm-monitoring-surface";
    root.dataset.crmTheater = "monitoring";
    root.hidden = true;
    grid = document.createElement("section");
    grid.className = "crm-monitoring-grid";
    grid.setAttribute("aria-label", "Monitoring tiles");
    root.appendChild(grid);
    document.body.appendChild(root);
    mountTiles();
    layout();
    return root;
  };

  const setActive = (on) => {
    active = !!on;
    mount();
    root.hidden = !active;
    if (active) {
      mountTiles();
      layout();
      requestAnimationFrame(layout);
    }
    return api;
  };

  const baseline = async ({ canRender } = {}) => {
    mount();
    if (typeof canRender === "function" && !canRender()) return root;
    mountTiles();
    layout();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return root;
  };

  const waitForGeometrySettled = async () => {
    let stable = 0;
    let previous = "";
    const started = performance.now();
    while (performance.now() - started < 800) {
      const signature = [...(grid?.children || [])].map((tile) => {
        const rect = tile.getBoundingClientRect();
        return [
          tile.dataset.tileObjectId,
          rect.x.toFixed(2),
          rect.y.toFixed(2),
          rect.width.toFixed(2),
          rect.height.toFixed(2),
        ].join(":");
      }).join("|");
      stable = signature && signature === previous ? stable + 1 : 0;
      previous = signature;
      if (stable >= 3) return { stable:true, signature };
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return { stable:false, signature:previous };
  };

  const homePreviewState = () => ({ revision:1 });
  const applyHomePreviewState = async () => {
    await baseline();
    return homePreviewState();
  };

  window.addEventListener("resize", layout);
  const api = {
    setActive,
    isActive:() => active,
    baseline,
    waitForGeometrySettled,
    homePreviewState,
    applyHomePreviewState,
    refresh:() => {
      mountTiles();
      return layout();
    },
    level:() => 0,
    geometry:() => ({ ...(lastGeometry || {}) }),
    tiles:() => monitoringObject.children,
    _objectGraph:() => monitoringObject,
    _objectIndex:() => monitoringIndex,
    _objectForElement:tileObjectForElement,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once:true });
  } else mount();
  window.crmMonitoring = api;
})();
