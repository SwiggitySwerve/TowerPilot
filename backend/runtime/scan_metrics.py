"""What one calibration scan did, measured where it happens and sealed with its operation (roadmap item 9, spec 3.1).

A worker that has an accepted operation starts ONE recorder (player/calibrate.py main). The code that already performs the measured action
reports to it through these functions, so each count has one place: Windows OCR (vision/textocr.py: invocations, crops, PowerShell launches,
timeouts, errors), screen captures (device/capture.py: ok, retries, failed), input (device/act.py: taps and swipes by reason) and the phase loop
(player/calibrate.py: start, end, status, coverage, errors of each phase). With no recorder every function is a no-op, so the runners, the
dashboard and every other caller are unchanged. A hook that raises is swallowed and counted in `hook_errors`: a measurement never changes a scan.

The file carries a `run` block (the operation's kind and request, and its account, device key, rendering and instance, read once from the ledger record) and an
`identity` block, so a later comparison judges a pair from the two files alone. The file is calibrate_metrics.json in the calibration folder, written once when the worker ends (any outcome) and retained under
operations/<id>/ by the operation's own sealing (runtime/operations.py), so it is per operation and cannot be overwritten by a later scan.
Coverage is the phase's OWN returned result copied at the phase's end (never the working card_manifest.json or module_manifest.json, which
later scans overwrite). A phase skipped because the saved state already holds it done is recorded `carried_over` with no coverage: that scan
did no work for it. Identity (which code ran) is runtime/scan_identity.py. Judging whether two files are comparable is not done here.

Time: durations come from a monotonic clock, instants from the wall clock. Nothing here sends input, captures or runs OCR.
"""
import contextlib
import json
import threading
import time

from player.calibration_report import entries_since

SCHEMA_VERSION = 1
ERROR_TEXT = 300
LISTED = 20

_lock = threading.RLock()
_recorder = None


def _zero():
    return dict(ocr=dict(calls=0, crops=0, process_launches=0, timeouts=0, errors=0),
                captures=dict(ok=0, retries=0, failed=0),
                inputs=dict(taps=0, swipes=0, refused=0, by_reason={}))


def _copy(counters):
    return json.loads(json.dumps(counters))


def _delta(after, before):
    out = {}
    for key, value in after.items():
        if isinstance(value, dict):
            inner = _delta(value, before.get(key, {}))
            out[key] = inner if key != 'by_reason' else {name: count for name, count in inner.items() if count}
        else:
            out[key] = value - before.get(key, 0)
    return out


def _count(value):
    if isinstance(value, (list, tuple, dict, set)):
        return len(value)
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    return str(value)


def coverage_of_result(result, player=None):
    """The coverage a phase returned, flattened to counts and scalars: {'inventory': {...counts}, 'names': 5, ...}. Not a source of truth about the
    account: a record of what THIS phase read in THIS operation."""
    if not isinstance(result, dict):
        return {}
    out = {}
    for key in sorted(result, key=str):
        value = result[key]
        if key == 'inventory' and isinstance(value, dict):
            out[key] = {str(name): _count(item) for name, item in sorted(value.items(), key=lambda pair: str(pair[0]))}
        else:
            out[str(key)] = _count(value)
    if 'modules_in_grid' in result and isinstance(player, dict) and 'module_inventory_complete' in player:
        out['module_inventory_complete'] = player['module_inventory_complete']       # returned by no phase: calibrate.py keeps it in cal.player
    return out


def bootstrap_coverage(state, since):
    """The coverage of a bootstrap (starter scan or selected routes) from the saved state: the screens it visited with their map rows, the steps it
    completed, and the targets it touched since `since` (wall time at its start): the rule player/bootstrap.py applies to count what needs attention."""
    phase = ((state or {}).get('phases') or {}).get('bootstrap') or {}
    screens = sorted(phase.get('screens') or [])
    rows = (state or {}).get('screen_map') or {}
    screen_map = {name: dict(status=row.get('status'), verified=row.get('verified'), total=row.get('total'))
                  for name, row in sorted(rows.items()) if name in screens and isinstance(row, dict)}
    entries = entries_since((state or {}).get('entries') or [], since)
    return dict(kind=phase.get('kind'), steps_completed=phase.get('completed'), steps_total=phase.get('total'), screens=screens,
                screen_map=screen_map, targets=dict(total=len(entries), verified=sum(bool(entry.get('verified')) for entry in entries)),
                skipped=len(phase.get('skipped') or []), needs_attention=phase.get('needs_attention'))


