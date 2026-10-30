# Setup scan side rules
> **Status:** Active
> **Type:** Rules
> **Created:** 2026-10-30
> **Updated:** 2026-10-30

## Ownership and scope

[scan_sides.py](scan_sides.py) owns construction of the source pair. It uses
[runtime/build_info.py](../runtime/build_info.py)'s source inventory and fingerprint
and [runtime/scan_identity.py](../runtime/scan_identity.py)'s declaration contract.
It does not run scans, produce a speed verdict, install a swap, or touch a device.

The after side is committed HEAD. The before side reverses only the five pause
changes from `17befd2`, using [p9b_pauses.json](overlays/p9b_pauses.json).
Four measured files carry five hunks: cards, collections, mapping observation,
mapping navigation, and module opening. Module opening restores a fixed wait in
place of animation polling; its workload test accounts for the polls replaced.
The recorder, ledger, safety gates and all other source stay equal.

---

## Commands and identity

Run from the measured checkout after the last commit:

```powershell
python backend/tools/scan_sides.py declare
python backend/tools/scan_sides.py inventory --out backend/logs/scan_inventory.json
python backend/tools/scan_sides.py check
python backend/tools/scan_sides.py diff after.json before.json
```

`declare` reads committed LF blobs with `git archive HEAD backend frontend`
(the bytes returned by `git show HEAD:<path>`), projects them through the public
source inventory, and refuses extra, missing or modified application Python
source. CRLF checkout conversions never become recorded source pins. Normalize
the measured checkout to LF before workers run: `check` and the worker fingerprint
compare actual loaded bytes and will classify a CRLF tree as dirty against LF pins.
The explicit `revision` Python API parameter is for synthetic/source-only trees;
it trusts the supplied bytes and is not a production declaration command.

The declaration goes to `backend/logs/scan_sides.json`, local ignored state,
containing both fingerprints, HEAD revision, overlay hash and each affected file's
before/after hash. Re-declare after every commit. The CLI prints a refusal reason
as JSON on stderr and exits 2 for invalid input. `check` exits 0 only for a clean
declared side, 1 for dirty or undeclared. `inventory` records committed LF source;
the Python `inventory(root)` helper compares actual bytes in synthetic side trees.

Each exact-text hunk must occur once and must not already be applied. Reverse
application must restore the original bytes. Ambiguous, missing or repeated
anchors are errors, never guessed locations. Both fingerprints substitute bytes
into the same source inventory; only the four overlay files differ.

---

## Offline proof and live boundary

`test_scan_sides.py` checks declaration, drift refusals, LF identity and reversible
hunks. `test_p9_before_overlay.py` executes synthetic workloads on both sides and
checks identical persisted results with the expected per-site pause differences.
The history fixture records `git show 17befd2 --format= -U3 -- <file>` hunk rows,
with whitespace stripped after their diff marker, through the shared
`tests/support/fixture_json.py` writer. It is synthetic text, with no game pixels.

The temporary live installer is deliberately absent. The old package's process
check cannot prevent a worker starting or lazily importing a module during a swap.
No live quiescence or device validation was authorized for this PR. Do not install
the before files into a running checkout. A future person-controlled swap must
stop the dashboard, establish no running or starting worker, pause harvesting,
verify hashes, retain a byte-checked backup and restore the after files.

This source pair alone proves no speed improvement. The separate comparison and
acceptance work must use sealed metrics, matching account/start state/phases and
coverage, successful final Home proof, three runs per side and a bracketing after
run. Live D3 consent, D5 harvesting/session control and D8 candidate approval and
backup remain the person's gates.
