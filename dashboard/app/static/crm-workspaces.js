// crm-workspaces.js — state router. Spatial navigation belongs to Home's
// fractal camera; the only persistent control is the inherited Home return.
(() => {
  const MODULES = [
    { key: "home", label: "Home", api: () => window.crmHome },
    { key: "desk", label: "Desk", api: () => window.crmDesk },
    { key: "people", label: "People", api: () => window.crmPeopleRoom },
    { key: "pipeline", label: "Pipeline", api: () => window.dealPipeline },
    { key: "jobs", label: "Jobs", api: () => window.jobPipeline },
    { key: "money", label: "Money", api: () => window.moneyPipeline },
    { key: "calendar", label: "Calendar", api: () => window.fractalCalendar },
    { key: "cases", label: "Cases", api: () => window.ticketStacks },
  ];
  const THEATERS = { home:["home"],desk:["desk"],people:["relationships"],pipeline:["pipeline"],jobs:["jobs"],money:["money"],calendar:["calendar"],cases:["tickets"] };
  const STORE_KEY = "crm-active-module-v3";
  let active = localStorage.getItem(STORE_KEY) || "home";
  let root = null;
  function styles(){if(document.getElementById("crm-workspace-switch-styles"))return;const s=document.createElement("style");s.id="crm-workspace-switch-styles";s.textContent=`
    .crm-module-switch{position:fixed;left:50%;bottom:18px;z-index:4600;transform:translateX(-50%);width:48px;height:48px;-webkit-app-region:no-drag}.crm-module-switch[hidden]{display:none}
    .crm-home-control{appearance:none;width:48px;height:48px;padding:0;border-radius:50%;border:1px solid rgba(255,255,255,.2);cursor:pointer;pointer-events:auto;background:linear-gradient(180deg,rgba(22,26,36,.64),rgba(12,16,24,.58));backdrop-filter:blur(25px) saturate(130%);box-shadow:inset 0 1px rgba(255,255,255,.2),0 12px 30px rgba(0,0,0,.34);color:rgba(244,248,255,.76);display:grid;place-items:center;transition:transform .16s,color .16s,border-color .16s}.crm-home-control:hover{transform:scale(1.06);color:#fff;border-color:rgba(174,205,248,.42)}.crm-home-control svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
  `;document.head.appendChild(s)}
  function setActive(key){active=MODULES.some((m)=>m.key===key)?key:"home";localStorage.setItem(STORE_KEY,active);document.body.dataset.crmModule=active;try{window.crmSearchDeck?.close?.()}catch{}try{window.crmCompanyDive?.setActive?.(false)}catch{}try{window.crmRecordWorld?.close?.()}catch{}try{window.crmToday?.setActive?.(false)}catch{}try{window.crmReports?.setActive?.(false)}catch{}try{window.peopleCards?.setActive?.(false)}catch{}
    MODULES.forEach((module)=>{try{module.api()?.setActive?.(module.key===active)}catch{}});const allowed=new Set(THEATERS[active]||[]);document.querySelectorAll("[data-crm-theater]").forEach((el)=>{el.hidden=!allowed.has(el.dataset.crmTheater)});if(root)root.hidden=active==="home";document.dispatchEvent(new CustomEvent("crm:theater-switch",{detail:{key:active}}));return active}
  function mount(){styles();root=document.createElement("div");root.className="crm-module-switch";root.innerHTML=`<button type="button" class="crm-home-control" aria-label="Return Home"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 10.5 12 3.8l8.5 6.7"></path><path d="M5.8 9.3v10.2h12.4V9.3"></path><path d="M9.4 19.5v-5.7h5.2v5.7"></path></svg></button>`;root.addEventListener("click",()=>window.crmDeskTransit?.driveTo?.("home")||setActive("home"));document.body.appendChild(root);setActive(active)}
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mount);else mount();window.crmWorkspaces={setActive,active:()=>active,modules:()=>MODULES.map(({key,label})=>({key,label}))};
})();
