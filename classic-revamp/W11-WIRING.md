# W11 — Wiring (record)

This is the package where decoded input first reaches the composer, the panels, and the
shared controllers, so classic becomes an operable frontend rather than a set of verified
parts.

## File map

| File | Owns |
| --- | --- |
| `src/classic/app/action-handlers.ts` | One dispatch function per `ActionId` family, plus the renderer-local feed-world remapping calls. No state. |
| `src/classic/app/app-wiring.ts` | The single stateful runtime owner: controllers, decoder and router, subscriptions, cadence, repaint scheduling, resize, feed offsets, plan visibility, queue selection, focus capture, disposal. |
| `src/classic/app/ClassicApp.tsx` | Layout only, 101 lines: allocator demand, then slot composition from one external snapshot. |
| `src/classic/app/use-feed.ts` | Transcript projection with an injected commit ledger, generation, and turn boundary. |
| `src/classic/bootstrap/start-classic.tsx` | Constructs the wiring, routes stdin through the decoder, schedules deadline flushes, disposes on exit. |
| `src/classic/input/cancel-ladder.ts` | Gained explicit escape disarming so idle transitions clear the armed state. |

## Action group ownership

| Group | Destination |
| --- | --- |
| `app.*`, `focus.*` | Exit, cancel ladder, help pager, jobs overlay, mode cycle via `nextMode`/`setDefaultMode`, focus regions. |
| `editor.*` | `ComposerController.handleAction`. |
| `transcript.*` | Renderer-local feed behavior per 03-RENDER-MODEL §10. |
| `selection.*` | `SelectionController` for copy/clear/select-all; extend only while the pager owns focus. |
| `plan.*` | `PanelController.handlePlanKey`, falling back to the plan document pager. |
| `picker.*`, `modal.*`, `pager.*`, `jobs.*` | `PanelController.handleKey`. |

`app.interrupt` and `app.cancel` reach exactly one `CancelLadder` instance, whether they
arrive as a keymap action or as an escalation inside `InputRouter`.

## §10 feed remapping as built

| Action | Behavior |
| --- | --- |
| `transcript.scroll-*`, `transcript.page-*` | Move the live-tail offset only while the tail is clipped; otherwise emit the terminal-scrollback hint once per session. |
| `transcript.top` | Points at `Ctrl+R` and history rather than scrolling. |
| `transcript.bottom` | No-op; classic follows the tail by construction. |
| `transcript.search` | Opens the search panel and captures `transcript-search` focus, restoring the prior region on close. |
| `transcript.expand-toggle` | Toggles a live item override; a committed item opens in a pager instead. |
| `transcript.toggle-thinking` | Flips the global toggle and reveals the latest committed thinking content. |
| `transcript.toggle-output` | Flips the global toggle, or dispatches the shared `/output` command when no output card exists. |
| `selection.select-all` / `selection.copy` | Operate on the shared transcript semantic document through `SelectionController` and `ClipboardPort`. |
| `selection.clear` | Clears, then falls through to the cancel ladder. |

## Cadence

Two independent timers keep 03-RENDER-MODEL §9 and the W09 status contract from colliding:
an 80 ms animation tick for the spinner and toasts, and a 1 Hz tick for elapsed time and job
freshness. Both only fire while there is something live to animate. Every publish goes
through one repaint scheduler capped at 20 fps, and feed projection reads a `feedNow` value
that only advances on transcript, resize, and generation changes, so animation ticks never
reproject blocks.

## Verification

| Command | Outcome |
| --- | --- |
| `npm run typecheck` | clean |
| `npx vitest run test/classic/app` | 23 passed (2 files) |
| `npx vitest run test/classic` | 708 passed, 10 skipped (42 files) |
| `npx vitest run test/tui-v2 test/app` | green |
| `npx vitest run` | 3530 passed, 10 skipped, 0 failed (394 files) |
| `npm run test:bun` | OpenTUI smoke 3/3; parity 257 passed |
| `npm run build` | clean |
| `npm run compile` | all five release targets built |

The load-dependent `/update` timeout recorded from W07 onward did not reproduce in this
package's runs, including the full suite and the Bun parity run.

## Findings for later packages

1. **Four manual gates are now executable but still unchecked.** W08 composer, W09 status,
   W10 panels, and W11's own full-turn walkthrough all require an interactive terminal
   session. They must not be checked from automated evidence.

2. **`ClassicApp` now requires a wiring instance.** The W04 render test was updated to build
   one with an injected resize source. Its height assertion was also rescoped: committed
   `<Static>` rows now precede the chrome, so the allocator total describes the dynamic
   region rather than the whole frame. `frame-height.test.ts` remains the authority on the
   `total < rows` invariant.

3. **Queue chords are still unbound.** W09 finding 5 stands: the rendered `^⌥` queue hints
   have no `ActionId`. W11 wires queue selection state and the shared reorder/send/take/remove
   methods, but nothing dispatches them. W12 must either bind them or stop rendering them.

4. **Status row 3 is still dark.** `permissions` is passed as `[]`, the fallback W09 approved.
   Assembling real scope strings remains open.

5. **The branch segment is not yet populated.** Cwd is cached and invalidated on turn end and
   session change; branch is reserved as `undefined` rather than reading git on the render
   path. W12 or W18 should add a cached boundary if the segment is wanted.

6. **Search is focus-captured by the wiring, not the panel controller.** `openSearch` pairs
   `FocusController.pushOverlay("transcript-search")` with the panel slot and releases it when
   the panel closes. Any future caller must go through the wiring rather than the panel
   controller directly.

## Deviations

None. D-09 through D-12 remain open and unsigned.
