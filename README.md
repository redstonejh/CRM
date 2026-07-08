# CRM

Phase 6 modular CRM build described in [CRM_PLAN.md](./CRM_PLAN.md).

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

Phase 6 is active. The old ticket bridge still exists as `window.tickets`, but it is now a compatibility adapter over `electron/store.js` and the Postgres API. The ticket card UI is re-instantiated through `card-system.js` and `card-detail.js`, with `ticket-stacks.js` and `ticket-detail.js` reduced to ticket-specific config wrappers. Pipeline is a Deals instance on the same factories, with deal temperature values, a Won deck, and card-on-card drop-to-link. People is a Contacts instance with neutral contact cards, one attention/unbucketed deck plus recycle bin, free company-relationship buckets, and contact-to-contact linking. The workspace switch now covers Home, Tickets, Pipeline, People, and Calendar. Generic entity bridges remain exposed for `window.deals`, `window.contacts`, `window.companies`, `window.tasks`, and `window.crmStore`.

MQTT is fully removed from the final CRM direction. Shared truth lives in Postgres through the API in `server/`; Electron talks to it through `electron/store.js`, with `window.tickets` kept as a compatibility bridge while the card engine is generalized.

The calendar now runs on the shared `fractal-camera.js` engine, has year paging, and accepts grid-card drops onto day buckets by persisting `scheduledDate` through the API-backed entity bridge. Home is also a camera instance with module buckets that activate the workspace switch.

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
