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
      .crm-money-stage{display:contents}.crm-money-switcher{position:fixed;z-index:1100;left:var(--crm-money-switcher-left,var(--crm-canvas-x,64px));top:var(--crm-money-switcher-top,132px);width:154px;
        box-sizing:border-box;padding:7px 6px;pointer-events:auto;overflow:hidden}
      .crm-money-switcher-list{display:flex;flex-direction:column;gap:2px}
      .crm-money-view.crm-menu-action{position:relative;width:100%;height:38px;text-align:left;padding-left:25px!important;letter-spacing:0}
      .crm-money-view::before{content:"";position:absolute;left:10px;top:17px;width:4px;height:4px;border-radius:50%;background:rgba(255,255,255,.16)}
      .crm-money-view.is-selected::before{background:rgba(174,207,250,.86);box-shadow:0 0 7px rgba(91,151,236,.4)}
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

  const alignSwitcher = () => {
    const theater = root?.querySelector(`[data-crm-subtheater="money"][data-crm-theater="${selected === "invoices" ? "money" : "bills"}"]`);
    const zone = [...(theater?.querySelectorAll?.(".tk-zone") || [])].find((node) => node.getBoundingClientRect().height > 0);
    if (!zone) return;
    const zoneRect = zone.getBoundingClientRect();
    const switcher = root.querySelector(".crm-money-switcher");
    const rootStyle = getComputedStyle(document.documentElement);
    const metric = (name, fallback) => parseFloat(rootStyle.getPropertyValue(name)) || fallback;
    const left = Math.max(metric("--crm-canvas-x", 64), zoneRect.left - (switcher?.offsetWidth || 154) - metric("--crm-object-gap", 18));
    root.style.setProperty("--crm-money-switcher-left", `${Math.round(left)}px`);
    root.style.setProperty("--crm-money-switcher-top", `${Math.round(zoneRect.top)}px`);
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
    alignSwitcher();
    requestAnimationFrame(alignSwitcher);
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
  window.addEventListener("resize", () => requestAnimationFrame(alignSwitcher));
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true }); else mount();
  window.crmMoneyRoom = api;
})();
