import chalk from "chalk";

// Live, dependency-free thinking indicator. Renders below the prompt as
// up to two dim lines:
//   ⠋ thinking 12.3s · 240 reasoning tokens
//      tail of the most recent reasoning text…
// On stop() it erases its own lines so subsequent output starts clean.

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_INTERVAL_MS = 80;
const PREVIEW_TAIL_CHARS = 220;

export interface ThinkingSpinner {
  setLabel(label: string): void;
  bumpReasoning(tokens: number): void;
  /** Append visible-but-dim "what the model is thinking" text. */
  pushPreview(text: string): void;
  stop(): void;
}

function stripAnsi(text: string): string {
  // biome-ignore lint: ANSI escape pattern is intentional.
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
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
    // clearing each line as we go.
    for (let i = 0; i < renderedLines; i += 1) {
      process.stdout.write("\r\x1b[2K"); // clear current line
      if (i < renderedLines - 1) process.stdout.write("\x1b[1A"); // move up
    }
    renderedLines = 0;
  };

  const truncateForWidth = (text: string, width: number): string => {
    const visibleLen = stripAnsi(text).length;
    if (visibleLen <= width) return text;
    // For preview text that has no ANSI codes, simple slice works.
    return text.slice(0, Math.max(0, width - 1)) + "…";
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
      chalk.magenta(FRAMES[frame % FRAMES.length]!) +
      " " +
      chalk.dim(`${label} ${elapsed}s`) +
      tokenSuffix;

    const cols = clamp(process.stdout.columns ?? 80, 40, 200);

    let lines: string[] = [headLine];
    if (preview) {
      // Take last N chars, drop ANSI/control noise, collapse whitespace,
      // and indent so the preview lines up under the spinner.
      const tail = preview
        .slice(-PREVIEW_TAIL_CHARS)
        // biome-ignore lint: control char strip
        .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (tail) {
        const previewLine = chalk.dim.italic(`  ${tail}`);
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
