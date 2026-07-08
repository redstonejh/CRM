// ticket-feed.js — the ticketing app's data feed (the analogue of status-feed.js,
// but for tickets instead of monitoring data). It reads window.tickets (the
// API-backed compatibility bridge exposed by the preload) and pushes the chosen ticket
// into the dashboard widget runtime, keyed to the ticket widget's data-widget-key
// ("ticket-card"). The "ticket" widget definition (widget-registry.js) renders it.
//
// Keyed ingest (not "default") matters: status-feed.js still ingests an empty
// "*" default, and a keyed entry is resolved ahead of "*", so the ticket survives.
(() => {
  const WIDGET_KEY = "ticket-card";

  // Show the most relevant ticket: a ticket the user dragged onto the grid (pinned) wins;
  // otherwise the first still-open one, else the newest.
  const pickTicket = (tickets) => {
    if (!Array.isArray(tickets) || !tickets.length) return null;
    const pin = window.__ticketGridPin;
    if (pin) { const p = tickets.find((t) => t && t.id === pin); if (p) return p; }
    return tickets.find((t) => t && t.state !== "resolved") || tickets[0];
  };

  const ingest = (tickets) => {
    const runtime = window.dashboardWidgetDataRuntime;
    if (!runtime || typeof runtime.ingest !== "function") return false;
    const pick = pickTicket(tickets);
    runtime.ingest({ widgets: { [WIDGET_KEY]: { rows: pick ? [pick] : [] } } });
    return true;
  };

  // Tri-state signal for the widget: undefined = still loading (render NOTHING, never a
  // grey "no ticket" flash); true = the backend genuinely has zero tickets (show the
  // "No tickets yet" message); false = a ticket exists. Only flips to a definite value
  // once we've actually heard back from the backend.
  const markLoaded = (tickets) => { window.__ticketsKnownEmpty = !pickTicket(tickets); };

  let latest = [];
  // The widget runtime (app.js) comes up asynchronously — retry the first paint
  // until it exists, the same way status-feed.js waits for it.
  const flushWhenReady = (tries = 0) => {
    if (ingest(latest)) return;
    if (tries > 150) return;
    setTimeout(() => flushWhenReady(tries + 1), 100);
  };

  const start = async () => {
    let loaded = false;
    try {
      const res = await window.tickets?.list?.();
      latest = (res && res.tickets) || [];
      loaded = true;
    } catch { latest = []; }
    // Only declare "known empty" once the backend has actually answered — a failed
    // list() leaves the signal undefined (loading) so the card stays blank, not grey.
    if (loaded) markLoaded(latest);
    flushWhenReady();
    // The widget may hydrate AFTER the first ingest; re-ingest a few times so the
    // card reliably shows its data regardless of the hydration race.
    [400, 1200, 2500].forEach((ms) => setTimeout(() => ingest(latest), ms));
    // Live updates: the backend pushes the full ticket list on any change.
    window.tickets?.onChanged?.((payload) => {
      latest = (payload && payload.tickets) || [];
      markLoaded(latest);
      ingest(latest);
    });
  };

  // Let the corner ticket stacks drop a ticket onto the dashboard grid: pin it so it shows
  // in the grid ticket widget and survives subsequent feed updates.
  window.ticketGrid = {
    show: (t) => {
      if (!t || !t.id) return;
      window.__ticketGridPin = t.id;
      ingest(latest && latest.length ? latest : [t]);
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
