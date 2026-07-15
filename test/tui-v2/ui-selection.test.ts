import { describe, expect, it } from "vitest";
import {
  describeUiDefault,
  isTuiRequested,
  isV2Requested,
  resolveUiChoice,
} from "../../src/tui-v2/bootstrap/ui-selection.js";

describe("resolveUiChoice (3.x OpenTUI default)", () => {
  it("defaults to full-screen TUI", () => {
    expect(resolveUiChoice({}, {})).toBe("tui");
    expect(isTuiRequested({}, {})).toBe(true);
    expect(isV2Requested({}, {})).toBe(true);
  });

  it("maps tui / v2 / opentui aliases to tui", () => {
    expect(resolveUiChoice({ ui: "tui" }, {})).toBe("tui");
    expect(resolveUiChoice({ ui: "v2" }, {})).toBe("tui");
    expect(resolveUiChoice({ ui: "opentui" }, {})).toBe("tui");
    expect(resolveUiChoice({}, { CLAI_UI: "v2" })).toBe("tui");
    expect(resolveUiChoice({}, { CLAI_UI: "tui" })).toBe("tui");
  });

  it("maps legacy / classic to line REPL", () => {
    expect(resolveUiChoice({ ui: "legacy" }, {})).toBe("legacy");
    expect(resolveUiChoice({ ui: "classic" }, {})).toBe("legacy");
    expect(resolveUiChoice({ classic: true }, {})).toBe("legacy");
    expect(resolveUiChoice({}, { CLAI_UI: "legacy" })).toBe("legacy");
    expect(resolveUiChoice({}, { CLAI_CLASSIC: "1" })).toBe("legacy");
    expect(resolveUiChoice({}, { CLAI_TUI: "0" })).toBe("legacy");
  });

  it("explicit --ui wins over CLAI_UI", () => {
    expect(resolveUiChoice({ ui: "legacy" }, { CLAI_UI: "v2" })).toBe("legacy");
    expect(resolveUiChoice({ ui: "tui" }, { CLAI_UI: "legacy" })).toBe("tui");
  });

  it("describeUiDefault mentions OpenTUI", () => {
    expect(describeUiDefault()).toMatch(/OpenTUI/i);
  });
});
