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
      .crm-money-stage{display:contents}.crm-money-switcher{position:fixed;z-index:1100;left:34px;top:132px;width:116px;
        box-sizing:border-box;padding:7px 6px 6px;pointer-events:auto;overflow:hidden}
      .crm-money-switcher-head{padding:5px 9px 7px;font:700 9px/1 system-ui;color:rgba(255,255,255,.36);letter-spacing:.14em;text-transform:uppercase}
      .crm-money-switcher-list{display:flex;flex-direction:column;gap:1px}
      .crm-money-view.crm-menu-action{position:relative;width:100%;height:31px;text-align:left;padding-left:20px!important;font-size:.7rem!important;letter-spacing:.01em}
      .crm-money-view::before{content:"";position:absolute;left:8px;top:9px;width:2px;height:13px;border-radius:2px;background:rgba(255,255,255,.13);transition:background .14s ease,box-shadow .14s ease}
      .crm-money-view.is-selected::before{background:rgba(151,196,255,.9);box-shadow:0 0 9px rgba(91,151,236,.48)}
      @media(max-width:1050px){.crm-money-switcher{left:18px;top:112px;width:108px}}
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
