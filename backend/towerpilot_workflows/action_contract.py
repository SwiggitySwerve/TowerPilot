"""The reusable timed-action contract (roadmap item 6): pure definitions and schedule policies.

Nothing here reads a clock, a random source, a file or a device. A driver that already exists asks a policy
"is this due?" with the numbers it holds, runs its own handler behind its own guards, and records the result
through `towerpilot_workflows.actions`. There is no central scheduler. The host owns the state dict (its own
attributes today), so reset scope and restart behaviour do not change.

Stdlib and this package only (`tests/test_workflow_boundary.py`): the package is installed without the rest of
the backend. Policies not yet used by a migrated caller are declared as parameters only; each gets an
`evaluate` when its first caller moves.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol

SCHEMA_VERSION = 1
RESULTS = ('succeeded', 'no_op', 'failed', 'refused', 'cancelled')
EFFECTS = ('confirmed', 'unconfirmed', 'unknown', 'none')
TRIGGERS = ('automatic', 'manual', 'dependency', 'boundary')
STATES = ('running', 'yielded', *RESULTS, 'interrupted', 'unknown')
OPEN_STATES = ('running', 'yielded')            # the states of an execution that is still open
COVERAGES = ('full', 'since_adoption', 'unknown')


class SystemClock:
    """Production clock. Reads at call time, so a test that patches `time` is honoured."""

    @staticmethod
    def mono() -> float:
        return time.monotonic()

    @staticmethod
    def wall() -> float:
        return time.time()


class FakeClock:
    """Deterministic clock for tests: advance it explicitly, never by waiting."""

    def __init__(self, mono: float = 0.0, wall: float = 1_700_000_000.0):
        self._mono, self._wall = float(mono), float(wall)

    def mono(self) -> float:
        return self._mono

    def wall(self) -> float:
        return self._wall

    def advance(self, seconds: float) -> None:
        self._mono += seconds
        self._wall += seconds


@dataclass(frozen=True)
class Field:
    """One control of an action. JSON-serializable, so a generic editor needs no per-action code."""
    path: str
    type: str                      # 'bool' | 'number'
    min: float | None = None
    max: float | None = None
    unit: str | None = None
    label: str = ''
    default: float | None = None   # what an absent setting means, when the action has one
    live: bool = True              # a person may change it on a running battle
    saved: bool = True             # it is part of the saved run settings
    nullable: bool = True          # null removes the override and inherits

    def valid(self, value: Any) -> bool:
        """The validation `control_settings.validate_patch` applies: no coercion, no NaN, inside the bounds."""
        if self.type == 'bool':
            return type(value) is bool
        return type(value) in (int, float) and math.isfinite(value) and self.min <= value <= self.max

    def spec(self):
        """The legacy `FIELDS` entry: `bool` or `(min, max)`."""
        return bool if self.type == 'bool' else (self.min, self.max)

    def to_json(self) -> dict:
        return dict(path=self.path, type=self.type, min=self.min, max=self.max, unit=self.unit, label=self.label,
                    default=self.default, live=self.live, saved=self.saved, nullable=self.nullable)


@dataclass(frozen=True)
class Capabilities:
    live_controls: bool = False
    pause: bool = False
    run_now: bool | str = False    # True, False, or a refusal reason code
    variants: bool = False         # the host binding publishes serialized tokens, e.g. shopping:<section>:<id>

    def to_json(self) -> dict:
        return dict(live_controls=self.live_controls, pause=self.pause, run_now=self.run_now, variants=self.variants)


@dataclass(frozen=True)
class BindingResult:
    """What a host binding reports about a manual request or an active execution."""
    state: str                     # pending | started | yielded | terminal
    outcome: str | None = None     # terminal: one of RESULTS
    effect: str = 'none'           # terminal: one of EFFECTS
    reason: str | None = None
    attempts: int = 0
    evidence: tuple = ()
    refs: Mapping[str, Any] = field(default_factory=dict)   # window_id, sweep_id, attempt_id: ids the code already mints


@dataclass(frozen=True)
class Decision:
    """What a schedule policy says. Unknown is `None`, never zero."""
    kind: str                      # due | wait | blocked | skip_missed | not_applicable
    occurrence_key: str | None = None
    eligible_at: float | None = None
    next_due_at: float | None = None
    next_attempt_at: float | None = None
    missed: int = 0
    reason: str | None = None
    basis: str = ''


# ----------------------------------------------------------------- policies
class SchedulePolicy(Protocol):
    """What every implemented policy offers: a pure decision from the numbers the host passes in. It returns a new
    state and never mutates the one it was given; unknown is `None`, never zero."""
    basis: str

    def evaluate(self, now: float, state: Mapping, conditions: Mapping) -> tuple['Decision', dict]: ...


@dataclass(frozen=True)
class StartToStart:
    """Windows that start on a fixed or sampled cadence, independent of how long a window ran.

    State: `next_window_at` (monotonic; 0.0 = nothing scheduled yet, so the first window is due at once) and
    `window_open`. Conditions: `manual`, `interval` (the period skip arithmetic uses) and `skip_duration` (how
    long a window may last). A window that is wholly in the past is skipped, never owed: there is no catch-up.
    """
    basis = 'start_to_start'

    def evaluate(self, now: float, state: Mapping, conditions: Mapping) -> tuple[Decision, dict]:
        new = dict(state)
        nwa, manual = state['next_window_at'], bool(conditions.get('manual'))
        if state.get('window_open'):
            return Decision('wait', next_due_at=nwa or None, reason='window_open', basis=self.basis), new
        if not manual and nwa and now >= nwa + conditions['skip_duration']:
            interval = conditions['interval']
            missed = math.floor((now - nwa) / interval) + 1
            new['next_window_at'] = nwa + missed * interval
            return Decision('skip_missed', next_due_at=new['next_window_at'], missed=missed, basis=self.basis), new
        if manual or now >= nwa:
            return Decision('due', eligible_at=nwa or None, basis=self.basis), new
        return Decision('wait', next_due_at=nwa, basis=self.basis), new

    @staticmethod
    def open_window(now: float, state: Mapping, interval: float, window_sec: float) -> tuple[dict, dict]:
        """The window that starts now: its length is capped by the interval so windows never overlap."""
        duration = min(window_sec, interval)
        window = dict(started_at=now, deadline=now + duration, duration=duration, interval=interval)
        return window, dict(state, next_window_at=now + interval, window_open=True)

    @staticmethod
    def close_window(state: Mapping) -> dict:
        return dict(state, window_open=False)

    @staticmethod
    def reanchor(last_started_at: float, interval: float) -> float:
        """A new interval counts from the last window's start; the schedule is neither reset nor awarded."""
        return last_started_at + interval

    @staticmethod
    def window_end(started_at: float, window_sec: float, deadline: float) -> float:
        """A shorter window shortens the live one and never extends it."""
        return min(deadline, started_at + window_sec)


