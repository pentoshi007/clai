import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLUMNS,
  DEFAULT_ROWS,
  detectCapabilities,
  type CapabilityEnv,
} from "../../src/tui-v2/bootstrap/capabilities.js";

function makeEnv(overrides: Partial<CapabilityEnv> = {}): CapabilityEnv {
  return {
    env: {},
    stdoutIsTTY: true,
    stdinIsTTY: true,
    columns: 120,
    rows: 40,
    ...overrides,
  };
}

describe("detectCapabilities color mode", () => {
  it("reports none and noColor when NO_COLOR is set", () => {
    const caps = detectCapabilities(makeEnv({ env: { NO_COLOR: "1" } }));
    expect(caps.colorMode).toBe("none");
    expect(caps.noColor).toBe(true);
  });

  it("reports truecolor via COLORTERM", () => {
    const caps = detectCapabilities(makeEnv({ env: { COLORTERM: "truecolor" } }));
    expect(caps.colorMode).toBe("truecolor");
    expect(caps.noColor).toBe(false);
  });

  it("reports truecolor for known terminal programs", () => {
    const caps = detectCapabilities(
      makeEnv({ env: { TERM_PROGRAM: "iTerm.app" } }),
    );
    expect(caps.colorMode).toBe("truecolor");
  });

  it("reports 256 color for 256-color TERM", () => {
    const caps = detectCapabilities(
      makeEnv({ env: { TERM: "xterm-256color" } }),
    );
    expect(caps.colorMode).toBe("256");
  });

  it("reports none when not a TTY", () => {
    const caps = detectCapabilities(makeEnv({ stdoutIsTTY: false }));
    expect(caps.colorMode).toBe("none");
    expect(caps.isTTY).toBe(false);
  });
});

describe("detectCapabilities keyboard protocol", () => {
  it("detects kitty keyboard for kitty-family terminals and enables Shift+Enter", () => {
    const caps = detectCapabilities(makeEnv({ env: { TERM: "xterm-kitty" } }));
    expect(caps.kittyKeyboard).toBe(true);
    expect(caps.canDistinguishShiftEnter).toBe(true);
  });

  it("does not claim Shift+Enter on a plain terminal", () => {
    const caps = detectCapabilities(makeEnv({ env: { TERM: "xterm-256color" } }));
    expect(caps.kittyKeyboard).toBe(false);
    expect(caps.canDistinguishShiftEnter).toBe(false);
  });

  it("never enables kitty keyboard on a non-TTY", () => {
    const caps = detectCapabilities(
      makeEnv({ stdoutIsTTY: false, env: { TERM: "xterm-kitty" } }),
    );
    expect(caps.kittyKeyboard).toBe(false);
  });
});

describe("detectCapabilities misc", () => {
  it("falls back to default dimensions when unknown", () => {
    const caps = detectCapabilities(
      makeEnv({ columns: undefined, rows: undefined }),
    );
    expect(caps.columns).toBe(DEFAULT_COLUMNS);
    expect(caps.rows).toBe(DEFAULT_ROWS);
  });

  it("detects unicode from UTF-8 locale and denies otherwise", () => {
    expect(
      detectCapabilities(makeEnv({ env: { LANG: "en_US.UTF-8" } })).unicode,
    ).toBe(true);
    expect(
      detectCapabilities(makeEnv({ env: { LANG: "C" } })).unicode,
    ).toBe(false);
  });

  it("honors reduced-motion opt-ins", () => {
    expect(
      detectCapabilities(makeEnv({ env: { CLAI_REDUCED_MOTION: "1" } }))
        .reducedMotion,
    ).toBe(true);
    expect(detectCapabilities(makeEnv()).reducedMotion).toBe(false);
  });

  it("derives a theme hint from COLORFGBG and explicit override", () => {
    expect(
      detectCapabilities(makeEnv({ env: { COLORFGBG: "15;0" } })).themeHint,
    ).toBe("dark");
    expect(
      detectCapabilities(makeEnv({ env: { COLORFGBG: "0;15" } })).themeHint,
    ).toBe("light");
    expect(
      detectCapabilities(makeEnv({ env: { CLAI_THEME: "light" } })).themeHint,
    ).toBe("light");
    expect(detectCapabilities(makeEnv()).themeHint).toBe("unknown");
  });
});
