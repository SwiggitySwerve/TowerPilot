"""Read-only check that this tree still has every automation the upstream tree has.

Run before every upstream sync pull request (.claude/skills/delivery-flow, Upstream
sync) and whenever upstream lands new work:

    python tools/upstream_parity.py                    # fetch upstream, compare with HEAD
    python tools/upstream_parity.py --no-fetch --theirs upstream/develop --ours master

It compares, file for file, what the upstream ref has and this ref lost: dashboard
routes, top-level functions and classes, logged event names, config keys of the
shipped config and default profile, and command-line flags. It also lists upstream
branches with commits this ref does not contain. Each loss is a GAP until
tools/upstream_parity_allow.json names it with the reason it was removed on
purpose, so a rerun shows only what is new. Exit code 1 when a gap remains.

It only reads git objects; it never checks out, merges or touches a device.
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
ALLOW = ROOT / "tools" / "upstream_parity_allow.json"
SOURCE = ("backend", "frontend")
EXCLUDE = ("backend/tests/", "backend/logs/", "frontend/app/")
CONFIG_FILES = ("backend/config.example.yaml", "backend/profiles/default.yaml")

ROUTE = re.compile(r"""@\w+\.(?:get|post|put|delete|route)\(\s*["']([^"']+)["']""")
DEF = re.compile(r"^(?:async\s+)?(?:def|class)\s+(\w+)", re.M)
EVENT = re.compile(r"""\b(?:logger\.)?event\(\s*["']([a-z0-9_]+)["']""")
FLAG = re.compile(r"""add_argument\(\s*["'](--?[\w-]+)["']""")


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True,
                          text=True, encoding="utf-8", errors="replace").stdout


def python_files(ref: str) -> list[str]:
    names = git("ls-tree", "-r", "--name-only", ref, "--", *SOURCE).splitlines()
    return [n for n in names if n.endswith(".py") and not n.startswith(EXCLUDE)]


def show(ref: str, path: str) -> str | None:
    try:
        return git("show", f"{ref}:{path}")
    except subprocess.CalledProcessError:
        return None


def config_keys(text: str | None) -> set[str]:
    def walk(node, prefix=""):
        if isinstance(node, dict):
            for key, value in node.items():
                name = f"{prefix}.{key}" if prefix else str(key)
                yield name
                yield from walk(value, name)
    return set(walk(yaml.safe_load(text) if text else None))


def surface(ref: str) -> dict[str, set[str]]:
    """Every compared fact of `ref`, keyed by kind; per-file kinds carry `path:` prefixes."""
    out = {"route": set(), "event": set(), "def": set(), "flag": set(), "config": set(), "file": set()}
    for path in python_files(ref):
        text = show(ref, path) or ""
        out["file"].add(path)
        out["route"] |= set(ROUTE.findall(text))
        out["event"] |= set(EVENT.findall(text))
        out["def"] |= {f"{path}:{name}" for name in DEF.findall(text)}
        out["flag"] |= {f"{path}:{flag}" for flag in FLAG.findall(text)}
    for path in CONFIG_FILES:
        out["config"] |= {f"{path}:{key}" for key in config_keys(show(ref, path))}
    return out


def moved(theirs: dict, ours: dict) -> dict[str, str]:
    """Upstream file -> our file with the same basename, for files that moved."""
    by_name = {}
    for path in ours["file"]:
        by_name.setdefault(Path(path).name, []).append(path)
    return {path: by_name[Path(path).name][0] for path in theirs["file"] - ours["file"]
            if len(by_name.get(Path(path).name, [])) == 1}


def gaps(theirs: dict, ours: dict) -> dict[str, list[str]]:
    renames = moved(theirs, ours)

    def ours_has(kind: str, item: str) -> bool:
        if item in ours[kind]:
            return True
        path, _, name = item.partition(":")
        if kind == "def" and any(i.endswith(":" + name) for i in ours[kind]):
            return True            # moved to another module
        return path in renames and f"{renames[path]}:{name}" in ours[kind]

    found = {kind: sorted(i for i in theirs[kind] if not ours_has(kind, i))
             for kind in ("route", "event", "def", "flag", "config")}
    found["file"] = sorted(theirs["file"] - ours["file"] - set(renames))
    return found


def unmerged_branches(ours: str, remote: str) -> list[str]:
    rows = []
    for ref in git("for-each-ref", "--format=%(refname:short)", f"refs/remotes/{remote}/").split():
        if ref.endswith("/HEAD"):
            continue
        missing = [line for line in git("cherry", ours, ref).splitlines() if line.startswith("+")]
        if missing:
            rows.append(f"{ref} ({len(missing)} commit{'s' * (len(missing) != 1)})")
    return rows


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--remote", default="upstream")
    parser.add_argument("--theirs", default=None, help="upstream ref (default: <remote>/develop)")
    parser.add_argument("--ours", default="HEAD")
    parser.add_argument("--no-fetch", action="store_true")
    args = parser.parse_args(argv)
    theirs_ref = args.theirs or f"{args.remote}/develop"
    if not args.no_fetch:
        git("fetch", "--quiet", args.remote)

    allow = json.loads(ALLOW.read_text(encoding="utf-8")) if ALLOW.exists() else {}
    allow = {kind: items for kind, items in allow.items() if not kind.startswith("_")}
    found = gaps(surface(theirs_ref), surface(args.ours))
    found["branch"] = unmerged_branches(args.ours, args.remote)

    open_gaps = 0
    print(f"upstream parity: {theirs_ref} -> {args.ours}")
    for kind, items in found.items():
        allowed = allow.get(kind, {})
        new = [i for i in items if i.split(" (")[0] not in allowed]
        known = len(items) - len(new)
        open_gaps += len(new)
        print(f"  {kind:<7} {len(new)} gap(s){f', {known} allowed' if known else ''}")
        for item in new:
            print(f"    GAP {item}")
    stale = sorted(f"{kind}:{item}" for kind, items in allow.items() for item in items
                   if item not in {i.split(" (")[0] for i in found.get(kind, [])})
    for item in stale:
        print(f"  note: allowlist entry no longer needed: {item}")
    print("PASS" if not open_gaps else f"FAIL: {open_gaps} gap(s); fix them or allow each with a reason")
    return 1 if open_gaps else 0


if __name__ == "__main__":
    sys.exit(main())
