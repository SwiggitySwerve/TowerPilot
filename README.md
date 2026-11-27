# Tower Pilot

Minimal emulator stream viewer and gem collector for **The Tower** (Android emulator on Windows).
Built as a clean, zero-bloat foundation.

## What it does

- **Live emulator stream** (`/api/stream.mjpg`): fast MuMu native DLL capture (isolated helper process) with automatic fallback to socket-only ADB raw screencap.
- **Gem harvesting ON/OFF** with individual toggles for **Ad Gems** and **Floating Gems**.
- **One mode switch — OCR vs Timer**:
  - **OCR** (`"ocr"`): scans the left HUD rail for `CLAIM` via Windows built-in WinRT OCR for Ad Gems, and uses the zero-template vision detector for Floating Gems.
  - **Timer** (`"timer"`): taps each enabled gem type periodically using its configured `timer_interval_sec`.
- **Battle-only safety guard**: every gem tap verifies a fresh ADB screencap showing an undimmed battle HUD (`detectors.menu_toggle_visible`), unobstructed `com.TechTreeGames.TheTower` foreground window on the paired logical display (`adb.foreground_blocker`), and excludes the ability row and open side menu.
- **Optional run continuity (`run_flow`)**: when `auto_home` / `auto_battle` are enabled, OCR-verified taps dismiss the normal `GAME STATS` screen (`RETRY` + `HOME`, rejecting tournaments) and tap `BATTLE` on the main menu to keep farming runs going automatically. Never surrenders or cancels an active run.
- **Structured event log**: persists trigger events (`harvest_started`, `battle_live`, `ad_gem_spotted`/`collected`/`attempted`, `floating_gem_spotted`/`collected`/`attempted`, `end_stats_home_tapped`, `home_battle_tapped`, skips, errors) to git-ignored `logs/events.jsonl`.
- **Persistent Windows tray app**: runs windowlessly in the notification area (`towerpilot/tray.py`, supports `--background`), remembers whether harvesting was ON in `config.yaml` across restarts, and sends a tray notification if a live battle is absent for 10+ minutes.
- **Build-free dashboard** (`towerpilot/static/index.html`, `style.css`, `app.js`): vanilla HTML/CSS/JS served directly by Flask — no Node.js, npm, React, or Vite build step.

## Unattended operation

Use Windows Task Scheduler (e.g. `\TowerPilot Dashboard` running `conhost.exe --headless "<repo>\.venv\Scripts\python.exe" -u -m towerpilot.tray --background`) to keep the tray server up across logons. Harvesting ON/OFF, mode (`ocr`/`timer`), intervals, and `run_flow` toggles persist in `config.yaml`, so restarts automatically resume harvesting if it was ON.

## Quick start

Double-click `Start Tower Pilot.cmd` or run:

```powershell
.\Start-TowerPilot.ps1
```

Or run the Flask server directly in the foreground:

```powershell
.\.venv\Scripts\python.exe app.py --port 8620
```

Open `http://127.0.0.1:8620/`. On first launch, `config.yaml` (git-ignored) is created from defaults (and automatically seeds ADB serial, ADB path, MuMu directory, and screen size if a legacy `backend/config.yaml` exists locally).

## API

- `GET /` — serves `towerpilot/static/index.html`
- `GET /api/stream.mjpg` — live MJPEG stream from `FrameSource`
- `GET /api/status` — current harvesting state, mode, per-gem status/counts/timers, stream status, battle guard state, and recent activity
- `POST /api/harvest` — partial update of `running`, `mode`, `ad_gems` (`enabled`, `timer_interval_sec`), `floating_gems` (`enabled`, `timer_interval_sec`), and `run_flow` (`auto_home`, `auto_battle`); persists to `config.yaml` and returns updated status

## Layout

| Path | Role |
|---|---|
| `app.py` | Minimal Flask server, MJPEG stream, `/api/status`, `/api/harvest` |
| `towerpilot/tray.py` | Windowless Windows system-tray launcher hosting `app.create_app()` |
| `towerpilot/config.py` | Minimal YAML config defaults, validation, legacy seeding, atomic save |
| `towerpilot/adb.py` | Socket-only ADB client (`127.0.0.1:5037`), MuMu display discovery, foreground window check |
| `towerpilot/capture.py` | Unified `FrameSource` (MuMu native stream + ADB raw screencap fallback) |
| `towerpilot/mumu_worker.py` | Isolated MuMu renderer DLL helper subprocess |
| `towerpilot/input.py` | Human-like ADB socket tapper (jitter, press duration, rate cap) |
| `towerpilot/ocr.py` + `winocr.ps1` | Persistent hidden Windows WinRT OCR reader |
| `towerpilot/detectors.py` | Zero-template battle HUD guard, Ad Gem OCR detector, Floating Gem vision detector |
| `towerpilot/collector.py` | Background `GemCollector` loop (OCR/vision vs timer + safety guard) |
| `towerpilot/static/` | Build-free minimal dark dashboard (`index.html`, `style.css`, `app.js`) |
| `tests/` | Offline unit and route tests (`python -m pytest`) |

## Verification

```powershell
.\.venv\Scripts\python.exe -m py_compile app.py towerpilot\*.py
.\.venv\Scripts\python.exe -m pytest
```
