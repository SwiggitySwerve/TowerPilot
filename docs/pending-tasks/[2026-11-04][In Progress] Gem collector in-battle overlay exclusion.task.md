# Gem collector in-battle overlay exclusion
> **Status:** In Progress
> **Type:** Task
> **Created:** 2026-11-04
> **Updated:** 2026-11-05
> **Priority:** Medium
> **Tags:** gem-collector, recognition, safety

## Problem

The gem collector's battle collection is gated on the screen classifier saying `battle` with
a readable wave (`backend/gem_collector.py`, the `live` check). The Home Ad Gem path was removed by
[#45](https://github.com/SwiggitySwerve/TowerPilot/pull/45). The classifier in
`backend/vision/screen.py` checks its `OVERLAYS` list first, then, when no screen header
matches, returns `Screen("battle", ...)` for any frame where `wave_reader.read_wave(frame)`
reads a wave (the `if best_s < HDR_THRESH:` fallback near the end of `identify`). The
`OVERLAYS` list has no entry for the in-battle perk dialog or other in-game panels drawn over
a running battle, so a frame with such a panel open and the wave still readable classifies
as `battle`.

Ad claims also check foreground windows (`backend/device/overlays.py`), but that check
accepts the game's own package, so it does not detect an in-game panel. Orbit collection
adds motion, geometry and per-tap screen checks (`backend/flows/shard.py`).

No real mis-tap over an overlay was found: a log audit on 2026-11-04 of 102 collector process
logs under `backend/logs/main/` found no input event naming an overlay. Taps logged while
the collector state is `collecting` carry no `surface`, so the screen under them is not
recorded either way.

---

## What Needs to Happen

1. List the in-game panels that can open over a running battle with the wave still visible
   (perk choice dialog, and any others found on the player's own screens) and how each is
   recognized today, if at all.
2. Make the collector refuse input while one is up: either new `OVERLAYS` entries
   (account-local templates cut by the human-started calibrator, per CLAUDE.md rule 6 and
   the image-free release boundary) or a battle check that needs more than a readable wave.
3. Keep the dispatch-time input gate (`backend/device/act.py`, `input_scope`) and Abort
   propagation (`backend/interactions/ad_gems.py`) unchanged.
4. Add synthetic regressions: a frame with a readable wave plus each overlay classifies as
   not-`battle` (or the collector sends no input on it); a clean battle frame still collects.

---

## Key Files

| File | Why |
|---|---|
| `backend/vision/screen.py` | `OVERLAYS` list and the readable-wave `battle` fallback in `identify` |
| `backend/gem_collector.py` | The `live` battle check that gates collection |
| `backend/interactions/ad_gems.py` | Ad claim verification before dispatch; Abort handling |
| `backend/flows/shard.py` | Orbit collection's motion, geometry and per-tap screen checks |
| `backend/device/overlays.py` | Foreground-window check (accepts the game package) |
| `backend/device/act.py` | The one input boundary (`input_scope`) that must stay as is |

---

## Context

- Found while removing Home claims from the collector (2026-11-04). The person chose
  battle-only collection, and chose to track overlay hardening here instead of in that PR.
- Evidence (git-ignored, local to the machine that ran it):
  [audit.txt](../../backend/logs/reviews/gem-collector-battle-only/audit.txt), a log audit
  of 102 collector process logs with every contributing log-line reference. Its counts: ad
  claims with no surface label (logged while `collecting`) 710 started / 709 finished, 681
  confirmed; orbit windows 336 started / 333 finished, 198 confirmed, 135
  `attempt_timeout`. Home claims, now removed: 16 attempts, 1 confirmed.
- This touches screen recognition that every flow uses, so changes need the per-machine
  variant approach from CLAUDE.md ("never by lowering thresholds") and a live check.

---

## Architectural Reasoning

Two places can hold the fix:

| Approach | Gain | Risk |
|---|---|---|
| Shared classifier: add in-battle overlays to `OVERLAYS` in `backend/vision/screen.py` | Every flow that trusts `battle` (orchestrator, shard, collector) stops acting under the panel | A new entry changes what every flow sees; a missed or noisy template can turn a real battle into a non-battle and stall collection or the orchestrator |
| Collector only: a check in `backend/gem_collector.py` / `backend/interactions/ad_gems.py` before input | Limited blast radius; the collector refuses, other flows unchanged | Other flows keep tapping under the panel; two places learn the same overlay |

The choice depends on what step 1 finds: if the orchestrator or shard flows also tap during a
battle and would misread the same panels, the shared classifier is the right home (one place
that knows the screen, per the manifest rule in CLAUDE.md). If only the collector acts while
such a panel can be open, a collector-local refusal is the smaller change. Either way, the
templates come from the human-started calibrator (CLAUDE.md rule 6), never from the
detector itself.

---

## Success Criteria

1. With a known in-battle overlay open, the collector sends no input; synthetic tests prove it.
2. Ad and orbit success rates in battle keep their usual level after a deploy between
   battles (`python tools/gem_health.py`).


---

## Implementation and remaining acceptance

The collector requires a bright side-menu toggle as well as a recognized battle and
readable wave: the closed menu's three horizontal bars or the open menu's close-X. The
structural detectors are shared with calibration in `backend/vision/hud.py`; the
extraction preserved their thresholds. Geometry is read from the display-bound manifest,
and scaled crops use the detector's reference size. No template is loaded or written for
this check, so a missing overlay template does not change the policy on an install. A
missing, dimmed, covered or unrecognized toggle means no collection until a later frame
proves the HUD again.

The first version (#47) accepted only the closed bars. Every saved live battle frame on
this machine shows the side menu open, so it would have refused all collection. The
follow-up accepts the X too; on the saved full-size frames (2026-11-05) all 17 battle
frames now pass, and game stats, death, Home, store, modules and unknown screens are
still refused (`backend/logs/reviews/gem-collector-battle-only/menu_state_after.json`).

| Panel | Existing recognition | Collector evidence |
|---|---|---|
| Perk choice / selected perks | `battle_perks` is described in the interface manifest, absent from `screen.OVERLAYS` | Modal scrim dims the underlying HUD; saved selected-perks frames were inspected read-only |
| Expanded battle menu | Existing calibrated close-X and structural hamburger recognition, absent from `screen.OVERLAYS` | Not an obstruction: battles run with it open; its X counts as a clear HUD |
| Target Priority / Orb Distance Adjuster | Described in the interface manifest, absent from `screen.OVERLAYS` | Synthetic modal-scrim cases; real panel-specific verification remains outstanding |
| Existing recognized dialogs and menus | `screen.identify` names them before the wave fallback | Existing battle-only gate remains in force |

`GemWatch` receives the collector guard at every construction. The existing ad and
orbit guard calls apply it again to their fresh frames, including between orbit taps.
Only this guard's refusal (`CollectionObscured`, an `interactions/ad_gems.py`
`InputObscured`) is handled: the ad claimer records it (see below), and the collector
catches an orbit refusal to resume observation. Unrelated `Abort` exceptions still
propagate. `device/act.py` and the shared classifier remain unchanged.

Collector-only policy keeps flows that intentionally own menus on their current screen
contract. The vision layer owns the reusable structural recognition. This does not
claim that a readable wave alone is safe for other flows, or that a hypothetical panel
leaving the toggle (bars or X) fully bright is excluded.

Synthetic regressions first failed on the original collector behavior, then passed with
the guard. They cover modal scrims, an expanded menu (collects) and a dimmed one (refused), native display scaling, clean
battle collection, fresh ad frames, and panels appearing between orbit taps.

No deployment or live check was requested. The running collector keeps the old code
until it is relaunched. This task stays In Progress until an authorized deployment and
live panel checks verify exclusion and normal ad/orbit success rates. In particular,
verify the perk-choice panel and each other in-battle panel against the HUD invariant;
synthetic fixtures establish the policy, not every game's rendering variant.

An ad claim the guard refuses on its fresh frame is a skip before input
(`fresh_frame_obscured`), like `fresh_frame_not_battle`, not lost ownership; a panel that
appears after the claim tap makes the claim `not_confirmed` (`post_claim_obscured`).

Still open from the post-merge review of #47:

- The dashboard says "Collecting" while the collector waits for a clear HUD: the
  `waiting_for_clear_battle` state reaches only the events log
  (`gem_collector.py` publishes no runtime field for it; `control/harvest.py` derives
  "Collecting gems in the battle on screen." from routine gates). Publish it and show the
  wait with its age.
- An open orbit attempt is not expired while the HUD is obscured (`flows/shard.py` runs
  the guard before `_expire_attempt`), so it can close as `attempt_timeout` after the panel
  goes. Low impact.
- Live acceptance: open each side-menu entry during a battle and confirm the toggle
  refuses. No saved real frame shows a modal over an open menu, so "a panel dims the X"
  rests on synthetic tests and a scrim probe (a uniform black scrim of 14-18% opacity
  already refuses every accepted saved X frame).
- The open side menu covers roughly x 850-1080, y 0-740 (native) of the battlefield,
  including EXIT BATTLE. The default 135° orbit arc (`flows/shard.py`) stays clear of it,
  but a blueprint's `gem_orbit.angle_deg` can move taps there and `field_region` does not
  exclude it. Exclude the open-menu area from orbit tap points, or refuse such angles.
  (Existed before #47.)
