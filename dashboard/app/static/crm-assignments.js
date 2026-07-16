// crm-assignments.js — people cards assigned into real activity buckets.
(() => {
  let root = null;
  let active = false;
  let model = null;
  let timer = 0;
  let dragContactId = "";
  let dragCommitmentId = "";
  let selectedPoolId = "";

  const rows = (result) => result?.records || [];
  const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[character]));
  const selectorValue = (value) => window.CSS?.escape?.(String(value ?? "")) || String(value ?? "").replace(/["\\]/g, "\\$&");
  const closed = (item) => ["completed", "cancelled", "canceled"].includes(String(item?.status || "").toLowerCase());
  const dueTime = (item) => Date.parse(item?.dueAt || "") || Number.MAX_SAFE_INTEGER;
  const nameOf = (person) => person?.name || person?.title || person?.client || person?.id || "Person";
  const companyName = (company) => company?.name || company?.title || company?.id || "Company";

  function ensureStyles() {
    if (document.getElementById("crm-assignments-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-assignments-styles";
    style.textContent = `
      .crm-assignments-surface{position:fixed;inset:0;z-index:836;color:#fff;overflow:hidden}.crm-assignments-surface[hidden]{display:none}
      .crm-assignments-frame{position:absolute;inset:var(--crm-canvas-top,78px) var(--crm-canvas-x,64px) 0;max-width:1150px;margin:auto;display:grid;grid-template-columns:210px minmax(0,1fr);gap:var(--crm-section-gap,28px)}
      .crm-assignment-pools{align-self:start;min-height:0;max-height:calc(100vh - 154px);display:flex;flex-direction:column;padding:9px 6px;overflow:hidden}
      .crm-assignment-head{display:flex;align-items:center;padding:0 12px}.crm-assignment-title{font-size:var(--crm-type-object,14px);font-weight:700}
      .crm-assignment-pools-head{height:38px;flex:0 0 38px;box-sizing:border-box}
      .crm-assignment-pool-stack{min-height:0;display:flex;flex-direction:column;gap:1px;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.24) transparent}
      .crm-assignment-source-pool.crm-menu-action{width:100%;min-height:38px;display:flex;align-items:center;gap:10px;text-align:left}
      .crm-assignment-source-pool-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .crm-assignment-stage{position:relative;min-width:0;min-height:0;overflow:visible}
      .crm-assignment-grid{position:absolute;left:0;right:0;top:0;height:336px;display:grid;grid-template-columns:repeat(4,202px);gap:var(--crm-object-gap,18px);place-content:start center}
      .crm-assignment-bucket.tk-zone{position:relative;inset:auto;width:202px;height:336px;box-sizing:border-box}
      .crm-assignment-bucket .tk-zone-body{min-height:0}.crm-assignment-bucket .tk-zone-track{position:relative;min-height:100%}
      .crm-assignment-bucket.is-drop-target{border-color:rgba(137,188,255,.72)!important;box-shadow:inset 0 1px rgba(255,255,255,.24),0 0 34px rgba(71,139,231,.24)!important}
      .crm-assignment-bucket-card.tk-card{position:absolute!important;left:50%!important;right:auto!important;bottom:auto!important;top:0!important;width:170px!important;height:257px!important;margin:0!important;transform:translateX(-50%)!important;z-index:2;cursor:grab}
      .crm-assignment-hand{position:fixed;left:50%;bottom:0;width:min(790px,100%);height:278px;transform:translateX(-50%);overflow:visible;pointer-events:none}
      .crm-assignment-hand-trigger{position:absolute;z-index:1;left:50%;bottom:0;width:var(--assignment-hand-span,760px);height:92px;transform:translateX(-50%);pointer-events:auto}
      .crm-assignment-hand-card.tk-card{position:absolute!important;left:50%!important;right:auto!important;top:auto!important;bottom:52px!important;width:165px!important;height:249px!important;margin:0!important;z-index:var(--hand-z);cursor:grab;pointer-events:auto;
        transform-origin:50% 108%;transform:translateX(calc(-50% + var(--hand-x,0px))) translateY(var(--hand-rest-y,180px)) rotate(var(--hand-rot,0deg));
        transition:transform .38s cubic-bezier(.22,1,.26,1),box-shadow .18s ease,opacity .18s ease}
      .crm-assignment-hand-card.crm-assignment-hand-seated{animation:none;transition:none}
      .crm-assignment-hand:is(:hover,:focus-within)>.crm-assignment-hand-card.tk-card{transform:translateX(calc(-50% + var(--hand-x,0px))) translateY(var(--hand-open-y,0px)) rotate(var(--hand-open-rot,var(--hand-rot,0deg))) scale(.9)}
      .crm-assignment-hand:is(:hover,:focus-within)>.crm-assignment-hand-card.tk-card:is(:hover,:focus-visible){z-index:1000;transform:translateX(calc(-50% + var(--hand-x,0px))) translateY(calc(var(--hand-open-y,0px) - 6px)) rotate(var(--hand-open-rot,var(--hand-rot,0deg))) scale(.92);box-shadow:inset 0 0 0 9999px rgba(255,255,255,.12),inset 0 1px rgba(255,255,255,.34),0 22px 48px rgba(0,0,0,.44)}
      .crm-assignment-hand-card.is-dragging,.crm-assignment-bucket-card.is-dragging{opacity:.32}.crm-assignment-hand-card:active,.crm-assignment-bucket-card:active{cursor:grabbing}
      @media(prefers-reduced-motion:reduce){.crm-assignment-hand-card.tk-card{transition-duration:.01ms;animation-duration:.01ms}}
      @media(max-width:1250px){.crm-assignments-frame{grid-template-columns:204px minmax(0,1fr);gap:16px}.crm-assignment-pools{max-height:calc(100vh - 146px)}.crm-assignment-grid{grid-template-columns:repeat(4,186px);gap:12px}.crm-assignment-bucket.tk-zone{width:186px}.crm-assignment-hand-card.tk-card{width:155px!important;height:234px!important}}
    `;
    document.head.appendChild(style);
  }

  async function load() {
    const [commitments, contacts, companies] = await Promise.all([
      window.crmDomain.list("commitments", { includeDeleted: false, limit: 100 }),
      window.crmStore.list("contacts", { includeDeleted: false }),
      window.crmStore.list("companies", { includeDeleted: false }),
    ]);
    const contactRows = rows(contacts).filter((person) => !person.deletedAt);
    const companyRows = rows(companies).filter((company) => !company.deletedAt);
    const companyNames = new Map(companyRows.map((company) => [companyName(company).trim().toLowerCase(), company]));
    const pools = companyRows.map((company) => ({
      id: String(company.id), label: companyName(company),
      people: contactRows.filter((person) => String(person.companyId || "") === String(company.id)
        || (!person.companyId && companyNames.get(String(person.company || "").trim().toLowerCase()) === company)),
    }));
    const pooledIds = new Set(pools.flatMap((pool) => pool.people.map((person) => String(person.id))));
    const unassigned = contactRows.filter((person) => !pooledIds.has(String(person.id)));
    if (unassigned.length) pools.push({ id: "unassigned", label: "Unassigned", people: unassigned });
    return {
      commitments: rows(commitments).filter((item) => !closed(item)).sort((a, b) => dueTime(a) - dueTime(b)),
      contacts: contactRows, companies: companyRows, pools,
    };
  }

  const assignedPerson = (commitment) => {
    const id = String(commitment.assignedContactId || "");
    const assignee = String(commitment.assignee || "").trim().toLowerCase();
    return model.contacts.find((person) => String(person.id) === id)
      || model.contacts.find((person) => nameOf(person).trim().toLowerCase() === assignee)
      || null;
  };

  function personCard(person, index, commitment = null) {
    const card = window.peopleCards.createCard(person, {
      onOpen: (_record, source) => window.crmRecordWorld?.open?.("contacts", person.id, source),
      ariaLabel: `${nameOf(person)} — drag to assign`,
    });
    card.classList.add(commitment ? "crm-assignment-bucket-card" : "crm-assignment-hand-card");
    if (!commitment && (root?.hidden || document.documentElement.classList.contains("crm-transit-materializing"))) {
      card.classList.add("crm-assignment-hand-seated");
    }
    card.dataset.assignmentContactId = person.id;
    if (commitment) card.dataset.assignmentCommitmentId = commitment.id;
    else {
      card.style.setProperty("--hand-z", String(index + 1));
      card.style.setProperty("--hand-delay", `${index * 22}ms`);
    }
    card.draggable = true;
    card.addEventListener("dragstart", (event) => {
      dragContactId = person.id;
      dragCommitmentId = commitment?.id || "";
      card.classList.add("is-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", person.id);
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("is-dragging");
      root?.querySelectorAll(".is-drop-target").forEach((node) => node.classList.remove("is-drop-target"));
      dragContactId = ""; dragCommitmentId = "";
    });
    return card;
  }

  function layoutHand(hand) {
    const cards = [...hand.querySelectorAll(".crm-assignment-hand-card.tk-card")];
    if (!cards.length) return;
    const width = cards[0].offsetWidth || 165;
    const height = cards[0].offsetHeight || 249;
    const maxSpan = Math.min(hand.clientWidth || 760, 760);
    const step = cards.length > 1 ? Math.min(width * .62, (maxSpan - width) / (cards.length - 1)) : 0;
    const middle = (cards.length - 1) / 2;
    const peek = 128;
    const baseBottom = 52;
    const openDrop = 33;
    cards.forEach((card, index) => {
      const distance = index - middle;
      const arc = Math.min(18, distance * distance * 2.35);
      const rotation = Math.max(-15, Math.min(15, distance * 4.2));
      card.style.setProperty("--hand-x", `${(distance * step).toFixed(2)}px`);
      card.style.setProperty("--hand-rot", `${rotation.toFixed(2)}deg`);
      card.style.setProperty("--hand-open-rot", `${(rotation * .72).toFixed(2)}deg`);
      card.style.setProperty("--hand-open-y", `${(openDrop + arc * .1).toFixed(2)}px`);
      card.style.setProperty("--hand-rest-y", `${(baseBottom + height - peek + arc).toFixed(2)}px`);
    });
    hand.style.setProperty("--assignment-hand-span", `${Math.min(hand.clientWidth, width + step * Math.max(0, cards.length - 1) + 64).toFixed(2)}px`);
  }

  async function assign(commitmentId, contactId) {
    const commitment = model.commitments.find((item) => String(item.id) === String(commitmentId));
    const person = model.contacts.find((item) => String(item.id) === String(contactId));
    if (!commitment || !person) return false;
    await window.crmDomain.update("commitments", commitment.id, {
      assignee: nameOf(person), assignedContactId: person.id, assignedContactName: nameOf(person), assignedAt: new Date().toISOString(),
    }, commitment.version);
    await refresh();
    return true;
  }

  async function unassign(commitmentId) {
    const commitment = model.commitments.find((item) => String(item.id) === String(commitmentId));
    if (!commitment) return false;
    await window.crmDomain.update("commitments", commitment.id, {
      assignee: null, assignedContactId: null, assignedContactName: null, assignedAt: null,
    }, commitment.version);
    await refresh();
    return true;
  }

  function render() {
    if (!root || !model) return;
    const pools = model.pools.slice(0, 8);
    if (!pools.some((pool) => pool.id === selectedPoolId)) selectedPoolId = pools.find((pool) => pool.people.length)?.id || pools[0]?.id || "";
    const selected = pools.find((pool) => pool.id === selectedPoolId) || pools[0];
    const hand = selected?.people || [];
    const activities = model.commitments.slice(0, 4);
    root.innerHTML = `<div class="crm-assignments-frame">
      <aside class="crm-assignment-pools crm-menu-surface">
        <div class="crm-assignment-head crm-assignment-pools-head crm-menu-item"><span class="crm-assignment-title">People pools</span></div>
        <div class="crm-assignment-pool-stack">${pools.map((pool) => `<button type="button" class="crm-assignment-source-pool crm-menu-action${pool.id === selectedPoolId ? " is-selected" : ""}" aria-pressed="${pool.id === selectedPoolId}" data-assignment-pool="${esc(pool.id)}">
          <span class="crm-assignment-source-pool-name" title="${esc(pool.label)}">${esc(pool.label)}</span>
        </button>`).join("")}</div>
      </aside>
      <section class="crm-assignment-stage">
        <div class="crm-assignment-grid">${activities.map((activity) => {
        const assigned = assignedPerson(activity);
        const late = activity.dueAt && dueTime(activity) < Date.now();
        return `<section class="tk-zone crm-assignment-bucket" data-assignment-commitment="${esc(activity.id)}">
          <div class="tk-zone-hd"><span class="tk-zone-title" title="${esc(activity.title)}">${esc(activity.title)}</span><span class="tk-zone-hd-r"><div class="tk-bars" aria-hidden="true"><span class="tk-seg${late ? " r" : " g"}"></span><span class="tk-seg"></span><span class="tk-seg"></span></div></span></div>
          <div class="tk-zone-body"><div class="tk-zone-clip"><div class="tk-zone-track"></div></div></div>
        </section>`;
      }).join("")}</div>
        <div class="crm-assignment-hand" data-assignment-hand><div class="crm-assignment-hand-trigger" aria-hidden="true"></div></div>
      </section>
    </div>`;
    const handNode = root.querySelector(".crm-assignment-hand");
    hand.forEach((person, index) => handNode.appendChild(personCard(person, index)));
    // Seat the fan before this render can paint. A deferred first layout made
    // the cards briefly appear at their CSS defaults and then snap into place.
    layoutHand(handNode);
    activities.forEach((activity) => {
      const assigned = assignedPerson(activity);
      if (assigned) root.querySelector(`[data-assignment-commitment="${selectorValue(activity.id)}"] .tk-zone-track`).appendChild(personCard(assigned, 0, activity));
    });
  }

  function wireDrops() {
    root.addEventListener("click", (event) => {
      const pool = event.target.closest("[data-assignment-pool]");
      if (!pool) return;
      selectedPoolId = pool.dataset.assignmentPool;
      render();
    });
    root.addEventListener("dragover", (event) => {
      const bucket = event.target.closest("[data-assignment-commitment]");
      const pool = event.target.closest("[data-assignment-pool]");
      if (!bucket && !(pool && dragCommitmentId)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      root.querySelectorAll(".is-drop-target").forEach((node) => node.classList.toggle("is-drop-target", node === bucket));
    });
    root.addEventListener("dragleave", (event) => {
      const bucket = event.target.closest("[data-assignment-commitment]");
      if (bucket && !bucket.contains(event.relatedTarget)) bucket.classList.remove("is-drop-target");
    });
    root.addEventListener("drop", async (event) => {
      const bucket = event.target.closest("[data-assignment-commitment]");
      const pool = event.target.closest("[data-assignment-pool]");
      if (!bucket && !pool) return;
      event.preventDefault();
      if (bucket && dragContactId) await assign(bucket.dataset.assignmentCommitment, dragContactId);
      else if (pool && dragCommitmentId) await unassign(dragCommitmentId);
    });
  }

  let renderDirty = true;
  async function refresh() { model = await load(); render(); renderDirty = false; return model; }
  async function miniature() {
    if (!root) mount();
    await refresh();
    const clone = root.cloneNode(true); clone.hidden = false; clone.removeAttribute("data-crm-theater");
    Object.assign(clone.style, { position: "absolute", left: "50%", top: "50%", width: "1280px", height: "860px", transform: "translate(-50%,-50%) scale(.285)", transformOrigin: "center", pointerEvents: "none" });
    return clone;
  }
  const schedule = () => { renderDirty = true; clearTimeout(timer); timer = setTimeout(() => { if (active) refresh(); }, 120); };
  function setActive(on) { active = !!on; if (!root) mount(); root.hidden = !active; if (active && renderDirty) refresh(); return api; }
  function mount() {
    ensureStyles();
    root = document.createElement("main"); root.className = "crm-assignments-surface"; root.dataset.crmTheater = "assignments"; root.hidden = true;
    document.body.appendChild(root); wireDrops();
    try { window.crmDomain?.onChanged?.(schedule); } catch {}
    try { window.crmStore?.onChanged?.(schedule); } catch {}
  }
  const baseline = async (options = {}) => {
    if (!root) mount();
    if (!model || renderDirty) {
      model = await load();
      if (typeof options.canRender === "function" && !options.canRender()) return root;
      render(); renderDirty = false;
    }
    root.hidden = !active;
    return root;
  };
  const api = { setActive, refresh, miniature, baseline, assign, unassign, selectPool: (id) => { selectedPoolId = String(id); render(); }, isActive: () => active };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
  window.crmAssignments = api;
})();
