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
