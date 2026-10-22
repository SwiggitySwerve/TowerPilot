# Historical battle evidence
> **Status:** Active
> **Type:** Domain rules
> **Updated:** 2026-10-22

[history.ts](history.ts) owns evidence checks for the read-only History page.

- Pages contain twenty records and use one extra server row to establish Next. There is no total count.
- A prepared record establishes no start; an interrupted observer establishes no defeat. Display recorded outcomes and origin without inferring earlier history.
- Stats capture preserves failed, pending, missing and unverified lifecycle states separately. Verified stats additionally require the server's verified, fresh, structured, matching-tier and consistent-wave flags, the same battle and envelope, and an observed entry. Evidence flags never upgrade another lifecycle state to verified. Keep the original status and any reason/error visible; an unknown status remains unknown.
- Collection counts come from the server's sampled evidence only. Require its generation and observation bounds to match the battle, valid nonnegative counters, and valid recorded confirmation times. Positive counters also require the corresponding channel's confirmation; an empty confirmation map supports only zero counters. Withhold counts with invalid provenance. Never calculate a battle gem total or a balance increase from ad claims.
- Missing values remain unknown; numeric zero remains zero. Recorded gaps and unknown server strings remain visible.

[store/history.ts](../store/history.ts) owns query lifecycle: one read per slot, independent list/detail retries, target and request fencing, same-query last-loaded retention, and clearing on target change.
