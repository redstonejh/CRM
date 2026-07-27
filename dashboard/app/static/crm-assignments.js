// crm-assignments.js — commitment semantics on the canonical card-system renderer.
(() => {
  if (typeof window.createCrmCardSystem !== "function" || typeof window.createCrmCardDetail !== "function") {
    console.error("[CRM] Assignment card factories are not loaded");
    return;
  }

  const STAGES = Object.freeze([
    { id:"unassigned", title:"Unassigned", key:"unassigned", label:"Unassigned" },
    { id:"assigned", title:"Assigned", key:"assigned", label:"Assigned" },
    { id:"active", title:"In progress", key:"active", label:"In progress" },
    { id:"blocked", title:"Blocked", key:"blocked", label:"Blocked" },
    { id:"done", title:"Done", key:"done", label:"Done" },
  ]);
  const rows = (result) => result?.records || [];
  const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[character]));
  const first = (...values) => values.map((value) => String(value ?? "").trim()).find(Boolean) || "";
  const clone = (value) => typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  const nowIso = () => new Date().toISOString();
  const closed = (item) => ["completed", "cancelled", "canceled"].includes(String(item?.status || "").toLowerCase());
  const stageById = (id) => STAGES.find((stage) => stage.id === String(id));
  const contactName = (contact) => first(contact?.name, contact?.title, contact?.client, contact?.id, "Person");
  const recordName = (record) => first(record?.title, record?.name, record?.companyLabel, record?.description, record?.id, "Untitled");

  let model = { commitments:[], flows:[], contacts:[], companies:[], tasks:[], tickets:[], workItems:[] };
  let currentUser = "rosa";
  let loadPromise = null;
  let loadTail = Promise.resolve();
  let refreshTimer = 0;
  let subscriptionsBound = false;
  let assignmentDetail = null;
  let floating = null;
  let factory = null;
  let detailSaveTimer = 0;
  let detailSaveTail = Promise.resolve();
  const listeners = new Set();
  const pendingDetailFields = new Map();
  const writeTails = new Map();

  const itemById = (id) => model.commitments.find((item) => String(item.id) === String(id));
  const flowFor = (itemOrId) => {
    const id = typeof itemOrId === "object" ? itemOrId?.id : itemOrId;
    return model.flows.find((flow) => flow.workflowKey === "assignments"
      && flow.entityType === "commitments" && String(flow.recordId) === String(id));
  };
  const stageOf = (item) => {
    if (closed(item)) return "done";
    const explicit = String(item?.assignmentStage || "").toLowerCase();
    if (stageById(explicit)) return explicit;
    return item?.assignedContactId || first(item?.assignee) ? "assigned" : "unassigned";
  };
  const linkOf = (item) => item?.links?.find((link) => link.relation === "assignment-context")
    || ["workItems","tickets","tasks","contacts","companies"].map((entityType) => item?.links?.find((link) => link.entityType === entityType)).find(Boolean)
    || item?.links?.[0] || null;
  const targetRecord = (link) => !link ? null : ({
    contacts:model.contacts, companies:model.companies, tasks:model.tasks, tickets:model.tickets, workItems:model.workItems,
  }[link.entityType] || []).find((record) => String(record.id) === String(link.recordId));
  const contextLabel = (item) => {
    const link = linkOf(item);
    if (!link) return "Independent work";
    const entity = ({ workItems:"Pipeline", tickets:"Ticket", tasks:"Task", contacts:"Person", companies:"Company" })[link.entityType] || "Work";
    return `${entity} · ${recordName(targetRecord(link) || { id:link.recordId })}`;
  };

  async function loadModel() {
    const [commitments, flows, contacts, companies, tasks, tickets, workItems, session] = await Promise.all([
      window.crmDomain.list("commitments", { includeDeleted:false, limit:1000 }),
      window.crmDomain.list("workflow-entries", { includeDeleted:false, workflowKey:"assignments", limit:1000 }),
      window.crmStore.list("contacts", { includeDeleted:false }),
      window.crmStore.list("companies", { includeDeleted:false }),
      window.crmStore.list("tasks", { includeDeleted:false }),
      window.crmStore.list("tickets", { includeDeleted:false }),
      window.crmStore.list("workItems", { includeDeleted:false }),
      window.auth?.session?.().catch?.(() => ({ user:null })) || Promise.resolve({ user:null }),
    ]);
    currentUser = first(session?.user?.username, currentUser, "rosa");
    model = {
      commitments:rows(commitments).filter((item) => !item.deletedAt),
      flows:rows(flows).filter((item) => !item.deletedAt),
      contacts:rows(contacts).filter((item) => !item.deletedAt),
      companies:rows(companies).filter((item) => !item.deletedAt),
      tasks:rows(tasks).filter((item) => !item.deletedAt),
      tickets:rows(tickets).filter((item) => !item.deletedAt),
      workItems:rows(workItems).filter((item) => !item.deletedAt),
    };
    return model;
  }
  const refreshModel = () => {
    if (loadPromise) return loadPromise;
    const run = loadTail.catch(() => null).then(loadModel);
    loadTail = run;
    loadPromise = run;
    run.finally(() => { if (loadPromise === run) loadPromise = null; }).catch(() => {});
    return run;
  };
  const publishModel = async () => {
    try {
      await refreshModel();
      const payload = { records:model.commitments };
      listeners.forEach((listener) => { try { listener(payload); } catch {} });
    } catch (error) {
      console.error("[CRM] Assignment refresh failed", error);
    }
  };
  const scheduleModelRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = 0;
      void publishModel();
    }, 100);
  };
  const waitForSourceSettled = (maxFrames = 120) => new Promise((resolve) => {
    let frame = 0;
    let stable = 0;
    let awaiting = false;
    const tick = async () => {
      if (awaiting) return;
      const pending = [
        loadPromise,
        ...writeTails.values(),
        detailSaveTimer || pendingDetailFields.size ? detailSaveTail : null,
      ].filter((value) => value && typeof value.then === "function");
      if (pending.length) {
        awaiting = true;
        await Promise.allSettled(pending);
        awaiting = false;
      }
      const quiet = !refreshTimer && !loadPromise && !writeTails.size
        && !detailSaveTimer && !pendingDetailFields.size;
      stable = quiet ? stable + 1 : 0;
      frame += 1;
      if (stable >= 3 || frame >= maxFrames) {
        resolve({ stable:stable >= 3, frames:frame });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const subscribe = (listener) => {
    listeners.add(listener);
    if (!subscriptionsBound) {
      subscriptionsBound = true;
      try { window.crmDomain?.onChanged?.(scheduleModelRefresh); } catch {}
      try { window.crmStore?.onChanged?.(scheduleModelRefresh); } catch {}
    }
    return () => listeners.delete(listener);
  };

  const freshDomainRecord = async (resource, id) => {
    const direct = await window.crmDomain?.get?.(resource, id).catch?.(() => null);
    if (direct?.record) return direct.record;
    return rows(await window.crmDomain.list(resource, { includeDeleted:false, limit:1000 }))
      .find((record) => String(record.id) === String(id)) || null;
  };
  async function syncFlow(item) {
    if (!item?.id) return null;
    const fields = {
      workflowKey:"assignments",
      entityType:"commitments",
      recordId:item.id,
      stage:stageOf(item),
      rank:Number(item.assignmentRank ?? item.stageRank ?? 0) || 0,
      owner:item.assignee || null,
    };
    let flow = flowFor(item);
    if (!flow) {
      const created = await window.crmDomain.create("workflow-entries", fields);
      if (created?.record) model.flows.push(created.record);
      return created?.record || null;
    }
    let result = await window.crmDomain.update("workflow-entries", flow.id, fields, flow.version);
    if (!result?.record) {
      const fresh = await freshDomainRecord("workflow-entries", flow.id);
      if (fresh) result = await window.crmDomain.update("workflow-entries", fresh.id, fields, fresh.version);
    }
    if (result?.record) Object.assign(flow, result.record);
    return result?.record || null;
  }
  const normalizedPatch = (item, rawFields = {}) => {
    const fields = { ...rawFields };
    const requestedStage = fields.assignmentStage ?? fields.stage;
    const hasAssignmentRank = Object.prototype.hasOwnProperty.call(fields, "assignmentRank");
    const hasStageRank = Object.prototype.hasOwnProperty.call(fields, "stageRank");
    const requestedRank = hasAssignmentRank ? fields.assignmentRank : fields.stageRank;
    delete fields.stage;
    delete fields.stageRank;
    if (hasAssignmentRank || hasStageRank) {
      fields.assignmentRank = requestedRank == null || requestedRank === ""
        ? null
        : (Number.isFinite(Number(requestedRank)) ? Number(requestedRank) : item?.assignmentRank ?? null);
    }
    if (requestedStage != null && stageById(requestedStage)) {
      const previousStage = stageOf(item);
      const stage = String(requestedStage);
      fields.assignmentStage = stage;
      if (stage === "done") {
        fields.status = "completed";
        fields.completedAt = first(fields.completedAt, item?.completedAt, nowIso());
        fields.outcome = first(fields.outcome, item?.outcome, "Assignment completed");
        fields.assignmentPreviousStage = previousStage === "done" ? first(item?.assignmentPreviousStage, "assigned") : previousStage;
      } else {
        fields.status = "open";
        fields.completedAt = null;
        fields.outcome = null;
      }
      if (stage === "unassigned") Object.assign(fields, {
        assignee:null, assignedContactId:null, assignedContactName:null, assignedAt:null,
      });
      else if (["assigned","active"].includes(stage) && !first(fields.assignee, item?.assignee)) {
        fields.assignee = currentUser;
        fields.assignedAt = first(item?.assignedAt, nowIso());
      }
    }
    return fields;
  };
  const updateCommitment = (id, rawFields = {}) => {
    const item = itemById(id);
    if (!item) return Promise.resolve({ ok:false, record:null });
    const fields = normalizedPatch(item, rawFields);
    Object.assign(item, fields);
    factory?.patchRecord?.(id, fields);
    const syncWorkflow = ["assignmentStage","assignmentRank","assignee","assignedContactId"].some((key) => Object.prototype.hasOwnProperty.call(fields, key));
    const prior = writeTails.get(String(id)) || Promise.resolve();
    const run = prior.catch(() => null).then(async () => {
      let current = itemById(id) || await freshDomainRecord("commitments", id);
      if (!current) return { ok:false, record:null };
      let result = await window.crmDomain.update("commitments", id, fields, current.version);
      if (!result?.record) {
        current = await freshDomainRecord("commitments", id);
        if (current) result = await window.crmDomain.update("commitments", id, fields, current.version);
      }
      if (result?.record) {
        const canonical = itemById(id);
        if (canonical) Object.assign(canonical, result.record);
        if (syncWorkflow) await syncFlow(canonical || result.record);
      }
      return result || { ok:false, record:null };
    }).catch((error) => {
      console.error("[CRM] Assignment update failed", error);
      return { ok:false, record:null };
    });
    writeTails.set(String(id), run);
    run.finally(() => { if (writeTails.get(String(id)) === run) writeTails.delete(String(id)); }).catch(() => {});
    return run;
  };

  const assignmentSource = {
    list:async () => ({ records:(await refreshModel()).commitments }),
    get:async (id) => ({ record:itemById(id) || await freshDomainRecord("commitments", id) }),
    create:async (fields) => {
      const stage = stageById(fields?.assignmentStage ?? fields?.stage)?.id || "unassigned";
      const payload = normalizedPatch(null, {
        ...fields,
        title:first(fields?.title, "New assignment"),
        kind:first(fields?.kind, "assignment"),
        priority:first(fields?.priority, "normal"),
        assignmentStage:stage,
        assignmentRank:Number.isFinite(Number(fields?.assignmentRank))
          ? Number(fields.assignmentRank)
          : model.commitments.filter((item) => stageOf(item) === stage).length,
      });
      const result = await window.crmDomain.create("commitments", payload);
      if (result?.record) {
        model.commitments.push(result.record);
        await syncFlow(result.record);
      }
      return result;
    },
    update:(id, fields) => updateCommitment(id, fields),
    remove:async (id) => {
      const flow = flowFor(id);
      const result = await window.crmDomain.remove("commitments", id);
      if (flow) await window.crmDomain.remove("workflow-entries", flow.id);
      model.commitments = model.commitments.filter((item) => String(item.id) !== String(id));
      model.flows = model.flows.filter((item) => String(item.id) !== String(flow?.id));
      return result;
    },
    resolve:(id) => updateCommitment(id, { assignmentStage:"done" }),
    onChanged:subscribe,
    waitForSettled:waitForSourceSettled,
  };

  const assignmentTargetPairs = () => [["", "No linked record"],
    ...model.tasks.map((record) => [`tasks:${record.id}`, `Task · ${recordName(record)}`]),
    ...model.contacts.map((record) => [`contacts:${record.id}`, `Person · ${recordName(record)}`]),
    ...model.tickets.map((record) => [`tickets:${record.id}`, `Ticket · ${recordName(record)}`]),
    ...model.workItems.map((record) => [`workItems:${record.id}`, `Pipeline · ${recordName(record)}`]),
  ];
  const dateInputValue = (value) => {
    const raw = String(value || "");
    if (!raw) return "";
    if (!raw.includes("T")) return raw.slice(0, 10);
    const date = new Date(raw);
    if (!Number.isFinite(date.getTime())) return "";
    const pad = (part) => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };
  const detailValue = (itemId, key) => {
    const item = itemById(itemId);
    if (!item) return "";
    if (key === "stage") return stageOf(item);
    if (key === "dueAt") return dateInputValue(item.dueAt);
    if (key === "assignedTarget") {
      if (item.assignedContactId) return String(item.assignedContactId);
      return first(item.assignee).toLowerCase() === currentUser.toLowerCase() ? "__me" : "";
    }
    if (key === "linkedTarget") {
      const link = linkOf(item);
      return link ? `${link.entityType}:${link.recordId}` : "";
    }
    return item[key] ?? "";
  };
  const detailFields = () => [
    { key:"title", label:"Assignment", q:"What needs to happen?" },
    { key:"context", label:"Definition of done", q:"What does done look like?", area:true, req:false },
    { key:"stage", label:"Stage", options:() => STAGES.map((stage) => [stage.id, stage.title]), req:false },
    { key:"dueAt", label:"Due", date:true, req:false },
    { key:"assignedTarget", label:"Owner", options:() => [["", "Unassigned"], ["__me", `Me · ${currentUser}`], ...model.contacts.map((contact) => [contact.id, contactName(contact)])], req:false },
    { key:"linkedTarget", label:"Linked to", options:assignmentTargetPairs, req:false },
    { key:"priority", label:"Priority", prio:true, req:false },
  ];
  function queueDetailFields(itemId, rawFields = {}) {
    const item = itemById(itemId);
    if (!item) return false;
    const fields = {};
    if (Object.prototype.hasOwnProperty.call(rawFields, "title")) {
      const title = String(rawFields.title || "").trim();
      if (title) fields.title = title;
    }
    if (Object.prototype.hasOwnProperty.call(rawFields, "context")) fields.context = String(rawFields.context || "");
    if (Object.prototype.hasOwnProperty.call(rawFields, "dueAt")) {
      const value = String(rawFields.dueAt || "");
      fields.dueAt = value ? new Date(`${value}T17:00:00`).toISOString() : null;
    }
    if (Object.prototype.hasOwnProperty.call(rawFields, "priority")) fields.priority = String(rawFields.priority || "normal");
    if (Object.prototype.hasOwnProperty.call(rawFields, "stage")) {
      const nextStage = String(rawFields.stage || "unassigned");
      fields.assignmentStage = nextStage;
      if (stageOf(item) !== nextStage) {
        fields.assignmentRank = model.commitments.filter((candidate) =>
          candidate.id !== item.id && stageOf(candidate) === nextStage).length;
      }
    }
    if (Object.prototype.hasOwnProperty.call(rawFields, "assignedTarget")) {
      const value = String(rawFields.assignedTarget || "");
      const contact = model.contacts.find((candidate) => String(candidate.id) === value);
      const assignee = contact ? contactName(contact) : value === "__me" ? currentUser : null;
      Object.assign(fields, {
        assignedContactId:contact?.id || null,
        assignedContactName:contact ? contactName(contact) : null,
        assignee,
        assignedAt:assignee ? first(item.assignedAt, nowIso()) : null,
      });
      if (!assignee) fields.assignmentStage = "unassigned";
      else if (stageOf(item) === "unassigned") fields.assignmentStage = "assigned";
    }
    if (Object.prototype.hasOwnProperty.call(rawFields, "linkedTarget")) {
      const raw = String(rawFields.linkedTarget || "");
      const [entityType, ...parts] = raw.split(":");
      const links = (item.links || []).filter((link) => link.relation !== "assignment-context");
      if (raw) links.push({ entityType, recordId:parts.join(":"), relation:"assignment-context" });
      fields.links = links;
    }
    const normalized = normalizedPatch(item, fields);
    Object.assign(item, normalized);
    factory?.patchRecord?.(item.id, normalized);
    pendingDetailFields.set(item.id, { ...(pendingDetailFields.get(item.id) || {}), ...normalized });
    clearTimeout(detailSaveTimer);
    detailSaveTimer = setTimeout(flushDetailFields, 180);
    return true;
  }
  function flushDetailFields() {
    clearTimeout(detailSaveTimer);
    detailSaveTimer = 0;
    const batch = [...pendingDetailFields.entries()];
    pendingDetailFields.clear();
    if (!batch.length) return detailSaveTail;
    detailSaveTail = detailSaveTail.catch(() => null).then(async () => {
      for (const [itemId, fields] of batch) await updateCommitment(itemId, fields);
    });
    return detailSaveTail;
  }

  assignmentDetail = window.createCrmCardDetail({
    apiName:"assignmentDetail",
    source:assignmentSource,
    stacks:() => window.crmAssignments,
    panelWidth:380,
    priorities:["normal","high","urgent"],
    intensityValues:["normal","high","urgent"],
    defaultIntensity:"normal",
    severityRgb:{ normal:"14,165,233", high:"202,138,4", urgent:"220,38,38", none:"107,114,128" },
    notFoundText:"Assignment not found.",
    draftRequiredText:"An assignment title is required.",
  });

  const assignmentFace = {
    title:(item) => first(item.title, "Untitled assignment"),
    subtitle:(item) => first(item.context, item.note, item.description),
    rows:[
      (item) => ({ label:"Owner", value:first(item.assignee, "Unassigned") }),
      (item) => ({ label:"For", value:contextLabel(item) }),
      (item) => ({ label:"Priority", value:first(item.priority, "Normal") }),
    ],
  };
  const stageUpdateFields = (_id, stage, item) => normalizedPatch(item, { assignmentStage:stage || "unassigned" });
  const stageRankUpdateFields = (_id, rank, _stage, item) => normalizedPatch(item, { assignmentRank:rank });
  const stageOrderCompare = (a, b) => {
    const due = (Date.parse(a?.dueAt || "") || Number.MAX_SAFE_INTEGER)
      - (Date.parse(b?.dueAt || "") || Number.MAX_SAFE_INTEGER);
    return due || String(a?.createdAt || "").localeCompare(String(b?.createdAt || ""));
  };
  const openLinked = (item) => {
    const link = linkOf(item);
    if (!link) return false;
    if (link.entityType === "workItems") return window.crmPlanner?.openItem?.(link.recordId) || false;
    if (link.entityType === "tickets") return window.ticketStacks?.open?.(link.recordId) || false;
    return window.crmRecordWorld?.open?.(link.entityType, link.recordId) || false;
  };

  factory = window.createCrmCardSystem({
    apiName:"crmAssignments",
    theater:"assignments",
    workflowKind:"lifecycle",
    stages:STAGES.map(({ key, label }) => ({ key, label })),
    stageFields:Object.fromEntries(STAGES.map((stage) => [stage.id, detailFields()])),
    stageAuthority:"source",
    deletionAuthority:"source",
    stageOf,
    stageRankOf:(item) => item?.assignmentRank,
    stageUpdateFields,
    stageRankUpdateFields,
    stageOrderCompare,
    stageMovement:"free",
    source:assignmentSource,
    detail:assignmentDetail,
    face:assignmentFace,
    widgetType:"assignment",
    widgetTitle:"Assignment",
    sizeEntity:"commitments",
    recordsFromList:rows,
    recordFromCreate:(result) => result?.record,
    intensityValues:["normal","high","urgent"],
    defaultIntensity:"normal",
    intensityOf:(item) => String(item?.priority || "normal").toLowerCase(),
    severityRgb:{ normal:"14,165,233", high:"202,138,4", urgent:"220,38,38", none:"107,114,128" },
    isResolved:closed,
    resolvedState:"completed",
    showProgressBars:true,
    horizontalZones:true,
    horizontalZoneRows:1,
    scrollZoneRows:false,
    zoneGravity:false,
    lazyZoneCards:false,
    restoreZoneExpansion:false,
    reserveStackSpace:false,
    leftDeckEnabled:false,
    rightDeckEnabled:false,
    trashEnabled:false,
    createEnabled:false,
    attentionDeckFilter:() => false,
    showActivityAction:false,
    contextActions:(item) => [
      linkOf(item) && { label:"Open linked record", run:() => openLinked(item) },
      { label:stageOf(item) === "done" ? "Reopen" : "Complete", run:() => move(item.id, stageOf(item) === "done" ? first(item.assignmentPreviousStage, "assigned") : "done") },
      { label:"Delete", run:async () => { await assignmentSource.remove(item.id); await factory.reload(); } },
    ].filter(Boolean),
    storageKeys:{
      order:(side) => `crm-assignment-order-${side}`,
      meta:"crm-assignment-meta",
      color:"crm-assignment-color",
      colorLast:"crm-assignment-color-last",
    },
    deckCopy:{ zoneEmpty:"No work here" },
    active:(document.body?.dataset?.crmModule || localStorage.getItem("crm-active-module")) === "assignments",
  });

  const factoryOnDetailClosed = factory.onDetailClosed.bind(factory);
  factory.stageFields = (itemId) => ({
    key:stageOf(itemById(itemId)),
    label:stageById(stageOf(itemById(itemId)))?.title || "Assignment",
    fields:detailFields(),
  });
  factory.fieldValue = detailValue;
  factory.setMeta = queueDetailFields;
  factory.setPriority = (itemId, priority) => queueDetailFields(itemId, { priority });
  factory.onDetailClosed = () => {
    const flushed = flushDetailFields();
    Promise.resolve(flushed).finally(() => {
      factoryOnDetailClosed();
      factory.reload();
    });
  };

  const closeFloating = () => { floating?.remove(); floating = null; };
  const ensureEditorStyles = () => {
    if (document.getElementById("crm-assignment-editor-styles")) return;
    const style = document.createElement("style");
    style.id = "crm-assignment-editor-styles";
    style.textContent = `
      .crm-assignment-editor{position:fixed;z-index:9330;width:min(380px,calc(100vw - 28px));padding:10px;display:grid;gap:8px}
      .crm-assignment-editor-title{padding:2px 3px 5px;font-size:var(--crm-type-control,13px);font-weight:700}
      .crm-assignment-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:7px}
      .crm-assignment-fields>.crm-wide,.crm-assignment-fields>textarea{grid-column:1/-1}
      .crm-assignment-fields textarea{min-height:64px;resize:vertical;padding-top:9px}
      .crm-assignment-editor-actions{display:flex;justify-content:flex-end;gap:2px}
      .crm-assignment-editor .crm-menu-action{height:32px;font-size:var(--crm-type-body,12px)!important}
    `;
    document.head.appendChild(style);
  };
  const placeFloating = (element, anchor) => {
    document.body.appendChild(element);
    const source = anchor?.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(10, Math.min(innerWidth - bounds.width - 10, (source?.right || innerWidth / 2) - bounds.width))}px`;
    element.style.top = `${Math.max(48, Math.min(innerHeight - bounds.height - 12, (source?.bottom || innerHeight / 2) + 5))}px`;
    setTimeout(() => {
      const outside = (event) => {
        if (element.contains(event.target)) return;
        closeFloating();
        document.removeEventListener("pointerdown", outside, true);
      };
      document.addEventListener("pointerdown", outside, true);
    }, 0);
  };
  const targetOptions = () => assignmentTargetPairs().map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join("");
  function openEditor(anchor = null) {
    closeFloating();
    ensureEditorStyles();
    floating = document.createElement("form");
    floating.className = "crm-assignment-editor crm-menu-surface";
    floating.innerHTML = `<div class="crm-assignment-editor-title">New assignment</div><div class="crm-assignment-fields"><input class="crm-menu-input crm-wide" name="title" placeholder="What needs to happen?" required><textarea class="crm-menu-input" name="context" placeholder="What does done look like?"></textarea><select class="crm-menu-input" name="stage" aria-label="Stage">${STAGES.map((stage) => `<option value="${stage.id}">${esc(stage.title)}</option>`).join("")}</select><select class="crm-menu-input" name="priority" aria-label="Priority">${["normal","high","urgent"].map((value) => `<option value="${value}">${value[0].toUpperCase() + value.slice(1)}</option>`).join("")}</select><input class="crm-menu-input" name="dueAt" type="date" aria-label="Due date"><select class="crm-menu-input" name="assignee" aria-label="Assignee"><option value="">Unassigned</option><option value="__me">Me · ${esc(currentUser)}</option>${model.contacts.map((contact) => `<option value="${esc(contact.id)}">${esc(contactName(contact))}</option>`).join("")}</select><select class="crm-menu-input crm-wide" name="target" aria-label="Linked record">${targetOptions()}</select></div><div class="crm-assignment-editor-actions"><button type="button" class="crm-menu-action" data-cancel>Cancel</button><button type="submit" class="crm-menu-action">Create</button></div>`;
    floating.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(floating);
      const stage = stageById(data.get("stage")) || STAGES[0];
      const rawAssignee = String(data.get("assignee") || "");
      const contact = model.contacts.find((candidate) => String(candidate.id) === rawAssignee);
      const rawTarget = String(data.get("target") || "");
      const [entityType, ...recordParts] = rawTarget.split(":");
      const due = String(data.get("dueAt") || "");
      const links = rawTarget ? [{ entityType, recordId:recordParts.join(":"), relation:"assignment-context" }] : [];
      const fields = {
        title:String(data.get("title") || "").trim(),
        context:String(data.get("context") || ""),
        kind:"assignment",
        priority:String(data.get("priority") || "normal"),
        dueAt:due ? new Date(`${due}T17:00:00`).toISOString() : null,
        assignmentStage:stage.id,
        links,
        assignedContactId:contact?.id || null,
        assignedContactName:contact ? contactName(contact) : null,
        assignee:contact ? contactName(contact) : rawAssignee === "__me" ? currentUser : null,
        assignedAt:rawAssignee ? nowIso() : null,
      };
      await assignmentSource.create(fields);
      closeFloating();
      await factory.reload();
    });
    floating.querySelector("[data-cancel]")?.addEventListener("click", closeFloating);
    placeFloating(floating, anchor);
    requestAnimationFrame(() => floating?.elements?.title?.focus());
    return floating;
  }

  async function move(itemId, stageId) {
    const item = itemById(itemId);
    const stage = stageById(stageId);
    if (!item || !stage) return false;
    const rank = model.commitments.filter((candidate) => candidate.id !== item.id && stageOf(candidate) === stage.id).length;
    const result = await updateCommitment(item.id, { assignmentStage:stage.id, assignmentRank:rank });
    await factory.reload();
    return !!result?.record;
  }
  async function assign(itemId, contactId) {
    const item = itemById(itemId);
    const contact = model.contacts.find((candidate) => String(candidate.id) === String(contactId));
    if (!item || !contact) return false;
    const result = await updateCommitment(item.id, {
      assignee:contactName(contact),
      assignedContactId:contact.id,
      assignedContactName:contactName(contact),
      assignedAt:nowIso(),
      assignmentStage:"assigned",
      assignmentRank:stageOf(item) === "assigned"
        ? item.assignmentRank
        : model.commitments.filter((candidate) => candidate.id !== item.id && stageOf(candidate) === "assigned").length,
    });
    await factory.reload();
    return !!result?.record;
  }
  const unassign = (itemId) => move(itemId, "unassigned");
  async function open(itemId) {
    if (!itemById(itemId)) await factory.reload();
    const item = itemById(itemId);
    if (!item) return false;
    await factory.baseline();
    factory.scrollZoneIntoView(stageOf(item));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const theater = document.querySelector('[data-crm-theater="assignments"]');
      const card = theater?.querySelector(`.tk-zcard[data-id="${window.CSS?.escape ? CSS.escape(String(item.id)) : String(item.id).replace(/["\\\]]/g, "\\$&")}"]`);
      if (card) assignmentDetail.open(item, card);
    }));
    return true;
  }

  // Assignment Home previews capture this factory's mounted theater through
  // baseline/applyHomePreviewState. Never expose the factory's detached legacy
  // miniature path for this module.
  delete factory.miniature;
  Object.assign(factory, {
    move,
    assign,
    unassign,
    create:openEditor,
    openCreate:openEditor,
    open,
    items:() => clone(model.commitments),
    stages:() => clone(STAGES.map(({ id, title }) => ({ id, title }))),
    scrollBy:factory.scrollZonesBy,
    scrollToStage:factory.scrollZoneIntoView,
    scrollState:factory.zoneScrollState,
  });
  document.addEventListener("crm:theater-switch", closeFloating);
})();
