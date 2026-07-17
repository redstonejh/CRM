// crm-card-date.js — one compact calendar affordance shared by every card face.
(() => {
  const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[character]));
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
  const html = (value, options = {}) => {
    const date = asDate(value); if (!date) return "";
    const iso = dateOnly(value); const month = date.toLocaleDateString([], { month:"short" }).replace(/\.$/, ""); const day = String(date.getDate());
    const label = String(options.label || `Open ${date.toLocaleDateString([], { month:"long", day:"numeric", year:"numeric" })} in Calendar`);
    const extra = String(options.className || "").trim();
    return `<span class="crm-card-date${extra ? ` ${esc(extra)}` : ""}" data-crm-card-date="${esc(iso)}" role="button" tabindex="0" aria-label="${esc(label)}" title="${esc(label)}"><span class="crm-card-date-rings" aria-hidden="true"></span><span class="crm-card-date-month" aria-hidden="true">${esc(month)}</span><span class="crm-card-date-day" aria-hidden="true">${esc(day)}</span></span>`;
  };
  const open = (value) => {
    const date = asDate(value); if (!date) return false;
    window.crmWorkspaces?.setActive?.("calendar");
    let attempts = 0;
    const reveal = () => {
      attempts += 1; window.fractalCalendar?.openMonthFor?.(date);
      if (window.fractalCalendar?.level?.() !== 1 && attempts < 12) setTimeout(reveal, 120);
    };
    // Workspace activation is synchronous. Seat the month in the same task as
    // the click so a busy main thread cannot leave Calendar exposed at its
    // year root while a deferred frame waits behind unrelated rendering.
    reveal();
    return true;
  };
  const ensureStyles = () => {
    if (document.getElementById("crm-card-date-styles")) return;
    const style = document.createElement("style"); style.id = "crm-card-date-styles"; style.textContent = `
      .crm-card-date{appearance:none;position:absolute;z-index:9;top:20px;right:12px;width:34px;height:32px;padding:7px 2px 2px;border:1px solid rgba(255,255,255,.23);border-radius:7px;background:rgba(8,13,21,.14);color:rgba(255,255,255,.76);display:grid;grid-template-rows:8px 1fr;place-items:center;overflow:visible;cursor:pointer;box-shadow:inset 0 1px rgba(255,255,255,.09);font:700 var(--crm-type-micro,9px)/1 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;transition:color .14s ease,background .14s ease,border-color .14s ease,transform .14s ease;-webkit-app-region:no-drag}
      .crm-card-date:before{content:"";position:absolute;left:-1px;right:-1px;top:6px;height:1px;background:rgba(255,255,255,.2)}.crm-card-date-rings:before,.crm-card-date-rings:after{content:"";position:absolute;top:-3px;width:2px;height:7px;border-radius:2px;background:currentColor;opacity:.72}.crm-card-date-rings:before{left:8px}.crm-card-date-rings:after{right:8px}
      .crm-card-date-month{max-width:28px;overflow:hidden;text-overflow:clip;text-transform:uppercase;font-size:7px;letter-spacing:.06em;opacity:.58}.crm-card-date-day{align-self:start;font-size:11px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
      .crm-card-date:hover,.crm-card-date:focus-visible{outline:0;color:#fff;background:rgba(255,255,255,.11);border-color:rgba(255,255,255,.38);transform:translateY(-1px)}.crm-card-date:active{transform:translateY(0)}
      .crm-object-small .crm-card-date{top:17px;right:9px;transform:scale(.82);transform-origin:top right}.crm-object-small .crm-card-date:hover,.crm-object-small .crm-card-date:focus-visible{transform:translateY(-1px) scale(.82)}
      .td-flyer .crm-card-date{pointer-events:none!important}
    `; document.head.appendChild(style);
  };
  const targetOf = (event) => event.target?.closest?.("[data-crm-card-date]");
  document.addEventListener("pointerdown", (event) => { if (targetOf(event)) event.stopPropagation(); }, true);
  document.addEventListener("click", (event) => {
    const target = targetOf(event); if (!target) return;
    event.preventDefault(); event.stopImmediatePropagation(); open(target.dataset.crmCardDate);
  }, true);
  document.addEventListener("keydown", (event) => {
    const target = targetOf(event); if (!target || !["Enter", " "].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation(); open(target.dataset.crmCardDate);
  }, true);
  ensureStyles();
  window.crmCardDate = { html, open, dateOnly, asDate };
})();
