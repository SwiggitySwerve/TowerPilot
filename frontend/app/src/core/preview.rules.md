# Preview rules
> **Status:** Active
> **Created:** 2026-10-23
> **Updated:** 2026-10-23

`preview.ts` owns viewer preferences, presets, session URLs, status interpretation,
source identity, effective FPS and freshness verdicts (F6-13 PV1–PV8).
Availability describes prerequisites; a current confirmed transport is required
separately. Auto is explicit in the URL. ADB caps effective FPS at four.

Receiving requires a decoded advancing successful sequence and a matching fresh
active status with a positive successful count and no error. The displayed
part identifies its source. Receipt age is measured locally; source age is the
estimate at server encode, and server report age is separate. Missing values
remain unknown. Freshness expires after `max(3, 2 / target_fps)` seconds.

The session store owns consent and cancellation. Entry and disclosure do no I/O.
Stop, collapse, hidden document, route leave, context change and unmount abort
all work, clear pixels and revoke object URLs. A context epoch and a new stream
ID reject late answers. Preferences persist in local storage; consent never does.
There is no automatic repair, still-image fallback or session restart.
