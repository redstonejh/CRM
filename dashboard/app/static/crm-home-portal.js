// crm-home-portal.js — six live, semantic windows into the operating rooms.
(() => {
  const rooms = [
    { key: "desk", label: "Desk" }, { key: "people", label: "People" },
    { key: "pipeline", label: "Pipeline" }, { key: "jobs", label: "Jobs" },
    { key: "money", label: "Money" }, { key: "calendar", label: "Calendar" },
  ];
  let root; let active = false; let timer = 0; let generation = 0;
  const esc = (v) => String(v ?? "").replace(/[&<>\"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
  const first = (...v) => v.map((x) => String(x ?? "").trim()).find(Boolean) || "";
  const rows = (result) => result?.records || [];
  const title = (record) => first(record?.name, record?.title, record?.client, record?.number, record?.companyLabel, record?.id, "Untitled");
  const stages = {
    pipeline: ["lead","qualified","proposal","negotiation"],
    jobs: ["intake","planned","active","review"],
    money: ["draft","sent","overdue"],
  };
  function styles() {
    if (document.getElementById("crm-home-portal-styles")) return;
    const style = document.createElement("style"); style.id = "crm-home-portal-styles"; style.textContent = `
      .crm-home-portal{position:fixed;inset:0;z-index:842;color:rgba(244,247,252,.93);overflow:hidden}.crm-home-portal[hidden]{display:none}
      .crm-home-portal-grid{position:absolute;inset:60px 70px 88px;max-width:1420px;margin:auto;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:13px}
      .crm-home-window{position:relative;min-width:0;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden;padding:0;color:inherit;text-align:left;cursor:pointer;border:1px solid rgba(255,255,255,.12);border-radius:19px;background:linear-gradient(155deg,rgba(26,32,42,.72),rgba(10,14,21,.65));backdrop-filter:blur(25px) saturate(120%);box-shadow:inset 0 1px rgba(255,255,255,.1),0 20px 50px rgba(0,0,0,.23);transition:border-color .16s,box-shadow .16s,transform .16s}
      .crm-home-window:hover{transform:translateY(-2px);border-color:rgba(157,194,245,.28);box-shadow:inset 0 1px rgba(255,255,255,.13),0 25px 58px rgba(0,0,0,.3),0 0 28px rgba(73,128,205,.09)}
      .crm-home-window-head{display:flex;align-items:baseline;justify-content:center;padding:10px 16px}.crm-home-window-title{font:650 12px/1 system-ui;letter-spacing:.08em}.crm-home-window-count{display:none}
      .crm-home-window-body{min-height:0;overflow:hidden;padding:0 14px 14px}.crm-home-empty{display:none}
      .crm-home-mini-list{display:grid;gap:5px}.crm-home-mini-row{display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:center;gap:8px;min-height:34px;padding:5px 7px;border-radius:8px;background:rgba(255,255,255,.033)}.crm-home-mini-dot{width:6px;height:6px;border-radius:50%;background:rgba(142,180,233,.52)}.crm-home-mini-dot.is-late{background:rgba(235,143,119,.78)}.crm-home-mini-name{font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-home-mini-meta{font-size:8px;color:rgba(215,225,240,.38);white-space:nowrap}
      .crm-home-companies{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;height:100%}.crm-home-company{min-width:0;border-radius:10px;padding:9px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}.crm-home-company-name{font-size:9px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-home-company-people{display:grid;gap:4px;margin-top:9px}.crm-home-company-person{height:15px;border-radius:4px;background:linear-gradient(90deg,rgba(138,170,216,.18),rgba(255,255,255,.035))}.crm-home-company-person:nth-child(2){width:82%}.crm-home-company-person:nth-child(3){width:65%}
      .crm-home-stages{height:100%;display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:7px}.crm-home-stage{position:relative;min-width:0;border-radius:10px;padding:8px;background:rgba(255,255,255,.028);border:1px solid rgba(255,255,255,.06)}.crm-home-stage-name{font-size:8px;text-transform:uppercase;letter-spacing:.06em;color:rgba(204,220,241,.43);white-space:nowrap;overflow:hidden}.crm-home-stage-cards{position:absolute;left:7px;right:7px;bottom:7px;display:grid;gap:3px}.crm-home-stage-card{height:25px;border-radius:6px;padding:5px;box-sizing:border-box;background:linear-gradient(155deg,rgba(115,150,202,.2),rgba(255,255,255,.04));border:1px solid rgba(160,192,237,.08);font-size:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-home-stage-bar{position:absolute;left:8px;right:8px;top:25px;display:grid;grid-auto-flow:column;gap:2px}.crm-home-stage-bar i{height:2px;border-radius:4px;background:rgba(255,255,255,.08)}.crm-home-stage-bar i.is-on{background:rgba(129,179,244,.64)}
      .crm-home-month{height:100%;display:grid;grid-template-columns:repeat(7,1fr);grid-template-rows:repeat(5,1fr);gap:4px}.crm-home-day{position:relative;border-radius:4px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.055)}.crm-home-day.is-today{border-color:rgba(139,185,247,.52);box-shadow:0 0 9px rgba(82,145,230,.2)}.crm-home-day.has-due:after{content:"";position:absolute;left:3px;right:3px;bottom:3px;height:2px;border-radius:4px;background:rgba(139,187,250,.72)}
      .crm-home-flight{position:fixed;z-index:7900;pointer-events:none;overflow:hidden;color:rgba(244,247,252,.93);border:1px solid rgba(157,194,245,.3);background:rgba(17,22,30,.94);box-shadow:0 35px 100px rgba(0,0,0,.5);transition:left .42s cubic-bezier(.22,1,.26,1),top .42s cubic-bezier(.22,1,.26,1),width .42s cubic-bezier(.22,1,.26,1),height .42s cubic-bezier(.22,1,.26,1),border-radius .42s cubic-bezier(.22,1,.26,1),opacity .16s ease .34s}
      @media(max-width:900px){.crm-home-portal-grid{inset:55px 25px 84px;grid-template-columns:repeat(2,1fr);grid-template-rows:repeat(3,1fr)}}
    `; document.head.appendChild(style);
  }
  async function load() {
    const [commitments, flows, companies, contacts, deals, jobs, invoices] = await Promise.all([
      window.crmDomain.list("commitments", { includeDeleted:false, limit:100 }),
      window.crmDomain.list("workflow-entries", { includeDeleted:false, limit:200 }),
      window.crmStore.list("companies", { includeDeleted:false }), window.crmStore.list("contacts", { includeDeleted:false }),
      window.crmStore.list("deals", { includeDeleted:false }), window.crmStore.list("jobs", { includeDeleted:false }), window.crmStore.list("invoices", { includeDeleted:false }),
    ]);
    const recordIndex = new Map([...rows(deals).map((r)=>[`deals:${r.id}`,r]),...rows(jobs).map((r)=>[`jobs:${r.id}`,r]),...rows(invoices).map((r)=>[`invoices:${r.id}`,r])]);
    return { commitments:rows(commitments).filter((c)=>!["completed","cancelled","canceled"].includes(String(c.status).toLowerCase())), flows:rows(flows), companies:rows(companies), contacts:rows(contacts), recordIndex };
  }
  const activeFlow = (key, model) => { const workflow=key==="pipeline"?"sales":key; return model.flows.filter((f)=>f.workflowKey===workflow&&!f.deletedAt&&(stages[key]||[]).includes(String(f.stage).toLowerCase())); };
  const stagePreview = (key, model) => { const flow=activeFlow(key,model); const list=stages[key]; return `<div class="crm-home-stages">${list.map((stage,index)=>{const items=flow.filter((f)=>String(f.stage).toLowerCase()===stage);return `<div class="crm-home-stage"><div class="crm-home-stage-name">${esc(stage)}</div><div class="crm-home-stage-bar">${list.map((_,i)=>`<i class="${i<=index?"is-on":""}"></i>`).join("")}</div><div class="crm-home-stage-cards">${items.slice(0,3).map((item)=>`<div class="crm-home-stage-card">${esc(title(model.recordIndex.get(`${item.entityType}:${item.recordId}`)||{id:item.recordId}))}</div>`).join("")}</div></div>`}).join("")}</div>` };
  function preview(key, model) {
    if (key === "desk") { const items=[...model.commitments].sort((a,b)=>(Date.parse(a.dueAt||"")||9e15)-(Date.parse(b.dueAt||"")||9e15)).slice(0,5); return items.length?`<div class="crm-home-mini-list">${items.map((item)=>`<div class="crm-home-mini-row"><i class="crm-home-mini-dot${item.dueAt&&Date.parse(item.dueAt)<Date.now()?" is-late":""}"></i><span class="crm-home-mini-name">${esc(item.title)}</span><span class="crm-home-mini-meta">${item.dueAt?new Date(item.dueAt).toLocaleDateString([],{month:"short",day:"numeric"}):"open"}</span></div>`).join("")}</div>`:""; }
    if (key === "people") return `<div class="crm-home-companies">${model.companies.slice(0,6).map((company)=>{const people=model.contacts.filter((p)=>String(p.companyId||"")===String(company.id));return `<div class="crm-home-company"><div class="crm-home-company-name">${esc(title(company))}</div><div class="crm-home-company-people">${people.slice(0,3).map(()=>`<i class="crm-home-company-person"></i>`).join("")}</div></div>`}).join("")}</div>`;
    if (["pipeline","jobs","money"].includes(key)) return stagePreview(key,model);
    const now=new Date();const y=now.getFullYear(),m=now.getMonth();const firstDay=new Date(y,m,1).getDay();const due=new Set(model.commitments.map((c)=>String(c.dueAt||"").slice(0,10)));return `<div class="crm-home-month">${Array.from({length:35},(_,i)=>{const day=i-firstDay+1;const valid=day>0&&day<=new Date(y,m+1,0).getDate();const iso=valid?`${y}-${String(m+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`:"";return `<i class="crm-home-day${iso===new Date().toISOString().slice(0,10)?" is-today":""}${due.has(iso)?" has-due":""}" style="${valid?"":"visibility:hidden"}"></i>`}).join("")}</div>`;
  }
  function count(){return ""}
  const emptyModel = () => ({ commitments: [], flows: [], companies: [], contacts: [], recordIndex: new Map() });
  styles();
  window.crmHomePreviewData = { load, preview, count, emptyModel };
})();
