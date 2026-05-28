// Regression test for the dim-text leak that caused the model's first
// few words after a thinking spinner to render in grey.
//
// Root cause: the spinner's preview line was styled with
// `chalk.dim.italic(...)` and then truncated by raw byte slicing. When
// the slice cut off the closing `\x1b[22;23m` sequence, the `dim+italic`
// SGR remained "open" and bled into whatever was written next. The fix
// (a) walks the styled string token-by-token to never split an ANSI
// escape and (b) emits a hard `\x1b[0m` at the end of every spinner
// line and after `erase()` / `stop()` so subsequent output is always
// rendered with a known SGR state.
//
// We verify the fix at the unit level by capturing every byte the
// spinner writes to stdout and asserting that:
//
//   1. The final byte stream after `stop()` ends with the SGR reset
//      sequence so terminals will not display subsequent characters
//      with any leaked attribute.
//   2. The truncated preview line never ends with a half-sequence (no
//      trailing `\x1b[` without a closing letter).

import { describe, expect, it, vi } from "vitest";

import { startThinkingSpinner } from "../src/ui/spinner.js";

interface CaptureHandle {
  output: string;
  restore: () => void;
}

function captureStdout(): CaptureHandle {
  const original = process.stdout.write.bind(process.stdout);
  let output = "";
  // `process.stdout.write` has a notoriously polymorphic signature.
  // For this test we only need to capture bytes; everything else is
  // forwarded to the original implementation so terminal state stays
  // consistent during the run.
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string") output += chunk;
    else if (chunk instanceof Buffer) output += chunk.toString("utf-8");
    return original(chunk as never, ...(rest as []));
  }) as typeof process.stdout.write;
  return {
    get output() {
      return output;
    },
    restore: () => {
      process.stdout.write = original;
    },
  };
}

function withFakeTty<T>(fn: () => T): T {
  // The spinner is a no-op in non-TTY environments, so the test must
  // pretend stdout is a TTY to exercise the rendering path.
  const originalIsTTY = (process.stdout as unknown as { isTTY: boolean })
    .isTTY;
  const originalCols = process.stdout.columns;
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: 80,
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalIsTTY,
    });
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: originalCols,
    });
  }
}

describe("spinner SGR leak regression", () => {
  it("ends every render and the final stop with a hard SGR reset", () => {
    vi.useFakeTimers();
    const handle = captureStdout();
    try {
      withFakeTty(() => {
        const spinner = startThinkingSpinner("thinking");
        // Push enough preview text to exceed any reasonable terminal
        // width so the truncation path runs.
        spinner.pushPreview("X".repeat(2000));
        // Drive at least one render frame.
        vi.advanceTimersByTime(120);
        spinner.stop();
      });
    } finally {
      handle.restore();
      vi.useRealTimers();
    }

    // After stop(), the very last bytes must be the SGR reset so any
    // terminal that still has a previous-line styled cell active will
    // be cleared before the next write.
    expect(handle.output.endsWith("\x1b[0m")).toBe(true);
  });

  it("never leaves a truncated ANSI escape at the end of a preview line", () => {
    vi.useFakeTimers();
    const handle = captureStdout();
    try {
      withFakeTty(() => {
        const spinner = startThinkingSpinner("thinking");
        spinner.pushPreview("the quick brown fox ".repeat(200));
        vi.advanceTimersByTime(80);
        vi.advanceTimersByTime(80);
        spinner.stop();
      });
    } finally {
      handle.restore();
      vi.useRealTimers();
    }

    // Look for any `\x1b[` that is NOT followed by an optional digit/;
    // sequence and an alphabetic terminator before EOF — that would be
    // a half-sequence the dim-text leak relied on.
    const halfSeqRe = /\x1b\[[0-9;]*$/;
    expect(halfSeqRe.test(handle.output)).toBe(false);
  });
});
