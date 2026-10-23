# Saved run entry settings
> **Status:** Active
> **Created:** 2026-10-22
> **Updated:** 2026-10-22

`runEntry.ts` owns selection and parsing of a run's entry and equipment fields.
The server vocabulary owns legal fields per kind, dissonance tabs and numeric bounds.
Config owns available equipment; the profile owns policy references. Only coin runs
offer the vocabulary's special loadout. Count belongs only to shard runs.

Each field saves one profile patch. Raw drafts retain their starting revision and
survive reads and reload under their original context, run and field. Invalid text
is never clamped. Empty max wave writes null; an empty perk list clears bans;
deleting perk bans leaves the game's bans alone. None deletes a policy reference.

The shared profile-patch command fences context at click time, captures the raw
draft, sends once and journals the outcome. A 500 is Unknown. Only a later read
holding the sent change proves application. An unchanged read keeps Unknown;
explicit continuation permits a new save without changing that journal evidence.
Stale drafts require an explicit continuation from a later successful profile read.
Each revision pin also records the raw edit so that newer typing retains its original
revision when an older save clears only matching submitted draft keys. The marker
also restores the raw list and removal choice if a newer compound edit survives
while its unchanged submitted text key is cleared. The explicit
read action retries vocabulary as well as profile source after a failed initial read.
The routine editor remains a separate owner and save path.
