// crm-money-room.js — one Money room with a quiet Bills / Invoices selector.
(() => {
  const VIEWS = [{ key: "bills", label: "Bills", api: () => window.billPipeline }, { key: "invoices", label: "Invoices", api: () => window.moneyPipeline }];
  const STORE_KEY = "crm-money-view-v1";
  let root = null;
  let active = false;
  let selected = ["bills", "invoices"].includes(localStorage.getItem(STORE_KEY)) ? localStorage.getItem(STORE_KEY) : "invoices";

  const ensureStyles = () => {
    if (document.getElementById("crm-money-room-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-money-room-styles";
    style.textContent = `
      .crm-money-room{position:fixed;inset:0;z-index:836;pointer-events:none;color:#fff}.crm-money-room[hidden]{display:none}
      .crm-money-stage{display:contents}.crm-money-switcher{position:fixed;z-index:1100;left:54px;top:50%;width:176px;
        transform:translateY(-50%);padding:8px 6px;pointer-events:auto;overflow:hidden}
      .crm-money-switcher-head{padding:9px 12px 8px;font:700 .78rem/1 system-ui;color:rgba(255,255,255,.76);letter-spacing:.04em}
      .crm-money-switcher-list{display:flex;flex-direction:column;gap:2px}
      .crm-money-view.crm-menu-action{position:relative;width:100%;height:42px;text-align:left;padding-left:28px!important;font-size:.84rem!important}
      .crm-money-view::before{content:"";position:absolute;left:12px;top:50%;width:5px;height:5px;border-radius:50%;
        transform:translateY(-50%);background:rgba(255,255,255,.2)}
      .crm-money-view.is-selected::before{background:rgba(142,190,255,.88);box-shadow:0 0 10px rgba(91,151,236,.6)}
      @media(max-width:1050px){.crm-money-switcher{left:20px;width:154px}}
    `;
    document.head.appendChild(style);
  };

  const mount = () => {
    if (root) return root;
    ensureStyles();
    root = document.createElement("main");
    root.className = "crm-money-room";
    root.dataset.crmTheater = "money-room";
    root.hidden = true;
    root.innerHTML = `<aside class="crm-money-switcher crm-menu-surface" aria-label="Money view">
      <div class="crm-money-switcher-head crm-menu-item">Money</div>
      <div class="crm-money-switcher-list">${VIEWS.map((view) => `<button type="button" class="crm-money-view crm-menu-action" data-money-view="${view.key}">${view.label}</button>`).join("")}</div>
    </aside><section class="crm-money-stage"></section>`;
    root.addEventListener("click", (event) => {
      const button = event.target.closest("[data-money-view]");
      if (button) select(button.dataset.moneyView);
    });
    document.body.appendChild(root);
    return root;
  };

  const attachRooms = async (options = {}) => {
    mount();
    await Promise.all(VIEWS.map(async (view) => {
      try { await view.api()?.baseline?.(options); } catch {}
      const theater = document.querySelector(`[data-crm-theater="${view.key === "invoices" ? "money" : "bills"}"]`);
      if (!theater) return;
      theater.dataset.crmSubtheater = "money";
      root.querySelector(".crm-money-stage")?.appendChild(theater);
    }));
    return root;
  };

  const sync = () => {
    mount();
    root.hidden = !active;
    VIEWS.forEach((view) => view.api()?.setActive?.(active && selected === view.key));
    root.querySelectorAll("[data-money-view]").forEach((button) => {
      const on = button.dataset.moneyView === selected;
      button.classList.toggle("is-selected", on);
      button.setAttribute("aria-pressed", String(on));
    });
  };

  function select(key) {
    if (!VIEWS.some((view) => view.key === key)) return selected;
    selected = key;
    try { localStorage.setItem(STORE_KEY, selected); } catch {}
    sync();
    return selected;
  }

  const setActive = (on) => {
    active = !!on;
    mount();
    if (active) attachRooms().then(sync);
    else sync();
    return api;
  };
  const baseline = async (options = {}) => { await attachRooms(options); sync(); return root; };
  const api = { setActive, baseline, select, selected: () => selected, isActive: () => active };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true }); else mount();
  window.crmMoneyRoom = api;
})();
