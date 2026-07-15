// crm-record-world.js — a compact, source-anchored record menu.
(() => {
  let root = null;
  let current = null;
  let anchorRect = null;
  let returnFocus = null;

  const esc = (value) => String(value ?? "").replace(/[&<>\"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[character]));
  const first = (...values) => values.map((value) => String(value ?? "").trim()).find(Boolean) || "";
  const meta = (record) => record?.meta && typeof record.meta === "object" ? record.meta : {};
  const value = (record, key) => record?.[key] ?? meta(record)[key];
  const title = (record) => first(
    value(record, "name"), value(record, "title"), value(record, "vendor"), value(record, "client"),
    value(record, "number"), value(record, "reference"), record?.companyLabel, record?.id, "Untitled",
  );
  const entityLabel = (entity) => ({
    contacts: "Person", companies: "Company", deals: "Deal", jobs: "Job", cases: "Case",
    tickets: "Ticket", bills: "Bill", invoices: "Invoice", tasks: "Task", calendarItems: "Event",
  }[entity] || "Record");
  const getRecord = async (entity, id) => (await window.crmStore?.get?.(entity, id))?.record || null;
  const isTicketEntity = (entity) => ["ticket", "tickets", "case", "cases"].includes(String(entity || "").trim().toLowerCase());

  function ensureStyles() {
    if (document.getElementById("crm-record-world-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-record-world-styles";
    style.textContent = `
      .record-world-shell{position:fixed;inset:0;z-index:7200;display:block;background:transparent;-webkit-backdrop-filter:none;backdrop-filter:none;-webkit-app-region:no-drag}
      .record-world-shell[hidden]{display:none}
      .record-world{position:fixed;width:min(292px,calc(100vw - 28px));max-height:min(420px,calc(100vh - 118px));overflow:hidden;display:grid;grid-template-rows:auto minmax(0,1fr);color:#fff}
      .record-world-head{min-height:52px;display:flex;align-items:center;gap:9px;padding:9px 9px 8px 12px}
      .record-world-heading{min-width:0;flex:1}.record-world-kicker{font-size:8px;letter-spacing:.1em;text-transform:uppercase;color:rgba(210,222,240,.43)}
      .record-world-title{margin-top:4px;font:680 14px/1.15 system-ui,sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .record-world-close.crm-menu-action{width:28px!important;min-width:28px!important;height:28px!important;padding:0!important;text-align:center!important;font-size:16px!important}
      .record-world-body{min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 7px 8px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}
      .record-world-facts{display:grid;gap:1px;padding:3px 0 6px}.record-world-fact{min-height:31px;display:grid;grid-template-columns:66px minmax(0,1fr);gap:8px;align-items:center;padding:4px 7px!important}
      .record-world-fact-label{font-size:9px;color:rgba(217,225,239,.38)}.record-world-fact-value{font-size:10px;color:rgba(245,247,251,.76);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .record-world-actions{display:grid;gap:1px;padding-top:6px;border-top:1px solid rgba(255,255,255,.07)}
      .record-world-action.crm-menu-action{width:100%;min-height:31px!important;padding:0 7px!important;text-align:left!important;font-size:.7rem!important}
      .record-world-editor{display:grid;gap:7px;margin-top:6px;padding:7px!important}.record-world-editor[hidden]{display:none}
      .record-world-editor textarea{min-height:58px;resize:vertical}.record-world-editor-actions{display:flex;justify-content:flex-end;gap:3px}
      .record-world-editor-actions .crm-menu-action{min-height:28px!important;padding:0 7px!important;font-size:.68rem!important}
      .record-world-empty{padding:18px 12px;color:rgba(221,229,242,.42);font-size:10px;line-height:1.45}
      @media(max-width:600px){.record-world{width:calc(100vw - 28px);max-height:calc(100vh - 112px)}}
    `;
    document.head.appendChild(style);
  }

  const displayValue = (label, raw) => {
    if (label !== "Due") return String(raw);
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? new Date(parsed).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : String(raw);
  };
  function factsHTML(record, entity) {
    const candidates = [
      ["Company", value(record, "company") || value(record, "companyName")],
      ["Role", value(record, "role")],
      ["Email", value(record, "email")],
      ["Phone", value(record, "phone")],
      ["Status", value(record, "state") || value(record, "status")],
      ["Owner", value(record, "assignee") || value(record, "owner")],
      ["Value", value(record, "amount") || value(record, "value")],
      ["Due", value(record, "dueDate") || value(record, "dueAt")],
    ].filter(([, fact]) => fact !== undefined && fact !== null && fact !== "").slice(0, 4);
    if (!candidates.length) candidates.push([entityLabel(entity), record?.id || "No details"]);
    return candidates.map(([label, fact]) => `<div class="record-world-fact crm-menu-item"><span class="record-world-fact-label">${esc(label)}</span><span class="record-world-fact-value" title="${esc(displayValue(label, fact))}">${esc(displayValue(label, fact))}</span></div>`).join("");
  }

  function render(data) {
    current = data;
    const record = data.record || { id: data.id };
    root.innerHTML = `<article class="record-world crm-menu-surface" role="dialog" aria-modal="false" aria-label="${esc(title(record))}">
      <header class="record-world-head"><div class="record-world-heading"><div class="record-world-kicker">${esc(entityLabel(data.entity))}</div><div class="record-world-title">${esc(title(record))}</div></div><button class="record-world-close crm-menu-action" type="button" data-record-close aria-label="Close">×</button></header>
      <div class="record-world-body"><div class="record-world-facts">${factsHTML(record, data.entity)}</div>
        <div class="record-world-actions">
          ${data.entity === "contacts" ? '<button class="record-world-action crm-menu-action" type="button" data-record-history>Conversation history</button>' : ""}
          <button class="record-world-action crm-menu-action" type="button" data-record-compose="note">Add note</button>
          <button class="record-world-action crm-menu-action" type="button" data-record-compose="follow-up">New follow-up</button>
        </div>
        <form class="record-world-editor crm-menu-item" data-record-editor="note" hidden><textarea class="crm-menu-input" name="content" placeholder="Add a note" aria-label="Note" required></textarea><div class="record-world-editor-actions"><button class="crm-menu-action" type="button" data-record-cancel>Cancel</button><button class="crm-menu-action" type="submit">Add</button></div></form>
        <form class="record-world-editor crm-menu-item" data-record-editor="follow-up" hidden><input class="crm-menu-input" name="title" placeholder="Follow-up" aria-label="Follow-up" required><input class="crm-menu-input" name="dueAt" type="datetime-local" aria-label="Due date"><div class="record-world-editor-actions"><button class="crm-menu-action" type="button" data-record-cancel>Cancel</button><button class="crm-menu-action" type="submit">Create</button></div></form>
      </div></article>`;
    window.crmInterfaceParity?.scan?.(root);
    placeWorld();
  }

  function placeWorld() {
    const panel = root?.querySelector(".record-world");
    if (!panel) return;
    requestAnimationFrame(() => {
      if (!panel.isConnected || root.hidden) return;
      const bounds = panel.getBoundingClientRect();
      const edge = 14; const topEdge = 62; const bottomEdge = 76; const gap = 10;
      let left = innerWidth - bounds.width - 42;
      let top = topEdge;
      if (anchorRect) {
        const right = anchorRect.right + gap;
        const leftSide = anchorRect.left - gap - bounds.width;
        left = right + bounds.width <= innerWidth - edge ? right : leftSide >= edge ? leftSide : Math.max(edge, Math.min(innerWidth - bounds.width - edge, anchorRect.left));
        top = Math.max(topEdge, Math.min(innerHeight - bounds.height - bottomEdge, anchorRect.top));
      }
      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(top)}px`;
    });
  }

  async function openWorld(entity, id, sourceElement) {
    if (!root) mount();
    const source = sourceElement?.getBoundingClientRect?.();
    anchorRect = source ? { left: source.left, right: source.right, top: source.top, bottom: source.bottom } : null;
    returnFocus = sourceElement?.isConnected ? sourceElement : document.activeElement;
    root.hidden = false;
    root.innerHTML = '<article class="record-world crm-menu-surface"><div class="record-world-empty">Loading…</div></article>';
    placeWorld();
    render({ entity, id, record: await getRecord(entity, id) });
    return true;
  }
  async function open(entity, id, sourceElement) {
    if (isTicketEntity(entity) && window.ticketStacks?.open) {
      const opened = await window.ticketStacks.open(id, sourceElement);
      if (opened) { close(); return true; }
    }
    return openWorld(entity, id, sourceElement);
  }
  async function refresh() {
    if (!current) return false;
    render({ ...current, record: await getRecord(current.entity, current.id) });
    return true;
  }
  function close() {
    if (!root || root.hidden) return;
    root.hidden = true;
    current = null;
    anchorRect = null;
    if (returnFocus?.isConnected) returnFocus.focus?.({ preventScroll: true });
    returnFocus = null;
  }

  function mount() {
    if (root) return root;
    ensureStyles();
    root = document.createElement("div");
    root.className = "record-world-shell";
    root.hidden = true;
    document.body.appendChild(root);
    [["contactDetail", "contacts"], ["dealDetail", "deals"], ["invoiceDetail", "invoices"]].forEach(([name, entity]) => {
      const legacy = window[name];
      if (!legacy) return;
      legacy.open = (record, sourceElement) => openWorld(entity, record?.id, sourceElement);
      legacy.close = close;
      legacy.isOpen = () => !!root && !root.hidden;
    });
    root.addEventListener("click", async (event) => {
      if (event.target === root || event.target.closest("[data-record-close]")) return close();
      const history = event.target.closest("[data-record-history]");
      if (history && current?.entity === "contacts") {
        const pending = window.crmPersonHistory?.open?.(current.id, history);
        close();
        await pending;
        return;
      }
      const compose = event.target.closest("[data-record-compose]");
      if (compose) {
        root.querySelectorAll("[data-record-editor]").forEach((form) => { form.hidden = form.dataset.recordEditor !== compose.dataset.recordCompose; });
        const form = root.querySelector(`[data-record-editor="${compose.dataset.recordCompose}"]`);
        form?.querySelector("input,textarea")?.focus();
        placeWorld();
        return;
      }
      const cancel = event.target.closest("[data-record-cancel]");
      if (cancel) { cancel.closest("form").hidden = true; placeWorld(); }
    });
    root.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!current) return;
      const form = event.target;
      const fields = new FormData(form);
      if (form.dataset.recordEditor === "note") {
        const content = String(fields.get("content") || "").trim();
        if (!content) return;
        await window.crmDomain.create("activities", { kind: "note", content, occurredAt: new Date().toISOString(), links: [{ entityType: current.entity, recordId: current.id }] });
      } else if (form.dataset.recordEditor === "follow-up") {
        const followUp = String(fields.get("title") || "").trim();
        if (!followUp) return;
        const due = String(fields.get("dueAt") || "");
        await window.crmDomain.create("commitments", { title: followUp, kind: "follow-up", dueAt: due ? new Date(due).toISOString() : null, links: [{ entityType: current.entity, recordId: current.id }] });
      }
      close();
    });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !root.hidden) close(); });
    return root;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true }); else mount();
  window.crmRecordWorld = { open, close, isOpen: () => !!root && !root.hidden, refresh };
})();
