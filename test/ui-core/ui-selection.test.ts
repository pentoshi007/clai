import { describe, expect, it } from "vitest";
import { MIN_COLS, MIN_ROWS } from "../../src/ui-core/bootstrap/can-use-tui.js";
import {
  UI_FLAG_CHOICES,
  defaultUiForPlatform,
  describeUiDefault,
  explainUiChoice,
  isTuiRequested,
  normalizeUiToken,
  resolveUiChoice,
  type PlatformProbe,
  type UiChoice,
} from "../../src/ui-core/bootstrap/ui-selection.js";

const POSIX_TTY: PlatformProbe = {
  platform: "linux",
  stdoutIsTTY: true,
  stdinIsTTY: true,
  columns: 120,
  rows: 40,
};

const WIN_TTY: PlatformProbe = { ...POSIX_TTY, platform: "win32" };
const PIPED: PlatformProbe = { ...POSIX_TTY, stdoutIsTTY: false };

describe("normalizeUiToken", () => {
  it("maps every tui alias", () => {
    for (const token of ["tui", "v2", "opentui", "TUI", " V2 "]) {
      expect(normalizeUiToken(token)).toBe("tui");
    }
  });

  it("maps every classic alias", () => {
    for (const token of ["classic", "legacy", "ink", "Classic", " INK "]) {
      expect(normalizeUiToken(token)).toBe("classic");
    }
  });

  it("rejects unknown and empty tokens", () => {
    for (const token of [undefined, "", "  ", "plain", "solid", "noninteractive"]) {
      expect(normalizeUiToken(token)).toBeUndefined();
    }
  });

  it("exposes exactly the tokens commander accepts", () => {
    expect([...UI_FLAG_CHOICES]).toEqual(["tui", "v2", "opentui", "classic", "legacy", "ink"]);
    for (const token of UI_FLAG_CHOICES) {
      expect(normalizeUiToken(token)).toBeDefined();
    }
  });
});

describe("defaultUiForPlatform", () => {
  it("returns noninteractive when either stdio end is not a TTY", () => {
    expect(defaultUiForPlatform({ ...POSIX_TTY, stdoutIsTTY: false })).toBe("noninteractive");
    expect(defaultUiForPlatform({ ...POSIX_TTY, stdinIsTTY: false })).toBe("noninteractive");
    expect(defaultUiForPlatform({ ...WIN_TTY, stdoutIsTTY: false })).toBe("noninteractive");
  });

  it("returns classic on win32", () => {
    expect(defaultUiForPlatform(WIN_TTY)).toBe("classic");
  });

  it("returns classic below the minimum window size", () => {
    expect(defaultUiForPlatform({ ...POSIX_TTY, columns: MIN_COLS - 1 })).toBe("classic");
    expect(defaultUiForPlatform({ ...POSIX_TTY, rows: MIN_ROWS - 1 })).toBe("classic");
    expect(defaultUiForPlatform({ ...POSIX_TTY, columns: undefined, rows: undefined })).toBe(
      "classic",
    );
  });

  it("returns tui on a large interactive POSIX terminal", () => {
    expect(defaultUiForPlatform(POSIX_TTY)).toBe("tui");
    expect(defaultUiForPlatform({ ...POSIX_TTY, columns: MIN_COLS, rows: MIN_ROWS })).toBe("tui");
  });

  it("is pure — same input, same answer", () => {
    expect(defaultUiForPlatform(POSIX_TTY)).toBe(defaultUiForPlatform({ ...POSIX_TTY }));
  });
});

