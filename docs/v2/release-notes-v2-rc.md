# clai UI v2 — release candidate notes

Status: **Opt-in released (Phase 10 V2-100)**  
Default UI remains the Ink full-screen TUI. OpenTUI v2 is opt-in.  
Default flip (`UI_CUTOVER_STAGE = "default-v2"`) is prepared but not activated
until dogfood/matrix evidence (see `docs/v2/cutover.md`).

## Opt-in

```bash
clai --ui=v2
# or
CLAI_UI=v2 clai
```

If the terminal cannot host the full-screen UI, the process falls back to the
Ink TUI when possible, otherwise the classic line REPL.

## What v2 delivers

- OpenTUI React shell with responsive chat / plan / composer / status layout.
- Pane-scoped semantic selection and OSC 52 clipboard with fallback.
- Streaming Markdown, thinking blocks, bounded tool cards, transcript search.
- Shared command registry parity with classic slash commands and pickers.
- Plan lifecycle (draft → approve/discard → implement) with confirm surfaces.
- Jobs panel, output pager, secret modal (masked, no-leak buffer).
- Application layer (`src/app`) fully renderer-independent.

## User migration notes

| Topic | Guidance |
|---|---|
| History / sessions | Same on-disk formats; `/history` resume works for sessions saved under classic or v2. |
| Config / keys | Unchanged paths and `conf` schema; provider secret prompts use the masked modal. |
| Key bindings | Shift+Enter newline when the terminal distinguishes it; else Alt/Option+Enter. Ctrl+J jobs, Ctrl+H plan toggle, Ctrl+P plan detail, Ctrl+R search, Ctrl+Shift+C copy selection. |
| Mouse | Click panes to focus; selection drag is pane-scoped; double/triple click word/line. |
| Plans | Compact overlay on narrow terminals; split pane when wide enough; Ctrl+H toggles. |
| Rollback | Omit `--ui=v2` / unset `CLAI_UI`, or use `--ui=tui` / `--ui=legacy` / `--classic`. No data migration required. |

## Known limitations (RC)

1. **OS/terminal matrix (V2-092)** — full Apple Terminal / Windows Terminal / tmux / Kitty protocol matrix not executed in automated CI. Record results when dogfooding.
2. **Live agent dogfood (V2-084 / V2-095)** — multi-step create/edit/web/scope workflows against live providers need interactive runs; unit coverage exists for abort, queue, permissions, history, plan implement.
3. **Built-in OpenTUI selection spike (V2-011)** — custom selection coordinator used instead; native subsystem still does not engage headlessly.
4. **Drag-edge autoscroll timing (V2-012)** — relies on native ScrollBox timers; headless probes show no scrollTop delta (expected).
5. **Diff/Code renderable tools** — no producer yet; slot is ready when a tool emits unified diffs.
6. **Inline search highlighting inside Markdown** — search jumps to the item; substring highlight inside rendered Markdown is a refinement.
7. **Crash telemetry without prompt content** — not shipped; dogfood should log only metadata if/when added.

## Compatibility checklist (manual — V2-092)

For each terminal, record Enter / Shift+Enter / Alt+Enter / Ctrl+J / Ctrl+H / Ctrl+P and OSC 52 copy:

| Terminal | OS | Keys OK | OSC 52 | Notes |
|---|---|---|---|---|
| | | | | |

## Rollback

1. Stop using `--ui=v2` / `CLAI_UI=v2`.
2. Classic TUI binary path is unchanged (`src/index.ts` default).
3. No schema downgrade required for history or config.
