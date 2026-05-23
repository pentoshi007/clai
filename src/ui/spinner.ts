import chalk from "chalk";

// Lightweight, dependency-free spinner used while we wait on the model
// (especially during long thinking phases when no visible tokens stream).
// Renders on a single line and clears itself on stop, so output below it
// stays clean.

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_INTERVAL_MS = 80;

export interface ThinkingSpinner {
  setLabel(label: string): void;
  bumpReasoning(tokens: number): void;
  stop(): void;
}

export function startThinkingSpinner(
  initialLabel = "thinking",
  signal?: AbortSignal,
): ThinkingSpinner {
  if (!process.stdout.isTTY) {
    // No-op for piped output so logs stay grep-friendly.
    return {
      setLabel: () => {},
      bumpReasoning: () => {},
      stop: () => {},
    };
  }

  let label = initialLabel;
  let reasoningTokens = 0;
  let frame = 0;
  const start = Date.now();
  let stopped = false;
  let lastWidth = 0;

  const render = (): void => {
    if (stopped) return;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const tokenSuffix =
      reasoningTokens > 0
        ? chalk.dim(` · ${reasoningTokens.toLocaleString()} reasoning tokens`)
        : "";
    const line =
      chalk.magenta(FRAMES[frame % FRAMES.length]!) +
      " " +
      chalk.dim(`${label} ${elapsed}s`) +
      tokenSuffix;
    process.stdout.write(`\r${line}`);
    // Pad to clear leftover characters when the line shrinks.
    const visibleLen = stripAnsi(line).length;
    if (visibleLen < lastWidth) {
      process.stdout.write(" ".repeat(lastWidth - visibleLen));
      process.stdout.write(`\r${line}`);
    }
    lastWidth = visibleLen;
    frame += 1;
  };

  render();
  const timer = setInterval(render, FRAME_INTERVAL_MS);
  // Don't keep the process alive just for the spinner.
  if (typeof timer.unref === "function") timer.unref();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    // Erase the spinner line entirely so subsequent output starts clean.
    process.stdout.write(`\r${" ".repeat(Math.max(lastWidth, 1))}\r`);
  };

  // Stop the moment the user aborts so the spinner can never linger past
  // an ESC, even if upstream cleanup paths are skipped by an exception.
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
    stop,
  };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
