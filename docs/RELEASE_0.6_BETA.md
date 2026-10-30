# 0.6-beta
> **Status:** Draft. The version number and the change list are confirmed when the release is tagged.
> **Type:** Release notes
> **Created:** 2026-10-24
> **Updated:** 2026-10-30
> **Tags:** release, environment limits, portable

> [!warning] Draft until the Windows 11 checks are recorded
> Do not publish this note until the checks of the tagged build (see
> [the portable build guide](PORTABLE_BUILD.md)) are recorded and the limits below still match them.

Recommended download: **windows-x64 portable ZIP** for Windows 11 x64. Extract the
whole ZIP into a writable folder, then double-click **Start Tower Pilot.cmd**. Python
and dependencies are already bundled. No console window opens: Tower Pilot sits in
the notification area near the clock. Click that icon to open the dashboard,
right-click it to quit. The launcher opens the dashboard's Emulators page in your
default browser; use current Chrome or Edge.

The separate **source ZIP** requires Python 3.12 and installs dependencies on first
launch. Neither package includes an emulator or the game.

Use **1080 x 2560 portrait at 360 DPI**. Allow **20-30 minutes** for mapping, plus
installation/download time. End existing battles and start mapping on Home. Choose
your own farming tier and equipment after mapping.

---

## Changes since 0.5-beta

### Dashboard

- **A new dashboard.** The old pages are gone. The dashboard at `/ui/app/` is now the
  only interface, with a sidebar that lists every page in three groups: Operate
  (Dashboard, Runs, Schedule, Run history), Configure (Equipment, Abilities, Collection,
  Profiles) and System (Emulators, Recognition, Runtime). The top bar shows the page,
  account, emulator and connection. Old `/ui/index.html` bookmarks redirect to the
  matching page.
- **A control station around the live screen.** On a wide window the emulator screen
  sits beside the controls; on a narrow one everything stacks in one column. Status
  words are the same everywhere, and Unknown is always shown as Unknown, never as Off.
- **Help where you need it.** Optional explanations moved behind small help icons, so
  pages are shorter. Status, errors, why a button is disabled and what an action will
  do stay visible.
- **It only claims what it can prove.** A click sends one request and is never resent.
  If the answer is lost, the page shows Unknown until a later read proves the outcome.
  A change made for one emulator, account or profile is refused once you have switched
  to another.
- **A smoother live preview.** The preview prefers MuMu's native capture, with
  screenshots over adb as the fallback. You can choose the frame rate and picture
  quality (Native, Balanced or Low bandwidth) per browser. The optional scrcpy source is
  not part of the portable build (see the limits below).
- **A Runtime page you can read.** Diagnostic records can be filtered by exact value and
  the last result exported as JSON. The page also shows the build's identity.
- **Run history shows how a run was set up.** A battle's history lists its setup
  evidence, and says when setup continued with partial evidence or when observation
  began after the battle did.

### Farming and gem collection

- **Gem harvesting stays on or off.** Your choice survives restarting the dashboard and
  reloading the browser, and changes only when you change it or press Stop (Stop also
  pauses harvesting). No second collector starts on top of a running one.
- **Shopping you can order.** Pick the order of the upgrades to buy, the pattern
  (first affordable, round robin or weighted split), a cash reserve that shopping never
  spends below, and whether a sweep buys once or keeps buying while it can afford to.
- **Fleet Nukes fire at a fleet that is on screen.** The app now recognizes a fleet by
  its shape and colour and Nukes it on sight, so a wrong tier row or a skipped mark no
  longer burns the Nuke. `fleet.sighting.enabled: false` restores the plain schedule.
- **Gem collection holds up on a busy PC.** The collector runs at above-normal
  priority and the dashboard task at normal. Re-run `tools/register_dashboard_task.ps1`
  once to apply the new priority to an existing dashboard task.
- **Workers stay hidden.** Workers started from a Python virtual environment no longer
  open a console window. The dashboard's scheduled task runs through the tray launcher
  without opening a browser tab or an error dialog, and it exits quietly when a
  dashboard is already running.
- **Fewer ways to claim a result that did not happen.** A "Run now" ad claim is reported
  as unconfirmed when the only proof is that the offer disappeared. A battle record the
  collector could not finish writing is finished on the next try instead of failing,
  and a purchase in the guild store counts only when the item and the exact cost are
  both seen to change.

### Taking over a battle

- **Take over the battle on screen.** On the Dashboard, This battle offers **Take over
  this battle** when no battle is tracked and the emulator is free. After you confirm,
  Tower Pilot plays it with the run's settings, with Repeat and Rewards off, and never
  ends it.
- **It refuses rather than guesses.** A takeover is refused for a tournament, for a run
  that is not an orchestrator coin run, or when the wave on screen is more than 100 waves
  from what the collector last saw. The page shows the server's reason, including a
  refusal the worker reports once it has looked at the screen (for example, pressing
  Take over at Home).
- **No input into the wrong battle.** If the battle on screen is replaced while Tower
  Pilot is playing it, its gem-collection helpers stop tapping rather than act on the
  new battle.

### Setup

- **Setup keeps what it verified.** Results are tied to the scan that produced them, so
  a newer capture cannot replace them and a finished step is not thrown away when a
  later one is incomplete. The page says plainly whether a scan was only accepted,
  applied to the profile, or left the run not ready.
