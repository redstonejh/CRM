import {
  bindTileObject,
  createTileObject,
  createTileObjectElement,
  ensureTileMaterialPlane,
  indexTileTree,
  mountTileChildren,
  syncTileMaterialPlane,
  tileObjectForElement,
} from "./modules/tile-system.js";
import {
  CDMS_DATASETS,
  CDMS_REPORTS,
  CDMS_ROOMS,
  datasetByKey,
  datasetsForRoom,
  payloadRows,
  recordSubtitle,
  recordTitle,
  rowIdentifier,
} from "./cdms-datasets.js";

// Client-centred CDMS world. CDMS data is projected into canonical viewport
// objects; the unchanged CDMS API remains the source of truth.
(() => {
  if (typeof window.createFractalCamera !== "function") return;

  const MORPH_MS = 460;
  const PAGE_SIZE = 25;
  const WORK_ROOMS = [
    ["cases", "Tickets"], ["planner", "Projects"], ["assignments", "Assignments"],
    ["calendar", "Calendar"], ["pipeline", "Pipeline"], ["jobs", "Jobs"],
  ];
  const REPORT_DATASETS = ["users", "emails", "vms", "daemons", "core", "services", "externalInfo", "workstations"];
  const clone = (value) => value == null ? value
    : (typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)));
  const text = (value) => String(value ?? "").trim();
  const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (character) => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;",
  }[character]));
  const cssValue = (value) => window.CSS?.escape
    ? CSS.escape(String(value ?? ""))
    : String(value ?? "").replace(/["\\\]]/g, "\\$&");
  const slug = (value) => text(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const stableHash = (value) => {
    let hash = 2166136261;
    for (const character of String(value || "")) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  };
  const valueText = (value) => {
    if (value == null) return "";
    if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join(", ");
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  };
  const businessKeys = (record = {}) => Object.keys(record)
    .filter((key) => !key.startsWith("_") && key !== "Actions")
    .filter((key) => record[key] == null || typeof record[key] !== "object");
  const secretFields = (record = {}) => Array.isArray(record._secretFields) ? record._secretFields : [];
  const clientCode = (client) => text(
    client?.value || client?.code || client?.companyCode || client?.cdmsClient
      || client?.sourceId || client?.Abbrv,
  );
  const clientLabel = (client) => {
    const code = clientCode(client);
    const label = text(client?.name || client?.label || client?.title || client?.["Company Name"] || code || "Client");
    if (!code) return label;
    return label.replace(new RegExp(`\\s*\\(${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)\\s*$`, "i"), "").trim() || label;
  };
  const statusLabel = (status) => ({ 0:"Good", 1:"Billing issue", 2:"Contact office" }[Number(status)] || "");

  let active = false;
  let camera = null;
  let rootObject = createTileObject({
    tile:{ id:"cdms-clients-root", key:"clients", title:"Clients", label:"Clients", kind:"cdms-clients-root" },
    data:{ domain:"cdms", unit:"clients" },
    children:[],
  });
  let objectIndex = indexTileTree(rootObject);
  let clients = [];
  let loadPromise = null;
  let loadedAt = 0;
  let detailShell = null;
  let detailState = null;
  let selectedObject = null;
  let rootQuery = "";
  const roomStateByHost = new WeakMap();
  const roomLoads = new WeakMap();
  const dataCache = new Map();
  const clientCounts = new Map();
  let clientMenu = null;

  const roomChildren = (client, room) => {
    const code = clientCode(client);
    if (room.key === "work") {
      return WORK_ROOMS.map(([key, label], rank) => createTileObject({
        tile:{
          id:`cdms-${stableHash(code)}-work-${key}`, key, title:label, label,
          kind:"cdms-work-room", rank, target:{ type:"workspace", id:key },
        },
        data:{ domain:"cdms", unit:"work-room", clientCode:code, workspace:key },
      }));
    }
    if (room.key === "monitoring") {
      return [["live", "Live Status"], ["history", "History & Incidents"]].map(([key, label], rank) => createTileObject({
        tile:{
          id:`cdms-${stableHash(code)}-monitor-${key}`, key, title:label, label,
          kind:"cdms-monitor-view", rank, target:{ type:"monitoring-view", id:key },
        },
        data:{ domain:"cdms", unit:"monitor-view", clientCode:code, monitorView:key },
      }));
    }
    if (room.key === "reports") {
      return CDMS_REPORTS.map((report, rank) => createTileObject({
        tile:{
          id:`cdms-${stableHash(code)}-report-${report.key}`, key:report.key,
          title:report.label, label:report.label, kind:"cdms-report", rank,
          target:{ type:"cdms-report", id:report.key },
        },
        data:{ domain:"cdms", unit:"report", clientCode:code, reportKey:report.key },
      }));
    }
    return [];
  };

  const createClientObject = (client, rank) => {
    const code = clientCode(client);
    const rooms = CDMS_ROOMS.map((room, roomRank) => createTileObject({
      tile:{
        id:`cdms-${stableHash(code)}-room-${room.key}`, key:room.key,
        title:room.label, label:room.label, kind:"cdms-client-room", rank:roomRank,
        target:{ type:"cdms-client-room", id:room.key },
      },
      data:{ domain:"cdms", unit:"room", room:room.key, clientCode:code, client:clone(client) },
      children:roomChildren(client, room),
    }));
    return createTileObject({
      tile:{
        id:`cdms-client-${stableHash(code)}`, key:code, title:clientLabel(client),
        label:clientLabel(client), kind:"cdms-client", rank,
        target:{ type:"cdms-client", id:code },
      },
      data:{ domain:"cdms", unit:"client", clientCode:code, client:clone(client) },
      children:rooms,
    });
  };

  const rebuildObjectTree = (records) => {
    rootObject = createTileObject({
      tile:rootObject.tile,
      data:rootObject.data,
      revision:rootObject.revision + 1,
      children:records.map(createClientObject),
    });
    objectIndex = indexTileTree(rootObject);
  };

  const loadClients = async ({ force = false } = {}) => {
    if (!force && loadPromise) return loadPromise;
    if (!force && loadedAt && Date.now() - loadedAt < 5 * 60 * 1000) return clients;
    loadPromise = (async () => {
      const [result, catalog] = await Promise.all([
        window.crmCdms?.dataset?.("clients", { force }),
        window.crmCdms?.catalog?.().catch?.(() => ({ companies:[] })) || { companies:[] },
      ]);
      if (result?.ok === false) throw new Error(result.error || "CDMS clients could not be loaded");
      const records = Array.isArray(result?.payload?.clients) ? result.payload.clients : [];
      const companies = Array.isArray(catalog?.companies) ? catalog.companies : [];
      clientCounts.clear();
      companies.forEach((company) => clientCounts.set(
        clientCode(company).toLowerCase(),
        { people:Number(company.contactCount) || 0, assets:Number(company.assetCount) || 0 },
      ));
      clients = records.filter((record) => clientCode(record)).sort((a, b) => clientLabel(a).localeCompare(clientLabel(b)));
      rebuildObjectTree(clients);
      loadedAt = Date.now();
      if (camera?.level?.() === 0) camera.rebuildRoot?.();
      return clients;
    })().finally(() => { loadPromise = null; });
    return loadPromise;
  };

  const objectForElement = (element) => tileObjectForElement(element)
    || objectIndex?.objectForId(element?.dataset?.tileObjectId || element?.dataset?.tileId || "");
  const clientObjectFor = (object) => {
    let current = object;
    while (current && current !== rootObject) {
      if (current.data?.unit === "client") return current;
      current = objectIndex?.parentOf(current);
    }
    return null;
  };
  const selectedClient = () => clone(clientObjectFor(selectedObject)?.data?.client || window.crmClientContext?.current?.());

  const tilePreviewHTML = (object) => {
    const data = object.data || {};
    if (data.unit === "client") {
      const client = data.client || {};
      const code = data.clientCode;
      const counts = clientCounts.get(code.toLowerCase()) || {};
      return `<span class="crm-client-tile-content">
        <span class="crm-client-tile-kicker">${esc(code)}</span>
        <span class="crm-client-tile-title">${esc(clientLabel(client))}</span>
        <span class="crm-client-tile-meta">${esc([
          text(client.group), counts.people ? `${counts.people} people` : "",
          counts.assets ? `${counts.assets} devices` : "", statusLabel(client.status),
        ].filter(Boolean).join(" · ") || "CDMS client")}</span>
      </span>`;
    }
    return `<span class="crm-client-tile-content"><span class="crm-client-tile-title">${esc(object.tile.label)}</span></span>`;
  };

  const syncMaterial = (grid) => requestAnimationFrame(() => {
    const plane = ensureTileMaterialPlane(grid, {
      className:"crm-clients-material",
      tileSelector:':scope > [data-crm-tile-instance="viewport"]',
    });
    if (plane) {
      plane.style.width = `${Math.max(grid.clientWidth, grid.scrollWidth)}px`;
      plane.style.height = `${Math.max(grid.clientHeight, grid.scrollHeight)}px`;
      syncTileMaterialPlane(plane);
    }
  });

  const mountObjectGrid = (grid, parent, options = {}) => {
    const elements = mountTileChildren(grid, parent, {
      elementOptions:(object) => ({
        tagName:"button",
        className:`crm-client-tile ${options.className || ""}`,
        preview:false,
        view:options.view || "viewport",
        ariaLabel:`Open ${object.tile.label}`,
      }),
      update:(element, object) => {
        element.dataset.cdmsUnit = object.data?.unit || "";
        element.dataset.cdmsClient = object.data?.clientCode || "";
        if (object.data?.room) element.dataset.cdmsRoom = object.data.room;
        if (object.data?.workspace) element.dataset.crmWorkspaceTarget = object.data.workspace;
        if (object.data?.monitorView) element.dataset.crmMonitorView = object.data.monitorView;
        element.hidden = options.filter ? !options.filter(object) : false;
        element.innerHTML = tilePreviewHTML(object);
      },
    });
    syncMaterial(grid);
    return elements;
  };

  const rootMarkup = (layer) => {
    layer.className = "crm-clients-level crm-clients-root";
    layer.innerHTML = `<header class="crm-clients-toolbar crm-menu-surface">
      <div><span class="crm-clients-kicker">CDMS</span><h1>Clients</h1></div>
      <label class="crm-client-search"><span class="sr-only">Search clients</span><input class="crm-menu-input" data-client-search value="${esc(rootQuery)}" placeholder="Search clients"></label>
      <button type="button" class="crm-menu-action" data-client-add>Add client</button>
      <button type="button" class="crm-menu-action" data-client-refresh>Refresh</button>
    </header><div class="crm-client-scroll"><section class="crm-client-grid" aria-label="CDMS clients"></section></div>
    <div class="crm-client-root-state" data-client-state ${clients.length ? "hidden" : ""}>${clients.length ? "" : "Loading clients…"}</div>`;
    const grid = layer.querySelector(".crm-client-grid");
    mountObjectGrid(grid, rootObject, {
      className:"crm-client-company-tile",
      filter:(object) => {
        const query = rootQuery.toLowerCase();
        return !query || [object.tile.label, object.data?.clientCode, object.data?.client?.group]
          .some((value) => String(value || "").toLowerCase().includes(query));
      },
    });
    return layer;
  };
  const filterClientTiles = (layer) => {
    const query = rootQuery.toLowerCase();
    layer?.querySelectorAll?.(".crm-client-company-tile").forEach((tile) => {
      const object = objectForElement(tile);
      tile.hidden = !!query && ![
        object?.tile?.label,
        object?.data?.clientCode,
        object?.data?.client?.group,
      ].some((value) => String(value || "").toLowerCase().includes(query));
    });
    syncMaterial(layer?.querySelector?.(".crm-client-grid"));
  };

  const buildRoot = () => {
    const layer = document.createElement("section");
    rootMarkup(layer);
    if (!clients.length) {
      void loadClients().then(() => {
        if (camera?.level?.() === 0) camera.rebuildRoot?.();
      }).catch((error) => {
        const state = camera?.layers?.()[0]?.querySelector?.("[data-client-state]");
        if (state) { state.hidden = false; state.textContent = error.message; }
      });
    }
    return layer;
  };

  const renderClientWorld = (host, object) => {
    const client = object.data?.client || {};
    const code = object.data?.clientCode || "";
    host.innerHTML = `<header class="crm-client-world-head">
      <div><span class="crm-clients-kicker">${esc(code)}</span><h1>${esc(clientLabel(client))}</h1>
      <div class="crm-client-world-meta">${esc([text(client.group), statusLabel(client.status)].filter(Boolean).join(" · "))}</div></div>
      <div class="crm-client-world-actions">
        <button type="button" class="crm-menu-action" data-client-edit="${esc(code)}">Edit client</button>
        <button type="button" class="crm-menu-action" data-client-refresh-room>Refresh</button>
      </div>
    </header><section class="crm-client-room-grid" aria-label="${esc(clientLabel(client))} rooms"></section>`;
    const grid = host.querySelector(".crm-client-room-grid");
    mountObjectGrid(grid, object, { className:"crm-client-room-tile", view:"client-room" });
    window.crmClientContext?.select?.({
      id:`cdms-company-${stableHash(code.toLowerCase())}`,
      code,
      label:clientLabel(client),
      group:text(client.group),
    }, { reason:"client-world" });
  };

  const datasetCacheKey = (definition, code) => `${code}|${definition.endpoint}`;
  const loadDataset = async (definition, code, { force = false } = {}) => {
    const key = datasetCacheKey(definition, code);
    if (!force && dataCache.has(key)) return dataCache.get(key);
    const promise = window.crmCdms.dataset(definition.endpoint, { client:code, force })
      .then((result) => {
        if (result?.ok === false) throw new Error(result.error || `${definition.label} could not be loaded`);
        return result;
      });
    dataCache.set(key, promise);
    try { return await promise; }
    catch (error) { dataCache.delete(key); throw error; }
  };

  const exportCsv = (definition, rows, code) => {
    const columns = [...new Set(rows.flatMap((row) => businessKeys(row)))];
    if (!columns.length) return false;
    const quote = (value) => `"${valueText(value).replace(/"/g, '""')}"`;
    const csv = [columns.map(quote).join(","), ...rows.map((row) => columns.map((column) => quote(row[column])).join(","))].join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type:"text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${slug(code)}-${slug(definition.label)}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  };

  const renderRecordCard = (definition, record, index) => {
    const subtitle = recordSubtitle(definition, record);
    const facts = businessKeys(record)
      .filter((field) => !definition.titleFields?.includes(field) && !definition.subtitleFields?.includes(field))
      .map((field) => [field, valueText(record[field])]).filter(([, value]) => value).slice(0, 3);
    return `<button type="button" class="crm-client-record-card ticket-widget-card" data-cdms-record="${index}" data-cdms-dataset="${esc(definition.key)}">
      <span class="crm-client-record-title">${esc(recordTitle(definition, record))}</span>
      ${subtitle ? `<span class="crm-client-record-subtitle">${esc(subtitle)}</span>` : ""}
      <span class="crm-client-record-facts">${facts.map(([field, value]) => `<span><b>${esc(field)}</b>${esc(value)}</span>`).join("")}</span>
      ${secretFields(record).length ? '<span class="crm-client-secret-chip">Credentials</span>' : ""}
    </button>`;
  };

  const filteredRows = (definition, rows, state) => {
    const query = state.query.toLowerCase();
    const filtered = !query ? rows : rows.filter((record) => (
      businessKeys(record).some((field) => valueText(record[field]).toLowerCase().includes(query))
    ));
    const direction = state.sorts.get(definition.key) || "none";
    if (direction === "none") return filtered.slice();
    return filtered.slice().sort((a, b) => {
      const left = recordTitle(definition, a);
      const right = recordTitle(definition, b);
      return direction === "desc" ? right.localeCompare(left, undefined, { numeric:true }) : left.localeCompare(right, undefined, { numeric:true });
    });
  };

  const renderDatasetBucket = (bucket, definition, state) => {
    const entry = state.datasets.get(definition.key) || { rows:[], error:null };
    const rows = filteredRows(definition, entry.rows, state);
    const pageSize = state.pageSizes.get(definition.key) || PAGE_SIZE;
    const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
    const page = Math.max(0, Math.min(pageCount - 1, state.pages.get(definition.key) || 0));
    state.pages.set(definition.key, page);
    const visible = rows.slice(page * pageSize, page * pageSize + pageSize);
    state.visibleRows.set(definition.key, visible);
    const sort = state.sorts.get(definition.key) || "none";
    bucket.innerHTML = `<header class="crm-client-bucket-head">
      <div><span class="crm-client-bucket-title">${esc(definition.label)}</span><span class="crm-client-bucket-count">${rows.length.toLocaleString()}</span></div>
      <div class="crm-client-bucket-actions">
        <button type="button" class="crm-menu-action" data-dataset-sort="${esc(definition.key)}" aria-label="Sort ${esc(definition.label)}">${sort === "desc" ? "Z–A" : sort === "asc" ? "A–Z" : "Source"}</button>
        <select class="crm-menu-input crm-client-page-size" data-page-size="${esc(definition.key)}" aria-label="Rows per page">${[25, 50, 100, 200].map((size) => `<option value="${size}" ${size === pageSize ? "selected" : ""}>${size}</option>`).join("")}</select>
        ${definition.exportable ? `<button type="button" class="crm-menu-action" data-dataset-export="${esc(definition.key)}">CSV</button>` : ""}
        ${definition.addable ? `<button type="button" class="crm-menu-action" data-dataset-add="${esc(definition.key)}">Add</button>` : ""}
      </div>
    </header><div class="crm-client-card-list">
      ${entry.error ? `<div class="crm-client-empty">${esc(entry.error)}</div>`
        : visible.length ? visible.map((record, index) => renderRecordCard(definition, record, index)).join("")
          : `<div class="crm-client-empty">No ${esc(definition.label.toLowerCase())}</div>`}
    </div>${pageCount > 1 ? `<footer class="crm-client-page">
      <button type="button" class="crm-menu-action" data-page-step="-1" data-page-dataset="${esc(definition.key)}" ${page === 0 ? "disabled" : ""}>Previous</button>
      <span>${page + 1} / ${pageCount}</span>
      <button type="button" class="crm-menu-action" data-page-step="1" data-page-dataset="${esc(definition.key)}" ${page + 1 >= pageCount ? "disabled" : ""}>Next</button>
    </footer>` : ""}`;
  };

  const renderAllBuckets = (state) => {
    state.host.querySelectorAll("[data-dataset-bucket]").forEach((bucket) => {
      const definition = datasetByKey(bucket.dataset.datasetBucket);
      if (definition) renderDatasetBucket(bucket, definition, state);
    });
    window.crmObjectSizing?.scan?.(state.host);
  };

  const loadStandardRoom = async (host, object, { force = false } = {}) => {
    const room = object.data?.room;
    const code = object.data?.clientCode;
    const definitions = datasetsForRoom(room);
    const state = roomStateByHost.get(host) || {
      host, object, room, code, query:"", sorts:new Map(), pages:new Map(),
      pageSizes:new Map(), datasets:new Map(), visibleRows:new Map(),
    };
    state.object = object; state.room = room; state.code = code;
    roomStateByHost.set(host, state);
    host.innerHTML = `<header class="crm-client-room-head"><div><span class="crm-clients-kicker">${esc(code)}</span><h1>${esc(object.tile.label)}</h1></div>
      <label class="crm-client-search"><span class="sr-only">Search ${esc(object.tile.label)}</span><input class="crm-menu-input" data-room-search value="${esc(state.query)}" placeholder="Search all fields"></label>
      <button type="button" class="crm-menu-action" data-client-refresh-room>Refresh</button>
    </header><div class="crm-client-dataset-strip">${definitions.map((definition) => `<section class="crm-client-dataset-bucket crm-menu-surface" data-dataset-bucket="${esc(definition.key)}"><div class="crm-client-empty">Loading ${esc(definition.label)}…</div></section>`).join("")}</div>`;
    const unique = new Map();
    definitions.forEach((definition) => {
      if (!unique.has(definition.endpoint)) unique.set(definition.endpoint, loadDataset(definition, code, { force }));
    });
    const results = await Promise.allSettled([...unique.entries()].map(async ([endpoint, promise]) => [endpoint, await promise]));
    const byEndpoint = new Map();
    results.forEach((result) => {
      if (result.status === "fulfilled") byEndpoint.set(result.value[0], { result:result.value[1] });
      else {
        const endpoint = [...unique.keys()][results.indexOf(result)];
        byEndpoint.set(endpoint, { error:result.reason?.message || "Could not load" });
      }
    });
    definitions.forEach((definition) => {
      const endpoint = byEndpoint.get(definition.endpoint);
      state.datasets.set(definition.key, endpoint?.error
        ? { rows:[], error:endpoint.error }
        : { rows:payloadRows(endpoint?.result, definition), error:null });
    });
    renderAllBuckets(state);
    return state;
  };

  const overviewStat = (label, value, note = "") => `<article class="crm-client-overview-card crm-menu-surface"><span>${esc(label)}</span><strong>${esc(value)}</strong>${note ? `<small>${esc(note)}</small>` : ""}</article>`;
  const loadOverview = async (host, object, { force = false } = {}) => {
    const code = object.data?.clientCode;
    const client = object.data?.client || {};
    host.innerHTML = `<header class="crm-client-room-head"><div><span class="crm-clients-kicker">${esc(code)}</span><h1>Overview</h1></div><button type="button" class="crm-menu-action" data-client-refresh-room>Refresh</button></header><div class="crm-client-overview-grid"><div class="crm-client-empty">Loading client overview…</div></div>`;
    const definitions = ["core", "workstationsUsers", "externalInfo", "managedInfo", "domains", "phoneNumbers", "guacamole", "adminEmails"].map(datasetByKey);
    const settled = await Promise.allSettled(definitions.map((definition) => loadDataset(definition, code, { force })));
    const counts = {};
    const rows = {};
    definitions.forEach((definition, index) => {
      const result = settled[index];
      rows[definition.key] = result.status === "fulfilled" ? payloadRows(result.value, definition) : [];
      counts[definition.key] = rows[definition.key].length;
    });
    const domain = valueText(rows.domains?.[0]?.["Domain Name"]);
    const phone = valueText(rows.phoneNumbers?.[0]?.Number);
    const guac = valueText(rows.guacamole?.[0]?.["Cloud Name"]);
    const grid = host.querySelector(".crm-client-overview-grid");
    grid.innerHTML = [
      overviewStat("Core", counts.core || 0, "servers, routers, switches"),
      overviewStat("Workstations & users", counts.workstationsUsers || 0),
      overviewStat("External", counts.externalInfo || 0, "firewalls and VPN"),
      overviewStat("Contacts", counts.managedInfo || 0),
      overviewStat("Admin credentials", counts.adminEmails || 0),
      overviewStat("Status", statusLabel(client.status) || "Good", text(client.group)),
    ].join("") + `<section class="crm-client-overview-links crm-menu-surface">
      ${domain ? `<button type="button" class="crm-menu-action" data-open-url="${esc(/^https?:/i.test(domain) ? domain : `https://${domain}`)}">Domain · ${esc(domain)}</button>` : ""}
      ${phone ? `<button type="button" class="crm-menu-action" data-open-url="tel:${esc(phone)}">Call · ${esc(phone)}</button>` : ""}
      ${guac ? `<button type="button" class="crm-menu-action" data-open-url="${esc(guac)}">Open Guacamole</button>` : ""}
      <button type="button" class="crm-menu-action" data-open-url="http://192.168.203.241:6029/attendance">Open Attend</button>
    </section>`;
  };

  const dateFromExcel = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) return new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? new Date(parsed) : null;
  };
  const loadReports = async (host, object, { force = false } = {}) => {
    const code = object.data?.clientCode;
    host.innerHTML = `<header class="crm-client-room-head"><div><span class="crm-clients-kicker">${esc(code)}</span><h1>Reports</h1></div><button type="button" class="crm-menu-action" data-client-refresh-room>Refresh</button></header><section class="crm-client-report-grid"><div class="crm-client-empty">Evaluating reports…</div></section>`;
    const definitions = REPORT_DATASETS.map(datasetByKey);
    const settled = await Promise.allSettled(definitions.map((definition) => loadDataset(definition, code, { force })));
    const rows = Object.fromEntries(definitions.map((definition, index) => [
      definition.key,
      settled[index].status === "fulfilled" ? payloadRows(settled[index].value, definition) : [],
    ]));
    const inactive = [
      ...rows.users.filter((row) => String(row.Active) === "0").map((row) => ({ definition:datasetByKey("users"), row, reason:"Active = 0" })),
      ...rows.emails.filter((row) => String(row.Active) === "0").map((row) => ({ definition:datasetByKey("emails"), row, reason:"Active = 0" })),
      ...rows.vms.filter((row) => String(row.Active) === "0").map((row) => ({ definition:datasetByKey("vms"), row, reason:"Active = 0" })),
      ...rows.daemons.filter((row) => String(row.Inactive) === "1").map((row) => ({ definition:datasetByKey("daemons"), row, reason:"Inactive = 1" })),
    ];
    const missing = [
      ...rows.core.filter((row) => !text(row["IP address"])).map((row) => ({ definition:datasetByKey("core"), row, reason:"Missing IP address" })),
      ...rows.core.filter((row) => !secretFields(row).some((field) => /password/i.test(field))).map((row) => ({ definition:datasetByKey("core"), row, reason:"Missing password" })),
      ...rows.vms.filter((row) => String(row.Active ?? "1") !== "0" && !text(row.IP)).map((row) => ({ definition:datasetByKey("vms"), row, reason:"Missing IP" })),
      ...rows.services.filter((row) => !secretFields(row).some((field) => /password|pass|pw/i.test(field))).map((row) => ({ definition:datasetByKey("services"), row, reason:"Missing password" })),
    ];
    const activeEmails = rows.emails.filter((row) => String(row.Active ?? "1") !== "0");
    const mfa = activeEmails.filter((row) => String(row["MFA or Ignore"] ?? "").toLowerCase() === "1" || row["MFA or Ignore"] === true);
    const mfaDisabled = activeEmails.filter((row) => !mfa.includes(row));
    const firmwarePresent = rows.externalInfo.filter((row) => text(row["Current Version"]));
    const firmwareMissing = rows.externalInfo.filter((row) => !text(row["Current Version"]));
    const allocations = new Map();
    rows.vms.filter((row) => String(row.Active ?? "1") !== "0").forEach((row) => {
      const hostName = text(row.Host) || "Unassigned";
      const current = allocations.get(hostName) || { cores:0, ram:0 };
      current.cores += Number(row["Assigned cores"]) || 0;
      current.ram += Number(row["Startup memory (GB)"]) || 0;
      allocations.set(hostName, current);
    });
    const now = Date.now();
    const passwordAge = rows.services.map((row) => {
      const date = dateFromExcel(row["Date of last known change"]);
      const days = date ? Math.max(0, Math.floor((now - date.getTime()) / 86400000)) : null;
      return { row, days, group:days == null ? "Unknown" : days > 90 ? "Over 90 days" : days >= 60 ? "60–90 days" : "Under 60 days" };
    });
    const w11Ready = rows.workstations.filter((row) => String(row["Win11 Capable"]) === "1");
    const w11NotReady = rows.workstations.filter((row) => String(row["Win11 Capable"]) !== "1");
    const vmIssues = rows.vms.filter((row) => {
      const value = text(row["Windows 11 Issue?"]);
      return value && !["0", "no"].includes(value.toLowerCase());
    });
    const health = await window.crmCdms.health?.();
    const titleItem = (definition, row, detail) => ({
      label:recordTitle(definition, row),
      detail,
    });
    const reportData = new Map([
      ["inactive", {
        value:inactive.length,
        note:inactive.length ? "Inactive records returned by the API" : "The source API normally filters archived rows",
        items:inactive.map(({ definition, row, reason }) => titleItem(definition, row, `${definition.label} · ${reason}`)),
      }],
      ["missing", {
        value:missing.length,
        note:"Core IP/password · VM IP · service password",
        items:missing.map(({ definition, row, reason }) => titleItem(definition, row, `${definition.label} · ${reason}`)),
      }],
      ["mfa", {
        value:`${mfa.length}/${activeEmails.length}`,
        note:activeEmails.length ? `${Math.round(mfa.length / activeEmails.length * 100)}% enabled or excepted` : "No active email accounts",
        items:[
          ...mfa.map((row) => titleItem(datasetByKey("emails"), row, "Enabled or excepted")),
          ...mfaDisabled.map((row) => titleItem(datasetByKey("emails"), row, "Not enabled / not excepted")),
        ],
      }],
      ["firmware", {
        value:`${firmwarePresent.length}/${rows.externalInfo.length}`,
        note:`${firmwareMissing.length} missing a current version`,
        items:[
          ...firmwareMissing.map((row) => titleItem(datasetByKey("externalInfo"), row, "Current Version missing")),
          ...firmwarePresent.map((row) => titleItem(datasetByKey("externalInfo"), row, `Version ${text(row["Current Version"])}`)),
        ],
      }],
      ["resources", {
        value:allocations.size,
        note:"Active VM allocation compared with matching Core capacity",
        items:[...allocations.entries()].map(([hostName, allocation]) => {
          const core = rows.core.find((row) => [row.Name, row.Host, row["IP address"]]
            .some((value) => text(value).toLowerCase() === hostName.toLowerCase()));
          const cores = Number(core?.Cores) || 0;
          const ram = Number(core?.RAM) || 0;
          return {
            label:hostName,
            detail:`${allocation.cores}/${cores || "?"} cores · ${allocation.ram}/${ram || "?"} GB`,
          };
        }),
      }],
      ["password-age", {
        value:passwordAge.filter((item) => item.group === "Over 90 days").length,
        note:`${passwordAge.filter((item) => item.group === "60–90 days").length} at 60–90 days · ${passwordAge.filter((item) => item.group === "Unknown").length} unknown`,
        items:passwordAge
          .sort((left, right) => (right.days ?? -1) - (left.days ?? -1))
          .map(({ row, days, group }) => titleItem(datasetByKey("services"), row, days == null ? group : `${group} · ${days} days`)),
      }],
      ["windows-11", {
        value:`${w11Ready.length}/${rows.workstations.length}`,
        note:`${w11NotReady.length} not capable · ${vmIssues.length} VM issues`,
        items:[
          ...w11NotReady.map((row) => titleItem(datasetByKey("workstations"), row, "Not Windows 11 capable")),
          ...vmIssues.map((row) => titleItem(datasetByKey("vms"), row, `VM issue · ${text(row["Windows 11 Issue?"])}`)),
          ...w11Ready.map((row) => titleItem(datasetByKey("workstations"), row, "Windows 11 capable")),
        ],
      }],
      ["source-health", {
        value:health?.summary || (health?.ok ? "Live" : "Unavailable"),
        note:health?.error || `Evaluated ${new Date().toLocaleTimeString([], { hour:"numeric", minute:"2-digit" })}`,
        items:(Array.isArray(health?.sources) ? health.sources : []).map((source) => ({
          label:text(source.key) || "Source",
          detail:`${source.ok ? "OK" : "Unavailable"} · ${Number(source.rows) || 0} rows`,
        })),
      }],
    ]);
    const grid = host.querySelector(".crm-client-report-grid");
    const tiles = mountTileChildren(grid, object, {
      elementOptions:(report) => ({
        tagName:"article",
        className:"crm-client-report-card",
        preview:false,
        view:"report-result",
        ariaLabel:report.tile.label,
      }),
      update:(element, report) => {
        const result = reportData.get(report.data?.reportKey) || { value:"—", note:"No data", items:[] };
        const visible = result.items.slice(0, 40);
        element.dataset.reportKey = report.data?.reportKey || "";
        element.innerHTML = `<header><span>${esc(report.tile.label)}</span><strong>${esc(result.value)}</strong></header>
          <small>${esc(result.note)}</small>
          <div class="crm-client-report-list">${visible.length ? visible.map((item) => `<div><b>${esc(item.label)}</b><span>${esc(item.detail)}</span></div>`).join("")
            : '<div class="crm-client-empty">No data</div>'}</div>
          ${result.items.length > visible.length ? `<footer>${result.items.length - visible.length} more results</footer>` : ""}`;
      },
    });
    syncMaterial(grid);
    return tiles;
  };

  const renderWork = (host, object) => {
    host.innerHTML = `<header class="crm-client-room-head"><div><span class="crm-clients-kicker">${esc(object.data?.clientCode)}</span><h1>Work</h1></div></header><section class="crm-client-work-grid"></section>`;
    mountObjectGrid(host.querySelector(".crm-client-work-grid"), object, { className:"crm-client-work-tile", view:"work-room" });
  };
  const renderMonitoringLink = (host, object) => {
    host.innerHTML = `<header class="crm-client-room-head"><div><span class="crm-clients-kicker">${esc(object.data?.clientCode)}</span><h1>Monitoring</h1></div></header><section class="crm-client-work-grid"></section>`;
    mountObjectGrid(host.querySelector(".crm-client-work-grid"), object, { className:"crm-client-monitor-tile", view:"monitor-room" });
  };

  const loadRoom = async (host, object, { force = false } = {}) => {
    if (!host?.isConnected || !object) return null;
    if (!force && roomLoads.has(host)) return roomLoads.get(host);
    selectedObject = object;
    const pending = (async () => {
      if (object.data?.room === "overview") return loadOverview(host, object, { force });
      if (object.data?.room === "reports") return loadReports(host, object, { force });
      if (object.data?.room === "work") return renderWork(host, object);
      if (object.data?.room === "monitoring") return renderMonitoringLink(host, object);
      return loadStandardRoom(host, object, { force });
    })().catch((error) => {
      host.innerHTML = `<div class="crm-client-room-error crm-menu-surface"><strong>${esc(object.tile.label)}</strong><span>${esc(error.message)}</span><button type="button" class="crm-menu-action" data-client-refresh-room>Try again</button></div>`;
    });
    roomLoads.set(host, pending);
    return pending;
  };

  const renderExpander = (expander, object) => {
    if (!object) return;
    bindTileObject(expander, object, { canonicalClass:false, view:"expanded-shell" });
    expander.dataset.cdmsUnit = object.data?.unit || "";
    expander.replaceChildren();
    const frame = document.createElement("span");
    frame.className = "crm-client-transition-acrylic";
    frame.setAttribute("aria-hidden", "true");
    const live = document.createElement("div");
    live.className = "crm-client-expander-live";
    expander.append(frame, live);
    if (object.data?.unit === "client") renderClientWorld(live, object);
    else if (object.data?.unit === "room") queueMicrotask(() => loadRoom(live, object));
  };

  const buildExpander = (target) => {
    const object = objectForElement(target);
    const expander = createTileObjectElement(object, {
      tagName:"section",
      className:"crm-clients-expander",
      canonicalClass:false,
      view:"expanded-shell",
      ariaLabel:object?.tile?.label || "CDMS",
    });
    renderExpander(expander, object);
    return expander;
  };

  const configureExpander = (expander, target, context) => {
    const object = objectForElement(target);
    if (!object) return;
    if (tileObjectForElement(expander) !== object || !expander.querySelector(":scope > .crm-client-expander-live")) {
      renderExpander(expander, object);
    }
    acrylicLens.prepare(expander, target, context);
  };

  const fieldMarkup = (field, value, editable) => {
    const name = esc(field);
    const stringValue = valueText(value);
    return `<label class="crm-client-detail-field crm-menu-item"><span>${name}</span>
      ${editable ? `<input class="crm-menu-input" name="${name}" value="${esc(stringValue)}" data-original="${esc(stringValue)}">`
        : `<output>${esc(stringValue || "—")}</output>`}</label>`;
  };
  const closeDetail = () => {
    if (!detailShell) return;
    detailShell.hidden = true;
    detailShell.replaceChildren();
    detailState = null;
  };
  const revealSecret = async (button) => {
    if (!detailState?.record) return;
    const field = button.dataset.revealField;
    const row = button.closest(".crm-client-secret-row");
    let input = row.querySelector("input");
    if (input && button.dataset.secretVisible === "true") {
      input.type = "password";
      button.textContent = "Reveal";
      button.dataset.secretVisible = "false";
      return;
    }
    if (input) {
      input.type = "text";
      button.textContent = "Hide";
      button.dataset.secretVisible = "true";
      input.focus();
      return;
    }
    button.disabled = true;
    let result = null;
    try {
      result = await window.crmCdms.revealSecret({
        endpoint:detailState.definition.endpoint,
        client:detailState.code,
        path:detailState.record._cdmsPath,
        field,
      });
    } catch (error) {
      result = { ok:false, error:error?.message || "Unavailable" };
    }
    button.disabled = false;
    if (result?.ok === false) { button.textContent = result.error || "Unavailable"; return; }
    if (!input) {
      input = document.createElement("input");
      input.className = "crm-menu-input";
      input.name = field;
      input.type = "text";
      input.dataset.original = String(result.value ?? "");
      row.querySelector(".crm-client-secret-mask")?.replaceWith(input);
    }
    input.value = String(result.value ?? "");
    input.focus();
    button.textContent = "Hide";
    button.dataset.secretVisible = "true";
  };
  const copySecret = async (button) => {
    if (!detailState?.record) return;
    const field = button.dataset.copySecret;
    const result = await window.crmCdms.revealSecret({
      endpoint:detailState.definition.endpoint,
      client:detailState.code,
      path:detailState.record._cdmsPath,
      field,
    });
    if (result?.ok === false) { button.textContent = "Unavailable"; return; }
    await navigator.clipboard?.writeText?.(String(result.value ?? ""));
    button.textContent = "Copied";
    setTimeout(() => { if (button.isConnected) button.textContent = "Copy"; }, 1200);
  };

  const openRecordDetail = (definition, record, state, options = {}) => {
    detailState = { definition, record, roomState:state, code:state.code, adding:!!options.adding };
    const keys = options.adding
      ? [...new Set([
        definition.clientField,
        ...definition.titleFields,
        ...definition.subtitleFields,
        ...state.datasets.get(definition.key)?.rows.flatMap(businessKeys) || [],
      ])].filter(Boolean)
      : businessKeys(record);
    const secrets = options.adding
      ? [...new Set(state.datasets.get(definition.key)?.rows.flatMap(secretFields) || [])]
      : secretFields(record);
    const editable = definition.editable !== false;
    detailShell.hidden = false;
    detailShell.innerHTML = `<form class="crm-client-detail crm-menu-surface" data-cdms-detail-form>
      <header><div><span class="crm-clients-kicker">${esc(definition.label)}</span><h2>${esc(options.adding ? `Add ${definition.label}` : recordTitle(definition, record))}</h2></div><button type="button" class="crm-menu-action" data-detail-close>×</button></header>
      <div class="crm-client-detail-fields">${keys.map((field) => fieldMarkup(field, options.adding && field === definition.clientField ? state.code : record[field], editable)).join("")}
        ${secrets.map((field) => `<div class="crm-client-secret-row crm-menu-item"><span>${esc(field)}</span>
          ${options.adding ? `<input class="crm-menu-input" type="password" name="${esc(field)}" autocomplete="new-password">`
            : `<span class="crm-client-secret-mask">••••••••</span><button type="button" class="crm-menu-action" data-reveal-field="${esc(field)}">Reveal</button><button type="button" class="crm-menu-action" data-copy-secret="${esc(field)}">Copy</button>`}
        </div>`).join("")}
      </div><footer>
        ${!options.adding && editable && definition.archiveColumn ? '<button type="button" class="crm-menu-action crm-client-danger" data-detail-archive>Archive</button>' : ""}
        ${!options.adding && definition.key === "misc" ? '<button type="button" class="crm-menu-action crm-client-danger" data-detail-delete>Delete</button>' : ""}
        <span data-detail-status></span><button type="button" class="crm-menu-action" data-detail-close>Cancel</button>
        ${editable ? `<button type="submit" class="crm-menu-action">${options.adding ? "Add" : "Save"}</button>` : ""}
      </footer></form>`;
    detailShell.querySelector("input:not([type=password])")?.focus();
  };

  const refreshDetailRoom = async () => {
    const state = detailState?.roomState;
    if (!state?.host?.isConnected) return;
    for (const definition of datasetsForRoom(state.room)) dataCache.delete(datasetCacheKey(definition, state.code));
    closeDetail();
    await loadRoom(state.host, state.object, { force:true });
  };
  const saveDetail = async (form) => {
    const current = detailState;
    if (!current) return;
    const status = form.querySelector("[data-detail-status]");
    const values = Object.fromEntries(new FormData(form));
    status.textContent = "Saving…";
    let result = null;
    if (current.adding) {
      const rowData = { ...values, [current.definition.clientField]:current.code };
      result = await window.crmCdms.mutate({
        kind:current.definition.key === "misc" ? "misc" : "update",
        client:current.code,
        body:{ action:"addRow", fileKey:current.definition.fileKey, rowData },
      });
    } else {
      const inputs = [...form.querySelectorAll("input[name]")];
      const changed = inputs.filter((input) => input.value !== input.dataset.original);
      const identifiers = new Set(current.definition.identifiers || []);
      changed.sort((left, right) => Number(identifiers.has(left.name)) - Number(identifiers.has(right.name)));
      result = { ok:true };
      for (const input of changed) {
        result = await window.crmCdms.mutate({
          kind:current.definition.key === "misc" ? "misc" : "update",
          client:current.code,
          body:current.definition.key === "misc"
            ? { action:"updateCell", rowIndex:current.record._rowIndex, columnKey:input.name, newValue:input.value }
            : {
              action:"updateCell", fileKey:current.definition.fileKey,
              rowIdentifier:rowIdentifier(current.definition, current.record),
              columnKey:input.name, newValue:input.value,
            },
        });
        if (result?.ok === false) break;
        current.record[input.name] = input.value;
      }
    }
    if (result?.ok === false) { status.textContent = result.error || "Save failed"; return; }
    await refreshDetailRoom();
  };
  const archiveDetail = async () => {
    const current = detailState;
    if (!current) return;
    const result = await window.crmCdms.mutate({
      kind:"update",
      body:{
        action:"setInactive", fileKey:current.definition.fileKey,
        rowIdentifier:rowIdentifier(current.definition, current.record),
        inactive:current.definition.inactiveValue ?? 1,
        ...(current.definition.archiveColumn ? { inactiveColumn:current.definition.archiveColumn } : {}),
      },
    });
    if (result?.ok === false) {
      detailShell.querySelector("[data-detail-status]").textContent = result.error || "Archive failed";
      return;
    }
    await refreshDetailRoom();
  };
  const deleteMiscDetail = async () => {
    const current = detailState;
    if (!current || current.definition.key !== "misc") return;
    const result = await window.crmCdms.mutate({
      kind:"misc", client:current.code,
      body:{ action:"deleteRow", rowIndex:current.record._rowIndex },
    });
    if (result?.ok === false) {
      detailShell.querySelector("[data-detail-status]").textContent = result.error || "Delete failed";
      return;
    }
    await refreshDetailRoom();
  };

  const openClientEditor = async (client = null) => {
    let company = client;
    const code = clientCode(client);
    if (code) {
      try {
        const result = await window.crmCdms?.dataset?.("companies", {
          query:{ abbrv:code },
          force:true,
        });
        company = result?.payload?.company || client;
      } catch {}
    }
    detailState = { clientEditor:true, client:company || client };
    detailShell.hidden = false;
    detailShell.innerHTML = `<form class="crm-client-detail crm-menu-surface" data-client-editor>
      <header><div><span class="crm-clients-kicker">CDMS client</span><h2>${client ? "Update client" : "Add client"}</h2></div><button type="button" class="crm-menu-action" data-detail-close>×</button></header>
      <div class="crm-client-detail-fields">
        ${fieldMarkup("Company Name", text(company?.["Company Name"]) || clientLabel(company), true)}
        ${fieldMarkup("Abbrv", code, true)}
        ${fieldMarkup("Group", text(company?.Group ?? company?.group), true)}
        <label class="crm-client-detail-field crm-menu-item"><span>Status</span><select class="crm-menu-input" name="Status"><option value="0">Good</option><option value="1">Billing issue</option><option value="2">Must contact office</option></select></label>
      </div><footer><span data-detail-status></span><button type="button" class="crm-menu-action" data-detail-close>Cancel</button><button type="submit" class="crm-menu-action">Save</button></footer>
    </form>`;
    detailShell.querySelector('select[name="Status"]').value = String(company?.Status ?? company?.status ?? 0);
  };
  const saveClient = async (form) => {
    const values = Object.fromEntries(new FormData(form));
    values.Status = Number(values.Status) || 0;
    const previous = detailState?.client;
    const result = await window.crmCdms.mutate({
      kind:"company",
      body:{
        action:previous ? "update" : "add",
        rowData:values,
        ...(previous ? { rowIdentifier:{ Abbrv:clientCode(previous) } } : {}),
      },
    });
    if (result?.ok === false) {
      form.querySelector("[data-detail-status]").textContent = result.error || "Save failed";
      return;
    }
    closeDetail();
    loadedAt = 0;
    await loadClients({ force:true });
  };

  const ensureStyles = () => {
    if (document.getElementById("crm-clients-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-clients-styles";
    style.textContent = `
      .crm-clients-surface{position:fixed;inset:0;z-index:800;overflow:hidden;pointer-events:auto}
      .crm-clients-surface[hidden]{display:none}.crm-clients-level{position:absolute;inset:0;overflow:hidden;box-sizing:border-box}
      .crm-clients-root{padding:72px 52px 82px}.crm-clients-toolbar,.crm-client-world-head,.crm-client-room-head{position:relative;z-index:8;display:flex;align-items:center;gap:12px;min-height:48px;padding:8px 12px}
      .crm-clients-toolbar{height:52px}.crm-clients-toolbar>div:first-child,.crm-client-world-head>div:first-child,.crm-client-room-head>div:first-child{min-width:0;margin-right:auto}
      .crm-clients-toolbar h1,.crm-client-world-head h1,.crm-client-room-head h1,.crm-client-detail h2{margin:0;color:#fff;font-size:var(--crm-type-room,17px);line-height:1.2}
      .crm-clients-kicker{display:block;color:rgba(230,237,248,.5);font-size:var(--crm-type-micro,9px);font-weight:800;letter-spacing:.12em;text-transform:uppercase}
      .crm-client-search{width:min(320px,28vw)}.crm-client-search input{width:100%;box-sizing:border-box}
      .crm-client-scroll{position:absolute;inset:140px 52px 84px;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;overscroll-behavior:contain}
      .crm-client-grid{position:relative;isolation:isolate;display:grid;height:100%;min-width:max-content;grid-template-rows:repeat(3,minmax(126px,1fr));grid-auto-flow:column;grid-auto-columns:clamp(226px,22vw,292px);gap:18px;padding:0 2px 12px}
      .crm-clients-material{position:absolute!important;z-index:0!important;inset:0 auto auto 0;pointer-events:none;background:var(--bucket-acrylic-surface);border:1px solid var(--bucket-acrylic-border);box-shadow:var(--bucket-acrylic-shadow);backdrop-filter:var(--bucket-acrylic-filter);-webkit-backdrop-filter:var(--bucket-acrylic-filter)}
      .crm-client-tile{position:relative;z-index:1;min-width:0;min-height:0;padding:18px;text-align:left;color:#fff;border:1px solid var(--bucket-acrylic-border);border-radius:var(--home-r,22px);background:linear-gradient(180deg,rgba(22,27,38,.27),rgba(10,14,22,.21));box-shadow:var(--bucket-acrylic-shadow);overflow:hidden;cursor:pointer}
      .crm-client-tile:hover,.crm-client-tile:focus-visible{outline:0;border-color:rgba(255,255,255,.34);box-shadow:inset 0 1px rgba(255,255,255,.24),0 18px 34px -20px rgba(0,0,0,.8)}
      .crm-client-tile[hidden]{display:none}.crm-client-tile-content{display:flex;flex-direction:column;height:100%;min-height:0}.crm-client-tile-kicker{font-size:var(--crm-type-meta,10px);font-weight:800;letter-spacing:.08em;color:rgba(218,229,244,.48)}
      .crm-client-tile-title{margin-top:auto;font-size:var(--crm-type-tile,15px);font-weight:760;line-height:1.22}.crm-client-tile-meta{margin-top:6px;color:rgba(222,231,244,.52);font-size:var(--crm-type-caption,11px);line-height:1.3}
      .crm-client-root-state{position:absolute;inset:0;display:grid;place-items:center;color:rgba(255,255,255,.54);pointer-events:none}.crm-client-root-state[hidden]{display:none}
      .crm-clients-expander{position:absolute;box-sizing:border-box;overflow:hidden;color:#fff;border:1px solid var(--bucket-acrylic-border);border-radius:var(--home-r,24px);background:rgba(12,16,24,.25);box-shadow:var(--bucket-acrylic-shadow)}
      .crm-client-transition-acrylic{position:absolute;inset:0;z-index:0;border-radius:inherit;background:var(--bucket-acrylic-surface);backdrop-filter:var(--bucket-acrylic-filter);-webkit-backdrop-filter:var(--bucket-acrylic-filter);pointer-events:none}
      .crm-client-expander-live{position:absolute;z-index:1;inset:0;padding:72px 52px 80px;box-sizing:border-box;overflow:hidden}.crm-client-world-head,.crm-client-room-head{height:54px}
      .crm-client-world-meta{color:rgba(222,231,244,.52);font-size:var(--crm-type-caption,11px)}.crm-client-world-actions{display:flex;gap:3px}
      .crm-client-room-grid,.crm-client-work-grid{position:absolute;isolation:isolate;inset:150px 52px 82px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr));gap:18px}
      .crm-client-work-grid{grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr))}
      .crm-client-dataset-strip{position:absolute;inset:150px 36px 82px;display:flex;gap:18px;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;overscroll-behavior:contain;padding:0 16px 12px}
      .crm-client-dataset-bucket{display:flex;flex:0 0 clamp(250px,27vw,350px);flex-direction:column;min-height:0;padding:10px;border-radius:22px;overflow:hidden}
      .crm-client-bucket-head{display:flex;align-items:center;gap:8px;min-height:36px;padding:0 3px 8px}.crm-client-bucket-head>div:first-child{min-width:0;margin-right:auto}
      .crm-client-bucket-title{font-size:var(--crm-type-object,14px);font-weight:760}.crm-client-bucket-count{margin-left:6px;color:rgba(226,234,246,.42);font-size:var(--crm-type-meta,10px)}
      .crm-client-bucket-actions{display:flex;gap:1px}.crm-client-bucket-actions .crm-menu-action{min-height:28px!important;padding:0 6px!important;font-size:var(--crm-type-meta,10px)!important}
      .crm-client-page-size{width:46px!important;min-width:46px!important;height:28px!important;min-height:28px!important;padding:0 4px!important;font-size:var(--crm-type-meta,10px)!important}
      .crm-client-card-list{display:flex;flex:1 1 auto;min-height:0;flex-direction:column;gap:8px;overflow-y:auto;padding:1px 2px 8px;scrollbar-width:thin}
      .crm-client-record-card{position:relative;display:flex;flex:0 0 auto;min-height:118px;flex-direction:column;gap:5px;padding:13px 14px;text-align:left;color:#fff;border:1px solid rgba(255,255,255,.13);border-radius:15px;background:linear-gradient(155deg,rgba(67,78,98,.66),rgba(30,38,52,.58));box-shadow:inset 0 1px rgba(255,255,255,.16),0 12px 20px -16px rgba(0,0,0,.9);cursor:pointer}
      .crm-client-record-card:hover{border-color:rgba(255,255,255,.27)}.crm-client-record-title{font-size:var(--crm-type-object,14px);font-weight:760;line-height:1.25}.crm-client-record-subtitle{color:rgba(230,237,247,.54);font-size:var(--crm-type-caption,11px);line-height:1.3}
      .crm-client-record-facts{display:grid;gap:2px;margin-top:auto}.crm-client-record-facts span{display:grid;grid-template-columns:minmax(66px,.7fr) minmax(0,1.3fr);gap:8px;color:rgba(234,240,249,.6);font-size:var(--crm-type-meta,10px)}.crm-client-record-facts b{overflow:hidden;text-overflow:ellipsis;color:rgba(234,240,249,.38);font-weight:650}
      .crm-client-secret-chip{position:absolute;right:10px;bottom:8px;color:rgba(245,222,153,.62);font-size:var(--crm-type-micro,9px)}
      .crm-client-empty{display:grid;min-height:80px;place-items:center;padding:18px;text-align:center;color:rgba(230,237,247,.42);font-size:var(--crm-type-caption,11px)}
      .crm-client-page{display:flex;align-items:center;justify-content:center;gap:5px;padding-top:5px;color:rgba(230,237,247,.46);font-size:var(--crm-type-meta,10px)}.crm-client-page .crm-menu-action{min-height:27px!important;padding:0 7px!important}
      .crm-client-overview-grid,.crm-client-report-grid{position:absolute;inset:150px 52px 82px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-auto-rows:minmax(118px,1fr);gap:18px;overflow-y:auto}
      .crm-client-overview-card{display:flex;min-width:0;flex-direction:column;padding:16px}.crm-client-overview-card>span{color:rgba(228,236,248,.48);font-size:var(--crm-type-caption,11px)}.crm-client-overview-card strong{margin-top:auto;font-size:clamp(20px,3vw,36px);font-weight:760}.crm-client-overview-card small{margin-top:5px;color:rgba(228,236,248,.42);font-size:var(--crm-type-meta,10px)}
      .crm-client-report-card{position:relative;z-index:1;display:flex;min-width:0;min-height:190px;box-sizing:border-box;flex-direction:column;padding:13px;border:1px solid var(--bucket-acrylic-border);border-radius:18px;background:linear-gradient(180deg,rgba(22,27,38,.27),rgba(10,14,22,.21));box-shadow:var(--bucket-acrylic-shadow);overflow:hidden}
      .crm-client-report-card>header{display:flex;align-items:flex-start;gap:8px}.crm-client-report-card>header>span{min-width:0;margin-right:auto;color:rgba(232,239,249,.58);font-size:var(--crm-type-caption,11px);font-weight:700}.crm-client-report-card>header>strong{font-size:var(--crm-type-object,14px);font-weight:780;text-align:right}.crm-client-report-card>small{display:block;margin-top:4px;color:rgba(230,237,248,.38);font-size:var(--crm-type-micro,9px);line-height:1.3}
      .crm-client-report-list{display:flex;min-height:0;flex:1 1 auto;flex-direction:column;gap:4px;margin-top:9px;overflow-y:auto;scrollbar-width:thin}.crm-client-report-list>div:not(.crm-client-empty){display:grid;gap:2px;padding:6px 7px;border-radius:9px;background:rgba(12,17,25,.28)}.crm-client-report-list b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(240,244,251,.72);font-size:var(--crm-type-meta,10px)}.crm-client-report-list span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(228,235,246,.4);font-size:var(--crm-type-micro,9px)}.crm-client-report-card>footer{padding-top:5px;color:rgba(228,235,246,.34);font-size:var(--crm-type-micro,9px);text-align:right}
      .crm-client-overview-links{display:flex;flex-direction:column;justify-content:center;padding:10px}.crm-client-overview-links .crm-menu-action{text-align:left!important}
      .crm-client-room-error{position:absolute;left:50%;top:50%;display:grid;gap:10px;width:min(360px,calc(100vw - 48px));padding:18px;transform:translate(-50%,-50%)}
      .crm-client-detail-shell{position:fixed;inset:0;z-index:9800;display:grid;place-items:center;background:rgba(4,7,12,.28);-webkit-app-region:no-drag}.crm-client-detail-shell[hidden]{display:none}
      .crm-client-detail{display:flex;width:min(760px,calc(100vw - 40px));max-height:calc(100vh - 90px);flex-direction:column;padding:10px;border-radius:24px;overflow:hidden}.crm-client-detail>header,.crm-client-detail>footer{display:flex;align-items:center;gap:4px;padding:5px}.crm-client-detail>header>div{margin-right:auto}.crm-client-detail>footer>span{margin-right:auto;color:rgba(255,220,150,.72);font-size:var(--crm-type-caption,11px)}
      .crm-client-detail-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;overflow-y:auto;padding:6px}.crm-client-detail-field{display:grid;gap:5px;padding:8px!important}.crm-client-detail-field>span,.crm-client-secret-row>span:first-child{color:rgba(230,237,248,.48);font-size:var(--crm-type-caption,11px)}.crm-client-detail-field output{min-height:28px;color:#fff;font-size:var(--crm-type-body,12px);overflow-wrap:anywhere}
      .crm-client-secret-row{display:grid;grid-template-columns:minmax(90px,1fr) minmax(0,1.5fr) auto auto;align-items:center;gap:5px;padding:8px!important}.crm-client-secret-mask{letter-spacing:.12em;color:rgba(255,255,255,.6)}
      .crm-client-danger{color:#ffaaa3!important}.crm-client-menu{position:fixed;z-index:9790;width:170px;padding:6px}.sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
      @media(max-width:780px){.crm-clients-root,.crm-client-expander-live{padding-inline:20px}.crm-client-scroll{inset-inline:20px}.crm-client-room-grid,.crm-client-work-grid,.crm-client-overview-grid,.crm-client-report-grid{inset-inline:20px;grid-template-columns:repeat(2,minmax(0,1fr))}.crm-client-detail-fields{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  };

  const acrylicLens = window.createFractalAcrylicLens({
    frameSelector:":scope > .crm-client-transition-acrylic",
    lensClass:"crm-client-screen-acrylic",
    holdThroughMotion:true,
    releaseMs:125,
  });

  const layout = () => {
    camera?.layers?.().forEach((layer) => {
      if (!layer) return;
      layer.style.width = `${innerWidth}px`;
      layer.style.height = `${innerHeight}px`;
    });
  };

  const mount = () => {
    if (camera) return camera.surface();
    ensureStyles();
    detailShell = document.createElement("div");
    detailShell.className = "crm-client-detail-shell";
    detailShell.hidden = true;
    document.body.appendChild(detailShell);
    camera = window.createFractalCamera({
      apiName:"crmClientsCamera",
      theater:"clients",
      surfaceClass:"crm-clients-surface",
      layerClass:"crm-clients-level",
      warmClass:"crm-clients-warm",
      contractingClass:"crm-clients-contracting",
      active:false,
      maxLevel:2,
      margin:0,
      morphMs:MORPH_MS,
      expandFadeMs:90,
      belowFadeMs:90,
      contractFadeMs:110,
      keepBelowVisibleDuringTransition:true,
      precomposeTransitions:true,
      lockInputDuringTransitions:true,
      contractExpanderAbove:true,
      holdContractEndpointFrame:true,
      keepExpanderOpaqueDuringTransition:true,
      measureTop:() => 0,
      ensureStyles,
      buildRoot,
      layout,
      buildExpander,
      configureExpander,
      primeExpander:acrylicLens.prime,
      prepareTarget:(target) => {
        selectedObject = objectForElement(target);
        const clientObject = clientObjectFor(selectedObject);
        if (clientObject) {
          const client = clientObject.data.client;
          window.crmClientContext?.select?.({
            id:`cdms-company-${stableHash(clientObject.data.clientCode.toLowerCase())}`,
            code:clientObject.data.clientCode,
            label:clientLabel(client),
            group:text(client?.group),
          }, { reason:"client-camera" });
        }
      },
      targetFromEvent:(event, context) => {
        if (event.target?.closest?.("input,select,textarea,[data-client-add],[data-client-refresh],[data-client-edit],[data-client-refresh-room],[data-crm-workspace-target],[data-crm-monitor-view]")) return null;
        const tile = event.target?.closest?.(".crm-client-tile[data-crm-tile-instance='viewport']");
        if (!tile || !context.layers?.[context.level]?.contains(tile)) return null;
        return tile;
      },
      targetAtPoint:(x, y, context) => [...(context.layers?.[context.level]?.querySelectorAll?.(".crm-client-tile[data-crm-tile-instance='viewport']") || [])].find((tile) => {
        const bounds = tile.getBoundingClientRect();
        return !tile.hidden && x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
      }) || null,
      sourceSelector:(target) => `[data-tile-object-id="${cssValue(target?.dataset?.tileObjectId)}"]`,
      keyOf:(target) => target?.dataset?.tileObjectId || "",
      onTransformPrepare:(direction) => acrylicLens.start(direction),
      onTransformReady:(_direction, context) => acrylicLens.sync(context.transformAnimation, context.transformStartTime),
      onTransitionEnd:async(direction, context) => {
        if (direction === "expand") await acrylicLens.release();
        acrylicLens.finish();
        if (context.level === 2) {
          const layer = context.layers[2];
          const object = objectForElement(layer);
          if (layer && object?.data?.unit === "room") await loadRoom(layer.querySelector(".crm-client-expander-live"), object);
        }
      },
      onLevelChange:(context) => {
        selectedObject = context.level ? objectForElement(context.layers[context.level]) : null;
      },
      onRootBack:() => window.crmDeskTransit?.driveTo?.("home"),
    });
    return camera.surface();
  };

  const setActive = (on) => {
    active = !!on;
    mount();
    camera.setActive(active);
    if (active) {
      void loadClients().catch(() => {});
      requestAnimationFrame(layout);
    } else closeDetail();
    return api;
  };

  const rootEventState = (target) => {
    const host = target?.closest?.(".crm-client-expander-live");
    return host ? roomStateByHost.get(host) : null;
  };
  document.addEventListener("input", (event) => {
    if (!active) return;
    if (event.target.matches("[data-client-search]")) {
      rootQuery = event.target.value;
      const layer = camera?.layers?.()[0];
      filterClientTiles(layer);
      return;
    }
    if (event.target.matches("[data-room-search]")) {
      const state = rootEventState(event.target);
      if (!state) return;
      state.query = event.target.value;
      state.pages.clear();
      renderAllBuckets(state);
    }
  });
  document.addEventListener("change", (event) => {
    if (!active || !event.target.matches("[data-page-size]")) return;
    const state = rootEventState(event.target);
    const key = event.target.dataset.pageSize;
    const pageSize = Number(event.target.value);
    if (!state || !key || ![25, 50, 100, 200].includes(pageSize)) return;
    state.pageSizes.set(key, pageSize);
    state.pages.set(key, 0);
    renderAllBuckets(state);
  });
  document.addEventListener("click", async (event) => {
    const target = event.target;
    if (target.closest?.("[data-detail-close]")) return closeDetail();
    if (target.closest?.("[data-reveal-field]")) return revealSecret(target.closest("[data-reveal-field]"));
    if (target.closest?.("[data-copy-secret]")) return copySecret(target.closest("[data-copy-secret]"));
    if (target.closest?.("[data-detail-archive]")) return archiveDetail();
    if (target.closest?.("[data-detail-delete]")) return deleteMiscDetail();
    if (!active) return;
    if (target.closest?.("[data-client-add]")) return openClientEditor();
    if (target.closest?.("[data-client-refresh]")) {
      loadedAt = 0; dataCache.clear();
      await window.crmCdms.refresh?.();
      await loadClients({ force:true });
      return;
    }
    const editClient = target.closest?.("[data-client-edit]");
    if (editClient) {
      const client = clients.find((record) => clientCode(record) === editClient.dataset.clientEdit);
      return openClientEditor(client);
    }
    const refreshRoom = target.closest?.("[data-client-refresh-room]");
    if (refreshRoom) {
      const host = refreshRoom.closest(".crm-client-expander-live");
      const object = objectForElement(host?.closest(".crm-clients-expander"));
      if (object?.data?.unit === "client") {
        await loadClients({ force:true });
        renderClientWorld(host, object);
      } else if (object) await loadRoom(host, object, { force:true });
      return;
    }
    const route = target.closest?.("[data-crm-workspace-target]");
    if (route) {
      window.crmClientContext?.select?.(selectedClient(), { reason:"work-route" });
      return window.crmDeskTransit?.driveTo?.(route.dataset.crmWorkspaceTarget)
        || window.crmWorkspaces?.setActive?.(route.dataset.crmWorkspaceTarget);
    }
    const monitor = target.closest?.("[data-crm-monitor-view]");
    if (monitor) {
      window.crmMonitoring?.setView?.(monitor.dataset.crmMonitorView);
      return window.crmDeskTransit?.driveTo?.("monitoring")
        || window.crmWorkspaces?.setActive?.("monitoring");
    }
    const openUrl = target.closest?.("[data-open-url]");
    if (openUrl) {
      const url = openUrl.dataset.openUrl;
      if (/^https?:\/\//i.test(url)) return window.electron?.openExternal?.(url);
      if (/^(tel:|mailto:)/i.test(url)) return window.open(url, "_self");
    }
    const state = rootEventState(target);
    if (!state) return;
    const sort = target.closest?.("[data-dataset-sort]");
    if (sort) {
      const key = sort.dataset.datasetSort;
      const current = state.sorts.get(key) || "none";
      state.sorts.set(key, current === "none" ? "asc" : current === "asc" ? "desc" : "none");
      state.pages.set(key, 0); renderAllBuckets(state); return;
    }
    const exportButton = target.closest?.("[data-dataset-export]");
    if (exportButton) {
      const definition = datasetByKey(exportButton.dataset.datasetExport);
      return exportCsv(definition, filteredRows(definition, state.datasets.get(definition.key)?.rows || [], state), state.code);
    }
    const add = target.closest?.("[data-dataset-add]");
    if (add) {
      const definition = datasetByKey(add.dataset.datasetAdd);
      return openRecordDetail(definition, {}, state, { adding:true });
    }
    const page = target.closest?.("[data-page-step]");
    if (page) {
      const key = page.dataset.pageDataset;
      state.pages.set(key, Math.max(0, (state.pages.get(key) || 0) + Number(page.dataset.pageStep || 0)));
      renderAllBuckets(state); return;
    }
    const card = target.closest?.("[data-cdms-record]");
    if (card) {
      const definition = datasetByKey(card.dataset.cdmsDataset);
      const record = state.visibleRows.get(definition.key)?.[Number(card.dataset.cdmsRecord)];
      if (record) openRecordDetail(definition, record, state);
    }
  }, true);
  document.addEventListener("submit", async (event) => {
    if (event.target.matches("[data-cdms-detail-form]")) {
      event.preventDefault();
      await saveDetail(event.target);
    } else if (event.target.matches("[data-client-editor]")) {
      event.preventDefault();
      await saveClient(event.target);
    }
  });
  document.addEventListener("contextmenu", (event) => {
    if (!active) return;
    const tile = event.target?.closest?.(".crm-client-company-tile");
    if (!tile) return;
    event.preventDefault();
    clientMenu?.remove();
    const object = objectForElement(tile);
    clientMenu = document.createElement("div");
    clientMenu.className = "crm-client-menu crm-menu-surface";
    clientMenu.innerHTML = '<button type="button" class="crm-menu-action" data-context-client-edit>Edit client</button>';
    Object.assign(clientMenu.style, { left:`${event.clientX}px`, top:`${event.clientY}px` });
    clientMenu.querySelector("button").addEventListener("click", () => {
      clientMenu.remove(); clientMenu = null; openClientEditor(object?.data?.client);
    });
    document.body.appendChild(clientMenu);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && detailShell && !detailShell.hidden) {
      event.stopPropagation();
      closeDetail();
    }
  }, true);

  const waitForGeometrySettled = async () => {
    let previous = "";
    let stable = 0;
    const started = performance.now();
    while (performance.now() - started < 1000) {
      const signature = camera?.layers?.()[0]?.querySelectorAll?.(".crm-client-company-tile")
        ? [...camera.layers()[0].querySelectorAll(".crm-client-company-tile")].map((tile) => {
          const bounds = tile.getBoundingClientRect();
          return `${tile.dataset.tileObjectId}:${bounds.x.toFixed(1)}:${bounds.y.toFixed(1)}:${bounds.width.toFixed(1)}:${bounds.height.toFixed(1)}`;
        }).join("|")
        : "";
      stable = signature && signature === previous ? stable + 1 : 0;
      previous = signature;
      if (stable >= 3) return { stable:true, signature };
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return { stable:false, signature:previous };
  };
  const homePreviewState = () => ({ revision:rootObject.revision, clients:clients.length });
  const applyHomePreviewState = async () => {
    await loadClients().catch(() => {});
    mount();
    if (camera.level() !== 0) camera.rebuildRoot();
    await waitForGeometrySettled();
    return homePreviewState();
  };

  const api = {
    setActive,
    isActive:() => active,
    baseline:async ({ canRender } = {}) => {
      mount();
      await loadClients().catch(() => {});
      if (typeof canRender !== "function" || canRender()) {
        if (camera.level() !== 0) camera.rebuildRoot();
        camera.layout();
      }
      return camera.surface();
    },
    waitForGeometrySettled,
    homePreviewState,
    applyHomePreviewState,
    refresh:async () => {
      dataCache.clear(); loadedAt = 0;
      await loadClients({ force:true });
      return clients.length;
    },
    clients:() => clone(clients),
    selectedClient,
    level:() => camera?.level?.() || 0,
    surface:() => camera?.surface?.() || null,
    _objectGraph:() => rootObject,
    _objectIndex:() => objectIndex,
    _objectForElement:objectForElement,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once:true });
  else mount();
  window.crmClients = api;
})();
