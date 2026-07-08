# CRM

Phase 10 modular CRM build. [CRM_PLAN.md](./CRM_PLAN.md) covers the original phases 1-7; `CRM_VISION.md` in the parent CRM workspace extends the roadmap through the Money, Today, automation, and reporting phases.

This repo starts from the `ticketing` shell, keeps the ticket stacks/detail surface active as the regression baseline, imports `fractal-calendar.js` into the same canvas, and now routes CRM records through the Postgres API store. The decision log for each reuse verdict lives in [DECISION_LOG.md](./DECISION_LOG.md).

## Run / build

```bash
npm install
npm run db:migrate   # requires DATABASE_URL, defaults to postgres://postgres:postgres@127.0.0.1:5432/crm
npm run server       # API defaults to http://127.0.0.1:3899
npm start
npm run make
```

## Source repos

- `ticketing`: base shell, ticket backend seam, card stacks/detail.
- `fractal-calendar-planner`: calendar engine imported for Phase 1.
- `name-and-info-cards`: People-module reference for later phases.

## Current stage

The dashboard shell remains the vendored canvas: auth, layout persistence, widget grid, visual tokens, glass styling, window controls, and the existing runtime modules are kept intact.

Phase 11 is active. The old ticket bridge still exists as `window.tickets`, but it is now a compatibility adapter over `electron/store.js` and the Postgres API. The ticket card UI is re-instantiated through `card-system.js` and `card-detail.js`, with `ticket-stacks.js` and `ticket-detail.js` reduced to ticket-specific config wrappers. Pipeline is a Deals instance on the same factories, with deal temperature values, a Won deck, and card-on-card drop-to-link. People is a Contacts instance with neutral contact cards, one attention/unbucketed deck plus recycle bin, free company-relationship buckets, and contact-to-contact linking. Money is an Invoices instance with Draft, Sent, Overdue, and Paid pile semantics. Today deals the API-backed `todayHand` through a deck-only `card-system.js` instance using shared card faces. Company dive is now a third `fractal-camera.js` booking fed by related CRM records, and top search deals transient results through a deck-only `card-system.js` instance. The workspace switch covers Home, Today, Tickets, People, Pipeline, Money, Calendar, and Reports. Generic entity bridges remain exposed for `window.deals`, `window.contacts`, `window.companies`, `window.tasks`, `window.invoices`, `window.interactions`, and `window.crmStore`.

MQTT is fully removed from the final CRM direction. Shared truth lives in Postgres through the API in `server/`; Electron talks to it through `electron/store.js`, with `window.tickets` kept as a compatibility bridge while the card engine is generalized.

The calendar now runs on the shared `fractal-camera.js` engine, has year paging, and accepts grid-card drops onto day buckets by persisting `scheduledDate` through the API-backed entity bridge. Home is also a camera instance with module buckets that activate the workspace switch.

Reports are grid-resident builder widgets fed by `/api/reports/summary` through `window.crmReportsApi`; they summarize open deals, pipeline value, win rate, contacts due, tasks, scheduled items, outstanding cash, invoice aging, today-hand records, activity, and recent records without reviving the removed monitoring feed. Quick-add is a global `+` launcher that delegates to the existing Ticket, Deal, Contact, and Invoice card-system draft create flows.

Interactions are API-backed records with `kind`, `note`, `at`, and related ids. Creating one fans out on the server: related records receive a `history[]` event and `lastTouchAt`, keeping relationship attention shared through Postgres instead of local-only renderer state. A server minute sweep flips sent invoices past `dueDate` to overdue and broadcasts the change.

Next-Touch Law is implemented as an optional `card-detail.js` interceptor for Contacts, Deals, and sent/overdue Invoices. Closing a qualifying detail panel without a future `nextTouchAt`, direct `scheduledDate`, or future related task blooms chips for `+2d`, `+1w`, `+1m`, `pick a day`, and `let it go`; scheduling writes `nextTouchAt` and `scheduledDate`, logs an Interaction, and lets the Calendar show the card on that day.

Today is now a first-class workspace fed by `/api/reports/summary`. It deals the `todayHand` once per local day as one deck from `card-system.js`: due next touches, scheduled tasks/calendar items, due or overdue invoices, and Cold Front records use the shared face pipeline and existing entity detail configs. Calendar keeps that Today deck visible so day-bucket drops persist `scheduledDate` and `nextTouchAt`. Cold Front is derived from `lastTouchAt` and stage-specific half-lives; it desaturates Contacts and Deals and pulls stale Contacts into the People attention deck without storing new state.

Search now reuses the existing top search chrome as a query menu and deals results as canonical deck cards through `crm-record-search.js`; there is no result list. Result cards open existing detail configs where available, can be dragged to Calendar days, and can be dropped onto active home-module stage buckets when the entity supports that stage. `crm-company-dive.js` derives company buckets from Companies plus related records and uses `fractal-camera.js` to dive into a company world with contact/deal/invoice card faces and a merged history/interaction thread.

Team backend polish now lives in the account menu's Backend panel. It shows the active API endpoint, probes `/api/health`, and lets the user switch API URLs; changing the endpoint reconnects the shared store, clears stale entity caches, and reloads records from the new Postgres/API backend.

## Verification

The current client smoke test is the Electron Forge package build:

```bash
npm run package
```

The backend expects `DATABASE_URL` when not using the local default:

```bash
$env:DATABASE_URL="postgres://user:pass@host:5432/crm"
npm run db:migrate
npm run server
```
