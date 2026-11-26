# Tower Pilot

Minimal emulator stream viewer and gem collector for **The Tower** (Android emulator on Windows).
Built as a clean, zero-bloat foundation to rebuild from the ground up.

## What it does

- **Live emulator stream** (`/api/stream.mjpg`): fast MuMu native DLL capture (isolated helper process) with automatic fallback to socket-only ADB raw screencap.
- **Ad Gems (left HUD)**: selectable **OCR** (Windows built-in WinRT OCR scanning the left HUD rail for `CLAIM`), **Timer**, **OCR + Timer**, or **Off**, with configurable human-like delay and cooldown.
- **Floating / Orbiting Gems**: selectable **Vision** (zero-template pink-square + HUD diamond glyph detector), **Timer** (safe top-left orbit arc burst), **Vision + Timer**, or **Off**.
- **Battle-only safety guard**: checks foreground window (`com.TechTreeGames.TheTower` in front via ADB socket `dumpsys window windows`) and undimmed battle HUD (side-menu toggle visible), and excludes the ability row and open side menu. Never starts, navigates, or ends a run.
- **Single-page dashboard** (`towerpilot/static/index.html`): vanilla HTML/CSS/JS served directly by Flask — no Node.js, npm, React, or Vite build step.

## Quick start

```powershell
# Optional custom port (default 8620)
$env:TOWER_PILOT_PORT = "8620"
.\Start-TowerPilot.ps1
```

Or run directly with your existing `.venv`:

```powershell
.\.venv\Scripts\python.exe app.py --port 8620
```

Open `http://127.0.0.1:8620/`. On first launch, `config.yaml` (git-ignored) is created from defaults (and automatically copies your ADB serial / MuMu path if a legacy `backend/config.yaml` exists locally).

## Layout

| Path | Role |
|---|---|
| `app.py` | Flask server, MJPEG stream, JSON API |
| `towerpilot/config.py` | YAML config defaults, validation, atomic save |
| `towerpilot/adb.py` | Socket-only ADB client (`127.0.0.1:5037`), MuMu display discovery, foreground window check |
| `towerpilot/capture.py` | Unified `FrameSource` (MuMu native stream + ADB raw screencap fallback) |
| `towerpilot/mumu_worker.py` | Isolated MuMu renderer DLL helper subprocess |
| `towerpilot/input.py` | Human-like ADB socket tapper (jitter, press duration, rate cap, `allow_taps`, `dry_run`) |
| `towerpilot/ocr.py` + `winocr.ps1` | Persistent hidden Windows WinRT OCR reader |
| `towerpilot/detectors.py` | Zero-template battle HUD guard, Ad Gem OCR detector, Floating Gem vision detector |
| `towerpilot/collector.py` | Background `GemCollector` loop (OCR/vision + timers + safety guard + event log) |
| `towerpilot/static/index.html` | Single-file dashboard UI with SVG detection overlays and click-to-pick coordinates |
| `tests/` | Offline unit and route tests (`python -m pytest`) |

## Verification

```powershell
.\.venv\Scripts\python.exe -m py_compile app.py towerpilot\*.py
.\.venv\Scripts\python.exe -m pytest
```
