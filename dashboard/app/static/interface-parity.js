// Applies one canonical visual contract to every non-card information surface.
// The account dropdown and background picker are the only source of truth.
// Search, Desk, and every other non-card surface only consume that contract.
(() => {
  "use strict";

  const SURFACE_SELECTOR = [
    ".background-tone-popover",
    ".dashboard-search-popover",
    ".auth-card",
    ".auth-profile-menu",
    ".auth-submenu",
    ".auth-modal",
    ".panel-add-menu",
    ".nav-menu-shell",
    ".floating-glass-menu",
    ".company-overflow-menu",
    ".confirm-dialog",
    ".toast",
    ".ticket-detail",
    ".tk-menu",
    ".tk-zone",
    ".crm-home-bucket",
    ".crm-home-window",
    ".crm-overview-pocket",
    ".record-world",
    ".crm-person-history",
    ".fc-year-strip",
    ".fc-bucket",
    ".crm-company-account",
    ".crm-company-bucket",
    ".crm-company-world",
    ".crm-report-widget",
    ".db-panel",
    ".widget-card:not([data-widget-runtime-type='ticket'])",
  ].join(",");

  const ITEM_SELECTOR = [
    ".auth-profile-head",
    ".background-tone-group",
    ".crm-home-mini-row",
    ".crm-home-company",
    ".crm-home-stage",
    ".crm-home-day",
    ".crm-person-row",
    ".crm-company-thread-row",
    ".record-world-fact",
    ".record-world-related-row",
    ".record-world-flow",
    ".record-world-commitment",
    ".record-world-event",
    ".record-world-composer",
    ".crm-person-history-head",
    ".crm-person-history-summary",
    ".crm-person-history-filters",
    ".crm-person-history-event",
    ".crm-person-history-composer",
    ".td-acc",
    ".td-log",
    ".tk-empty",
    ".tk-zone-empty",
  ].join(",");

  const CARD_FACE_SELECTOR = [
    ".tk-card",
    ".tk-zcard",
    ".tk-zfly",
    ".td-card",
    ".td-flyer",
    ".fc-fly-card",
    ".crm-home-hand-card",
    ".crm-company-face",
    ".crm-home-flight",
    ".crm-project-tile",
    ".crm-planner-card",
    ".crm-assignment-work-card",
    ".crm-overview-project",
    ".crm-overview-ticket",
    ".widget-card[data-widget-runtime-type='ticket']",
  ].join(",");

  const DIRECT_MENU_SELECTOR = [
    ".auth-profile-menu",
    ".auth-submenu",
    ".background-tone-popover",
    ".dashboard-search-popover",
  ].join(",");

  const TOP_CIRCULAR_SELECTOR = ".window-glass-control, .auth-profile-button";
  const PHYSICAL_ACTION_SELECTOR = ".tk-arrow";
  const ACTION_SELECTOR = "button, [role='button']";
  const INPUT_SELECTOR = [
    "input:not([type='checkbox']):not([type='radio']):not([type='color']):not([type='range']):not([type='file']):not([type='button']):not([type='submit']):not([type='reset'])",
    "textarea",
    "select",
  ].join(",");

  const isElement = (node) => node?.nodeType === Node.ELEMENT_NODE;
  const inCardFace = (element) => !!element.closest(CARD_FACE_SELECTOR);
  const inDirectMenu = (element) => !!element.closest(DIRECT_MENU_SELECTOR);
  const isTopCircular = (element) => element.matches(TOP_CIRCULAR_SELECTOR) || !!element.closest(TOP_CIRCULAR_SELECTOR);
  const isPhysicalAction = (element) => element.matches(PHYSICAL_ACTION_SELECTOR) || !!element.closest(PHYSICAL_ACTION_SELECTOR);
  const classify = (element) => {
    if (!isElement(element)) return;
    const cardFace = inCardFace(element);

    if (!cardFace && element.matches(SURFACE_SELECTOR)) element.classList.add("crm-menu-surface");

    if (!cardFace && element.matches(ITEM_SELECTOR) && !element.matches(SURFACE_SELECTOR)) {
      element.classList.add("crm-menu-item");
    }

    if (
      !cardFace &&
      !inDirectMenu(element) &&
      !isTopCircular(element) &&
      !isPhysicalAction(element) &&
      element.matches(ACTION_SELECTOR) &&
      !element.matches(SURFACE_SELECTOR)
    ) {
      element.classList.add("crm-menu-action");
    }

    if (!cardFace && !inDirectMenu(element) && element.matches(INPUT_SELECTOR)) {
      element.classList.add("crm-menu-input");
    }
  };

  const scan = (root) => {
    if (!root) return;
    if (isElement(root)) classify(root);
    root.querySelectorAll?.("*").forEach(classify);
  };

  const pending = new Set();
  let frame = 0;
  const queue = (node) => {
    const root = isElement(node) ? node : node?.parentElement;
    if (!root) return;
    pending.add(root);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const roots = [...pending];
      pending.clear();
      roots.forEach(scan);
      document.documentElement.dataset.crmInterfaceParity = "canonical-menu";
    });
  };

  const eligibleAction = (element) => (
    !inCardFace(element) &&
    !inDirectMenu(element) &&
    !isTopCircular(element) &&
    !isPhysicalAction(element) &&
    !element.matches(SURFACE_SELECTOR)
  );

  const audit = () => {
    scan(document.body);
    const surfaceCandidates = [...document.querySelectorAll(SURFACE_SELECTOR)].filter((element) => !inCardFace(element));
    const actionCandidates = [...document.querySelectorAll(ACTION_SELECTOR)].filter(eligibleAction);
    return {
      surfaces: surfaceCandidates.length,
      actions: actionCandidates.length,
      items: document.querySelectorAll(".crm-menu-item").length,
      missingSurfaces: surfaceCandidates.filter((element) => !element.classList.contains("crm-menu-surface")),
      missingActions: actionCandidates.filter((element) => !element.classList.contains("crm-menu-action")),
      bucketArrows: document.querySelectorAll("svg.tk-flow, .tk-flow-shaft, .tk-flow-head").length,
    };
  };

  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      if (record.type === "characterData") queue(record.target);
      record.addedNodes?.forEach(queue);
    });
  });

  const start = () => {
    scan(document.body);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    document.documentElement.dataset.crmInterfaceParity = "canonical-menu";
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();

  window.crmInterfaceParity = Object.freeze({ audit, scan, selectors: Object.freeze({ surfaces: SURFACE_SELECTOR, cards: CARD_FACE_SELECTOR }) });
})();