- **Device checks have deadlines.** Setup's screen captures and device reads give up
  at a fixed time, and evidence that arrives late is rejected.
- **A saved stat image that now reads as another stat is not left silently stale.**
  Setup keeps a replacement candidate beside the scan's evidence. It never overwrites
  your saved image; you decide.
- **Setup records what it measured:** timings and counters per scan, readable at
  `/api/calibrate/metrics`.

### Release and install

- **Pinned runtime packages.** The portable runtime installs from
  `requirements-portable.lock`: 26 packages, each with a SHA-256 that pip checks.
  `tpk_ar` has no wheel; it is built from its pinned source archive, and the build
  notice (`THIRD_PARTY.txt`) says so.
- **Pinned connection tools.** Setup downloads Android platform-tools 37.0.1 from
  Google and checks its SHA-256 before it unpacks anything. Nothing is downloaded
  until you accept the Android SDK terms and choose **Install connection tools**.
- **Release ZIPs are checked before they are published.** The check refuses local
  state (config, accounts, logs, runs, captures, templates, other profiles), personal
  paths, e-mail addresses outside dependency licence files, credentials in URLs, and
  dependency images that are not on the pinned list. It also requires the release note
  of the version being built, with an Environment limits section. The portable ZIP is
  then extracted into a fresh folder, where its own bundled Python imports the app and
  serves the dashboard's pages with no system Python on the path, before it is
  published. That check does not start the tray, a browser, Setup or an emulator.
- **A release says what it is.** Each ZIP carries a release identity (version, source
  fingerprint, build hash, git revision), shown read-only on the Runtime page, and a
  build from a tree with uncommitted changes is refused. A first start creates
  `config.yaml` from the shipped example and never changes one that exists.
- **Capability reports say what was checked.** `/api/runtime` carries an
  `environment` block. Each capability is available, missing, timeout or unknown, with the
  check it rests on. Windows text recognition stays unknown until the on-demand probe
  has run (see the limits below).

---

## Environment limits

These are the limits of this build. Nothing outside them is claimed.

### Operating system and browser

- **Windows 11 x64 is the supported environment.** The checks are described in
  [the portable build guide](PORTABLE_BUILD.md). **Windows 10 is untested.**
- **Browsers: current Chrome and Edge.** Other browsers are not supported. The launcher
  opens your default browser; if that is another one, open
  `http://127.0.0.1:8620/ui/app/#emulators` in Chrome or Edge. The port is 8620 unless
  `TOWER_PILOT_PORT` is set.
- **The portable build is an extracted folder, not an installer.** Keep all files
  together in a writable location. Local account data lives in that folder.

### Emulators and display

- **MuMu Player is the reference emulator.** Native-resolution coin farming on MuMu has
  live validation.
- **BlueStacks is tested.** It has needed scan retries and targeted repairs.
- **No other emulator is claimed.** LDPlayer is not supported. The Emulators page
  launches MuMu and BlueStacks only.
- **Reference display: 1080 x 2560 portrait at 360 DPI.** BlueStacks keeps a 2560 x 1080
  landscape panel that the game rotates to the same frame. Other resolutions, including
  1080 x 1920, are unvalidated, and resolution scaling is experimental. Use the
  reference display.
- **Ad overlays are known for MuMu only.** Only MuMu Store is a known ad owner. Another
  emulator's ad shows up as an `overlay_unknown` event naming the window; report it so it
  can be added.

### Downloads, components and Windows features

- **Platform tools are downloaded at Setup and need internet.** Setup downloads Android
  platform-tools 37.0.1 from Google after you accept the Android SDK terms. The download
  is checked against a pinned SHA-256 and refused if it differs.
- **The scrcpy preview is unavailable in the portable build.** The decoder it needs
  (PyAV, listed in `requirements-scrcpy.txt`) is not part of the portable runtime. The
  preview uses MuMu native capture or screenshots over adb instead.
- **Windows text recognition is required.** Setup and several run flows read game text
  with the Windows built-in OCR engine. Capability reports show it as unknown until the
  on-demand probe has run. The probe is a POST request to `/api/environment/probe` with
  the body `{"probe": "windows_ocr"}`. It recognizes a synthetic image within 10 seconds
  and reports available, missing or timeout. It does not touch an emulator or the game,
  and its result is kept in memory until the dashboard restarts.

### Carried from 0.5-beta

- The perk-ban flow has automated tests but has not yet run against a live Perks dialog.
  Watch for a `perk_bans_applied` or `perk_bans_failed` event the first time a run type
  with bans starts.
- A Dissonance run type can only re-enter the mode by itself once that tab's dialog
  images are captured; until then start the mode by hand and let the app adopt the run.
- HUD Ad Gems stop appearing once the game's daily allowance is spent, so a long day ends
  with quiet hours. That is the game, not the collector.
- The fleet table for Tiers 1-13 and 15-24 comes from published data, not from runs of
  this app; report a mismatch and override it meanwhile with `fleet.by_tier`.
- Optional or locked features can remain unverified. A Ready run does not mean every
  possible screen or emergency effect has been exercised.
- Stop automation before manually using the emulator. Stop now preserves a live battle;
  it does not surrender it.

The tagged prerelease is built by `.github/workflows/release.yml`. That workflow does not
start the extracted app, run Setup, an emulator or the game, so a full Setup scan on a
pristine Windows installation remains a beta validation task.