describe("resolveUiChoice precedence", () => {
  const ENV_KEYS = ["CLAI_UI", "CLAI_CLASSIC", "CLAI_TUI", "CLAI_CLASSIC_UI"] as const;

  const ENVS: readonly NodeJS.ProcessEnv[] = [
    {},
    { CLAI_UI: "tui" },
    { CLAI_UI: "classic" },
    { CLAI_UI: "legacy" },
    { CLAI_UI: "ink" },
    { CLAI_UI: "opentui" },
    { CLAI_UI: "nonsense" },
    { CLAI_CLASSIC: "1" },
    { CLAI_TUI: "0" },
    { CLAI_CLASSIC_UI: "plain" },
    { CLAI_UI: "tui", CLAI_CLASSIC: "1", CLAI_CLASSIC_UI: "plain" },
  ];

  it("--ui beats every environment variable", () => {
    for (const env of ENVS) {
      expect(resolveUiChoice({ ui: "classic" }, env, POSIX_TTY)).toBe("classic");
      expect(resolveUiChoice({ ui: "tui" }, env, POSIX_TTY)).toBe("tui");
    }
  });

  it("--classic beats every environment variable", () => {
    for (const env of ENVS) {
      expect(resolveUiChoice({ classic: true }, env, POSIX_TTY)).toBe("classic");
    }
  });

  it("--tui beats every environment variable", () => {
    for (const env of ENVS) {
      expect(resolveUiChoice({ tui: true }, env, POSIX_TTY)).toBe("tui");
    }
  });

  it("--ui beats the boolean flags", () => {
    expect(resolveUiChoice({ ui: "tui", classic: true }, {}, POSIX_TTY)).toBe("tui");
    expect(resolveUiChoice({ ui: "classic", tui: true }, {}, POSIX_TTY)).toBe("classic");
  });

  it("--classic beats --tui when both are passed", () => {
    expect(resolveUiChoice({ classic: true, tui: true }, {}, POSIX_TTY)).toBe("classic");
  });

  it("CLAI_UI beats the narrower classic env switches", () => {
    expect(resolveUiChoice({}, { CLAI_UI: "tui", CLAI_CLASSIC: "1" }, POSIX_TTY)).toBe("tui");
    expect(resolveUiChoice({}, { CLAI_UI: "tui", CLAI_TUI: "0" }, POSIX_TTY)).toBe("tui");
    expect(
      resolveUiChoice({}, { CLAI_UI: "classic", CLAI_CLASSIC_UI: "plain" }, POSIX_TTY),
    ).toBe("classic");
  });

  it("CLAI_CLASSIC=1 and CLAI_TUI=0 select classic", () => {
    expect(resolveUiChoice({}, { CLAI_CLASSIC: "1" }, POSIX_TTY)).toBe("classic");
    expect(resolveUiChoice({}, { CLAI_TUI: "0" }, POSIX_TTY)).toBe("classic");
  });

  it("CLAI_CLASSIC_UI=plain selects noninteractive", () => {
    expect(resolveUiChoice({}, { CLAI_CLASSIC_UI: "plain" }, POSIX_TTY)).toBe("noninteractive");
    expect(resolveUiChoice({}, { CLAI_CLASSIC_UI: "PLAIN" }, POSIX_TTY)).toBe("noninteractive");
  });

  it("classic env switches beat CLAI_CLASSIC_UI=plain", () => {
    expect(
      resolveUiChoice({}, { CLAI_CLASSIC: "1", CLAI_CLASSIC_UI: "plain" }, POSIX_TTY),
    ).toBe("classic");
  });

  it("ignores unset-looking and unrecognized env values", () => {
    expect(resolveUiChoice({}, { CLAI_UI: "nonsense" }, POSIX_TTY)).toBe("tui");
    expect(resolveUiChoice({}, { CLAI_CLASSIC: "0" }, POSIX_TTY)).toBe("tui");
    expect(resolveUiChoice({}, { CLAI_TUI: "1" }, POSIX_TTY)).toBe("tui");
    expect(resolveUiChoice({}, { CLAI_CLASSIC_UI: "rich" }, POSIX_TTY)).toBe("tui");
  });

  it("falls back to the platform default when nothing is specified", () => {
    expect(resolveUiChoice({}, {}, POSIX_TTY)).toBe("tui");
    expect(resolveUiChoice({}, {}, WIN_TTY)).toBe("classic");
    expect(resolveUiChoice({}, {}, PIPED)).toBe("noninteractive");
  });

  it("never returns a value outside the union", () => {
    const allowed: readonly UiChoice[] = ["tui", "classic", "noninteractive"];
    for (const env of ENVS) {
      for (const probe of [POSIX_TTY, WIN_TTY, PIPED]) {
        expect(allowed).toContain(resolveUiChoice({}, env, probe));
      }
    }
    expect(ENV_KEYS.length).toBe(4);
  });
});

