# Design System — Status Monitor (tray + dashboard)

**This file is the single source of truth for the visual language.** If you are
building a new surface (or another app in this family) and want it to match with
**zero visual drift**, copy the recipes below verbatim. Every value here is the
*actual* value in the code, not an approximation. When you change a primitive,
change it here too.

Surfaces:
- **Dashboard** — the Electron window. CSS lives in `status-monitor-client/dashboard/app/static/*.css`. Loaded by `dashboard/index.html` in this order: `tokens → base → components → dashboard-grid → themes → utilities`. **No HMR** — reload the window to see CSS/JS edits.
- **Tray popover** — the small React window (`status-monitor-client/src/`, `App.css`). Vite **does** hot-reload it.

---

## 1. Materials — "acrylic" vs "glass" vs "liquid glass"

Three *different* translucency mechanisms. Don't confuse them.

### ACRYLIC = the native OS window material (tray popover only)
"Acrylic" means the **operating system** frosts whatever is *behind the window*
(the desktop, other apps) — it is not a CSS effect.
- Created in `electron/main.js` when the popover window is built:
  - **Windows 11:** `opts.backgroundMaterial = 'acrylic'` (DWM acrylic). Requires `transparent:false` + `backgroundColor:'#00000000'`, and the window must keep `WS_THICKFRAME` or DWM won't paint the acrylic. The renderer adds `body.win-acrylic`, which **squares the panel corners** (`border-radius: 0`) because DWM rounds the window at its own native radius — otherwise you get blurred-acrylic wedges in the corners.
  - **macOS:** `opts.vibrancy = 'under-window'`.
- Over that OS acrylic, the popover paints **one** translucent tint — `.panel` in `App.css`:
  ```css
  .panel {
    background: linear-gradient(180deg, rgba(31, 41, 55, 0.55), rgba(24, 32, 44, 0.5));
    -webkit-backdrop-filter: blur(18px) saturate(135%);
            backdrop-filter: blur(18px) saturate(135%);
  }
  body.win-acrylic .panel { border-radius: 0; }   /* DWM owns the corners */
  ```
- The tray popover uses CSS acrylic, **not** the WebGL shader — its canvas is hidden so the OS acrylic frosts the real backdrop.

### GLASS = CSS `backdrop-filter` frosted surfaces (dashboard chrome, menus, wells)
A CSS-only frost of whatever DOM is behind the element. The **canonical glass recipe** (themes.css) is:
```css
border-color: var(--glass-border);            /* rgba(190,202,220,.82) */
background:   var(--glass-surface-strong);     /* rgba(255,255,255,.84) */
box-shadow:   var(--shadow-glass);             /* 0 18px 42px rgba(15,23,42,.10), inset 0 1px 0 var(--glass-highlight) */
backdrop-filter: blur(18px) saturate(1.12);
-webkit-backdrop-filter: blur(18px) saturate(1.12);
```
Blur scales with surface importance: chrome/menus `blur(18px)`, popovers `blur(22–26px)`, small controls `blur(10px)`. Always pair `-webkit-backdrop-filter`.

### LIQUID GLASS = the WebGL refraction shader (dashboard panels & widgets)
A single full-viewport WebGL canvas (`liquid-glass-webgl.js`, `pointer-events:none`) that **refracts the live workspace background** behind these surfaces, with edge-weighted distortion + inner-rim glow. It is **always on**.
- Refracted targets (`OBJECT_SELECTOR`): **`.db-panel`, `.widget-card`, `.app-nav.workspace-chrome.floating-control-bar`** — and nothing else. The round top-bar buttons are deliberately excluded (refraction looked wrong on small circles).
- When `body.webgl-glass-on`, panels drop their CSS fill so the shader-refracted backdrop *is* the surface; the CSS glass recipe above is the fallback when the shader is off.

**Rule of thumb:** popover → OS **acrylic**. Dashboard panels/widgets → **liquid glass** (WebGL) with CSS glass fallback. Dashboard menus/wells/buttons → CSS **glass**.

---

## 2. Tokens (`dashboard/app/static/tokens.css` `:root`)

