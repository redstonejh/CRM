// Applies one canonical visual contract to every non-card information surface.
// The source of truth is the ticket configuration/account/search menu recipe;
// this audit layer only assigns semantic classes and never invents a variant.
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
    ".crm-desk-panel",
    ".crm-desk-composer",
    ".crm-command",
    ".record-world",
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
    ".crm-desk-commitment",
    ".crm-desk-work-card",
    ".crm-desk-activity",
    ".crm-person-row",
    ".crm-company-thread-row",
    ".crm-command-row",
    ".record-world-fact",
    ".record-world-related-row",
    ".record-world-flow",
    ".record-world-commitment",
    ".record-world-event",
    ".record-world-composer",
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
    ".widget-card[data-widget-runtime-type='ticket']",
  ].join(",");

  const REFERENCE_SELECTOR = [
    ".ticket-detail",
    ".dashboard-search-popover",
    ".auth-profile-menu",
    ".auth-submenu",
  ].join(",");

  const TOP_CIRCULAR_SELECTOR = ".window-glass-control, .auth-profile-button";
  const ACTION_SELECTOR = "button, [role='button']";
  const INPUT_SELECTOR = [
    "input:not([type='checkbox']):not([type='radio']):not([type='color']):not([type='range']):not([type='file']):not([type='button']):not([type='submit']):not([type='reset'])",
    "textarea",
    "select",
  ].join(",");

  const isElement = (node) => node?.nodeType === Node.ELEMENT_NODE;
  const inCardFace = (element) => !!element.closest(CARD_FACE_SELECTOR);
  const inReference = (element) => !!element.closest(REFERENCE_SELECTOR);
  const isTopCircular = (element) => element.matches(TOP_CIRCULAR_SELECTOR) || !!element.closest(TOP_CIRCULAR_SELECTOR);
  const hasDirectCopy = (element) => [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());

  const classify = (element) => {
    if (!isElement(element)) return;
    const cardFace = inCardFace(element);

    if (!cardFace && element.matches(SURFACE_SELECTOR)) element.classList.add("crm-config-surface");

    if (!cardFace && element.matches(ITEM_SELECTOR) && !element.matches(SURFACE_SELECTOR)) {
      element.classList.add("crm-config-item");
    }

    if (
      !cardFace &&
      !inReference(element) &&
      !isTopCircular(element) &&
      element.matches(ACTION_SELECTOR) &&
      !element.matches(SURFACE_SELECTOR)
    ) {
      element.classList.add("crm-config-action");
    }

    if (!cardFace && !inReference(element) && element.matches(INPUT_SELECTOR)) {
      element.classList.add("crm-config-input");
    }

    if (
      !cardFace &&
      !inReference(element) &&
      hasDirectCopy(element) &&
      !element.closest(ACTION_SELECTOR) &&
      !element.matches("input, textarea, select, option, script, style")
    ) {
      element.classList.add("crm-config-copy");
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
      document.documentElement.dataset.crmInterfaceParity = "config-menu";
    });
  };

  const eligibleAction = (element) => (
    !inCardFace(element) &&
    !inReference(element) &&
    !isTopCircular(element) &&
    !element.matches(SURFACE_SELECTOR)
  );

  const audit = () => {
    scan(document.body);
    const surfaceCandidates = [...document.querySelectorAll(SURFACE_SELECTOR)].filter((element) => !inCardFace(element));
    const actionCandidates = [...document.querySelectorAll(ACTION_SELECTOR)].filter(eligibleAction);
    return {
      surfaces: surfaceCandidates.length,
      actions: actionCandidates.length,
      items: document.querySelectorAll(".crm-config-item").length,
      copy: document.querySelectorAll(".crm-config-copy").length,
      missingSurfaces: surfaceCandidates.filter((element) => !element.classList.contains("crm-config-surface")),
      missingActions: actionCandidates.filter((element) => !element.classList.contains("crm-config-action")),
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
    document.documentElement.dataset.crmInterfaceParity = "config-menu";
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();

  window.crmInterfaceParity = Object.freeze({ audit, scan, selectors: Object.freeze({ surfaces: SURFACE_SELECTOR, cards: CARD_FACE_SELECTOR }) });
})();
