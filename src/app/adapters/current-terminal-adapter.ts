import type {
  ColorMode,
  TerminalCapabilities,
  TerminalPort,
} from "../ports/terminal-port.js";

function detectColorMode(): ColorMode {
  if (process.env.NO_COLOR !== undefined) return "none";
  if (/truecolor|24bit/i.test(process.env.COLORTERM ?? "")) return "truecolor";
  if (/256/.test(process.env.TERM ?? "")) return "256";
  return process.stdout.isTTY ? "16" : "none";
}

/**
 * Reads terminal capabilities from the process streams. This adapter is the
 * single sanctioned place to inspect the terminal; components receive
 * dimensions/capabilities through it rather than reading `process.stdout`.
 * `canDistinguishShiftEnter` is conservatively false until the renderer's
 * keyboard-protocol detection (Phase 3/4) can prove otherwise.
 */
export function createCurrentTerminalPort(): TerminalPort {
  return {
    capabilities(): TerminalCapabilities {
      return {
        columns: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
        colorMode: detectColorMode(),
        isTTY: Boolean(process.stdout.isTTY),
        canDistinguishShiftEnter: false,
        supportsOsc52: true,
      };
    },
  };
}
