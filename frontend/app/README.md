# Tower Pilot dashboard app
> **Status:** Active (Phase 0 scaffold)
> **Type:** Knowledge
> **Created:** 2026-10-21
> **Updated:** 2026-10-21
> **Decision record:** ADR-001, frontend stack and structure (2026-10-21)

## Purpose

The new dashboard application: React 19, TypeScript (strict), Vite. It builds into
`frontend/webui/app/`, which Flask serves at `/ui/app/`. The build is git-ignored;
CI and the release scripts produce it. The legacy page (`/ui/index.html`) stays
the default until the Dashboard cutover.

---

## Commands

Node.js 22.13+ (22.x), 24.x or 26+ (`engines` in package.json; the locked dependencies accept nothing else). Run from this folder.

| Command             | What it does                                                                      |
| ------------------- | --------------------------------------------------------------------------------- |
| `npm ci`            | Install the exact versions in `package-lock.json`                                 |
| `npm run dev`       | Dev server on `http://127.0.0.1:5173/ui/app/` with the fixture-based fake backend |
| `npm run build`     | Production build into `../webui/app/` with `THIRD_PARTY_NOTICES.txt`              |
| `npm run typecheck` | `tsc` over the app, tests, tooling and the DOM-free `core/`                       |
| `npm run lint`      | ESLint (layers, no literals, a11y, hooks, typed rules) and Prettier check         |
| `npm test`          | Vitest: unit, component (Testing Library, jest-axe) and type tests                |
| `npm run e2e`       | Playwright against the built app and the fake backend (build first)               |
| `npm run format`    | Prettier write                                                                    |

`npm run dev` never talks to a real dashboard unless asked:
`TOWER_PILOT_DEV_BACKEND=http://127.0.0.1:<port>` proxies `/api` to a dashboard on
this machine and forwards GET and HEAD only.

---

## Layers

| Folder          | Holds                                                                 |
| --------------- | --------------------------------------------------------------------- |
| `src/core/`     | Evidence rules and projections, pure TypeScript (`Fact`, `Confirmed`) |
| `src/contract/` | Endpoint types and zod schemas, checked against the backend fixtures  |
| `src/api/`      | The only code that talks to the server                                |
| `src/store/`    | Store and selectors (`useSyncExternalStore`)                          |
| `src/copy/`     | Every user-visible string, as `{short, why?}`                         |
| `src/ui/`       | Design system: tokens, `Chip`, `Button`, `CopyLine`, `Why`            |
| `src/features/` | One folder per page                                                   |
| `src/app/`      | Shell, hash router, error boundary, live region, wiring               |

Which layer may import which is defined once, in `MAY_IMPORT` in
[eslint-rules/policy.js](eslint-rules/policy.js); only `src/api/` and `src/store/`
import `src/contract/` (`store/` imports `api/` for types only), and components
read `store/` view models. The lint rules are guardrails against honest mistakes,
not a security boundary (ADR-001 Amendment 1, trimmed in F1): layer zones, no JSX
text and no plain-`string` JSX child (`react/jsx-no-literals` and
[eslint-rules/no-string-jsx-child.js](eslint-rules/no-string-jsx-child.js)), no type
assertions outside the homes of the type-only brands, the network only from
`src/api/`, and no `eval`, `new Function` or `dangerouslySetInnerHTML`. The
render check in [tests/copy/renderedText.ts](tests/copy/renderedText.ts) backs
this up at runtime, and [tests/lint/rules.test.ts](tests/lint/rules.test.ts) holds
one probe per rule.

The ADR-001 decision record is kept with the project's review logs, which are not
part of the repository, so it is named here rather than linked.
---

## Notes

- ESLint 10 runs `eslint-plugin-react` 7.37.5 and `eslint-plugin-jsx-a11y` 6.10.2
  through `overrides` in `package.json`; both declare ESLint 9 at most. Remove the
  overrides when they declare ESLint 10. `eslint.config.js` explains the one
  workaround (React version read from the package, not detected).
- Contract tests read `backend/tests/fixtures/harvest_status_v1.json`.
