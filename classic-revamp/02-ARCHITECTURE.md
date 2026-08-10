# Target Architecture

## Principles

1. One backend, one application state, three presentation surfaces.
2. A renderer translates state into terminal cells and input into semantic actions.
   Nothing else.
3. Product behaviour never branches on renderer type.
4. `src/tui-v2` changes only where an extraction forces an import rewrite.
5. Cross-platform terminal behaviour lives behind explicit ports.
6. Parity is enforced by shared contracts and shared fixtures, not by eyeballing frames.

## Layer map

```
src/agent  src/tools  src/llm  src/store  src/safety  src/interactive-session
                              ▲
                          src/app                    renderer-free, React-free
                              ▲
                        src/ui-core                  renderer-free, React allowed only in react/
                              ▲
        ┌─────────────────────┼─────────────────────┐
   src/tui-v2            src/classic          src/noninteractive
   (OpenTUI)             (React + Ink)        (plain stream writer)
```

### Dependency rules — enforced by tests, not convention

| Rule | Guard |
|---|---|
| `src/app` imports no React, Ink, OpenTUI, inquirer; writes no terminal bytes | extend `test/app/architecture-guard.test.ts` |
| `src/ui-core` imports no `ink`, no `@opentui/*`; contains no `process.stdout.write` | new `test/ui-core/architecture.test.ts` |
| `src/ui-core/react/**` may import `react` but no renderer package | same guard, directory-scoped allowance |
| `src/classic` imports no `@opentui/*` and nothing from `src/tui-v2` | new `test/classic/architecture.test.ts` |
| `src/tui-v2` imports nothing from `src/classic` or `src/noninteractive` | extend `test/tui-v2/architecture.test.ts` |
| No renderer imports `src/repl*` | new guard, then moot after W16 |
| No renderer calls `runAgent`, provider routers, stores, jobs manager, or safety directly | guard on import specifiers per renderer tree |
| Only `src/classic/bootstrap/terminal-session.ts` and `src/noninteractive/**` write to stdout inside the classic path | guard on `process.stdout.write` |

Write these guards in W02 before the bulk of the moves so violations surface immediately.

## Target source layout

