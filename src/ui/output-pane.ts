import { readFile } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import { isCtrlC, isCtrlO, isEscape } from "./keys.js";

export interface OutputViewport {
  /** Display name for the tool (e.g. "shell.exec", "nmap"). */
  toolName: string;
  /** Short args display (e.g. the command line). */
  argsDisplay: string;
  /** Path to the raw artifact file on disk (if present). */
  artifactPath?: string | undefined;
  /** AI-facing reduced summary shown to the user as well. */
  summary: string;
  /** Whether the user has expanded the full output via Ctrl+O / /output. */
  expanded: boolean;
  /** Timestamp the viewport was registered (for /output last). */
  createdAt: number;
  /** Unique id; users can refer to it via /output <id>. */
  id: string;
}

let viewportCounter = 0;
const viewports = new Map<string, OutputViewport>();
let lastViewportId: string | undefined;
let pagerActive = false;

/** True while the alt-screen pager owns the terminal. The REPL prompt
 *  inspects this so its own keypress handler ignores nav keys while the
 *  pager is open (otherwise `j` etc would be inserted into the input). */
export function isPagerActive(): boolean {
  return pagerActive;
}

export function newViewportId(toolName: string): string {
  viewportCounter += 1;
  return `${toolName.replace(/\W+/g, "-")}-${viewportCounter}`;
}

export function registerViewport(
  partial: Omit<OutputViewport, "id" | "expanded" | "createdAt"> & { id?: string | undefined },
): OutputViewport {
  const id = partial.id ?? newViewportId(partial.toolName);
  const v: OutputViewport = {
    ...partial,
    id,
    expanded: false,
    createdAt: Date.now(),
  };
  viewports.set(id, v);
  lastViewportId = id;
  return v;
}

export function getViewport(id: string): OutputViewport | undefined {
  return viewports.get(id);
}

export function getLastViewport(): OutputViewport | undefined {
  if (!lastViewportId) return undefined;
  return viewports.get(lastViewportId);
}

