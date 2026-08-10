# Input Architecture

## 1. Why we own the bytes

Ink's `useInput` is not usable for this product. The table below was measured on Ink 6.3.1
during the earlier attempt. Ink 7 is a major release, so W00 spike **S5** must re-verify every
row on `ink@7.1.1` before the decoder is written. The conclusion is unlikely to change —
these are gaps in Ink's input layer, not bugs — but do not assume it.

| Input | What Ink reports | What we need |
|---|---|---|
| `\x1b[13;2u` (CSI-u Shift+Enter) | literal text `[13;2u` | `shift+enter` |
| `0x0A` (Ctrl+J) | text `\n`, every flag false | `ctrl+j` |
| `0x08` (Ctrl+H) | `backspace: true`, no ctrl flag | `ctrl+h` |
| `0x7F` | `delete: true` | `backspace` |
| `\x1b[<0;10;5M` (SGR mouse) | literal text `[<0;10;5M` | a mouse event, or nothing |
| `\x1b\r` (Alt+Enter) | `escape` then `return`, two events | `alt+enter` |
| bracketed paste | interleaved key events | one `PasteEvent` |

`useInput` is therefore forbidden. `classic/input/raw-decoder.ts` is the only stdin
consumer in the classic tree. Ink is mounted with `stdin: process.stdin` so it manages raw
mode consistently, but because no component calls `useInput`, Ink never competes for bytes.
A test asserts that no file under `src/classic` imports `useInput`.

## 2. Pipeline

```
process.stdin  (raw mode, utf8)
      │
      ▼
classic/input/raw-decoder.ts        bytes → DecodedEvent[]
      │
      ├── PasteEvent  ─────────────► composer / secret buffer only
      ├── MouseEvent  ─────────────► input-router (dropped when mouse is off)
      └── KeyEvent
              │
              ▼
      classic/input/chord-from-key.ts        KeyEvent → chord
              │
              ▼
      ui-core/actions/chord.ts               normalizeChord
              │
              ▼
      ActionRouter.resolve(chord, focus.activeContext())
              │
              ├── ActionId  ───────► classic/app/action-handlers.ts
              └── undefined  ──────► text insertion, if the context accepts text
```

`classic/input/input-router.ts` owns step ordering, the double-press windows, and the
"who gets this key" decision. It is a plain class with injected dependencies
(`focus`, `router`, `onAction`, `onKey`, `onPaste`, `onMouse`) so it is testable without a
terminal.

## 3. Decoder contract

```ts
type DecodedEvent =
  | { readonly type: "key"; readonly key: KeyEvent }
  | { readonly type: "paste"; readonly text: string }
  | { readonly type: "mouse"; readonly event: MouseEvent };

interface KeyEvent {
  readonly name: string;      // "a" | "enter" | "up" | "f5" | "backspace" | …
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly text: string;      // printable payload, "" for pure control keys
}
```

Rules:

1. **Stateful and chunk-safe.** stdin delivers arbitrary chunk boundaries. The decoder
   keeps a pending buffer and never emits a partial sequence. A sequence split across two
   chunks must decode identically to the same bytes in one chunk — fuzz-tested.
2. **Escape disambiguation.** A lone `\x1b` with nothing following within 25 ms is
   `escape`. `\x1b` followed by a printable byte is `alt+<byte>`. `\x1b[`, `\x1bO`, and
   `\x1b]` start CSI / SS3 / OSC parsing.
3. **Bracketed paste.** `\x1b[200~` opens, `\x1b[201~` closes. Everything between is one
   `PasteEvent`, with `\r` normalized to `\n` and every C0 control except `\n` and `\t`
   stripped. A paste never produces key events and never resolves to an action. An
   unterminated paste at 1 MiB or 250 ms flushes what it has and logs a warn notice.
4. **Claim raw control bytes before text.** `0x0A` → `ctrl+j`, `0x08` → `ctrl+h`,
   `0x7F` → `backspace`, `0x09` → `tab`, `0x0D` → `enter`, `0x03` → `ctrl+c`,
   `0x01`–`0x1A` → `ctrl+<letter>` for the rest.
5. **CSI-u.** `\x1b[<code>;<mods>u` decodes to the key for `code` with modifiers from
   `mods - 1` as a bitmask (1 shift, 2 alt, 4 ctrl, 8 meta). This is the only reliable
   Shift+Enter on kitty, ghostty, WezTerm, and foot.
