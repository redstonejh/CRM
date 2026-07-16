// crm-object-sizing.js — one persistent Large/Small contract for cards and buckets.
(() => {
  const STORE_KEY = "crm-object-sizing-v1";
  const CARD_SELECTOR = ".tk-card:not(.td-card):not(.td-flyer),.tk-zcard,.crm-planner-card,.crm-assignment-work-card";
  const BUCKET_SELECTOR = ".tk-zone,.crm-planner-bucket,.crm-company-bucket";
  let state = { cards: {}, buckets: {} };
  let menu = null;
  let previewTimer = 0;

  const read = () => {
    try {
      const value = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      state = value && typeof value === "object"
        ? { cards: value.cards && typeof value.cards === "object" ? value.cards : {}, buckets: value.buckets && typeof value.buckets === "object" ? value.buckets : {} }
        : { cards: {}, buckets: {} };
    } catch { state = { cards: {}, buckets: {} }; }
  };
  const write = () => { if (!window.crmHomePreviews?.isCaptureWorker) localStorage.setItem(STORE_KEY, JSON.stringify(state)); };
  const theaterOf = (element) => element?.closest?.("[data-crm-theater]")?.dataset?.crmTheater || "workspace";
  const entityFor = (element, theater) => element?.dataset?.recordEntity || ({
    tickets: "tickets", people: "contacts", assignments: "commitments", pipeline: "deals", jobs: "jobs",
    bills: "bills", invoices: "invoices", planner: "planner",
  }[theater] || theater);
  const idFor = (element, kind) => {
    if (kind === "card") return element?.dataset?.id || element?.dataset?.recordId || element?.dataset?.plannerCard || element?.dataset?.assignmentContactId || "";
    return element?.dataset?.stage || element?.dataset?.assignmentCommitment || element?.dataset?.plannerBucket || element?.dataset?.companyKey || "";
  };
  const keyOf = (element, kind = "card") => {
    if (!element) return "";
    if (element.dataset.crmSizeKey) return element.dataset.crmSizeKey;
    const theater = theaterOf(element); const id = idFor(element, kind); if (!id) return "";
    const key = kind === "card" ? `card:${entityFor(element, theater)}:${id}` : `bucket:${theater}:${id}`;
    element.dataset.crmSizeKey = key;
    return key;
  };
  const sizeOf = (element, kind = "card") => {
    const key = keyOf(element, kind); return key && state[kind === "card" ? "cards" : "buckets"][key] === "small" ? "small" : "large";
  };
  const apply = (element, kind) => {
    if (!element?.classList) return;
    const size = sizeOf(element, kind);
    element.dataset.crmObjectSize = size;
    element.classList.toggle("crm-object-small", size === "small");
  };
  const scan = (root = document) => {
    if (root.matches?.(CARD_SELECTOR)) apply(root, "card");
    if (root.matches?.(BUCKET_SELECTOR)) apply(root, "bucket");
    root.querySelectorAll?.(CARD_SELECTOR).forEach((element) => apply(element, "card"));
    root.querySelectorAll?.(BUCKET_SELECTOR).forEach((element) => apply(element, "bucket"));
    return root;
  };
  const homeKeyFor = (element) => ({
    people: "people", tickets: "cases", cases: "cases", planner: "planner", assignments: "assignments",
  }[theaterOf(element)] || "");
  const refreshPreview = (homeKey) => {
    if (!homeKey || window.crmHomePreviews?.isCaptureWorker) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => window.crmHome?.captureBaseline?.(homeKey), 180);
  };
  const setSize = (element, kind = "card", size = "large") => {
    const key = keyOf(element, kind); if (!key) return "large";
    const group = kind === "card" ? "cards" : "buckets";
    if (size === "small") state[group][key] = "small"; else delete state[group][key];
    write();
    const selector = kind === "card" ? CARD_SELECTOR : BUCKET_SELECTOR;
    document.querySelectorAll(selector).forEach((candidate) => { if (keyOf(candidate, kind) === key) apply(candidate, kind); });
    const homeKey = homeKeyFor(element);
    const detail = { key, kind, size: size === "small" ? "small" : "large", homeKey };
    document.dispatchEvent(new CustomEvent("crm:object-size-change", { detail }));
    refreshPreview(homeKey);
    return detail.size;
  };
  const toggle = (element, kind = "card") => setSize(element, kind, sizeOf(element, kind) === "small" ? "large" : "small");
  const isSmall = (element, kind = "card") => sizeOf(element, kind) === "small";

  const closeMenu = () => { menu?.remove(); menu = null; };
  const openMenu = (element, kind, x, y) => {
    closeMenu(); if (!keyOf(element, kind)) return null;
    menu = document.createElement("div"); menu.className = "crm-size-menu crm-menu-surface";
    const button = document.createElement("button"); button.type = "button"; button.className = "crm-menu-action";
    button.textContent = isSmall(element, kind) ? "Make large" : "Make small";
    button.addEventListener("click", () => { toggle(element, kind); closeMenu(); }); menu.appendChild(button);
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(innerWidth - rect.width - 8, x))}px`;
    menu.style.top = `${Math.max(48, Math.min(innerHeight - rect.height - 8, y))}px`;
    setTimeout(() => {
      const outside = (event) => { if (menu?.contains(event.target)) return; closeMenu(); document.removeEventListener("pointerdown", outside, true); };
      document.addEventListener("pointerdown", outside, true);
    }, 0);
    return menu;
  };

  const ensureStyles = () => {
    if (document.getElementById("crm-object-sizing-styles")) return;
    const style = document.createElement("style"); style.id = "crm-object-sizing-styles"; style.textContent = `
      .crm-object-small{transition:width .18s cubic-bezier(.22,1,.26,1),height .18s cubic-bezier(.22,1,.26,1),flex-basis .18s cubic-bezier(.22,1,.26,1),scale .18s cubic-bezier(.22,1,.26,1)!important}
      .tk-card.crm-object-small:not(.crm-assignment-bucket-card){scale:.8;transform-origin:bottom center}
      .tk-zcard.crm-object-small,.tk-zone.crm-object-small,.crm-assignment-work-card.crm-object-small,.crm-planner-card.crm-object-small,.crm-planner-bucket.crm-object-small,.crm-company-bucket.crm-object-small{scale:1!important}
      .crm-size-menu{position:fixed;z-index:9320;width:154px;padding:6px;display:grid}.crm-size-menu .crm-menu-action{height:34px;text-align:left;font-size:var(--crm-type-body,12px)!important}
      @media(prefers-reduced-motion:reduce){.crm-object-small{transition-duration:.01ms!important}}
    `; document.head.appendChild(style);
  };
  const start = () => {
    ensureStyles(); read(); scan(document.body);
    new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach((node) => { if (node.nodeType === 1) scan(node); })))
      .observe(document.body, { childList: true, subtree: true });
    document.addEventListener("contextmenu", (event) => {
      if (event.defaultPrevented) return;
      const bucket = event.target.closest?.(BUCKET_SELECTOR); if (!bucket) return;
      event.preventDefault(); openMenu(bucket, "bucket", event.clientX, event.clientY);
    });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && menu) closeMenu(); });
    document.addEventListener("crm:theater-switch", closeMenu);
    document.dispatchEvent(new CustomEvent("crm:object-sizing-ready"));
  };
  window.addEventListener("storage", (event) => { if (event.key === STORE_KEY) { read(); scan(document.body); } });
  const api = { keyOf, sizeOf, isSmall, setSize, toggle, scan, openMenu, closeMenu, state: () => JSON.parse(JSON.stringify(state)) };
  window.crmObjectSizing = api;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true }); else start();
})();
