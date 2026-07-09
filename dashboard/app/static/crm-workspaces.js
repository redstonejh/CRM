// crm-workspaces.js - small module switch for overlay CRM card systems.
(() => {
  const MODULES = [
    { key: "home", label: "Home", api: () => window.crmHome },
    { key: "today", label: "Today", api: () => window.crmToday },
    { key: "tickets", label: "Tickets", api: () => window.ticketStacks },
    { key: "people", label: "People", api: () => window.peopleCards },
    { key: "pipeline", label: "Pipeline", api: () => window.dealPipeline },
    { key: "money", label: "Money", api: () => window.moneyPipeline },
    { key: "calendar", label: "Calendar", api: () => window.fractalCalendar },
    { key: "reports", label: "Reports", api: () => window.crmReports },
  ];
  const STORE_KEY = "crm-active-module";
  let active = localStorage.getItem(STORE_KEY) || "home";
  let root = null;

  const ensureStyles = () => {
    if (document.getElementById("crm-workspace-switch-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-workspace-switch-styles";
    style.textContent = `
      .crm-module-switch { position: fixed; left: 50%; top: 14px; z-index: 4600; transform: translateX(-50%);
        display: inline-flex; gap: 4px; padding: 4px; border-radius: 999px;
        background: rgba(12,16,24,0.42); border: 1px solid rgba(255,255,255,0.16);
        -webkit-backdrop-filter: blur(18px) saturate(135%); backdrop-filter: blur(18px) saturate(135%);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.16), 0 10px 28px rgba(0,0,0,0.2);
        -webkit-app-region: no-drag; }
      .crm-module-switch button { appearance: none; border: 0; border-radius: 999px; padding: 5px 12px;
        background: transparent; color: rgba(255,255,255,0.58); font: inherit; font-size: 12px; font-weight: 700;
        line-height: 1; cursor: pointer; transition: color .15s ease, background .15s ease; }
      .crm-module-switch button:hover { color: rgba(255,255,255,0.86); }
      .crm-module-switch button.is-active { color: #fff; background: rgba(255,255,255,0.12); }
    `;
    document.head.appendChild(style);
  };

  // Which theaters may be visible on each surface. The Today hand rides along on
  // the Calendar surface (cards are dragged onto days); everything else is
  // strictly one theater per surface. Summoned overlays (search deck, company
  // dive) are never allowed to survive a switch — they must re-open on demand.
  const ALLOWED_THEATERS = {
    home: ["home"],
    today: ["today"],
    tickets: ["tickets"],
    people: ["people"],
    pipeline: ["pipeline"],
    money: ["money"],
    calendar: ["calendar", "today"],
    reports: ["reports"],
  };

  const setActive = (key) => {
    active = MODULES.some((m) => m.key === key) ? key : "home";
    localStorage.setItem(STORE_KEY, active);
    // Close the summoned overlays FIRST — they own portaled panels that must
    // cancel before the destination theater takes the stage.
    try { window.crmSearchDeck?.close?.(); } catch {}
    try { window.crmCompanyDive?.setActive?.(false); } catch {}
    MODULES.forEach((module) => {
      const on = module.key === active || (module.key === "today" && active === "calendar");
      try { module.api()?.setActive?.(on); } catch {}
    });
    // Enforce the one-theater invariant: whatever the modules' own setActive
    // logic did (or forgot), exactly the allowed theater roots are visible.
    const allowed = new Set(ALLOWED_THEATERS[active] || [active]);
    document.querySelectorAll("[data-crm-theater]").forEach((el) => {
      el.hidden = !allowed.has(el.dataset.crmTheater);
    });
    // Portaled chrome (card-detail panels, drag flyers) listens for this and
    // closes/cancels — a theater switch never carries another module's UI along.
    document.dispatchEvent(new CustomEvent("crm:theater-switch", { detail: { key: active } }));
    root?.querySelectorAll("button[data-crm-module]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.crmModule === active);
      button.setAttribute("aria-pressed", button.dataset.crmModule === active ? "true" : "false");
    });
    document.body.dataset.crmModule = active;
  };

  const mount = () => {
    ensureStyles();
    root = document.createElement("div");
    root.className = "crm-module-switch";
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", "CRM module");
    root.innerHTML = MODULES.map((module) => (
      `<button type="button" data-crm-module="${module.key}" aria-pressed="false">${module.label}</button>`
    )).join("");
    root.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-crm-module]");
      if (button) setActive(button.dataset.crmModule);
    });
    document.body.appendChild(root);
    setActive(active);
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
  window.crmWorkspaces = {
    setActive,
    active: () => active,
    modules: () => MODULES.map((module) => ({ key: module.key, label: module.label })),
  };
})();