@dataclass(frozen=True)
class AppearanceDriven:
    """Attempts that open when the host recognizes what to collect, spaced only after input that was not confirmed.

    There is no cadence: nothing is owed while nothing is on screen, and a confirmed claim owes nothing but the host's own input
    pacing. State: `next_window_at` (monotonic; the earliest the next attempt may open, 0.0 = nothing owed) and `window_open`.
    Conditions: `manual` (an explicit request, which waits for neither an appearance nor the spacing) and `appearance` (True only
    when the pixels the host already holds show the thing; unknown is not absence, and authorizes nothing).

    The host keeps three numbers beside that state and passes them to the arithmetic below: the anchor of the spacing (the start of
    the last attempt that sent input and was not confirmed; `None` = no spacing owed), the safety floor an expired attempt leaves,
    and its own input pacing. The arithmetic is here so that one definition decides when the next attempt may open.
    """
    basis = 'appearance_driven'

    def evaluate(self, now: float, state: Mapping, conditions: Mapping) -> tuple[Decision, dict]:
        new = dict(state)
        nwa = state['next_window_at']
        if state.get('window_open'):
            return Decision('wait', next_due_at=nwa or None, reason='window_open', basis=self.basis), new
        if conditions.get('manual'):
            return Decision('due', eligible_at=nwa or None, basis=self.basis), new
        if now < nwa:
            return Decision('wait', next_due_at=nwa, reason='spacing', basis=self.basis), new
        if not conditions.get('appearance'):
            return Decision('wait', next_due_at=nwa or None, reason='no_appearance', basis=self.basis), new
        return Decision('due', eligible_at=nwa or None, basis=self.basis), new

    @staticmethod
    def open_window(now: float, window_sec: float) -> dict:
        """The attempt that starts now. Its length is the window setting alone: spacing never shortens it."""
        return dict(started_at=now, deadline=now + window_sec, duration=window_sec)

    @staticmethod
    def window_end(started_at: float, window_sec: float, deadline: float) -> float:
        """A shorter window shortens the live attempt and never extends it."""
        return StartToStart.window_end(started_at, window_sec, deadline)

    @staticmethod
    def retry_anchor(attempt_started: float, had_input: bool) -> float | None:
        """Only an attempt that really sent input anchors the spacing; one that sent none owes none."""
        return attempt_started if had_input else None

    @staticmethod
    def safety_floor(now: float, backoff: float, input_ready_at: float) -> float:
        """What an expired attempt leaves: no new attempt sooner than the safety backoff or the host's input pacing."""
        return max(now + backoff, input_ready_at)

    @staticmethod
    def spacing_floor(anchor: float | None, interval: float, safety_floor: float) -> float:
        """The earliest the next attempt may open: `interval` after the anchor, never before the safety floor."""
        return max(0.0 if anchor is None else anchor + interval, safety_floor)

    @staticmethod
    def resume_at(now: float, input_ready_at: float) -> float:
        """A confirmed claim resumes watching at once, after the host's input pacing."""
        return max(now, input_ready_at)


