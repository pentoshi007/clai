# Phase 10 — Controlled cutover policy

Date: 2026-07-14  
Branch: `ui/v2-opentui`

## Stages

| Stage | Constant | Default frontend | Rollback |
|---|---|---|---|
| **opt-in** (current) | `UI_CUTOVER_STAGE = "opt-in"` | Ink TUI (`tui`) | n/a (v2 is opt-in) |
| **default-v2** | `UI_CUTOVER_STAGE = "default-v2"` | OpenTUI (`v2`) | `--ui=legacy`, `--ui=tui`, `CLAI_UI=legacy`, `--classic` |
| **legacy-removed** | after V2-103 window | OpenTUI only | n/a |

Single switch: `src/tui-v2/bootstrap/ui-selection.ts` → `UI_CUTOVER_STAGE`.

## V2-100 — Opt-in release (done)

- CLI: `--ui v2|tui|legacy`, env `CLAI_UI`
- README documents opt-in and rollback
- `clai doctor` reports cutover stage, resolved UI, and host readiness
- Classic Ink remains default

## V2-101 — Feedback and hardening re-gate

Re-run before flipping default:

```bash
npm run typecheck
npm test
npm run spike   # when Bun + interactive host available
```

Accepted residual blockers for **opt-in** (not for default flip):

| ID | Item | Status |
|---|---|---|
| V2-092 | OS/terminal matrix | blocked — needs real terminals |
| V2-095 | Week dogfood + metadata-only crash telemetry | blocked — interactive |
| V2-084 | Live multi-step agent workflows | partial — unit coverage only |

## V2-102 — Default flip readiness

Code path for `default-v2` is implemented and unit-tested. **Production stage stays
`opt-in` until:**

1. Interactive dogfood on macOS (and ideally Linux/Windows) without showstoppers
2. Terminal matrix checklist in `release-notes-v2-rc.md` filled for primary targets
3. Hardening suite still green
4. Product owner approval to flip `UI_CUTOVER_STAGE` to `"default-v2"`

After the flip, keep Ink and the line REPL for **one full release cycle**.

## V2-103 — Remove Ink (deferred)

Do **not** delete `src/tui/**` or drop the `ink` dependency until:

- At least one release shipped with `default-v2`
- Usage/feedback shows legacy opt-out is rarely needed
- Rollback window closed deliberately

## V2-104 — Docs and adapters

- Architecture docs updated for React OpenTUI (not Solid)
- Migration adapters (`AgentEventAdapter`, current-core ports) stay while both UIs ship
- Spike scripts under `scripts/v2-spikes/` retained as evidence (not production path)

## Rollback (any stage before Ink removal)

```sh
clai --ui=tui          # Ink default path
clai --ui=legacy       # line REPL
clai --classic
CLAI_UI=legacy clai
CLAI_CLASSIC=1 clai
```

No history/config migration is required to roll back.

## Local try-out

See **`docs/v2/TRYING.md`**. Short form from the repo root:

```sh
npm run dev:v2          # Node/tsx
npm run dev:v2:bun      # Bun (recommended for native OpenTUI)
```
