// crm-today.js - the dealt Today hand.
(() => {
  const LAST_DEALT_KEY = "crm-today-last-dealt";
  const typeLabels = {
    contacts: "Contact",
    deals: "Deal",
    invoices: "Invoice",
    tasks: "Task",
    calendarItems: "Calendar",
    tickets: "Ticket",
  };
  const reasonLabels = {
    "next-touch": "Next touch",
    "cold-front": "Cold front",
    "contact-touch": "Contact touch",
    "invoice-overdue": "Overdue",
    "invoice-due": "Due today",
    task: "Task",
    calendar: "Scheduled",
  };
  let active = false;
  let root = null;
  let refreshTimer = 0;
  let subscribed = false;

  const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[char]));
  const localDate = (date = new Date()) => {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };
  const recordsFrom = (result) => Array.isArray(result) ? result : ((result && (result.records || result.tickets)) || []);
  const entityBridge = (entity) => ({
    contacts: window.contacts,
    deals: window.deals,
    invoices: window.invoices,
    tickets: window.tickets,
    tasks: window.tasks,
  }[entity] || null);
  const entityDetail = (entity) => ({
    contacts: window.contactDetail,
    deals: window.dealDetail,
    invoices: window.invoiceDetail,
    tickets: window.ticketDetail,
  }[entity] || null);

  const ensureStyles = () => {
    if (document.getElementById("crm-today-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-today-styles";
    style.textContent = `
      .crm-today-surface { position: fixed; inset: 0; z-index: 840; pointer-events: none; overflow: hidden; }
      .crm-today-surface[hidden] { display: none; }
      .crm-today-glow { position: absolute; left: 50%; bottom: 0; width: min(820px, 82vw); height: 230px;
        transform: translateX(-50%); pointer-events: none;
        background: radial-gradient(ellipse at center bottom, rgba(125,180,255,0.20), rgba(125,180,255,0.00) 70%); }
      .crm-today-title { position: fixed; left: 50%; top: 70px; transform: translateX(-50%);
        color: rgba(255,255,255,0.82); font-size: 0.9rem; font-weight: 800; letter-spacing: .02em;
        pointer-events: none; text-shadow: 0 2px 18px rgba(0,0,0,0.35); }
      .crm-today-hand { position: absolute; inset: 0; pointer-events: none; }
      .crm-today-empty { position: fixed; left: 50%; bottom: 120px; transform: translateX(-50%);
        color: rgba(255,255,255,0.58); font-size: 0.88rem; font-weight: 750; pointer-events: none; }
      .crm-today-card { position: absolute; left: 50%; bottom: 30px; width: 185px; height: 279px; box-sizing: border-box;
        border-radius: 16px; padding: 15px 15px 14px; color: #fff; pointer-events: auto; cursor: pointer;
        background-color: #202936;
        background-image: linear-gradient(180deg, rgba(83,95,117,0.42), rgba(33,41,56,0.34));
        border: 1px solid rgba(255,255,255,0.14);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 20px 44px rgba(0,0,0,0.30);
        transform: translateX(calc(-50% + var(--tx, 0px))) translateY(var(--ty, 0px)) rotate(var(--rot, 0deg));
        transform-origin: center bottom;
        transition: transform .18s ease, box-shadow .18s ease; -webkit-app-region: no-drag; }
      .crm-today-card:hover { box-shadow: inset 0 1px 0 rgba(255,255,255,0.22), 0 24px 54px rgba(0,0,0,0.38);
        transform: translateX(calc(-50% + var(--tx, 0px))) translateY(calc(var(--ty, 0px) - 10px)) rotate(var(--rot, 0deg)); }
      .crm-today-card-body { height: 100%; display: flex; flex-direction: column; min-height: 0;
        filter: saturate(calc(1 - (var(--crm-staleness, 0) * .56))) opacity(calc(1 - (var(--crm-staleness, 0) * .22))); }
      .crm-today-card::after { content: ""; position: absolute; inset: 0; pointer-events: none; border-radius: inherit;
        background: rgba(180,190,205, calc(var(--crm-staleness, 0) * .14)); mix-blend-mode: screen; }
      .crm-today-kind { font-size: 0.66rem; font-weight: 800; text-transform: uppercase; letter-spacing: .08em;
        color: rgba(255,255,255,0.46); }
      .crm-today-name { margin-top: 8px; font-size: 1rem; font-weight: 850; line-height: 1.15;
        display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
      .crm-today-meta { margin-top: 8px; font-size: 0.75rem; line-height: 1.35; color: rgba(255,255,255,0.66);
        display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
      .crm-today-reason { margin-top: auto; width: fit-content; border-radius: 999px; padding: 3px 8px;
        font-size: 0.68rem; font-weight: 800; color: rgba(255,255,255,0.72); background: rgba(255,255,255,0.10);
        border: 1px solid rgba(255,255,255,0.10); }
      .crm-today-card[data-entity="invoices"] { background-image: linear-gradient(180deg, rgba(239,68,68,0.28), rgba(33,41,56,0.34)); }
      .crm-today-card[data-entity="deals"] { background-image: linear-gradient(180deg, rgba(249,115,22,0.25), rgba(33,41,56,0.34)); }
      .crm-today-card[data-entity="contacts"] { background-image: linear-gradient(180deg, rgba(83,95,117,0.42), rgba(33,41,56,0.34)); }
      .crm-today-surface.is-dealing .crm-today-card { animation: crm-today-deal .52s cubic-bezier(.22,1,.26,1) both;
        animation-delay: calc(var(--i, 0) * 65ms); }
      @keyframes crm-today-deal {
        from { opacity: 0; transform: translateX(-50%) translateY(280px) rotate(0deg) scale(.86); }
        to { opacity: 1; transform: translateX(calc(-50% + var(--tx, 0px))) translateY(var(--ty, 0px)) rotate(var(--rot, 0deg)) scale(1); }
      }
    `;
    document.head.appendChild(style);
  };

  const ensureRoot = () => {
    if (root) return root;
    ensureStyles();
    root = document.createElement("section");
    root.className = "crm-today-surface";
    root.hidden = true;
    root.innerHTML = `
      <div class="crm-today-glow" aria-hidden="true"></div>
      <div class="crm-today-title">Today</div>
      <div class="crm-today-hand"></div>
      <div class="crm-today-empty" hidden>Desk clear.</div>
    `;
    root.addEventListener("click", (event) => {
      const card = event.target.closest?.(".crm-today-card[data-id]");
      if (card && root.contains(card)) openCard(card);
    });
    document.body.appendChild(root);
    return root;
  };

  const shouldDeal = () => {
    const today = localDate();
    if (localStorage.getItem(LAST_DEALT_KEY) === today) return false;
    localStorage.setItem(LAST_DEALT_KEY, today);
    return true;
  };

  const summaryPayload = async () => {
    try {
      const response = await window.crmReportsApi?.summary?.();
      if (response?.ok && response.summary) return response.summary;
    } catch {}
    return { datasets: { todayHand: [] } };
  };

  const cardMeta = (row) => {
    const parts = [];
    if (row.dueDate) parts.push(row.dueDate);
    if (row.stageLabel) parts.push(row.stageLabel);
    if (row.amountValue || row.amount) parts.push(row.amount || row.amountValue);
    if (row.state && !row.stageLabel) parts.push(row.state);
    return parts.join(" · ");
  };

  const cardHTML = (row, index, count) => {
    const mid = (count - 1) / 2;
    const spread = Math.max(34, Math.min(58, 420 / Math.max(1, count)));
    const delta = index - mid;
    const tx = Math.round(delta * spread);
    const ty = Math.round(Math.abs(delta) * 8);
    const rot = Math.max(-14, Math.min(14, delta * 4.2));
    const staleness = Number(row.staleness || 0);
    return `<button type="button" class="crm-today-card" data-entity="${esc(row.entity || row.type || "")}" data-id="${esc(row.id || "")}"
        style="--i:${index}; --tx:${tx}px; --ty:${ty}px; --rot:${rot.toFixed(2)}deg; --crm-staleness:${Math.max(0, Math.min(1, staleness)).toFixed(3)}">
      <div class="crm-today-card-body">
        <div class="crm-today-kind">${esc(typeLabels[row.entity] || typeLabels[row.type] || row.entity || row.type || "Card")}</div>
        <div class="crm-today-name">${esc(row.title || "Untitled")}</div>
        <div class="crm-today-meta">${esc(cardMeta(row))}</div>
        <div class="crm-today-reason">${esc(reasonLabels[row.reason] || row.reason || "Today")}</div>
      </div>
    </button>`;
  };

  const render = async ({ deal = false } = {}) => {
    if (!active || !root) return;
    const summary = await summaryPayload();
    const rows = (summary.datasets?.todayHand || []).slice(0, 9);
    const hand = root.querySelector(".crm-today-hand");
    const empty = root.querySelector(".crm-today-empty");
    if (!hand || !empty) return;
    hand.innerHTML = rows.map((row, index) => cardHTML(row, index, rows.length)).join("");
    empty.hidden = rows.length > 0;
    root.classList.toggle("is-dealing", !!deal && rows.length > 0);
    if (deal) setTimeout(() => root?.classList.remove("is-dealing"), 1100);
  };

  const recordById = async (entity, id) => {
    const bridge = entityBridge(entity);
    if (!bridge?.list || !id) return null;
    try {
      const result = await bridge.list({ includeDeleted: true });
      return recordsFrom(result).find((record) => String(record.id || "") === String(id)) || null;
    } catch {
      return null;
    }
  };

  const openCard = async (card) => {
    const entity = card.dataset.entity || "";
    const detail = entityDetail(entity);
    if (!detail?.open) return;
    const record = await recordById(entity, card.dataset.id || "");
    if (record) detail.open(record, card);
  };

  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => render(), 140);
  };

  const subscribe = () => {
    if (subscribed) return;
    subscribed = true;
    try { window.crmStore?.onChanged?.(scheduleRefresh); } catch {}
    try { window.tickets?.onChanged?.(scheduleRefresh); } catch {}
  };

  const setActive = (on) => {
    active = !!on;
    ensureRoot();
    subscribe();
    root.hidden = !active;
    if (active) render({ deal: shouldDeal() });
    return api;
  };

  const api = {
    setActive,
    isActive: () => active,
    refresh: () => render({ deal: false }),
  };

  window.crmToday = api;
})();
