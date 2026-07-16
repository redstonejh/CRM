// crm-workspaces.js — state router. Spatial navigation belongs to Home's
// fractal camera; the only persistent control is the inherited Home return.
(() => {
  const MODULES = [
    { key: "home", label: "Home", api: () => window.crmHome },
    { key: "people", label: "People", api: () => window.peopleCards },
    { key: "pipeline", label: "Pipeline", api: () => window.dealPipeline },
    { key: "jobs", label: "Jobs", api: () => window.jobPipeline },
    { key: "planner", label: "Planner", api: () => window.crmPlanner },
    { key: "assignments", label: "Assignments", api: () => window.crmAssignments },
    { key: "calendar", label: "Calendar", api: () => window.fractalCalendar },
    { key: "cases", label: "Tickets", api: () => window.ticketStacks },
  ];
  const THEATERS = { home:["home"],people:["people"],pipeline:["pipeline"],jobs:["jobs"],planner:["planner"],assignments:["assignments"],calendar:["calendar"],cases:["tickets"] };
  const STORE_KEY = "crm-active-module-v3";
  let active = localStorage.getItem(STORE_KEY) || "home";
  let root = null;
  const apiStates = new WeakMap();
  function styles(){if(document.getElementById("crm-workspace-switch-styles"))return;const s=document.createElement("style");s.id="crm-workspace-switch-styles";s.textContent=`
    .crm-module-switch{position:fixed;left:50%;bottom:18px;z-index:4600;transform:translateX(-50%);width:48px;height:48px;-webkit-app-region:no-drag}.crm-module-switch[hidden]{display:none}
    .crm-module-switch::after{content:"";position:absolute;inset:0;z-index:0;border-radius:50%;pointer-events:none;background:linear-gradient(180deg,rgba(13,35,72,.94),rgba(3,10,24,.96));border:1px solid rgba(123,174,247,.42);backdrop-filter:blur(25px) saturate(145%);box-shadow:inset 0 1px rgba(214,232,255,.24),inset 0 0 18px rgba(45,105,193,.22),0 12px 34px rgba(0,0,0,.52),0 0 22px rgba(54,121,219,.18)}
    .crm-home-control-deadzone{position:absolute;z-index:0;left:50%;bottom:-18px;width:190px;height:150px;transform:translateX(-50%);clip-path:polygon(32% 0,68% 0,100% 100%,0 100%);pointer-events:auto;cursor:default;-webkit-app-region:no-drag}
    .crm-home-control{position:relative;z-index:1;appearance:none;width:48px;height:48px;padding:0;border-radius:50%;border:1px solid rgba(255,255,255,.2);cursor:pointer;pointer-events:auto;background:linear-gradient(180deg,rgba(22,26,36,.64),rgba(12,16,24,.58));backdrop-filter:blur(25px) saturate(130%);box-shadow:inset 0 1px rgba(255,255,255,.2),0 12px 30px rgba(0,0,0,.34);color:rgba(244,248,255,.76);display:grid;place-items:center;transition:transform .16s,color .16s,border-color .16s}.crm-home-control:hover{transform:scale(1.06);color:#fff;border-color:rgba(174,205,248,.42)}.crm-home-control svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
  `;document.head.appendChild(s)}
  function setActive(key){active=MODULES.some((m)=>m.key===key)?key:"home";if(!window.crmHomePreviews?.isCaptureWorker)localStorage.setItem(STORE_KEY,active);document.body.dataset.crmModule=active;try{window.crmSearchDeck?.close?.()}catch{}try{window.crmCompanyDive?.setActive?.(false)}catch{}try{window.crmRecordWorld?.close?.()}catch{}try{window.crmToday?.setActive?.(false)}catch{}try{window.crmReports?.setActive?.(false)}catch{}
    const activeApi=MODULES.find((module)=>module.key===active)?.api?.();const seen=new Set();MODULES.forEach((module)=>{try{const api=module.api?.();if(!api||seen.has(api))return;seen.add(api);const on=api===activeApi;if(apiStates.get(api)===on)return;api.setActive?.(on);apiStates.set(api,on)}catch{}});const allowed=new Set(THEATERS[active]||[]);document.querySelectorAll("[data-crm-theater]").forEach((el)=>{if(el.dataset.crmSubtheater)return;const hidden=!allowed.has(el.dataset.crmTheater);if(el.hidden!==hidden)el.hidden=hidden});if(root)root.hidden=active==="home";document.dispatchEvent(new CustomEvent("crm:theater-switch",{detail:{key:active}}));return active}
  function mount(){styles();root=document.createElement("div");root.className="crm-module-switch";root.innerHTML=`<div class="crm-home-control-deadzone" aria-hidden="true"></div><button type="button" class="crm-home-control" aria-label="Return Home"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 10.5 12 3.8l8.5 6.7"></path><path d="M5.8 9.3v10.2h12.4V9.3"></path><path d="M9.4 19.5v-5.7h5.2v5.7"></path></svg></button>`;root.querySelector(".crm-home-control")?.addEventListener("click",()=>window.crmDeskTransit?.driveTo?.("home")||setActive("home"));document.body.appendChild(root);setActive(active)}
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mount);else mount();window.crmWorkspaces={setActive,active:()=>active,modules:()=>MODULES.map(({key,label})=>({key,label}))};
})();
