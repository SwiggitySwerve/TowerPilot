# Tower Pilot

Minimal vision-driven emulator stream viewer and gem collector for **The Tower** in an Android emulator:
ADB socket / MuMu native frames in, human-like ADB socket taps out. No memory reading, no modded APK, no game artwork shipped.

## Hard rules

1. **ADB via socket only.** Every screencap, tap, and `dumpsys` command goes through `towerpilot/adb.py` (socket client to `127.0.0.1:5037`). Never spawn `adb.exe` per command: spawning `adb.exe` repeatedly flashes console windows and exhausts Windows socket buffers on long runs.
2. **Never end, surrender, or cancel a live run.** This app only collects gems during active battles and, when `run_flow` is explicitly enabled, performs OCR-verified boundary transitions outside battles: `GAME STATS -> HOME` or `GAME STATS -> RETRY`, `Home -> BATTLE` (optionally gated by `expected_tier`), and crash-recovery `Home -> RESUME` — always rejecting tournaments. It never surrenders, exits battles, or enters tournaments.
3. **Tower on screen or hands off.** When `safety.battle_only` is enabled, every tap requires:
   - `safety.allow_taps` enabled (unless `dry_run`),
   - a fresh ADB screencap showing an undimmed battle HUD (`detectors.menu_toggle_visible`),
   - `com.TechTreeGames.TheTower` unobstructed in front (`adb.foreground_blocker`),
   - tap coordinates outside the ability row (`detectors.in_ability_row`) and any open side menu (`detectors.in_open_side_menu`).
4. **MuMu native capture is preview-only for safety.** `FrameSource` uses MuMu native DLL capture for fast streaming and idle scans, but every tap verifies the live screen via ADB socket screencap + `dumpsys window windows`.
5. **No machine/account state or game images in git.** `config.yaml`, logs, and any screenshots/PNGs stay git-ignored. `config.example.yaml` holds generic defaults only.

## Skills & verification

- Skills live in `.claude/skills/`; consult `.claude/skills/trigger-map.md`. `verify-never-infer` is mandatory before reporting any factual claim about code, data, or running processes.
- Verify edits with:
  - `python -m py_compile app.py towerpilot/*.py`
  - `python -m pytest`
