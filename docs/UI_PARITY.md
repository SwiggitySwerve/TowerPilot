# Dashboard UI parity checklist
> **Status:** Active
> **Type:** Checklist
> **Created:** 2026-10-30
> **Updated:** 2026-10-30
> **Tags:** ui, regression, parity, frontend

Every visual cue or function the React dashboard (`frontend/app`) lost against the legacy
vanilla-JS dashboard, with the shared primitive that should restore it and a fact a Playwright
assertion can check. Each page PR of
[Restore the legacy UI idiom](pending-tasks/%5B2026-10-30%5D%5BIn%20Progress%5D%20Restore%20the%20legacy%20UI%20idiom.task.md)
is checked against its section here, and a row only closes when its acceptance condition is a
passing assertion (test titles start with the row id).

---

## How to read the rows

**Legacy** points into the deleted legacy tree. It is the parent of the deletion commit:
`git show 84123e7c^:frontend/webui/<file>`. Paths below are relative to `frontend/webui/`.
`index.html` carries the inline `<style>` and the page scripts; the other files are named in
the row. Line numbers are those of that revision.

**New** points into `frontend/app/src/` at `master` when this file was written. Paths are
relative to that folder.

**Primitive** is one of the shared vocabulary built in PR1: `ToggleChip` (a chip or switch that
toggles), `ChipField` (a chip that carries inline inputs while selected), `ChipGrid` (an
auto-fill grid of chips), `MarkChip` + `MarkLegend` (marks such as check and star, with a
one-line legend), `PriorityQueue` (numbered, draggable, with up/down and an end slot),
`RecordRow` (a one-line row with inline actions), `KindTag` (a small tinted kind badge),
`StatusDot` (a tinted dot or tone) and `CompactField` (a label and control on one line).
Two rows name a primitive outside that list because none fits: `SaveBar` and `EditDialog`
(see [Primitives proposed beyond the vocabulary](#primitives-proposed-beyond-the-vocabulary)).

**Acceptance** is stated as a DOM or geometry fact at the three measured viewports
(1360, 1054 and 390 px wide). Where a number is given it was measured on the legacy page or
read from its CSS in this review.

**Evidence** is `capture` when the legacy cue shows in a legacy capture, `source` when it is
only in the legacy code (the fixture did not reach that state), and `both` when both agree.

---

## Shared cues

| ID | Lost cue or function | Legacy | New | Primitive | Acceptance | Evidence |
|---|---|---|---|---|---|---|
| S1 | Lists show every row; nothing folds behind a count | whole-list renders: `index.html` 2769-2792 (loadouts), 2937-2975 (policies); `run-workspace.js` 367-376 (queue) | `ui/ShownList.tsx` 7 (`SHOWN_LIMIT = 10`), applied to pages by `7f22b5be`: `features/equipment/EquipmentPage.tsx` 189, `features/abilities/AbilitiesPage.tsx` 273, `features/collection/CollectionPage.tsx` 485, `features/runtime/DiagnosticsSection.tsx` 209, `features/runtime/IdentitySection.tsx` 150, `features/recognition/RecognitionPage.tsx` 878-983, `features/runs/ShoppingLibrary.tsx` 340 | `RecordRow` lists with no limit | With a 15-row fixture on each of those lists, 15 `li` are visible with no click and `main .tp-shown-list details` matches 0 elements | capture |
| S2 | Every boolean is an iOS-style switch | `index.html` 120-136 (`input[type=checkbox]` restyled: 2.55rem by 1.5rem pill, on = `#30d158`) | native checkboxes: `features/settings/SettingsModuleForm.tsx` 234, `features/collection/CollectionPage.tsx` 720, `features/shopping/QueueEditor.tsx` 200, 300 and 313 | `ToggleChip` (switch variant) | every `input[type=checkbox]` in `main` computes `appearance: none`, width 38.25 px and height 22.5 px (+-1; 2.55rem by 1.5rem at the 15 px root), and a checked one computes background `rgb(48, 209, 88)`; an unchecked one does not | capture |
| S3 | Status carried by a tinted dot or tone on list rows and status lines | `index.html` 78-83 (`.ok` `#30d158`, `.bad` `#ff453a`, `.warn` `#ffd60a`, `.dot` with glow); `dashboard.css` 95-98 (`data-tone` ok, busy, warn) | `ui/Chip.tsx` draws eight state shapes; `ui/Pill.tsx` and `ui/ui.css` 56 are deliberately "square, neutral, no dot"; list rows print the state as plain text | `StatusDot` | each row that states reachability, readiness or state has one `[data-status-dot]` whose `data-tone` is one of ok, bad, warn, busy, unknown and whose computed colour equals the matching `--tp-color-*` token | both |
| S4 | A tinted kind badge beside a row title | `index.html` 147-151 (`.chip`, `.chip.kind`, `.chip.ok`); used at 2778, 2810, 4754 | none: kinds print as text | `KindTag` | a row that has a kind carries one `[data-kind-tag]` with non-empty text; its background and border are derived from a `--tp-color-*` token, not a literal | capture |
| S5 | Controls sit on one line with their label | `index.html` 188-190 (`.blockrow`, input height 2.15rem), 228-237 (`.rulecard .rowline`) | label above control inside tiles with `Facts` cells (`ui/Facts.tsx`, `ui/Tile.tsx`) | `CompactField` | a `CompactField` is one flex row: label and control tops differ by at most 4 px at 1360 and 1054, and its control height is at most 36 px | capture |
| S6 | One save bar per settings module (Saved, Save changes, Discard) | `settings.css` 109-130; `settings.js` 460-472 | a Save button and "No change to save" under every field group: `features/runs/RunEntry.tsx` 187 ("Save field", `copy/runEntry.ts` 11), `features/settings/ScopedSettingsModule.tsx` | `SaveBar` (proposed) | a module of three fields renders exactly one Save control and one Discard control. **Decision for the person before this row is worked:** per-field Save is a deliberate write contract (fenced patches, one field at a time), so only the bar presentation may return, never batching | capture |

---

## Dashboard

| ID | Lost cue or function | Legacy | New | Primitive | Acceptance | Evidence |
|---|---|---|---|---|---|---|
| D1 | Shopping priority as numbered pill chips, three shown, "All N priorities" opening a two-column list | `run-workspace.js` 516 (`shoppingSummaryHTML`); `dashboard.css` 183-197 (`.rw-summary-queue > li` radius 999px with a counter prefix; `-full` has `columns: 2 16rem`) | `features/dashboard/thisBattle/ThisBattle.tsx` 575 (`Queue`): a "Queue for this battle" disclosure with the names joined by a dot | `ChipGrid` (read-only) with section tint | with a 12-upgrade queue, three `li` chips are visible with no click, each carrying its position as a text prefix and a border radius of 999px; one disclosure reads "All 12 priorities" and its opened list has `column-count: 2` at 1360 and 1054 | capture |
| D2 | Status lines lead with a tinted dot (ok, busy, warn) | `dashboard.css` 95-98 (`.dashboard-dot`, `data-tone`) | `features/dashboard/control/` chips carry tone and shape, so the loss is limited to plain status sentences (needs-you text, gems line, schedule line) | `StatusDot` | each status sentence in the Control, Needs you and Plan tiles has a leading `[data-status-dot]`; none is tone-less | both |
| D3 | The live screen sits beside the controls and stays in view | `dashboard.css` 32 (`grid-template-columns: minmax(0, 1fr) clamp(14rem, var(--dashboard-feed-width), 40%)`), 267-268 (one column at 900 px or less), 247-257 (one-line feed header with the stream switch) | `features/dashboard/Preview.tsx` is the last region; at 1360 it starts below roughly 1100 px and is one full-width tile | none (page layout, no primitive) | at 1360 and 1054 the preview tile's left edge is greater than the controls column's right edge and their tops differ by at most 40 px; at 390 the preview is below the controls | capture |

---

## Runs

| ID | Lost cue or function | Legacy | New | Primitive | Acceptance | Evidence |
|---|---|---|---|---|---|---|
| R1 | The shopping selector is three tinted sections of toggle chips: attack `#b95660`, defense `#4e92c7`, utility `#c69a42` | `run-workspace.js` 296-319 (`shoppingHTML`); `run-workspace.css` 36-43 (`.know-grid.rw-upgrades`, `.rw-attack`, `.rw-defense`, `.rw-utility`, `.rw-upgrade.on` mixes 20% of the section colour); chips are 72 px tall | `features/shopping/QueueEditor.tsx` 280-330: checkbox rows with a second "Never buy" checkbox inside `.tp-shop__page-viewport` | `ChipGrid` of `ToggleChip` | in each section every chip is one toggle (role button with `aria-pressed`, or switch) 72 px tall; selected chips compute a border colour of `rgb(185, 86, 96)`, `rgb(78, 146, 199)` and `rgb(198, 154, 66)` for attack, defense and utility; the section holds no checkbox | both |
| R2 | A selected chip carries its tap limit (and weight) inline; an unselected chip shows none | `run-workspace.js` 296-319 and 332 (`.rw-chip-controls`); `run-workspace.css` 49-58 | `features/shopping/QueueEditor.tsx` 183-215: every queue entry always shows four labelled fields and Move buttons | `ChipField` | a selected chip contains exactly one visible number input for the tap limit (plus one for weight when the pattern is weighted); an unselected chip contains no visible input | both |
| R3 | The queue is numbered cards with a drag handle, up and down icon buttons, a section-coloured edge and a dashed "Drop here to add to the end" slot | `run-workspace.js` 367-376 (`queueHTML`, `.rw-queue-end`); `run-workspace.css` 70-77 | `features/shopping/QueueEditor.tsx` 27-28 and 183-215: a fieldset per entry with text "Move up" and "Move down"; no drag, no end slot | `PriorityQueue` | `[draggable=true]` items equal the selected count; each item is 72 px tall with an index prefix and an up and a down button; one end slot exists with computed border style `dashed`; dropping a chip on it appends that upgrade last; the buttons still reorder from the keyboard | both |
| R4 | The queue sits beside the chip sections, switching on container width | `run-workspace.css` 100-110 (`@container rw-shopping` at 640, 900 and 1200 px gives 1, 2 and 3 selector columns) | `features/runs/RunsPage.tsx` stacks regions; the shop pages are always three tile columns | `ChipGrid` container query | measured on legacy: at 1360 each section has 2 chip columns and the queue shares the sections' top (within 40 px); at 1054 each has 1 column and the queue still shares the top; at 390 each has 1 column and the queue is above the sections | capture |
| R5 | A card per saved run: label, identifier chip, kind tag, equipment and tier line, readiness (ready, needs preparation, N screens to learn) and a Prepare button | `index.html` 4743-4765 (`renderFlows`, the card at 4752); `index.html` 170-179 (`.flowcard`); in the legacy default view these sit in the closed "Run templates and entry settings" disclosure | `features/runs/RunsPage.tsx` 168 (one `<select>`) and 193-203 (readiness text and Prepare for the selected run only) | `RecordRow` + `KindTag` + `StatusDot` | one card per saved run in the fixture (3 on legacy, 83 px at 1360); each has a `KindTag`, a readiness label and, when not ready, a visible Prepare button | capture |
| R6 | Routines are tiles with a switch, interval and a duration hint ("12m 00s") | `run-workspace.js` 292-295 (`routinesHTML`); `run-workspace.css` 5-6 (`.rw-routines` auto-fit grid) | `features/runs/RunsPage.tsx` 164 (the "Saved routines" tile) and `features/runs/RunEditor.tsx`: a table with checkboxes | `ToggleChip` + `CompactField` | each routine is one tile with one switch and its fields inline; at 1360 at least 2 tiles share a row; the duration hint sits under the interval input | capture |

---

## Run history

| ID | Lost cue or function | Legacy | New | Primitive | Acceptance | Evidence |
|---|---|---|---|---|---|---|
| H1 | One line per battle: label, status, "Tier N - wave N", start time | `run-workspace.js` 1214 (`.rw-history-row`); `run-workspace.css` 26 (grid `minmax(8rem,1fr) auto 1fr auto`) and 111 (`1fr auto` at 700 px or less) | `features/history/HistoryPage.tsx` 53-73: name, a record id and the start stacked, then a `Facts` row | `RecordRow` | at 1360 and 1054 each record is at most 40 px tall (legacy 36 px; new 87-99 px); at 390 at most 70 px (legacy 62 px; new 236-292 px); the record id is not in the row | capture |
| H2 | The page of records is the page; there is no inner scroll box | `run-workspace.js` 1214 inside `.rw-history-list`; paging 20 per page | `features/history/history.css` 22-46 (`max-block-size: 65dvh`, scroll shadows) and `features/history/HistoryPage.tsx` 265 (the hint "scroll the list") | `RecordRow` list | for a page of 20 records the list container has `scrollHeight` equal to `clientHeight` and no scroll hint exists (new: 583 px box over a 1976 px list at 1360) | capture |
| H3 | Setup evidence state is coloured: verified green, degraded amber, unknown muted | `run-workspace.js` 333-345 (`setupEvidenceHTML`); `run-workspace.css` 85-88 (`#a4d5b2`, `#f0ca82`, muted) | `features/history/HistoryDetail.tsx` 92-119: the state is a plain `Fact` | `MarkChip` | the setup state element carries `data-state` of verified, degraded or unknown and the three computed colours differ from each other | source |

---

## Schedule

| ID | Lost cue or function | Legacy | New | Primitive | Acceptance | Evidence |
|---|---|---|---|---|---|---|
| SC1 | A block is one line: run select, from, until, count, up, down, edit, remove | `index.html` 188-190 (`.blockrow`: `1.4fr 5.2rem 5.2rem 4.2rem auto`), 4681-4697 (`blockRow`) | `features/schedule/SchedulePage.tsx` 490-626: a fieldset per block with five labelled fields, text buttons and a quota `Facts` row | `RecordRow` + `CompactField` | each block row is 32 px tall at 1360 and 1054 on legacy (new: 236 and 280 px) and its select, three inputs and four buttons share one top (within 4 px); at 390 the row wraps to at most two lines with no horizontal overflow (the legacy row stayed 32 px but crushed its select to a sliver and clipped its remove button, a defect not to copy; new: 590 px) | capture |
| SC2 | The weekday map is a four-column grid of selects (default plus seven days) | `index.html` 239-240 (`.weekmap`), 4650-4670 | `features/schedule/SchedulePage.tsx` 662-690: a facts summary and an "Edit weekday mapping" disclosure | `CompactField` | the opened map has 8 selects in 4 columns at 1360 and 1054 | capture |
| SC3 | The plan is the first thing on the page | `index.html` 4640-4679 (`renderDay`): the day tabs and the first block are the first content | `features/schedule/SchedulePage.tsx` 211-311: a target tile and an observed-choice tile come first | `RecordRow` | with a plan present, the first block row's top is below 450 px at 1360 (legacy at 1360: about 260 px; new: 882, 911 and 1594 px at the three widths) | capture |
| SC4 | Day tabs read as one tab strip | `index.html` 238 (`.daytabs`), 4650-4662 | `features/schedule/SchedulePage.tsx` 469-480 already has pressed buttons | `ToggleChip` | already present: keep one `[aria-pressed=true]` day button and all days in one row at 1360 (guard row, no change expected) | both |

---

## Equipment

| ID | Lost cue or function | Legacy | New | Primitive | Acceptance | Evidence |
|---|---|---|---|---|---|---|
| E1 | One line per loadout: name, kind badge, summary, "used by" and an edit button | `index.html` 2769-2792 (`renderLoadouts`; `.rowline` plus `.chip.kind`) | `features/equipment/EquipmentPage.tsx` 189-235: a card with a name button, "Selected" text, a summary and a consumers `Facts` row, all stacked | `RecordRow` + `KindTag` | one row per loadout, at most 40 px tall at 1360 (legacy 30 px; new cards 117-163 px), each with a `KindTag` and an inline "used by" list | capture |
| E2 | Edit opens a modal with Cancel and Save in its header, a Before and After summary and the equip-mode fieldset | `index.html` 2793-2855 (`openLoadout`, `loRender`, dialog `#editor3`) | the editor is the right-hand "Selected loadout" pane of the same page (`features/equipment/EquipmentPage.tsx`) | `EditDialog` (proposed) | activating a row's edit opens `dialog[open]` titled with the loadout name and a `KindTag`; it holds Cancel, Save, a "Before ... After save" line and the mode radios; Escape closes it without a write | capture |
| E3 | The list is the first content of the page | `index.html` 2769 renders straight under the page text | `features/equipment/EquipmentPage.tsx` puts the standing tournament deck changes and the saved target above the list | `RecordRow` | the first loadout row's top is below 300 px at 1360 (legacy at 1360: about 220 px; new: 675 px) | capture |

---

## Collection

| ID | Lost cue or function | Legacy | New | Primitive | Acceptance | Evidence |
|---|---|---|---|---|---|---|
| C1 | Reward and chore toggles are switches with a caption naming the key and its default | `settings.js` 180-195 (boolean input), the caption under each field; `index.html` 120-136 | `features/collection/CollectionPage.tsx` 720 and `features/settings/SettingsModuleForm.tsx` 234: checkboxes with range text | `ToggleChip` (switch) | every boolean field in the rewards, gathering and chores modules is a switch (S2) and its caption contains the word "Default" | capture |
| C2 | One save bar per module | `settings.css` 109-130 | a Save button per fieldset (`features/collection/CollectionPage.tsx`, `features/settings/ScopedSettingsModule.tsx`) | `SaveBar` (proposed) | see S6, including its decision note | capture |
| C3 | The policy library is rows with edit, copy and remove inline, and "used by" or "not used by any run type" | `index.html` 2937-2975 (`renderBehaviors`, `#collection-policies`) | `features/collection/CollectionPage.tsx` 485 (`ShownList` of links) plus separate Delete, Copy and "Create a policy from a template" forms below the selected policy | `RecordRow` | one row per policy with an edit, a copy and a remove control in the same row; remove is absent while the policy is in use; the row carries "used by ..." or "not used by any run type" | capture |
| C4 | Each module names its scope in an outlined tag under its heading (for example "Shared profile") | `settings.js` 298 (`.settings-scope`); `settings.css` 102 | `features/collection/CollectionPage.tsx`: a text line "Active profile" in the first tile only | `KindTag` | every module heading is followed by one `[data-kind-tag]` naming its scope | capture |

---

## Abilities

| ID | Lost cue or function | Legacy | New | Primitive | Acceptance | Evidence |
|---|---|---|---|---|---|---|
| A1 | Both plan families are listed at once as rows: label, id chip, "used by ...", edit, copy and remove, plus a "new_name" create row | `index.html` 2937-2975 (`renderBehaviors`, `#ability-policies`) | `features/abilities/AbilitiesPage.tsx` 250-305: one family `<select>` and a button per plan; "Used by saved runs" appears only in the selected plan's header | `RecordRow` + `KindTag` | two groups, ultimate-weapon plans and rescue plans, each with one row per plan (a row is 47-54 px at 1360 on legacy); each row has an id `KindTag`, a used-by text, edit and copy, and remove only when unused; each group ends in a create row | capture |
| A2 | A rule is a compact card: a WHEN line and a THEN line | `index.html` 228-237 (`.rulecard`, `.rowline > b` 3.4rem right-aligned), 5383-5430 | `features/abilities/RuleEditor.tsx` 73-117: stacked label-above fields | `CompactField` + `RecordRow` | each rule card has two `.rowline`s with the label at 3.4rem and controls inline, each control at most 35 px tall | source |
| A3 | Edit opens a modal: display name, baseline weapons as switches, chain-mode select and number pairs, Save and Cancel in the header | `index.html` 332 (`<dialog id="editor2">`), 673-677 (`p2Render`), 5355-5514 | the plan editor is the right and left tiles of the page (`features/abilities/AbilitiesPage.tsx`); baseline weapons are a select per weapon (the fixture shows "On" and "Leave unspecified") | `EditDialog` (proposed) + `ToggleChip` | activating edit opens `dialog[open]` with Cancel and Save in its header; the baseline fieldset holds one switch per weapon; unowned weapons show "(not owned - skipped here)". **Decision for the person:** the new select is tri-state, so it needs a third state on the switch | capture |
| A4 | The global Demon Mode override is one switch on the page, with its key and default as a caption | `settings.js` 180-195 (boolean field), 298 (module heading and scope); hosted by `#panel-abilities` | a button "Global Demon Mode timing" in the target tile (`features/abilities/AbilitiesPage.tsx`) | `ToggleChip` | the override is a switch on the page, labelled with its key and default | capture |

---

## Profiles

| ID | Lost cue or function | Legacy | New | Primitive | Acceptance | Evidence |
|---|---|---|---|---|---|---|
| P1 | The chosen account carries a green "Selected" chip | `index.html` 1360 (`<span class="chip ok">Selected</span>`) | `features/profiles/ProfilesPage.tsx` 462-471 (label and id only) and 744-748 (a plain "Active" mark in the files table) | `KindTag` (ok tone) | when an account is active, `[data-active-account]` contains a `KindTag` with the text "Selected" and tone ok | capture |
| P2 | A requirement checklist ("A run is ready", "4 of 4 checks satisfied") with a mark per requirement | `workspace-status.js` 28 (`requirementHTML`); shown at the top of the legacy page | `features/profiles/ProfilesPage.tsx` Setup region: two counts, "Runs ready to start" and "Not ready" | `StatusDot` + `MarkChip` | four requirement items, each with a mark, a title and a status line, plus a "N of 4 checks satisfied" counter | capture |

---

## Emulators

These two rows are `source` evidence: the legacy fixture held no configured instances, so the
dots and the "In use" badge never rendered in a capture.

| ID | Lost cue or function | Legacy | New | Primitive | Acceptance | Evidence |
|---|---|---|---|---|---|---|
| EM1 | The emulator the config already points at shows an "In use" badge instead of a button | `index.html` 1432-1443 (`inUse`, `useOrStatus`, `.chip.ok` "In use ✓") | `features/emulators/EmulatorsPage.tsx` 525-560: every detected row keeps its action button | `KindTag` (ok tone) | when a detected row's address equals a configured serial, that row has a `KindTag` reading "In use" and no "Use this one" button | source |
| EM2 | Instance rows carry a coloured dot and a coloured "running" or "reachable" word; "not reachable" is red | `index.html` 1427-1431 (`.dot ok bad unknown`, `.ok`, `.bad`), 1449-1451 (running green, off muted) | `features/emulators/EmulatorsPage.tsx` 540-550 prints state as plain text | `StatusDot` | each configured-instance row has a `[data-status-dot]` with tone ok when reachable, bad when not reachable and unknown otherwise; the detected "running" cell has tone ok | source |

---

## Recognition

| ID | Lost cue or function | Legacy | New | Primitive | Acceptance | Evidence |
|---|---|---|---|---|---|---|
| RC1 | "What we know about this profile": one row per feature (cards and presets, modules, global presets, guardians, bots, workshop presets) with a phase word, a found summary, and a grid of saved names, active ones tinted with a check and mastered ones with a star, under a "check active, star mastered" legend | `index.html` 153-162 (`.know-grid`, marks), 1613-1652 (`calibrationKnowledge`, `knowledgeGrid` at 1647) | absent: `features/recognition/RecognitionPage.tsx` 860-1000 has only the evidence report; `core/recognition.ts` 582-585 maps a card to a name and slot; the generated contract's `card_manifest` schema is an empty strict object (`contract/generated/dashboard_contract_pages_v1_recognition.29aa411f.ts` 23) | `ChipGrid` + `MarkChip` + `MarkLegend` | six feature rows; with N saved names of which a are active and m mastered, N grid `li` exist, a have the tint, `[aria-label=active]` matches a and `[aria-label=mastered]` matches m, and the legend shows only when a mark exists. **Needs a contract change first:** the live backend reply carries per-card `active` and `mastery` and the app schema drops them | both |
| RC2 | Art and screenshot pairs: the installed art next to the cut, on a green ground when identified and red when failing | `index.html` 182-187 (`.artpair`, `.ok` and `.bad`), 1899 (`artPair`) | none: evidence entries print an image path, status and reason (`features/recognition/RecognitionPage.tsx`) | `RecordRow` + `StatusDot` | each evidence entry shows two `img` elements in an `.artpair` with background `rgba(48, 209, 88, 0.28)` when verified and `rgba(255, 69, 58, 0.28)` when failing. Images come only from the local artwork endpoint (never shipped); the fake backend answers with its text badge, so the test needs no game image. Legacy art 404 in this review's capture, so the cue is `source` only | source |
| RC3 | A needed image is a red-flagged card | `index.html` 177-178 (`.flowcard.outstanding`: border `rgba(255,69,58,.55)`), 1886-1940 (`outstandingCard`, the card at 1934), 4276 | `features/recognition/advanced/Coverage.tsx`: counted disclosures of text lists | `RecordRow` + `StatusDot` | each outstanding image row computes border colour `rgba(255, 69, 58, 0.55)` and carries `data-tone=bad` | source |
| RC4 | A scan stepper: a progress bar, "N of M steps processed" and a column of dotted stops (done green, running blue, error red, skipped amber) | `index.html` 242-262 (`.scan-progress`, `.scan-stops`, `.scan-step-*`), 2340 (`ol.scan-stops`) | absent: `features/recognition/RecognitionPage.tsx` shows "What the scan did" as three recorded lines | `StatusDot` | with a 4-step operation, `ol[aria-label="Scan steps"] li` matches 4, each stop's dot computes `#30d158`, `#64b5ff`, `#ff6961` or `#ffcc66` for its state, and a `progress` element is present | capture |
| RC5 | Saved names are not folded | `index.html` 1647 renders every name | `features/recognition/RecognitionPage.tsx` 878-983 and `features/recognition/advanced/*` use `ShownList` | `ChipGrid` | see S1: the grid of 33 names on legacy shows all 33 with no disclosure | capture |

---

## Runtime

| ID | Lost cue or function | Legacy | New | Primitive | Acceptance | Evidence |
|---|---|---|---|---|---|---|
| RT1 | A failed event has an amber left edge | `diagnostics-view.css` 11 (`.diag-event.diag-failure { border-left: 3px solid ... }`); `diagnostics-view.js` 72 | `features/runtime/DiagnosticsSection.tsx` 230-236 prints "Failure flag: true" as text | `RecordRow` + `StatusDot` | in the five-event fixture exactly 3 rows compute a 3 px left border in the warn colour and 2 compute 1 px (measured on legacy: 1, 3, 1, 3, 3 px) | capture |
| RT2 | Every event is one collapsed line, all visible | `diagnostics-view.js` 70-75; `diagnostics-view.css` 10-14 (53 px collapsed at 1360, 73 px at 1054, 92-138 px at 390) | `features/runtime/DiagnosticsSection.tsx` 209 (`ShownList`, 10 then a disclosure); each event also lists its fields expanded (173-225 px) | `RecordRow` | with 200 events, 200 `details[data-event-key]` are in the document and visible without a click; each collapsed row is at most 60 px tall at 1360 | capture |
| RT3 | Event times read as local dates | `diagnostics-view.js` 70 (`new Date(...)`; the legacy header says "Times use this browser's local time") | "Event time (epoch seconds)" with a raw number (`features/runtime/DiagnosticsSection.tsx` 224-228) | `RecordRow` | the time cell matches `\d{1,2}/\d{1,2}/\d{4}, \d{1,2}:\d{2}:\d{2} [AP]M` and its title carries the epoch seconds. **Decision for the person:** the schedule page already says "Times shown in UTC", so choose local or UTC once for both pages | capture |

---

## Primitives proposed beyond the vocabulary

| Name | Why none of the nine fits | Rows |
|---|---|---|
| `SaveBar` | a module-level Saved, Save changes, Discard bar is neither a chip nor a row | S6, C2 |
| `EditDialog` | a modal editor with Cancel and Save in its header and a Before and After line is not a record row | E2, A3 |

---

## Corrections to the inventory this review started from

- **History colouring is on the setup evidence, not the row.** The verified, degraded and
  unknown colours belong to the Setup evidence summary in the selected battle's detail (H3).
  The legacy row itself has no colour; its loss is the one-line shape (H1).
- **History is not folded by `ShownList`.** It is bounded by a 65 dvh scroll box (H2). The
  list that does fold in the runtime page is the events list (RT2).
- **Dashboard tones are partly kept.** The new Control tile draws tinted state chips; the loss
  is the dot on plain status sentences and the queue chips (D1, D2).
- **Emulators dots and the "In use" badge** are confirmed in the legacy code only; the legacy
  capture had no configured instance, so no capture shows them (EM1, EM2).
- **The legacy run cards (R5) sit in a closed disclosure** on the Runs page, not in its default
  view; the legacy default view shows one run's controls and its queue.
- **Abilities and Equipment keep "used by" in the selected record's header.** What is lost is
  the row form, the id and kind tags, and the edit modal (A1, E1, E2).
- **Recognition's "What we know" needs a contract change** before any UI work (RC1): the live
  reply carries `active` and `mastery` per card and the generated schema drops them.

---

## Capture limits

The captures that back these rows are local only (the folder is git-ignored) and are not part
of any PR. Where the legacy fixture could not reach a state, that is why a row says `source`:

- At 390 px the legacy day-plan row overflowed (SC1): the cue is the one-line idiom, not that
  defect.
- The artwork endpoint returned 404 for every image, so art pairs never rendered.
- The history detail endpoint was missing from the fixture, so no legacy battle detail was
  captured (H3 is `source`).
- The legacy fixture profile has no day plan; Schedule captures use a synthetic plan built
  over the fixture's own run names. Settings, runtime and recognition-evidence replies came
  from the committed fake backend (synthetic), because the recorded fixture lacked them.
- New-app captures use the committed fake backend (`frontend/app/tests/support/fake-backend`),
  so wording and counts differ from the legacy fixture; rows compare structure, not values.
