// crm-cold-front.js - derived relationship staleness for cards and Today.
(() => {
  const valueOf = (record, key) => {
    const meta = record?.meta && typeof record.meta === "object" ? record.meta : {};
    return record && record[key] != null && record[key] !== "" ? record[key] : meta[key];
  };

  const firstText = (...values) => {
    for (const value of values) {
      const text = String(value ?? "").trim();
      if (text) return text;
    }
    return "";
  };

  const timestampOf = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const text = String(value ?? "").trim();
    if (/^\d{10,}$/.test(text)) {
      const numeric = Number(text);
      if (Number.isFinite(numeric)) return numeric;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const stateOf = (record) => String(firstText(valueOf(record, "state"), valueOf(record, "status"))).toLowerCase();
  const dealStage = (record) => String(firstText(valueOf(record, "stage"), valueOf(record, "pipelineStage"), stateOf(record), "lead"))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "lead";

  const touchTime = (record, entity) => timestampOf(firstText(
    valueOf(record, "lastTouchAt"),
    valueOf(record, "lastContactAt"),
    entity === "invoices" ? valueOf(record, "sentAt") : "",
    valueOf(record, "createdAt"),
    valueOf(record, "updatedAt"),
  ));

  const halfLifeDays = (record, entity) => {
    if (entity === "contacts") return 21;
    if (entity === "deals") return dealStage(record) === "proposal" ? 5 : 10;
    if (entity === "invoices") return ["sent", "overdue"].includes(stateOf(record)) ? 5 : 0;
    return 0;
  };

  const staleness = (record, entity, now = Date.now()) => {
    const halfLife = halfLifeDays(record, entity);
    if (!record || !halfLife) return 0;
    const touch = touchTime(record, entity);
    if (!touch) return 1;
    const days = Math.max(0, (now - touch) / 86400000);
    return Math.max(0, Math.min(1, days / halfLife));
  };

  const isTripped = (record, entity, now = Date.now()) => staleness(record, entity, now) >= 1;

  window.crmColdFront = {
    valueOf,
    timestampOf,
    stateOf,
    dealStage,
    staleness,
    isTripped,
  };
})();
