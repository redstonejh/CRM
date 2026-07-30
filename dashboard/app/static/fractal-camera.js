// fractal-camera.js - shared nested-bucket camera for calendar/home/drill-in views.
((global) => {
  // Backdrop blur is a screen-space effect. Putting it inside the camera's
  // scaled expander changes its apparent radius throughout the transform and
  // can leave only the translucent tint visibly stable. This sibling lens
  // never scales: only its clip expands or contracts with the camera.
  global.createFractalAcrylicLens = function createFractalAcrylicLens(config = {}) {
    const frameSelector = config.frameSelector || ":scope > [data-fractal-acrylic-frame]";
    const ownerClass = config.ownerClass || "fractal-camera-screen-acrylic";
    const lensClass = config.lensClass || "fractal-camera-acrylic-lens";
    const entryHold = Number.isFinite(Number(config.entryHold)) ? Number(config.entryHold) : .86;
    const exitReveal = Number.isFinite(Number(config.exitReveal)) ? Number(config.exitReveal) : .14;
    const releaseEase = config.releaseEase || "cubic-bezier(.3, 0, .7, 1)";
    const holdThroughMotion = config.holdThroughMotion === true;
    const releaseMs = Math.max(1, Number(config.releaseMs) || 140);
    let lens = null;
    let clipOwner = null;
    let owner = null;
    let state = null;
    let clipAnimation = null;
    let opacityAnimation = null;
    let frameAnimation = null;
    let releaseAnimation = null;

    const material = (node) => {
      const style = node && getComputedStyle(node);
      if (!style) return null;
      return {
        backgroundColor:style.backgroundColor,
        backgroundImage:style.backgroundImage,
        backgroundPosition:style.backgroundPosition,
        backgroundSize:style.backgroundSize,
        backgroundRepeat:style.backgroundRepeat,
        backdropFilter:style.webkitBackdropFilter || style.backdropFilter,
        borderColor:style.borderColor,
        borderStyle:style.borderStyle,
        boxShadow:style.boxShadow,
        radiusX:Math.max(0, parseFloat(style.borderTopLeftRadius) || 0),
        radiusY:Math.max(0, parseFloat(style.borderTopLeftRadius) || 0),
      };
    };
    const copyFrameMaterial = (frame, source) => {
      if (!frame || !source) return;
      // The transformed child is only the persistent edge/shadow frame. Never
      // give it a backdrop again: toggling a transformed backdrop at the
      // endpoint forces Chromium to rebuild the whole moving composition.
      frame.style.backgroundColor = "transparent";
      frame.style.backgroundImage = "none";
      frame.style.backgroundPosition = "";
      frame.style.backgroundSize = "";
      frame.style.backgroundRepeat = "";
      frame.style.webkitBackdropFilter = "none";
      frame.style.backdropFilter = "none";
      frame.style.borderColor = source.borderColor;
      frame.style.borderStyle = source.borderStyle;
      frame.style.boxShadow = source.boxShadow;
    };
    const stop = () => {
      clipAnimation?.cancel();
      opacityAnimation?.cancel();
      frameAnimation?.cancel();
      releaseAnimation?.cancel();
      clipAnimation = null;
      opacityAnimation = null;
      frameAnimation = null;
      releaseAnimation = null;
    };
    const finish = () => {
      const frame = state?.frame;
      stop();
      (clipOwner || lens)?.remove();
      lens = null;
      clipOwner = null;
      owner?.classList.remove(ownerClass);
      owner = null;
      state = null;
      if (frame) frame.style.removeProperty("opacity");
    };
    const park = () => {
      if (!lens) return false;
      const frame = state?.frame;
      stop();
      lens.style.opacity = "0";
      lens.dataset.fractalAcrylicPhase = "parked";
      owner?.classList.remove(ownerClass);
      owner = null;
      state = null;
      if (frame) frame.style.removeProperty("opacity");
      return true;
    };
    const clipFor = (rect, surfaceRect, radiusX, radiusY) => {
      const top = Math.max(0, rect.top - surfaceRect.top);
      const right = Math.max(0, surfaceRect.right - rect.right);
      const bottom = Math.max(0, surfaceRect.bottom - rect.bottom);
      const left = Math.max(0, rect.left - surfaceRect.left);
      return `inset(${top.toFixed(2)}px ${right.toFixed(2)}px ${bottom.toFixed(2)}px ${left.toFixed(2)}px round ${Math.max(0, radiusX).toFixed(2)}px / ${Math.max(0, radiusY).toFixed(2)}px)`;
    };
    const prepare = (expander, target, context = {}) => {
      const sourceMaterial = material(target);
      const frame = expander?.querySelector?.(frameSelector);
      copyFrameMaterial(frame, sourceMaterial);
      if (!expander || !target || !context.surface || !sourceMaterial) {
        expander?.classList.remove(ownerClass);
        return null;
      }

      const surfaceRect = context.surface.getBoundingClientRect();
      const sourceRect = target.getBoundingClientRect();
      const destination = context.expRect?.() || { x:surfaceRect.left, y:surfaceRect.top, w:surfaceRect.width, h:surfaceRect.height };
      const destinationRect = {
        left:destination.x,
        top:destination.y,
        right:destination.x + destination.w,
        bottom:destination.y + destination.h,
        width:destination.w,
        height:destination.h,
      };
      const scaleX = Math.max(.0001, sourceRect.width / Math.max(1, destinationRect.width));
      const scaleY = Math.max(.0001, sourceRect.height / Math.max(1, destinationRect.height));
      const sourceClip = clipFor(sourceRect, surfaceRect, sourceMaterial.radiusX, sourceMaterial.radiusY);
      const destinationClip = clipFor(destinationRect, surfaceRect, sourceMaterial.radiusX / scaleX, sourceMaterial.radiusY / scaleY);

      const direction = context.direction || "prewarm";
      const mountedOwner = clipOwner || lens;
      const canReuse = !!lens && mountedOwner?.parentElement === context.surface;
      if (!canReuse) {
        finish();
        owner = expander;
        owner.classList.add(ownerClass);
        lens = document.createElement("span");
        lens.className = lensClass;
        lens.setAttribute("aria-hidden", "true");
        if (holdThroughMotion) {
          // Keep the expensive full-viewport backdrop plane geometrically
          // static and animate only a parent clip. Applying clip-path directly
          // to a backdrop-filter element makes Chromium resize/reallocate the
          // blur pass as the tile grows, which is both slower and visually less
          // stable than masking one precomposed acrylic plane.
          clipOwner = document.createElement("span");
          clipOwner.className = `${lensClass}-clip`;
          clipOwner.setAttribute("aria-hidden", "true");
          clipOwner.appendChild(lens);
          context.surface.appendChild(clipOwner);
        } else {
          clipOwner = null;
          context.surface.appendChild(lens);
        }
      } else {
        stop();
        owner?.classList.remove(ownerClass);
        owner = expander;
        owner.classList.add(ownerClass);
      }
      lens.dataset.fractalAcrylicLens = direction;
      const initialClip = direction === "contract" ? destinationClip : sourceClip;
      const initialOpacity = direction === "prewarm"
        ? ".001"
        : (holdThroughMotion ? "1" : (direction === "expand" ? "1" : "0"));
      const geometryOwner = clipOwner || lens;
      Object.assign(geometryOwner.style, {
        position:"absolute",
        inset:"0",
        zIndex:direction === "contract" ? String(config.contractZIndex ?? 5) : String(config.expandZIndex ?? 4),
        boxSizing:"border-box",
        pointerEvents:"none",
        clipPath:initialClip,
        webkitClipPath:initialClip,
        transform:"translateZ(0)",
        willChange:"clip-path",
        backfaceVisibility:"hidden",
      });
      Object.assign(lens.style, {
        position:"absolute",
        inset:"0",
        boxSizing:"border-box",
        pointerEvents:"none",
        backgroundColor:sourceMaterial.backgroundColor,
        backgroundImage:sourceMaterial.backgroundImage,
        backgroundPosition:sourceMaterial.backgroundPosition,
        backgroundSize:sourceMaterial.backgroundSize,
        backgroundRepeat:sourceMaterial.backgroundRepeat,
        webkitBackdropFilter:sourceMaterial.backdropFilter,
        backdropFilter:sourceMaterial.backdropFilter,
        clipPath:clipOwner ? "none" : initialClip,
        webkitClipPath:clipOwner ? "none" : initialClip,
        // Hover prefetch uploads the exact same backdrop layer before motion.
        // Its .001 coat is visually inert but avoids allocating a full acrylic
        // surface in the first animated frame.
        opacity:initialOpacity,
        transform:"translateZ(0)",
        // Promote the actual material during hover prewarm. In hold mode its
        // separate parent owns clip motion, so this full-screen blur surface
        // never changes geometry during the transition.
        willChange:clipOwner ? "opacity,backdrop-filter" : "clip-path,opacity,backdrop-filter",
        backfaceVisibility:"hidden",
      });
      state = {
        direction,
        sourceClip,
        destinationClip,
        duration:Number(context.morphMs) || 460,
        easing:context.ease || "cubic-bezier(.22, 1, .26, 1)",
        frame,
        clipOwner:geometryOwner,
      };
      lens.dataset.fractalAcrylicPhase = direction === "prewarm" ? "prewarm" : "prepared";
      lens.dataset.fractalAcrylicDirection = direction;
      return lens;
    };
    const start = (direction) => {
      if (!lens || !state || state.direction !== direction) return null;
      stop();
      lens.dataset.fractalAcrylicPhase = "motion";
      lens.dataset.fractalAcrylicDirection = direction;
      const from = direction === "expand" ? state.sourceClip : state.destinationClip;
      const to = direction === "expand" ? state.destinationClip : state.sourceClip;
      clipAnimation = state.clipOwner.animate(
        [{ clipPath:from }, { clipPath:to }],
        { duration:state.duration, easing:state.easing, fill:"forwards" },
      );
      if (holdThroughMotion) {
        // Acrylic is a material, not an opacity cue. Keep its tint and live
        // screen-space backdrop fully owned for every geometric frame. Entry
        // can retain that same owner at the viewport endpoint until an opaque
        // handoff covers it; exit carries it intact back into the source tile.
        lens.style.opacity = "1";
        if (state.frame) state.frame.style.opacity = "1";
      }
      opacityAnimation = lens.animate(
        holdThroughMotion
          ? [{ opacity:1, offset:0 }, { opacity:1, offset:1 }]
          : (direction === "expand"
            ? [{ opacity:1, offset:0 }, { opacity:1, offset:entryHold, easing:releaseEase }, { opacity:0, offset:1 }]
            : [{ opacity:0, offset:0, easing:releaseEase }, { opacity:1, offset:exitReveal }, { opacity:1, offset:1 }]),
        { duration:state.duration, easing:"linear", fill:"forwards" },
      );
      return lens;
    };
    const holdEndpoint = () => {
      if (!holdThroughMotion || !lens || !state) return false;
      const endpointClip = state.direction === "expand" ? state.destinationClip : state.sourceClip;
      stop();
      state.clipOwner.style.clipPath = endpointClip;
      state.clipOwner.style.webkitClipPath = endpointClip;
      lens.style.opacity = "1";
      if (state.frame) state.frame.style.opacity = "1";
      lens.dataset.fractalAcrylicPhase = "endpoint-held";
      return true;
    };
    const release = () => {
      if (!holdThroughMotion || !lens || !state) return Promise.resolve(false);
      const releaseLens = lens;
      const releaseFrame = state.frame;
      const endpointClip = state.direction === "expand" ? state.destinationClip : state.sourceClip;
      clipAnimation?.cancel();
      opacityAnimation?.cancel();
      frameAnimation?.cancel();
      releaseAnimation?.cancel();
      clipAnimation = null;
      opacityAnimation = null;
      frameAnimation = null;
      releaseAnimation = null;
      state.clipOwner.style.clipPath = endpointClip;
      state.clipOwner.style.webkitClipPath = endpointClip;
      releaseLens.style.opacity = "1";
      if (releaseFrame) releaseFrame.style.opacity = "1";
      releaseLens.dataset.fractalAcrylicPhase = "release";
      const timing = { duration:releaseMs, easing:releaseEase, fill:"forwards" };
      const lensFade = releaseLens.animate([{ opacity:1 }, { opacity:0 }], timing);
      const frameFade = releaseFrame?.animate?.([{ opacity:1 }, { opacity:0 }], timing) || null;
      releaseAnimation = lensFade;
      frameAnimation = frameFade;
      return Promise.allSettled([lensFade.finished, frameFade?.finished].filter(Boolean)).then(() => {
        if (lens !== releaseLens || releaseAnimation !== lensFade) return false;
        releaseLens.style.opacity = "0";
        if (releaseFrame) releaseFrame.style.opacity = "0";
        lensFade.cancel();
        frameFade?.cancel?.();
        releaseAnimation = null;
        frameAnimation = null;
        releaseLens.dataset.fractalAcrylicPhase = "released";
        return true;
      });
    };
    const sync = (transformAnimation, startTime) => {
      const initialAnchor = Number(startTime);
      const probeHeld = () => state?.clipOwner?.parentElement?.dataset?.fractalCameraProbeHold === "true";
      if (!Number.isFinite(initialAnchor) || !lens?.isConnected || !state
        || probeHeld()) return false;
      const syncedLens = lens;
      const syncedClip = clipAnimation;
      const syncedOpacity = opacityAnimation;
      const align = () => {
        if (lens !== syncedLens || clipAnimation !== syncedClip || opacityAnimation !== syncedOpacity
          || !syncedLens?.isConnected || probeHeld()) return false;
        const liveStart = Number(transformAnimation?.startTime);
        const liveTime = Number(transformAnimation?.currentTime);
        const anchor = Number.isFinite(liveStart) ? liveStart : initialAnchor;
        let synchronized = false;
        [syncedClip, syncedOpacity].forEach((animation) => {
          // Calendar's native profiler deliberately pauses and seeks the
          // compositor-owned transition. Never disturb that explicit hold, nor
          // an opacity animation a material owner has intentionally cancelled.
          if (!animation || animation.playState === "paused" || animation.playState === "idle"
            || animation.replaceState === "removed") return;
          try {
            animation.startTime = anchor;
            if (Number.isFinite(liveTime)) animation.currentTime = liveTime;
            synchronized = true;
          } catch {}
        });
        return synchronized;
      };
      const synchronized = align();
      // When an actual transform animation supplied the anchor, re-check after
      // pending play tasks resolve. The shared camera normally passes the
      // resolved transform start directly; its effects are already ready then,
      // so another promise/microtask alignment would only add moving-frame work.
      if (transformAnimation) {
        Promise.allSettled([transformAnimation, syncedClip, syncedOpacity]
          .filter(Boolean).map((animation) => animation.ready)).then(align);
      }
      return synchronized;
    };
    const prime = () => {
      if (!lens || !state || state.direction !== "prewarm") return null;
      stop();
      state.clipOwner.style.clipPath = state.destinationClip;
      state.clipOwner.style.webkitClipPath = state.destinationClip;
      lens.style.opacity = ".001";
      lens.dataset.fractalAcrylicPhase = "prewarm";
      // Contract is smooth on first use because its full-viewport, transparent
      // lens receives covered paints before motion. Give expansion the same
      // preparation while the pointer rests over its source tile.
      return lens;
    };
    const status = () => ({
      active:!!lens && ["motion", "endpoint-held", "release"].includes(lens.dataset.fractalAcrylicPhase || ""),
      phase:lens?.dataset?.fractalAcrylicPhase || "",
      direction:lens?.dataset?.fractalAcrylicDirection || state?.direction || "",
      holdThroughMotion,
      releaseMs,
    });
    return { prepare, start, sync, prime, holdEndpoint, release, park, finish, element:() => lens, status };
  };

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
    const keepBelowVisibleDuringJump = config.keepBelowVisibleDuringJump === true;
    const precomposeTransitions = config.precomposeTransitions === true;
    const lockInputDuringTransitions = config.lockInputDuringTransitions === true;
    const delegateClickToOwner = config.delegateClickToOwner === true;
    const contractExpanderAbove = config.contractExpanderAbove === true;
    const holdContractEndpointFrame = config.holdContractEndpointFrame === true;
    const keepExpanderOpaque = config.keepExpanderOpaqueDuringTransition === true;
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
    // Transition material is deliberately separate from the captured room
    // objects. These metrics let a live acrylic layer keep the source tile's
    // exact corner geometry while the camera itself remains transform-only.
    const setSourceGeometry = (expander, target, E = expRect()) => {
      if (!expander || !target) return;
      const rect = target.getBoundingClientRect();
      const style = getComputedStyle(target);
      const scaleX = Math.max(.0001, rect.width / Math.max(1, E.w));
      const scaleY = Math.max(.0001, rect.height / Math.max(1, E.h));
      const radiusX = Math.max(0, parseFloat(style.borderTopLeftRadius) || 0) / scaleX;
      const radiusY = Math.max(0, parseFloat(style.borderTopLeftRadius) || 0) / scaleY;
      expander.style.setProperty("--fractal-source-radius-x", `${radiusX.toFixed(2)}px`);
      expander.style.setProperty("--fractal-source-radius-y", `${radiusY.toFixed(2)}px`);
      expander.style.setProperty("--fractal-camera-morph-ms", `${morphMs}ms`);
      expander.style.setProperty("--fractal-camera-ease", ease);
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
      ease,
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
    const finishTransitionHook = (direction, context, finalize) => {
      let pending = null;
      try { pending = config.onTransitionEnd?.(direction, context); }
      catch (error) {
        console.error(error);
        finalize();
        return;
      }
      if (pending && typeof pending.then === "function") {
        Promise.resolve(pending).then(finalize, (error) => {
          console.error(error);
          finalize();
        });
      } else finalize();
    };
    const settleWaiters = () => {
      const waiters = transitionWaiters;
      transitionWaiters = [];
      waiters.forEach((resolve) => resolve(ctx()));
    };
    const whenSettled = () => transitioning ? new Promise((resolve) => transitionWaiters.push(resolve)) : Promise.resolve(ctx());
    const afterTransform = (el, fn) => {
      let done = false;
      let fallback = 0;
      const finish = () => {
        if (done) return;
        // Native visual probes may hold an already-composited transition at
        // an exact phase. Keep the watchdog armed, but do not let wall-clock
        // fallback teardown race that explicit compositor hold.
        if (surface?.dataset?.fractalCameraProbeHold === "true") {
          clearTimeout(fallback);
          fallback = setTimeout(finish, 16);
          return;
        }
        done = true;
        el.removeEventListener("transitionend", onEnd);
        clearTimeout(fallback);
        fn();
      };
      const onEnd = (event) => {
        if (event.target === el && event.propertyName === "transform") finish();
      };
      el.addEventListener("transitionend", onEnd);
      // Precomposed cameras wait two paints before applying their transform.
      // Starting this watchdog while setup is still pending can make a cold
      // raster hitch consume part of the morph budget and tear the scene down
      // before its CSS transition reaches the endpoint. Arm the listener now,
      // but let the caller start the fallback at the exact transform trigger.
      return () => {
        if (done || fallback) return;
        fallback = setTimeout(finish, morphMs + 35);
      };
    };
    const transitionFrame = (fn) => requestAnimationFrame((frameTime) => {
      if (precomposeTransitions) requestAnimationFrame(fn);
      else fn(frameTime);
    });
    const announceTransformReady = (direction, expander, seq, triggerFrameTime) => {
      let published = false;
      const publish = (startTime, transformAnimation = null) => {
        if (published) return;
        if (seq !== transitionSeq || !transitioning || !expander?.isConnected) return;
        published = true;
        const resolvedStartTime = Number(startTime);
        const transformStartTime = Number.isFinite(resolvedStartTime) ? resolvedStartTime : performance.now();
        const transformContext = {
          ...ctx(),
          expander,
          transformAnimation,
          transformStartTime,
        };
        config.onTransformReady?.(direction, transformContext);
        config.onTransformStart?.(direction, {
          ...transformContext,
          motionStartedAt:performance.now(),
        });
      };
      const resolveStart = (fallbackTime) => {
        const transformAnimation = [...(expander.getAnimations?.({ subtree:false }) || [])]
          .find((animation) => {
            const property = String(animation.transitionProperty || "").replace(/^-webkit-/, "").toLowerCase();
            const keyframes = animation.effect?.getKeyframes?.() || [];
            return animation.effect?.target === expander
              && (property === "transform" || keyframes.some((keyframe) => keyframe.transform != null))
              && animation.playState !== "idle"
              && animation.replaceState !== "removed";
          }) || null;
        const rawStart = transformAnimation?.startTime;
        const rawCurrent = transformAnimation?.currentTime;
        const rawTimeline = document.timeline?.currentTime;
        const start = rawStart == null ? NaN : Number(rawStart);
        const current = rawCurrent == null ? NaN : Number(rawCurrent);
        const timeline = rawTimeline == null ? NaN : Number(rawTimeline);
        publish(Number.isFinite(start)
          ? start
          : (Number.isFinite(timeline) && Number.isFinite(current)
            ? timeline - current
            : fallbackTime), transformAnimation);
      };
      const onTransitionRun = (event) => {
        if (event.target !== expander || event.propertyName !== "transform") return;
        expander.removeEventListener("transitionrun", onTransitionRun);
        // This event runs after style resolution, so the CSS transition already
        // exists and reading its startTime cannot force a style update. Event
        // dispatch itself can lag the actual start by one vblank; the animation
        // clock remains authoritative in both dispatch modes.
        resolveStart(event.timeStamp);
      };
      expander.addEventListener("transitionrun", onTransitionRun);
      requestAnimationFrame((frameTime) => {
        if (published) return;
        expander.removeEventListener("transitionrun", onTransitionRun);
        // Fallback for engines that omit transitionrun. At this rendering
        // boundary the transition is likewise already materialized.
        resolveStart(frameTime || triggerFrameTime);
      });
    };
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
    const navigationInteractionSource = `camera:${apiName || surfaceClass}:navigation`;
    const hoverInteractionSource = `camera:${apiName || surfaceClass}:hover`;
    const navigationDetail = (phase, direction) => ({ apiName, phase, direction, level, state:historyState() });
    const announceNavigation = (phase, direction) => {
      if (!apiName) return;
      if (phase === "start") {
        try { global.crmHomePreviews?.setInteraction?.(false, hoverInteractionSource); } catch {}
      }
      try { global.crmHomePreviews?.setInteraction?.(phase === "start", navigationInteractionSource); } catch {}
      document.dispatchEvent(new CustomEvent("crm:camera-navigation", { detail:navigationDetail(phase, direction) }));
    };
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
      warm.animation?.cancel?.();
      warm.el.remove();
      warm = null;
    };
    const buildExpander = (target) => {
      const E = expRect();
      const source = layoutRect(target, layers[level]);
      const expander = config.buildExpander?.(target, { ...ctx(), sourceRect: source }) || document.createElement("div");
      Object.assign(expander.style, { left: `${E.x}px`, top: `${E.y}px`, width: `${E.w}px`, height: `${E.h}px` });
      expander.dataset.fractalFrame = "viewport";
      setSourceGeometry(expander, target, E);
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
      const E = expRect();
      const rect = target.getBoundingClientRect();
      const sourceTransform = `translate(${(rect.left - E.x).toFixed(2)}px, ${(rect.top - E.y).toFixed(2)}px) scale(${(rect.width / E.w).toFixed(5)}, ${(rect.height / E.h).toFixed(5)})`;
      Object.assign(expander.style, { opacity: "0.001", zIndex: "1", transform:sourceTransform });
      surface.appendChild(expander);
      config.primeExpander?.(expander, target, ctx());
      // Exercise the exact transparent room texture through its compositor
      // scale while the pointer is merely hovering. The first visible camera
      // frame can then reuse an uploaded, transform-ready surface.
      const animation = expander.animate(
        [
          { transform:sourceTransform, offset:0 },
          { transform:"none", offset:.5 },
          { transform:sourceTransform, offset:1 },
        ],
        { duration:96, easing:"linear", fill:"both" },
      );
      const entry = { key, el: expander, animation };
      warm = entry;
      // Once the hover pass has exercised both compositor scales, retire the
      // Web Animation while preserving its final source transform. Cancelling
      // a finished fill-mode animation at click time can otherwise rebuild the
      // promoted layer during the first visible camera frames.
      animation.finished.then(() => {
        if (warm !== entry || !expander.isConnected) return;
        try { animation.commitStyles(); } catch {}
        animation.cancel();
        entry.animation = null;
      }).catch(() => {});
    };
    const expand = (target) => {
      if (!target || !active || transitioning || level >= maxLevel) return;
      announceNavigation("start", "forward");
      config.prepareTarget?.(target, ctx());
      const seq = ++transitionSeq;
      transitioning = true;
      surface.querySelectorAll(`.${config.contractingClass || "fractal-camera-contracting"}`).forEach((el) => el.remove());
      const E = expRect();
      const rect = target.getBoundingClientRect();
      const key = keyOf(target);
      let expander = null;
      if (warm && warm.key === key) {
        warm.animation?.cancel?.();
        expander = warm.el;
        expander.classList.remove(config.warmClass || "fractal-camera-warm");
        warm = null;
      } else {
        dropWarm();
        expander = buildExpander(target);
        surface.appendChild(expander);
      }
      setSourceGeometry(expander, target, E);
      expander.dataset.fractalFrame = "source";
      srcSel[level] = config.sourceSelector?.(target, ctx()) || "";
      Object.assign(expander.style, {
        zIndex: "5",
        pointerEvents: "auto",
        transition: "none",
        opacity: keepExpanderOpaque ? "1" : "0",
        transform: `translate(${(rect.left - E.x).toFixed(2)}px, ${(rect.top - E.y).toFixed(2)}px) scale(${(rect.width / E.w).toFixed(5)}, ${(rect.height / E.h).toFixed(5)})`,
      });
      const below = layers[level];
      below.style.zIndex = "0";
      below.style.pointerEvents = "none";
      const source = layoutRect(target, below);
      // A warm expander may have been built several pointer frames earlier.
      // Refresh source-owned paint immediately before motion so its acrylic
      // handoff carries the material that is actually visible at click time.
      config.configureExpander?.(expander, target, { ...ctx(), sourceRect: source, direction: "expand" });
      const kx = E.w / source.w;
      const ky = E.h / source.h;
      const dive = `translate(${(E.x - below.offsetLeft - source.x * kx).toFixed(2)}px, ${(E.y - below.offsetTop - source.y * ky).toFixed(2)}px) scale(${kx.toFixed(4)}, ${ky.toFixed(4)})`;
      // A second animation frame commits the start styles without forcing a
      // synchronous layout. Cameras without precomposition retain the legacy
      // flush because their transition begins on the next frame.
      if (!precomposeTransitions) void expander.offsetWidth;
      let armTransformFallback = () => {};
      transitionFrame((triggerFrameTime) => {
        config.onTransformPrepare?.("expand", ctx());
        expander.dataset.fractalFrame = "viewport";
        expander.style.transition = keepExpanderOpaque
          ? `transform ${morphMs}ms ${ease}`
          : `transform ${morphMs}ms ${ease}, opacity ${expandFadeMs}ms ease`;
        armTransformFallback();
        expander.style.transform = "none";
        expander.style.opacity = "1";
        below.style.transition = keepBelowVisible
          ? `transform ${morphMs}ms ${ease}`
          : `transform ${morphMs}ms ${ease}, opacity ${belowFadeMs}ms ease`;
        below.style.transform = dive;
        below.style.opacity = keepBelowVisible ? "1" : "0";
        announceTransformReady("expand", expander, seq, triggerFrameTime);
      });
      const oldLevel = level;
      const commit = once(() => {
        level = oldLevel + 1;
        layers[level] = expander;
        surface.dataset.level = String(level);
        config.onLevelChange?.(ctx());
        finishTransitionHook("expand", ctx(), () => {
          if (seq !== transitionSeq) return;
          transitioning = false;
          announceNavigation("settled", "forward");
          settleWaiters();
        });
      });
      config.onTransitionStart?.("expand", ctx());
      armTransformFallback = afterTransform(expander, () => {
        if (seq !== transitionSeq) return;
        expander.style.transition = "none";
        below.style.transition = "none";
        below.style.visibility = "hidden";
        below.style.transform = "none";
        below.style.opacity = "1";
        below.style.pointerEvents = "";
        // Level ownership changes only after the exact transform endpoint is
        // seated. A camera may return a Promise from onTransitionEnd to retain
        // its endpoint cover while the resting tree completes covered paints.
        commit();
      });
    };
    const contract = () => {
      if (!active || level === 0 || transitioning) return;
      announceNavigation("start", "back");
      const seq = ++transitionSeq;
      transitioning = true;
      const expander = layers[level];
      const below = layers[level - 1];
      const selector = srcSel[level - 1] || "";
      const source = selector ? below?.querySelector?.(selector) : null;
      if (!expander || !below || !source) {
        level = Math.max(0, level - 1);
        transitioning = false;
        announceNavigation("settled", "back");
        settleWaiters();
        return;
      }
      const E = expRect();
      const sourceRect = layoutRect(source, below);
      setSourceGeometry(expander, source, E);
      config.configureExpander?.(expander, source, { ...ctx(), sourceRect, direction: "contract" });
      expander.dataset.fractalFrame = "viewport";
      const kx = E.w / sourceRect.w;
      const ky = E.h / sourceRect.h;
      const dive = `translate(${(E.x - below.offsetLeft - sourceRect.x * kx).toFixed(2)}px, ${(E.y - below.offsetTop - sourceRect.y * ky).toFixed(2)}px) scale(${kx.toFixed(4)}, ${ky.toFixed(4)})`;
      const rx = below.offsetLeft + sourceRect.x;
      const ry = below.offsetTop + sourceRect.y;
      below.style.transition = "none";
      // Precomposed cameras get one covered frame at their native scale before
      // the zoomed start transform is applied. The full-screen expander hides
      // that preparation, while Chromium can retain a viewport-scale texture
      // instead of first rasterizing the root at a very large zoom scale.
      below.style.zIndex = precomposeTransitions ? "3" : "5";
      below.style.pointerEvents = lockInputDuringTransitions ? "none" : "auto";
      below.style.transform = precomposeTransitions ? "none" : dive;
      below.style.opacity = keepBelowVisible ? "1" : (config.contractFadeMs != null ? "0" : "1");
      below.style.visibility = "";
      expander.style.transition = "none";
      // Some cameras use the expander as the exact destination image while
      // the live root resolves underneath it. Keep that image above the root
      // until its deliberate final fade instead of exposing an approximate
      // root preview for the entire return trip.
      expander.style.zIndex = contractExpanderAbove ? "6" : "4";
      expander.style.pointerEvents = "none";
      expander.style.opacity = "1";
      expander.classList.add(config.contractingClass || "fractal-camera-contracting");
      const oldLevel = level;
      const commit = once(() => {
        level = oldLevel - 1;
        surface.dataset.level = String(level);
        dropWarm();
        config.onLevelChange?.(ctx());
        // Async endpoint hooks may retain a raster/cut-out while they settle the
        // lower live tree. Give that hook an idempotent way to retire the
        // outgoing full-screen layer *beneath its retained cover*. The generic
        // finalizer remains a safe fallback for cameras without such a bridge.
        const retireOutgoingLayer = once(() => {
          if (layers[oldLevel] === expander) layers[oldLevel] = null;
          expander.remove();
        });
        const transitionContext = {
          ...ctx(),
          outgoingLayer:expander,
          retireOutgoingLayer,
        };
        finishTransitionHook("contract", transitionContext, () => {
          retireOutgoingLayer();
          if (seq !== transitionSeq) return;
          below.style.zIndex = "";
          below.style.pointerEvents = "";
          transitioning = false;
          announceNavigation("settled", "back");
          settleWaiters();
        });
      });
      config.onTransitionStart?.("contract", ctx());
      if (!precomposeTransitions) void below.offsetWidth;
      let armTransformFallback = () => {};
      const beginTransition = (triggerFrameTime) => {
        if (seq !== transitionSeq) return;
        config.onTransformPrepare?.("contract", ctx());
        expander.dataset.fractalFrame = "source";
        below.style.transition = keepBelowVisible
          ? `transform ${morphMs}ms ${ease}`
          : (config.contractFadeMs != null
            ? `transform ${morphMs}ms ${ease}, opacity ${contractFadeMs}ms ease ${contractFadeDelay}ms`
            : `transform ${morphMs}ms ${ease}`);
        below.style.transform = "none";
        below.style.opacity = "1";
        expander.style.transition = keepExpanderOpaque
          ? `transform ${morphMs}ms ${ease}`
          : `transform ${morphMs}ms ${ease}, opacity ${contractFadeMs}ms ease ${contractFadeDelay}ms`;
        armTransformFallback();
        expander.style.transform = `translate(${(rx - E.x).toFixed(2)}px, ${(ry - E.y).toFixed(2)}px) scale(${(sourceRect.w / E.w).toFixed(5)}, ${(sourceRect.h / E.h).toFixed(5)})`;
        expander.style.opacity = keepExpanderOpaque ? "1" : "0";
        announceTransformReady("contract", expander, seq, triggerFrameTime);
      };
      if (precomposeTransitions) requestAnimationFrame(() => {
        if (seq !== transitionSeq) return;
        below.style.zIndex = "5";
        below.style.transform = dive;
        requestAnimationFrame(beginTransition);
      });
      else transitionFrame(beginTransition);
      armTransformFallback = afterTransform(expander, () => {
        if (seq !== transitionSeq) {
          expander.remove();
          return;
        }
        const finish = () => {
          if (seq !== transitionSeq) { expander.remove(); return; }
          commit();
        };
        // A same-task teardown can replace the last animated composition
        // before Chromium paints its exact endpoint. Preserve one complete
        // endpoint paint, then exchange it for the identical resting DOM.
        if (holdContractEndpointFrame) requestAnimationFrame(() => requestAnimationFrame(finish));
        else finish();
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
      expander.dataset.fractalFrame = "viewport";
      srcSel[level] = config.sourceSelector?.(target, ctx()) || "";
      Object.assign(expander.style, { zIndex: "5", pointerEvents: "auto", transition: "none", opacity: "1", transform: "none" });
      surface.appendChild(expander);
      const below = layers[level];
      below.style.zIndex = "0";
      below.style.pointerEvents = "none";
      // Retained camera roots can remain compositor-resident beneath the
      // full-screen lid. Avoid a hide/show boundary before reverse motion.
      below.style.visibility = keepBelowVisibleDuringJump ? "" : "hidden";
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
      srcSel = [];
      layers[0].classList.add(layerClass);
      surface.replaceChildren(layers[0]);
      level = 0;
      surface.dataset.level = "0";
      layout();
      config.onLevelChange?.(ctx());
    };
    // Restore the already-rendered root after an adopted transition lid has
    // been removed. This avoids throwing away decoded images and compositor
    // layers merely to return the camera to level zero.
    const restoreRoot = () => {
      ensure();
      dropWarm();
      transitionSeq += 1;
      const root = layers[0];
      layers.slice(1).forEach((el) => el?.remove?.());
      if (!root) { rebuildRoot(); return; }
      [...surface.children].forEach((child) => { if (child !== root) child.remove(); });
      Object.assign(root.style, {
        zIndex: "", pointerEvents: "", transition: "none", visibility: "",
        transform: "none", opacity: "1",
      });
      layers = [root];
      srcSel = [];
      level = 0;
      transitioning = false;
      surface.dataset.level = "0";
      config.onLevelChange?.(ctx());
      settleWaiters();
    };
    const refresh = () => {
      if (!surface) return;
      rebuildRoot();
    };
    function historyState() {
      return { level, selectors:srcSel.slice(0, level) };
    }
    const restoreHistoryState = async (state = {}) => {
      ensure();
      await whenSettled();
      const selectors = Array.isArray(state.selectors)
        ? state.selectors.slice(0, maxLevel).map((selector) => String(selector || ""))
        : [];
      let common = 0;
      while (common < level && common < selectors.length && srcSel[common] === selectors[common]) common += 1;
      while (level > common) {
        contract();
        await whenSettled();
      }
      for (let index = level; index < selectors.length; index += 1) {
        const selector = selectors[index];
        const target = selector ? layers[level]?.querySelector?.(selector) : null;
        if (!target) break;
        expand(target);
        await whenSettled();
      }
      return historyState();
    };
    const setActive = (on) => {
      active = !!on;
      ensure();
      surface.hidden = !active;
      if (!active) {
        dropWarm();
        try { global.crmHomePreviews?.setInteraction?.(false, hoverInteractionSource); } catch {}
      }
      else layout();
      config.onActiveChange?.(active, ctx());
      return api;
    };
    const onClick = (event) => {
      if (!active || !surface || surface.hidden) return;
      if (event.target?.closest?.(ignoreSelector)) return;
      // Some cameras have an outer navigation coordinator that must complete
      // covered preflight work before calling expand(). Let that owner consume
      // the same event instead of starting an uncoordinated camera first.
      if (delegateClickToOwner) return;
      const target = targetFromEvent(event) || targetAtPoint(event.clientX, event.clientY);
      if (!target) return;
      event.preventDefault();
      expand(target);
    };
    const onMouseMove = (event) => {
      if (!active || !surface || surface.hidden) return;
      const target = targetAtPoint(event.clientX, event.clientY);
      try { global.crmHomePreviews?.setInteraction?.(!!target, hoverInteractionSource); } catch {}
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
      restoreRoot,
      dropWarm,
      layout,
      historyState,
      restoreHistoryState,
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
