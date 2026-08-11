# W05 — Input (record)

We own the bytes. `src/classic/input/raw-decoder.ts` is the only stdin consumer, asserted by
`test/classic/architecture.test.ts`; `useInput` appears nowhere in the tree.

## Files

| File | Owns |
|---|---|
| `terminal-sequences.ts` | every literal sequence, key table, modifier bitmask, and timing constant |
| `key-event.ts` | `KeyEvent`, `MouseEvent`, `DecodedEvent` |
| `raw-decoder.ts` | bytes → `DecodedEvent[]`, stateful and chunk-safe |
| `paste-decoder.ts` | paste sanitisation (ANSI strip, CR→LF, C0 strip) |
| `sgr-mouse.ts` | `\x1b[<b;x;yM\|m` → `MouseEvent` |
| `chord-from-key.ts` | `KeyEvent` → chord, via `ui-core/actions/chord.ts` |
| `cancel-ladder.ts` | the Ctrl+C and Esc double-press ladders |
| `input-router.ts` | the nine-step ownership order |

`cancel-ladder.ts` is one addition to the roadmap's file list. The ladders need controller
calls (`session.abort`, `session.cancelAll`, `overlay.cancelBlockingPrompt`, `requestExit`)
and a clock, and W11's action handlers must reach the same implementation for
`app.interrupt`/`app.cancel`. Keeping it in `input-router.ts` would have made one file own
both ordering and policy.

## Decoder rules, each with a test

| Rule (05-INPUT §3) | Behaviour | Test |
|---|---|---|
| 1 stateful, chunk-safe | exhaustive split-point equality for every real sequence | `raw-decoder.test.ts`, fuzz |
| 2 escape disambiguation | lone `\x1b` resolves only on `flush()`; `\x1b`+printable → alt; `\x1b\x1b[A` → alt+up | `raw-decoder.test.ts` |
| 3 bracketed paste | one event, CR→LF, C0 stripped, 1 MiB / idle-timeout guard | `paste.test.ts` |
| 4 raw control bytes | `0x0A`→ctrl+j, `0x08`→ctrl+h, `0x7F`→backspace, `0x09`→tab, `0x0D`→enter, `0x01`–`0x1A`→ctrl+letter | `raw-decoder.test.ts` |
| 5 CSI-u | `\x1b[13;2u` → shift+enter, sub-parameters tolerated | `raw-decoder.test.ts` |
| 6 SGR mouse | parsed always, emitted only when mouse is on, never leaked | `sgr-mouse.test.ts` |
| 7 unknown dropped | unknown CSI finals, OSC, DCS all consumed and discarded | `raw-decoder.test.ts` |
| 8 grapheme safety | combining marks and emoji ZWJ/skin-tone stay in one event | `raw-decoder.test.ts` |

`chord-table.test.ts` enumerates `defaultKeymap` — 44 unique chords, 76 bindings — and for
each one synthesizes the terminal bytes, decodes them, and asserts both
`chordFromKey(...) === chord` and `ActionRouter.resolve(chord, context) === action`. A new
binding without a decoder path fails the build.

## Ownership order, as implemented

`InputRouter.handle` follows 05-INPUT §6 exactly: paste → mouse → blocking overlay
(`secret`, `modal`; only `escape`/`ctrl+c` escalate) → non-blocking overlay
(`picker`, `pager`, `jobs`, `transcript-search`) → context-limit editing → `escape` on
transcript focus with no selection → `tab` with composer focus → resolve → text insertion.

Text insertion is additionally gated on the context not being an overlay. Without that
gate, an unresolved printable key inside a picker was inserted into the composer draft
behind the overlay. `onPanelKey` carries it to the panel instead, which is where picker
filter text belongs.

## Ladder constants

`CTRL_C_QUIT_WINDOW_MS` 1500, `ESC_CANCEL_WINDOW_MS` 1500, `ESC_SAME_PRESS_MS` 80 — copied
from `src/tui-v2/app/App.tsx`, not re-chosen. The ladder is timer-free: armed state is
derived from an injected clock, so `double-press.test.ts` drives all six required scenarios
with a fake clock and no fake timers.

## Verification

| Command | Result |
|---|---|
| `npx vitest run test/classic` | 15 files / 268 passed, 10 skipped (Windows fixtures) |
| `npx vitest run test/classic/input/raw-decoder.fuzz.test.ts` | green; 10,000 runs on the main property |
| `npm run typecheck` | clean |

## Findings that change later packages

1. **Grapheme clustering is chunk-dependent, and that is correct.** A combining mark that
   arrives in a later stdin read is a later keystroke, so byte-for-byte event equality
   across arbitrary chunk splits is not achievable — the fuzz test asserts the decoded
   *payload* is identical instead, plus exact event equality for escape sequences and
   pastes. Holding the trailing grapheme back would delay every keystroke by one read.
2. **The escape timer belongs to the caller.** `RawDecoder` exposes `pendingDeadline` and a
   `flush()`; it starts no timers. W11 must schedule a single `setTimeout` to
   `pendingDeadline` after each `push` so a lone Esc resolves after 25 ms.
3. **Unterminated paste uses an idle timeout, not an absolute one.** 05-INPUT §3 says "250 ms";
   measured against paste *start* that would split a slow multi-megabyte paste. It is
   measured from the last received byte instead, which still bounds a truly unterminated
   paste and keeps a 500-line paste as one event.
4. **`ctrl+shift+<letter>` only exists over CSI-u.** Legacy encodings cannot express it, so
   `ctrl+shift+x`, `ctrl+shift+c`, `ctrl+shift+s`, `ctrl+shift+e` and `shift+n` reach us
   only on kitty-protocol terminals. The keymap already binds unshifted `ctrl+s`/`ctrl+e`
   aliases in the pager; W09's status hints must not promise the shifted forms when
   `capabilities.kittyKeyboard` is false.
5. **Windows fixtures are placeholders and their tests skip, not pass.**
   `test/classic/input/fixtures/windows/*.json` carry `recorded: false` plus the full §10
   chord checklist; `windows-fixtures.test.ts` asserts the checklist shape now and replays
   bytes once W17 records them. Flipping `recorded` to `true` activates 2 tests per host.
