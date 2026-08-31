# Phase 6 — App, UI core, and renderers

Status: **planned**
Depends on: Phase 5 complete
Primary hotspots: UI-core commands/rendering/state, app session controller, OpenTUI components, Classic surfaces, noninteractive renderer

## Objective

Separate renderer-neutral session semantics, commands, state, layout, and rendering primitives from Classic, OpenTUI, and noninteractive projections. Reduce UI hotspots without changing transcript meaning, output channels, terminal behavior, keyboard/mouse interaction, performance bounds, or cross-renderer parity.

## Scope

In scope:

- `src/app`, especially large session/controller modules;
- `src/ui-core`, including `commands/picker-commands.ts` (audit: 1,342 lines), `rendering/markdown.ts` (1,138), `rendering/syntax-highlight.ts` (1,368), transcript state/store/hydration, layout, actions, controllers, and ports;
- `src/tui-v2`, including app, transcript/tool card, pager, composer, modal, bootstrap, and rendering hotspots;
- `src/classic`, following its stricter contributor line guideline;
- `src/noninteractive` and shared CLI stream/output semantics;
- relevant `src/ui` compatibility/mention helpers;
- session-runtime integration where renderer/session ownership contracts are exercised.

Out of scope:

- changing visual design, command behavior, shortcuts, output wording, default surface selection, or terminal feature set;
- changing agent/LLM/tool semantics already stabilized in earlier phases;
- broad snapshot regeneration;
- removing a renderer or merging renderer-specific state into UI core.

## Protected contracts

### Shared app/session semantics

Preserve:

- session controller queueing, generation, cancellation, compaction, plan, history, provider/model, command, and lifecycle semantics;
- shared event payload/order and transcript semantic document;
- new/fork/switch/resume behavior, busy queue continuation, and cancellation coordination;
- action/port contracts and architecture direction from renderers to UI core/app, not runtime policy imports from renderers;
- usage, working-time, status, toast, confirmation, overlay, focus, selection, and pager state.

### Rendering and transcript

Preserve:

- Markdown/syntax/ANSI rendering, links, widths, wrapping, incremental streaming, code blocks, tool/thinking rows, diffs, truncation, search, copy/export, and semantic hydration;
- transcript event order, pending flush behavior, compaction cards, persisted/restored state, and interleaved thinking;
- locale-sensitive number/token/byte rendering characterized in Phase 0;
- no renderer-specific object leaking into persisted or shared semantic state.

### OpenTUI and Classic

Preserve:

- default/platform/size surface selection and no-OpenTUI Windows/Classic startup path;
- keyboard chords, text editing, completion, paste, history, MCP tokens, secret buffers, mouse/hover/scroll, card focus, selection, and overlay stacking;
- alternate-screen entry/exit, raw mode, resize/repaint, terminal restoration, sign-off card, and clipboard behavior;
- tool/thinking duration, plan pane, job/pager, command/provider/model/key/scope/privacy/history interactions;
- performance and row-budget behavior; no per-frame unbounded parsing or allocation regression.

### Noninteractive

Preserve:

- assistant answer on stdout and progress/tools/diffs/thinking/confirmations/errors on stderr;
- quiet/verbose/show-thinking behavior, spinner/progress, stream block order, MCP lifecycle, cancellation, and exact exit codes;
- no TTY-only import/startup side effect for prompt/pipe operation.

### Session runtime

Preserve authenticated local transport, single attached controller, detach/reattach/replay behavior, alternate-screen modes, live/fresh switching, idle lifecycle, bounded buffers, and platform path/permission rules.

## Required characterization

Run and strengthen:

```sh
npx vitest run \
  test/app \
  test/ui-core \
  test/tui-v2 \
  test/classic \
  test/noninteractive \
  test/session-runtime \
  test/reducers.test.ts \
  test/markdown.test.ts \
  test/file-diff.test.ts \
  test/mentions.test.ts \
  test/app/frontend-semantic-parity.test.ts \
  test/exit-epilogue-resume.test.ts \
  test/job-tail-pager.test.ts \
  test/pager-wrap.test.ts \
  --reporter=dot
```

Add semantic fixtures before component extraction. Snapshot shared semantic data rather than incidental component internals when possible. For visual snapshots, review every row/ANSI/style change. Include narrow terminals, Unicode widths, large streaming updates, selection/focus boundaries, and locale cases.

## Intended architecture

