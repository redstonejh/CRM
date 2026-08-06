// crm-workspaces.js — state router. Spatial navigation belongs to Home's
// fractal camera; room views carry a bottom cluster for viewport history and Home.
(() => {
  const MODULES = [
    { key: "home", label: "Home", api: () => window.crmHome },
    { key: "people", label: "People", api: () => window.peopleCards },
    { key: "pipeline", label: "Pipeline", api: () => window.dealPipeline },
    { key: "jobs", label: "Jobs", api: () => window.jobPipeline },
    { key: "planner", label: "Projects", api: () => window.crmPlanner },
    { key: "assignments", label: "Assignments", api: () => window.crmAssignments },
    { key: "calendar", label: "Calendar", api: () => window.fractalCalendar },
    { key: "monitoring", label: "Monitoring", api: () => window.crmMonitoring },
    { key: "cases", label: "Tickets", api: () => window.ticketStacks },
  ];
  const THEATERS = { home:["home"],people:["people"],pipeline:["pipeline"],jobs:["jobs"],planner:["planner"],assignments:["assignments"],calendar:["calendar"],monitoring:["monitoring"],cases:["tickets"] };
  const STORE_KEY = "crm-active-module-v3";
  let active = localStorage.getItem(STORE_KEY) || "home";
  let root = null;
  let routeSequence = 0;
  const apiStates = new WeakMap();
  // Staged routing is entered from desk transit's rAF continuation. Scheduling
  // one subsequent callback therefore closes the current mutation's paint
  // before the next route owner runs, while avoiding an unnecessary blank
  // refresh between every activation step.
  const nextPaint = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const traceRoutePhase = (sequence, phase) => {
    if (window.__crmDeskPerformanceTrace === true) {
      performance.mark(`crm-workspaces:${sequence}:${phase}`);
    }
  };
  const moduleKey = (key) => MODULES.some((module) => module.key === key) ? key : "home";
  function styles(){if(document.getElementById("crm-workspace-switch-styles"))return;const s=document.createElement("style");s.id="crm-workspace-switch-styles";s.textContent=`
    .crm-module-switch{position:fixed;left:50%;bottom:18px;z-index:4600;transform:translateX(-50%) translateZ(0);will-change:transform;width:154px;height:46px;display:grid;grid-template-columns:repeat(3,46px);align-items:center;gap:8px;-webkit-app-region:no-drag}.crm-module-switch[hidden]{display:none}
    .crm-home-control-deadzone{position:absolute;z-index:0;left:50%;bottom:-18px;width:244px;height:150px;transform:translateX(-50%);clip-path:polygon(25% 0,75% 0,100% 100%,0 100%);pointer-events:auto;cursor:default;-webkit-app-region:no-drag}
    .crm-module-switch .crm-secondary-control{position:relative;z-index:1;pointer-events:auto}.crm-module-switch .crm-secondary-control>svg{fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
  `;document.head.appendChild(s)}
  function syncNavigationControls(){if(!root)return;const state=window.crmDeskTransit?.historyState?.()||{canBack:false,canForward:false,busy:false};const back=root.querySelector("[data-crm-history-back]");const forward=root.querySelector("[data-crm-history-forward]");const home=root.querySelector(".crm-home-control");back.disabled=!state.canBack;forward.disabled=!state.canForward;home.disabled=active==="home"||state.busy;home.setAttribute("aria-current",active==="home"?"page":"false");root.dataset.canBack=String(!!state.canBack);root.dataset.canForward=String(!!state.canForward);root.hidden=active==="home"}
  function beginRoute(next) {
    if (next !== active) window.crmDeskTransit?.noteViewportDeparture?.();
    active = next;
    if (!window.crmHomePreviews?.isCaptureWorker) localStorage.setItem(STORE_KEY, active);
    document.body.dataset.crmModule = active;
  }
  function closeTransientSurfaces() {
    try { window.crmSearchDeck?.close?.(); } catch {}
    try { window.crmCompanyDive?.setActive?.(false); } catch {}
    try { window.crmRecordWorld?.close?.(); } catch {}
    try { window.crmToday?.setActive?.(false); } catch {}
    try { window.crmReports?.setActive?.(false); } catch {}
  }
  function syncModuleApis() {
    const activeApi = MODULES.find((module) => module.key === active)?.api?.();
    const seen = new Set();
    MODULES.forEach((module) => {
      try {
        const api = module.api?.();
        if (!api || seen.has(api)) return;
        seen.add(api);
        const on = api === activeApi;
        if (apiStates.get(api) === on) return;
        api.setActive?.(on);
        apiStates.set(api, on);
      } catch {}
    });
  }
  function syncTheaters() {
    const allowed = new Set(THEATERS[active] || []);
    document.querySelectorAll("[data-crm-theater]").forEach((element) => {
      if (element.dataset.crmSubtheater) return;
      const hidden = !allowed.has(element.dataset.crmTheater);
      // Forward desk transit still needs Home's decoded endpoint owner while
      // the incoming room is committed beneath it. Home finalization applies
      // the semantic hidden state after reducing that camera to one retained
      // bitmap; doing it here lays out the complete Home scene unnecessarily.
      if (hidden
        && element.dataset.crmTheater === "home"
        && element.hasAttribute("data-crm-transit-cover")) return;
      if (element.hidden !== hidden) element.hidden = hidden;
    });
  }
  function finishRoute() {
    syncNavigationControls();
    document.dispatchEvent(new CustomEvent("crm:theater-switch", { detail:{ key:active } }));
  }
  function setActive(key) {
    routeSequence += 1;
    beginRoute(moduleKey(key));
    closeTransientSurfaces();
    syncModuleApis();
    syncTheaters();
    finishRoute();
    return active;
  }
  async function setActiveStaged(key) {
    const sequence = ++routeSequence;
    traceRoutePhase(sequence, "begin");
    beginRoute(moduleKey(key));
    traceRoutePhase(sequence, "begun");
    // Each of these operations can invalidate a viewport-sized selector tree.
    // Desk transit calls this only beneath its decoded opaque endpoint raster,
    // so give every owner one closed 100 Hz paint instead of combining them
    // into a single long BeginMainFrame.
    await nextPaint();
    if (sequence !== routeSequence) return active;
    closeTransientSurfaces();
    syncModuleApis();
    traceRoutePhase(sequence, "apis-synced");
    await nextPaint();
    if (sequence !== routeSequence) return active;
    syncTheaters();
    traceRoutePhase(sequence, "theaters-synced");
    await nextPaint();
    if (sequence !== routeSequence) return active;
    finishRoute();
    traceRoutePhase(sequence, "finished");
    return active;
  }
  function mount(){styles();root=document.createElement("nav");root.className="crm-module-switch";root.setAttribute("aria-label","Viewport navigation");root.innerHTML=`<div class="crm-home-control-deadzone" aria-hidden="true"></div><button type="button" class="crm-history-control crm-secondary-control" data-crm-history-back aria-label="Back" title="Back · Mouse 4"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 6-6 6 6 6"></path></svg></button><button type="button" class="crm-home-control crm-secondary-control" aria-label="Return Home" title="Home"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 10.5 12 3.8l8.5 6.7"></path><path d="M5.8 9.3v10.2h12.4V9.3"></path><path d="M9.4 19.5v-5.7h5.2v5.7"></path></svg></button><button type="button" class="crm-history-control crm-secondary-control" data-crm-history-forward aria-label="Forward" title="Forward · Mouse 5"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 6 6 6-6 6"></path></svg></button>`;root.querySelector("[data-crm-history-back]")?.addEventListener("click",()=>window.crmDeskTransit?.back?.());root.querySelector(".crm-home-control")?.addEventListener("click",()=>window.crmDeskTransit?.driveTo?.("home")||setActive("home"));root.querySelector("[data-crm-history-forward]")?.addEventListener("click",()=>window.crmDeskTransit?.forward?.());document.body.appendChild(root);setActive(active);syncNavigationControls()}
  document.addEventListener("crm:navigation-history-changed",syncNavigationControls);
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mount);else mount();window.crmWorkspaces={setActive,setActiveStaged,active:()=>active,modules:()=>MODULES.map(({key,label})=>({key,label}))};
})();
