// Shared selected-client scope. CDMS remains authoritative; this object stores
// only the user's current navigation choice and helps existing CRM rooms filter
// records that already reference that client.
(() => {
  const STORE_KEY = "crm-selected-cdms-client-v1";
  const listeners = new Set();
  let current = null;

  const clone = (value) => value == null
    ? null
    : (typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)));
  const text = (value) => String(value ?? "").trim();
  const normalize = (client) => {
    if (!client) return null;
    const code = text(client.code || client.value || client.companyCode || client.cdmsClient || client.sourceId);
    if (!code) return null;
    return {
      id:text(client.id) || `cdms-client-${code.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      code,
      label:text(client.label || client.name || client.title || code),
      group:text(client.group),
    };
  };
  const stored = (() => {
    try { return normalize(JSON.parse(localStorage.getItem(STORE_KEY) || "null")); }
    catch { return null; }
  })();
  current = stored;

  const persist = () => {
    try {
      if (current) localStorage.setItem(STORE_KEY, JSON.stringify(current));
      else localStorage.removeItem(STORE_KEY);
    } catch {}
    void window.crmCdms?.preferences?.({
      method:"PUT",
      key:"selected-client",
      body:{ value:current?.code || "" },
    });
  };
  const announce = (reason) => {
    const detail = { client:clone(current), reason };
    listeners.forEach((listener) => {
      try { listener(detail); } catch {}
    });
    document.dispatchEvent(new CustomEvent("crm:client-context-changed", { detail }));
  };
  const select = (client, options = {}) => {
    const next = normalize(client);
    if (!next) return null;
    const changed = next.code !== current?.code || next.label !== current?.label;
    current = next;
    if (options.persist !== false) persist();
    if (changed || options.force) announce(options.reason || "select");
    return clone(current);
  };
  const clear = (options = {}) => {
    if (!current) return null;
    current = null;
    if (options.persist !== false) persist();
    announce(options.reason || "clear");
    return null;
  };
  const recordClientCode = (record = {}) => text(
    record.cdmsClient || record.companyCode || record.clientCode || record.Client
      || record.client || record.abbrv || record.meta?.companyCode,
  );
  const recordCompanyId = (record = {}) => text(
    record.companyId || record.cdmsCompanyId || record.meta?.companyId,
  );
  const matches = (record) => {
    if (!current) return true;
    const code = recordClientCode(record);
    if (code) return code.toLowerCase() === current.code.toLowerCase();
    const companyId = recordCompanyId(record);
    return !!companyId && companyId === current.id;
  };
  const filter = (records) => (Array.isArray(records) ? records : []).filter(matches);
  const onChanged = (listener) => {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  window.crmClientContext = {
    select,
    clear,
    current:() => clone(current),
    code:() => current?.code || "",
    matches,
    filter,
    onChanged,
  };
})();
