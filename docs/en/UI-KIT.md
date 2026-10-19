# UI Kit — surface roles and styling rules

> 🌐 **English** · [Russian](../UI-KIT.md)

> Dev doc (architectural conventions for UI developers). User documentation lives
> on the portal [docs.synth.itphx.ru](https://docs.synth.itphx.ru/).
> The rules are mandatory when editing `packages/ui` markup: colors come only from
> theme CSS variables/tokens — no hex/oklch literals and no hardcoded Tailwind
> palette.

## Sweep summary (inventory → result)

Measurements across `packages/ui/src`, excluding test files.

| Metric | Initially | After sweep-1..4 | After sweep-2 |
|---|---|---|---|
| distinct `bg-*` variants | 104 | **76** | **65** |
| hardcoded palette `bg-*` (occurrences) | ~40 | **16** | **3** |
| hardcoded palette `text-*` (occurrences) | ~185 | — | **11** |
| hardcoded palette `border-*` (occurrences) | ~23 | — | **2** |
| ad-hoc alphas (`bg-interactive-hover/50`, `bg-muted/30`, …) | many | eliminated | 0 |

**Sweep-1..4** (surface roles): 104 → 76 distinct `bg-*` variants, hardcoded palette
`bg-*` ≈ 40 → 16 occurrences; ad-hoc alphas reduced to roles; floating layers
switched to `bg-popover` + `text-popover-foreground`. The `panel` roles
(`bg-muted` / `bg-secondary` / `bg-sidebar`) and the `card`↔`popover` collision are
described below.

**Sweep-2** (targeted, semantics; this pass):

- log levels (`logviewer/logFormat.ts`) — `sky/emerald/amber/red/green-100..900`
  and the `dark:` pairing → `status-info|success|warning|error` (background `/15`,
  text);
- status icons/states (`layout/Header.tsx`, `chat/FileViewerTab.tsx`,
  `chat/CommitDetailTab.tsx`) → `text-status-*`;
- metrics legend (`panels/StatsTab.tsx`, 32 occurrences) → fixed theme palette slots
  `--palette-N` (inline style) rather than the Tailwind palette;
- links (`panels/ReferencesTab.tsx`) → `status-info` (hover preserved);
- resize handle (`layout/ResizeHandle.tsx`) → `hover:bg-primary`;
- secret placeholders (`chat/SecretPlaceholder.tsx`) → `--palette-13` (collapsed) /
  `--palette-3` (revealed).

Result: 16 hardcoded palette occurrences (3 `bg-` + 11 `text-` + 2 `border-`) stay
on purpose — see “Deliberately kept hardcoded colors”.

## Surface role contract

Final contract: any opaque surface is chosen from the table, not from the Tailwind
palette; semantics (statuses/metrics) come from the `status-*` tokens /
`--palette-N` slots.

| Role | Where it applies | CSS variable | Tailwind class |
|------|-----------------|----------------|----------------|
| **page** | application/screen background | `--surface-background` | `bg-background` / `bg-surface-page` |
| **panel** | side panels, wrapper sections | `--surface-muted` | `bg-sidebar` / `bg-muted` / `bg-surface-panel` |
| **card** | cards, content sections | `--surface-elevated` | `bg-card` / `bg-surface-card` |
| **inset** | nested block, list row, empty state | `--surface-subtle` | `bg-surface-inset` |
| **menu** | menu, popover, dropdown, drop-down list | `--surface-raised` | `bg-popover` / `bg-surface-menu` |
| **input** | input fields | `--input` | `bg-input` |

Semantic aliases (`--color-surface-*` in `@theme inline`,
`packages/ui/src/styles/design-system.css`) let you write `bg-surface-inset`,
`bg-surface-menu`, `bg-surface-card`, etc. — this is the preferred form for new
places; `bg-card`/`bg-popover` remain canonical for primitives.

### The fifth surface — `raised`

The theme gains an independent surface `surface.raised` / `surface.raisedForeground`
for the **menu** role (floating layers). CSS contract: `--surface-raised` /
`--surface-raised-foreground`; `--popover` → `var(--surface-raised)`,
`--popover-foreground` → `var(--surface-raised-foreground)`.

`raised` is added as an **optional** field of the `SurfaceColors` type: if a theme
does not define it, `cssGenerator` substitutes a fallback to `elevated` /
`elevatedForeground` (the behavior from before the field appeared does not change).
That way new themes can be rolled out gradually.

### Floating layer: surface + shadow, border outside the contract

A floating layer (menu, popover, dropdown, tooltip, context menu) is defined by the
**`menu` role + a shadow**: `bg-popover` (`--surface-raised`) +
`text-popover-foreground` + `shadow-lg`. **The border is not part of the contract.**
A `border` may be present as an optional reinforcement (the primitives' canon is
`border border-border`), but:

- it is not the defining trait of the layer — the separation comes from
  surface + shadow;
- it is not given a role color of its own (`border-sidebar-border` and the like) —
  only `border-border`;
- its absence does not make the layer “wrong”, while using it without a
  surface/shadow does (the layer would blend with the content).

## Rules

1. **Do not multiply ad-hoc surfaces** with arbitrary alphas
   (`bg-interactive-hover/50`, `bg-muted/30`, `bg-surface-subtle/50`, …). Need a
   surface — pick a role from the table above.
2. **Semantics — `status-*` tokens only.** Success/error/warning/info —
   `bg-status-success|warning|error|info` and the same-named `text-*`/`border-*`
   (an alpha `/15` is allowed for chips). Do not use `emerald/amber/yellow/blue/
   purple/red/…` from the Tailwind palette.
3. **Series/identities — `--palette-N` slots.** Categorical colors (metrics,
   entity colors, secret identity) come from the theme palette
   (`--palette-1..16`, `palette.colors`) — via an inline style or the Tailwind
   arbitrary `text-[color:var(--palette-N)]`. The same object/metric always gets
   the same slot in every place.
4. **Nested on a card — `inset`, floating — `menu`.** A nested block/row inside
   `bg-card` takes `bg-surface-inset`; a menu/popover — `bg-popover` (the `raised`
   surface) with the `shadow-lg` shadow (see the border rule above), so that it
   does not blend with the card.
5. **Empty states and list rows** — `inset` + border: `rounded-lg border
   border-border bg-surface-inset` with muted text (an icon if needed). Do not
   draw a “transparent rect with a border” (`border border-dashed` without a
   background) — such a placeholder does not read on different surfaces.
6. **Tabs** — a single pattern: the container uses `panel`, the active tab is
   lighter than the background (`bg-card text-foreground`), the inactive ones —
   `text-muted-foreground hover:bg-interactive-hover`. Reference —
   `ui/settings/controls/Tabs.tsx`; `RightPanel` follows the same look.

## Floating layers (recipe, implemented)

The depth of a floating layer is set by a **shadow-as-border**, not by a solid
`border`. The container carries a thin halo `ring-1 ring-foreground/10` along the
shadow contour plus the shadow itself; a solid border is not used here.

| Recipe part | Value |
|---|---|
| Halo border | `ring-1 ring-foreground/10` |
| Surface | `bg-popover` + `text-popover-foreground` (the `menu` role) |
| Shadow: menu/popover/select/context menu, including `ModelSelector`, `AgentModeSelector`, `ReasoningLevelSelector`, `MentionPopup`, `CommandAutocomplete` | `shadow-lg` |
| Shadow: tooltip | `shadow-md` |
| Shadow: dialog | `shadow-xl` (the dialog surface is `bg-background`) |
| Radii | concentric: container `rounded-xl` + `p-1`, items inside `rounded-lg` (the radius difference = the container padding) |
| Dividers | the `Divider` component (`components/ui/Divider.tsx`): in a floating layer `tone="raised"` + `inset` (the line does not touch the edges), on regular surfaces `tone="default"` (= `bg-border`) |

**Scrollable content in the `SelectContent` popup.** `BaseSelect.Popup`
(`components/ui/select.tsx`) must have `overflow-y-auto overscroll-contain` instead
of `overflow-hidden`: `SelectPositioner` enables the iOS mode with inline
`overflow: hidden auto; height: 100%` by default only when opened with the mouse,
and not when opened with a tap (`openMethod === 'touch'`). Without its own
scrolling, a long list on a phone is clipped by `max-h-60` and cannot be scrolled
with a finger. `rounded-xl` keeps clipping the content, so the rounded corners do
not suffer.

The iOS mode (`alignItemWithTrigger`) is **disabled** in the kit's `Select`
(`alignItemWithTrigger={false}` on `SelectPositioner`) for a consistent compact
dropdown on all devices and opening methods.

The `SelectContent` popup is **at least as wide as the trigger** but grows with
its content up to the available area: `min-w-[var(--anchor-width)] w-max
max-w-[var(--available-width)]` (Base UI puts the anchor width into the
`--anchor-width` CSS variable on the positioner and the available area into
`--available-width`). A narrow trigger (for example "INFO" in Debug) therefore no
longer clips longer items ("WARNING", "ERROR"), and the popup does not overflow a
narrow viewport. `truncate` on `BaseSelect.ItemText` remains as a safeguard: text
is clipped only when the item actually hits the available width.

The sign-in card (`components/auth/LoginForm.tsx`) follows the floating-layer
recipe, but on the **card** surface (`bg-card`): `rounded-xl` +
`ring-1 ring-foreground/10` + `shadow-xl`; the inner fields are `rounded-lg`
(concentric radii), the accent stripe on top is `rounded-t-xl`.

**Dividers.** Any divider is the `Divider` component
(`components/ui/Divider.tsx`), not an ad-hoc `border-t`/`border-b` and not a
standalone `<hr>`. In a floating layer (`bg-popover`) — `tone="raised"`
(`bg-popover-foreground/25`) + `inset`, so that the line does not touch the
container edges; the indentation is chosen per container (inside a menu's `p-1` —
`mx-2`). On regular surfaces — `tone="default"` (`bg-border`), without `inset`, if
the line is to divide the container entirely.

Affected components: `components/ui/contextMenu.tsx`,
`components/ui/popover.tsx`, `components/ui/select.tsx`,
`components/ui/dialog.tsx`, `components/ui/tooltip.tsx`,
`chat/ModelSelector.tsx`, `chat/AgentModeSelector.tsx`,
`chat/ReasoningLevelSelector.tsx`, `chat/MentionPopup.tsx`,
`chat/CommandAutocomplete.tsx`.

## Settings blocks (ADR-072)

A two-level “section → item” contract: the item background always differs from the
section background.

| Element | Role | Classes |
|---|---|---|
| `SettingsSection` (`components/ui/settings/SettingsSection.tsx`) | group (surface **elevated**) | `rounded-xl border border-border/60 bg-card p-4 space-y-3` |
| `SettingsItem` (`components/ui/settings/SettingsItem.tsx`) | item (surface **subtle**) | `rounded-lg border border-border bg-surface-inset p-3` |

Rules:

- **“item background ≠ section background”** — inside `bg-card` an item is always
  `bg-surface-inset` (not `bg-card` and not `bg-popover`).
- **Do not nest sections into each other** — take a nested group out into a
  separate `SettingsSection`; do not place identical surfaces in a row.
- **Interactive rows** (checkbox/radio, hover selection) must have
  `bg-surface-inset` — for example
  `flex … rounded-lg border border-border/60 bg-surface-inset … cursor-pointer`;
  a disabled row — the same background +
  `border-dashed … opacity-* cursor-not-allowed`.

Reference implementations: `NotificationSettings` (`SettingsSection` +
`SettingsItem`/`ToggleField`), `ToolsDisabledSettings` (checkbox rows, including
disabled ones), `CommandsSettings` (lists/rows).

## Suppressing the transition on theme switch

`ThemeCssGenerator.apply` (`packages/ui/src/lib/theme/cssGenerator.ts`) suppresses
animations before applying new CSS variables, otherwise the theme switch “drifts”
— the repaint of all surfaces gets animated.

Order:

1. remove the previous `#theme-transition-suppress` element if it is still there;
2. insert
   `<style id="theme-transition-suppress">*,*::before,*::after{transition:none!important}</style>`;
3. force a reflow (`void document.body?.offsetHeight`);
4. apply the theme variables;
5. remove the suppression after two frames (`requestAnimationFrame` →
   `requestAnimationFrame` → `remove()`).

## Deliberately kept hardcoded colors

The full list of deliberate exceptions to the “theme tokens only” rule. Each place
comes with a reason; once a canonical token appears — migrate it.

| Place | Colors | Reason |
|---|---|---|
| `chat/SubagentPart.tsx`, `chat/SubagentResumeBar.tsx` | `text-purple-300/400/500/600`, `bg-purple-500/5|10`, `border-purple-500/20` | **Subagent** identity (purple — a visual marker of a child session). There is no dedicated token; `AgentInfo.color` does not apply here (the block is not about a specific agent). Once a canonical subagent token appears — migrate it. |
| `tree/TreeNode.tsx` | `text-orange-400` (`hasUnread`) | The author's accent of an “unread” tree node (an entity without a saved color). Not a status (`status-warning` carries a different semantics) and not an entity palette slot. Pinned by `TreeNode.test.tsx`. |
| `components/ui/dialog.tsx`, `chat/DebugModal.tsx`, `App.tsx` | `bg-black/40|50|70` (scrim) | The darkening backdrop of modals/the drawer: a theme-independent black with alpha, not a surface. Replacing it with `bg-background/80` would change the look in light themes. |
| Syntax highlighting (editor, markdown, tool-render) | `--syntax-*` / `syntax.*` | Not hardcode: the colors come from the theme tokens `--syntax-*` (`cssGenerator.generateSyntaxColors`), but they need a highlighting semantics independent of the UI palette. Out of sweep scope. |

## Related places

- Theme types: `packages/ui/src/types/theme.ts` (`SurfaceColors`, `palette`).
- CSS variable generator: `packages/ui/src/lib/theme/cssGenerator.ts`
  (`generateTailwindVariables`, `generateSurfaceColors`, `generateSyntaxColors`,
  `--palette-1..16`).
- Tailwind tokens: `packages/ui/src/styles/design-system.css` (`@theme inline`,
  `--color-surface-*`, `--color-status-*`).
- Entity palette resolver: `packages/ui/src/lib/projectMeta.ts`
  (`PROJECT_COLOR_MAP` → `var(--palette-N)`).
- Floating-layer primitives: `components/ui/popover.tsx` (menu),
  `components/ui/select.tsx` (menu), `components/ui/dialog.tsx` (scrim).
- Settings block primitives: `components/ui/settings/SettingsSection.tsx`,
  `components/ui/settings/SettingsItem.tsx` (ADR-072).
