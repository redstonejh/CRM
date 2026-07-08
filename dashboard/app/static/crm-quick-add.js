// crm-quick-add.js - global launcher for the existing module create flows.
(() => {
  const ITEMS = [
    { key: "ticket", label: "Ticket", module: "tickets", api: () => window.ticketStacks },
    { key: "deal", label: "Deal", module: "pipeline", api: () => window.dealPipeline },
    { key: "contact", label: "Contact", module: "people", api: () => window.peopleCards },
    { key: "invoice", label: "Invoice", module: "money", api: () => window.moneyPipeline },
  ];

  let root = null;
  let open = false;

  const ensureStyles = () => {
    if (document.getElementById("crm-quick-add-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-quick-add-styles";
    style.textContent = `
      .crm-quick-add { position: fixed; top: 14px; right: 142px; z-index: 4610; -webkit-app-region: no-drag; }
      .crm-quick-add-button { appearance: none; width: 30px; height: 30px; border: 0; border-radius: 999px;
        display: grid; place-items: center; cursor: pointer; color: #fff; font-size: 20px; line-height: 1;
        background: rgba(12,16,24,0.46); border: 1px solid rgba(255,255,255,0.16);
        -webkit-backdrop-filter: blur(18px) saturate(135%); backdrop-filter: blur(18px) saturate(135%);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.16), 0 10px 28px rgba(0,0,0,0.2); }
      .crm-quick-add-button:hover { background: rgba(255,255,255,0.12); }
      .crm-quick-add-menu { position: absolute; top: 38px; right: 0; min-width: 132px; display: grid; gap: 3px;
        padding: 5px; border-radius: 12px; background: rgba(12,16,24,0.62); border: 1px solid rgba(255,255,255,0.16);
        -webkit-backdrop-filter: blur(18px) saturate(135%); backdrop-filter: blur(18px) saturate(135%);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.14), 0 16px 36px rgba(0,0,0,0.26); }
      .crm-quick-add-menu[hidden] { display: none !important; }
      .crm-quick-add-item { appearance: none; border: 0; border-radius: 8px; padding: 8px 10px; text-align: left;
        background: transparent; color: rgba(255,255,255,0.82); font: inherit; font-size: 12px; font-weight: 750; cursor: pointer; }
      .crm-quick-add-item:hover { color: #fff; background: rgba(255,255,255,0.10); }
      @media (max-width: 900px) { .crm-quick-add { right: 100px; } }
    `;
    document.head.appendChild(style);
  };

  const setOpen = (next) => {
    open = !!next;
    root?.querySelector(".crm-quick-add-button")?.setAttribute("aria-expanded", open ? "true" : "false");
    const menu = root?.querySelector(".crm-quick-add-menu");
    if (menu) menu.hidden = !open;
  };

  const createItem = (key) => {
    const item = ITEMS.find((candidate) => candidate.key === key);
    if (!item) return;
    setOpen(false);
    window.crmWorkspaces?.setActive?.(item.module);
    window.setTimeout(() => {
      const api = item.api();
      if (typeof api?.create === "function") api.create();
      else if (typeof api?.openCreate === "function") api.openCreate();
    }, 220);
  };

  const mount = () => {
    ensureStyles();
    root = document.createElement("div");
    root.className = "crm-quick-add";
    root.innerHTML = `
      <button class="crm-quick-add-button" type="button" aria-label="Quick add" aria-haspopup="menu" aria-expanded="false">+</button>
      <div class="crm-quick-add-menu" role="menu" hidden>
        ${ITEMS.map((item) => `<button class="crm-quick-add-item" type="button" role="menuitem" data-quick-add="${item.key}">${item.label}</button>`).join("")}
      </div>
    `;
    root.addEventListener("click", (event) => {
      const button = event.target.closest(".crm-quick-add-button");
      if (button) {
        setOpen(!open);
        return;
      }
      const item = event.target.closest("[data-quick-add]");
      if (item) createItem(item.dataset.quickAdd);
    });
    document.addEventListener("pointerdown", (event) => {
      if (open && root && !root.contains(event.target)) setOpen(false);
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setOpen(false);
    });
    document.body.appendChild(root);
  };

  const api = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    create: createItem,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
  window.crmQuickAdd = api;
})();