@dataclass(frozen=True)
class AfterCompletion:
    """Due once `interval` has strictly passed since the last completion, or at once for a confirmed continuation.

    State: `last_completed_at`. Conditions: `interval`, `continuation_ready`. Every terminal path completes, so
    a failed or empty sweep backs off exactly like a full one.
    """
    basis = 'after_completion'

    def evaluate(self, now: float, state: Mapping, conditions: Mapping) -> tuple[Decision, dict]:
        last, interval = state['last_completed_at'], conditions['interval']
        if conditions.get('continuation_ready'):
            return Decision('due', eligible_at=now, next_due_at=now, reason='continuation', basis=self.basis), dict(state)
        if now - last > interval:
            return Decision('due', eligible_at=last + interval, next_due_at=last + interval, basis=self.basis), dict(state)
        return Decision('wait', next_due_at=last + interval, basis=self.basis), dict(state)

    @staticmethod
    def complete(now: float, state: Mapping) -> dict:
        return dict(state, last_completed_at=now)


@dataclass(frozen=True)
class Backoff:
    """Relaunch spacing after failed attempts, with a circuit.

    `delay(n)` is `min(cap, base * factor**(n-1))` after n consecutive fast failures. A launch is also never
    sooner than `min_spacing` after the previous one began, a refusal is rechecked every `refusal_retry`
    seconds, and `circuit` consecutive fast failures stop relaunching until an explicit On.
    State: `newest_created_at`, `newest_updated_at` (None while an attempt is still running), `failures`,
    `refusal_at`. Facts come from the operations ledger, which stays the authority for the circuit.
    """
    base: int = 30
    factor: int = 2
    cap: int = 900
    circuit: int = 5
    window: int = 120              # an exit sooner than this counts as a failed attempt
    min_spacing: int = 10
    refusal_retry: int = 10
    basis = 'backoff'

    def delay(self, failures: int) -> int:
        return 0 if failures <= 0 else min(self.cap, self.base * self.factor ** (failures - 1))

    def fast_failure(self, status: str, ran_sec: float, refused: bool) -> bool:
        return status in ('failed', 'interrupted') and ran_sec < self.window and not refused

    def evaluate(self, now: float, state: Mapping, conditions: Mapping | None = None) -> tuple[Decision, dict]:
        failures = state.get('failures', 0)
        spacing = None
        if state.get('newest_updated_at') is not None:
            spacing = max(state['newest_updated_at'] + self.delay(failures), state['newest_created_at'] + self.min_spacing)
        refusal_at = state.get('refusal_at')
        waits = [t for t in (spacing, refusal_at) if t is not None and t > now]
        until = max(waits) if waits else None
        if failures >= self.circuit:
            return Decision('blocked', next_attempt_at=until, reason='circuit_open', basis=self.basis), dict(state)
        if until is not None:
            return Decision('wait', next_attempt_at=until, reason='backing_off', basis=self.basis), dict(state)
        return Decision('due', basis=self.basis), dict(state)


# Declared as parameters; each is implemented with its first migrated caller (items 6-7).
@dataclass(frozen=True)
class DailyCalendar:
    tz: str = 'local'
    floor: str | None = None
    offset_sec: int = 0
    retry_sec: int = 0
    close_on: str = 'confirmed'
    basis = 'calendar'


@dataclass(frozen=True)
class Cooldown:
    floor_sec: float = 0.0
    basis = 'cooldown'


@dataclass(frozen=True)
class Elapsed:
    seconds: float = 0.0
    basis = 'elapsed'


@dataclass(frozen=True)
class EventOnly:
    reason: str = 'event'
    basis = 'event'


# ---------------------------------------------------------------- definitions
@dataclass(frozen=True)
class ActionDefinition:
    id: str
    label: str
    family: str                    # gems | rewards | chores | rules | cycles | dayplan | harvest
    hosts: frozenset
    schedule: Any
    fields: tuple = ()
    capabilities: Capabilities = Capabilities()
    saved: str | None = None       # name of the SavedAdapter the dashboard registers for it; None = live only
    restricted: str | None = None  # reason; non-None means never user-triggered
    evidence: tuple = ()           # outcome reasons that prove a game effect
    consumes: str | None = None    # 'confirmed' | 'attempted' (calendar families)

    def field(self, path: str) -> Field | None:
        return next((item for item in self.fields if item.path == path), None)

    def descriptor(self) -> dict:
        return dict(fields=[item.to_json() for item in self.fields], capabilities=self.capabilities.to_json())


