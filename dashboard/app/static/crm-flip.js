// crm-flip.js - the product's second signature (BLUEPRINT A5): a won deal
// dropped on Money turns over mid-flight and lands in Draft as an invoice,
// pre-filled. Built as MOTION from existing parts — the desk transit's glide,
// the dropIntoZone landing trick, and a two-faced 3D card — never a dialog.
(() => {
  const EASE = "cubic-bezier(.22, 1, .26, 1)";
  const MORPH_MS = 460;

  const ensureStyles = () => {
    if (document.getElementById("crm-flip-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-flip-styles";
    style.textContent = `
      /* The flyer is OPAQUE (no backdrop-filter under a 3D transform — the
         td-flyer lesson) and carries two faces: the deal in front, the invoice
         pre-rotated behind. Turning the inner 180° over the flight is the flip. */
      .crm-flip-flyer { position: fixed; z-index: 6200; pointer-events: none; perspective: 1200px;
        transform-origin: top left; transition: transform ${MORPH_MS}ms ${EASE}; }
      .crm-flip-inner { position: absolute; inset: 0; transform-style: preserve-3d;
        transition: transform ${MORPH_MS}ms ${EASE}; }
      .crm-flip-face { position: absolute; inset: 0; box-sizing: border-box; overflow: hidden;
        -webkit-backface-visibility: hidden; backface-visibility: hidden;
        border-radius: 15px; padding: 14px 15px; color: #fff; display: flex; flex-direction: column; gap: 6px;
        background-color: rgb(74, 84, 101);
        background-image: linear-gradient(180deg, rgba(83,95,117,0.9), rgba(33,41,56,0.94));
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.22), 0 18px 42px rgba(0,0,0,0.45); }
      .crm-flip-face.is-back { transform: rotateY(180deg); }
      .crm-flip-face::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px;
        background: var(--flip-accent, transparent); }
      .crm-flip-title { font-weight: 800; font-size: 0.95rem; line-height: 1.2; }
      .crm-flip-amount { font-weight: 800; font-size: 1.35rem; }
      .crm-flip-sub { font-size: 0.78rem; color: rgba(255,255,255,0.62); }
    `;
    document.head.appendChild(style);
  };

  const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[char]));
  const amountText = (value) => {
    const amount = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(amount) && amount ? `$${amount.toLocaleString()}` : "";
  };
  const titleOf = (record) => String(record?.client || record?.title || record?.name || "Untitled");

  const waitFor = (probe, timeout = 2400, every = 90) => new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const found = probe();
      if (found) return resolve(found);
      if (Date.now() - t0 > timeout) return resolve(null);
      setTimeout(tick, every);
    };
    tick();
  });

  // The one motion: create the invoice through the real bridge FIRST (release
  // is save — motion never outruns truth), then glide to Money under the
  // flyer, turn it over, and land it on the real Draft card.
  const play = async ({ record, fromRect, target }) => {
    if (!record || !fromRect || !target?.build) return false;
    const fields = (() => { try { return target.build(record); } catch { return null; } })();
    if (!fields) return false;
    let created = null;
    try { created = await window.invoices?.create?.(fields); } catch { created = null; }
    const invoice = created?.record || (created?.id ? created : null);
    if (!invoice || created?.ok === false) return false;   // no orphan motion on failure
    // One write, three truths: link the deal to its invoice and log the
    // interaction — the server fan-out stamps lastTouchAt on both.
    try {
      const related = Array.isArray(record.relatedInvoiceIds) ? record.relatedInvoiceIds : [];
      await window.deals?.update?.(record.id, { invoiceId: invoice.id, relatedInvoiceIds: [...related, invoice.id] });
    } catch {}
    try {
      await window.interactions?.create?.({
        kind: "invoice",
        note: `Invoice drafted from won deal "${titleOf(record)}"`,
        at: new Date().toISOString(),
        relatedIds: [
          { entity: "deals", id: record.id },
          { entity: "invoices", id: invoice.id },
          ...(record.companyId ? [{ entity: "companies", id: record.companyId }] : []),
        ],
      });
    } catch {}

    ensureStyles();
    const flyer = document.createElement("div");
    flyer.className = "crm-flip-flyer";
    Object.assign(flyer.style, {
      left: `${Math.round(fromRect.left)}px`, top: `${Math.round(fromRect.top)}px`,
      width: `${Math.round(fromRect.width)}px`, height: `${Math.round(fromRect.height)}px`,
    });
    flyer.innerHTML = `
      <div class="crm-flip-inner">
        <div class="crm-flip-face" style="--flip-accent: rgba(234,88,12,0.9)">
          <div class="crm-flip-title">${esc(titleOf(record))}</div>
          <div class="crm-flip-amount">${esc(amountText(record?.amount ?? record?.value))}</div>
          <div class="crm-flip-sub">Won deal</div>
        </div>
        <div class="crm-flip-face is-back" style="--flip-accent: rgba(148,163,184,0.55)">
          <div class="crm-flip-amount">${esc(amountText(fields.amount))}</div>
          <div class="crm-flip-title">${esc(String(fields.title || fields.client || "Invoice"))}</div>
          <div class="crm-flip-sub">Draft invoice</div>
        </div>
      </div>`;
    document.body.appendChild(flyer);

    // Glide the desk to Money beneath the flyer (module→module through Home).
    try { await window.crmDeskTransit?.driveTo?.(target.module); } catch {}
    const dest = await waitFor(() => {
      const el = document.querySelector(`[data-crm-theater="${target.module}"] .tk-zcard[data-id="${CSS.escape(invoice.id)}"]`);
      return el && el.getBoundingClientRect().width > 4 ? el : null;
    });
    const inner = flyer.querySelector(".crm-flip-inner");
    if (!dest) {   // state is already correct — settle the flyer out quietly
      flyer.style.transition = `opacity 240ms ease`;
      flyer.style.opacity = "0";
      setTimeout(() => flyer.remove(), 280);
      return true;
    }
    const to = dest.getBoundingClientRect();
    dest.style.opacity = "0";   // the real card waits under the landing clone (the dropIntoZone trick)
    requestAnimationFrame(() => {
      flyer.style.transform = `translate(${Math.round(to.left - fromRect.left)}px, ${Math.round(to.top - fromRect.top)}px) scale(${(to.width / fromRect.width).toFixed(4)}, ${(to.height / fromRect.height).toFixed(4)})`;
      inner.style.transform = "rotateY(180deg)";   // the turnover rides the flight
    });
    setTimeout(() => {
      flyer.remove();
      if (dest.isConnected) dest.style.opacity = "";
    }, MORPH_MS + 80);
    return true;
  };

  window.crmFlip = { play };
})();
