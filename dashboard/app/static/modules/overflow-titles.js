export function initializeOverflowTitles() {
  const skipTags = new Set(["SCRIPT", "STYLE", "SVG", "PATH", "INPUT", "TEXTAREA", "SELECT", "OPTION"]);
  const refreshElement = (element) => {
    if (!(element instanceof Element) || !element.isConnected || skipTags.has(element.tagName)) return;
    const text = (element.textContent || "").replace(/\s+/g, " ").trim();
    if (!text || text.length < 2) return;
    const style = window.getComputedStyle(element);
    const canClip = style.textOverflow === "ellipsis" || style.overflow === "hidden" || style.whiteSpace === "nowrap";
    if (!canClip || !element.clientWidth) return;
    const clipped = element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
    if (clipped) {
      if (!element.getAttribute("title") || element.dataset.autoTitle === "true") {
        element.setAttribute("title", text);
        element.dataset.autoTitle = "true";
      }
    } else if (element.dataset.autoTitle === "true") {
      element.removeAttribute("title");
      delete element.dataset.autoTitle;
    }
  };

  const refreshOverflowTitles = (root = document.body) => {
    if (!(root instanceof Element)) return;
    refreshElement(root);
    root.querySelectorAll("*").forEach(refreshElement);
  };

  let overflowTitleTimer = 0;
  let overflowTitleIdle = 0;
  const pending = [];
  const pendingSet = new Set();
  const enqueueElement = (element) => {
    if (!(element instanceof Element) || !element.isConnected || pendingSet.has(element)) return;
    pendingSet.add(element);
    pending.push(element);
  };
  const enqueueTree = (root) => {
    if (!(root instanceof Element) || !root.isConnected) return;
    enqueueElement(root);
    root.querySelectorAll("*").forEach(enqueueElement);
  };
  const transitionIsBusy = () => !!window.crmDeskTransit?.isBusy?.()
    || !!window.crmHomeCamera?.isTransitioning?.()
    || !!document.querySelector(".crm-home-camera-moving");
  const requestChunk = (delay = 0) => {
    if (overflowTitleTimer || overflowTitleIdle || !pending.length) return;
    overflowTitleTimer = window.setTimeout(() => {
      overflowTitleTimer = 0;
      if (transitionIsBusy()) { requestChunk(80); return; }
      const run = (deadline) => {
        overflowTitleIdle = 0;
        if (transitionIsBusy()) { requestChunk(80); return; }
        const started = performance.now();
        let count = 0;
        while (pending.length && count < 64 && performance.now() - started < 8) {
          if (count && !deadline.didTimeout && deadline.timeRemaining() < 3) break;
          const element = pending.shift();
          pendingSet.delete(element);
          refreshElement(element);
          count += 1;
        }
        if (pending.length) requestChunk();
      };
      if ("requestIdleCallback" in window) overflowTitleIdle = window.requestIdleCallback(run, { timeout: 350 });
      else overflowTitleIdle = window.setTimeout(() => run({ didTimeout:true, timeRemaining:() => 0 }), 0);
    }, delay);
  };
  const scheduleOverflowTitles = (root = document.body) => {
    enqueueTree(root instanceof Element ? root : document.body);
    requestChunk(80);
  };

  scheduleOverflowTitles();
  window.addEventListener("load", scheduleOverflowTitles);
  window.addEventListener("resize", scheduleOverflowTitles);
  new MutationObserver((records) => {
    records.forEach((record) => {
      const target = record.type === "characterData" ? record.target.parentElement : record.target;
      enqueueElement(target);
      record.addedNodes?.forEach((node) => { if (node instanceof Element) enqueueTree(node); });
    });
    requestChunk(80);
  }).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  return { scheduleOverflowTitles, refreshOverflowTitles };
}
