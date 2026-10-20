"""Pure gathering configuration shared by editors, validation and collectors."""
import copy
import math

ORBIT_TIMING_FIELDS = {
    "interval_sec": {"default": 960, "min": 1, "max": 3600,
        "label": "Time between collection windows",
        "description": "Start-to-start interval, whether collected or missed. Defaults to 16 minutes. A new collector starts its first window immediately."},
    "retry_interval_sec": {"default": 5, "min": 0.5, "max": 30,
        "label": "Time between tap sets while seeking",
        "description": "Short retries within one collection attempt; farming continues between sets."},
    "attempt_timeout_sec": {"default": 60, "min": 5, "max": 60,
        "label": "Collection window duration",
        "description": "Maximum active time per window; confirmation stops it early. Misses and safety refusals do not extend the window."},
    "retry_backoff_sec": {"default": 15, "min": 1, "max": 300,
        "label": "Backoff within the active window",
        "description": "Wait after an unreadable balance or safety refusal. Once the window ends, wait for the next scheduled window."},
}


def validate_orbit_timing(body: dict, path: str = "gem_orbit") -> list[str]:
    errors = []
    for key, spec in ORBIT_TIMING_FIELDS.items():
        if key not in body:
            continue
        value = body[key]
        if (type(value) not in (int, float) or not math.isfinite(value)
                or not spec['min'] <= value <= spec['max']):
            errors.append(f"{path}.{key}: must be a finite number within {spec['min']}–{spec['max']}")
    return errors


AD_GEM_FIELDS = {
    "edge_inset_px": {
        "type": "int", "default": 5, "min": 5, "max": 40,
        "label": "Button edge inset", "unit": "px",
        "description": "Minimum distance from every button edge, including tap jitter and press drift.",
    },
    "poll_sec": {
        "type": "range", "default": [2, 4], "min": 0.5, "max": 60,
        "label": "Offer check interval", "unit": "sec",
        "description": "Random interval between checks for an ad-gem offer.",
    },
    "confirmed_cooldown_sec": {
        "type": "range", "default": [720, 720], "min": 1, "max": 3600,
        "label": "Interval between collection windows", "unit": "sec",
        "description": "Time from the start of one collection window to the next, even when no gem is collected. Defaults to 12 minutes.",
    },
    "attempt_timeout_sec": {
        "type": "number", "default": 60, "min": 5, "max": 60,
        "label": "Maximum collection window", "unit": "sec",
        "description": "Stop attempts after this duration, or immediately after a confirmed claim. Farming continues between checks.",
    },
    "retry_cooldown_sec": {
        "type": "range", "default": [4, 7], "min": 1, "max": 120,
        "label": "After an unconfirmed claim", "unit": "sec",
        "description": "Random wait before checking again; a visible offer then gets its response delay.",
    },
}


def validate_ad_gem_options(body: object, path: str = "ad_gem_options") -> list[str]:
    """Validate partial overrides without loading settings or device modules."""
    if not isinstance(body, dict):
        return [f"{path}: must be a mapping"]
    errors = []
    for key, value in body.items():
        field = AD_GEM_FIELDS.get(key)
        if field is None:
            errors.append(f"{path}.{key}: unknown setting")
            continue
        if field["type"] == "int":
            valid = type(value) is int and field["min"] <= value <= field["max"]
        elif field["type"] == "number":
            valid = (type(value) in (int, float) and math.isfinite(value)
                     and field["min"] <= value <= field["max"])
        else:
            valid = (
                isinstance(value, (list, tuple)) and len(value) == 2
                and all(type(v) in (int, float) and math.isfinite(v) for v in value)
                and field["min"] <= value[0] <= value[1] <= field["max"]
            )
        if not valid:
            shape = {"int": "an integer", "number": "a finite number",
                     "range": "an ordered [min, max] pair"}[field["type"]]
            errors.append(f"{path}.{key}: must be {shape} within {field['min']}–{field['max']}")
    return errors


def resolve_ad_gem_options(body: dict | None = None) -> dict:
    """Return independent effective values; invalid saved settings fail closed."""
    overrides = {} if body is None else body
    errors = validate_ad_gem_options(overrides)
    if errors:
        raise ValueError("; ".join(errors))
    return {key: copy.deepcopy(overrides.get(key, field["default"]))
            for key, field in AD_GEM_FIELDS.items()}
