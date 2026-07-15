// crm-planner.js — Planner room shell. Project behavior is layered in the next batch.
(() => {
  let root = null;
  let active = false;
  const ensureStyles = () => {
    if (document.getElementById("crm-planner-styles")) return;
    const style = document.createElement("style"); style.id = "crm-planner-styles";
    style.textContent = `
      .crm-planner-surface{position:fixed;inset:0;z-index:836;color:#fff;overflow:hidden}.crm-planner-surface[hidden]{display:none}
      .crm-planner-frame{position:absolute;inset:66px 54px 86px;max-width:1380px;margin:auto;display:grid;grid-template-columns:220px minmax(0,1fr);gap:18px}
      .crm-planner-sidebar{padding:8px 6px;overflow:hidden}.crm-planner-sidebar-title{padding:10px 12px;font-size:.82rem;font-weight:700}
      .crm-planner-project-list{display:grid;gap:2px}.crm-planner-project.crm-menu-action{height:42px;text-align:left;font-size:.82rem!important}
      .crm-planner-canvas{min-width:0;padding:14px;display:grid;grid-template-rows:42px minmax(0,1fr)}
      .crm-planner-heading{display:flex;align-items:center;padding:0 8px;font-size:.92rem;font-weight:700}
      .crm-planner-buckets{min-height:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
      .crm-planner-bucket{min-width:0;min-height:0;padding:12px;overflow:hidden}.crm-planner-bucket-title{font-size:.78rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .crm-planner-empty{height:100%;display:grid;place-items:center;color:rgba(255,255,255,.42);font-size:.78rem;text-align:center}
    `; document.head.appendChild(style);
  };
  const mount = () => {
    if (root) return root;
    ensureStyles(); root = document.createElement("main"); root.className = "crm-planner-surface"; root.dataset.crmTheater = "planner"; root.hidden = true;
    root.innerHTML = `<div class="crm-planner-frame"><aside class="crm-planner-sidebar crm-menu-surface"><div class="crm-planner-sidebar-title crm-menu-item">Projects</div><div class="crm-planner-project-list"><button type="button" class="crm-planner-project crm-menu-action is-selected">First project</button></div></aside><section class="crm-planner-canvas crm-menu-surface"><header class="crm-planner-heading">First project</header><div class="crm-planner-buckets">${["Ideas","In progress","Done"].map((label) => `<section class="crm-planner-bucket crm-menu-item"><div class="crm-planner-bucket-title">${label}</div><div class="crm-planner-empty">Custom buckets and project cards</div></section>`).join("")}</div></section></div>`;
    document.body.appendChild(root); return root;
  };
  const setActive = (on) => { active = !!on; mount(); root.hidden = !active; return api; };
  const baseline = async () => { mount(); root.hidden = !active; return root; };
  const api = { setActive, baseline, isActive: () => active };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true }); else mount();
  window.crmPlanner = api;
})();
