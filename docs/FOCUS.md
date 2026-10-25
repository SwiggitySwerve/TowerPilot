# Tower Pilot: current focus

Updated 2026-10-25. This file is the single place that says what is being worked
on now, in what order, and what "done" means. Older plans and review evidence live
under the git-ignored `backend/logs/reviews/`; this file supersedes their ordering.

## Goal for this stretch

You can tell from the Dashboard alone that gems are being collected, and when one
is missed you can see that it was missed and why. The live preview is on whenever
the emulator is already up, and the dashboard keeps itself running.

## Order of work

One change at a time, smallest first. Each is committed to
`feat/dashboard-polish-20261020` as soon as it meets the definition of done below.

| # | Change | Why | Status |
|---|---|---|---|
| 1 | Ad gem delay: keep the original delay when an offer moves, and clamp it to the time left in the window (person approved) | 2 of the 3 missed ad windows after r15d | done 5bc75004; live once the collector restarts between battles |
| 2 | Dashboard supervision: single-instance lock, restart when it dies, no landing kills the collector | 2 h 55 min of lost harvesting on 10-24 | 2a done f92ab0ae (live); 2b done d6da4246 (start report; live at next restart); 2c later: landings stop the collector at a safe point instead of killing it |
| 3 | Gem outcomes on the Dashboard: confirmations seen, misses, and a cause line, all from the backend | "Collecting gems" today only means a collector is running | in progress |
| 4 | Gem-health signal: warn when frames arrive but the recognizer matches nothing | silent recognizer failures | |
| 5 | Live preview starts by itself when the emulator is already available, and reattaches when it returns; never starts the emulator | person's decision | |
| 6 | Gem regression test that needs no screenshots | three broken orbit versions pass every test today | done 2b93e993 |
| 6b | Orbit taps 2-3 aim on a fresh frame captured after the tap-rate wait (council #3b) | taps were sent on a frame up to 0.7 s old | done (orbit fix commit); live at next collector restart |
| 7 | Hard rule 4 fix: the day plan must not tap over the person's screen (item 7 #10) | safety gap | |

Source for 2-6: `backend/logs/reviews/quality-council-20261024/synthesis.md`, items 1-6.

## Definition of done for one change

1. The change is small and has one purpose.
2. A test that fails before the change and passes after it, or a stated reason none is possible.
3. The focused tests pass, and the full backend suite passes (`python -m pytest backend/tests -q`)
   when the change touches shared code. Frontend changes run typecheck, lint and the affected tests.
4. Recorded fixtures that move are regenerated through their writers, and every moved value is explained.
5. One independent review of the final diff (Astra). Opus verifies only changes to the live
   collection path or safety rules.
6. Committed and pushed. The dashboard is restarted between battles when runtime files changed,
   and the result is checked on the live Dashboard.

No packages, zip files or landing scripts for ordinary changes.

## Working rules

- At most two changes in flight, and only if they touch different files.
- Never stop, restart or touch the emulator (MuMu) or adb. Only the dashboard and collector may be
  restarted, by root, between battles.
- Tests never reach live ports: `backend/tests/conftest.py` refuses connections to 5037, 8620 and 8630.
- The dashboard runs from the Scheduled Task "TowerPilot Dashboard" under a hidden console
  (`conhost.exe --headless ... python.exe backend/dashboard.py`).

## Paused (state saved, resume after this stretch)

| Item | Where its state is |
|---|---|
| 3 Tracked takeover (T3-0 and T3a landed; T3b, T3c, takeover UI remain) | `backend/logs/reviews/roadmap-item3-build/STATE.md` |
| 6 Reusable action module (needs one natural shopping sweep on a live run) | `backend/logs/reviews/roadmap-item6-declaration-audit/` |
| 7 Timer migration (r18d landed; r18e, r18h, F-1 port remain) | `backend/logs/reviews/roadmap-item7-*/STATE.md` |
| 9 Setup evidence and speed (P9-F approved; P9-A, P9-B remain) | `backend/logs/reviews/roadmap-item9-*/STATE.md` |
| 10 Packaging | `backend/logs/reviews/item10-*/STATE.md` |
| 1, 4, 5 | need the person: a fresh live run (1), visual acceptance (4, 5) |

## Open decisions for the person

From the council synthesis, section 5: whether golden test fixtures are exempt from hard rule 8,
whether to keep the strict schema layer (31% of the shipped JavaScript), whether recognition may use
native preview frames, how a leftover person's run differs from a scheduler handoff for surrender
rules, whether a learner may cut the ad claim template, and whether APK art may be a live matcher.
Decided: tap cap 5/s, ad delay clamp yes, preview auto-start only when the emulator is up, MuMu
started by the person.