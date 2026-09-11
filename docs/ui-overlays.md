# Pickers and pagers

Classic and OpenTUI use almost the full terminal for option pickers and output
pagers. The outer margin is two columns and one row on normal terminals, shrinking
on smaller terminals. Measurements are terminal cells, not pixels. The `/`
completion menu remains compact and keeps its existing layout.

Option labels and descriptions wrap instead of disappearing on narrow terminals.
Use Up/Down to select an option, Page Up/Page Down to scroll, and Left/Right to
scroll a single wrapped row. This also exposes descriptions taller than the entire
viewport. Home/End selects the first/last option. Enter accepts; Escape dismisses.
Typing filters options. History retains its resume and row-action shortcuts.

Pager bodies wrap complete command strings and output. Use Up/Down or Page Up/Page
Down to scroll and Home/End to jump. Search, copy, format/raw, export, and live-follow
shortcuts remain available. Each hint appears once; small terminals condense the
chrome to leave room for content. Extremely short terminals hide headers and
footers, but keyboard actions continue to work.

OpenTUI notifications use the outer margin instead of covering an expanded picker
or pager. Terminals without a spare outer row suppress the notification overlay
while these panels are open.

## Orchestration options

`/orchestration`, `/orchestrator`, and `/orchastrator` open the same described options
in both renderers:

- **Status** reports the session setting without changing it. It is the initially
  selected option, so opening the picker and pressing Enter never enables agents.
- **On** explicitly permits read-only delegation for this session.
- **Off** stops active children and prevents new starts and restarts.

The explicit `on`, `off`, and `status` arguments continue to work. Escape makes no
change, and a picker from an old session cannot enable orchestration in a new one.
This UI does not give the main agent permission to enable itself.

## Subagent inspection

`/agents` opens the live inspector. File reads show the tool name, filename, and
requested options such as offset and limit instead of dumping file contents.
Tool failures remain visible, and successful calls receive a completion marker.
The worker retains bounded tool evidence for its research; the compact display
does not remove that evidence from its model conversation.

Reports render once as Markdown. Partial reports are labeled unfinished, and the
inspector distinguishes an exact in-memory conversation checkpoint from recovery
using retained redacted history. Switching agents or closing the inspector does
not cancel the main turn. OpenTUI notifications use the top margin while an
expanded picker or pager is open, so they do not cover controls or report text.
