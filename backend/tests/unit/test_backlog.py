"""The backlog stays one coherent list (.claude/skills/delivery-flow).

Every unit of work is a task file in docs/pending-tasks/ whose name agrees with
its header, and every open task is queued in docs/FOCUS.md through a link that
resolves. Remaining work written anywhere else is invisible to the next session."""
import re
from urllib.parse import unquote

import pytest

import paths as test_paths

TASKS = test_paths.REPO / "docs" / "pending-tasks"
FOCUS = test_paths.REPO / "docs" / "FOCUS.md"
NAME = re.compile(r"^\[(\d{4}-\d{2}-\d{2})\]\[(Open|In Progress|Done|Won't Fix)\] (.+)\.task\.md$")
REQUIRED = ("Problem", "What Needs to Happen", "Key Files", "Context")
OPEN = ("Open", "In Progress")


def _tasks():
    return sorted(TASKS.glob("*.task.md"))


def _header(text, key):
    match = re.search(rf"^> \*\*{re.escape(key)}:\*\* (.+)$", text, re.M)
    return match.group(1).strip() if match else None


def _queued():
    """Task files FOCUS.md links to, as resolved paths."""
    text = FOCUS.read_text(encoding="utf-8")
    return {(FOCUS.parent / unquote(target)).resolve()
            for target in re.findall(r"\]\((pending-tasks/[^)]+\.task\.md)\)", text)}


def test_the_backlog_exists():
    assert _tasks(), "docs/pending-tasks/ holds the backlog"


@pytest.mark.parametrize("path", _tasks(), ids=lambda p: p.name)
def test_a_task_file_name_agrees_with_its_header(path):
    match = NAME.match(path.name)
    assert match, f"{path.name}: expected [YYYY-MM-DD][Status] Title.task.md"
    created, status, title = match.groups()
    text = path.read_text(encoding="utf-8")
    assert text.startswith(f"# {title}\n"), "the H1 is the title in the file name"
    assert _header(text, "Status") == status
    assert _header(text, "Created") == created


@pytest.mark.parametrize("path", _tasks(), ids=lambda p: p.name)
def test_a_task_file_carries_the_sections_a_fresh_session_needs(path):
    text = path.read_text(encoding="utf-8")
    sections = set(re.findall(r"^## (.+)$", text, re.M))
    missing = [s for s in REQUIRED if s not in sections]
    if (_header(text, "Priority") or "").lower() in ("medium", "high"):
        missing += [s for s in ("Success Criteria",) if s not in sections]
    assert not missing, f"missing sections: {missing}"


@pytest.mark.parametrize("path", _tasks(), ids=lambda p: p.name)
def test_links_between_task_files_resolve(path):
    text = path.read_text(encoding="utf-8")
    targets = re.findall(r"\]\(([^)]+\.task\.md)\)", text)
    dangling = [t for t in targets if not (path.parent / unquote(t)).exists()]
    assert not dangling, f"links to missing task files: {dangling}"


def test_every_open_task_is_queued_and_every_queue_link_resolves():
    queued = _queued()
    dangling = sorted(p.name for p in queued if not p.exists())
    assert not dangling, f"FOCUS.md links to missing task files: {dangling}"
    open_tasks = {p.resolve() for p in _tasks() if NAME.match(p.name).group(2) in OPEN}
    unqueued = sorted(p.name for p in open_tasks - queued)
    assert not unqueued, f"open tasks missing from FOCUS.md: {unqueued}"
    closed = sorted(p.name for p in queued - open_tasks if p.exists())
    assert not closed, f"FOCUS.md still queues closed tasks: {closed}"