```
src/
  app/
    commands/
      catalog.ts                 ← moved from src/repl/slash-commands.ts (W01)
      command.ts
      registry.ts
    controllers/  events/  ports/  adapters/
  ui-core/
    actions/
      action-id.ts  action-router.ts  keymap.ts  format-shortcuts.ts
      chord.ts                   ← normalizeChord + KeyEventLike, renderer-neutral
      mode-cycle.ts
    bootstrap/
      capabilities.ts  composition-root.ts  console-guard.ts  console-suppress.ts
      lifecycle.ts  overlay-ports.ts  ui-selection.ts
    commands/
      command-handlers.ts  config-commands.ts  key-commands.ts
      picker-commands.ts  session-commands.ts
    composer/
      arrow-intent.ts  completion.ts  composer-height.ts  composer-meta.ts
      draft-actions.ts  paste-placeholder.ts  prompt-history.ts
      secret-buffer.ts  input-history.ts
    controllers/
      focus-controller.ts  overlay-controller.ts
      selection-controller.ts  toast-controller.ts
    layout/
      compute-layout.ts
    motion/
      ease.ts
    plan/
      plan-lifecycle.ts
    ports/
      clipboard-osc52.ts  pager-export-port.ts  renderer-port.ts
    react/
      providers.tsx  use-has-draft.ts  use-overlay.ts  use-plan.ts
      use-session-state.ts  use-toast.ts  use-transcript-store.ts
    rendering/
      artifact-pager-source.ts  batch-sections.ts  context-limit.ts
      file-diff-view.ts  format-help.ts  incremental-strip.ts
      intro-header.ts  job-tail-source.ts  link-detector.ts  markdown.ts
      open-tool-output.ts  pager-chrome.ts  pager-view-policy.ts
      picker-filter.ts  plan-view.ts  prompt-preview.ts
      render-markdown-lines.ts  responder-status.ts  sanitize-display.ts
      status-segments.ts         ← new, extracted from status-line.tsx
      streaming-markdown.ts  strip-tool-surfaces.ts  syntax-highlight.ts
      theme.ts  thinking-tail.ts  tool-presenter.ts  transcript-semantic.ts
      user-message-wrap.ts  wordmark.ts
    state/
      pager-search.ts  semantic-document.ts  transcript-compaction.ts
      transcript-hydrate.ts  transcript-reducer.ts  transcript-search.ts
      transcript-store.ts  transcript-struct.ts  transcript-types.ts
    notify.ts
  tui-v2/
    app/  bootstrap/  components/  composer/
    rendering/
      ansi-to-styled.ts  pager-markdown.ts  styled-markdown.ts
  classic/
    bootstrap/
      start-classic.tsx  terminal-session.ts  suspend-port.ts  osc52-renderer.ts
    app/
      ClassicApp.tsx  action-handlers.ts  app-wiring.ts
    feed/
      Feed.tsx  FeedStatic.tsx  LiveTail.tsx
      feed-blocks.ts  commit-ledger.ts  block-height.ts  live-tail-policy.ts
    chrome/
      Chrome.tsx  row-budget.ts
      Composer.tsx  composer-frame.ts  editor-model.ts  editor-view.ts
      StatusBar.tsx  ToastRow.tsx  QueuePanel.tsx  ResponderStrip.tsx
    blocks/
      IntroBlock.tsx  UserBlock.tsx  AssistantBlock.tsx  ThinkingBlock.tsx
      ToolBlock.tsx  BatchBlock.tsx  DiffBlock.tsx  CompactedBlock.tsx
      NoticeBlock.tsx
    panels/
      PanelFrame.tsx  PickerPanel.tsx  PagerPanel.tsx  JobsPanel.tsx
      PlanPanel.tsx  ConfirmPanel.tsx  SecretPanel.tsx  ScopePanel.tsx
      KeysPanel.tsx  PromptActionsPanel.tsx  CompletionPanel.tsx
      SearchPanel.tsx  panel-host.tsx
    input/
      raw-decoder.ts  key-event.ts  chord-from-key.ts  paste-decoder.ts
      sgr-mouse.ts  terminal-sequences.ts  input-router.ts
    render/
      ansi-text.ts  glyphs.ts  ink-theme.ts  wrap.ts  measure.ts
  noninteractive/
    start-noninteractive.ts  stream-renderer.ts  stream-blocks.ts
    stdio-confirm-port.ts
```

Subdivision may shift if a test proves a better boundary. Ownership and dependency
direction may not.

## `src/ui-core` extraction manifest

Move with `git mv`, in this cluster order. Run `npx vitest run test/tui-v2 test/app`
after every cluster. Move each module's tests alongside it.

