# CRM

Phase 1 assembly for the modular CRM described in [CRM_PLAN.md](./CRM_PLAN.md).

This repo currently starts from the `ticketing` shell, keeps the ticket stacks/detail surface active as the regression baseline, and imports `fractal-calendar.js` into the same canvas. The decision log for each reuse verdict lives in [DECISION_LOG.md](./DECISION_LOG.md).

## Run / build

```bash
npm install
npm start
npm run make
```

## Source repos

- `ticketing`: base shell, ticket backend seam, card stacks/detail.
- `fractal-calendar-planner`: calendar engine imported for Phase 1.
- `name-and-info-cards`: People-module reference for later phases.

## Phase 1 baseline

The dashboard shell remains the vendored canvas: auth, layout persistence, widget grid, visual tokens, glass styling, window controls, and the existing runtime modules are kept intact.

The active data bridge is still `window.tickets` for this first assembly. Later phases replace that seam with the generalized store described in the plan, then re-instantiate ticketing through the card-system factory before deals, contacts, and tasks are added.

The imported calendar currently initializes as its original full-window overlay. Phase 6 will split its navigation camera from calendar content and reuse that camera for Home and company drill-in.

## Verification

The current smoke test is the Electron Forge package build:

```bash
npm run package
```
