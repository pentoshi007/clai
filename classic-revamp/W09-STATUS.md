# W09 — Status, toasts, queue, responder (record)

## File map

| File | Owns |
| --- | --- |
| `src/classic/chrome/status-rows.ts` | Row 1/2/3 construction, density ladder, drop-from-bottom, `statusRowsWanted`. Pure. |
| `src/classic/chrome/StatusBar.tsx` | Renders those rows. |
| `src/classic/chrome/toast-rows.ts` | Newest-two selection, plate colour per level, `(+N)` marker. Pure. |
| `src/classic/chrome/ToastRow.tsx` | Renders those rows, `null` when empty. |
| `src/classic/chrome/queue-rows.ts` | Header, numbered items, selection marker, `… +N more`, `queueRowsWanted`. Pure. |
| `src/classic/chrome/QueuePanel.tsx` | Renders those rows, `null` when empty. |
| `src/classic/chrome/responder-row.ts` | Visibility predicate and the one strip row. Pure. |
| `src/classic/chrome/ResponderStrip.tsx` | Renders it, `null` when invisible. |

Every component is a thin wrapper over a pure row builder and reuses `BlockRows` from
`feed/Feed.tsx` as the row primitive, so there is exactly one place in classic that turns a
string into an Ink `<Text>`.

## Reuse from `ui-core`

`status-segments.ts` supplies `statusDensityForWidth`, `modeIndicatorPresentation`,
`idleHintIds`, `busyCancelHint`, `armedCancelHint`, `formatActivity`, `spinnerFrame`,
`clipSegment`, `cwdViewportWidth`, `tasksToggleLabel`, and `responderStatusText`.
`context-limit.ts` supplies `contextChipForDensity`'s output through
`SessionState.contextChip` and `contextUsageSeverity` for the chip colour.
`ToastController` is consumed unchanged, including its `MAX_VISIBLE_TOASTS = 3` and
same-key replacement.

## Density ladder as built

| Density | Width | Rows | Row 1 | Row 2 |
| --- | --- | --- | --- | --- |
| `xs` | < 48 | 1 | `AGENT · 24.1k` plus scroll badges when the tail clips | — |
| `sm` | 48-67 | 2 | model without the provider, chip without the limit, cwd | `^X clear` only with a draft, then `⇧⇥ mode` |
| `md` | 68-95 | 2 | `provider/model`, full chip, cwd, no branch | `/ commands · ^T thinking · ^O output · ⇧⇥ mode` |
| `lg` | >= 96 | 2-3 | adds `(branch)` | adds `/shortcuts`; row 3 only when there are permissions to report |

While busy, row 2 is the activity row: `⠋ <activity> · <elapsed> · esc: cancel`, with
`esc again to cancel` when armed and `compacting` replacing the activity while compacting.
Goldens for five widths x five states are snapshotted in
`test/classic/chrome/__snapshots__/status-density.test.ts.snap`.

## Verification

| Command | Outcome |
| --- | --- |
| `npm run typecheck` | clean |
| `npx vitest run test/classic/chrome` | 113 passed (4 files) |
| `npx vitest run test/classic` | 570 passed, 10 skipped (28 files) |

## Findings for later packages

1. **Row 3 has no data source yet.** `statusRows` takes `permissions: readonly string[]`
   and renders it verbatim. Nothing in `SessionState` or the controllers exposes
   auto-approve scope, network scope, or free-tier state as strings today. W11 must either
   assemble that list from the safety configuration or pass `[]` and leave row 3 dark; the
   allocator already asks for two rows in that case, so nothing breaks either way.

2. **Cwd and branch are inputs, not reads.** `status-rows.ts` performs no `process.cwd()`
   or git call — `relativizeHome` is exported for the caller. W11 owns the cache and its
   turn-end / cwd-change invalidation, per 04-UI-SPEC §4.2.

3. **The spinner needs the 1 Hz tick, and elapsed needs a turn start time.** Both arrive as
   plain numbers (`tick`, `elapsedSeconds`). W11's tick must drive them; the row builder
   stays deterministic and testable.

4. **`(+N)` sits on the bottom row.** 04-UI-SPEC §4.3 says the marker goes on the last row,
   and the last row is the newest toast. This is the opposite of "mark the row nearest the
   hidden ones", so it is pinned by a test to stop a later refactor from flipping it.

5. **Queue selection is not owned here.** `queueRows` takes `selected`; the `^⌥↑↓` /
   `^⌥⏎` / `^⌥E` / `^⌥⌫` chords are not in `defaultKeymap` and no `ActionId` covers them.
   W11 must decide whether to add queue actions to `action-id.ts` and the keymap, or render
   the hints as documentation only. Rendering them while nothing handles them would be a
   parity lie.

6. **`responderStatusText` never moved.** 04-UI-SPEC §4.5 expected W02 to relocate it to
   `ui-core/rendering/responder-status.ts`; it lives in `status-segments.ts` instead. Both
   frontends import it from there, so there is no drift — the spec's file path is stale, not
   the behaviour.

## Deviations

None. D-09 through D-12 remain open and unsigned.
