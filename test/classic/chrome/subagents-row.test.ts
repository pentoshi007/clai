import { describe, expect, it } from "vitest";
import type { SubagentsRuntimeState } from "../../../src/app/controllers/session-controller.js";
import {
  subagentsRow,
  subagentsVisible,
} from "../../../src/classic/chrome/subagents-row.js";
import { plainText } from "../../../src/classic/render/ansi-text.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import { displayWidth } from "../../../src/classic/render/measure.js";

const ink = createInkTheme({ themeHint: "dark", colorMode: "none", unicode: true });

function state(overrides: Partial<SubagentsRuntimeState> = {}): SubagentsRuntimeState {
  return { enabled: true, running: 0, settled: 0, total: 0, ...overrides };
}

describe("subagents strip", () => {
  it("hides itself until there is a subagent run", () => {
    expect(subagentsVisible(state())).toBe(false);
    expect(subagentsVisible(state({ total: 1, settled: 1 }))).toBe(true);
  });

  it("reports running and settled work with the inspector hint", () => {
    const row = plainText(
      subagentsRow({ ink, columns: 120, state: state({ running: 2, settled: 3, total: 5 }) }),
    );
    expect(row).toBe("◆ 2 running · 3 done · /agents");
  });

  it("stays inside the available width", () => {
    for (const columns of [1, 8, 20, 40, 80]) {
      const row = subagentsRow({
        ink,
        columns,
        state: state({ running: 2, settled: 3, total: 5 }),
      });
      expect(displayWidth(row)).toBeLessThanOrEqual(columns);
    }
  });
});
