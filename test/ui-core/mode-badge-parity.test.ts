import { describe, expect, it } from "vitest";
import { statusRows, type StatusViewInput } from "../../src/classic/chrome/status-rows.js";
import { createInkTheme } from "../../src/classic/render/ink-theme.js";
import { renderIntroHeaderLines } from "../../src/ui-core/rendering/intro-header.js";
import { modeBadgeToken, themeFor } from "../../src/ui-core/rendering/theme.js";
import type { Mode } from "../../src/types.js";

const MODES: readonly Mode[] = ["agent", "ask", "plan"];

const theme = themeFor("dark");
const ink = createInkTheme({ themeHint: "dark", colorMode: "truecolor", unicode: true });

function backgroundSequence(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  return `\x1b[48;2;${r};${g};${b}m`;
}

function statusInput(mode: Mode): StatusViewInput {
  return {
    ink,
    columns: 120,
    allocatedRows: 1,
    mode,
    contextChip: "ctx 0/250k 0%",
    contextUsage: undefined,
    running: false,
    compacting: false,
    activity: undefined,
    cancelArmed: false,
    tick: 0,
    hasDraft: false,
    queued: 0,
    planVisible: false,
    hasActivePlan: false,
  };
}

function introBadgeLine(mode: Mode): string {
  const lines = renderIntroHeaderLines({
    width: 120,
    version: "1.2.3",
    mode,
    provider: "openrouter",
    model: "example/model",
    permissions: "default",
    workdir: "~/project",
    variant: "high",
    theme,
  });
  return lines.find((line) => line.includes(`${mode.toUpperCase()} MODE`))!;
}

describe("mode badge colors", () => {
  it("assigns a distinct color to every mode", () => {
    const colors = new Set(MODES.map((mode) => theme[modeBadgeToken(mode)]));
    expect(colors.size).toBe(MODES.length);
  });

  it("falls back to the agent color for unknown modes without reading inherited keys", () => {
    for (const mode of ["unknown", "constructor", "__proto__", ""]) {
      expect(modeBadgeToken(mode)).toBe(modeBadgeToken("agent"));
    }
  });

  it.each(MODES)("paints the %s badge on the intro card like the status bar below the composer", (mode) => {
    const expected = backgroundSequence(theme[modeBadgeToken(mode)]);
    const statusRow = statusRows(statusInput(mode)).join("\n");
    expect(statusRow).toContain(expected);
    expect(introBadgeLine(mode)).toContain(expected);
  });
});
