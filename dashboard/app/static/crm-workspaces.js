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
      /* FIDELITY_ORDER §2: the original's circular glass control, scaled to
         54px and docked at bottom-centre, is the one navigation control. */
      .crm-module-switch { position: fixed; left: 50%; bottom: 18px; z-index: 4600; transform: translateX(-50%);
        width: 54px; height: 54px; -webkit-app-region: no-drag; }
      .crm-home-control { appearance: none; width: 54px; height: 54px; padding: 0; border-radius: 50%;
        border: 1px solid rgba(255,255,255,0.22); cursor: pointer; pointer-events: auto;
        background: linear-gradient(180deg, rgba(22,26,36,0.62), rgba(12,16,24,0.55));
        -webkit-backdrop-filter: blur(26px) saturate(140%); backdrop-filter: blur(26px) saturate(140%);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.24), 0 10px 26px rgba(0,0,0,0.34);
        color: #fff; display: flex; align-items: center; justify-content: center;
        transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease, opacity .25s ease; }
      .crm-home-control:hover { transform: scale(1.08); }
      .crm-home-control svg { width: 22px; height: 22px; fill: none; stroke: currentColor;
        stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
      .crm-home-control.is-active { color: rgba(255,255,255,.64); cursor: default; }
      /* BLUEPRINT A4 / Scene VII: when a next-touch chip lands a card on a day
         the calendar can't show, its shortcut pulses once — the card still
         visibly has somewhere to be. */
      .crm-home-control.crm-pill-pulse { animation: crmPillPulse .7s cubic-bezier(.22, 1, .26, 1); }
      /* BLUEPRINT A5: the flip target lights while an eligible card hovers it. */
      .crm-home-control.crm-pill-drop { color: #fff;
        box-shadow: 0 0 0 2px rgba(125,180,255,0.75), 0 0 18px rgba(90,150,255,0.5); }
      @keyframes crmPillPulse {
        0% { box-shadow: 0 0 0 0 rgba(125,180,255,0.75); color: #fff; }
        100% { box-shadow: 0 0 0 16px rgba(125,180,255,0); }
      }
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
    // The active-module marker goes up FIRST: module render paths (e.g. the
    // Today hand's once-per-day auto-fan) read it to know which surface owns
    // the stage.
    document.body.dataset.crmModule = active;
    // Close the summoned overlays next — they own portaled panels that must
    // cancel before the destination theater takes the stage.
    try { window.crmSearchDeck?.close?.(); } catch {}
    try { window.crmCompanyDive?.setActive?.(false); } catch {}
    MODULES.forEach((module) => {
      const on = module.key === active || (module.key === "today" && active === "calendar");
      try { module.api()?.setActive?.(on); } catch {}
    });
    // FIX_PASS_2 F4: the calendar arrives calm — the riding-along Today hand
    // collapses to its closed pile (which also drops the depth-of-field scrim),
    // so the year grid renders sharp. Fanning is on-demand only.
    if (active === "calendar") {
      try { window.crmToday?.fan?.("left", false); } catch {}
    }
    // Enforce the one-theater invariant: whatever the modules' own setActive
    // logic did (or forgot), exactly the allowed theater roots are visible.
    const allowed = new Set(ALLOWED_THEATERS[active] || [active]);
    document.querySelectorAll("[data-crm-theater]").forEach((el) => {
      el.hidden = !allowed.has(el.dataset.crmTheater);
    });
    // Portaled chrome (card-detail panels, drag flyers) listens for this and
    // closes/cancels — a theater switch never carries another module's UI along.
    document.dispatchEvent(new CustomEvent("crm:theater-switch", { detail: { key: active } }));
    const homeControl = root?.querySelector(".crm-home-control");
    if (homeControl) {
      const isHome = active === "home";
      homeControl.classList.toggle("is-active", isHome);
      homeControl.setAttribute("aria-current", isHome ? "page" : "false");
      homeControl.setAttribute("aria-label", isHome ? "Home — current surface" : "Return Home");
    }
    document.body.dataset.crmModule = active;
  };

  const mount = () => {
    ensureStyles();
    root = document.createElement("div");
    root.className = "crm-module-switch";
    root.setAttribute("aria-label", "Desk navigation");
    root.innerHTML = `<button type="button" class="crm-home-control" data-crm-home-control aria-label="Return Home">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 10.5 12 3.8l8.5 6.7"></path><path d="M5.8 9.3v10.2h12.4V9.3"></path><path d="M9.4 19.5v-5.7h5.2v5.7"></path></svg>
    </button>`;
    root.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-crm-home-control]");
      if (!button) return;
      if (active === "home") return;
      if (window.crmDeskTransit?.driveTo) window.crmDeskTransit.driveTo("home");
      else setActive("home");
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
