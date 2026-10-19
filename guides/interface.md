# Terminal interface

[← Back to README](../README.md)

OpenTUI is selected by default on macOS and Linux when the terminal is at least 60 columns by 14 rows and the runtime is available. Windows and smaller terminals use Classic, which runs on React and Ink. `clai --classic` selects Classic explicitly; `clai --tui` requests OpenTUI with a Classic fallback when unavailable.

Both interfaces provide streaming chat, tool output, plans, session history, and provider controls.

## Terminal compatibility and recommendations

Choose a terminal for the OS on your local device. These recommendations link to each terminal's official setup information:

| Local OS | Recommended terminal | Alternatives |
| --- | --- | --- |
| Linux | [Kitty](https://sw.kovidgoyal.net/kitty/binary/) | [WezTerm](https://wezterm.org/installation.html) or [Alacritty](https://alacritty.org/). |
| macOS | [iTerm2](https://iterm2.com/) | [Kitty](https://sw.kovidgoyal.net/kitty/binary/), [WezTerm](https://wezterm.org/installation.html), or [Alacritty](https://alacritty.org/); the built-in Terminal app is also an option. |
| Windows | [Windows Terminal](https://learn.microsoft.com/en-us/windows/terminal/) | [WezTerm](https://wezterm.org/installation.html) or [Alacritty](https://alacritty.org/). |

clai selects its interface using the OS where it runs. Native Windows uses Classic; WSL and SSH sessions on a Linux host use the Linux interface selection, even when the local window is Windows Terminal or iTerm2. Over SSH, key, mouse, and clipboard capabilities come from your local terminal and any intervening multiplexer.

Standard terminals can handle ordinary text input and output. Modified keys, mouse motion/hover, and clipboard integration vary by terminal and configuration. In Classic with mouse reporting enabled, click a visible composer row to position the cursor, including wrapped lines and Unicode graphemes; transcript clicks and scrolling leave typing in the composer. The Classic composer spans the original transcript-shell width and shares the startup card's aqua border color. Scrolling does not display a scrollbar. If `Shift+Enter` is not distinguishable from `Enter`, use `Ctrl+N` or `Alt+Enter` for a newline. Use `clai --classic` if OpenTUI cannot start, and `F5` or `/redraw` to repaint a scrambled screen.

Large pastes collapse into a line or character count inside the composer while retaining the full text for submission. In both interfaces, place the cursor near a shortened block and press `Ctrl+E` to expand just that block for editing. `Alt+E` also works. When no shortened block is present, `Ctrl+E` moves to the end of the current line. In OpenTUI, hovering over an inline placeholder opens a preview that stays visible while the pointer remains inside the composer; double-clicking the placeholder or preview also expands it. Pasted transcripts remain one draft, including when a terminal sends unbracketed text in bursts over SSH. Press `Enter` after the paste has finished to submit it.

Type `/` at the start of the draft or after a space to browse commands. Use the arrow keys to select, `Tab` to complete, and `Enter` to run the command. A leading command retains its arguments, such as `/model model-name`; an inline command runs while preserving the surrounding draft. Completed commands also run after the suggestion menu is dismissed. Unknown leading commands show a local warning, and paths such as `/tmp/notes.txt` remain ordinary prompts.

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Send prompt | `Enter` |
| Insert newline | `Shift+Enter`, `Alt+Enter`, or `Ctrl+N` |
| Expand shortened paste nearest the cursor | `Ctrl+E` or `Alt+E` |
| Cancel current turn | `Esc` |
| Interrupt; press again to quit | `Ctrl+C` |
| Cycle mode | `Shift+Tab` |
| Toggle plan pane / details | `Ctrl+H` / `Ctrl+P` |
| Show / hide queued-message blocks (Classic) | `Ctrl+Z` |
| Background jobs | `Ctrl+J` |
| Expand thinking / tool output | `Ctrl+T` / `Ctrl+O` |
| Return to the latest transcript content | `Ctrl+D` or click the contextual **Jump to latest** control |
| Search transcript when focused | `Ctrl+R` |
| Repaint screen | `F5` or `/redraw` |
| Help / full shortcut reference | `Ctrl+G` / `/shortcuts` |

Type `/` for command suggestions and `@` for file mentions. Terminal support affects which modified key combinations are available; `/shortcuts` lists bindings by context.

Both UIs show the paste shortcut inside shortened-text brackets, for example `[1200 chars pasted #1 · Ctrl+E]`. Expansion and submission restore the original pasted content, without the label. When the transcript is away from its latest content, a clickable **Jump to latest** control appears to the right of the task/queue hints. Clicking it restores automatic following; it disappears when the latest content is visible.

In Classic, `Ctrl+Z` hides or restores the queued-message blocks above the composer. On macOS, use Control rather than Command; no Option-key configuration is needed. `Alt+Q` remains a compatibility alias. The queue count and hidden state appear immediately to the right of the `Ctrl+H` tasks hint. Hiding does not remove, pause, or alter queued messages; selection, send-now, edit, and drop shortcuts still work. Tool headers use the OpenTUI state colors, with cyan inputs and light-blue outputs.

Classic transcripts show shell calls as **Shell**, file reads as **Explored** with option-free file lists, and edits as numbered red/green diffs. Inputs stay on one line; output previews show the first three lines, using the available terminal width. Tool timers match the composer `ctx` color and expansion controls use a subdued shade. Purple **Thinking** shows the complete wrapped stream without expansion controls or `Ctrl+T`. When streaming finishes, **Reasoning** honors the selected collapsed or expanded state, with timing, disclosure, and `Ctrl+T` together on the header. Click **+ click to expand** to reveal an item's complete stored input/output and **- click to collapse** to collapse it again. No external app is required. On terminals without mouse support, `Ctrl+O` toggles tool output, `Ctrl+T` toggles reasoning, and `Enter` toggles the last visible item while the transcript is focused (`Tab`). Saved output is loaded on expansion; exceptionally large artifacts use the clickable **+ full output** built-in paged viewer rather than exhausting terminal memory.

OpenTUI tool-output previews also show only their first three lines; `Ctrl+O` expands them and the full-output pager remains available. Structured file lists and diffs retain their dedicated presentation.

In OpenTUI, task titles and statuses keep their original colors and formatting while extra information starts collapsed. Click the small shaded `+` / `−` button immediately after a task title, or use **Expand all** / **Collapse all** beside the progress bar. Buttons center their glyphs and change background on hover or keyboard focus without brackets or underlines; mouse clicks leave no persistent highlight. Expanded information keeps the original muted text without added fields or headers; controls follow the end of wrapped titles in narrow panes. Scrolling keeps wrapped titles together when they fit the viewport, and keyboard selection reveals the whole title without unrelated progress updates moving your reading position. With the task pane focused, `↑` / `↓` select a task, `Enter` toggles its details, `→` / `←` expand or collapse it, `E` / `C` expand or collapse all, and `PageUp` / `PageDown` scroll. `Ctrl+P` still opens the full plan view.
