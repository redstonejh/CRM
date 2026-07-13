// crm-record-search.js — CRM retrieval inside the canonical top-bar dropdown.
//
// The account dropdown and background picker own the menu visual contract.
// Search consumes their shell/item classes; it never defines a menu variant.
(() => {
  "use strict";

  const entities = ["contacts", "companies", "deals", "jobs", "cases", "tickets", "invoices"];
  const labels = {
    contacts: "Person",
    companies: "Company",
    deals: "Deal",
    jobs: "Job",
    cases: "Case",
    tickets: "Case",
    invoices: "Invoice",
  };

  let root = null;
  let input = null;
  let results = null;
  let trigger = null;
  let all = [];
  let selected = 0;
  let loadGeneration = 0;

  const esc = (value) => String(value ?? "").replace(/[&<>\"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[char]));
  const first = (...values) => values.map((value) => String(value ?? "").trim()).find(Boolean) || "";
  const title = (record) => first(record.name, record.title, record.client, record.number, record.companyLabel, record.id, "Untitled");

  function ensureLayoutStyles() {
    if (document.getElementById("crm-search-layout-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-search-layout-styles";
    style.textContent = `
      .crm-search-result { flex-shrink:0; min-height:34px; gap:10px; }
      .crm-search-result-copy { display:flex; flex:1 1 auto; flex-direction:column; min-width:0; gap:2px; overflow:hidden; }
      .crm-search-result-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:inherit; }
      .crm-search-result-sub { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:rgba(255,255,255,.5); font-size:.78em; font-weight:400; }
      .crm-search-result-type { flex:0 0 auto; margin-left:auto; color:rgba(255,255,255,.5); font-size:.78em; font-weight:600; }
      .crm-search-result.is-selected { color:#fff; background:transparent; }
      .crm-search-empty { padding:0 12px; color:rgba(255,255,255,.62); font-size:.85rem; line-height:1.45; }
    `;
    document.head.appendChild(style);
  }

  async function load() {
    const groups = await Promise.all(entities.map(async (entity) => {
      try {
        const response = await window.crmStore.list(entity, { includeDeleted: false });
        return (response?.records || []).map((record) => ({ entity, record }));
      } catch {
        return [];
      }
    }));
    all = groups.flat();
  }

  function matches(item, query) {
    const record = item.record;
    return `${title(record)} ${record.description || ""} ${record.email || ""} ${record.company || ""} ${record.role || ""} ${record.stage || record.state || ""}`
      .toLowerCase()
      .includes(query);
  }

  function visibleResults() {
    const query = input.value.trim().toLowerCase();
    if (query) return all.filter((item) => matches(item, query)).slice(0, 30);
    return all
      .slice()
      .sort((a, b) => (Date.parse(b.record.updatedAt || "") || 0) - (Date.parse(a.record.updatedAt || "") || 0))
      .slice(0, 12);
  }

  function render() {
    const items = visibleResults();
    selected = Math.min(selected, Math.max(0, items.length - 1));
    results.innerHTML = items.length
      ? items.map((item, index) => {
        const record = item.record;
        const context = first(record.company, record.role, record.description, record.stage, record.state, "Open record");
        return `<button class="auth-menu-item crm-search-result${index === selected ? " is-selected" : ""}" type="button" role="option" aria-selected="${index === selected}" data-result="${index}" data-entity="${esc(item.entity)}" data-id="${esc(record.id)}">
          <span class="crm-search-result-copy"><span class="crm-search-result-title">${esc(title(record))}</span><span class="crm-search-result-sub">${esc(context)}</span></span>
          <span class="crm-search-result-type">${esc(labels[item.entity])}</span>
        </button>`;
      }).join("")
      : `<div class="crm-search-empty">No matching CRM record.</div>`;
  }

  function position() {
    if (!root || root.hidden || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = root.getBoundingClientRect().width;
    root.style.top = `${Math.round(rect.bottom + 8)}px`;
    root.style.left = `${Math.round(Math.min(Math.max(14, rect.left), innerWidth - width - 14))}px`;
  }

  async function open(query = "") {
    if (!root) mount();
    root.hidden = false;
    trigger?.setAttribute("aria-expanded", "true");
    input.value = String(query ?? "");
    selected = 0;
    results.innerHTML = `<div class="crm-search-empty">Loading records…</div>`;
    position();
    const generation = ++loadGeneration;
    await load();
    if (generation !== loadGeneration || root.hidden) return;
    render();
    input.focus();
  }

  function close({ restoreFocus = false } = {}) {
    if (!root) return;
    loadGeneration += 1;
    root.hidden = true;
    trigger?.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger?.focus();
  }

  function choose(node) {
    if (!node) return;
    close();
    window.crmRecordWorld.open(node.dataset.entity, node.dataset.id, node);
  }

  function mount() {
    if (root) return;
    ensureLayoutStyles();
    root = document.getElementById("dashboard-search-popover");
    trigger = document.querySelector(".control-bar-search");
    if (!root || !trigger) return;

    root.dataset.wired = "crm-record-search";
    root.setAttribute("role", "search");
    root.setAttribute("aria-label", "Search CRM records");
    root.innerHTML = `
      <input class="dashboard-search-input" type="search" placeholder="Find a person, company, deal, job, case, or invoice" aria-label="Search CRM records" autocomplete="off" spellcheck="false">
      <div class="dashboard-search-results" role="listbox" aria-label="CRM search results"></div>
    `;
    input = root.querySelector(".dashboard-search-input");
    results = root.querySelector(".dashboard-search-results");
    trigger.setAttribute("aria-label", "Search CRM");
    trigger.setAttribute("title", "Search CRM");

    input.addEventListener("input", () => {
      selected = 0;
      render();
    });
    results.addEventListener("mousemove", (event) => {
      const row = event.target.closest("[data-result]");
      if (!row) return;
      const next = Number(row.dataset.result);
      if (next !== selected) {
        selected = next;
        render();
      }
    });
    results.addEventListener("click", (event) => choose(event.target.closest("[data-result]")));
    root.addEventListener("keydown", (event) => {
      const rows = [...root.querySelectorAll("[data-result]")];
      if (event.key === "Escape") {
        event.preventDefault();
        close({ restoreFocus: true });
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        selected = Math.min(rows.length - 1, selected + 1);
        render();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        selected = Math.max(0, selected - 1);
        render();
      } else if (event.key === "Enter") {
        event.preventDefault();
        choose(root.querySelector(`[data-result="${selected}"]`));
      }
    });

    document.addEventListener("click", (event) => {
      const button = event.target.closest(".control-bar-search");
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (root.hidden) open();
      else close({ restoreFocus: true });
    }, true);
    document.addEventListener("pointerdown", (event) => {
      if (!root.hidden && !root.contains(event.target) && !trigger.contains(event.target)) close();
    });
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        open();
      }
    });
    window.addEventListener("resize", position);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();

  window.crmSearchDeck = {
    open,
    close,
    isOpen: () => !!root && !root.hidden,
    setQuery: (query) => open(query),
  };
})();
