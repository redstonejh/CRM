# Decision Log

| Component | Verdict | Reason |
|---|---|---|
| `ticketing` repository | Use as Phase 1 base | It already contains the canonical Electron shell, dashboard canvas, ticket backend seam, `ticket-stacks.js`, and `ticket-detail.js` called out in the plan. |
| `fractal-calendar.js` | Import unchanged for Phase 1 | The plan names the camera/calendar split for Phase 6; Phase 1 only needs the existing calendar experience present in the merged shell. |
| `ticket-detail.js` and `ticket-stacks.js` choreography | Keep active and behavior-compatible | The ticketing behavior is the regression surface for the later card-system factory refactor. |
| CRM identity strings | Rename now | The final repo should launch as CRM while retaining the ticketing seams for upcoming phases. |
| `name-and-info-cards` repository | Inspect, do not copy yet | Its People-specific changes belong to the Phase 5 module, after the card-system factory exists. |
| MQTT dependency and broker settings | Remove | The final CRM backend is Postgres/API; MQTT is not a retained architecture seam. |
| `electron/store.js` | Add API-backed seam | Existing `window.tickets` can run as an adapter while future `window.deals`, `window.contacts`, and other entity bridges share the same backend contract. |
| `server/` Postgres API | Add in Phase 2 | Shared team truth requires a central API, version checks, soft-delete fields, and a change stream instead of per-machine state. |
| `ticket-stacks.js` shared state | Move stage/rank/trash/meta writes toward record docs | Team CRM state cannot stay per-machine; local state now acts as optimistic fallback while the API-backed doc becomes shared truth. |
| `ticket-stacks.js` deck/bucket choreography | Extract to `card-system.js` factory | The drag, fan, stack, zone, trash, grid-drop, scroll, and focus mechanics are entity-blind; ticket assumptions are concentrated in source bridge, stages, field schema, card face, palette, storage keys, and verbs. |
| Ticket stage field schema | Keep as ticket config | Triage/investigation/resolution prompts are ticket workflow content, not card-system mechanics. They become the first factory config instead of remaining hard-coded choreography. |
| Ticket severity palette | Keep as ticket config | Deals and tasks can reuse the intensity idea, but contacts should not inherit incident severity styling. The palette belongs to each entity instance. |
| `ticket-detail.js` open/close motion | Extract to `card-detail.js` factory | Context-aware flyout, side selection, depth-of-field, clipping, and close choreography are reusable; the panel fields and save behavior are entity content. |
| Ticket detail panel fields | Keep as ticket config through stack API | The current panel shows only the active ticket stage fields and validates draft creation; future entities need different content without changing the motion engine. |
| Existing `window.ticketStacks` / `window.ticketDetail` globals | Preserve as ticket instance aliases | Ticketing is the regression baseline for Phase 3, so the renderer contract stays stable while the implementation moves behind factories. |
| Pipeline module | Instantiate through `card-system.js` / `card-detail.js` | Deals need the same deck, bucket, trash, grid-drop, and detail choreography, but with deal stages, temperature values, Won state, and deal-specific fields. |
| Tickets and Pipeline overlays | Add explicit module switch | The current card theater occupies one overlay plane; two active card-system instances would overlap. The switch keeps one active instance while preserving both configurations. |
| Pipeline right deck | Use as Won pile | The right deck's mechanics already represent a completed/reward pile; deals map that state to `state: "won"` instead of ticket `resolved`. |
| Drop-to-link | Add generic card-on-card drop hook, persist deal links as `relatedDealIds` | Relationship gestures belong in the card-system choreography; the deal module supplies the persistence rule so future Contacts/Companies can reuse the gesture without inheriting deal semantics. |
