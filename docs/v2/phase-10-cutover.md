# Phase 10 evidence

Date: 2026-07-14

| Task | Status | Evidence |
|---|---|---|
| V2-100 opt-in release | **PASS** | `UI_CUTOVER_STAGE=opt-in`; README; `--ui` help; doctor UI block; `resolveUiChoice` |
| V2-101 hardening re-gate | **PASS** (automated) | typecheck + full Vitest; residual interactive blockers documented in cutover.md |
| V2-102 make v2 default | **PREPARED, not activated** | `default-v2` resolution tested; production constant remains `opt-in` pending dogfood |
| V2-103 remove Ink | **DEFERRED** | Explicit non-goal until rollback window after default-v2 release |
| V2-104 archive + architecture | **PASS** | ARCHITECTURE.md React topology; cutover.md adapter retention notes |

## Commands

```bash
npm run typecheck
npm test
npm run dev:v2       # interactive try (real TTY)
npm run dev:v2:bun   # interactive try via Bun
```

See `docs/v2/TRYING.md`.

## How to flip default later (V2-102 activation)

1. Confirm cutover.md readiness checklist.
2. Change `UI_CUTOVER_STAGE` to `"default-v2"` in `ui-selection.ts`.
3. Update README default language and release notes.
4. Bump version; ship one release with `--ui=legacy` / `--ui=tui` advertised.
