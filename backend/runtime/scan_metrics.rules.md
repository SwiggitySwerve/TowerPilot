# Scan metrics and identity: rules
> **Status:** Active
> **Type:** Rules of one owner (runtime/scan_metrics.py, runtime/scan_identity.py)
> **Created:** 2026-10-30
> **Updated:** 2026-10-30
> **Tags:** setup, measurement, calibration

Roadmap item 9 asks that a faster-setup claim rest on comparable successful scans. These two modules measure one scan and name the code that ran it. Judging two scans
against each other is a separate, later owner.

1. **One recorder per worker operation.** player/calibrate.py `main` starts it only when the process has an accepted operation (`TOWER_OPERATION_ID`). With no recorder
   every hook is a no-op, so runners, the dashboard and other callers are unchanged.
2. **One place per count.** OCR is counted in vision/textocr.py (invocations, crops, PowerShell launches - a cold batch and a warm reader start alike - timeouts, errors), captures in device/capture.py (ok, retries,
   failed), input in device/act.py (taps and swipes by reason, refusals) and phases in player/calibrate.py. Do not count the same thing elsewhere.
3. **Never changes a scan.** A hook that raises is swallowed and counted in `hook_errors`. A failed write is logged (`metrics_error`) and the scan keeps its
   outcome. A scan without a valid metrics file is simply not eligible for a comparison. Phase and lifecycle hooks use the module lock; hot counters use plain increments; the callables
   a phase context manager is given (`coverage`, `status`: they read files) run before the lock is taken, and one that raises is counted and leaves the phase to be closed
   as interrupted.
4. **Per operation, sealed.** The worker writes backend/.../calibrate_metrics.json once, when it ends; runtime/operations.py retains it under `operations/<id>/` and the status
   reads only that retained copy (GET /api/calibrate/metrics). The working file of an earlier scan is deleted when a scan starts, so it can never be retained for another.
5. **Coverage is the phase's own result.** It is copied at the phase's end from what the phase returned (and `cal.player` for the module inventory flag), never from the working
   card_manifest.json or module_manifest.json. A phase skipped because the saved state holds it done is `carried_over`, has no coverage and did no work.
6. **Durations are per run.** `phases[*].duration_s` and the totals come from this run's monotonic clock. Old `state.phases` timestamps are cleared before each operation; the ledger's `updated_at` includes the apply wait: neither is a duration.
7. **Identity is declared, not guessed.** `identity` holds the revision and fingerprint the worker loaded, the sha256 of each measured file and a `tree_state`:
   `clean` (revision and fingerprint equal a side declared in backend/logs/scan_sides.json), `dirty` (the revision is declared but the fingerprint matches no side) or
   `undeclared`. The fingerprint covers application `.py` files except tests and local state (runtime/build_info.py). Until the later package P9-B writes
   backend/logs/scan_sides.json (tools/scan_sides.py), no side is declared and every scan is `undeclared`. `identity` also holds `python` (`platform.python_version()`) and
   `windows` (`sys.getwindowsversion()`, no subprocess): a pair on different ones is not the same measurement.
8. **Start state.** The template inventory (path and sha256 of every file under the account's templates folder, resolved by `player.accounts.template_dir`, the owner of that path,
   never derived beside the state file) and the phases already done are recorded when the scan starts, so a later comparison can require equal starting points.
9. **No device, no input.** Nothing here captures, taps or runs OCR; it only counts what other code does.
10. **The run block.** `run` = `{kind, request, account, device_key, rendering, instance}` is read once, by `scan_metrics.run_of`, from the operation's ledger record when the worker
    starts (`request` is the operation's request: phases, routes, fresh, overwrite, flows). With `identity`, `start_state` and the per-phase coverage it lets the later comparison
    check spec 3.2 rule 1 without a second source. A part the record lacks is null.
11. **Schema version.** `schema_version` stays 1: this package is the first landing, so no file written under an earlier shape exists. Any later change to the shape of an existing
    key raises it, and the later comparison must refuse a version it does not know.
12. **Known limits of the counts.** With `raise_on_error=False`, vision/textocr.py ignores a non-zero PowerShell return code and returns what it parsed; the recorder mirrors that
    silent path, so such a failure is not counted in `ocr.errors` (a timeout or an exception is). The bootstrap phase's coverage `since` is the worker's instant just before
    `bootstrap.run` is called, not `Bootstrap.started_at` (set inside the bootstrap): both consumers use `player.calibration_report.entries_since` for the inclusive timestamp rule.

Hot counters use plain increments with no added locks or I/O. The controlling worker thread owns recorder lifetime and scan I/O; the warm OCR drain thread does not count. Phase/lifecycle hooks remain guarded. Failed writes, missing files, invalid JSON, and foreign operation IDs emit `metrics_error` and never change the scan outcome. Resumed phases keep their status and results but lose timestamps from the preceding operation.
