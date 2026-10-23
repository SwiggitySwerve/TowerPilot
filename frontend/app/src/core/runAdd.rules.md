# Run recipe creation rules
> **Status:** Active
> **Created:** 2026-10-22
> **Updated:** 2026-10-22

`runAdd.ts` owns the Runs page's interpretation of the recipe catalogue, identifier checks,
option construction, add answers and read settlement. `runTemplates.ts` retains Collection's
reading of gathering defaults. Both consume the recorded catalogue without inventing recipes.

- Offer only each recipe's choices and optional policies. Always require a label. Tournament,
  shard and dissonance recipes require equipment chosen from the account configuration.
- Check identifiers against the latest profile read and `[a-z][a-z0-9_]{0,63}` without trimming
  or changing the person's input. Preserve raw drafts in `runs:add:<context>` across reads and reload.
- Send once with `expected_revision` captured when editing starts and the click-time context
  serialized by `expectedContext`. Check context and identifiers again before sending. Adding
  saves a profile; it never starts a run or changes a schedule.
- A 200 confirms only when its profile contains the new run with the recipe's kind. Its returned
  revision is the next add's base. A refusal retains the draft; an explicit profile check permits
  review against the newest revision. Context refusals show the returned current context.
- A lost answer and the recorded 400 after the file changed are Unknown. An unchanged read
  keeps them Unknown. Only a later read of the same profile holding the run with its recipe's
  kind settles them. No automatic resend or resend control exists. Continuing from the current
  state records a person's decision without changing the unknown outcome.

The RL4 core, component, persistence and browser tests enforce these boundaries with the r12
`run_templates_add` and `run_templates_add_fenced` recordings.
