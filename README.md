# CRM

Phase 2 backend-seam build for the modular CRM described in [CRM_PLAN.md](./CRM_PLAN.md).

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

Phase 2 is active. The old ticket bridge still exists as `window.tickets`, but it is now a compatibility adapter over `electron/store.js` and the Postgres API. Generic entity bridges are exposed for `window.deals`, `window.contacts`, `window.companies`, `window.tasks`, and `window.crmStore`; later phases re-instantiate ticketing through the card-system factory before those entities get full CRM surfaces.

MQTT is fully removed from the final CRM direction. Shared truth lives in Postgres through the API in `server/`; Electron talks to it through `electron/store.js`, with `window.tickets` kept as a compatibility bridge while the card engine is generalized.

The imported calendar currently initializes as its original full-window overlay. Phase 6 will split its navigation camera from calendar content and reuse that camera for Home and company drill-in.

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
