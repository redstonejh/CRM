import {
  applyAdaptiveTileGrid,
  createTileObject,
  ensureTileMaterialPlane,
  indexTileTree,
  mountTileChildren,
  normalizeTileRecord,
  reconcileTileChildren,
  syncTileMaterialPlane,
  tileObjectForElement,
} from "./modules/tile-system.js";

// Two canonical monitoring tiles backed by the original retained MQTT topic
// tree. The old dashboard builder remains empty; monitoring owns only these
// two objects and changes their contents in place as broker messages arrive.
(() => {
  const GAP = 18;
  const INSET_X = 64;
  const TOP = 78;
  const BOTTOM = 96;
  const REFRESH_MS = 15000;
  const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (character) => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;",
  }[character]));
  const text = (value) => String(value ?? "").trim();
  const timeLabel = (value) => {
    const parsed = typeof value === "number" ? value : Date.parse(value || "");
    if (!Number.isFinite(parsed)) return "No timestamp";
    const ageSeconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
    if (ageSeconds < 60) return `${ageSeconds}s ago`;
    if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m ago`;
    if (ageSeconds < 86400) return `${Math.floor(ageSeconds / 3600)}h ago`;
    return new Date(parsed).toLocaleString([], { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });
  };
  const severityLabel = (value) => ({
    green:"Good",
    yellow:"Degraded",
    red:"Down",
    offline:"Offline",
    grey:"Unknown",
  }[value] || "Unknown");

  let active = false;
  let root = null;
  let grid = null;
  let material = null;
  let lastGeometry = null;
  let selectedView = "live";
  let refreshTimer = 0;
  let refreshFrame = 0;
  let loadSequence = 0;
  let unsubscribe = null;
  const monitoringObject = createTileObject({
    tile:{
      id:"monitoring",
      key:"monitoring",
      title:"Monitoring",
      label:"Monitoring",
      kind:"monitoring-root",
      target:{ type:"workspace", id:"monitoring" },
    },
    data:{
      domain:"monitoring", unit:"root", moduleKey:"monitoring", key:"monitoring",
      label:"Monitoring", snapshot:null, error:"", loadedAt:0,
    },
    children:[
      createTileObject({
        tile:{
          id:"monitoring-live",
          key:"live",
          title:"Live Status",
          label:"Live Status",
          kind:"monitoring-tile",
          rank:0,
          target:{ type:"monitoring-panel", id:"live" },
        },
        data:{ domain:"monitoring", unit:"panel", view:"live" },
      }),
      createTileObject({
        tile:{
          id:"monitoring-history",
          key:"history",
          title:"History & Incidents",
          label:"History & Incidents",
          kind:"monitoring-tile",
          rank:1,
          target:{ type:"monitoring-panel", id:"history" },
        },
        data:{ domain:"monitoring", unit:"panel", view:"history" },
      }),
    ],
  });
  let monitoringIndex = indexTileTree(monitoringObject);
  const liveObject = monitoringObject.children.find((object) => object.data.view === "live");
  const historyObject = monitoringObject.children.find((object) => object.data.view === "history");

  const canonicalSignature = (value) => {
    try { return JSON.stringify(value); } catch { return String(value ?? ""); }
  };
  const stableHash = (value) => {
    let hash = 2166136261;
    for (const character of String(value || "")) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  };
  const syncObject = (object, tile, data, signature) => {
    const nextSignature = canonicalSignature(signature);
    if (object.data.canonicalSignature !== nextSignature) object.revision += 1;
    object.tile = normalizeTileRecord(tile, object.tile);
    Object.assign(object.data, data, { canonicalSignature:nextSignature });
    return object;
  };
  const notifyTreeChanged = (reason) => {
    monitoringIndex = indexTileTree(monitoringObject);
    document.dispatchEvent(new CustomEvent("crm:canonical-tree-changed", {
      detail:{ root:monitoringObject, moduleKey:"monitoring", reason },
    }));
  };
  const reconcileMonitoringRecords = (panelObject, records) => {
    const duplicates = new Map();
    const entries = (Array.isArray(records) ? records : []).map((record, index) => {
      const identity = canonicalSignature([
        record.topic || record.id || record.machine || record.label || index,
        panelObject.data.view === "history" ? record.checkedAt || record.createdAt || record.timestamp || "" : "",
      ]);
      const duplicate = duplicates.get(identity) || 0;
      duplicates.set(identity, duplicate + 1);
      return {
        id:`${panelObject.tile.id}-record-${stableHash(identity)}${duplicate ? `-${duplicate + 1}` : ""}`,
        record,
      };
    });
    reconcileTileChildren(panelObject, entries, {
      keyOf:(entry) => entry.id,
      create:(entry, rank) => createTileObject({
        tile:{
          id:entry.id, key:entry.id,
          title:text(entry.record.label || entry.record.machine || "Monitoring check"),
          label:text(entry.record.label || entry.record.machine || "Monitoring check"),
          kind:"monitoring-record", rank,
          target:{ type:"monitoring-record", id:entry.id },
        },
        data:{ domain:"monitoring", unit:"record", view:panelObject.data.view, record:entry.record },
        children:[],
      }),
      update:(object, entry, rank) => syncObject(object, {
        ...object.tile,
        title:text(entry.record.label || entry.record.machine || "Monitoring check"),
        label:text(entry.record.label || entry.record.machine || "Monitoring check"),
        rank,
      }, { record:entry.record, view:panelObject.data.view }, [entry.id, entry.record]),
    });
  };

  const scopeClient = () => window.crmClientContext?.scope?.() || null;
  const scopeLabel = () => scopeClient()?.label || "All monitored systems";
  const bridge = () => window.crmMonitoringData;

  const ensureStyles = () => {
    if (document.getElementById("crm-monitoring-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-monitoring-styles";
    style.textContent = `
      .crm-monitoring-surface{position:fixed;inset:0;z-index:800;overflow:hidden;pointer-events:none}
      .crm-monitoring-surface[hidden]{display:none}
      .crm-monitoring-grid{position:absolute;z-index:1;display:grid;isolation:isolate;
        gap:var(--crm-object-gap,18px);pointer-events:auto;contain:layout style;
        -webkit-app-region:no-drag}
      .crm-monitoring-material{position:absolute!important;z-index:0!important;inset:0;
        pointer-events:none;background:var(--bucket-acrylic-surface);
        border:1px solid var(--bucket-acrylic-border);
        box-shadow:var(--bucket-acrylic-shadow);
        backdrop-filter:var(--bucket-acrylic-filter);
        -webkit-backdrop-filter:var(--bucket-acrylic-filter)}
      .crm-monitoring-tile{position:relative;z-index:1;display:flex;min-width:0;min-height:0;
        box-sizing:border-box;flex-direction:column;padding:12px;overflow:hidden;
        color:#fff;border:1px solid var(--bucket-acrylic-border);
        border-radius:var(--home-r,24px);
        background:linear-gradient(180deg,rgba(22,27,38,.25),rgba(10,14,22,.2));
        box-shadow:var(--bucket-acrylic-shadow);pointer-events:auto;
        -webkit-app-region:no-drag;transition:border-color .14s ease,box-shadow .14s ease}
      .crm-monitoring-tile[data-monitoring-selected="true"]{border-color:rgba(255,255,255,.28);
        box-shadow:inset 0 1px rgba(255,255,255,.2),0 18px 34px -22px rgba(0,0,0,.86)}
      .crm-monitor-head{display:flex;align-items:center;gap:7px;min-height:42px;padding:1px 2px 9px}
      .crm-monitor-head>div:first-child{min-width:0;margin-right:auto}
      .crm-monitor-kicker{display:block;color:rgba(230,237,248,.46);
        font-size:var(--crm-type-micro,9px);font-weight:800;letter-spacing:.1em;text-transform:uppercase}
      .crm-monitor-title{margin:1px 0 0;font-size:var(--crm-type-room,17px);line-height:1.2}
      .crm-monitor-connection{display:inline-flex;align-items:center;gap:6px;max-width:150px;
        color:rgba(235,241,249,.58);font-size:var(--crm-type-meta,10px);white-space:nowrap;
        overflow:hidden;text-overflow:ellipsis}
      .crm-monitor-dot{display:inline-block;flex:0 0 7px;width:7px;height:7px;border-radius:50%;
        background:rgba(150,160,175,.7);box-shadow:0 0 0 3px rgba(150,160,175,.08)}
      .crm-monitor-dot[data-severity="green"]{background:#65d58a;box-shadow:0 0 0 3px rgba(101,213,138,.1)}
      .crm-monitor-dot[data-severity="yellow"]{background:#e2bd64;box-shadow:0 0 0 3px rgba(226,189,100,.1)}
      .crm-monitor-dot[data-severity="red"]{background:#e87972;box-shadow:0 0 0 3px rgba(232,121,114,.1)}
      .crm-monitor-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;padding:0 0 10px}
      .crm-monitor-stat{display:flex;min-width:0;min-height:48px;box-sizing:border-box;
        flex-direction:column;justify-content:center;padding:7px 9px;border:1px solid rgba(255,255,255,.09);
        border-radius:11px;background:rgba(14,19,28,.32)}
      .crm-monitor-stat span{color:rgba(230,237,248,.4);font-size:var(--crm-type-micro,9px);
        letter-spacing:.04em;text-transform:uppercase}
      .crm-monitor-stat strong{margin-top:2px;font-size:var(--crm-type-object,14px);font-weight:760}
      .crm-monitor-list{display:flex;min-height:0;flex:1 1 auto;flex-direction:column;gap:6px;
        overflow-y:auto;padding:1px 1px 8px;scrollbar-width:thin}
      .crm-monitor-row{display:grid;grid-template-columns:10px minmax(0,1fr) auto;align-items:center;
        gap:9px;min-height:53px;padding:8px 10px;box-sizing:border-box;border:1px solid rgba(255,255,255,.1);
        border-radius:12px;background:linear-gradient(150deg,rgba(57,68,86,.57),rgba(27,34,46,.5));
        box-shadow:inset 0 1px rgba(255,255,255,.1)}
      .crm-monitor-row-main{min-width:0}.crm-monitor-row-title{display:block;overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap;font-size:var(--crm-type-body,12px);font-weight:700}
      .crm-monitor-row-detail{display:block;margin-top:3px;overflow:hidden;text-overflow:ellipsis;
        white-space:nowrap;color:rgba(229,236,247,.45);font-size:var(--crm-type-meta,10px)}
      .crm-monitor-row-time{text-align:right;color:rgba(229,236,247,.38);
        font-size:var(--crm-type-micro,9px);white-space:nowrap}
      .crm-monitor-empty{display:grid;min-height:100px;flex:1 1 auto;place-items:center;padding:20px;
        text-align:center;color:rgba(230,237,247,.42);font-size:var(--crm-type-caption,11px);line-height:1.5}
      .crm-monitor-foot{display:flex;align-items:center;gap:6px;min-height:20px;padding:4px 2px 0;
        color:rgba(230,237,247,.34);font-size:var(--crm-type-micro,9px)}
      .crm-monitor-foot span:first-child{margin-right:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .crm-monitor-error{color:rgba(255,181,174,.7)}
      @media(max-width:850px){.crm-monitoring-grid{overflow-x:auto}.crm-monitoring-tile{min-width:360px}
        .crm-monitor-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
    `;
    document.head.appendChild(style);
  };

  const panel = (view) => grid?.querySelector?.(`[data-monitoring-view="${view}"]`) || null;
  const updateMonitoringRow = (element, object) => {
    const record = object.data.record;
    const revision = String(object.revision);
    if (element.dataset.monitorRecordRevision === revision) return element;
    element.dataset.monitorRecordRevision = revision;
    element.setAttribute("aria-label", object.tile.label);
    const severity = text(record.severity || "grey");
    const detail = text(record.detail)
      || [text(record.host), record.latencyMs == null ? "" : `${record.latencyMs} ms`]
        .filter(Boolean).join(" · ");
    element.dataset.monitorRecord = text(record.topic || record.id);
    element.innerHTML = `<span class="crm-monitor-dot" data-severity="${esc(severity)}" aria-label="${esc(severityLabel(severity))}"></span>
      <span class="crm-monitor-row-main"><span class="crm-monitor-row-title">${esc(record.label || record.machine || "Monitoring check")}</span>
      <span class="crm-monitor-row-detail">${esc(detail || severityLabel(severity))}</span></span>
      <span class="crm-monitor-row-time">${esc(timeLabel(record.checkedAt))}</span>`;
    return element;
  };
  const ensurePanelStructure = (element) => {
    if (element.querySelector(":scope > .crm-monitor-head")) return;
    element.innerHTML = `<header class="crm-monitor-head"><div><span class="crm-monitor-kicker"></span>
      <h2 class="crm-monitor-title"></h2></div>
      <span class="crm-monitor-connection"><span class="crm-monitor-dot"></span><span data-monitor-connection-label></span></span>
      <button type="button" class="crm-menu-action" data-monitor-refresh>Refresh</button></header>
      <section class="crm-monitor-stats" aria-label="Monitoring totals">${[0, 1, 2, 3].map((index) => `<div class="crm-monitor-stat" data-monitor-stat="${index}"><span></span><strong></strong></div>`).join("")}</section>
      <div class="crm-monitor-list"></div><footer class="crm-monitor-foot"><span></span><span></span></footer>`;
  };
  const renderPanel = (element, object) => {
    ensurePanelStructure(element);
    const view = object.data.view;
    const snapshot = monitoringObject.data.snapshot;
    const totals = snapshot?.totals || {};
    const error = monitoringObject.data.error;
    const scope = scopeLabel();
    const incidents = historyObject.children.filter((entry) => (
      ["red", "yellow", "offline"].includes(entry.data.record?.severity)
    ));
    const live = view === "live";
    const connection = snapshot?.status?.connection || (error ? "offline" : "connecting");
    const connectionSeverity = connection === "live" ? "green" : (liveObject.children.length ? "yellow" : "grey");
    element.querySelector(".crm-monitor-kicker").textContent = scope;
    element.querySelector(".crm-monitor-title").textContent = live ? "Live Status" : "History & Incidents";
    const connectionDot = element.querySelector(".crm-monitor-connection .crm-monitor-dot");
    connectionDot.hidden = !live;
    connectionDot.dataset.severity = connectionSeverity;
    element.querySelector("[data-monitor-connection-label]").textContent = live ? connection : `${incidents.length} incidents`;
    element.querySelector("[data-monitor-refresh]").hidden = !live;
    const stats = live
      ? [["Good", Number(totals.good) || 0], ["Degraded", Number(totals.degraded) || 0], ["Down", Number(totals.down) || 0], ["Offline", Number(totals.offline) || 0]]
      : [["Events", historyObject.children.length], ["Incidents", incidents.length], ["Agents", `${Number(totals.agentsOnline) || 0}/${Number(totals.agents) || 0}`], ["Updated", monitoringObject.data.loadedAt ? timeLabel(monitoringObject.data.loadedAt) : "—"]];
    stats.forEach(([label, value], index) => {
      const stat = element.querySelector(`[data-monitor-stat="${index}"]`);
      stat.querySelector("span").textContent = label;
      stat.querySelector("strong").textContent = String(value);
    });
    const list = element.querySelector(".crm-monitor-list");
    const scroll = list.scrollTop;
    mountTileChildren(list, object, {
      elementOptions:(recordObject) => ({
        tagName:"article",
        className:"crm-monitor-row",
        canonicalClass:false,
        preview:false,
        view:"monitoring-record",
        ariaLabel:recordObject.tile.label,
      }),
      update:updateMonitoringRow,
    });
    if (!object.children.length) {
      const empty = document.createElement("div");
      empty.className = "crm-monitor-empty";
      empty.textContent = error || (live
        ? `No retained checks match ${scope}.`
        : `No monitoring history matches ${scope}.`);
      list.appendChild(empty);
    }
    list.scrollTop = scroll;
    const foot = element.querySelector(".crm-monitor-foot");
    foot.firstElementChild.textContent = live
      ? `Original MQTT · ${snapshot?.status?.config?.mqttHost || "24.121.212.206"}`
      : (snapshot?.status?.restError ? "REST history unavailable · live MQTT remains active" : "Original status-monitor history");
    foot.firstElementChild.classList.toggle("crm-monitor-error", !live && !!snapshot?.status?.restError);
    foot.lastElementChild.textContent = live ? `${object.children.length} checks` : "Newest first";
  };
  const renderData = () => {
    monitoringObject.children.forEach((object) => {
      const element = panel(object.data.view);
      if (element) renderPanel(element, object);
    });
  };

  const syncMaterial = () => requestAnimationFrame(() => {
    if (!grid) return;
    material = ensureTileMaterialPlane(grid, {
      className:"crm-monitoring-material",
      tileSelector:':scope > [data-crm-tile-instance="viewport"]',
    });
    if (material) syncTileMaterialPlane(material);
  });
  const mountTiles = () => {
    if (!grid) return [];
    const tiles = mountTileChildren(grid, monitoringObject, {
      elementOptions:(object) => ({
        tagName:"section",
        className:"crm-monitoring-tile",
        preview:false,
        view:"viewport",
        ariaLabel:object.tile.label,
      }),
      update:(element, object) => {
        element.dataset.monitoringTile = object.tile.id;
        element.dataset.monitoringView = object.data.view;
        element.dataset.monitoringSelected = String(object.data.view === selectedView);
        renderPanel(element, object);
      },
    });
    syncMaterial();
    return tiles;
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
      `${Math.min(64, Math.max(2, 16 / 245 * Math.min(
        lastGeometry?.cellWidth || 1,
        lastGeometry?.cellHeight || 1,
      ) * 2)).toFixed(1)}px`,
    );
    syncMaterial();
    return lastGeometry;
  };

  const loadData = async ({ force = false } = {}) => {
    const source = bridge();
    const sequence = ++loadSequence;
    if (!source?.snapshot || !source?.history) {
      monitoringObject.data.error = "The original MQTT monitoring bridge is unavailable.";
      renderData();
      return null;
    }
    const client = scopeClient();
    if (force) {
      try { await source.refresh?.({ client }); } catch {}
    }
    const [nextSnapshot, nextHistory] = await Promise.all([
      source.snapshot({ client }),
      source.history({ client, limit:160 }),
    ]);
    if (sequence !== loadSequence) return null;
    const liveRecords = Array.isArray(nextSnapshot?.checks) ? nextSnapshot.checks : [];
    const historyRecords = Array.isArray(nextHistory?.results) ? nextHistory.results : [];
    if (nextSnapshot?.ok === false && !Array.isArray(nextSnapshot?.checks)) {
      monitoringObject.data.error = nextSnapshot.error || "Monitoring is unavailable.";
    } else {
      monitoringObject.data.snapshot = nextSnapshot;
      monitoringObject.data.error = nextHistory?.ok === false ? nextHistory.error || "" : "";
      monitoringObject.data.loadedAt = Date.now();
    }
    reconcileMonitoringRecords(liveObject, liveRecords);
    reconcileMonitoringRecords(historyObject, historyRecords);
    liveObject.data.totals = nextSnapshot?.totals || {};
    liveObject.data.status = nextSnapshot?.status || {};
    historyObject.data.incidents = historyObject.children.filter((object) => (
      ["red", "yellow", "offline"].includes(object.data.record?.severity)
    )).length;
    monitoringObject.revision += 1;
    notifyTreeChanged("monitoring-records-reconciled");
    renderData();
    return monitoringObject.data.snapshot;
  };
  const scheduleLoad = () => {
    cancelAnimationFrame(refreshFrame);
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = 0;
      if (active) void loadData();
    });
  };
  const syncRefreshTimer = () => {
    clearInterval(refreshTimer);
    refreshTimer = active ? setInterval(scheduleLoad, REFRESH_MS) : 0;
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
    unsubscribe = bridge()?.onChanged?.(scheduleLoad) || null;
    return root;
  };

  const setActive = (on) => {
    active = !!on;
    mount();
    root.hidden = !active;
    syncRefreshTimer();
    if (active) {
      mountTiles();
      layout();
      void loadData();
      requestAnimationFrame(layout);
    }
    return api;
  };
  const setView = (view) => {
    selectedView = view === "history" ? "history" : "live";
    mount();
    mountTiles();
    const target = panel(selectedView);
    target?.focus?.({ preventScroll:true });
    return selectedView;
  };
  const baseline = async ({ canRender } = {}) => {
    mount();
    await loadData();
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
      const signature = [...(grid?.querySelectorAll?.(':scope > [data-crm-tile-instance="viewport"]') || [])].map((tile) => {
        const rect = tile.getBoundingClientRect();
        return [tile.dataset.tileObjectId, rect.x.toFixed(2), rect.y.toFixed(2), rect.width.toFixed(2), rect.height.toFixed(2)].join(":");
      }).join("|");
      stable = signature && signature === previous ? stable + 1 : 0;
      previous = signature;
      if (stable >= 3) return { stable:true, signature };
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return { stable:false, signature:previous };
  };
  const homePreviewState = () => ({
    revision:monitoringObject.revision,
    view:selectedView,
    totals:monitoringObject.data.snapshot?.totals || null,
    scope:scopeClient()?.code || "",
  });
  const applyHomePreviewState = async (state = {}) => {
    selectedView = state.view === "history" ? "history" : "live";
    await baseline();
    return homePreviewState();
  };
  const identityState = () => {
    const objects = [...monitoringIndex.objectsById.values()];
    const homeRoot = window.crmHome?._objectGraph?.();
    const mounted = [...document.querySelectorAll('.crm-monitoring-surface [data-tile-object-id]')];
    const exactMounted = mounted.filter((element) => {
      const object = tileObjectForElement(element);
      return object && monitoringIndex.objectForId(element.dataset.tileObjectId) === object;
    });
    return {
      rootId:monitoringObject.tile.id,
      homeSharesRoot:!!homeRoot?.children?.includes(monitoringObject),
      objects:objects.length,
      liveRecords:liveObject.children.length,
      historyRecords:historyObject.children.length,
      mounted:mounted.length,
      exactMounted:exactMounted.length,
      syntheticMounted:mounted.length - exactMounted.length,
    };
  };

  document.addEventListener("click", (event) => {
    if (!active || !event.target?.closest?.("[data-monitor-refresh]")) return;
    void loadData({ force:true });
  });
  document.addEventListener("crm:client-context-changed", () => {
    if (active) void loadData();
  });
  window.addEventListener("resize", layout);
  window.addEventListener("beforeunload", () => {
    clearInterval(refreshTimer);
    unsubscribe?.();
  }, { once:true });

  const api = {
    setActive,
    setView,
    isActive:() => active,
    baseline,
    waitForGeometrySettled,
    homePreviewState,
    applyHomePreviewState,
    refresh:() => loadData({ force:true }),
    performanceState:() => ({
      ready:!!monitoringObject.data.snapshot,
      checks:monitoringObject.data.snapshot?.totals?.total || 0,
      loadedAt:monitoringObject.data.loadedAt,
      error:monitoringObject.data.error,
    }),
    level:() => 0,
    geometry:() => ({ ...(lastGeometry || {}) }),
    tiles:() => monitoringObject.children,
    snapshot:() => monitoringObject.data.snapshot,
    history:() => historyObject.children.map((object) => object.data.record),
    _objectGraph:() => monitoringObject,
    _objectIndex:() => monitoringIndex,
    _objectForElement:tileObjectForElement,
    _identityState:identityState,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once:true });
  } else mount();
  window.crmMonitoring = api;
})();