def run_of(record):
    """The run block of a metrics file, from the operation's ledger record: what was asked (kind and request) and on which account, device and rendering,
    so a later comparison judges a pair from the two files alone (spec 3.1 and 3.2 rule 1). Missing parts are None."""
    record = record if isinstance(record, dict) else {}
    context = record.get('context') if isinstance(record.get('context'), dict) else {}
    return dict(kind=record.get('kind'), request=record.get('request'), account=context.get('account'), device_key=context.get('device_key'),
                rendering=context.get('rendering'), instance=context.get('instance'))


def error_of(error):
    if error is None:
        return None
    if isinstance(error, BaseException):
        return dict(type=type(error).__name__, message=str(error)[:ERROR_TEXT])
    return dict(type='text', message=str(error)[:ERROR_TEXT])


class Recorder:
    def __init__(self, operation_id, identity=None, run=None, *, mono=time.monotonic, wall=time.time):
        self.operation_id = operation_id
        self.identity = identity or {}
        self.run = run or {}
        self.mono, self.wall = mono, wall
        self.started_mono, self.started_at = mono(), wall()
        self.counters = _zero()
        self.phases, self.open = [], None
        self.start_state = None
        self.hook_errors = 0

    # -- worker I/O runs on its controlling thread; no locks on the hot path
    def input(self, kind, reason):
        inputs = self.counters['inputs']
        inputs[kind] += 1
        key = reason or '(none)'
        inputs['by_reason'][key] = inputs['by_reason'].get(key, 0) + 1

    # -- phases
    def phase_begin(self, name):
        self._close_open('interrupted', 'the next phase began before this one was ended')
        self.open = dict(name=name, started_mono=self.mono(), started_at=self.wall(), before=_copy(self.counters))

    def phase_end(self, name, status, *, coverage=None, error=None, unverified=()):
        opened = self.open
        if opened is None or opened['name'] != name:
            return
        self.open = None
        errors = []
        if error is not None and status not in ('done',):
            errors.append(dict(kind=status, **error_of(error)))
        unverified = list(unverified)
        if unverified:
            errors.append(dict(kind='entries_not_verified', count=len(unverified), rels=unverified[:LISTED]))
        self.phases.append(self._phase_record(opened, status, True, coverage, errors))

    def phase_carried_over(self, name):
        now = self.wall()
        self.phases.append(dict(name=name, status='carried_over', ran_in_this_operation=False, started_at=now, ended_at=now, duration_s=0.0,
                                coverage={}, errors=[], **_zero()))

    def _phase_record(self, opened, status, ran, coverage, errors):
        spent = _delta(self.counters, opened['before'])
        return dict(name=opened['name'], status=status, ran_in_this_operation=ran, started_at=opened['started_at'], ended_at=self.wall(),
                    duration_s=round(self.mono() - opened['started_mono'], 3), coverage=coverage or {}, errors=errors, **spent)

    def _close_open(self, status, message):
        if self.open is not None:
            opened, self.open = self.open, None
            self.phases.append(self._phase_record(opened, status, True, {}, [dict(kind=status, type='text', message=message)]))

    # -- the file
    def document(self, outcome='completed', error=None):
        self._close_open('interrupted', 'the worker ended inside this phase')
        errors = [dict(phase=phase['name'], **item) for phase in self.phases for item in phase['errors']]
        totals = _copy(self.counters)
        totals['inputs']['by_reason'] = dict(sorted(totals['inputs']['by_reason'].items()))
        return dict(schema_version=SCHEMA_VERSION, operation_id=self.operation_id, run=self.run, closed=True,
                    started_at=self.started_at, ended_at=self.wall(), duration_s=round(self.mono() - self.started_mono, 3),
                    exit=dict(outcome=outcome, error=error_of(error)), phases=self.phases, ocr=totals['ocr'], captures=totals['captures'],
                    inputs=totals['inputs'], errors=errors, start_state=self.start_state, identity=self.identity, hook_errors=self.hook_errors)


