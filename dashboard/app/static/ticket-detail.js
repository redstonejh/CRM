// ticket-detail.js — ticket instance of the reusable card detail flyout.
(() => {
  const severityRgb = {
    low: "34,211,238",
    medium: "250,204,21",
    high: "249,115,22",
    critical: "239,68,68",
    none: "120,130,140",
  };

  if (typeof window.createCrmCardDetail !== "function") {
    console.error("[CRM] card-detail factory is not loaded");
    return;
  }

  window.createCrmCardDetail({
    apiName: "ticketDetail",
    source: window.tickets,
    priorities: ["low", "medium", "high", "critical"],
    severityRgb,
  });
})();