| # | Cluster | Files |
|---|---|---|
| 1 | actions | `tui-v2/actions/*` → `ui-core/actions/`; `tui-v2/app/mode-cycle.ts` → `ui-core/actions/mode-cycle.ts`; split `chord-from-key.ts` into neutral `ui-core/actions/chord.ts` (normalizer + `KeyEventLike`) and OpenTUI-specific `tui-v2/input/chord-from-opentui-key.ts` |
| 2 | controllers | `tui-v2/controllers/*` → `ui-core/controllers/` |
| 3 | state | `tui-v2/state/{pager-search,semantic-document,transcript-*}.ts` → `ui-core/state/`; the six `use-*.ts` hooks → `ui-core/react/` |
| 4 | composer logic | `tui-v2/composer/{arrow-intent,completion,composer-height,composer-meta,draft-actions,paste-placeholder,prompt-history,secret-buffer}.ts` → `ui-core/composer/`; `tui/input-history.ts` → `ui-core/composer/input-history.ts`; `tui/text-format.ts` merges into `ui-core/rendering/user-message-wrap.ts` or stays as `ui-core/rendering/text-format.ts` |
| 5 | layout + motion | `tui-v2/layout/compute-layout.ts` → `ui-core/layout/`; `tui-v2/motion/ease.ts` → `ui-core/motion/` |
| 6 | rendering (pure) | the 22 pure files listed in §4 of [01-AUDIT.md](01-AUDIT.md) → `ui-core/rendering/`; plus `ui/markdown.ts`, `ui/code-block.ts` (fold into `markdown.ts` if the seam allows), `ui/text-width.ts`, `ui/intro-header.ts`, `ui/wordmark.ts` |
| 7 | capabilities + lifecycle | `tui-v2/bootstrap/{capabilities,lifecycle,console-guard,console-suppress}.ts` → `ui-core/bootstrap/` |
| 8 | composition root + ports | `tui-v2/bootstrap/{composition-root,overlay-ports,ui-selection,pager-export,osc52-clipboard}.ts` → `ui-core/bootstrap/` and `ui-core/ports/`; generalize `osc52-clipboard` and `pager-export` over their existing narrow port interfaces so both renderers inject their own |
| 9 | command handlers + plan | `tui-v2/app/{command-handlers,plan-lifecycle,startup-update}.ts` and `tui-v2/app/commands/*` → `ui-core/commands/` and `ui-core/plan/` |
| 10 | React providers | `tui-v2/app/providers.tsx` → `ui-core/react/providers.tsx`; the JSX pragma moves to the renderer-specific wrappers |
| 11 | new neutral models | extract `status-segments.ts` from `components/status/status-line.tsx` and `context-limit.ts` from `components/status/context-limit-chip.tsx`; OpenTUI then renders those models instead of computing them |
| 12 | shim removal | delete every temporary re-export created during 1–11 |

### Splitting the styled-value seam

`render-markdown-lines.ts` and `streaming-markdown.ts` currently return
`ReturnType<typeof ansiToStyledText>`. Restructure so they return **ANSI strings**
(`readonly string[]`) and OpenTUI converts at the edge:

- `ui-core/rendering/render-markdown-lines.ts` → `AnsiLine[]` where `AnsiLine = string`.
- `ui-core/rendering/streaming-markdown.ts` → `AnsiLine[]` plus its existing cache.
- `tui-v2/rendering/styled-markdown.ts` (new, thin) wraps both and applies
  `ansiToStyledText`.
- Ink renders `AnsiLine` directly inside `<Text>`; Ink passes SGR through untouched.

This is behaviour-preserving for OpenTUI and removes the only real blocker to sharing the
markdown pipeline.

## Shared services contract

Both interactive renderers receive the identical `AppServices` from
`ui-core/bootstrap/composition-root.ts`. A renderer may hold private adapter state. It may
not replace, shadow, or duplicate shared state.

`CompositionOptions` already accepts injectable `clipboard`, `pagerExport`, `requestExit`,
and `capabilities`. Ink supplies:

| Injection | Ink implementation |
|---|---|
| `clipboard` | `ui-core/ports/clipboard-osc52.ts` driven by `classic/bootstrap/osc52-renderer.ts` (`Osc52RendererPort` = `{ isOsc52Supported(): boolean; copyToClipboardOSC52(text): boolean }`), falling back to `createSystemClipboardPort()` |
| `pagerExport` | `ui-core/ports/pager-export-port.ts` driven by `classic/bootstrap/suspend-port.ts` (`RendererSuspendPort` = `{ suspend(); resume() }`) |
| `requestExit` | `lifecycleRef.current?.shutdownAndExit(0)` |
| `capabilities` | `readCapabilitiesFromProcess()` |
| `confirm` / `requestSecret` | defaults from `createOverlayConfirmPort` / `createOverlaySecretPort` — unchanged, so every confirm prompt string stays identical across renderers |

`RendererHandle` (`{ start(); destroy() }`) and `RendererLifecycle` are reused verbatim.
Ink's `start()` enters the terminal session then mounts; `destroy()` unmounts, disposes
controllers, leaves the terminal session, disposes services.

## Command ownership

- **Metadata** lives in `src/app/commands/catalog.ts` after W01: names, usages,
  descriptions, aliases, `knownModels`, `getKnownModels`, `inferProviderForModel`,
  `looksLikeSlashCommand`, `slashCommandFilter`, `getSlashCommandSuggestions`,
  `isKnownSlashCommand`, `slashCommandLabel`. `/jobs` is added.
