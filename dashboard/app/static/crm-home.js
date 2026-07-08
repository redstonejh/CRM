// crm-home.js - module home menu hosted by the shared fractal camera.
(() => {
  if (typeof window.createFractalCamera !== "function") {
    console.error("[CRM] fractal camera factory is not loaded");
    return;
  }

  const MODULES = [
    { key: "tickets", label: "Tickets", note: "Active queue and issue history", enabled: true },
    { key: "pipeline", label: "Pipeline", note: "Deals, stages and wins", enabled: true },
    { key: "people", label: "People", note: "Contacts and relationship attention", enabled: true },
    { key: "calendar", label: "Calendar", note: "Scheduled work by day", enabled: true },
    { key: "tasks", label: "Tasks", note: "Work items from the same card system", status: "Planned" },
    { key: "reports", label: "Reports", note: "Aggregates and builder widgets", status: "Phase 7" },
  ];
  let camera = null;

  const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[char]));

  const ensureStyles = () => {
    if (document.getElementById("crm-home-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-home-styles";
    style.textContent = `
      .crm-home-surface { position: fixed; inset: 0; z-index: 820; pointer-events: none; overflow: hidden; }
      .crm-home-surface[hidden] { display: none; }
      .crm-home-level { position: absolute; inset: 0; transform-origin: 0 0; }
      .crm-home-grid { position: absolute; display: grid; pointer-events: auto; -webkit-app-region: no-drag;
        grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(2, 1fr); gap: 14px; }
      .crm-home-bucket { position: relative; box-sizing: border-box; display: flex; flex-direction: column; min-height: 0;
        overflow: hidden; color: #fff; cursor: pointer;
        border-radius: 16px; padding: 14px 16px;
        background: linear-gradient(180deg, rgba(22,26,36,0.5), rgba(12,16,24,0.42));
        -webkit-backdrop-filter: blur(28px) saturate(140%); backdrop-filter: blur(28px) saturate(140%);
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.14), inset 0 1px 0 rgba(255,255,255,0.18), 0 18px 42px rgba(0,0,0,0.28);
        transition: box-shadow .18s ease, background .18s ease; }
      .crm-home-bucket:hover {
        background: linear-gradient(180deg, rgba(70,110,190,0.34), rgba(40,70,130,0.26));
        box-shadow: inset 0 0 0 1px rgba(125,180,255,0.5), 0 0 30px rgba(90,150,255,0.42);
      }
      .crm-home-bucket[aria-disabled="true"] { cursor: default; opacity: .54; }
      .crm-home-bucket[aria-disabled="true"]:hover {
        background: linear-gradient(180deg, rgba(22,26,36,0.5), rgba(12,16,24,0.42));
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.14), inset 0 1px 0 rgba(255,255,255,0.18), 0 18px 42px rgba(0,0,0,0.28);
      }
      .crm-home-title { font-size: clamp(1rem, 2.4vw, 1.35rem); font-weight: 800; line-height: 1.1; }
      .crm-home-note { margin-top: 8px; font-size: 0.8rem; line-height: 1.35; color: rgba(255,255,255,0.58); max-width: 24ch; }
      .crm-home-status { margin-top: 10px; width: fit-content; border-radius: 999px; padding: 3px 7px;
        font-size: 0.68rem; font-weight: 800; color: rgba(255,255,255,0.62); background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.10); }
      .crm-home-preview { margin-top: auto; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; opacity: .76; }
      .crm-home-tile { height: 9px; border-radius: 999px; background: rgba(255,255,255,0.14); }
      .crm-home-bucket[data-module="pipeline"] .crm-home-tile:nth-child(2),
      .crm-home-bucket[data-module="calendar"] .crm-home-tile:nth-child(3),
      .crm-home-bucket[data-module="people"] .crm-home-tile:nth-child(4) { background: rgba(125,180,255,0.42); }
      .crm-home-expander { position: absolute; z-index: 5; pointer-events: auto; -webkit-app-region: no-drag;
        transform-origin: 0 0; }
      .crm-home-warm, .crm-home-warm * { pointer-events: none !important; }
    `;
    document.head.appendChild(style);
  };

  const bucketHTML = (module) => `
    <div class="crm-home-title">${esc(module.label)}</div>
    <div class="crm-home-note">${esc(module.note)}</div>
    ${module.status ? `<div class="crm-home-status">${esc(module.status)}</div>` : ""}
    <div class="crm-home-preview" aria-hidden="true">
      <span class="crm-home-tile"></span><span class="crm-home-tile"></span>
      <span class="crm-home-tile"></span><span class="crm-home-tile"></span>
    </div>`;

  const buildRoot = () => {
    const root = document.createElement("div");
    root.className = "crm-home-level";
    const grid = document.createElement("div");
    grid.className = "crm-home-grid";
    MODULES.forEach((module) => {
      const bucket = document.createElement("button");
      bucket.type = "button";
      bucket.className = "crm-home-bucket";
      bucket.dataset.module = module.key;
      bucket.dataset.enabled = module.enabled ? "true" : "false";
      if (!module.enabled) bucket.setAttribute("aria-disabled", "true");
      bucket.innerHTML = bucketHTML(module);
      grid.appendChild(bucket);
    });
    root.appendChild(grid);
    return root;
  };

  const layout = ({ expRect }) => {
    const grid = camera?.surface?.()?.querySelector(".crm-home-grid");
    if (!grid) return;
    const E = expRect();
    const maxW = Math.min(E.w, 980);
    const maxH = Math.min(E.h, 560);
    const width = Math.max(320, maxW);
    const height = Math.max(260, maxH);
    Object.assign(grid.style, {
      left: `${Math.round(E.x + (E.w - width) / 2)}px`,
      top: `${Math.round(E.y + (E.h - height) / 2)}px`,
      width: `${Math.round(width)}px`,
      height: `${Math.round(height)}px`,
    });
  };

  const targetAtPoint = (x, y, context) => {
    if (context.level > 0) return null;
    return [...(context.layers[0]?.querySelectorAll('.crm-home-bucket[data-enabled="true"]') || [])].find((bucket) => {
      const rect = bucket.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }) || null;
  };

  const targetFromEvent = (event, context) => {
    if (context.level > 0) return null;
    const target = event.target.closest?.('.crm-home-bucket[data-enabled="true"]');
    return target && context.layers[0]?.contains(target) ? target : null;
  };

  const moduleFor = (target) => MODULES.find((module) => module.key === target?.dataset?.module) || MODULES[0];
  const buildExpander = (target) => {
    const module = moduleFor(target);
    const bucket = document.createElement("div");
    bucket.className = "crm-home-bucket crm-home-expander";
    bucket.dataset.module = module.key;
    bucket.innerHTML = bucketHTML(module);
    return bucket;
  };

  const openModule = (target) => {
    const module = target?.dataset?.module || "";
    if (!module || target?.dataset?.enabled !== "true") return;
    window.setTimeout(() => window.crmWorkspaces?.setActive?.(module), 180);
  };

  camera = window.createFractalCamera({
    apiName: "crmHomeCamera",
    surfaceClass: "crm-home-surface",
    layerClass: "crm-home-level",
    warmClass: "crm-home-warm",
    contractingClass: "crm-home-contracting",
    active: false,
    maxLevel: 1,
    margin: 16,
    ensureStyles,
    buildRoot,
    layout,
    targetFromEvent,
    targetAtPoint,
    buildExpander,
    keyOf: (target) => target.dataset.module || "",
    sourceSelector: (target) => `.crm-home-bucket[data-module="${target.dataset.module}"]`,
  });

  document.addEventListener("click", (event) => {
    if (!camera?.isActive?.()) return;
    const target = event.target?.closest?.(".crm-home-bucket[data-module]");
    if (!target || !camera.surface()?.contains(target)) return;
    openModule(target);
  }, true);

  window.crmHome = {
    setActive: (on) => camera.setActive(on),
    isActive: () => camera.isActive(),
    refresh: () => camera.refresh(),
  };
})();
