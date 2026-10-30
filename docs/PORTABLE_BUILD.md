# Windows portable package
> **Status:** Active
> **Type:** Build and release guide
> **Created:** 2026-09-11
> **Updated:** 2026-10-30
> **Tags:** release, portable, environment limits

Users download the `windows-x64.zip`, extract it into a writable folder, and
double-click `Start Tower Pilot.cmd`. No Python installation, pip, PATH changes,
or administrator access is needed. The emulator and game are installed separately.
ADB can be downloaded through Setup after accepting Google's terms. The supported
environment is Windows 11 x64 with current Chrome or Edge; the limits are listed under
"Environment limits" in the release note for the version, for example
`docs/RELEASE_0.6_BETA.md` in the repository.

The private runtime is the official Python 3.12.10 x64 embeddable distribution,
checked against a pinned SHA-256. Dependencies are installed at build time from
`requirements-portable.lock`, not on the user's machine. The `_pth` file isolates
imports from system Python; the dashboard and worker subprocesses use this runtime.
Python and dependency license files remain inside the package.

## Rebuild

On Windows with 64-bit Python 3.12 and Node.js 22.13+ (22.x), 24.x or 26+, build the dashboard
app first; both release scripts refuse to run without it:

```powershell
cd frontend/app; npm ci; npm run build; cd ../..
py -3.12 tools/build_portable.py
```

Output is under `dist/`, with a ZIP SHA-256 sidecar and per-file checksums inside.
Builds use a fresh staging directory and the source allowlist; runtime captures,
personal profiles, account state, ADB and game assets are not collected.

### Clean tree and release identity

A release is the tagged merge, built by the CI run of the tag; the assets that run
publishes are the accepted artifacts. A local build is for rehearsal only.

Both builders refuse to run when the working tree has uncommitted changes, including
untracked files that git does not ignore, and when git cannot say (no `.git` of its own).
`--allow-dirty` skips that refusal for a rehearsal build. Such a build records `dirty` or
`unknown` in its identity, and the archive checker rejects it.

Each ZIP carries `release_identity.json` at its root: the version, the kind
(`source` or `portable-windows-x64`), the source fingerprint, the app build hash, the
lock hash, the Python version and hash (portable only), the build time, the git revision and
the working-tree state. It holds no path, user name or machine name. The dashboard reports it
read-only in `/api/runtime` under `release`, with `matches_source` and `matches_app_build`
(whether the files on disk are still the ones the build recorded). A copy without the file
reports kind `checkout`; one with an unreadable file reports `unknown`.
## Environments and limits

| ID | Environment | What it shows |
|---|---|---|
| E1 | Windows 11 development machine, manual check of an extracted ZIP | Tray icon, browser and Emulators page; system Python and per-user state exist on this machine |
| E2 | GitHub `windows-latest` runner, through `release.yml` | Full offline backend suite, dashboard checks/build, archive gates and portable qualification; preinstalled Python and Node are present, no emulator |
| E3 | Fresh temporary extraction of the built portable ZIP, automated on E2; available locally on E1 | Bundled interpreter imports, runtime identity, dashboard app responses, generic config seeding and unchanged shipped files; no listening server or device I/O |

Windows 10 is not one of these environments; it is untested. The full list of limits for
a version (browsers, emulators, display, the scrcpy preview, Windows text recognition, ad
overlays) is under "Environment limits" in `docs/RELEASE_<VERSION>.md`; the README and the
GitHub release text repeat only the short form. The archive checker requires the note of
the version being built, with that heading, in both ZIPs.

## Release workflow

`release.yml` runs the steps in this order: tag and `VERSION` check, dependency install
(the hash-checked lock, then the pinned `pytest`), the source release boundary tests,
the full offline backend suite, the
dashboard app checks and build, both builds, the archive check (`tools/check_release_zips.py`),
portable qualification and acceptance validation, and the prerelease publication.

`tools/qualify_portable.py` first checks the archive and sidecar, then extracts into a
fresh temporary folder whose name contains spaces. Its bundled `runtime/python.exe`
runs with a scrubbed environment and no system Python on PATH. Before application
imports, an audit guard refuses network connections, socket creation and child-process launches
(reading the local hostname is allowed). It
imports bundled dependencies and the dashboard, uses Flask's in-process client to
check `/api/runtime`, serves every built app file byte-for-byte, and checks the
`/api/config` response and first-run seeding of the shipped example bytes. Runtime identity must match the build,
source and app inventory. Every shipped file must remain unchanged. The child has a
120-second timeout; the temporary extraction is removed after success or failure.

The JSON report records the archive SHA-256, individual checks and any failure.
`tools/validate_acceptance.py` requires both the report and the original ZIP with its
sidecar. It refuses incomplete or failed reports and independently repeats qualification
in another fresh extraction before accepting matching results. JSON alone cannot prove
who wrote it; validation never trusts a report-only success claim. The workflow retains
the report as the `portable-acceptance` Actions artifact, including qualification failures.

To repeat locally:

```powershell
python tools/qualify_portable.py --archive dist/TowerPilot-<version>-windows-x64.zip --report dist/portable-acceptance.json
python tools/validate_acceptance.py dist/portable-acceptance.json --archive dist/TowerPilot-<version>-windows-x64.zip
```

These checks do not launch the tray, a browser, a listening dashboard, workers or an
emulator. For E1 visual acceptance, double-click `Start Tower Pilot.cmd` in a clean
extraction and confirm the tray icon, the dashboard in Chrome or Edge, and that the
Emulators page opens. Record that manual result separately.

A later run of the workflow for a version that already has a release replaces that release's
assets (`gh release upload --clobber`). Before accepting artifacts, compare their SHA-256 with the
`.sha256` files.

## 0.1-beta validation

- Bundled OpenCV, NumPy, Flask, UnityPy and other dependencies import successfully.
- With system Python removed from PATH, the bundled interpreter launches the
  module-based clicker worker and loads the shipped default configuration.
- Extracted package serves Setup in Chrome and correctly reports no installed
  connection tools or configured emulator. No scan or live-game actions were sent
  from this clean copy; the existing farm was left running.

This smoke test used the development Windows machine, not a pristine Windows VM.
Full clean-machine scanning remains a beta validation task. Keep the whole folder
when upgrading: local account data is stored under its backend directory.
