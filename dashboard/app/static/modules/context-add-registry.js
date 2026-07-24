const providers = new Map();

export const currentContext = () => {
  const module = String(
    document.body?.dataset?.crmModule ||
    window.crmWorkspaces?.active?.() ||
    "home"
  );
  if (module !== "planner") return { module, contextKey: module };
  const view = String(window.crmPlanner?.view?.() || "projects");
  return {
    module,
    view,
    contextKey: view === "project" ? "planner:project" : "planner:projects",
  };
};

const providerResult = (provider, context) => {
  if (typeof provider === "function") return provider(context);
  if (typeof provider?.snapshot === "function") return provider.snapshot(context);
  return provider || null;
};

const normalizeAction = (action, index, group = "") => {
  if (!action || action.hidden) return null;
  const id = String(action.id || `action-${index}`);
  const children = Array.isArray(action.children)
    ? action.children.map((child, childIndex) => normalizeAction(child, childIndex, id)).filter(Boolean)
    : [];
  return {
    id,
    label: String(action.label || "Add"),
    description: String(action.description || ""),
    group: String(action.group || group || ""),
    kind: String(action.kind || ""),
    disabled: Boolean(action.disabled),
    children,
  };
};

const normalizeSnapshot = (value, context) => {
  const result = value && typeof value === "object" ? value : {};
  const actions = Array.isArray(result.actions)
    ? result.actions.map((action, index) => normalizeAction(action, index)).filter(Boolean)
    : [];
  return {
    contextKey: String(result.contextKey || context.contextKey),
    label: String(result.label || context.module || "Current view"),
    actions,
  };
};

const rawSnapshot = async (context = currentContext()) => {
  const provider = providers.get(context.contextKey) || providers.get(context.module);
  return {
    context,
    provider,
    value: await Promise.resolve(providerResult(provider, context)),
  };
};

const findAction = (actions, actionId) => {
  for (const action of actions || []) {
    if (String(action?.id) === actionId) return action;
    const child = findAction(action?.children, actionId);
    if (child) return child;
  }
  return null;
};

export const refresh = (reason = "changed") => {
  document.dispatchEvent(new CustomEvent("crm:add-context-changed", {
    detail: { ...currentContext(), reason },
  }));
};

export const register = (contextKey, provider) => {
  const definition = contextKey && typeof contextKey === "object" && !provider ? contextKey : null;
  const key = String(definition?.contextKey || definition?.id || contextKey || "").trim();
  const value = definition || provider;
  if (!key || !value) return () => {};
  providers.set(key, value);
  refresh("provider-registered");
  return () => {
    if (providers.get(key) === value) {
      providers.delete(key);
      refresh("provider-removed");
    }
  };
};

export const snapshot = async () => {
  const resolved = await rawSnapshot();
  return normalizeSnapshot(resolved.value, resolved.context);
};

export const execute = async (actionId, options = {}) => {
  const id = String(actionId || "");
  const resolved = await rawSnapshot();
  if (!resolved.provider) return false;
  const rawActions = Array.isArray(resolved.value?.actions) ? resolved.value.actions : [];
  const action = findAction(rawActions, id);
  if (!action || action.disabled) return false;
  const payload = { ...options, ...resolved.context, actionId: id };
  if (typeof action.execute === "function") {
    const result = await action.execute(payload);
    refresh("action-executed");
    return result !== false;
  }
  if (typeof resolved.provider?.execute === "function") {
    const result = await resolved.provider.execute(id, payload);
    refresh("action-executed");
    return result !== false;
  }
  return false;
};

const lazyCreate = (api, methods = ["create", "openCreate"]) => async ({ anchor } = {}) => {
  const target = api();
  const method = methods.find((name) => typeof target?.[name] === "function");
  if (!method) return false;
  const result = await target[method](anchor);
  return result !== false;
};

register("people", {
  label: "People",
  actions: [{ id: "person", label: "Person", kind: "person", execute: lazyCreate(() => window.peopleCards) }],
});
register("pipeline", {
  label: "Pipeline",
  actions: [{ id: "deal", label: "Deal", kind: "money", execute: lazyCreate(() => window.dealPipeline) }],
});
register("jobs", {
  label: "Jobs",
  actions: [{ id: "job", label: "Job", kind: "work", execute: lazyCreate(() => window.jobPipeline) }],
});
register("assignments", {
  label: "Assignments",
  actions: [{ id: "assignment", label: "Assignment", kind: "task", execute: lazyCreate(() => window.crmAssignments) }],
});
register("calendar", {
  label: "Calendar",
  actions: [{
    id: "commitment",
    label: "Scheduled commitment",
    description: "Add work that can be placed on the calendar",
    kind: "calendar",
    execute: lazyCreate(() => window.crmAssignments),
  }],
});
register("cases", {
  label: "Tickets",
  actions: [{ id: "ticket", label: "Ticket", kind: "ticket", execute: lazyCreate(() => window.ticketStacks) }],
});

export const changed = refresh;
export const context = currentContext;
export const crmContextAddRegistry = Object.freeze({
  register,
  snapshot,
  execute,
  refresh,
  changed,
  context: currentContext,
});
window.crmContextAddRegistry = crmContextAddRegistry;

document.addEventListener("crm:theater-switch", refresh);
document.addEventListener("crm:planner-context-changed", refresh);