class Catalog:
    """Data only: nothing here imports cv2, adb or settings."""

    def __init__(self, definitions=()):
        self._definitions: dict[str, ActionDefinition] = {}
        for definition in definitions:
            self.register(definition)

    def register(self, definition: ActionDefinition) -> ActionDefinition:
        if definition.id in self._definitions:
            raise ValueError(f'Action already registered: {definition.id}')
        self._definitions[definition.id] = definition
        return definition

    def get(self, action_id: str) -> ActionDefinition:
        return self._definitions[action_id]

    def find(self, action_id: str) -> ActionDefinition | None:
        return self._definitions.get(action_id)

    def __contains__(self, action_id: str) -> bool:
        return action_id in self._definitions

    def __iter__(self):
        return iter(self._definitions.values())

    def copy(self) -> 'Catalog':
        return Catalog(self._definitions.values())

    def control_fields(self) -> dict:
        """The legacy `FIELDS` table of the actions that have controls: `{action: {field: bool | (min, max)}}`."""
        return {item.id: {f.path: f.spec() for f in item.fields} for item in self if item.fields}


_GEM_HOSTS = frozenset({'orchestrator', 'collector', 'shard', 'quest_sm', 'quest_ilm', 'harness'})
_ENABLED = Field('enabled', 'bool', label='Enabled')
_INTERVAL = Field('interval_sec', 'number', 1, 3600, 's', 'Interval')
_WINDOW = Field('window_sec', 'number', 5, 60, 's', 'Window')

AD_GEMS = ActionDefinition(
    id='ad_gems', label='Ad gems', family='gems', hosts=_GEM_HOSTS, schedule=StartToStart(),
    fields=(_ENABLED, _INTERVAL, _WINDOW),
    capabilities=Capabilities(live_controls=True, pause=True, run_now=True), saved='gather_policy',
    evidence=('offer_disappeared',))
FLOATING_GEMS = ActionDefinition(
    id='floating_gems', label='Floating gems', family='gems', hosts=_GEM_HOSTS, schedule=AppearanceDriven(),
    fields=(_ENABLED,
            Field('interval_sec', 'number', 1, 3600, 's', 'Retry spacing after unconfirmed taps'),
            Field('window_sec', 'number', 5, 60, 's', 'Maximum floating gem claim attempt'),
            Field('tap_interval_sec', 'number', 0.5, 30, 's', 'Time between tap sets while seeking')),
    capabilities=Capabilities(live_controls=True, pause=True, run_now=True), saved='gather_policy',
    evidence=('balance_increased',))
SHOPPING = ActionDefinition(
    id='shopping', label='Shopping', family='rewards', hosts=frozenset({'orchestrator'}), schedule=AfterCompletion(),
    fields=(_ENABLED, Field('interval_sec', 'number', 1, 86400, 's', 'Interval', default=90)),
    capabilities=Capabilities(live_controls=True, pause=True, run_now=True, variants=True), saved='shopping_plan',
    evidence=('confirmed_purchase',))
HARVEST_LAUNCH = ActionDefinition(
    id='harvest_launch', label='Harvest collector launch', family='harvest', hosts=frozenset({'dashboard'}),
    schedule=Backoff(), capabilities=Capabilities(run_now='not_supported'), evidence=('launched',))

CATALOG = Catalog((AD_GEMS, FLOATING_GEMS, SHOPPING, HARVEST_LAUNCH))

DEFAULT_SHOPPING_INTERVAL_SEC = SHOPPING.field('interval_sec').default
SPRINT_SHOPPING_INTERVAL_SEC = 20     # an untracked run shops this often during the intro sprint


def shopping_interval(preset: Mapping, *, tracked: bool = True, sprint: bool = False) -> float:
    """Seconds between shopping sweeps: the one definition. A tracked run follows its shopping plan, else the preset's
    `shop_interval_sec`, else the default; a run with no battle record ignores the plan and shops every 20 s during
    the intro sprint."""
    if not tracked:
        return SPRINT_SHOPPING_INTERVAL_SEC if sprint else preset.get('shop_interval_sec', DEFAULT_SHOPPING_INTERVAL_SEC)
    return (preset.get('shopping_plan') or {}).get('interval_sec', preset.get('shop_interval_sec', DEFAULT_SHOPPING_INTERVAL_SEC))
