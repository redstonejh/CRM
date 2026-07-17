// crm-card-date.js — one quiet, global calendar affordance.
(() => {
  const dateOnly = (value) => {
    const raw = String(value || "").trim();
    if (value == null || !raw) return "";
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
    if (match) return match[1];
    const parsed = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(parsed.getTime())) return "";
    const pad = (part) => String(part).padStart(2, "0");
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
  };
  const asDate = (value) => {
    const iso = dateOnly(value); if (!iso) return null;
    const date = new Date(`${iso}T12:00:00`); return Number.isFinite(date.getTime()) ? date : null;
  };

  // Compatibility no-op while card renderers migrate. Dates remain card data,
  // but navigation belongs to the single viewport-level control below.
  const html = () => "";
  const open = (value = new Date()) => {
    const date = asDate(value) || new Date();
    window.crmWorkspaces?.setActive?.("calendar");
    let attempts = 0;
    const reveal = () => {
      attempts += 1;
      window.fractalCalendar?.openMonthFor?.(date);
      if (window.fractalCalendar?.level?.() !== 1 && attempts < 12) setTimeout(reveal, 120);
    };
    reveal();
    return true;
  };

  const ensureStyles = () => {
    if (document.getElementById("crm-viewport-date-styles")) return;
    const style = document.createElement("style"); style.id = "crm-viewport-date-styles"; style.textContent = `
      .crm-viewport-date{appearance:none;position:fixed;z-index:9400;left:50%;top:9px;translate:-50% 0;width:38px;height:36px;padding:8px 2px 2px;border:1px solid rgba(255,255,255,.16);border-radius:10px;background:linear-gradient(180deg,rgba(23,29,40,.5),rgba(10,15,23,.38));color:rgba(240,246,255,.72);display:grid;grid-template-rows:8px 1fr;place-items:center;cursor:pointer;box-shadow:inset 0 1px rgba(255,255,255,.1),0 8px 22px rgba(0,0,0,.12);-webkit-backdrop-filter:blur(18px) saturate(125%);backdrop-filter:blur(18px) saturate(125%);font:700 var(--crm-type-micro,9px)/1 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;transition:color .14s ease,background .14s ease,border-color .14s ease,translate .14s ease;-webkit-app-region:no-drag}
      .crm-viewport-date:before{content:"";position:absolute;left:-1px;right:-1px;top:8px;height:1px;background:rgba(255,255,255,.14)}
      .crm-viewport-date-rings:before,.crm-viewport-date-rings:after{content:"";position:absolute;top:-3px;width:2px;height:7px;border-radius:2px;background:currentColor;opacity:.66}.crm-viewport-date-rings:before{left:9px}.crm-viewport-date-rings:after{right:9px}
      .crm-viewport-date-month{text-transform:uppercase;font-size:7px;letter-spacing:.08em;opacity:.58}.crm-viewport-date-day{align-self:start;font-size:12px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
      .crm-viewport-date:hover,.crm-viewport-date:focus-visible{outline:0;color:#fff;background:linear-gradient(180deg,rgba(34,43,58,.62),rgba(15,21,31,.5));border-color:rgba(255,255,255,.3);translate:-50% -1px}.crm-viewport-date:active{translate:-50% 0}
    `; document.head.appendChild(style);
  };
  const syncFace = (button, date = new Date()) => {
    if (!button) return;
    button.querySelector(".crm-viewport-date-month").textContent = date.toLocaleDateString([], { month:"short" }).replace(/\.$/, "");
    button.querySelector(".crm-viewport-date-day").textContent = String(date.getDate());
    button.title = date.toLocaleDateString([], { weekday:"long", month:"long", day:"numeric", year:"numeric" });
  };
  const mount = () => {
    let button = document.querySelector(".crm-viewport-date");
    if (!button) {
      button = document.createElement("button");
      button.type = "button"; button.className = "crm-viewport-date"; button.setAttribute("aria-label", "Open Calendar");
      button.innerHTML = '<span class="crm-viewport-date-rings" aria-hidden="true"></span><span class="crm-viewport-date-month" aria-hidden="true"></span><span class="crm-viewport-date-day" aria-hidden="true"></span>';
      button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); open(new Date()); });
      document.body.appendChild(button);
    }
    syncFace(button);
    return button;
  };

  ensureStyles();
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount, { once:true });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncFace(document.querySelector(".crm-viewport-date")); });
  window.crmCardDate = { html, open, dateOnly, asDate, mount };
})();
