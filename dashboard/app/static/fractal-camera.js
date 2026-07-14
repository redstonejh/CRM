// fractal-camera.js - shared nested-bucket camera for calendar/home/drill-in views.
((global) => {
  global.createFractalCamera = function createFractalCamera(config = {}) {
    const apiName = config.apiName || "";
    const surfaceClass = config.surfaceClass || "fractal-camera-surface";
    const layerClass = config.layerClass || "fractal-camera-layer";
    const maxLevel = Number.isFinite(config.maxLevel) ? config.maxLevel : 2;
    const ease = config.ease || "cubic-bezier(.22, 1, .26, 1)";
    const morphMs = Number(config.morphMs) || 460;
    const expandFadeMs = Number.isFinite(Number(config.expandFadeMs)) ? Number(config.expandFadeMs) : 140;
    const belowFadeMs = Number.isFinite(Number(config.belowFadeMs)) ? Number(config.belowFadeMs) : morphMs;
    const contractFadeMs = Number.isFinite(Number(config.contractFadeMs)) ? Number(config.contractFadeMs) : Math.round(morphMs * .35);
    const contractFadeDelay = Math.max(0, morphMs - contractFadeMs);
    const keepBelowVisible = config.keepBelowVisibleDuringTransition === true;
    const configuredMargin = Number(config.margin);
    const margin = Number.isFinite(configuredMargin) ? configuredMargin : 16;
    const ignoreSelector = config.ignoreSelector || ".window-control-cluster, .background-tone-menu, .auth-shell, .auth-modal-backdrop";
    let top = 58;
    let surface = null;
    let level = 0;
    let layers = [];
    let srcSel = [];
    let transitioning = false;
    let transitionSeq = 0;
    let transitionWaiters = [];
    let warm = null;
    let active = config.active !== false;

    const measureTop = () => {
      if (typeof config.measureTop === "function") {
        top = config.measureTop({ margin });
        return;
      }
      let bottom = 42;
      document.querySelectorAll(".window-control-cluster").forEach((el) => {
        bottom = Math.max(bottom, el.getBoundingClientRect().bottom);
      });
      top = Math.round(bottom + margin);
    };
    const expRect = () => ({ x: margin, y: top, w: window.innerWidth - 2 * margin, h: window.innerHeight - top - margin });
    const layoutRect = (el, layer) => {
      const lr = layer.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      const sx = lr.width / layer.offsetWidth;
      const sy = lr.height / layer.offsetHeight;
      return { x: (er.left - lr.left) / sx, y: (er.top - lr.top) / sy, w: er.width / sx, h: er.height / sy };
    };
    const ctx = () => ({
      api,
      level,
      layers,
      surface,
      expRect,
      layoutRect,
      margin,
      morphMs,
      active,
    });
    const once = (fn) => {
      let done = false;
      return () => {
        if (done) return;
        done = true;
        fn();
      };
    };
    const settleWaiters = () => {
      const waiters = transitionWaiters;
      transitionWaiters = [];
      waiters.forEach((resolve) => resolve(ctx()));
    };
    const whenSettled = () => transitioning ? new Promise((resolve) => transitionWaiters.push(resolve)) : Promise.resolve(ctx());
    const afterTransform = (el, fn) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        el.removeEventListener("transitionend", onEnd);
        clearTimeout(fallback);
        fn();
      };
      const onEnd = (event) => {
        if (event.target === el && event.propertyName === "transform") finish();
      };
      const fallback = setTimeout(finish, morphMs + 35);
      el.addEventListener("transitionend", onEnd);
    };
    const transitionFrame = (fn) => requestAnimationFrame(() => {
      if (config.precomposeTransitions === true) requestAnimationFrame(fn);
      else fn();
    });
    const ensure = () => {
      if (surface) return;
      config.ensureStyles?.(ctx());
      surface = document.createElement("div");
      surface.className = surfaceClass;
      surface.dataset.level = "0";
      if (config.theater) surface.dataset.crmTheater = String(config.theater);
      surface.hidden = !active;
      layers[0] = config.buildRoot?.(ctx()) || document.createElement("div");
      layers[0].classList.add(layerClass);
      surface.appendChild(layers[0]);
      document.body.appendChild(surface);
      measureTop();
      layout();
      document.addEventListener("click", onClick, true);
      document.addEventListener("mousemove", onMouseMove, true);
      document.addEventListener("keydown", onKeyDown);
      window.addEventListener("resize", onResize);
      config.onReady?.(ctx());
    };
    const layout = () => {
      if (!surface) return;
      measureTop();
      const E = expRect();
      for (let i = 1; i <= level; i++) {
        if (layers[i]) Object.assign(layers[i].style, { left: `${E.x}px`, top: `${E.y}px`, width: `${E.w}px`, height: `${E.h}px` });
      }
      config.layout?.(ctx());
    };
    const keyOf = (target) => config.keyOf?.(target, ctx()) || "";
    const targetFromEvent = (event) => {
      if (!active || transitioning || level >= maxLevel) return null;
      return config.targetFromEvent?.(event, ctx()) || null;
    };
    const targetAtPoint = (x, y) => {
      if (!active || transitioning || level >= maxLevel) return null;
      return config.targetAtPoint?.(x, y, ctx()) || null;
    };
    const dropWarm = () => {
      if (!warm) return;
      warm.el.remove();
      warm = null;
    };
    const buildExpander = (target) => {
      const E = expRect();
      const source = layoutRect(target, layers[level]);
      const expander = config.buildExpander?.(target, { ...ctx(), sourceRect: source }) || document.createElement("div");
      Object.assign(expander.style, { left: `${E.x}px`, top: `${E.y}px`, width: `${E.w}px`, height: `${E.h}px` });
      config.configureExpander?.(expander, target, { ...ctx(), sourceRect: source });
      return expander;
    };
    const prefetch = (target) => {
      const key = keyOf(target);
      if (!key) return;
      if (warm && warm.key === key) return;
      dropWarm();
      const expander = buildExpander(target);
      expander.classList.add(config.warmClass || "fractal-camera-warm");
      Object.assign(expander.style, { opacity: "0.001", zIndex: "1" });
      surface.appendChild(expander);
      warm = { key, el: expander };
    };
    const expand = (target) => {
      if (!target || !active || transitioning || level >= maxLevel) return;
      config.prepareTarget?.(target, ctx());
      const seq = ++transitionSeq;
      transitioning = true;
      surface.querySelectorAll(`.${config.contractingClass || "fractal-camera-contracting"}`).forEach((el) => el.remove());
      const E = expRect();
      const rect = target.getBoundingClientRect();
      const key = keyOf(target);
      let expander = null;
      if (warm && warm.key === key) {
        expander = warm.el;
        expander.classList.remove(config.warmClass || "fractal-camera-warm");
        warm = null;
      } else {
        dropWarm();
        expander = buildExpander(target);
        surface.appendChild(expander);
      }
      srcSel[level] = config.sourceSelector?.(target, ctx()) || "";
      Object.assign(expander.style, {
        zIndex: "5",
        pointerEvents: "auto",
        transition: "none",
        opacity: "0",
        transform: `translate(${(rect.left - E.x).toFixed(2)}px, ${(rect.top - E.y).toFixed(2)}px) scale(${(rect.width / E.w).toFixed(5)}, ${(rect.height / E.h).toFixed(5)})`,
      });
      const below = layers[level];
      below.style.zIndex = "0";
      below.style.pointerEvents = "none";
      const source = layoutRect(target, below);
      const kx = E.w / source.w;
      const ky = E.h / source.h;
      const dive = `translate(${(E.x - below.offsetLeft - source.x * kx).toFixed(2)}px, ${(E.y - below.offsetTop - source.y * ky).toFixed(2)}px) scale(${kx.toFixed(4)}, ${ky.toFixed(4)})`;
      void expander.offsetWidth;
      transitionFrame(() => {
        expander.style.transition = `transform ${morphMs}ms ${ease}, opacity ${expandFadeMs}ms ease`;
        expander.style.transform = "none";
        expander.style.opacity = "1";
        below.style.transition = keepBelowVisible
          ? `transform ${morphMs}ms ${ease}`
          : `transform ${morphMs}ms ${ease}, opacity ${belowFadeMs}ms ease`;
        below.style.transform = dive;
        below.style.opacity = keepBelowVisible ? "1" : "0";
      });
      const oldLevel = level;
      const commit = once(() => {
        level = oldLevel + 1;
        layers[level] = expander;
        surface.dataset.level = String(level);
        transitioning = false;
        config.onLevelChange?.(ctx());
        config.onTransitionEnd?.("expand", ctx());
        settleWaiters();
      });
      config.onTransitionStart?.("expand", ctx());
      afterTransform(expander, () => {
        if (seq !== transitionSeq) return;
        commit();
        expander.style.transition = "none";
        below.style.transition = "none";
        below.style.visibility = "hidden";
        below.style.transform = "none";
        below.style.opacity = "1";
        below.style.pointerEvents = "";
      });
    };
    const contract = () => {
      if (!active || level === 0 || transitioning) return;
      const seq = ++transitionSeq;
      transitioning = true;
      const expander = layers[level];
      const below = layers[level - 1];
      const selector = srcSel[level - 1] || "";
      const source = selector ? below?.querySelector?.(selector) : null;
      if (!expander || !below || !source) {
        level = Math.max(0, level - 1);
        transitioning = false;
        settleWaiters();
        return;
      }
      const E = expRect();
      const sourceRect = layoutRect(source, below);
      const kx = E.w / sourceRect.w;
      const ky = E.h / sourceRect.h;
      const dive = `translate(${(E.x - below.offsetLeft - sourceRect.x * kx).toFixed(2)}px, ${(E.y - below.offsetTop - sourceRect.y * ky).toFixed(2)}px) scale(${kx.toFixed(4)}, ${ky.toFixed(4)})`;
      const rx = below.offsetLeft + sourceRect.x;
      const ry = below.offsetTop + sourceRect.y;
      below.style.transition = "none";
      below.style.zIndex = "5";
      below.style.pointerEvents = "auto";
      below.style.transform = dive;
      below.style.opacity = keepBelowVisible ? "1" : (config.contractFadeMs != null ? "0" : "1");
      below.style.visibility = "";
      expander.style.transition = "none";
      expander.style.zIndex = "4";
      expander.style.pointerEvents = "none";
      expander.style.opacity = "1";
      expander.classList.add(config.contractingClass || "fractal-camera-contracting");
      const oldLevel = level;
      const commit = once(() => {
        layers[oldLevel] = null;
        level = oldLevel - 1;
        surface.dataset.level = String(level);
        dropWarm();
        transitioning = false;
        config.onLevelChange?.(ctx());
        config.onTransitionEnd?.("contract", ctx());
        settleWaiters();
      });
      config.onTransitionStart?.("contract", ctx());
      void below.offsetWidth;
      transitionFrame(() => {
        if (seq !== transitionSeq) return;
        below.style.transition = keepBelowVisible
          ? `transform ${morphMs}ms ${ease}`
          : (config.contractFadeMs != null
            ? `transform ${morphMs}ms ${ease}, opacity ${contractFadeMs}ms ease ${contractFadeDelay}ms`
            : `transform ${morphMs}ms ${ease}`);
        below.style.transform = "none";
        below.style.opacity = "1";
        expander.style.transition = `transform ${morphMs}ms ${ease}, opacity ${contractFadeMs}ms ease ${contractFadeDelay}ms`;
        expander.style.transform = `translate(${(rx - E.x).toFixed(2)}px, ${(ry - E.y).toFixed(2)}px) scale(${(sourceRect.w / E.w).toFixed(5)}, ${(sourceRect.h / E.h).toFixed(5)})`;
        expander.style.opacity = "0";
      });
      afterTransform(expander, () => {
        if (seq !== transitionSeq) {
          expander.remove();
          return;
        }
        commit();
        below.style.zIndex = "";
        expander.remove();
      });
    };
    const backToRoot = () => {
      while (level > 0 && !transitioning) contract();
    };
    // Seat a target's expander at FULL size with no animation — the end state
    // expand() would have reached. contract() then plays the reverse dive from
    // here, which is how the desk transit (BLUEPRINT A1) re-enters Home: the
    // module's own bucket lid appears over the stage and flies back to its slot.
    const jumpTo = (target) => {
      if (!target || !active || transitioning || level >= maxLevel) return false;
      ensure();
      dropWarm();
      const expander = buildExpander(target);
      config.prepareJump?.(expander, target, ctx());
      srcSel[level] = config.sourceSelector?.(target, ctx()) || "";
      Object.assign(expander.style, { zIndex: "5", pointerEvents: "auto", transition: "none", opacity: "1", transform: "none" });
      surface.appendChild(expander);
      const below = layers[level];
      below.style.zIndex = "0";
      below.style.pointerEvents = "none";
      below.style.visibility = "hidden";
      below.style.transform = "none";
      below.style.opacity = "1";
      level += 1;
      layers[level] = expander;
      surface.dataset.level = String(level);
      config.onLevelChange?.(ctx());
      return true;
    };
    const rebuildRoot = () => {
      ensure();
      dropWarm();
      layers.slice(1).forEach((el) => el?.remove?.());
      layers = [config.buildRoot?.(ctx()) || document.createElement("div")];
      layers[0].classList.add(layerClass);
      surface.replaceChildren(layers[0]);
      level = 0;
      surface.dataset.level = "0";
      layout();
      config.onLevelChange?.(ctx());
    };
    const refresh = () => {
      if (!surface) return;
      rebuildRoot();
    };
    const setActive = (on) => {
      active = !!on;
      ensure();
      surface.hidden = !active;
      if (!active) dropWarm();
      else layout();
      config.onActiveChange?.(active, ctx());
      return api;
    };
    const onClick = (event) => {
      if (!active || !surface || surface.hidden) return;
      if (event.target?.closest?.(ignoreSelector)) return;
      const target = targetFromEvent(event) || targetAtPoint(event.clientX, event.clientY);
      if (!target) return;
      event.preventDefault();
      expand(target);
    };
    const onMouseMove = (event) => {
      if (!active || !surface || surface.hidden) return;
      const target = targetAtPoint(event.clientX, event.clientY);
      if (target) prefetch(target);
    };
    const onKeyDown = (event) => {
      if (!active || !surface || surface.hidden) return;
      if (event.target && /INPUT|TEXTAREA/.test(event.target.tagName)) return;
      if (event.key === "b" || event.key === "B" || event.key === "Escape") {
        // At root the surface has nowhere further to contract — hand the key to
        // the owner (the desk transit chains module → Home; BLUEPRINT A1).
        if (level === 0) { config.onRootBack?.(ctx()); return; }
        contract();
      }
    };
    const onResize = () => {
      if (!surface) return;
      dropWarm();
      layout();
    };
    const api = {
      init: ensure,
      setActive,
      isActive: () => active,
      level: () => level,
      surface: () => surface,
      layers: () => layers.slice(),
      expRect,
      layoutRect,
      expand,
      back: contract,
      backToRoot,
      jumpTo,
      isTransitioning: () => transitioning,
      whenSettled,
      refresh,
      rebuildRoot,
      dropWarm,
      layout,
    };
    if (apiName) global[apiName] = api;
    const start = () => {
      ensure();
      if (!active && surface) surface.hidden = true;
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
    return api;
  };
})(window);
