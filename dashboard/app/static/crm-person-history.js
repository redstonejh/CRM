// crm-person-history.js — person-native conversation and interaction history.
(() => {
  let root = null;
  let current = null;
  let currentId = "";
  let activeFilter = "all";
  let returnFocus = null;
  let refreshTimer = 0;

  const esc = (value) => String(value ?? "").replace(/[&<>\"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[char]));
  const first = (...values) => values.map((value) => String(value ?? "").trim()).find(Boolean) || "";
  const rows = (result) => result?.records || result?.tickets || [];
  const meta = (record) => record?.meta && typeof record.meta === "object" ? record.meta : {};
  const value = (record, key) => record?.[key] ?? meta(record)[key];
  const nameOf = (person) => first(value(person, "name"), value(person, "title"), value(person, "client"), person?.id, "Unknown person");
  const dateMs = (value) => {
    const parsed = typeof value === "number" ? value : Date.parse(String(value || ""));
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
    subject: first(record?.subject, record?.title),
    content: first(record?.note, record?.content, record?.description, record?.summary, record?.detail, record?.subject, record?.action),
    sourceId: first(record?.sourceId, record?.interactionId),
  });
  const openCommitment = (item) => !item.deletedAt && !["completed", "cancelled", "canceled"].includes(String(item.status || "").toLowerCase());

  const relative = (raw) => {
    const ms = dateMs(raw);
    if (!ms) return "No touch yet";
    const delta = ms - Date.now();
    const abs = Math.abs(delta);
    if (abs < 60000) return "just now";
    if (abs < 3600000) return `${Math.round(abs / 60000)}m ${delta < 0 ? "ago" : "from now"}`;
    if (abs < 86400000) return `${Math.round(abs / 3600000)}h ${delta < 0 ? "ago" : "from now"}`;
    const days = Math.round(abs / 86400000);
    return `${days}d ${delta < 0 ? "ago" : "from now"}`;
  };
  const dayLabel = (raw) => {
    const ms = dateMs(raw);
    if (!ms) return "Undated";
    const date = new Date(ms); const today = new Date();
    const key = date.toDateString();
    if (key === today.toDateString()) return "Today";
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    if (key === yesterday.toDateString()) return "Yesterday";
    return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
  };
  const clock = (raw) => {
    const ms = dateMs(raw);
    return ms ? new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  };
  const dueLabel = (raw) => {
    const ms = dateMs(raw);
    if (!ms) return "No due date";
    const days = Math.round((ms - Date.now()) / 86400000);
    if (days < 0) return `${Math.abs(days)}d overdue`;
    if (days === 0) return "Due today";
    return `Due in ${days}d`;
  };

  function ensureStyles() {
    if (document.getElementById("crm-person-history-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-person-history-styles";
    style.textContent = `
      .crm-person-history-shell{position:fixed;inset:0;z-index:7350;display:grid;place-items:center;padding:34px;background:rgba(3,6,12,.58);-webkit-backdrop-filter:blur(10px) saturate(108%);backdrop-filter:blur(10px) saturate(108%);-webkit-app-region:no-drag}
      .crm-person-history-shell[hidden]{display:none}
      .crm-person-history{width:min(1180px,calc(100vw - 68px));height:min(750px,calc(100vh - 68px));overflow:hidden;display:grid;grid-template-rows:auto minmax(0,1fr);color:#fff}
      .crm-person-history-head{min-height:76px;display:flex;align-items:center;gap:14px;padding:12px 16px!important}
      .crm-person-history-avatar{width:42px;height:50px;flex:0 0 auto;display:grid;place-items:center;border-radius:10px;background:linear-gradient(160deg,rgba(77,132,215,.36),rgba(17,42,80,.18));box-shadow:inset 0 0 0 1px rgba(159,198,255,.22);font:700 12px system-ui;letter-spacing:.05em;color:rgba(229,240,255,.82)}
      .crm-person-history-heading{min-width:0;flex:1}.crm-person-history-kicker{font-size:9px;text-transform:uppercase;letter-spacing:.15em;color:rgba(210,224,246,.48)}
      .crm-person-history-title{margin-top:3px;font:650 21px/1.15 system-ui;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff}.crm-person-history-subtitle{margin-top:5px;font-size:11px;color:rgba(219,229,244,.55)}
      .crm-person-history-close{min-height:34px}
      .crm-person-history-body{min-height:0;display:grid;grid-template-columns:244px minmax(0,1fr);gap:10px;padding:0 10px 10px}
      .crm-person-history-sidebar{min-height:0;overflow:auto;padding:6px;display:flex;flex-direction:column;gap:14px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.2) transparent}
      .crm-person-history-section{padding:8px!important}.crm-person-history-section-title{font-size:9px;font-weight:720;text-transform:uppercase;letter-spacing:.12em;color:rgba(199,217,244,.5);margin-bottom:8px}
      .crm-person-history-fact{display:grid;grid-template-columns:58px minmax(0,1fr);gap:8px;padding:5px 0;font-size:10px}.crm-person-history-fact span:first-child{color:rgba(218,228,242,.38)}.crm-person-history-fact span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(241,245,251,.72)}
      .crm-person-history-filters{display:grid;gap:1px;padding:6px!important}.crm-person-history-filter{min-height:34px;display:flex!important;align-items:center;justify-content:space-between;text-align:left;width:100%}.crm-person-history-filter-count{font-size:10px;color:inherit}
      .crm-person-history-followups{display:grid;gap:7px}.crm-person-history-followup{padding:5px 0}.crm-person-history-followup-title{font-size:11px;line-height:1.35;color:rgba(244,247,252,.78)}.crm-person-history-followup-due{margin-top:3px;font-size:9px;color:rgba(215,225,240,.42)}
      .crm-person-history-main{min-width:0;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr) auto;gap:8px}
      .crm-person-history-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));padding:9px 6px!important}.crm-person-history-stat{padding:3px 12px}.crm-person-history-stat-value{font:650 18px/1 system-ui;color:#fff}.crm-person-history-stat-label{margin-top:5px;font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:rgba(208,222,244,.42)}
      .crm-person-history-thread{min-height:0;overflow:auto;padding:4px 12px 12px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.24) transparent}.crm-person-history-day{margin:10px 0 4px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.13em;color:rgba(202,218,243,.4)}
      .crm-person-history-event{position:relative;margin:3px 0;padding:9px 12px 10px 16px!important;max-width:84%}.crm-person-history-event::before{content:"";position:absolute;left:5px;top:11px;bottom:11px;width:2px;border-radius:3px;background:rgba(123,174,247,.5)}
      .crm-person-history-event.is-inbound{margin-right:16%}.crm-person-history-event.is-outbound{margin-left:16%}.crm-person-history-event.is-system{max-width:100%;opacity:.64}.crm-person-history-event.is-system::before{background:rgba(255,255,255,.18)}
      .crm-person-history-event-top{display:flex;align-items:center;justify-content:space-between;gap:10px}.crm-person-history-event-kind{font-size:9px;font-weight:750;text-transform:uppercase;letter-spacing:.1em;color:rgba(185,210,247,.64)}.crm-person-history-event-when{font-size:9px;color:rgba(215,225,239,.36)}
      .crm-person-history-event-subject{margin-top:5px;font-size:11px;font-weight:650;color:rgba(246,248,252,.84)}.crm-person-history-event-content{margin-top:4px;font-size:12px;line-height:1.48;color:rgba(239,243,249,.74);white-space:pre-wrap;overflow-wrap:anywhere}.crm-person-history-event-actor{margin-top:5px;font-size:9px;color:rgba(213,224,240,.36)}
      .crm-person-history-empty{padding:28px 12px;font-size:11px;line-height:1.5;color:rgba(220,229,242,.42)}
      .crm-person-history-composer{display:grid;grid-template-columns:116px 116px minmax(0,1fr) auto;gap:7px;align-items:end;padding:8px!important}.crm-person-history-composer textarea{height:40px;min-height:40px;max-height:94px;resize:vertical}.crm-person-history-submit{min-height:40px;white-space:nowrap}
      .crm-person-history-status{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
      @media(max-width:900px){.crm-person-history{width:calc(100vw - 34px);height:calc(100vh - 34px)}.crm-person-history-body{grid-template-columns:205px minmax(0,1fr)}.crm-person-history-summary{grid-template-columns:repeat(2,1fr)}.crm-person-history-composer{grid-template-columns:1fr 1fr}.crm-person-history-composer textarea{grid-column:1/-1}.crm-person-history-submit{grid-column:2}}
    `;
    document.head.appendChild(style);
  }

  async function load(id) {
    const [contactResult, interactionsResult, activityResult, commitmentResult] = await Promise.all([
      window.crmStore.get("contacts", id),
      window.crmStore.list("interactions", { includeDeleted: false }),
      window.crmDomain.list("activities", { entityType: "contacts", recordId: id, includeDeleted: false, limit: 300 }),
      window.crmDomain.list("commitments", { entityType: "contacts", recordId: id, includeDeleted: false, limit: 100 }),
    ]);
    const person = contactResult?.record || null;
    const interactions = rows(interactionsResult).filter((item) => !item.deletedAt && contactLinked(item, id));
    const interactionIds = new Set(interactions.map((item) => String(item.id)));
    const activity = rows(activityResult).filter((item) => {
      const sourceId = first(item.sourceId, item.interactionId);
      return !sourceId || !interactionIds.has(sourceId);
    });
    const history = (Array.isArray(person?.history) ? person.history : []).filter((item) => !item.interactionId || !interactionIds.has(String(item.interactionId)));
    const events = [
      ...interactions.map((item) => eventOf(item, "interaction")),
      ...activity.map((item) => eventOf(item, "activity")),
      ...history.map((item, index) => eventOf({
        ...item, id: `history-${index}`, kind: "system", occurredAt: item.at,
        content: first(item.detail, item.note, item.text, item.action ? `${item.action} record` : "Record changed"),
      }, "system")),
    ].filter((item) => item.content);
    if (person?.createdAt && !history.some((item) => String(item.action || "").toLowerCase() === "created")) {
      events.push(eventOf({ id: "contact-created", kind: "system", occurredAt: person.createdAt, content: "Person added to the CRM" }, "system"));
    }
    const unique = new Map();
    events.forEach((event) => {
      const key = `${event.kind}|${dateMs(event.occurredAt)}|${event.content}`;
      if (!unique.has(key)) unique.set(key, event);
    });
    return {
      person,
      events: [...unique.values()].sort((a, b) => dateMs(b.occurredAt) - dateMs(a.occurredAt)),
      commitments: rows(commitmentResult).filter(openCommitment).sort((a, b) => dateMs(a.dueAt) - dateMs(b.dueAt)),
    };
  }

  const eventHTML = (event) => `<article class="crm-person-history-event crm-menu-item is-${esc(event.direction || (event.kind === "system" ? "system" : "neutral"))}" data-history-kind="${esc(channelOf(event))}" data-history-event="${esc(event.id)}">
    <div class="crm-person-history-event-top"><span class="crm-person-history-event-kind">${esc(event.kind)}</span><span class="crm-person-history-event-when">${esc(clock(event.occurredAt))}</span></div>
    ${event.subject && event.subject !== event.content ? `<div class="crm-person-history-event-subject">${esc(event.subject)}</div>` : ""}
    <div class="crm-person-history-event-content">${esc(event.content)}</div>
    ${event.actor ? `<div class="crm-person-history-event-actor">${esc(event.actor)}</div>` : ""}
  </article>`;

  function threadHTML(events) {
    const visible = events.filter((event) => activeFilter === "all" || channelOf(event) === activeFilter);
    if (!visible.length) return `<div class="crm-person-history-empty">No ${activeFilter === "all" ? "conversation" : activeFilter} history has been recorded for this person yet.</div>`;
    let lastDay = "";
    return visible.map((event) => {
      const day = dayLabel(event.occurredAt);
      const divider = day === lastDay ? "" : `<div class="crm-person-history-day">${esc(day)}</div>`;
      lastDay = day;
      return divider + eventHTML(event);
    }).join("");
  }

  function render() {
    if (!root || !current?.person) return;
    const person = current.person;
    const initials = nameOf(person).split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
    const touchEvents = current.events.filter((event) => event.kind !== "system");
    const lastTouch = touchEvents[0]?.occurredAt || value(person, "lastTouchAt") || value(person, "lastContactAt");
    const channels = new Set(touchEvents.map(channelOf).filter((kind) => kind !== "system"));
    const counts = Object.fromEntries(["all", "messages", "calls", "meetings", "notes"].map((filter) => [filter, filter === "all" ? touchEvents.length : touchEvents.filter((event) => channelOf(event) === filter).length]));
    const facts = [
      ["Company", value(person, "company")], ["Role", value(person, "role")], ["Email", value(person, "email")], ["Phone", value(person, "phone")],
    ].filter(([, fact]) => fact);
    root.innerHTML = `<article class="crm-person-history crm-menu-surface" role="dialog" aria-modal="true" aria-label="Conversation history for ${esc(nameOf(person))}">
      <header class="crm-person-history-head crm-menu-item">
        <div class="crm-person-history-avatar" aria-hidden="true">${esc(initials)}</div>
        <div class="crm-person-history-heading"><div class="crm-person-history-kicker">Conversation & interaction history</div><div class="crm-person-history-title">${esc(nameOf(person))}</div><div class="crm-person-history-subtitle">${esc([value(person, "role"), value(person, "company")].filter(Boolean).join(" · ") || "Relationship record")}</div></div>
        <button type="button" class="crm-person-history-close crm-menu-action" data-person-history-close>Close</button>
      </header>
      <div class="crm-person-history-body">
        <aside class="crm-person-history-sidebar">
          <section class="crm-person-history-section crm-menu-item"><div class="crm-person-history-section-title">Contact</div>${facts.length ? facts.map(([label, fact]) => `<div class="crm-person-history-fact"><span>${esc(label)}</span><span title="${esc(fact)}">${esc(fact)}</span></div>`).join("") : `<div class="crm-person-history-empty">No contact details recorded.</div>`}</section>
          <section class="crm-person-history-filters crm-menu-item" aria-label="History filters">${["all", "messages", "calls", "meetings", "notes"].map((filter) => `<button type="button" class="crm-person-history-filter crm-menu-action${activeFilter === filter ? " is-selected" : ""}" data-history-filter="${filter}" aria-pressed="${activeFilter === filter}"><span>${esc(filter[0].toUpperCase() + filter.slice(1))}</span><span class="crm-person-history-filter-count">${counts[filter]}</span></button>`).join("")}</section>
          <section class="crm-person-history-section crm-menu-item"><div class="crm-person-history-section-title">Open follow-ups</div><div class="crm-person-history-followups">${current.commitments.length ? current.commitments.slice(0, 6).map((item) => `<div class="crm-person-history-followup"><div class="crm-person-history-followup-title">${esc(item.title)}</div><div class="crm-person-history-followup-due">${esc(dueLabel(item.dueAt))}</div></div>`).join("") : `<div class="crm-person-history-empty">Nothing is currently owed.</div>`}</div></section>
        </aside>
        <main class="crm-person-history-main">
          <section class="crm-person-history-summary crm-menu-item" aria-label="Relationship summary">
            <div class="crm-person-history-stat"><div class="crm-person-history-stat-value">${touchEvents.length}</div><div class="crm-person-history-stat-label">Recorded touches</div></div>
            <div class="crm-person-history-stat"><div class="crm-person-history-stat-value">${esc(relative(lastTouch))}</div><div class="crm-person-history-stat-label">Last touch</div></div>
            <div class="crm-person-history-stat"><div class="crm-person-history-stat-value">${channels.size}</div><div class="crm-person-history-stat-label">Channels</div></div>
            <div class="crm-person-history-stat"><div class="crm-person-history-stat-value">${current.commitments.length}</div><div class="crm-person-history-stat-label">Open follow-ups</div></div>
          </section>
          <section class="crm-person-history-thread" data-person-history-thread>${threadHTML(current.events)}</section>
          <form class="crm-person-history-composer crm-menu-item" data-person-history-composer>
            <select class="crm-menu-input" name="kind" aria-label="Interaction type"><option value="note">Note</option><option value="email">Email</option><option value="call">Call</option><option value="message">Message</option><option value="meeting">Meeting</option></select>
            <select class="crm-menu-input" name="direction" aria-label="Direction"><option value="outbound">Outbound</option><option value="inbound">Inbound</option><option value="internal">Internal</option></select>
            <textarea class="crm-menu-input" name="content" placeholder="What happened with ${esc(nameOf(person))}?" aria-label="Interaction details" required></textarea>
            <button type="submit" class="crm-person-history-submit crm-menu-action">Log interaction</button>
          </form>
        </main>
      </div>
    </article><div class="crm-person-history-status" role="status" aria-live="polite"></div>`;
    window.crmInterfaceParity?.scan?.(root);
  }

  async function refresh() {
    if (!currentId) return;
    const generation = currentId;
    const next = await load(generation);
    if (currentId !== generation) return;
    current = next;
    render();
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

  async function open(id, sourceElement = null) {
    if (!root) mount();
    currentId = String(id || "");
    if (!currentId) return false;
    activeFilter = "all";
    returnFocus = sourceElement?.isConnected ? sourceElement : document.activeElement;
    root.hidden = false;
    root.innerHTML = `<article class="crm-person-history crm-menu-surface"><div class="crm-person-history-empty" style="margin:auto">Loading conversation history…</div></article>`;
    try {
      await refresh();
      root.querySelector("[data-person-history-close]")?.focus({ preventScroll: true });
      return true;
    } catch (error) {
      root.innerHTML = `<article class="crm-person-history crm-menu-surface"><div class="crm-person-history-empty" style="margin:auto">${esc(error?.message || "Conversation history could not be loaded.")}</div></article>`;
      return false;
    }
  }
  function close() {
    if (!root || root.hidden) return;
    root.hidden = true;
    current = null; currentId = ""; clearTimeout(refreshTimer);
    if (returnFocus?.isConnected) returnFocus.focus?.({ preventScroll: true });
    returnFocus = null;
  }

  function mount() {
    ensureStyles();
    root = document.createElement("div");
    root.className = "crm-person-history-shell";
    root.hidden = true;
    document.body.appendChild(root);
    root.addEventListener("click", (event) => {
      if (event.target === root || event.target.closest("[data-person-history-close]")) return close();
      const filter = event.target.closest("[data-history-filter]");
      if (filter) { activeFilter = filter.dataset.historyFilter; render(); }
    });
    root.addEventListener("submit", async (event) => {
      const form = event.target.closest("[data-person-history-composer]");
      if (!form) return;
      event.preventDefault();
      const button = form.querySelector("[type='submit']");
      const data = new FormData(form);
      button.disabled = true; button.textContent = "Logging…";
      try {
        await logInteraction({ kind: data.get("kind"), direction: data.get("direction"), content: data.get("content") });
        root.querySelector(".crm-person-history-status").textContent = "Interaction logged";
        root.querySelector("[data-person-history-composer] textarea")?.focus();
      } catch (error) {
        button.disabled = false; button.textContent = "Try again";
        root.querySelector(".crm-person-history-status").textContent = error?.message || "Interaction could not be logged";
      }
    });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !root.hidden) close(); });
    document.addEventListener("crm:theater-switch", () => { if (!root.hidden) close(); });
    try { window.crmStore?.onChanged?.(scheduleRefresh); } catch {}
    try { window.crmDomain?.onChanged?.(scheduleRefresh); } catch {}
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
  window.crmPersonHistory = { open, close, refresh, logInteraction, isOpen: () => !!root && !root.hidden, current: () => current };
})();