Always use these vars; never hardcode a hex that a token already covers.

**Surface / ink**
`--surface #fff` · `--surface-soft #f2f6fb` · `--ink #1f2937` · `--ink-strong #111827` · `--muted #64748b` · `--muted-strong #475569` · `--line #c4cedd` · `--line-soft #d8e0ec`

**Brand / semantic**
`--blue #2563eb` (hover `--blue-hover #1d4ed8`, soft `--blue-soft #eff6ff`) · `--red #dc2626` · `--amber #d97706` · `--green #10b981` · `--ok #0f766e`

**Glass**
`--glass-surface rgba(255,255,255,.68)` · `--glass-surface-strong rgba(255,255,255,.84)` · `--glass-border rgba(190,202,220,.82)` · `--glass-highlight rgba(255,255,255,.60)`

**Shadows**
`--shadow-card 0 2px 7px rgba(15,23,42,.045)` · `--shadow-glass 0 18px 42px rgba(15,23,42,.10), inset 0 1px 0 var(--glass-highlight)` · `--shadow-control 0 8px 20px rgba(15,23,42,.08), inset 0 1px 0 var(--glass-highlight)`

**Radii** `--radius-lg 24px` · `--radius-md 16px` · `--radius-sm 12px` · `--radius-pill 999px`
**Spacing** `--space-4 4px` `--space-5 5px` `--space-6 6px` `--space-8 8px`
**Motion** `--motion-fast .15s ease` · `--motion-grid .18s cubic-bezier(.2,.8,.2,1)` · `--motion-popover .18s ease`
**Z-index** `--z-header 1500` · `--z-popover 1600` · `--z-modal 1700` · `--z-menu-overlay 2600`
**Text weight** `--ui-text-weight 760` (the UI runs heavy/semibold by default)

**Spatial CRM type ladder** (`base.css`; choose by meaning, never by visual guess)

| Role | Token | Size |
|---|---|---:|
| Room heading | `--crm-type-room` | 17px |
| Home tile heading | `--crm-type-tile` | 15px |
| Bucket / object heading | `--crm-type-object` | 14px |
| Menu / control label | `--crm-type-control` | 13px |
| Reading copy / section label | `--crm-type-body` | 12px |
| Supporting caption | `--crm-type-caption` | 11px |
| Timestamp / quiet metadata | `--crm-type-meta` | 10px |
| Dense micro-label | `--crm-type-micro` | 9px |

Card faces retain their proven physical proportions through the semantic
`--crm-type-card-title` and `--crm-type-card-caption` tokens. Responsive or
container-relative sizes are reserved for camera content whose physical scale
actually changes; ordinary interface text does not invent local `rem` values.

---

## 3. Status colours (THREE context-specific palettes — do not mix them)

There is no single "red". Pick the palette by context:

| Context | green | amber/yellow | red | grey |
|---|---|---|---|---|
| **Tray icon / popover / traffic-light** (`icons.js`, `status-feed.js` `STATUS_COLORS`) | `#32d74b` | `#ffd60a` | `#ff453a` | `#8e8e93` |
| **Dashboard chart HP bars** (`widget-registry.js`) | `#6fc99a` | `#d4ab63` | `#e1857c` | — |
| **Adaptive stat-card accents** (`status-feed.js` `ADAPTIVE_STATUS_COLORS`) | `#16a34a` | `#ca8a04` | `#dc2626` | — |

The tray/popover palette is the "vivid traffic-light" set; the chart palette is intentionally softer (stacked bars); the stat-card palette is the saturated web set. Donut/pie band colours live in `src/components/pie-geometry.js` (`PIE_COLORS`).

**Status meaning** (do not reinvent — from `main.js`): a single failed check = a **"down"**; **4 consecutive downs = a "failure"** (`CRITICAL_DOWN_STREAK`). green = healthy · amber = flaky (downs not in a row, or degraded: loss>0 / latency > `max(avg·2.2+25, 40)`) · red = failure (sustained outage).

---

## 4. THIS IS HOW YOU MAKE A PANEL (dashboard)

