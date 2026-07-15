import { describe, expect, it } from "vitest";
import {
  UI_CUTOVER_STAGE,
  describeUiDefault,
  isV2Requested,
  resolveUiChoice,
  type UiCutoverStage,
} from "../../src/tui-v2/bootstrap/ui-selection.js";

describe("isV2Requested", () => {
  it("is true only for explicit --ui=v2 under opt-in stage", () => {
    expect(isV2Requested({ ui: "v2" }, {}, "opt-in")).toBe(true);
    expect(isV2Requested({ ui: "V2" }, {}, "opt-in")).toBe(true);
  });

  it("is true for CLAI_UI=v2 when no overriding flag", () => {
    expect(isV2Requested({}, { CLAI_UI: "v2" }, "opt-in")).toBe(true);
  });

  it("is false by default under opt-in", () => {
    expect(isV2Requested({}, {}, "opt-in")).toBe(false);
  });

  it("an explicit non-v2 --ui flag overrides CLAI_UI=v2", () => {
    expect(isV2Requested({ ui: "legacy" }, { CLAI_UI: "v2" }, "opt-in")).toBe(false);
    expect(isV2Requested({ ui: "tui" }, { CLAI_UI: "v2" }, "opt-in")).toBe(false);
  });
});

describe("resolveUiChoice (V2-100 / V2-102)", () => {
  it("production stage remains opt-in until dogfood flips the constant", () => {
    expect(UI_CUTOVER_STAGE).toBe("opt-in");
    expect(resolveUiChoice({}, {})).toBe("tui");
    expect(isV2Requested({}, {})).toBe(false);
  });

  it("never returns v2 without opt-in under opt-in stage", () => {
    expect(resolveUiChoice({}, {}, "opt-in")).toBe("tui");
    expect(resolveUiChoice({ classic: true }, {}, "opt-in")).toBe("legacy");
  });

  it("honors --ui=v2 and CLAI_UI=v2", () => {
    expect(resolveUiChoice({ ui: "v2" }, {}, "opt-in")).toBe("v2");
    expect(resolveUiChoice({}, { CLAI_UI: "v2" }, "opt-in")).toBe("v2");
  });

  it("maps explicit flags and env aliases", () => {
    expect(resolveUiChoice({ ui: "legacy" }, {}, "opt-in")).toBe("legacy");
    expect(resolveUiChoice({ ui: "classic" }, {}, "opt-in")).toBe("legacy");
    expect(resolveUiChoice({ ui: "tui" }, {}, "opt-in")).toBe("tui");
    expect(resolveUiChoice({}, { CLAI_UI: "legacy" }, "opt-in")).toBe("legacy");
    expect(resolveUiChoice({}, { CLAI_UI: "tui" }, "opt-in")).toBe("tui");
  });

  it("explicit --ui wins over CLAI_UI", () => {
    expect(resolveUiChoice({ ui: "legacy" }, { CLAI_UI: "v2" }, "opt-in")).toBe("legacy");
    expect(resolveUiChoice({ ui: "tui" }, { CLAI_UI: "v2" }, "opt-in")).toBe("tui");
  });

  it("honors classic env opt-outs", () => {
    expect(resolveUiChoice({}, { CLAI_CLASSIC: "1" }, "opt-in")).toBe("legacy");
    expect(resolveUiChoice({}, { CLAI_TUI: "0" }, "opt-in")).toBe("legacy");
  });

  it("default-v2 stage makes v2 the default with legacy/tui rollback", () => {
    const stage: UiCutoverStage = "default-v2";
    expect(resolveUiChoice({}, {}, stage)).toBe("v2");
    expect(isV2Requested({}, {}, stage)).toBe(true);
    expect(resolveUiChoice({ ui: "legacy" }, {}, stage)).toBe("legacy");
    expect(resolveUiChoice({ ui: "tui" }, {}, stage)).toBe("tui");
    expect(resolveUiChoice({}, { CLAI_UI: "legacy" }, stage)).toBe("legacy");
    expect(resolveUiChoice({ classic: true }, {}, stage)).toBe("legacy");
    expect(resolveUiChoice({}, { CLAI_CLASSIC: "1" }, stage)).toBe("legacy");
  });

  it("describeUiDefault matches stage", () => {
    expect(describeUiDefault("opt-in")).toMatch(/opt in/i);
    expect(describeUiDefault("default-v2")).toMatch(/opt out/i);
  });
});