export function listViewports(): OutputViewport[] {
  return [...viewports.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Toggle expansion and render either the full artifact (when expanding) or
 * a collapse confirmation (when collapsing). Used by the `/output` slash
 * command and as a non-TTY fallback for the Ctrl+O key handler.
 *
 * The interactive Ctrl+O shortcut prefers `openViewportPager` instead, which
 * opens an alternate-screen pager (less-style) the user can scroll and
 * close with `q` or Ctrl+O.
 */
export async function toggleViewport(
  id: string,
  write: (chunk: string) => void = (c) => process.stdout.write(c),
): Promise<boolean> {
  const v = viewports.get(id);
  if (!v) return false;
  v.expanded = !v.expanded;
  if (v.expanded) {
    write(chalk.dim(`\n  ── full output for ${v.toolName} (${v.argsDisplay}) ──\n`));
    if (v.artifactPath) {
      try {
        const raw = await readFile(v.artifactPath, "utf8");
        write(raw);
        if (!raw.endsWith("\n")) write("\n");
      } catch (error) {
        write(
          chalk.yellow(`  (could not read artifact: ${error instanceof Error ? error.message : String(error)})\n`),
        );
      }
    } else {
      write(chalk.dim("  (no artifact file — only the summary is available)\n"));
    }
    write(chalk.dim(`  ── press Ctrl+O again to collapse ──\n`));
  } else {
    write(chalk.dim(`\n  ── collapsed; press Ctrl+O to expand ──\n`));
  }
  return true;
}

export function clearViewports(): void {
  viewports.clear();
  lastViewportId = undefined;
}

export function formatViewportHint(v: OutputViewport): string {
  const hints: string[] = [];
  if (process.stdout.isTTY) hints.push("Ctrl+O");
  hints.push("/output last");
  if (v.artifactPath) hints.push(`/output ${v.id}`);
  const action = v.expanded
    ? "collapse"
    : process.stdout.isTTY
      ? "open full output (q to close)"
      : "show full output";
  return chalk.dim(
    `  ${hints.join(" or ")} to ${action}${v.artifactPath ? ` (${v.artifactPath})` : ""}`,
  );
}

// ── Alternate-screen pager (less / more style) ──────────────────────────────
// When the user presses Ctrl+O on a TTY we open the full tool output in a
// scrollable pager that lives in the alternate screen buffer, leaving the
// REPL session below intact. Closing with `q`, ESC, or Ctrl+O drops back
// to the REPL with the previous prompt redrawn by the caller.

interface KeypressKey {
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  name?: string;
  sequence?: string;
}

function ansiSeq(code: string): string {
  return `\x1b[${code}`;
}

const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_EXIT = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_SCREEN = "\x1b[2J";
const HOME = "\x1b[H";

function termSize(): { rows: number; cols: number } {
  const rows = output.rows ?? 24;
  const cols = output.columns ?? 80;
  return { rows: Math.max(rows, 4), cols: Math.max(cols, 20) };
}

/** Wrap a single logical line to the given column width, preserving ANSI
 *  escapes by treating them as zero-width when measuring. */
function wrapLine(line: string, width: number): string[] {
  if (width <= 0) return [line];
  const ansiRe = /\x1b\[[0-9;]*[A-Za-z]/g;
  const stripped = line.replace(ansiRe, "");
  if (stripped.length <= width) return [line];
  // Naive but ANSI-aware wrap: walk character by character, breaking when
  // the visible column counter hits `width`. We don't try to preserve
  // styling across breaks, only to avoid splitting an escape mid-sequence.
  const result: string[] = [];
  let buf = "";
  let visible = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "\x1b" && line[i + 1] === "[") {
      const end = line.indexOf("m", i);
      if (end >= 0) {
        buf += line.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    buf += ch;
    visible += 1;
    i += 1;
    if (visible >= width) {
      result.push(buf);
      buf = "";
      visible = 0;
    }
  }
  if (buf.length > 0) result.push(buf);
  return result;
}

interface PagerOptions {
  title: string;
  body: string;
  /** Optional footer text; defaults to navigation help. */
  footer?: string | undefined;
}

/**
 * Open `body` in an alternate-screen pager. Resolves once the user closes
 * it (q, ESC, or Ctrl+O). Falls back to inline rendering when the terminal
 * is not a TTY (eg piped output, non-interactive shells) so the same code
 * path also serves CI logs.
 */
export async function openPager(options: PagerOptions): Promise<void> {
  if (!output.isTTY || !input.isTTY) {
    // Non-TTY fallback — just dump the body. Useful for `clai ... | tee log`.
    process.stdout.write(`\n── ${options.title} ──\n`);
    process.stdout.write(options.body);
    if (!options.body.endsWith("\n")) process.stdout.write("\n");
    return;
  }

  const lines = options.body.split(/\r?\n/);

  return new Promise<void>((resolve) => {
    // Track whether we entered raw mode ourselves so we can restore the
    // exact previous state. The REPL toggles raw mode for its own input
    // loop, so we want to leave it the way we found it.
    const wasRaw = (input as { isRaw?: boolean }).isRaw ?? false;
    let scrollTop = 0;
    let resolved = false;

    // Memoize the wrap result by column width. Wrapping every paint for a
    // 100k-line artifact would burn CPU; recompute only when the terminal
    // is resized to a different width.
    let cachedWidth = -1;
    let wrapped: string[] = [];
    const computeWrapped = (cols: number): string[] => {
      if (cachedWidth === cols) return wrapped;
      cachedWidth = cols;
      wrapped = [];
      for (const line of lines) {
        const segments = wrapLine(line, cols);
        for (const seg of segments) wrapped.push(seg);
      }
      return wrapped;
    };

    const enter = (): void => {
      output.write(ALT_SCREEN_ENTER);
      output.write(HIDE_CURSOR);
      output.write(CLEAR_SCREEN);
      output.write(HOME);
    };
    const exit = (): void => {
      output.write(SHOW_CURSOR);
      output.write(ALT_SCREEN_EXIT);
    };

    const buildFooter = (
      visibleStart: number,
      visibleEnd: number,
      total: number,
    ): string => {
      const help =
        options.footer ??
        "↑/↓ j/k · PgUp/PgDn space · g/G top/bottom · q or Ctrl+O to close";
      const ratio =
        total === 0 ? 100 : Math.round((visibleEnd / total) * 100);
      const counter = `${visibleStart + 1}-${visibleEnd}/${total} (${ratio}%)`;
      return `${help}  ${chalk.dim(counter)}`;
    };

    const paint = (): void => {
      const { rows, cols } = termSize();
      const headerLines = 1;
      const footerLines = 1;
      const viewRows = Math.max(rows - headerLines - footerLines, 1);

      const wrappedLines = computeWrapped(cols);
      const total = wrappedLines.length;
      if (scrollTop > Math.max(total - viewRows, 0)) {
        scrollTop = Math.max(total - viewRows, 0);
      }
      if (scrollTop < 0) scrollTop = 0;
      const slice = wrappedLines.slice(scrollTop, scrollTop + viewRows);

      // Build the full frame in a single buffer and write it at once. Many
      // small `output.write()` calls cause flicker on Windows Terminal and
      // on macOS Terminal.app under high CPU load; one big write paints
      // the whole pager in a single syscall.
      let frame = "";
      frame += HOME;
      frame += CLEAR_SCREEN;
      frame += HOME;
      frame += chalk.cyan(options.title);
      frame += "\n";
      for (let i = 0; i < viewRows; i += 1) {
        frame += ansiSeq(`${i + 2};1H`);
        frame += slice[i] ?? "";
        frame += ansiSeq("K");
      }
      frame += ansiSeq(`${rows};1H`);
      frame += ansiSeq("K");
      const footer = buildFooter(
        scrollTop,
        Math.min(scrollTop + viewRows, total),
        total,
      );
      const visibleFooter = footer.length > cols ? footer.slice(0, cols) : footer;
      frame += chalk.dim(visibleFooter);

      output.write(frame);
    };

    const close = (): void => {
      if (resolved) return;
      resolved = true;
      pagerActive = false;
      input.off("keypress", handleKeypress);
      output.off("resize", handleResize);
      if (input.isTTY) {
        try {
          input.setRawMode(wasRaw);
        } catch {
          // ignore — caller is responsible for restoring its preferred mode
        }
      }
      exit();
      resolve();
    };

    function handleResize(): void {
      if (resolved) return;
      // Force re-wrap on next paint — the column width changed.
      cachedWidth = -1;
      paint();
    }

    function handleKeypress(_seq: string, key: KeypressKey): void {
      if (resolved) return;

      if (isCtrlC(key)) {
        // Treat Ctrl+C as "close pager" rather than killing the whole REPL.
        close();
        return;
      }
      if (isCtrlO(key)) {
        close();
        return;
      }
      if (isEscape(key) || key.name === "q") {
        close();
        return;
      }

      const { rows } = termSize();
      const pageSize = Math.max(rows - 3, 1);

      if (key.name === "down" || key.name === "j") {
        scrollTop += 1;
        paint();
        return;
      }
      if (key.name === "up" || key.name === "k") {
        scrollTop = Math.max(0, scrollTop - 1);
        paint();
        return;
      }
      if (
        key.name === "pagedown" ||
        (key.ctrl && key.name === "f") ||
        key.name === "space"
      ) {
        scrollTop += pageSize;
        paint();
        return;
      }
      if (key.name === "pageup" || (key.ctrl && key.name === "b")) {
        scrollTop = Math.max(0, scrollTop - pageSize);
        paint();
        return;
      }
      if (key.name === "g" && !key.shift) {
        scrollTop = 0;
        paint();
        return;
      }
      if (key.name === "g" && key.shift) {
        scrollTop = Number.MAX_SAFE_INTEGER;
        paint();
        return;
      }
      if (key.name === "home") {
        scrollTop = 0;
        paint();
        return;
      }
      if (key.name === "end") {
        scrollTop = Number.MAX_SAFE_INTEGER;
        paint();
        return;
      }
    }

    try {
      pagerActive = true;
      enter();
      if (input.isTTY) input.setRawMode(true);
      input.resume();
      input.on("keypress", handleKeypress);
      output.on("resize", handleResize);
      paint();
    } catch (error) {
      // Surface to stderr in case alt-screen is unsupported, then fall back
      // to inline render so the user still sees the data.
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(chalk.yellow(`\n  (pager unavailable: ${msg})\n`));
      pagerActive = false;
      try {
        exit();
      } catch {
        // ignore
      }
      process.stdout.write(`\n── ${options.title} ──\n`);
      process.stdout.write(options.body);
      if (!options.body.endsWith("\n")) process.stdout.write("\n");
      resolved = true;
      resolve();
    }
  });
}

/**
 * Open the full output for a viewport in the alternate-screen pager. Reads
 * the raw artifact when present; falls back to the AI-facing summary so
 * the user always sees something even if the artifact file was rotated.
 */
export async function openViewportPager(id: string): Promise<boolean> {
  const v = viewports.get(id);
  if (!v) return false;
  let body = v.summary;
  if (v.artifactPath) {
    try {
      body = await readFile(v.artifactPath, "utf8");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      body = `(could not read artifact ${v.artifactPath}: ${msg})\n\n${v.summary}`;
    }
  }
  // Mark expanded for parity with the toggleViewport flow so /output behavior
  // stays consistent — opening the pager counts as "expanded".
  v.expanded = true;
  await openPager({
    title: `full output · ${v.toolName} ${v.argsDisplay}${v.artifactPath ? ` · ${v.artifactPath}` : ""}`,
    body,
  });
  // Closing the pager collapses the viewport back to its summary state.
  v.expanded = false;
  return true;
}