Markup (panels are built by `app.js`/`status-feed.js`; this is the runtime shape):
```html
<div class="db-panel">                <!-- liquid-glass refracted; add db-panel-custom-color for a tinted panel -->
  <div class="db-panel-hd">           <!-- header: caret + title -->
    <div class="db-panel-title">…</div>
  </div>
  <div class="db-panel-body">
    <div class="panel-internal-widget-grid"> … .widget-card … </div>
  </div>
</div>
```
- The panel surface is **liquid glass** (it's in `OBJECT_SELECTOR`) with the §1 CSS glass recipe as fallback. Don't give it an opaque background.
- A user-recoloured panel adds `db-panel-custom-color` + a `--panel-accent` (the header/well tint derive from the accent; see themes.css `.db-panel.db-panel-custom-color > .db-panel-hd`).
- Internal widget grid rows are **66px** (workspace grid rows are **81px**) with a 10px gap — match these or the layout reflow breaks.

---

## 5. XYZ IS THE BUTTON CSS

There are two canonical buttons. Pick by surface.

### Circular glass control — the tray-style icon buttons (dashboard top bar)
`.window-glass-control` (themes.css). Icon is a 15×15 CSS `mask` on `::before`.
```css
.window-glass-control {
  width: 34px; height: 34px; border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--glass-border) 72%, transparent);
  background: transparent;            /* it reads as glass via the shadows, not a fill */
  color: rgba(255,255,255,.96);
  box-shadow:
    0 9px 20px rgba(15,23,42,.16),
    inset 0 1px 0 color-mix(in srgb, var(--glass-highlight) 76%, transparent),
    inset 0 -8px 16px rgba(15,23,42,.08);
  backdrop-filter: none;              /* static glass — NOT refracted */
  transition: transform .18s cubic-bezier(.19,1,.22,1), background .18s, box-shadow .18s, color .18s;
}
```

### ⛔ There is NO blue / oval / glowing button — anywhere
The old global blue-pill `button {}` style (999px radius + `var(--blue)` background +
`0 10px 22px rgba(37,99,235,.20)` glow) is **DELETED** from `base.css`. A bare
`<button>` now carries **no chrome** — it inherits text + a pointer, nothing else.
Never reintroduce a default button background, border, radius, or box-shadow.

**Actions inside a menu/panel are menu items**, not buttons — copy `.auth-menu-item`
(see §6): flat, full-width, `border:0`, transparent background, `border-radius:8px`,
**colour-only hover** (`rgba(255,255,255,.62)` → `#fff`). No fill, no border, no blue.

The only "button" with chrome is the **circular glass control** above
(`.window-glass-control`) — and that reads as glass via shadows, not a fill.

> Hover model (dashboard chrome): hover is **colour/shadow only**, never a size change; the lift is the CSS `translate` (not `transform`) property and is frozen during drag/resize via `body.panel-interaction-active`.

---

## 6. THIS IS HOW YOU MAKE A MENU / DROPDOWN (dashboard)

> ### ⭐ THE CANONICAL MENU — read this first
> **When the user says "menu" as a reference, they mean the ACCOUNT DROPDOWN and the BACKGROUND PICKER.**
> Search, Desk, ticket screens, and all other UI are consumers, never sources.
> Any new menu, dropdown, flyout, or popover must match these two references exactly. Do not infer a new look from a consuming screen.

The account menu and background picker own one byte-identical frosted-glass recipe. Search, the account submenu, Layout flyout, and other menus copy it (auth-ui.js pins `.auth-submenu` as "byte-for-byte identical to `.auth-profile-menu`"). Copy this exactly:

```css
/* THE MENU — account dropdown / background picker recipe */
.menu {
  padding: 9px 6px;
  border-radius: 14px;
  background: linear-gradient(180deg, rgba(22,26,36,0.62), rgba(12,16,24,0.55));
  -webkit-backdrop-filter: blur(26px) saturate(140%);
          backdrop-filter: blur(26px) saturate(140%);
  border: 1px solid rgba(255,255,255,0.22);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.24), 0 18px 42px rgba(0,0,0,0.4);
  display: flex; flex-direction: column; gap: 9px;
}
```

**The two references and their live consumers:**

| Instance | Selector | Where it's defined |
|---|---|---|
| **Account menu** ⭐ reference | `.auth-profile-menu` (items: `.auth-menu-item`) | `auth-ui.js` injected `<style>` (~610) |
| **Background picker** ⭐ reference | `.bg-picker-pop` | `themes.css` (~4034) |
| Search popover (consumer) | `.dashboard-search-popover` (results reuse `.auth-menu-item`) | `themes.css` + `crm-record-search.js` |
| Account submenu (consumer) | `.auth-submenu` | `auth-ui.js` (pinned identical to account menu) |
| Company overflow (consumer) | `.company-overflow-menu` | `themes.css` |

Only the two ⭐ rows are references. Every other row is tested against them and must never be used to justify a new style.

**Menu items** (the row styling inside the menu) — flat, left-aligned, hover is colour-only:
```css
.auth-menu-item {                 /* = the row inside THE menu */
  display: flex; align-items: center; justify-content: flex-start; text-align: left;
  width: 100%; border: 0; outline: 0; box-shadow: none;
  border-radius: 8px; padding: 0 12px; margin: 0;   /* NO vertical padding — see rule 1 */
  cursor: pointer;
}
/* hover: background tint / colour ONLY — never a size change, never a blue pill */
```

**Two hard rules** (the user enforces these):
1. **Equal-gap spacing.** The rim and item interval use `9px`: `gap: 9px` + `padding-block: 9px`. Put item spacing in the **gap**, never in item padding. Items must be `flex-shrink: 0` or multi-line rows crush and overlap.
2. **No blue selection chrome.** Options are flat, colour/label only — the selected one is marked subtly (e.g. `.is-selected`, bold), never a blue pill/highlight.

> GOTCHA: a `backdrop-filter` element nested inside another `backdrop-filter` element renders **flat** (Chromium ignores it). Portal submenus/flyouts out onto a non-filtered root (`document.body` / `.workspace-menu-overlay-layer`) and reuse the parent's exact recipe, or they won't match.

---

## 7. Source-of-truth file map

| Thing | File |
|---|---|
| Tokens (colours, radii, spacing, shadows, glass vars) | `dashboard/app/static/tokens.css` |
| Base elements + pill buttons + forms | `dashboard/app/static/base.css` |
| Panels, widget grid, charts/tables, glass surfaces, menus, top-bar controls | `dashboard/app/static/themes.css` + `dashboard-grid.css` |
| **⭐ Canonical menu reference — account** (`.auth-profile-menu`, `.auth-menu-item`) | `dashboard/app/static/auth-ui.js` (injected `<style>`, ~610) |
| **⭐ Canonical menu reference — background** (`.bg-picker-pop`) | `dashboard/app/static/themes.css` (~4034) |
| Search menu consumer | `dashboard/app/static/crm-record-search.js` + `.dashboard-search-popover` in `themes.css` |
| Liquid-glass WebGL shader + which elements refract | `dashboard/app/static/liquid-glass-webgl.js` |
| Tray popover surface (CSS acrylic) + tints + status buttons | `src/App.css` |
| Native OS acrylic/vibrancy window | `electron/main.js` (popover `BrowserWindow`) |
| Tray status icon (traffic light) | `electron/icons.js` |
| Donut/pie band colours | `src/components/pie-geometry.js` |
| Status meaning / down vs failure rules | `electron/main.js` |

## 8. Drift-prevention checklist
- Use a **token** for any colour/radius/shadow it covers; don't hardcode.
- Match the **material** to the surface (§1) — popover = OS acrylic; dashboard panel = liquid glass; menu = CSS glass.
- Pick the **right status palette** for the context (§3) — they are not interchangeable.
- Any **menu / dropdown / flyout / popover** copies the **account dropdown + background picker** recipe (§6), verbatim. Search and Desk are never references. Follow the **equal-gap** and **no-blue-selection** rules.
- Never nest `backdrop-filter` inside `backdrop-filter` — portal it out.
- Dashboard has **no HMR**: reload the window and verify visually (CDP/Playwright), don't assume.