- **Behaviour** lives in `src/ui-core/commands/*`. Both renderers call the same
  `attachCommandHandlers(services)`. There is no renderer-specific command switch.
- Handlers request UI through shared controllers (`overlay.openPicker`,
  `overlay.openPager`, `toast.show`, `session.notice`). They never emit JSX or bytes.

## Input architecture

```
raw stdin bytes
  → classic/input/raw-decoder.ts        (bytes → KeyEvent | PasteEvent | MouseEvent)
  → classic/input/chord-from-key.ts     (KeyEvent → chord string)
  → ui-core/actions/chord.ts            (normalizeChord)
  → ActionRouter.resolve(chord, focus.activeContext())
  → classic/app/action-handlers.ts      (semantic action → controller call)
```

`ActionRouter`'s `TRAPPING_CONTEXTS` (`picker`, `modal`, `secret`, `transcript-search`,
`pager`, `jobs`) already prevents an unbound chord inside an overlay from firing a global
action. Reuse it as-is.

## State and presentation

`TranscriptStore` + `applyAppEvent` are the source of truth, unchanged. Its 16 ms
coalescing of `assistant-delta` / `thinking-delta` / `tool-output` and its 2000-item bound
are load-bearing; do not tune them.

Where a rendering helper currently returns an OpenTUI value, introduce a neutral view
model and let each renderer map it:

| Model | Owner | Consumers |
|---|---|---|
| `AnsiLine[]` markdown output | `ui-core/rendering/render-markdown-lines.ts` | both |
| `ToolPresentation` | `ui-core/rendering/tool-presenter.ts` (already neutral) | both |
| file-diff rows | `ui-core/rendering/file-diff-view.ts` (already neutral) | both |
| pager rows + chrome | `ui-core/rendering/{pager-chrome,pager-view-policy}.ts` | both |
| plan rows | `ui-core/rendering/plan-view.ts` (already neutral) | both |
| status segments | `ui-core/rendering/status-segments.ts` (new) | both |
| picker rows | `ui-core/rendering/picker-filter.ts` (already neutral) | both |
| feed blocks | `classic/feed/feed-blocks.ts` | classic only |

Formatting policy lives in the model. JSX only positions and colours.

## Lifecycle and terminal ownership

`RendererLifecycle` handles `SIGINT` (1500 ms cooperative window, second signal → exit
130), `SIGTERM` → 143, `SIGHUP` → 129, `uncaughtException` / `unhandledRejection` → exit 1,
and idempotent concurrent shutdown. Disposers run in reverse order:
`session.persistNow()`, then `restoreConsole`, then
`interactiveSessions.closeAll("app-shutdown")`.

`classic/bootstrap/terminal-session.ts` is the **only** module in the classic tree allowed
to write control bytes. It owns raw mode, bracketed paste, cursor visibility, and optional
mouse reporting. Every `enter`/`leave` is idempotent so teardown is safe from any path.
Alternate screen is **not** used — see [03-RENDER-MODEL.md](03-RENDER-MODEL.md) §2.

`installConsoleGuard` is reused: stray `console.*` goes to `<logsDir>/tui-console.log`
(mode 0o600, 1 MiB cap) and surfaces as a warn notice. Ink is mounted with
`patchConsole: false` so the two mechanisms do not fight.

## Non-interactive surface

`src/noninteractive/` is not React. It subscribes to the same `AppEvent` stream through a
minimal composition (session controller + agent port, no overlay/toast/selection) and
writes ordered lines to stdout. See [06-ONESHOT.md](06-ONESHOT.md).

## What stays in `src/tui-v2` forever

OpenTUI renderer creation and teardown, `patch-opentui-text.ts`, the JSX components,
`useKeyboard` and OpenTUI mouse events, the OpenTUI textarea integration, native
selection integration, `ScrollBox` scroll renderables, `ansi-to-styled.ts`,
`pager-markdown.ts`, `styled-markdown.ts`, and the OpenTUI-bound OSC52 and pager-export
adapters.
