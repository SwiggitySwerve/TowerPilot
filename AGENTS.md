# Agent instructions

Project rules live in [CLAUDE.md](CLAUDE.md). Read it first — every hard rule applies to every agent.

- Skills live in `.claude/skills/<name>/SKILL.md` (indexed in `.claude/skills/trigger-map.md`). `verify-never-infer` is mandatory before stating any factual claim about code, data, or process state.
- Verification: `python -m py_compile app.py towerpilot/*.py` and `python -m pytest` from the repo root (all tests run offline with no device required).
- Machine state (`config.yaml`, logs, screenshots) never enters git — see `.gitignore`.
