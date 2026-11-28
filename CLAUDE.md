# Tower Pilot

Minimal vision-driven emulator stream viewer and gem collector for **The Tower** in an Android emulator:
ADB socket / MuMu native frames in, human-like ADB socket taps out. No memory reading, no modded APK, no game artwork shipped.

## Hard rules

1. **ADB via socket only.** Every screencap, tap, and `dumpsys` command goes through `towerpilot/adb.py` (socket client to `127.0.0.1:5037`). Never spawn `adb.exe` per command: spawning `adb.exe` repeatedly flashes console windows and exhausts Windows socket buffers on long runs.
2. **Never end a live farming or tournament run and never spend.** Normal automation and navigation (`screens.py`, `nav.py`) have zero outgoing edges from `battle` and may never target exit/surrender controls. Safe read-only in-battle Side Menu overlays (`battle_menu.py`: Battle History, Cards, Modules, Daily Missions, Guild Rewards, Event Missions) are permitted and strictly exclude Store, Exit Battle, reroll icons, Guild Leave, and the Event screen's Event Boost price button, Event Shop, and Bots tabs; free reward claims are limited to OCR-verified Daily Mission and Event Mission `CLAIM` buttons and unlocked milestone chests. The sole surrender exception is an explicit, user-triggered **Setup Test** (`POST /api/setup-test` in `towerpilot/setup_test.py`), hard-gated to non-tournament runs with a readable low wave (`1 <= wave <= max_wave`, hard cap `<= 100`) so it can never touch a real farming or tournament run. Never spend: no target may show a price or read `BUY`, `MERGE`, `SHATTER`, `CLAIM` (outside battle Ad Gem or verified Daily / Event Mission reward), or `Dissonant Run`. Tournament entry is permitted only under an active `tournament` profile on an OCR-verified tournament screen; any ticket or purchase dialog means hold and notify, with no tap.
3. **Tower on screen or hands off.** Every tap requires Gem Harvesting ON (`running: true`, enforced via `Tapper` `allow_taps` / `dry_run` safety gates), a fresh ADB screencap, and `com.TechTreeGames.TheTower` unobstructed in front (`adb.foreground_blocker`), split into two tap classes:
   - **Battle taps:** require an undimmed battle HUD (`detectors.menu_toggle_visible`) and coordinates outside the ability row (`detectors.in_ability_row`) and any open side menu (`detectors.in_open_side_menu`).
   - **Menu taps:** require an identified off-battle screen via `screens.identify()`, an allowlisted target whose text is re-read on that frame and passes `screens.validate_target()`, a 16px inset, and a verified post-condition.
4. **MuMu native capture is preview-only for safety.** `FrameSource` uses MuMu native DLL capture for fast streaming and idle scans, but every tap verifies the live screen via ADB socket screencap + `dumpsys window windows`.
5. **No machine/account state or game images in git.** `config.yaml`, logs, and any screenshots/PNGs stay git-ignored. `config.example.yaml` holds generic defaults only.

## Skills & verification

- Skills live in `.claude/skills/`; consult `.claude/skills/trigger-map.md`. `verify-never-infer` is mandatory before reporting any factual claim about code, data, or running processes.
- Verify edits with:
  - `python -m py_compile app.py towerpilot/*.py`
  - `python -m pytest`
