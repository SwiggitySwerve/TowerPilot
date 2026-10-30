"""Load backend/tools/scan_sides.py by path: backend/tools and the repository's own tools/ share the name `tools` on the test path."""
import importlib.util

from paths import BACKEND_TOOLS, REPO

PATH = BACKEND_TOOLS / 'scan_sides.py'
ROOT = REPO
_spec = importlib.util.spec_from_file_location('p9_scan_sides', PATH)
scan_sides = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(scan_sides)
