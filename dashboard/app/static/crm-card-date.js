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
      .crm-viewport-date{appearance:none;box-sizing:border-box;position:fixed;z-index:9400;left:50%;top:14px;translate:-50% 0;width:58px;height:52px;padding:11px 4px 4px;border:1px solid rgba(225,237,252,.2);border-radius:15px;background:linear-gradient(160deg,rgba(28,37,51,.68),rgba(10,16,25,.56));color:rgba(245,249,255,.84);display:grid;grid-template-rows:11px 1fr;place-items:center;cursor:pointer;box-shadow:inset 0 1px rgba(255,255,255,.14),0 16px 30px -22px rgba(0,0,0,.8);-webkit-backdrop-filter:blur(22px) saturate(132%);backdrop-filter:blur(22px) saturate(132%);font:700 var(--crm-type-micro,9px)/1 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;transition:color .16s ease,background .16s ease,border-color .16s ease,translate .16s ease,box-shadow .16s ease;-webkit-app-region:no-drag}
      .crm-viewport-date[hidden]{display:none}
      .crm-viewport-date:before{content:"";position:absolute;left:-1px;right:-1px;top:13px;height:1px;background:rgba(225,237,252,.16)}
      .crm-viewport-date-rings:before,.crm-viewport-date-rings:after{content:"";position:absolute;top:-4px;width:2px;height:9px;border-radius:2px;background:currentColor;opacity:.58}.crm-viewport-date-rings:before{left:13px}.crm-viewport-date-rings:after{right:13px}
      .crm-viewport-date-month{text-transform:uppercase;font-size:8px;letter-spacing:.1em;opacity:.62}.crm-viewport-date-day{align-self:start;font-size:19px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.04em}
      .crm-viewport-date:hover,.crm-viewport-date:focus-visible{outline:0;color:#fff;background:linear-gradient(160deg,rgba(37,49,67,.76),rgba(13,21,32,.64));border-color:rgba(225,237,252,.34);translate:-50% -2px;box-shadow:inset 0 1px rgba(255,255,255,.18),0 18px 34px -22px rgba(0,0,0,.88)}.crm-viewport-date:active{translate:-50% 0}
    `; document.head.appendChild(style);
  };
  const syncFace = (button, date = new Date()) => {
    if (!button) return;
    button.querySelector(".crm-viewport-date-month").textContent = date.toLocaleDateString([], { month:"short" }).replace(/\.$/, "");
    button.querySelector(".crm-viewport-date-day").textContent = String(date.getDate());
    const fullDate = date.toLocaleDateString([], { weekday:"long", month:"long", day:"numeric", year:"numeric" });
    button.title = fullDate;
    button.setAttribute("aria-label", `Open calendar for ${fullDate}`);
  };
  const syncVisibility = (button = document.querySelector(".crm-viewport-date"), key = document.body?.dataset?.crmModule || "home") => {
    if (!button) return false;
    button.hidden = key === "home";
    return !button.hidden;
  };
  const mount = () => {
    let button = document.querySelector(".crm-viewport-date");
    if (!button) {
      button = document.createElement("button");
      button.type = "button"; button.className = "crm-viewport-date"; button.setAttribute("aria-label", "Open Calendar");
      button.hidden = true;
      button.innerHTML = '<span class="crm-viewport-date-rings" aria-hidden="true"></span><span class="crm-viewport-date-month" aria-hidden="true"></span><span class="crm-viewport-date-day" aria-hidden="true"></span>';
      button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); open(new Date()); });
      document.body.appendChild(button);
    }
    syncFace(button);
    syncVisibility(button);
    return button;
  };

  ensureStyles();
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount, { once:true });
  document.addEventListener("crm:theater-switch", (event) => syncVisibility(document.querySelector(".crm-viewport-date"), event.detail?.key || "home"));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { const button = document.querySelector(".crm-viewport-date"); syncFace(button); syncVisibility(button); } });
  window.crmCardDate = { html, open, dateOnly, asDate, mount, syncVisibility };
})();
