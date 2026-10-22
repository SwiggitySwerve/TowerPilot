"""Build a source beta from reviewed source paths, never the workspace wholesale."""
import hashlib
import re
import subprocess
import zipfile
from collections.abc import Mapping
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
TOP = {'VERSION', 'LICENSE', 'README.md', 'requirements.txt', 'requirements-dev.txt', 'requirements-portable.lock', 'requirements-scrcpy.txt',
       'pytest.ini', 'pyproject.toml', 'Start Tower Pilot.cmd', 'Start-TowerPilot.ps1', '.gitignore', '.gitattributes',
       # agent rules and skills ship with the source (0.2-beta): CLAUDE.md is
       # the rule book, AGENTS.md points Codex and others at it
       'CLAUDE.md', 'AGENTS.md', 'DESIGN.md'}
DOCS = {'README.md', 'ACCOUNT_SETUP.md', 'BLUESTACKS.md', 'GLOBAL_REWARDS.md',
        'RUN_TEMPLATES.md', 'RELEASE_0.1_BETA.md', 'RELEASE_0.2_BETA.md', 'RELEASE_0.3_BETA.md', 'RELEASE_0.4_BETA.md', 'RELEASE_0.5_BETA.md', 'RUNTIME_GEOMETRY.md',
        'PORTABLE_BUILD.md', 'SETTINGS.md', 'LEARNING_FLOWS.md', 'OBSERVABILITY.md',
        'WORKFLOW_ARCHITECTURE_PROPOSAL.md', 'RUN_LIFECYCLE_PLAN.md',
        'RUN_WORKSPACE_REVIEW.md', 'VIDEO_PREVIEW.md'}
# Whole folders that ship as they are: the Claude Code skills, agents, hooks
# and workflow helpers, the project-local Codex config, the release workflow.
# Personal files never do: .claude/settings.local.json is a per-machine
# permission list and is excluded by name.
AGENT_DIRS = {'.claude', '.codex', '.github'}
AGENT_EXCLUDE = {'.claude/settings.local.json'}
# The dashboard app (ADR-001). Its sources ship so a release can be rebuilt
# and reviewed (decision 2); npm and test state never do.
APP_SOURCE_SUFFIXES = {'.ts', '.tsx', '.mjs', '.cjs', '.js', '.json', '.css', '.html', '.md'}
APP_SOURCE_NAMES = {'.npmrc', '.prettierignore'}
APP_SOURCE_EXCLUDE = {'node_modules', 'test-results', 'playwright-report', 'coverage'}
# Its build is git-ignored, so it is added from the filesystem: index.html,
# hashed .js and .css, the npm licence notices and the build's own inventory.
# Nothing else may ship from it - no sourcemaps, fonts or images.
APP_BUILD = 'frontend/webui/app'
APP_NOTICES = 'THIRD_PARTY_NOTICES.txt'
# Written by the build (frontend/app/scripts/build-inventory.ts) after Vite has
# checked its chunk graph: '<sha256>  <path>' for every file of the build.
APP_INVENTORY = 'BUILD_INVENTORY.txt'
APP_BUILD_SUFFIXES = {'.html', '.js', '.css'}
APP_BUILD_HINT = 'cd frontend/app; npm ci; npm run build'


def allowed(name):
    p = Path(name)
    if name in TOP:
        return True
    if p.parts[0] in AGENT_DIRS:
        return (name not in AGENT_EXCLUDE and len(p.parts) > 1
                and p.suffix in {'.md', '.json', '.js', '.cjs', '.ps1', '.toml', '.yml', '.yaml', '.txt'})
    if p.parts[0] == 'docs':
        return len(p.parts) == 2 and p.name in DOCS
    if name in {'backend/config.example.yaml', 'backend/profiles/default.yaml',
                'backend/tests/fixtures/golden_profile.yaml', 'backend/tools/winocr.ps1',
                'tools/build_release.py', 'tools/build_portable.py', 'tools/check_release_zips.py',
                'tools/portable_launcher.py'}:
        return True
    if p.parts[0] == 'backend':
        return (len(p.parts) > 1 and p.parts[1] not in {
            'accounts', 'captures', 'logs', 'runs', 'recordings', 'profiles', 'templates',
            'tools', '__pycache__'} and p.suffix in {'.py', '.json', '.md'})
    if p.parts[:2] == ('frontend', 'app'):
        return (len(p.parts) > 2 and not APP_SOURCE_EXCLUDE.intersection(p.parts)
                and (p.suffix in APP_SOURCE_SUFFIXES or p.name in APP_SOURCE_NAMES))
    if p.parts[:3] == ('frontend', 'webui', 'app'):
        return False                # the build product: app_build_files() adds it
    if p.parts[0] == 'frontend':
        return p.suffix in {'.py', '.html', '.css', '.js', '.cjs'}
    return False


class _AppIndexParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.references: list[str] = []
        self.module_scripts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.references.extend(value for key, value in attrs
                               if key in {'src', 'href'} and value is not None)
        attributes = dict(attrs)
        if tag == 'script' and (attributes.get('type') or '').strip().lower() == 'module':
            src = attributes.get('src')
            if src is not None:
                self.module_scripts.append(src)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)


def _app_reference(value: str) -> str | None:
    if not value.startswith('/ui/app/'):
        return None
    return unquote(value[len('/ui/app/'):].split('#', 1)[0].split('?', 1)[0])