1. **App controllers** own renderer-neutral session/use-case coordination through explicit ports.
2. **UI-core actions/controllers/state** own semantic UI state transitions, not framework components.
3. **UI-core rendering primitives** own pure Markdown/syntax/width/wrap/tool presentation and produce renderer-neutral rows/models.
4. **Classic adapter/components** project shared state through Ink and own only Classic input/terminal concerns.
5. **OpenTUI adapter/components** project shared state through OpenTUI and own only OpenTUI layout/input/renderer concerns.
6. **Noninteractive adapter** projects the same semantic events to stdout/stderr with its own stream lifecycle.
7. **Session-runtime ports** expose ownership/attach/replay operations without importing renderer components.

Avoid a universal “UI context” object. Split by state domain, command family, controller, and pure rendering primitive. Keep framework types at adapter boundaries.

## Work sequence

### 1. Freeze semantic parity

Capture event-to-semantic-state-to-render-projection fixtures for representative conversation, tool batch, diff, plan, thinking, compaction, confirmation, abort, error, history restore, and sign-off flows across all three surfaces.

### 2. Decompose app controllers

Split session queue/cancel/compact/lifecycle/commands through narrow ports. Preserve `test/app/controllers.contract.test.ts` and session-controller parity as primary contracts.

### 3. Decompose UI-core commands and state

Split picker/config/key/model/provider/history/plan/scope/job/output command families. Split transcript reducer/store/hydration/pending flush/search/selection without changing action semantics.

### 4. Decompose rendering primitives

Move tokenization, block/inline Markdown, syntax themes/tokenization, width/wrap, links, tool sections, and pager policy as pure modules. Share behavior only where parity tests prove identity.

### 5. Decompose OpenTUI

Reduce app/transcript/tool card/pager/composer/modal hotspots into components/hooks/models with explicit ownership. Characterize mouse/focus/scroll and performance before movement.

### 6. Decompose Classic

Reduce components/controllers under the contributor guideline of 400 lines. Preserve Windows-first selection and POSIX terminal/input behavior.

### 7. Decompose noninteractive output

Separate semantic stream state, stdout/stderr writers, progress, confirmations, and exit mapping. Keep no-TTY startup free of renderer side effects.

### 8. Remove architecture debt

When a frozen runtime-policy import edge is removed, update the exact remove-only expected edge set in `test/architecture/legacy-baseline.json` in the same structural commit. Never add a replacement edge or exception.

### 9. Reduce facades

Remove applicable oversized entries as files pass 1,000 lines, then continue below 500 (Classic below 400). Perform cosmetic cleanup separately.

## Acceptance criteria

- [ ] Shared semantic fixtures and frontend parity are unchanged across Classic, OpenTUI, and noninteractive output.
- [ ] Commands, aliases, event/action order, state persistence, stdout/stderr, and exit codes are unchanged.
- [ ] Keyboard/mouse/editor/focus/scroll/terminal/resize/sign-off behavior remains protected.
- [ ] Surface selection and session-runtime detach/reattach contracts pass on supported platforms/runtimes.
- [ ] UI-core remains framework/renderer neutral and architecture exceptions only decrease.
- [ ] Scoped ordinary files are `<500`; Classic files are `<=400`; applicable legacy entries are removed.
- [ ] Changed functions meet complexity/Halstead/CRAP/type ratchets and scoped mutation has no survivors/no-coverage mutants.
- [ ] Performance suites show no material regression under the Phase 0 budget.
- [ ] Targeted, architecture, canonical full-suite, build, Bun, PTY, and platform jobs pass.

## Validation

The `test:deterministic` and `quality:*` scripts below are Phase 0 deliverables and must exist before this phase begins; use the final names recorded by Phase 0.

After each state/render/component seam:

```sh
npm run typecheck
npx vitest run test/app test/ui-core --reporter=dot
npx vitest run test/tui-v2 test/classic test/noninteractive --reporter=dot
npm run test:arch -- --reporter=dot
npm run quality:changed
```

At phase close:

```sh
npm run typecheck
npm run embed-prompts:check
npm run test:arch -- --reporter=dot
npx vitest run test/app test/ui-core test/tui-v2 test/classic test/noninteractive test/session-runtime --reporter=dot
npm run test:deterministic -- --reporter=dot
npm run build
npm run test:bun
npm run test:classic:pty
npm run quality:ratchet
npm run quality:mutation -- --scope ui
npm run release:verify
git diff --check
```

macOS/Windows renderer/process evidence must come from target-host CI. Do not mark it passed from Linux fixtures alone.

## Commit and rollback plan

Commit shared semantic characterization first, then one controller/state/render/component seam at a time. Keep facade exports and renderer adapters stable until all callers migrate. Architecture edge removal and its remove-only baseline update are one structural commit. Any semantic parity, output-channel, terminal-mode, input, focus/scroll, performance, or resume regression requires reverting the smallest seam before continuing.
