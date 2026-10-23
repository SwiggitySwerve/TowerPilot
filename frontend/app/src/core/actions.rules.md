# Timed action rules
> **Status:** Active
> **Created:** 2026-10-23
> **Updated:** 2026-10-23

`actions.ts` owns what the app knows about a timed action (brief
`backend/logs/reviews/ui-pages/a2-7-actions-brief.md`, refactor R1). Consumers call it; no other
module names a routine in a list, a field order or a name lookup.

- **Projection views.** `actionsView(battle)` reads `battle.runtime.actions` into plain values:
  the envelope (`schema_version`, `observed_at`, `control_revision`, `context`) and each item's
  `id`, `instance`, `label` and descriptor fields. It returns null when the battle publishes no
  `actions` key. Server text (labels) stays raw; only the selectors turn it into `ServerText`.
- **Routine key.** An item's controls live at `routines.<key>.<field>` and its Run now token is
  `<key>[:<variant>]`. The key is the published `key`; without one it is `id` only when the
  item is its action's single instance (`instance === id`, gap G2), otherwise null and the item's
  controls cannot be addressed.
- **Compatibility list (S5).** `COMPAT_ROUTINES` (Ad gems, Floating gems, Shopping, in the
  Dashboard's row order) and `COMPAT_FIELDS` (the editor's field order) are the one copy of the
  pre-A2 routine and field lists. A driver that never built the projection runs pre-A2 code,
  which can publish only these. Root decision Q1 keeps them until every driver publishes
  actions (end of roadmap item 7); AC12 deletes them. `compatClaimLine` keeps the per-routine
  confirmed-result line of those rows until C1 reads `item.last`.
- **Shopping predicates (S2).** `isShoppingAction` (the shopping action or a variant) and
  `isShoppingVariant` (`shopping:<section>[:<upgrade>]`) are the one test for the shopping
  queue's own rules (queue gate, Try once, command states). An action named `shopping<x>`
  without the colon is not shopping.
- **Field order.** A live editor row lists a routine's fields in its item's live descriptor
  order, else in `COMPAT_FIELDS` order, then every other reported field in its reported order
  (`liveFieldOrder`, `orderedFields`); the saved editor uses `COMPAT_FIELDS` until the saved read
  carries descriptors (B12). The column header stays `COMPAT_FIELDS` until C2.
- **Live bounds (R2).** `liveConstraints` gives a battle's live number fields the bounds of
  their addressable item's descriptor (`min`, `max`; null is no bound); every other path keeps
  the saved run's `constraints` as read, and a battle without a projection uses only those. On
  every recorded pair (checkout and the r17b candidate) the two sources are equal, so the switch
  changed no recorded output (`tests/core/actions.test.ts`). With a projection the live editor's
  bounds are known before the saved run is read (`hasLiveBounds`), so `boundsKnown` and its
  notice follow both sources.
- **Name and label lookups.** `actionName` and `fieldLabel` take the caller's code-keyed copy
  table and its fallback entry (`copy.actions`); a code read only as an OWN key of the table
  (`core/read.ts` `ownOr`), so an inherited name such as `constructor` is never a name.
- **Enforcement.** `tests/core/actionsEnforcement.test.ts` fails when a quoted `ad_gems`,
  `floating_gems` or `shopping` appears in `src` outside this module and the S1 to S4 allowlist,
  or when an allowed file's count changes. `tests/store/actionsDump.test.tsx` holds the R1/R2
  output dump over every recorded battle and saved read.