# Phase 9 — Hardening evidence

Date: 2026-07-14  
Branch: `ui/v2-opentui`

## Scope

| Task | Status | Evidence |
|---|---|---|
| V2-090 file-size / dependency / architecture | **PASS** | `test/tui-v2/quality-guard.test.ts` + existing architecture guards |
| V2-091 performance suite | **PASS** (Node pure paths) | `test/tui-v2/performance-suite.test.ts`; native frames still via Bun spikes |
| V2-092 OS/terminal matrix | **BLOCKED** | Same constraint as V2-015/035/065 — needs real machines |
| V2-093 fuzz (resize, Unicode, control, replay) | **PASS** | `test/tui-v2/fuzz.test.ts` (fast-check) |
| V2-094 security audit | **PASS** | `test/tui-v2/security-audit.test.ts` + `sanitize-display` wiring |
| V2-095 week dogfood + crash telemetry | **BLOCKED** | Requires sustained interactive use outside CI |
| V2-096 release / migration / limitations | **PASS** | `docs/v2/release-notes-v2-rc.md` |

## V2-090

- Hard fail: any `src/app` or `src/tui-v2` source file >400 lines.
- OpenTUI `@opentui/{core,react,keymap}` exact and identical versions.
- No `@opentui/solid` / `solid-js` (ADR-006).
- Existing: `test/app/architecture-guard.test.ts`, `test/tui-v2/architecture.test.ts`.

## V2-091 budgets (Node CI)

| Check | Budget |
|---|---|
| Fold 10k assistant-delta events | < 2000 ms |
| OutputSpool 10 MB stream | tail ≤ 20k chars; truncated notice present |
| Resize storm 70–180 × 20–60 | < 250 ms |
| Semantic doc for 10k notices | < 1500 ms |

Native culling/frame budgets remain documented under Phase 1 V2-013 spike measurements (cellsUpdated bounded; scroll frame ~7 ms class on reference hardware).

## V2-093

Property tests cover: layout non-negativity, deterministic event replay, ANSI/C0/C1 sanitize with Unicode retention, semantic anchor clamp, chord normalize idempotence, non-http URL scheme rejection.

## V2-094 changes

- New pure helper: `src/tui-v2/rendering/sanitize-display.ts`.
- Applied to: tool output presentation, selection clipboard text, transcript export.
- Export also runs `redactSecrets()` (known key shapes).
- Audit asserts SecretBuffer no-leak, limited `writeText` call sites, http(s)-only link URLs.

## V2-092 / V2-095 (blocked)

Template for manual matrix and dogfood is in `docs/v2/release-notes-v2-rc.md` § Known limitations. Do not mark these complete without interactive evidence.

## Commands

```bash
npm run typecheck
npm test
npm run spike   # Bun-only native spikes when available
```
