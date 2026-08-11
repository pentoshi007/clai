# W10 — Panels (record)

## File map

| File | Owns |
| --- | --- |
| `src/classic/panels/panel-effect.ts` | Typed effects and handled/unhandled reducer results shared by every panel. |
| `src/classic/panels/panel-controller.ts` | Overlay synchronization, per-panel interaction state, key and paste dispatch, effect interpretation, search state, and row demand. |
| `src/classic/panels/panel-host.tsx` | Exhaustive overlay-kind dispatch and the independent transcript-search slot. |
| `src/classic/panels/list-rows.ts` | Shared list-row clipping and active-row presentation. Pure. |
| `src/classic/panels/picker-panel.ts`, `PickerPanel.tsx` | Filtered picker state transitions and rendering. |
| `src/classic/panels/pager-panel.ts`, `PagerPanel.tsx` | Wrapped artifact paging, caret movement, search, format selection, and export hints. |
| `src/classic/panels/jobs-panel.ts`, `JobsPanel.tsx` | Job list, elapsed/status presentation, tail opening, and stop actions. |
| `src/classic/panels/plan-panel.ts`, `PlanPanel.tsx` | Plan progress, task rows, hide, and full-document pager actions. |
| `src/classic/panels/confirm-panel.ts`, `ConfirmPanel.tsx` | Tool, pentest, reset, continue, switch, and plan confirmation variants. |
| `src/classic/panels/secret-panel.ts`, `SecretPanel.tsx` | Masked secret entry backed exclusively by `SecretBuffer`. |
| `src/classic/panels/scope-panel.ts`, `ScopePanel.tsx` | Scope choice and description rows. |
| `src/classic/panels/keys-panel.ts`, `KeysPanel.tsx` | Provider-key editing, masking, reveal policy, and provider cap. |
| `src/classic/panels/prompt-actions-panel.ts`, `PromptActionsPanel.tsx` | Copy, resend, and edit actions for prior prompts. |
| `src/classic/panels/search-panel.ts`, `SearchPanel.tsx` | Transcript query editing, match navigation, and selected-hit opening. |
| `src/classic/render/glyphs.ts` | Sticky, remove, lock, and presenter-only ASCII fallbacks required by panel rows. |

`panel-frame.ts`, `PanelFrame.tsx`, and `list-window.ts` were delivered in W08 and are consumed unchanged except for the corrected inner-body width calculation in `panel-frame.ts`.

## Reuse from `ui-core`

No panel duplicates shared policy. Picker filtering comes from `rendering/picker-filter.ts`; pager chrome from `rendering/pager-chrome.ts`; plan ordering, progress, wrapping, owner chips, glyph selection, and task colours from `rendering/plan-view.ts`; transcript matching from `state/transcript-search.ts`; transcript projection from `state/transcript-types.ts`; secret storage and sanitization from `state/secret-buffer.ts`; overlay requests and callbacks from `ports/overlay-ports.ts`; and job-tail paging from `rendering/job-tail-source.ts`.

Jobs use `formatJobElapsed` from `src/tools/jobs.ts`. Key entry uses `MAX_PROVIDER_KEYS` from `src/llm/key-rotation.ts`. Overlay opening, suspension, restoration, and blocking-prompt resolution remain owned by `OverlayController`.

## Panel and controller flow

`OverlayController` publishes a renderer-neutral request. `PanelController` creates only the renderer-local cursor, query, window, caret, and edit state for that request. Pure panel reducers return typed `PanelEffect` values. The controller applies those effects through the request callbacks, shared controllers, or injected ports, then publishes one snapshot consumed by `PanelHost` through `useSyncExternalStore`.

Transcript search is intentionally separate from `OverlayState`: it is a classic transcript interaction rather than a shared blocking request. It can occupy the panel slot while the shared overlay kind remains `none`. W11 must pair search open and close with transcript-search focus capture and restoration.

Effects that inspect the active request are applied before `close`. This is required for plan detail, delete preview, resend, and edit because closing mutates the tracked overlay state. Pager wrapping is recomputed from the current artifact page and width rather than cached, so asynchronously loaded pages cannot leave navigation on stale lines.

## Key and stacking evidence

| Surface | Pinned behavior |
| --- | --- |
| Confirm | Variant-specific key sets; delete `v` previews without resolving; plan `p` opens detail without resolving. |
| Pager | Navigation, paging, search, format cycling, scrollback export, and editor export. |
| Jobs | Tail opens a pager over jobs; closing the pager restores the jobs list. |
| Plan | `Ctrl+P` opens the formatted plan document; `Ctrl+H` hides the inline plan. |
| Secret | Key and paste paths remain inside `SecretBuffer`; serialized controller state contains no plaintext. |
| Keys | Sensitive labels stay masked; non-secret endpoint values may be revealed. |
| Search | Uses shared match ordering and opens the selected transcript hit in a pager. |

`overlay-stacking.test.ts` proves pager-over-confirm and pager-over-jobs restoration through the real `OverlayController`. `secret.test.ts` proves both typing and paste paths do not expose plaintext through panel state serialization.

## Verification

| Command | Outcome |
| --- | --- |
| `npm run typecheck` | clean |
| `npx vitest run test/classic/panels` | 115 passed (12 files) |
| `npx vitest run test/classic` | 684 passed, 10 skipped, 1 failed (40 files) — unrelated load-dependent timeout in `test/classic-lifecycle.test.ts` |
| `npx vitest run test/classic-lifecycle.test.ts` | 5 passed in isolation, confirming the aggregate failure was load-dependent |
| `npm run test:bun` | OpenTUI smoke 3/3 passed; parity 256 passed with the known `/update` load timeout; `/update` passed alone |
| `npm run build` | clean |
| `npm run compile` | all five release targets built |
| Prior full-suite package run | 3506 passed, 10 skipped, 1 failed — the known load-dependent `/update` timeout in `test/tui-v2/app/command-parity.test.ts` |

## Findings for later packages

1. **The manual panel gate moves to W11.** The panels and controller are unit-verified, but runtime stdin does not reach `PanelController` yet. W11 must exercise every overlay, focus restoration, delete preview, and plan detail before checking the final W10 box.

2. **Plan progress deliberately excludes responder-owned tasks.** `planProgress` and `taskGlyph` are consumed exactly as shared `ui-core` exposes them. Classic must not introduce a second denominator or normalize responder glyphs into foreground-task glyphs.

3. **Search needs explicit focus ownership.** `PanelController.openSearch()` owns search state but does not mutate `OverlayController`. W11 must push `transcript-search` focus when opening it and restore the prior focus when it closes.

4. **Panel effects are ordered operations.** Any W11 action that emits multiple effects must resolve request-dependent effects before close. Deferring all closes inside the controller would hide caller mistakes and was not introduced.

5. **Panel row demand is already authoritative.** Confirm demand follows wrapped prompt height; prompt-actions demand follows its rendered line count; pager and list panels use their own caps. W11 should pass `PanelController.rowsWanted()` directly to the chrome allocator.

6. **Presenter-only glyphs require the shared fallback map.** Responder task markers and compact plan plates use glyphs not present in the foreground task table. `adaptPresenterGlyphs` now covers those values for ASCII terminals.

## Deviations

None. D-09 through D-12 remain open and unsigned.
