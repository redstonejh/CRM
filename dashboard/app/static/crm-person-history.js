// crm-person-history.js — a compact, source-anchored conversation menu.
(() => {
  let root = null;
  let current = null;
  let currentId = "";
  let anchorRect = null;
  let returnFocus = null;
  let refreshTimer = 0;

  const esc = (value) => String(value ?? "").replace(/[&<>\"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[character]));
  const first = (...values) => values.map((value) => String(value ?? "").trim()).find(Boolean) || "";
  const rows = (result) => result?.records || result?.tickets || [];
  const meta = (record) => record?.meta && typeof record.meta === "object" ? record.meta : {};
  const value = (record, key) => record?.[key] ?? meta(record)[key];
  const nameOf = (person) => first(value(person, "name"), value(person, "title"), value(person, "client"), person?.id, "Unknown person");
  const dateMs = (raw) => {
    const parsed = typeof raw === "number" ? raw : Date.parse(String(raw || ""));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const contactLinked = (record, id) => {
    const wanted = String(id);
    if (String(record?.contactId || "") === wanted) return true;
    if (Array.isArray(record?.contactIds) && record.contactIds.some((item) => String(item) === wanted)) return true;
    if (Array.isArray(record?.relatedContactIds) && record.relatedContactIds.some((item) => String(item) === wanted)) return true;
    return (record?.relatedIds || []).some?.((item) => {
      if (typeof item === "string") return item === `contacts:${wanted}` || item === `contacts/${wanted}`;
      return String(item?.entity || item?.entityType || "") === "contacts" && String(item?.id || item?.recordId || "") === wanted;
    }) || false;
  };
  const channelOf = (event) => {
    const kind = String(event?.kind || "note").toLowerCase();
    if (["email", "message", "sms", "chat"].includes(kind)) return "messages";
    if (["call", "phone"].includes(kind)) return "calls";
    if (["meeting", "visit", "demo"].includes(kind)) return "meetings";
    if (kind === "system") return "system";
    return "notes";
  };
  const eventOf = (record, source = "interaction") => ({
    id: String(record?.id || `${source}-${Math.random()}`),
    source,
    kind: first(record?.kind, record?.type, record?.action, source === "system" ? "system" : "note").toLowerCase(),
    occurredAt: first(record?.at, record?.occurredAt, record?.createdAt, record?.updatedAt),
    actor: first(record?.actor, record?.by, record?.owner),
    direction: first(record?.direction, record?.disposition).toLowerCase(),
    content: first(record?.note, record?.content, record?.description, record?.summary, record?.detail, record?.subject, record?.action),
  });
  const relative = (raw) => {
    const milliseconds = dateMs(raw);
    if (!milliseconds) return "";
    const delta = Math.max(0, Date.now() - milliseconds);
    if (delta < 60000) return "now";
    if (delta < 3600000) return `${Math.floor(delta / 60000)}m`;
    if (delta < 86400000) return `${Math.floor(delta / 3600000)}h`;
    if (delta < 604800000) return `${Math.floor(delta / 86400000)}d`;
    return new Date(milliseconds).toLocaleDateString([], { month: "short", day: "numeric" });
  };

  function ensureStyles() {
    if (document.getElementById("crm-person-history-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-person-history-styles";
    style.textContent = `
      .crm-person-history-shell{position:fixed;inset:0;z-index:7350;display:block;background:transparent;-webkit-backdrop-filter:none;backdrop-filter:none;-webkit-app-region:no-drag}
      .crm-person-history-shell[hidden]{display:none}
      .crm-person-history{position:fixed;width:min(354px,calc(100vw - 28px));max-height:min(540px,calc(100vh - 118px));overflow:hidden;display:grid;grid-template-rows:auto minmax(0,1fr) auto;color:#fff}
      .crm-person-history-head{min-height:54px;display:flex;align-items:center;gap:9px;padding:9px 9px 8px 12px!important}
      .crm-person-history-heading{min-width:0;flex:1}.crm-person-history-kicker{font-size:var(--crm-type-micro,9px);letter-spacing:.1em;text-transform:uppercase;color:rgba(210,222,240,.43)}
      .crm-person-history-title{margin-top:4px;font:680 var(--crm-type-object,14px)/1.15 system-ui,sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .crm-person-history-close.crm-menu-action{width:28px!important;min-width:28px!important;height:28px!important;padding:0!important;text-align:center!important;font-size:16px!important}
      .crm-person-history-thread{min-height:0;overflow-y:auto;display:grid;align-content:start;gap:1px;padding:2px 7px 7px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}
      .crm-person-history-event{position:relative;min-height:45px;padding:7px 35px 8px 11px!important}
      .crm-person-history-event:before{content:"";position:absolute;left:3px;top:11px;bottom:11px;width:2px;border-radius:2px;background:rgba(134,180,241,.4)}
      .crm-person-history-event-kind{font-size:var(--crm-type-micro,9px);font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:rgba(190,211,241,.48)}
      .crm-person-history-event-content{margin-top:4px;font-size:var(--crm-type-caption,11px);line-height:1.4;color:rgba(242,245,250,.72);white-space:pre-wrap;overflow-wrap:anywhere}
      .crm-person-history-event-when{position:absolute;right:7px;top:8px;font-size:var(--crm-type-micro,9px);color:rgba(215,225,239,.34)}
      .crm-person-history-event-direction{margin-left:6px;font-size:var(--crm-type-micro,9px);color:rgba(215,225,239,.3)}
      .crm-person-history-empty{padding:18px 12px;color:rgba(221,229,242,.42);font-size:var(--crm-type-caption,11px);line-height:1.45}
      .crm-person-history-foot{display:grid;gap:1px;padding:6px 7px 8px;border-top:1px solid rgba(255,255,255,.07)}
      .crm-person-history-compose.crm-menu-action{width:100%;min-height:31px!important;padding:0 7px!important;text-align:left!important;font-size:var(--crm-type-body,12px)!important}
      .crm-person-history-composer{display:grid;grid-template-columns:1fr 1fr;gap:7px;padding:7px!important}.crm-person-history-composer[hidden]{display:none}
      .crm-person-history-composer textarea{grid-column:1/-1;min-height:58px;resize:vertical}.crm-person-history-composer-actions{grid-column:1/-1;display:flex;justify-content:flex-end;gap:3px}
      .crm-person-history-composer-actions .crm-menu-action{min-height:28px!important;padding:0 7px!important;font-size:var(--crm-type-caption,11px)!important}
      .crm-person-history-status{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
      @media(max-width:600px){.crm-person-history{width:calc(100vw - 28px);max-height:calc(100vh - 112px)}}
    `;
    document.head.appendChild(style);
  }

  async function load(id) {
    const [contactResult, interactionsResult, activityResult] = await Promise.all([
      window.crmStore.get("contacts", id),
      window.crmStore.list("interactions", { includeDeleted: false }),
      window.crmDomain.list("activities", { entityType: "contacts", recordId: id, includeDeleted: false, limit: 120 }),
    ]);
    const person = contactResult?.record || null;
    const interactions = rows(interactionsResult).filter((item) => !item.deletedAt && contactLinked(item, id));
    const interactionIds = new Set(interactions.map((item) => String(item.id)));
    const activities = rows(activityResult).filter((item) => {
      const sourceId = first(item.sourceId, item.interactionId);
      return !sourceId || !interactionIds.has(sourceId);
    });
    const history = (Array.isArray(person?.history) ? person.history : []).filter((item) => !item.interactionId || !interactionIds.has(String(item.interactionId)));
    const events = [
      ...interactions.map((item) => eventOf(item, "interaction")),
      ...activities.map((item) => eventOf(item, "activity")),
      ...history.map((item, index) => eventOf({
        ...item, id: `history-${index}`, kind: "system", occurredAt: item.at,
        content: first(item.detail, item.note, item.text, item.action ? `${item.action} record` : "Record changed"),
      }, "system")),
    ].filter((item) => item.content);
    const unique = new Map();
    events.forEach((event) => {
      const key = `${event.kind}|${dateMs(event.occurredAt)}|${event.content}`;
      if (!unique.has(key)) unique.set(key, event);
    });
    return { person, events: [...unique.values()].sort((a, b) => dateMs(b.occurredAt) - dateMs(a.occurredAt)) };
  }

  const eventHTML = (event) => `<article class="crm-person-history-event crm-menu-item" data-history-kind="${esc(channelOf(event))}" data-history-event="${esc(event.id)}"><div><span class="crm-person-history-event-kind">${esc(event.kind)}</span>${event.direction ? `<span class="crm-person-history-event-direction">${esc(event.direction)}</span>` : ""}</div><div class="crm-person-history-event-content">${esc(event.content)}</div><time class="crm-person-history-event-when">${esc(relative(event.occurredAt))}</time></article>`;

  function render() {
    if (!root || !current?.person) return;
    const person = current.person;
    root.innerHTML = `<article class="crm-person-history crm-menu-surface" role="dialog" aria-modal="false" aria-label="Conversation history for ${esc(nameOf(person))}">
      <header class="crm-person-history-head crm-menu-item"><div class="crm-person-history-heading"><div class="crm-person-history-kicker">Conversation history</div><div class="crm-person-history-title">${esc(nameOf(person))}</div></div><button type="button" class="crm-person-history-close crm-menu-action" data-person-history-close aria-label="Close">×</button></header>
      <section class="crm-person-history-thread" data-person-history-thread>${current.events.length ? current.events.slice(0, 30).map(eventHTML).join("") : '<div class="crm-person-history-empty">No conversation history</div>'}</section>
      <footer class="crm-person-history-foot"><button type="button" class="crm-person-history-compose crm-menu-action" data-person-history-compose>Log interaction</button>
        <form class="crm-person-history-composer crm-menu-item" data-person-history-composer hidden><select class="crm-menu-input" name="kind" aria-label="Interaction type"><option value="note">Note</option><option value="email">Email</option><option value="call">Call</option><option value="message">Message</option><option value="meeting">Meeting</option></select><select class="crm-menu-input" name="direction" aria-label="Direction"><option value="outbound">Outbound</option><option value="inbound">Inbound</option><option value="internal">Internal</option></select><textarea class="crm-menu-input" name="content" placeholder="What happened?" aria-label="Interaction details" required></textarea><div class="crm-person-history-composer-actions"><button type="button" class="crm-menu-action" data-person-history-cancel>Cancel</button><button type="submit" class="crm-menu-action">Log</button></div></form>
      </footer></article><div class="crm-person-history-status" role="status" aria-live="polite"></div>`;
    window.crmInterfaceParity?.scan?.(root);
    placeHistory();
  }
  async function refresh() {
    if (!currentId) return false;
    const generation = currentId;
    const loaded = await load(generation);
    if (currentId !== generation) return false;
    current = loaded;
    render();
    return true;
  }
  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (root && !root.hidden && currentId) refresh().catch(() => {}); }, 100);
  };
  async function logInteraction(fields) {
    if (!current?.person || !currentId) return false;
    const content = String(fields?.content || "").trim();
    if (!content) return false;
    const result = await window.crmStore.create("interactions", {
      kind: first(fields?.kind, "note"), direction: first(fields?.direction, "outbound"), note: content,
      at: new Date().toISOString(), contactId: currentId, companyId: value(current.person, "companyId") || null,
    });
    if (result?.ok === false) throw new Error(result.error || "Interaction could not be saved");
    await refresh();
    return true;
  }

  function placeHistory() {
    const panel = root?.querySelector(".crm-person-history");
    if (!panel?.isConnected || root.hidden) return;
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
  }
  async function open(id, sourceElement = null) {
    if (!root) mount();
    currentId = String(id || "");
    if (!currentId) return false;
    const source = sourceElement?.getBoundingClientRect?.();
    anchorRect = source ? { left: source.left, right: source.right, top: source.top, bottom: source.bottom } : null;
    returnFocus = sourceElement?.isConnected ? sourceElement : document.activeElement;
    // Do not instantiate a placeholder menu and then replace its size and
    // contents in view. Load while the shell is absent; the anchored surface
    // enters once, with its final thread and final geometry.
    root.hidden = true;
    root.replaceChildren();
    try {
      const generation = currentId;
      const loaded = await load(generation);
      if (currentId !== generation) return false;
      current = loaded;
      render();
      root.hidden = false;
      placeHistory();
      return true;
    } catch (error) {
      root.innerHTML = `<article class="crm-person-history crm-menu-surface"><div class="crm-person-history-empty">${esc(error?.message || "Conversation history unavailable")}</div></article>`;
      root.hidden = false;
      placeHistory();
      return false;
    }
  }
  function close() {
    if (!root || root.hidden) return;
    root.hidden = true;
    current = null;
    currentId = "";
    anchorRect = null;
    clearTimeout(refreshTimer);
    if (returnFocus?.isConnected) returnFocus.focus?.({ preventScroll: true });
    returnFocus = null;
  }

  function mount() {
    if (root) return root;
    ensureStyles();
    root = document.createElement("div");
    root.className = "crm-person-history-shell";
    root.hidden = true;
    document.body.appendChild(root);
    root.addEventListener("click", (event) => {
      if (event.target === root || event.target.closest("[data-person-history-close]")) return close();
      if (event.target.closest("[data-person-history-compose]")) {
        const form = root.querySelector("[data-person-history-composer]");
        form.hidden = false;
        event.target.closest("[data-person-history-compose]").hidden = true;
        form.querySelector("textarea")?.focus();
        placeHistory();
        return;
      }
      if (event.target.closest("[data-person-history-cancel]")) {
        root.querySelector("[data-person-history-composer]").hidden = true;
        root.querySelector("[data-person-history-compose]").hidden = false;
        placeHistory();
      }
    });
    root.addEventListener("submit", async (event) => {
      const form = event.target.closest("[data-person-history-composer]");
      if (!form) return;
      event.preventDefault();
      const fields = new FormData(form);
      await logInteraction({ kind: fields.get("kind"), direction: fields.get("direction"), content: fields.get("content") });
    });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !root.hidden) close(); });
    document.addEventListener("crm:theater-switch", () => { if (!root.hidden) close(); });
    try { window.crmStore?.onChanged?.(scheduleRefresh); } catch {}
    try { window.crmDomain?.onChanged?.(scheduleRefresh); } catch {}
    return root;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true }); else mount();
  window.crmPersonHistory = { open, close, refresh, logInteraction, isOpen: () => !!root && !root.hidden, current: () => current };
})();
