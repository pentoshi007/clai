export type ColorMode = "truecolor" | "256" | "16" | "none";

/**
 * Terminal capability report (COMPAT-001, A11Y-001). Action defaults are
 * semantic, not byte-sequence promises: `canDistinguishShiftEnter` tells the
 * action layer whether Shift+Enter is a usable newline binding or whether the
 * advertised Alt/Option+Enter fallback must be shown instead.
 */
export interface TerminalCapabilities {
  readonly columns: number;
  readonly rows: number;
  readonly colorMode: ColorMode;
  readonly isTTY: boolean;
  readonly canDistinguishShiftEnter: boolean;
  readonly supportsOsc52: boolean;
}

export interface TerminalPort {
  capabilities(): TerminalCapabilities;
}
