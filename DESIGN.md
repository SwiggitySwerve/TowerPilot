# Tower Pilot dashboard design
> **Status:** Active
> **Type:** Design reference
> **Created:** 2026-10-12
> **Updated:** 2026-10-19
> **Scope:** Navigation, workspace layout and saved/live run controls

## Sources and visual system

The rendered dashboard combines [index.html](frontend/webui/index.html) with
[app-shell.css](frontend/webui/app-shell.css). The shell stylesheet overrides
the earlier inline glass skin: use flat dark surfaces, restrained borders,
blue actions and compact corners. Reuse its tokens and existing form controls.
The system font stack and 15px root size come from the page stylesheet.

The top bar holds the brand, connection status and narrow-screen Menu control.
The desktop shell has a left sidebar and a scrolling workspace that uses the
remaining width. Below 700px, Menu reveals the sidebar above the workspace.
Search filters destination links; the selected link uses `aria-current="page"`.
Keep native link navigation and browser history, a visible focus indicator,
and the Skip to content link.

---

## Destinations

Navigation labels, routes and descriptions are defined in
[index.html](frontend/webui/index.html). Operate, Configure and Workspace are
group labels in one flat list, with no second navigation tier.

| Group | Destination | Route |
| --- | --- | --- |
| Operate | Dashboard | `#overview` |
| Operate | Runs | `#runs` |
| Operate | Run history | `#history` |
| Operate | Schedule | `#schedule` |
| Configure | Equipment | `#equipment` |
| Configure | Collection | `#collection` |
| Configure | Abilities | `#abilities` |
| Workspace | Profiles | `#profiles` |
| Workspace | Emulators | `#emulators` |
| Workspace | Recognition | `#screens` |
| Workspace | Runtime | `#runtime` |

Legacy hashes resolve through the route aliases. Hidden page panels remain
separate from navigation; these links are not an ARIA tab widget. Functional
configuration forms mount on the visible page. See the
[configuration guide](docs/SETTINGS.md) for setting ownership and scope.

---

## Dashboard and run workspaces

The Dashboard leads with connection and automation blockers. Automation,
recent activity and setup guidance share the main column beside the emulator
screen; that grid collapses below 900px. Current battle controls occupy a
separate full-width article below it, so workshop selection can use the
workspace width.

Runs offers a saved-run selector, Entry and equipment, and autosaved controls
for future battles. Dashboard controls apply temporarily to the current
battle. Show Pending until the driver acknowledges live changes. Reset live
overrides returns to frozen battle defaults. Numeric inputs keep their focus
while status refreshes; show validation and request failures beside the controls.

The shared renderer and styles live in
[run-workspace.js](frontend/webui/run-workspace.js) and
[run-workspace.css](frontend/webui/run-workspace.css). Keep routine gates,
intervals, countdowns and manual actions compact, with visible labels and
explicit disabled states for unsupported controls.
Duration fields remain editable in seconds and show a minute/second hint
when their value exceeds 60 seconds.

---

## Workshop controls

The global priority queue sits on the left and upgrade selection on the
right when the workshop container is at least 640px wide. Narrow containers
stack them in that order. Attack, Defense and Utility group the selector;
selection contributes to one queue across all three pages.

Selector chips and queue chips share a 36px height and a computed track width.
The selector gains columns at wider container sizes while the queue retains
one column. Selected upgrade chips keep the attempt limit and Try once action
visible; Weighted split adds a per-turn amount. Preserve the compact chip
shape, section accents and selected markers. Explain provisional catalog order
and unavailable recognition without claiming account ownership.

Dragging a selector chip into the queue selects and positions it. Existing
queue entries support dragging and keyboard move buttons. The queue panel
also holds the cash reserve and purchase pattern. Keep the reserve requirement
and legacy-policy warning visible where they affect a purchase decision.
Purchase semantics and safety contracts are documented in the
[run lifecycle plan](docs/RUN_LIFECYCLE_PLAN.md).

---

## Learning, feedback and evidence

Recognition owns screen learning and repair; Profiles and Emulators own
their respective setup forms. Project live progress from recorded operation
state and retain explicit unavailable or last-known states on failed reads.
Do not infer completion or an ETA from processed-step counts. Follow the
[learning contract](docs/LEARNING_FLOWS.md) for acceptance, reconciliation
and application.

Use visible labels, native controls and inline status messages. Status
communication includes text rather than relying on color alone. Screen
captures, learned images and account data remain local under the
[project rules](CLAUDE.md#image-free-release-boundary).

This reference describes the source layout. Runtime evidence and remaining
live-verification limits belong in the
[verification record](docs/RUN_LIFECYCLE_PLAN.md#verification-result), rather
than being inferred from styling or passing unit tests.
