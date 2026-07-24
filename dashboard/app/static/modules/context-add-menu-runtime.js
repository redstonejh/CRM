const actionMarkup = (action) => {
  const description = action.description
    ? `<span class="context-add-action-description">${escapeHtml(action.description)}</span>`
    : "";
  return `<button type="button" class="auth-menu-item context-add-action" role="menuitem" data-context-add-action="${escapeHtml(action.id)}"${action.disabled ? " disabled" : ""}>
    <span class="context-add-action-label">${escapeHtml(action.label)}</span>${description}
  </button>`;
};

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"]/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
}[character]));

const flattenActions = (actions = []) => actions.flatMap((action) => (
  action.children?.length
    ? action.children.map((child) => ({ ...child, group: child.group || action.label }))
    : [action]
));

export function initializeContextAddMenuRuntime({ showToast = () => {} } = {}) {
  const trigger = document.querySelector(".window-add-control");
  const menu = document.getElementById("context-add-menu");
  const heading = menu?.querySelector(".context-add-menu-heading");
  const actionHost = menu?.querySelector(".context-add-menu-actions");
  if (!trigger || !menu || !heading || !actionHost) return null;

  let open = false;
  let currentSnapshot = null;
  let renderToken = 0;

  const position = () => {
    if (!open) return;
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const left = Math.max(12, Math.min(
      window.innerWidth - menuRect.width - 12,
      triggerRect.right - menuRect.width
    ));
    const top = Math.min(
      window.innerHeight - menuRect.height - 12,
      triggerRect.bottom + 8
    );
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.max(12, Math.round(top))}px`;
  };

  const close = ({ restoreFocus = false } = {}) => {
    open = false;
    menu.classList.remove("open");
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus();
  };

  const render = async () => {
    const token = ++renderToken;
    let snapshot;
    try {
      snapshot = await window.crmContextAddRegistry?.snapshot?.();
    } catch {
      snapshot = null;
    }
    if (token !== renderToken) return;
    currentSnapshot = snapshot || { label: "Current view", actions: [] };
    const actions = flattenActions(currentSnapshot.actions);
    const label = currentSnapshot.label || "Current view";
    heading.textContent = `Add to ${label}`;
    trigger.setAttribute("aria-label", `Add to ${label}`);
    trigger.title = `Add to ${label}`;
    menu.setAttribute("aria-label", `Add to ${label}`);
    if (!actions.length) {
      actionHost.innerHTML = '<div class="context-add-empty" role="status">Nothing can be added here.</div>';
    } else {
      const groups = [];
      let activeGroup = null;
      actions.forEach((action) => {
        const group = action.group || "";
        if (group && group !== activeGroup) {
          groups.push(`<div class="context-add-group-label">${escapeHtml(group)}</div>`);
          activeGroup = group;
        }
        groups.push(actionMarkup(action));
      });
      actionHost.innerHTML = groups.join("");
    }
    if (open) requestAnimationFrame(position);
  };

  const show = async () => {
    await render();
    open = true;
    menu.hidden = false;
    menu.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    position();
    requestAnimationFrame(() => {
      position();
      menu.querySelector(".context-add-action:not(:disabled)")?.focus();
    });
  };

  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (open) close();
    else void show();
  });

  menu.addEventListener("click", async (event) => {
    const button = event.target?.closest?.("[data-context-add-action]");
    if (!button || button.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    const actionId = button.dataset.contextAddAction || "";
    const action = flattenActions(currentSnapshot?.actions).find((item) => item.id === actionId);
    close();
    try {
      const handled = await window.crmContextAddRegistry?.execute?.(actionId, { anchor: trigger });
      if (!handled) showToast(`${action?.label || "Item"} is not available in this view.`, "warning");
    } catch (error) {
      console.warn("[context-add] action failed", error);
      showToast(`Could not add ${String(action?.label || "item").toLowerCase()}.`, "error");
    }
  });

  document.addEventListener("pointerdown", (event) => {
    if (!open || menu.contains(event.target) || trigger.contains(event.target)) return;
    close();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      close({ restoreFocus: true });
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const actions = [...menu.querySelectorAll(".context-add-action:not(:disabled)")];
    if (!actions.length) return;
    event.preventDefault();
    const current = actions.indexOf(document.activeElement);
    const direction = event.key === "ArrowDown" ? 1 : -1;
    actions[(current + direction + actions.length) % actions.length].focus();
  }, true);
  window.addEventListener("resize", position);
  document.addEventListener("crm:add-context-changed", () => {
    if (open) void render();
    else {
      const context = window.crmContextAddRegistry?.context?.();
      const label = context?.module ? context.module[0].toUpperCase() + context.module.slice(1) : "current view";
      trigger.setAttribute("aria-label", `Add to ${label}`);
      trigger.title = `Add to ${label}`;
    }
  });

  void render();
  return Object.freeze({ open: show, close, refresh: render });
}
