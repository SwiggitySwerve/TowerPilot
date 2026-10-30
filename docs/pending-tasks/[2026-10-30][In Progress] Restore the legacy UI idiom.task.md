# Restore the legacy UI idiom
> **Status:** In Progress
> **Type:** Task
> **Created:** 2026-10-30
> **Updated:** 2026-10-30
> **Priority:** High
> **Tags:** dashboard, ui, regression, parity, needs-person

## Problem

The React dashboard (`frontend/app`) replaced the legacy vanilla-JS dashboard in commit
`84123e7c` (`feat(app): retire the legacy Dashboard pages (R17)`), and the person reports
that every screen regressed. The legacy pages were compact and scannable: tinted toggle
chips, numbered priority cards, one-line rows with inline actions, kind badges, switches,
status dots and complete lists. The new pages are tiles of labelled fields with text
buttons, native checkboxes and lists folded at ten rows (`frontend/app/src/ui/ShownList.tsx`
7, applied to pages by `7f22b5be`). A side-by-side review of 72 legacy and 69 new captures
found 45 lost cues or functions; they are the rows of [UI parity](../UI_PARITY.md).

---

## What Needs to Happen

Port the legacy idiom into shared React primitives, then page by page. One PR each, in this
order:

1. **PR0 (this one):** [UI parity](../UI_PARITY.md) and this task. No app code.
2. **PR1:** the shared primitives (`ToggleChip`, `ChipField`, `ChipGrid`, `MarkChip` with
   `MarkLegend`, `PriorityQueue`, `RecordRow`, `KindTag`, `StatusDot`, `CompactField`, and the
   two proposed in the checklist, `SaveBar` and `EditDialog`) plus a gallery route that draws
   each one in every state, with unit and Playwright tests. Colour tokens for the three upgrade
   sections (attack `#b95660`, defense `#4e92c7`, utility `#c69a42`) and the ok, bad and warn
   tones join `ui/tokens.css`. Rows S1-S6 close here, except the S6 decision below.
3. **Runs:** R1-R6.
4. **Equipment and Abilities:** E1-E3, A1-A4.
5. **Schedule and History:** SC1-SC4, H1-H3.
6. **Collection:** C1-C4.
7. **Dashboard, Emulators, Runtime and Profiles:** D1-D3, EM1-EM2, RT1-RT3, P1-P2.
8. **Recognition:** RC1-RC5. First a contract change: add per-card `active` and `mastery` to
   the `card_manifest` schema (the live backend reply already carries both; the generated
   schema is an empty strict object and `core/recognition.ts` 582-585 keeps only the slot).
   The art pairs (RC2) read the local artwork endpoint only; no game image is ever tracked.

Each page PR must:

- Carry one Playwright assertion per row of its section, titled with the row id, using the
  acceptance condition as written. A row whose condition cannot be asserted is reworded in
  `docs/UI_PARITY.md` in that same PR, with the reason.
- Keep every safety contract the page has now (fenced writes, one-field saves, takeover
  controls). The idiom changes how a control looks and where it sits, never what a write does.
- Be signed off by the person on the rebuilt page through
  [Visual acceptance of the dashboard pages](%5B2026-10-30%5D%5BOpen%5D%20Visual%20acceptance%20of%20the%20dashboard%20pages.task.md);
  the PR waits on that sign-off.

Decisions the person owes before the named rows start: S6 and C2 (per-field Save is a
deliberate write contract, so only the save-bar presentation may return), A3 (the baseline
weapon select is tri-state, a switch is two-state) and RT3 (local time or UTC for event times,
chosen once for the runtime and schedule pages).

---

## Key Files

| File | Why |
|---|---|
| `docs/UI_PARITY.md` | The checklist every PR is checked against |
| `frontend/app/src/ui/` | Where the shared primitives, `tokens.css` and `ShownList.tsx` live |
| `frontend/app/src/features/` | One folder per page |
| `frontend/app/tests/e2e/` | Playwright specs; geometry helpers in `tests/e2e/helpers/` |
| `frontend/app/tests/support/fake-backend/` | The committed fake backend every capture and test uses |
| `frontend/app/README.md` | Build, dev server and test commands |
| `git show 84123e7c^:frontend/webui/index.html` | The legacy page (also `run-workspace.js`, `run-workspace.css`, `dashboard.css`, `settings.js`, `diagnostics-view.js`) |

---

## Context

The legacy tree is the parent of `84123e7c`; extract it with
`git archive 84123e7c^ frontend/webui | tar -x -C <empty folder outside the repo>` and serve
it on a loopback port to look at it. Captures of both sides at 1360, 1054 and 390 px were
taken for this review and live only in the git-ignored
`backend/logs/reviews/ui-legacy-parity/` of the main checkout. They come from real account
data (legacy side) and must never be committed, attached to a PR or quoted in tracked files
beyond generic structure; `backend/tests/unit/test_release_clean.py` fails on any tracked
raster.

Guard: the geometry contracts in the checklist run locally as text and geometry assertions
(`npm run e2e` in `frontend/app`, Node 22 on Windows). Pixel captures stay local; a PR may
describe a visual result in words but does not attach images.

Capture limits worth knowing before relying on a row marked `source` in the checklist: the
legacy fixture had no configured emulator instance, no history detail, no day plan and no
artwork, so those cues are confirmed in the legacy code only.

---

## Success Criteria

- [ ] Every row of `docs/UI_PARITY.md` has a passing Playwright assertion, or is reworded
  there with a recorded reason.
- [ ] Every page PR is signed off by the person on the rebuilt page.
- [ ] No list on those pages folds at ten rows (S1).
- [ ] No tracked image; `backend/tests/unit/test_release_clean.py` passes.

---

## Architectural Reasoning

Shared primitives first, because the same cue recurs across pages (the tinted chip in Runs,
Recognition and Equipment; the one-line row in History, Schedule, Equipment and Abilities).
Rebuilding each page alone would copy the same markup eleven times and drift again. The
alternative of restoring the legacy markup verbatim was rejected: the new app has
accessibility, fenced-write and takeover contracts the legacy page lacked, so the primitives
carry those contracts and only the look and density return. Pixel diffs were rejected as the
guard because captures hold real account data and cannot ship; text and geometry assertions
(column counts per width, element presence, no fold, badge text, a computed colour from a
token) run offline and catch the same regressions. Recognition goes last because its
"What we know" grid needs a contract change first.
