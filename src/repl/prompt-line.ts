import { cursorTo, moveCursor } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";

import { PROMPT } from "../ui/banner.js";
import { isPagerActive } from "../ui/output-pane.js";
import { isCtrlC, isCtrlO, isCtrlP, isCtrlT, isEscape } from "../ui/keys.js";
import {
  getMentionQuery,
  findFileSuggestions,
  type FileSuggestion,
} from "../ui/mentions.js";
import {
  getSlashCommandSuggestions,
  slashCommandFilter,
  slashCommandLabel,
  type SlashCommand,
} from "./slash-commands.js";

export interface KeypressKey {
  ctrl?: boolean;
  meta?: boolean;
  name?: string;
  sequence?: string;
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function fitPlain(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  if (maxWidth === 1) return "…";
  return `${text.slice(0, maxWidth - 1)}…`;
}

export function renderSlashCommandMenu(
  line: string,
  suggestions: SlashCommand[],
  selectedIndex: number,
): string[] {
  const cols = terminalColumns();
  // Stay one column short to avoid terminal autowrap when the cursor lands in
  // the final column. refresh() depends on each menu item occupying one row.
  const maxWidth = Math.max(1, cols - 1);

  if (suggestions.length === 0) {
    return [chalk.dim(fitPlain(`  no commands matching ${line}`, maxWidth))];
  }

  // Cap visible items to leave room in the terminal
  const termRows = process.stdout.rows || 24;
  const maxVisible = Math.max(5, termRows - 4);
  const visible = suggestions.slice(0, maxVisible);

  const maxCommandLength = Math.max(
    ...visible.map((command) => slashCommandLabel(command).length),
  );

  const items = visible.map((command, index) => {
    const markerPlain = index === selectedIndex ? "›" : " ";
    const marker = index === selectedIndex ? chalk.magenta("›") : " ";
    const prefix = `  ${markerPlain} `;
    const labelBudget = Math.max(1, maxWidth - prefix.length);
    const labelWidth = Math.min(maxCommandLength + 2, labelBudget);
    const label = fitPlain(slashCommandLabel(command), labelWidth).padEnd(
      labelWidth,
    );
    const descWidth = Math.max(0, maxWidth - prefix.length - label.length);
    const desc = fitPlain(command.description, descWidth);

    return `  ${marker} ${chalk.cyan(label)}${chalk.dim(desc)}`;
  });

  if (suggestions.length > maxVisible) {
    items.push(
      chalk.dim(
        fitPlain(`  … ${suggestions.length - maxVisible} more`, maxWidth),
      ),
    );
  }

  return items;
}

export function renderFileMentionMenu(
  query: string,
  suggestions: FileSuggestion[],
  selectedIndex: number,
): string[] {
  const cols = terminalColumns();
  const maxWidth = Math.max(1, cols - 1);

  if (suggestions.length === 0) {
    return [chalk.dim(fitPlain(`  no files matching @${query}`, maxWidth))];
  }

  const termRows = process.stdout.rows || 24;
  const maxVisible = Math.max(5, termRows - 4);
  const visible = suggestions.slice(0, maxVisible);

  const items = visible.map((suggestion, index) => {
    const markerPlain = index === selectedIndex ? "›" : " ";
    const marker = index === selectedIndex ? chalk.magenta("›") : " ";
    const prefix = `  ${markerPlain} `;
    const labelBudget = Math.max(1, maxWidth - prefix.length);
    const label = fitPlain(suggestion.label, labelBudget);
    const colored = suggestion.isDir ? chalk.cyan(label) : chalk.white(label);
    return `  ${marker} ${colored}`;
  });

  if (suggestions.length > maxVisible) {
    items.push(
      chalk.dim(
        fitPlain(`  … ${suggestions.length - maxVisible} more`, maxWidth),
      ),
    );
  }

  return items;
}

export function isPrintableSequence(sequence: string | undefined): sequence is string {
  return sequence !== undefined && /^[^\x00-\x1f\x7f]+$/u.test(sequence);
}

function terminalColumns(): number {
  return Math.max(1, process.stdout.columns || 80);
}

function promptCursorPosition(
  line: string,
  cursor: number,
  columns: number,
): {
  row: number;
  col: number;
} {
  const cols = Math.max(1, columns);
  const promptCols = promptColumnsForRender();
  // Walk the buffer up to the cursor, advancing visual row/col. Newlines
  // (from a multi-line paste) move to the next row at column 0; otherwise we
  // wrap when a row fills. The prompt only offsets the very first row.
  let row = 0;
  let col = promptCols < cols ? promptCols : 0;
  const end = Math.max(0, Math.min(cursor, line.length));
  for (let i = 0; i < end; i += 1) {
    if (line[i] === "\n") {
      row += 1;
      col = 0;
      continue;
    }
    col += 1;
    if (col >= cols) {
      row += 1;
      col = 0;
    }
  }
  return { row, col };
}

function promptColumnsForRender(): number {
  return stripAnsi(PROMPT).length;
}

function buildPromptRows(
  line: string,
  columns: number,
  includeCursorRow: boolean,
): string[] {
  const cols = Math.max(1, columns);
  const promptCols = promptColumnsForRender();
  const rows: string[] = [];

  // Split on explicit newlines first (multi-line paste), then wrap each
  // logical line by the terminal width. Only the first logical line carries
  // the prompt prefix; continuation lines start at column 0.
  const logicalLines = line.split("\n");
  logicalLines.forEach((logical, li) => {
    const prefix = li === 0 ? PROMPT : "";
    const prefixCols = li === 0 ? promptCols : 0;
    if (prefixCols >= cols) {
      rows.push(prefix);
      for (let i = 0; i < logical.length; i += cols) {
        rows.push(logical.slice(i, i + cols));
      }
    } else {
      const firstRowCapacity = cols - prefixCols;
      rows.push(prefix + logical.slice(0, firstRowCapacity));
      for (let i = firstRowCapacity; i < logical.length; i += cols) {
        rows.push(logical.slice(i, i + cols));
      }
    }
  });

  if (includeCursorRow) {
    // Pad so the row the cursor will sit on exists even at exact width
    // boundaries or after a trailing newline.
    const cursorRows = promptCursorPosition(line, line.length, cols).row + 1;
    while (rows.length < cursorRows) rows.push("");
  }

  return rows;
}

export async function readPromptLine(options: {
  history: string[];
  onThinkingShortcut: () => void;
  onOutputShortcut: () => Promise<void>;
  onPlanShortcut: () => Promise<void>;
}): Promise<string> {
  return new Promise((resolve) => {
    let line = "";
    let cursor = 0;
    let selectedIndex = 0;
    let menuNavigated = false;
    let dismissedSlashLine: string | null = null;
    let mentionDismissed = false;
    let historyIndex: number | null = null;
    let historyDraft = "";
    let lastCtrlCAt = 0;
    // Bracketed-paste state. When the terminal wraps a paste in
    // paste-start/paste-end markers, we buffer the whole paste (including
    // its embedded newlines) and insert it as literal text — so a multi-line
    // prompt is captured in full instead of the first newline submitting and
    // dropping the rest.
    let pasting = false;
    let pasteBuffer = "";

    // Track which row (relative to prompt start) the cursor is on.
    // Needed to move back up to prompt start when text wraps across rows.
    let promptCursorRow = 0;
    const getMenuState = (): {
      visible: boolean;
      suggestions: SlashCommand[];
    } => {
      const filter = slashCommandFilter(line);
      if (filter === null || dismissedSlashLine === line) {
        return { visible: false, suggestions: [] };
      }
      const suggestions = getSlashCommandSuggestions(line);
      if (selectedIndex >= suggestions.length) selectedIndex = 0;
      return { visible: true, suggestions };
    };

    // File @-mention autocomplete: active when the cursor sits inside an
    // `@partial/path` token. Mutually exclusive with the slash menu (slash
    // requires the line to start with "/" and contain no whitespace).
    const getMentionState = (): {
      visible: boolean;
      query: string;
      start: number;
      suggestions: FileSuggestion[];
    } => {
      if (mentionDismissed || line.startsWith("/")) {
        return { visible: false, query: "", start: 0, suggestions: [] };
      }
      const q = getMentionQuery(line, cursor);
      if (!q) return { visible: false, query: "", start: 0, suggestions: [] };
      const suggestions = findFileSuggestions(q.query);
      if (suggestions.length === 0) {
        return { visible: false, query: q.query, start: q.start, suggestions };
      }
      if (selectedIndex >= suggestions.length) selectedIndex = 0;
      return { visible: true, query: q.query, start: q.start, suggestions };
    };

    const applyMention = (suggestion: FileSuggestion, start: number): void => {
      const before = line.slice(0, start);
      const after = line.slice(cursor);
      let insert = `@${suggestion.value}`;
      let newCursor = before.length + insert.length;
      if (!suggestion.isDir) {
        // Completed a file — add a trailing space and close the menu so the
        // user can keep typing their request.
        insert += " ";
        newCursor = before.length + insert.length;
        mentionDismissed = true;
      } else {
        // Completed a directory — keep the menu open so the user drills in.
        mentionDismissed = false;
      }
      line = before + insert + after;
      cursor = newCursor;
      selectedIndex = 0;
      menuNavigated = false;
      refresh();
    };

    const refresh = (): void => {
      const cols = terminalColumns();
      const menu = getMenuState();
      const mention = menu.visible
        ? {
            visible: false,
            query: "",
            start: 0,
            suggestions: [] as FileSuggestion[],
          }
        : getMentionState();
      const menuLines = menu.visible
        ? renderSlashCommandMenu(line, menu.suggestions, selectedIndex)
        : mention.visible
          ? renderFileMentionMenu(
              mention.query,
              mention.suggestions,
              selectedIndex,
            )
          : [];
      const promptRows = buildPromptRows(line, cols, true);
      const target = promptCursorPosition(line, cursor, cols);
      const blockRows = [...promptRows, ...menuLines];

      // Always redraw the whole prompt block from its anchor. Partial row
      // clearing is fragile once terminal autowrap, slash menus, and cursor
      // movement mix; clearing to the end of screen leaves no stale wrapped
      // prompt/menu rows behind and keeps the cursor anchor stable.
      if (promptCursorRow > 0) {
        moveCursor(output, 0, -promptCursorRow);
      }
      cursorTo(output, 0);
      output.write("\x1b[J");
      output.write(blockRows.join("\n"));

      const currentRow = Math.max(0, blockRows.length - 1);
      const rowDelta = target.row - currentRow;
      if (rowDelta !== 0) {
        moveCursor(output, 0, rowDelta);
      }
      cursorTo(output, target.col);

      promptCursorRow = target.row;
    };

    const editLine = (nextLine: string, nextCursor: number): void => {
      line = nextLine;
      cursor = Math.max(0, Math.min(nextCursor, line.length));
      selectedIndex = 0;
      menuNavigated = false;
      dismissedSlashLine = null;
      mentionDismissed = false;
      historyIndex = null;
      refresh();
    };

    // Insert literal text (e.g. a multi-line paste) at the cursor, preserving
    // newlines so the full pasted prompt is kept and later submitted intact.
    const insertText = (text: string): void => {
      const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      if (!normalized) return;
      line = line.slice(0, cursor) + normalized + line.slice(cursor);
      cursor += normalized.length;
      selectedIndex = 0;
      menuNavigated = false;
      dismissedSlashLine = null;
      mentionDismissed = false;
      historyIndex = null;
      refresh();
    };

    const cleanup = (restoreInput = false): void => {
      input.off("keypress", handleKeypress);
      // Leave bracketed-paste mode so the terminal isn't left in a special
      // state during tool execution or after exit.
      if (input.isTTY) output.write("\x1b[?2004l");
      if (restoreInput) {
        input.pause();
        if (input.isTTY) input.setRawMode(false);
      }
    };

    const clearPromptDisplay = (): void => {
      // Move back to prompt start
      if (promptCursorRow > 0) {
        moveCursor(output, 0, -promptCursorRow);
      }
      cursorTo(output, 0);
      output.write("\x1b[J");
      promptCursorRow = 0;
    };

    const submit = (submittedLine: string): void => {
      line = submittedLine;
      cursor = line.length;
      // Move back to prompt start
      if (promptCursorRow > 0) {
        moveCursor(output, 0, -promptCursorRow);
      }
      cursorTo(output, 0);
      output.write("\x1b[J");

      // Write final prompt using the same wrapping rules as refresh(), then
      // move to the next line. Do not include the extra cursor-only row used
      // for interactive editing at exact terminal-width boundaries.
      output.write(buildPromptRows(line, terminalColumns(), false).join("\n"));
      output.write("\n");
      promptCursorRow = 0;

      cleanup();
      resolve(submittedLine);
    };

    function handleKeypress(sequence: string, key: KeypressKey): void {
      // The alt-screen pager owns the terminal while open; ignore everything
      // here so the user's navigation keys don't bleed into the input line.
      if (isPagerActive()) return;

      // ── Bracketed paste ───────────────────────────────────────────────
      // The terminal brackets a paste with paste-start / paste-end markers.
      // Buffer everything in between (including embedded newlines) and insert
      // it literally, so a long multi-line prompt is captured in full and the
      // first newline does not submit early.
      if (key?.name === "paste-start") {
        pasting = true;
        pasteBuffer = "";
        return;
      }
      if (key?.name === "paste-end") {
        pasting = false;
        const pasted = pasteBuffer;
        pasteBuffer = "";
        if (pasted) insertText(pasted);
        return;
      }
      if (pasting) {
        if (key?.name === "return" || key?.name === "enter") {
          pasteBuffer += "\n";
        } else if (key?.name === "tab") {
          pasteBuffer += "\t";
        } else if (isPrintableSequence(sequence)) {
          pasteBuffer += sequence;
        }
        return;
      }

      const menu = getMenuState();
      const mention = menu.visible
        ? {
            visible: false,
            query: "",
            start: 0,
            suggestions: [] as FileSuggestion[],
          }
        : getMentionState();

      // Cmd+C on macOS terminals is handled by the OS (it never reaches us),
      // but some Linux terminals forward Meta+C. Treat that as a no-op so
      // selecting + copying never breaks the REPL.
      if (key.meta && !key.ctrl && key.name === "c") return;

      if (isCtrlC(key)) {
        // First press: clear the current line. Second press within 1s: exit.
        // This mirrors bash / Claude Code and avoids killing the REPL by
        // accident when users habitually press Ctrl+C to copy in some
        // terminals.
        const now = Date.now();
        if (line.length > 0) {
          editLine("", 0);
          lastCtrlCAt = now;
          return;
        }
        if (now - lastCtrlCAt < 1_000) {
          cleanup(true);
          output.write("\n");
          process.exit(0);
        }
        lastCtrlCAt = now;
        output.write("\n");
        output.write(chalk.dim("  (press Ctrl+C again to exit)\n"));
        output.write(PROMPT);
        return;
      }

      if (isCtrlT(key)) {
        options.onThinkingShortcut();
        refresh();
        return;
      }

      if (isCtrlO(key)) {
        clearPromptDisplay();
        output.write("\n");
        void options.onOutputShortcut().finally(refresh);
        return;
      }

      if (isCtrlP(key)) {
        clearPromptDisplay();
        output.write("\n");
        void options.onPlanShortcut().finally(refresh);
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        if (mention.visible && mention.suggestions.length > 0) {
          applyMention(
            mention.suggestions[selectedIndex] ?? mention.suggestions[0]!,
            mention.start,
          );
          return;
        }
        const useSelection = menu.visible && (line !== "/" || menuNavigated);
        const selectedCommand = useSelection
          ? menu.suggestions[selectedIndex]
          : undefined;
        submit(selectedCommand?.command ?? line);
        return;
      }

      if (key.name === "tab") {
        if (mention.visible && mention.suggestions.length > 0) {
          applyMention(
            mention.suggestions[selectedIndex] ?? mention.suggestions[0]!,
            mention.start,
          );
          return;
        }
        if (menu.visible && menu.suggestions.length > 0) {
          const target =
            menu.suggestions[selectedIndex] ?? menu.suggestions[0]!;
          editLine(target.command, target.command.length);
        }
        return;
      }

      if (isEscape(key)) {
        if (mention.visible) {
          mentionDismissed = true;
          refresh();
          return;
        }
        if (menu.visible) {
          dismissedSlashLine = line;
          refresh();
        }
        return;
      }

      if (key.name === "up") {
        if (mention.visible && mention.suggestions.length > 0) {
          selectedIndex =
            (selectedIndex - 1 + mention.suggestions.length) %
            mention.suggestions.length;
          menuNavigated = true;
          refresh();
          return;
        }
        if (menu.visible && menu.suggestions.length > 0) {
          selectedIndex =
            (selectedIndex - 1 + menu.suggestions.length) %
            menu.suggestions.length;
          menuNavigated = true;
          refresh();
          return;
        }
        if (options.history.length > 0) {
          if (historyIndex === null) {
            historyDraft = line;
            historyIndex = options.history.length - 1;
          } else {
            historyIndex = Math.max(0, historyIndex - 1);
          }
          line = options.history[historyIndex] ?? "";
          cursor = line.length;
          selectedIndex = 0;
          dismissedSlashLine = null;
          refresh();
        }
        return;
      }

      if (key.name === "down") {
        if (mention.visible && mention.suggestions.length > 0) {
          selectedIndex = (selectedIndex + 1) % mention.suggestions.length;
          menuNavigated = true;
          refresh();
          return;
        }
        if (menu.visible && menu.suggestions.length > 0) {
          selectedIndex = (selectedIndex + 1) % menu.suggestions.length;
          menuNavigated = true;
          refresh();
          return;
        }
        if (historyIndex !== null) {
          if (historyIndex < options.history.length - 1) {
            historyIndex += 1;
            line = options.history[historyIndex] ?? "";
          } else {
            historyIndex = null;
            line = historyDraft;
          }
          cursor = line.length;
          selectedIndex = 0;
          dismissedSlashLine = null;
          refresh();
        }
        return;
      }

      if (key.name === "left") {
        if (cursor > 0) {
          cursor -= 1;
          refresh();
        }
        return;
      }

      if (key.name === "right") {
        if (cursor < line.length) {
          cursor += 1;
          refresh();
        }
        return;
      }

      if (key.name === "home" || (key.ctrl && key.name === "a")) {
        cursor = 0;
        refresh();
        return;
      }

      if (key.name === "end" || (key.ctrl && key.name === "e")) {
        cursor = line.length;
        refresh();
        return;
      }

      if (key.name === "backspace") {
        if (cursor > 0) {
          editLine(line.slice(0, cursor - 1) + line.slice(cursor), cursor - 1);
        }
        return;
      }

      if (key.name === "delete") {
        if (cursor < line.length) {
          editLine(line.slice(0, cursor) + line.slice(cursor + 1), cursor);
        }
        return;
      }

      if (key.ctrl && key.name === "u") {
        editLine(line.slice(cursor), 0);
        return;
      }

      if (key.ctrl && key.name === "k") {
        editLine(line.slice(0, cursor), cursor);
        return;
      }

      if (isPrintableSequence(sequence) && !key.ctrl && !key.meta) {
        editLine(
          line.slice(0, cursor) + sequence + line.slice(cursor),
          cursor + sequence.length,
        );
      }
    }

    output.write(PROMPT);
    if (input.isTTY) {
      input.setRawMode(true);
      // Enable bracketed paste so multi-line pastes arrive as one chunk
      // (wrapped in paste-start/paste-end) instead of submitting at the
      // first embedded newline.
      output.write("\x1b[?2004h");
    }
    input.resume();
    input.on("keypress", handleKeypress);
  });
}