6. **SGR mouse.** `\x1b[<b;x;yM|m` parsed in `sgr-mouse.ts` into
   `{ button, x, y, release, ctrl, alt, shift }`. When mouse reporting is off, parse and
   **discard** — the sequence must still be consumed so it cannot leak into a buffer.
7. **Unknown sequences are dropped silently.** Never fall through to text. This is the
   invariant that keeps escape noise out of prompts and secrets.
8. **Grapheme-safe text.** Multi-byte UTF-8 and combining sequences arrive as whole
   strings in `text`. Never split a code point across events.

Fuzz target in `test/classic/input/raw-decoder.fuzz.test.ts` with `fast-check`: for any
random byte string, the decoder must not throw, must not emit a `KeyEvent` whose `text`
contains `\x1b`, and must consume every byte it accepted.

## 4. Chord mapping

`chord-from-key.ts` produces the chord string that `defaultKeymap` already expects.
Normalization matches `ui-core/actions/chord.ts`: modifier order `ctrl+alt+shift+meta`,
lowercase key.

| `KeyEvent` | Chord |
|---|---|
| `name: "a"` | `a` |
| `name: "A"` or `shift` with a letter | `shift+a` |
| `ctrl` + `c` | `ctrl+c` |
| `alt` + `enter` | `alt+enter` |
| `name: "return"` \| `"kpenter"` | `enter` |
| `name: "linefeed"` | `ctrl+j` |
| `name: "backtab"` | `shift+tab` |
| `name: "escape"` | `escape` |
| arrows | `up` `down` `left` `right` |
| `pageup` / `pagedown` / `home` / `end` / `insert` / `delete` | same names |
| function keys | `f1`…`f12` |

macOS Option is reported as `alt`. The Command key is `meta` and is **not** bound to any
action — Terminal.app and iTerm2 both intercept most Cmd chords, and binding them would be
unreliable.

`test/classic/input/chord-table.test.ts` is table-driven over every binding in
`defaultKeymap`: for each `(chord, context, action)` triple, synthesize the `KeyEvent` that
produces that chord and assert `ActionRouter.resolve` returns the expected action. The test
enumerates `defaultKeymap` itself, so a new binding without a decoder path fails the build.

## 5. Newline chord and its platform fallback

Submitting versus inserting a newline is the single most platform-sensitive interaction.

| Terminal | Newline chord | Detection |
|---|---|---|
| kitty, ghostty, WezTerm, foot | `shift+enter` via CSI-u | `capabilities.kittyKeyboard` |
| iTerm2, Terminal.app, most xterm | `alt+enter` | fallback |
| Windows Terminal | `alt+enter` — verify `shift+enter` in W05 on a real runner | fallback until proven |
| legacy conhost | `alt+enter` | fallback |

Both `shift+enter` and `alt+enter` are bound to `editor.newline` in `defaultKeymap`
already, so no keymap change is needed. What must adapt is the **hint**: the composer meta
row shows `⇧⏎ newline` only when `capabilities.canDistinguishShiftEnter` is true, otherwise
`⌥⏎ newline`, and on Windows `alt+⏎ newline`. Reuse
`capabilities.canDistinguishShiftEnter`; do not add a second detector.

`ctrl+j` stays bound to `app.jobs`, matching OpenTUI. The legacy REPL's Ctrl+J-as-newline
behaviour is deliberately not restored.

## 6. Focus routing and key ownership

`FocusController.activeContext()` returns `overlay ?? region`. Exactly one surface owns a
key. `input-router.ts` resolves ownership in this order, and each step either consumes the
event or explicitly passes it on:

1. **Paste** → the focused text surface (composer or secret buffer). If neither is
   focused, drop it and toast `paste ignored · focus the input first`.
2. **Mouse** → mouse handling (§8) or discard.
3. **Blocking overlay** (`secret`, `confirm`, `scope-editor`, `keys-editor`): only
   `escape` and `ctrl+c` escalate to the global ladder; everything else goes to the panel.
   This mirrors `App.tsx`'s precedence exactly, including the reason it exists — a stuck
   sudo prompt must never be able to block exit.