# ----------------------------------------------------------------------------------------------- lifecycle
def begin(operation_id, identity=None, run=None, **clocks):
    """Start the recorder of this process (replacing any earlier one). Call only for a worker that has an accepted operation."""
    global _recorder
    with _lock:
        _recorder = Recorder(operation_id, identity, run, **clocks)
        return _recorder


def active():
    return _recorder is not None


def current():
    return _recorder


def end():
    """Stop recording; returns the recorder (or None)."""
    global _recorder
    with _lock:
        recorder, _recorder = _recorder, None
        return recorder


def _with(action):
    """Run one hook's action on the recorder, entirely under the module lock (the recorder is read, changed and its failures counted there)."""
    with _lock:
        recorder = _recorder
        if recorder is None:
            return
        try:
            action(recorder)
        except Exception:       # noqa: BLE001 - a measurement never changes a scan
            recorder.hook_errors += 1


def _hook_failed():
    """Count a hook failure that happened outside _with (a caller's callable that raised)."""
    with _lock:
        if _recorder is not None:
            _recorder.hook_errors += 1


def set_start_state(state):
    _with(lambda r: setattr(r, 'start_state', state))


def discard_stale(path):
    """Remove a metrics file a previous operation left in the working folder, so sealing can only retain THIS operation's."""
    from pathlib import Path
    with contextlib.suppress(OSError):
        Path(path).unlink(missing_ok=True)


def end_and_write(path_of, outcome='completed', error=None):
    """End the recorder and write its file at path_of(). Never raises: a failed write is logged and the scan stays what it was."""
    recorder = end()
    if recorder is None:
        return None
    try:
        from runtime.files import atomic_json
        with _lock:
            document = recorder.document(outcome, error)
        atomic_json(path_of(), document)
        return document
    except Exception as exc:        # noqa: BLE001
        try:
            from runtime import logger
            logger.event('metrics_error', operation_id=recorder.operation_id, error=str(exc)[:ERROR_TEXT])
        except Exception:           # noqa: BLE001
            pass
        return None


# ----------------------------------------------------------------------------------------------- hooks
def _bump(group, name, amount=1):
    recorder = _recorder
    if recorder is not None:
        try:
            recorder.counters[group][name] += amount
        except Exception:
            recorder.hook_errors += 1


def ocr_call(crops=1):
    _bump('ocr', 'calls')
    _bump('ocr', 'crops', crops)


def ocr_launch():
    _bump('ocr', 'process_launches')


def ocr_timeout():
    _bump('ocr', 'timeouts')


def ocr_error():
    _bump('ocr', 'errors')


def capture_ok():
    _bump('captures', 'ok')


def capture_retry():
    _bump('captures', 'retries')


def capture_failed():
    _bump('captures', 'failed')


def _input(kind, reason):
    recorder = _recorder
    if recorder is not None:
        try:
            recorder.input(kind, reason)
        except Exception:
            recorder.hook_errors += 1


def tap(reason=''):
    _input('taps', reason)


def swipe(reason=''):
    _input('swipes', reason)


def input_refused():
    _bump('inputs', 'refused')


def phase_begin(name):
    _with(lambda r: r.phase_begin(name))


def phase_end(name, status, **fields):
    _with(lambda r: r.phase_end(name, status, **fields))


def phase_carried_over(name):
    _with(lambda r: r.phase_carried_over(name))


@contextlib.contextmanager
def phase(name, coverage=None, status=None):
    """One phase of a worker that is not the phase loop (the bootstrap, the observation). `coverage` and `status` are called when it ends normally,
    outside the module lock (they read files); one that raises is counted in `hook_errors` and leaves the phase open, to be closed as interrupted."""
    phase_begin(name)
    try:
        yield
    except BaseException as exc:
        phase_end(name, 'error', error=exc)
        raise
    else:
        if active():
            try:
                final = status() if status else 'done'
                seen = coverage() if coverage else None
            except Exception:       # noqa: BLE001 - a measurement never changes a scan
                _hook_failed()
            else:
                phase_end(name, final, coverage=seen)


def evaluate(action):
    """Gather optional measurement inputs without letting their evaluation fail a scan."""
    if not active():
        return
    try:
        action()
    except Exception:
        _hook_failed()