def _inventory_problems(files: Mapping[str, bytes]) -> list[str]:
    """The build must match the inventory the build wrote: every listed file
    present with its hash, and nothing unlisted. This is what catches a chunk,
    stylesheet or asset that index.html does not name directly."""
    if APP_INVENTORY not in files:
        return [f'missing {APP_INVENTORY} (written by the build; rebuild the app)']
    try:
        lines = files[APP_INVENTORY].decode('utf-8').splitlines()
    except UnicodeDecodeError:
        return [f'{APP_INVENTORY} is not UTF-8']
    problems = []
    listed: set[str] = set()
    for number, line in enumerate(lines, 1):
        if not line or line.startswith('#'):
            continue
        match = re.fullmatch(r'([0-9a-f]{64})  (\S.*)', line)
        if match is None:
            problems.append(f'{APP_INVENTORY} malformed line {number}')
            continue
        digest, name = match.groups()
        if name in listed or name == APP_INVENTORY:
            problems.append(f'{APP_INVENTORY} lists {name} twice or lists itself')
        listed.add(name)
        if name not in files:
            problems.append(f'missing build output listed in {APP_INVENTORY}: {name}')
        elif hashlib.sha256(files[name]).hexdigest() != digest:
            problems.append(f'build output differs from {APP_INVENTORY}: {name}')
    if not listed:
        problems.append(f'{APP_INVENTORY} lists no files')
    for name in sorted(set(files) - listed - {APP_INVENTORY}):
        problems.append(f'file not in {APP_INVENTORY}: {name}')
    return problems

def app_build_problems(files: Mapping[str, bytes]) -> list[str]:
    """Validate a build snapshot, with paths relative to frontend/webui/app/."""
    problems = []
    if 'index.html' not in files:
        problems.append('missing index.html')
    if APP_NOTICES not in files:
        problems.append(f'missing {APP_NOTICES}')
    elif not files[APP_NOTICES].strip():
        problems.append(f'empty {APP_NOTICES}')
    for name in sorted(files):
        suffix = PurePosixPath(name).suffix.lower()
        if suffix == '.map':
            problems.append(f'sourcemap may not ship: {name}')
        elif suffix not in APP_BUILD_SUFFIXES and name not in {APP_NOTICES, APP_INVENTORY}:
            problems.append(f'file may not ship: {name}')
    problems.extend(_inventory_problems(files))
    if 'index.html' in files:
        parser = _AppIndexParser()
        try:
            parser.feed(files['index.html'].decode('utf-8'))
            parser.close()
        except UnicodeDecodeError:
            problems.append('index.html is not UTF-8')
        for value in parser.references:
            relative = _app_reference(value)
            if relative is None:
                continue
            if '..' in relative.split('/') or '\\' in relative:
                problems.append(f'invalid app reference (path traversal): {value}')
            elif relative not in files:
                problems.append(f'missing referenced app file: {relative} ({value})')
        if not any((relative := _app_reference(value)) is not None
                   and '..' not in relative.split('/') and '\\' not in relative
                   and PurePosixPath(relative).suffix == '.js'
                   for value in parser.module_scripts):
            problems.append('index.html has no <script type="module"> referencing a /ui/app/ .js file')
    return problems


def app_build_files(root: Path = ROOT, *, build_dir: Path | None = None) -> list[str]:
    """The built dashboard app, from the filesystem. Refuses a release without
    a build, or with a file the build may not contain."""
    build_dir = root / (APP_BUILD if build_dir is None else build_dir)
    files = {path.relative_to(build_dir).as_posix(): path.read_bytes()
             for path in sorted(build_dir.rglob('*')) if path.is_file()}
    problems = app_build_problems(files)
    if problems:
        raise RuntimeError(f'{APP_BUILD}/ is not built or holds files a release may not ship:\n'
                           + '\n'.join(problems) + f'\nBuild the dashboard app first: {APP_BUILD_HINT}')
    return [f'{APP_BUILD}/{name}' for name in files]


def release_files(root: Path = ROOT, *, build_dir: Path | None = None) -> list[str]:
    """Every file a release ships: the reviewed source paths git knows about,
    plus the dashboard app build."""
    names = subprocess.check_output(
        ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        cwd=root).decode().split('\0')
    sources = {n for n in names if n and allowed(n) and (root / n).is_file()}
    return sorted(sources | set(app_build_files(root, build_dir=build_dir)))


def build(root: Path = ROOT, dist: Path | None = None) -> Path:
    version = (root / 'VERSION').read_text().strip()
    files = release_files(root)
    prefix = f'TowerPilot-{version}'
    output = (root / 'dist' if dist is None else dist) / f'{prefix}-source.zip'
    output.parent.mkdir(exist_ok=True)
    inventory = []
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name in files:
            content = (root / name).read_bytes()
            archive.writestr(prefix + '/' + name, content)
            inventory.append(hashlib.sha256(content).hexdigest() + '  ' + name)
        archive.writestr(prefix + '/SHA256SUMS.txt', '\n'.join(inventory) + '\n')
    output.with_suffix('.zip.sha256').write_text(
        hashlib.sha256(output.read_bytes()).hexdigest() + '  ' + output.name + '\n')
    print(f'{output} ({len(files)} files)')
    return output


if __name__ == '__main__':
    build()