describe("regressions fixed in W03", () => {
  it("--classic wins over CLAI_UI=tui", () => {
    expect(resolveUiChoice({ classic: true }, { CLAI_UI: "tui" }, POSIX_TTY)).toBe("classic");
  });

  it("--ui classic is an accepted commander token", () => {
    expect(UI_FLAG_CHOICES).toContain("classic");
    expect(resolveUiChoice({ ui: "classic" }, {}, POSIX_TTY)).toBe("classic");
  });
});

describe("explainUiChoice", () => {
  it("attributes each precedence level", () => {
    expect(explainUiChoice({ ui: "ink" }, {}, POSIX_TTY)).toEqual({
      choice: "classic",
      source: "ui-flag",
      reason: "--ui ink",
    });
    expect(explainUiChoice({ classic: true }, {}, POSIX_TTY).source).toBe("classic-flag");
    expect(explainUiChoice({ tui: true }, {}, POSIX_TTY).source).toBe("tui-flag");
    expect(explainUiChoice({}, { CLAI_UI: "v2" }, POSIX_TTY)).toEqual({
      choice: "tui",
      source: "clai-ui-env",
      reason: "CLAI_UI=v2",
    });
    expect(explainUiChoice({}, { CLAI_TUI: "0" }, POSIX_TTY)).toEqual({
      choice: "classic",
      source: "classic-env",
      reason: "CLAI_TUI=0",
    });
    expect(explainUiChoice({}, { CLAI_CLASSIC_UI: "plain" }, POSIX_TTY).source).toBe("plain-env");
    expect(explainUiChoice({}, {}, POSIX_TTY).source).toBe("platform-default");
  });

  it("explains why the platform default landed where it did", () => {
    expect(explainUiChoice({}, {}, WIN_TTY).reason).toMatch(/win32/);
    expect(explainUiChoice({}, {}, PIPED).reason).toMatch(/stdout is not a TTY/);
    expect(
      explainUiChoice({}, {}, { ...POSIX_TTY, stdoutIsTTY: false, stdinIsTTY: false }).reason,
    ).toMatch(/stdin and stdout are not TTYs/);
    expect(explainUiChoice({}, {}, { ...POSIX_TTY, stdinIsTTY: false }).reason).toMatch(
      /stdin is not a TTY/,
    );
    expect(explainUiChoice({}, {}, { ...POSIX_TTY, columns: 10 }).reason).toMatch(
      new RegExp(`smaller than ${MIN_COLS}x${MIN_ROWS}`),
    );
    expect(explainUiChoice({}, {}, POSIX_TTY).reason).toMatch(/interactive terminal/);
  });
});

describe("isTuiRequested", () => {
  it("tracks resolveUiChoice", () => {
    expect(isTuiRequested({}, {}, POSIX_TTY)).toBe(true);
    expect(isTuiRequested({}, {}, WIN_TTY)).toBe(false);
    expect(isTuiRequested({ classic: true }, {}, POSIX_TTY)).toBe(false);
  });
});

describe("describeUiDefault", () => {
  it("names all three frontends", () => {
    const text = describeUiDefault();
    expect(text).toMatch(/tui/i);
    expect(text).toMatch(/classic/i);
    expect(text).toMatch(/noninteractive/i);
  });
});
