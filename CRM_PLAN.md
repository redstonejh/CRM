# CRM Plan v3 — Same Canvas, Same Legos, Curated With Judgment

The base program's front end — the shell, the glass, the grid, the sixty runtime modules — is the product's foundation and it does not get rebuilt. On top of it, every lego (card, deck, bucket, detail panel, fractal camera) gets **interrogated, not xeroxed**: kept, generalized, simplified, stripped, or — when the CRM truly demands it — extended with an invention that speaks the design language natively.

---

## 1. The three layers, and what's allowed in each

**Layer 1 — The Canvas (untouchable).** Everything that survives if you "take away all buckets and tickets": the Electron shell, tokens/themes/glass/liquid-glass, the widget-grid workspace and its ~60 runtime modules (layout persistence, undo history, pages/tabs, group ops, LOD, conditional styling, inline editing, toasts, tool drawer, keyword search), auth/SSO, the canonical menus. This layer is identical in all three repos today and stays identical in the merged program. Changes here need extraordinary justification.

**Layer 2 — The Engines (the legos — judged piece by piece).** `ticket-stacks.js`, `ticket-detail.js`, `fractal-calendar.js`, the ticket schema, the severity system, the deck/bucket choreography. These are working material: their logic and styling get abstracted, tweaked, simplified, or partially stripped to serve the CRM — with a recorded verdict and reason per piece (§3).

**Layer 3 — The Modules (CRM instances + honest inventions).** Pipeline, People, Companies, Calendar, Tasks, Reports, Home — each assembled from Layer-2 engines on the Layer-1 canvas. New code is allowed here, but only in the existing idioms and only after the question "could an existing arrangement do this?" has been asked and answered in writing.

A structural fact worth naming: the app already has **two planes**. The widget-grid plane (the dashboard canvas, z-order of the grid) and the **overlay theater** (`position:fixed` surfaces — ticket stacks live at z 3900–7000, the fractal calendar at z 800). Cards, decks, buckets, and the calendar all perform on the overlay; charts and tables live on the grid. The CRM keeps this split: module views are overlay performances, Reports and workbenches are grid residents.

---

## 2. The interrogation — the questions asked of every component

Every Layer-2 piece, and every proposed reuse, answers these before code is written:

1. **Do we need it at all?** (We used X in ticketing; tickets are becoming deals — does X's *reason* still exist?)
2. **Is it already general?** (Sometimes the answer is yes and the honest move is: touch nothing.)
3. **Should it be abstracted into a real system?** — only when it will have ≥2 genuinely different consumers *and* the entity-specific surface is demonstrably small. Abstraction must be earned by evidence, not aesthetics.
4. **Can it be simplified?** Does the CRM context need less than the ticketing context did?
5. **What must be stripped?** Which styling/semantics are monitoring-flavored and wrong for a CRM?
6. **Am I copying because I'm scared to touch it?** Verbatim duplication is only correct when the pieces will *diverge* by design. Fear is not a reason.
7. **Does this demand an invention?** If yes: smallest possible, built from existing materials, styled by DESIGN_SYSTEM recipe, and it must look like it was always there.

Every answer goes in a **decision log** (one line: component → verdict → reason). That log is the project's conscience — it's how you audit later whether the eye stayed good.

---

## 3. The verdicts (made now, with the evidence)

### `ticket-stacks.js` (2,743 lines) → **GENERALIZE** into the card-system engine
The evidence says the coupling is thin: `window.tickets` appears **8 times** in 2,743 lines. Everything else — deck fanning, bucket zones, drag choreography, stage/order persistence, trash, scroll rows, the menu — is entity-blind. Stronger still: the card face already routes through a **meta-override layer** (`metaOf` → client/title/subtitle), built because the ticket API couldn't edit `companyLabel`/`host`. The file already *wanted* to be generic; ticketing's API just wouldn't let it. Finishing that thought is honoring the code, not rewriting it.

The generalization is surgical: the IIFE becomes a factory taking `{ source, stages, palette, cardFace, verbs }` — the 2,700 lines of choreography untouched, the ~6 entity touchpoints (data source, `STAGES`, `SEV_RGB`, title/sub derivation, resolve-verb, trash semantics) lifted to config. The meta-override system gets *retired* where the new store makes fields properly editable (a strip: it was a workaround, and its reason dies with the old API). Instances: deals, contacts, tasks, invoices-someday.

*(v2 of this plan said "vendor three verbatim copies." That verdict is overturned by question 6: the copies would differ in 6 config points and share 2,700 lines of choreography — copying that is fear, and three copies of one bug is the price.)*

### `ticket-detail.js` (660 lines) → **GENERALIZE** choreography, **PER-ENTITY** content
The context-aware open (clone glides by card location, panel tucks left, close flies back) is pure choreography — zero ticket semantics in the motion. The panel *contents* (fields, actions) are per-entity by nature. Split accordingly: motion engine shared, panel body a per-entity template. The priority row becomes config (deals: temperature; tasks: priority as-is; contacts: probably nothing — see glow verdict).

### `fractal-calendar.js` (420 lines) → **SPLIT** camera from calendar
The uniform-scale morph, layer stack, hover pre-warm, and k-scaled bucket object are a *navigation camera* with three confirmed consumers: the calendar, the home menu, and diving into a company. The month/day math is calendar content. Split the file along that line; the calendar keeps its content, the camera becomes shared. Sanctioned tweaks: `YEAR = 2026` parameterized + year paging (a small honest invention).

### Severity glow (`SEV_RGB`) → **KEEP / RETHINK / STRIP, per entity**
Deals: keep — temperature (cold→hot pipeline) is exactly what the four-step glow was born for. Tasks: keep as-is — it *is* priority. **Contacts: strip.** A human being glowing critical-red like a failing server is emotionally wrong for a CRM; relationship health wants something quieter — a small status dot or a slow desaturation as contact goes stale, built from tokens. This is the "styling stripped away" case.

### Corner decks → **SIMPLIFY, per module**
Ticketing needed two (unresolved inbox / resolved archive). Pipeline: two still earns its keep (unassigned leads inbox / Won pile as the right deck — the win pile is a *reward*, worth keeping visible). People view: **one** deck — "needs attention" (the red-rising-edge *idea* — sustained-signal detection — abstracted from outage detection to "no touch in N days"). Two decks of people would be clutter. Calendar view: zero decks by default; a deck appears only while dragging-to-schedule. The deck count is a per-module design decision, not a fixed feature.

### Trash bin → **KEEP** as the universal soft-delete
Recoverable delete is more important in a CRM than in ticketing. The existing flip-the-right-deck-to-trash pattern generalizes cleanly. One change: the client-side "deleted flag in localStorage" becomes a `deletedAt` on the doc — shared truth (same reasoning as stages, below).

### Stage/order in `localStorage` → **MOVE to the doc** (a simplification, not a feature)
`tk-ticket-stage`, `tk-stage-order`, deck orders, trash flags — per-machine state, correct for a solo operator, wrong for a team CRM where the pipeline is shared truth. Stage and rank move onto the doc through the store; the optimistic apply-then-persist choreography already in the code stays, so the feel is unchanged. Per-user cosmetics (which deck is fanned open) stay local.

### Stubbed `window.dashboard` → **KEEP monitor bridge stubbed, REPLACE the empty workspace**
Ticketing neutralized the monitor's data feeds with a stub so the shell renders empty. The monitor bridge itself stays empty because `status-feed.js` is circuit-specific. The CRM replaces the empty builder workspace by feeding `builder`, `builder-chart`, and `builder-table` real aggregates (pipeline value by stage, win rate, activity volume, recent records) through the existing widget data runtime and a CRM-specific API bridge.

### Monitoring semantics (`recoveredAt`, episode keys, red rising edge) → **STRIP the words, KEEP the ideas**
The outage vocabulary goes. The *patterns* transfer: deterministic id from an episode → deterministic dedupe of imported records; rising-edge detection → staleness detection on relationships; `recoveredAt`-without-close → "re-engaged" marker on a cold contact.

### The ticket schema → **KEEP as the universal envelope**
`{ id, createdAt, updatedAt, version, history[], assignee }` + entity fields. `history[]` is already the activity timeline; `comment` is already notes. Tasks keep `open|claimed|resolved` verbs verbatim — they were always task verbs.

### The canvas modules (all ~60) → **KEEP, untouched**
Search, undo, pages, LOD, inline editing, tool drawer, toasts, form bindings — all consumed as-is. LOD specifically is what makes 200 deal cards viable; it exists because someone already fought that battle.

---

## 4. The honest inventions (small, and in the language)

Each of these passed question 7 — no existing arrangement covers it:

- **Drop-to-link.** Relating records (contact ↔ deal) has no precedent in ticketing. Invention: drag a card onto another card/bucket → a link, with the same fly-in physics as drag-to-grid. New *gesture meaning*, zero new visual species.
- **Quick-add.** Creating a contact/deal from anywhere: the tool-drawer idiom + the "+" that ticket-stacks already has on decks, generalized to entity choice. Mostly composition, thin invention.
- **Year paging** in the calendar (the level-0 strip). Small, sanctioned above.
- **Aggregates feed** (server-side) for the builder widgets — invisible invention, no UI at all.
- **Home menu instance** of the camera: 6 module buckets instead of 12 months, each mini bucket a live k-scaled preview of its module. Not really an invention — the camera's second booking.

Anything else that comes up mid-build goes through §2 first, and the default answer to "new UI species?" is no.

---

## 5. Repo + backend

One central repo: the merged base program (mechanical 7-file merge — base `ticketing`, add `fractal-calendar.js` + one script tag, two identity strings) + `server/`.

The MQTT idea is dead here, not deferred. There is no retained broker tree, no `tickets/#`, no broker settings, and no MQTT dependency in the final CRM. The backend is **Postgres behind an API**:

- Postgres table with envelope columns (`entity_type`, `id`, `created_at`, `updated_at`, `version`, `deleted_at`, `assignee`) plus `doc JSONB` for entity fields.
- REST endpoints for list/get/create/update/delete.
- One WebSocket change stream so Electron clients refresh from shared truth.
- Compare-and-set on `version` for updates and deletes.

The swap happens at the preload seam: `electron/tickets.js` becomes a compatibility adapter over `electron/store.js`, and `electron/store.js` speaks to the Postgres API. The renderer keeps the same contract shape per entity (`window.tickets`, `window.deals`, `window.contacts`, …), and the proof of a clean seam is that Layer 1 needs zero changes to run on it.

---

## 6. Roadmap

`CRM_VISION.md` in the parent CRM workspace extends this original roadmap beyond Phase 7. The active continuation is Phase 10: Today hand plus Cold Front derivation on the Postgres/API backend.

| Phase | Work | Layer touched |
|---|---|---|
| **1** | Mechanical merge; both experiences in one shell; decision log opened | none (assembly) |
| **2** | Remove MQTT fully; add Postgres API + `store.js`; ticketing runs through the API with zero canvas changes | seam only |
| **3** | Card-system factory from `ticket-stacks.js`; tickets re-instantiated through it (proof: behavior identical); detail split (motion/content) | Layer 2 |
| **4** | Pipeline module (deals instance + temperature palette + Won deck + drop-to-link) | Layer 3 |
| **5** | People module (contacts instance, glow stripped, attention deck, company buckets) | Layer 3 |
| **6** | Camera split; Calendar gets card drops + year paging; Home menu instance | Layers 2–3 |
| **7** | Reports (aggregates → builder widgets), quick-add, team polish | Layer 3 |
| **8** | Money module, invoices/interactions, invoice aging, interaction fan-out, overdue nudges | Layer 3 + API |
| **9** | Next-Touch Law interceptor, `nextTouchAt` card faces, calendar/report surfacing | Layers 2–3 + API |
| **10** | Today surface, morning deal, Cold Front derivation and attention detector | Layers 2–3 + API |

Phase 3 is the crux and carries its own test: **re-instantiate ticketing through the factory first**. If tickets don't behave byte-for-byte identically through the generalized engine, the abstraction is wrong — fix it before any CRM entity touches it.

---

## 7. Risks

- **The factory refactor is the one place we touch a big Layer-2 file.** Mitigation is the Phase-3 test above: tickets themselves are the regression suite for the generalization.
- **Judgment drift** — the "good eye" degrading into either slop (inventing freely) or fear (copying blindly). The decision log + §2 questions are the guardrail; DESIGN_SYSTEM's drift checklist remains law for anything visual.
- **Feel changes** from localStorage → shared truth: masked by the existing optimistic-apply pattern; verify on the pipeline first, where reorder frequency is highest.
- **API/change-stream parity** must be exact enough that the old ticket UI cannot tell whether records arrived from local cache or the Postgres API. Mitigation: keep `window.tickets` as an adapter over `store.js`, verify ticketing first, then add other entities.

---

*One sentence: keep the immense canvas exactly as it is, finish the abstractions the code already started (the card system that was straining against the ticket API, the camera trapped inside the calendar), strip what's monitoring-flavored, invent only what passes interrogation — and log every verdict so the eye stays honest.*
