// crm-next-touch.js - shared Next-Touch Law helpers for card-detail configs.
(() => {
  const valueOf = (record, key) => {
    const meta = record?.meta && typeof record.meta === "object" ? record.meta : {};
    return record && record[key] != null && record[key] !== "" ? record[key] : meta[key];
  };

  const localDate = (date = new Date()) => {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };

  const dateOnly = (value) => {
    const text = String(value ?? "").trim();
    const direct = /^(\d{4}-\d{2}-\d{2})/.exec(text);
    if (direct) return direct[1];
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? localDate(new Date(parsed)) : "";
  };

  const today = () => localDate();
  const futureOrToday = (value) => {
    const date = dateOnly(value);
    return !!date && date >= today();
  };
  const waivedToday = (record) => dateOnly(valueOf(record, "nextTouchWaivedAt")) === today();

  const refsFor = (entity, record) => {
    const refs = [];
    const seen = new Set();
    const arrayOf = (key) => {
      const value = valueOf(record, key);
      return Array.isArray(value) ? value : [];
    };
    const add = (refEntity, id) => {
      const cleanId = String(id || "").trim();
      if (!refEntity || !cleanId) return;
      const key = `${refEntity}:${cleanId}`;
      if (seen.has(key)) return;
      seen.add(key);
      refs.push({ entity: refEntity, id: cleanId });
    };
    add(entity, record?.id);
    arrayOf("relatedContactIds").forEach((id) => add("contacts", id));
    arrayOf("relatedDealIds").forEach((id) => add("deals", id));
    arrayOf("relatedInvoiceIds").forEach((id) => add("invoices", id));
    add("contacts", valueOf(record, "contactId"));
    add("deals", valueOf(record, "dealId"));
    add("companies", valueOf(record, "companyId"));
    add("invoices", valueOf(record, "invoiceId"));
    return refs;
  };

  const recordsFrom = (result) => Array.isArray(result) ? result : ((result && (result.records || result.tickets)) || []);
  const closedTaskStates = new Set(["resolved", "done", "closed", "complete", "completed", "cancelled", "canceled", "archived"]);
  const firstText = (...values) => {
    for (const value of values) {
      const text = String(value ?? "").trim();
      if (text) return text;
    }
    return "";
  };
  const taskDate = (task) => firstText(
    valueOf(task, "dueDate"),
    valueOf(task, "scheduledDate"),
    valueOf(task, "calendarDate"),
    valueOf(task, "startDate"),
    valueOf(task, "at"),
  );
  const relatedEntityKeys = {
    contacts: ["contactId", "relatedContactIds"],
    deals: ["dealId", "relatedDealIds"],
    invoices: ["invoiceId", "relatedInvoiceIds"],
  };
  const taskRelatesTo = (task, entity, record) => {
    const id = String(record?.id || "").trim();
    if (!entity || !id) return false;
    const relatedValue = valueOf(task, "relatedIds");
    const relatedIds = Array.isArray(relatedValue) ? relatedValue : [];
    if (relatedIds.some((ref) => String(ref?.entity || "") === entity && String(ref?.id || "") === id)) return true;
    const keys = relatedEntityKeys[entity] || [];
    return keys.some((key) => {
      const value = valueOf(task, key);
      return Array.isArray(value) ? value.map(String).includes(id) : String(value || "").trim() === id;
    }) || (Array.isArray(record?.relatedTaskIds) && record.relatedTaskIds.map(String).includes(String(task?.id || "")));
  };
  const hasScheduledRelatedTask = async (entity, record) => {
    if (!entity || !record?.id || !window.tasks?.list) return false;
    try {
      const result = await window.tasks.list({ includeDeleted: true });
      return recordsFrom(result).some((task) => {
        if (!task || task.deletedAt || closedTaskStates.has(String(valueOf(task, "state") || valueOf(task, "status") || "").toLowerCase())) return false;
        return taskRelatesTo(task, entity, record) && futureOrToday(taskDate(task));
      });
    } catch {
      return false;
    }
  };

  const ensureOk = (result, fallback) => {
    if (result && result.ok === false) throw new Error(result.error || fallback || "Request failed");
    return result;
  };

  const shouldPrompt = async (record, { entity, isClosed } = {}) => {
    if (!record || record.deletedAt || waivedToday(record)) return false;
    if (typeof isClosed === "function" && isClosed(record)) return false;
    if (futureOrToday(valueOf(record, "nextTouchAt")) || futureOrToday(valueOf(record, "scheduledDate"))) return false;
    return !(await hasScheduledRelatedTask(entity, record));
  };

  const schedule = async ({ entity, bridge, record, date, mode }) => {
    if (!entity || !bridge || !record?.id || !date) return;
    ensureOk(await bridge.update?.(record.id, {
      nextTouchAt: date,
      scheduledDate: date,
      nextTouchWaivedAt: null,
    }), "Could not set next touch");
    const relatedIds = refsFor(entity, record);
    ensureOk(await window.interactions?.create?.({
      kind: "next-touch",
      note: `Next touch scheduled for ${date}${mode ? ` (${mode})` : ""}`,
      at: new Date().toISOString(),
      relatedIds,
    }), "Could not log next touch");
  };

  const letGo = async ({ entity, bridge, record }) => {
    if (!entity || !bridge || !record?.id) return;
    ensureOk(await bridge.update?.(record.id, {
      nextTouchWaivedAt: new Date().toISOString(),
    }), "Could not dismiss next touch");
    ensureOk(await window.interactions?.create?.({
      kind: "next-touch-waived",
      note: "Next touch dismissed",
      at: new Date().toISOString(),
      relatedIds: refsFor(entity, record),
    }), "Could not log dismissal");
  };

  window.crmNextTouch = {
    valueOf,
    dateOnly,
    localDate,
    futureOrToday,
    waivedToday,
    refsFor,
    hasScheduledRelatedTask,
    shouldPrompt,
    schedule,
    letGo,
  };
})();
