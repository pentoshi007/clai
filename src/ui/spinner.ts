import chalk from "chalk";

// Live, dependency-free thinking indicator. Renders below the prompt as
// up to two dim lines:
//   ⠋ thinking 12.3s · 240 reasoning tokens
//      tail of the most recent reasoning text…
// On stop() it erases its own lines so subsequent output starts clean.

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_INTERVAL_MS = 80;
const PREVIEW_TAIL_CHARS = 220;

/**
 * Hard SGR reset emitted at the end of every spinner-rendered line and
 * before/after every erase. Without this the dim+italic style chalk
 * applies to the preview line can leak past the spinner's lifetime —
 * e.g. when {@link truncateForWidth} slices off the closing reset
 * sequence — and the next thing written to the terminal (the model's
 * visible answer, the markdown header, etc.) renders dim until the
 * next ANSI sequence happens to reset it. Always emitting `\x1b[0m`
 * here makes the leak impossible.
 */
const SGR_RESET = "\x1b[0m";

export interface ThinkingSpinner {
  setLabel(label: string): void;
  bumpReasoning(tokens: number): void;
  /** Append visible-but-dim "what the model is thinking" text. */
  pushPreview(text: string): void;
  stop(): void;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Truncate `text` to at most `width` *visible* characters while keeping
 * any embedded ANSI escape sequences intact. The previous implementation
 * sliced the raw string at byte index `width - 1`, which routinely cut
 * the closing `\x1b[22;23m` reset off the end of a `chalk.dim.italic`
 * preview line — leaving the dim attribute "on" so the model's first
 * visible tokens after the spinner stopped rendered in light grey until
 * the markdown writer happened to emit its own ANSI sequence.
 *
 * This rewrite walks the string token-by-token: it copies ANSI escape
 * sequences verbatim (they consume zero visible columns), counts each
 * non-escape character against `width`, and truncates at the visible
 * boundary. The returned string is always followed by a hard
 * {@link SGR_RESET} so any open style is closed before the cursor moves
 * on.
 */
function truncateForWidth(text: string, width: number): string {
  if (width <= 0) return SGR_RESET;
  const visibleLen = stripAnsi(text).length;
  if (visibleLen <= width) return text;

  let out = "";
  let visible = 0;
  let i = 0;
  // Reserve the trailing ellipsis from the visible budget.
  const cap = Math.max(0, width - 1);
  while (i < text.length && visible < cap) {
    if (text.startsWith("\x1b[", i)) {
      // Copy a full ANSI sequence so we never split it mid-byte.
      const m = ANSI_RE.exec(text.slice(i));
      // ANSI_RE is global, but we only want a single match starting at i.
      // Fall back to a manual scan if exec doesn't anchor at 0.
      if (m && m.index === 0) {
        out += m[0];
        i += m[0].length;
        ANSI_RE.lastIndex = 0;
        continue;
      }
      ANSI_RE.lastIndex = 0;
      // Defensive: scan for the terminating letter (m / K / etc.).
      let j = i + 2;
      while (j < text.length && !/[a-zA-Z]/.test(text[j]!)) j += 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += text[i];
    visible += 1;
    i += 1;
  }
  return `${out}…${SGR_RESET}`;
}

export function startThinkingSpinner(
  initialLabel = "thinking",
  signal?: AbortSignal,
): ThinkingSpinner {
  if (!process.stdout.isTTY) {
    return {
      setLabel: () => {},
      bumpReasoning: () => {},
      pushPreview: () => {},
      stop: () => {},
    };
  }

  let label = initialLabel;
  let reasoningTokens = 0;
  let frame = 0;
  const start = Date.now();
  let stopped = false;
  let renderedLines = 0;
  let preview = "";

  const erase = (): void => {
    if (renderedLines === 0) return;
    // Cursor is currently after the last rendered line. Move back up,
    // clearing each line as we go. Always emit a hard SGR reset before
    // and after the clear so any open style attribute (dim, italic,
    // colored) cannot persist past the spinner — `\x1b[2K` clears the
    // visible cells but leaves SGR untouched.
    process.stdout.write(SGR_RESET);
    for (let i = 0; i < renderedLines; i += 1) {
      process.stdout.write("\r\x1b[2K"); // clear current line
      if (i < renderedLines - 1) process.stdout.write("\x1b[1A"); // move up
    }
    process.stdout.write(SGR_RESET);
    renderedLines = 0;
  };

  const render = (): void => {
    if (stopped) return;
    erase();

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const tokenSuffix =
      reasoningTokens > 0
        ? chalk.dim(` · ${reasoningTokens.toLocaleString()} reasoning tokens`)
        : "";
    const headLine =
      "  " +
      chalk.magenta(FRAMES[frame % FRAMES.length]!) +
      " " +
      chalk.dim(`${label} ${elapsed}s`) +
      tokenSuffix +
      // Belt-and-braces SGR reset at end-of-line.
      SGR_RESET;

    const cols = clamp(process.stdout.columns ?? 80, 40, 200);

    let lines: string[] = [headLine];
    if (preview) {
      // Take last N chars, drop ANSI/control noise, collapse whitespace,
      // and indent so the preview lines up under the spinner. Strip any
      // ANSI escapes that leaked in from the upstream stream so we are
      // the sole source of styling on the preview line.
      const tail = stripAnsi(preview)
        .slice(-PREVIEW_TAIL_CHARS)
        // biome-ignore lint: control char strip
        .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (tail) {
        // Always end the styled run with SGR_RESET so the truncator (or
        // a terminal that doesn't process the trailing CR/clear in time)
        // can never carry the dim+italic attribute past this line.
        const previewLine = `${chalk.dim.italic(`    ${tail}`)}${SGR_RESET}`;
        lines.push(truncateForWidth(previewLine, cols));
      }
    }

    process.stdout.write(lines.join("\n"));
    renderedLines = lines.length;
    frame += 1;
  };

  render();
  const timer = setInterval(render, FRAME_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    erase();
    // Final, unconditional SGR reset so nothing emitted after the
    // spinner inherits its style attributes.
    process.stdout.write(SGR_RESET);
  };

  if (signal) {
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  }

  return {
    setLabel(next: string): void {
      label = next;
    },
    bumpReasoning(tokens: number): void {
      reasoningTokens += tokens;
    },
    pushPreview(text: string): void {
      if (!text) return;
      preview += text;
      // Only keep what we'll actually show, plus a small overflow buffer.
      if (preview.length > PREVIEW_TAIL_CHARS * 4) {
        preview = preview.slice(-PREVIEW_TAIL_CHARS * 2);
      }
    },
    stop,
  };
}
