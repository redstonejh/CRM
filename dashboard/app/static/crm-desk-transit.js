// crm-desk-transit.js - the desk's one navigation choreographer (BLUEPRINT A1).
// The Desk is a single continuous place and the camera is how you move through
// it: every module switch is a dive through the Home bucket lids, never a cut.
// This module is a motion coordinator, not a new UI species — it drives the
// existing home fractal camera (expand/contract) and lets crm-workspaces'
// setActive remain the instant commit primitive, called only at choreography
// boundaries (and at boot/restore, which is not navigation).
(() => {
  const MORPH_MS = 460;             // the house morph — fractal-camera's own default
  const SETTLE_MS = MORPH_MS + 80;  // morph + the camera's transitionend fallback slack
  const LID_FADE_MS = 180;          // the lid unfrosts off the revealed module

  let busy = false;
  let queued = null;

  const ensureStyles = () => {
    if (document.getElementById("crm-desk-transit-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-desk-transit-styles";
    style.textContent = `
      /* The veil carries the fully-dived bucket lid for one beat while the
         destination theater takes the stage beneath its frost, then fades. */
      .crm-transit-veil { position: fixed; inset: 0; z-index: 4500; pointer-events: none;
        opacity: 1; transition: opacity ${LID_FADE_MS}ms ease; }
    `;
    document.head.appendChild(style);
  };

  const camera = () => window.crmHomeCamera;
  const commit = (key) => window.crmWorkspaces?.setActive?.(key);
  const bucketFor = (key) => {
    const layer = camera()?.layers?.()[0];
    return layer?.querySelector?.(`.crm-home-bucket[data-module="${key}"]`) || null;
  };

  // The dive-in ending: the expanded lid keeps covering the stage while the
  // destination theater is committed beneath it, then unfrosts away. The swap
  // happens behind blur(28px) glass — continuous to the eye, never a cut.
  const finishDiveIn = async (key, done) => {
    const cam = camera();
    const surface = cam?.surface?.();
    const lid = cam?.level?.() >= 1 ? cam.layers()[1] : null;
    let veil = null;
    if (lid) {
      ensureStyles();
      veil = document.createElement("div");
      veil.className = "crm-transit-veil";
      veil.appendChild(lid);   // adopt the lid out of the camera so the theater toggle can't hide it
      document.body.appendChild(veil);
    }
    commit(key);
    // Keep the settled full-viewport baseline over the theater until the real
    // destination has completed its own render. Because both share the same
    // coordinates, the only visible release is the acrylic material itself.
    try { await window.crmHome?.waitForModuleSettled?.(key); } catch {}
    if (veil) {
      requestAnimationFrame(() => { veil.style.opacity = "0"; });
      setTimeout(() => {
        veil.remove();
        cam?.rebuildRoot?.();                 // home camera rests at level 0, ready for the next dive
        if (surface) surface.style.zIndex = "";
        done();
      }, LID_FADE_MS + 40);
    } else {
      cam?.rebuildRoot?.();
      if (surface) surface.style.zIndex = "";
      done();
    }
  };

  // Home (active, level 0) → module: play the home camera's own dive, commit at
  // completion — the 180ms mid-flight cut this replaces was the build failure.
  const diveIn = (key, done, expandFirst = true) => {
    const cam = camera();
    const bucket = bucketFor(key);
    if (!cam || !bucket) { commit(key); done(); return; }
    const surface = cam.surface();
    if (surface) surface.style.zIndex = "4500";   // the lid must cover module chrome during the reveal
    if (expandFirst) {
      if (cam.level() > 0) cam.rebuildRoot();
      cam.expand(bucket);
    }
    Promise.resolve(cam.whenSettled?.()).then(() => finishDiveIn(key, done));
  };

  // Module → Home: seat the module's own bucket lid over the stage at full
  // size (jumpTo), commit Home behind its frost, then contract() flies the lid
  // back into its Home slot — the identical camera move, reversed.
  const diveOut = async (fromKey, done) => {
    const cam = camera();
    try { window.crmHome?.setActive?.(true); } catch {}
    if (!cam) { commit("home"); done(); return; }
    try { await window.crmHome?.captureBaseline?.(fromKey, { mount: true }); } catch {}
    if (cam.level() > 0) cam.rebuildRoot();
    const bucket = bucketFor(fromKey);
    const surface = cam.surface();
    if (!bucket || !cam.jumpTo?.(bucket)) { commit("home"); done(); return; }
    if (surface) surface.style.zIndex = "4500";
    commit("home");   // the module vanishes behind the full-screen lid, same frame
    requestAnimationFrame(() => {
      cam.back();     // 460ms house contract into the Home slot
      Promise.resolve(cam.whenSettled?.()).then(() => {
        if (surface) surface.style.zIndex = "";
        done();
      });
    });
  };

  const driveTo = (key) => new Promise((resolve) => {
    const ws = window.crmWorkspaces;
    if (!ws || !(ws.modules?.() || []).some((module) => module.key === key)) { resolve(false); return; }
    const current = ws.active?.();
    if (busy) { queued = { key, resolve }; return; }
    if (key === current) { resolve(true); return; }
    busy = true;
    const done = () => {
      busy = false;
      resolve(true);
      const next = queued;
      queued = null;
      if (next) driveTo(next.key).then(next.resolve);
    };
    try {
      if (current === "home") diveIn(key, done);
      else if (key === "home") diveOut(current, done);
      else diveOut(current, () => diveIn(key, done));   // neighbors on the desk: out through Home, in again
    } catch {
      commit(key);   // motion failed — state must still be correct
      done();
    }
  });

  // A dive the home camera already started (a bucket click — the camera's own
  // onClick ran expand): adopt its ending instead of starting a second one.
  const adoptDive = (key) => new Promise((resolve) => {
    const ws = window.crmWorkspaces;
    if (!ws || busy) { resolve(false); return; }
    busy = true;
    const surface = camera()?.surface?.();
    if (surface) surface.style.zIndex = "4500";
    const done = () => {
      busy = false;
      resolve(true);
      const next = queued;
      queued = null;
      if (next) driveTo(next.key).then(next.resolve);
    };
    Promise.resolve(camera()?.whenSettled?.()).then(() => finishDiveIn(key, done));
  });

  // B / Esc backs out to Home from any camera-less module. Camera surfaces
  // (calendar) chain through their own onRootBack; overlays that own the key
  // (detail panel, menus, search deck, company dive, an open trash
  // bin) always win — the desk never navigates out from under an open hand.
  const overlayOwnsKeys = (key) => {
    if (window.crmCompanyDive?.isActive?.()) return true;
    if (window.crmSearchDeck?.isOpen?.()) return true;
    if (document.querySelector(".ticket-detail-overlay:not([hidden]), .tk-menu")) return true;
    if (key === "Escape" && document.querySelector("section[data-crm-theater]:not([hidden]) .tk-stack-btn.is-active")) return true;
    return false;
  };
  document.addEventListener("keydown", (event) => {
    if (event.key !== "b" && event.key !== "B" && event.key !== "Escape") return;
    if (event.defaultPrevented) return;
    const target = event.target;
    if (target && (/INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable)) return;
    const current = document.body.dataset.crmModule || "home";
    if (current === "home" || current === "calendar") return;   // home is root; calendar's camera owns its chain
    if (busy || overlayOwnsKeys(event.key)) return;
    driveTo("home");
  });

  window.crmDeskTransit = {
    driveTo,
    adoptDive,
    isBusy: () => busy,
  };
})();