4. **Non-blocking overlay** (`picker`, `pager`, `jobs`, `prompt-actions`,
   `transcript-search`): the panel gets the key. `TRAPPING_CONTEXTS` in `ActionRouter`
   already prevents an unbound chord from firing a global action, so no extra guard is
   needed.
5. **Context-limit editing**: swallow everything except `ctrl+c`.
6. **`escape` with transcript focus and no selection**: escalate to the global cancel
   ladder. This is the OpenTUI workaround for `selection.clear` shadowing `app.cancel` and
   must be reproduced.
7. **`tab` with composer focus**: belongs to the completion menu, never to
   `focus.next-region`.
8. **Resolve** the action for `(chord, context)` and dispatch.
9. **Unresolved** and the context accepts text: insert into the focused buffer.

## 7. Double-press ladders

Timings are copied from OpenTUI, not re-chosen:

| Constant | Value | Meaning |
|---|---|---|
| `CTRL_C_QUIT_WINDOW_MS` | 1500 | second Ctrl+C within the window exits |
| `ESC_CANCEL_WINDOW_MS` | 1500 | second Esc within the window cancels all work |
| `ESC_SAME_PRESS_MS` | 80 | collapses one physical Esc reaching two handlers |
| `SIGINT_QUIT_WINDOW_MS` | 1500 | already in `RendererLifecycle` |

Ctrl+C: dismiss any blocking prompt; if a turn is running, abort it and arm quit; if
already armed within the window, `requestExit()`. Idle: first press arms with the toast
`Ctrl+C again to exit`, second exits.

Esc: first press dismisses a blocking prompt or arms cancellation, showing
`esc again to cancel`; second press within the window calls `session.cancelAll()`, which
covers the live turn, compaction, the queue, and every session-owned responder job. Arming
auto-clears on turn end and when the jobs subscription reports no remaining work — both
already implemented in `App.tsx` and to be reproduced in `classic/app/app-wiring.ts`.

`test/classic/input/double-press.test.ts` uses a fake clock and asserts the exact
controller calls for: abort-then-exit, idle-arm-then-exit, arm-then-timeout-then-single,
Esc-with-blocking-prompt, Esc-with-queue-only, and one physical Esc reaching two handlers
inside 80 ms.

## 8. Mouse policy

Mouse reporting is **off by default**. `CLAI_CLASSIC_MOUSE=1` opts in, and only when
`stdin.isTTY` and `TERM !== "dumb"`.

Rationale: enabling `?1000h/?1002h/?1006h` takes native text selection away from the user.
In a scrollback feed, native selection is how copying works. Losing it to gain wheel
scrolling of a region that the terminal already scrolls is a bad trade.

When enabled, the only behaviours are:

- wheel over the live tail → scroll the live tail if it is internally clipped
- wheel over a panel → move that panel's window
- click on a panel row → select it
- everything else ignored; no drag, no hover, no click-through to committed rows

`SelectionController` receives no mouse input in classic. Its drag API stays unused, its
`selectAll`/`copy`/`extend` API stays used. This is deviation D-03.

## 9. Secret input safety

- Bytes go from the decoder straight into `ui-core/composer/secret-buffer.ts`. No React
  state, no props, no context ever holds the plaintext.
- Only `answerSecret` moves the value out, once, to the resolver.
- Paste into a secret panel is decoded, ANSI-stripped, and control-stripped first.
- A mouse report, an unknown escape, or a function key can never reach the buffer —
  the decoder drops them before routing (§3 rule 7).
- `test/classic/panels/secret.test.ts` asserts the plaintext appears in no captured frame,
  no log write, and no thrown error message.

## 10. Windows verification requirements

These cannot be verified on macOS and are W05 gates on a real Windows runner:

- Windows Terminal: `shift+enter`, `alt+enter`, `shift+tab`, `ctrl+h`, `ctrl+j`, `ctrl+o`,
  `ctrl+t`, `ctrl+g`, `ctrl+p`, `ctrl+r`, `escape`, `ctrl+c`.
- PowerShell host and cmd.exe/conhost: the same list, plus confirmation that
  `capabilities.unicode` correctly reports false on legacy conhost.
- VS Code integrated terminal on Windows.
- Bracketed paste of a 500-line block in each host.
- Resize during a running turn in each host.

Each result is recorded as a fixture in `test/classic/input/fixtures/windows/*.json` and
replayed by the decoder tests, so the finding survives without a Windows machine in CI.
