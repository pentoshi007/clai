import { describe, expect, it } from "vitest";
import {
  isV2Requested,
  resolveUiChoice,
} from "../../src/tui-v2/bootstrap/ui-selection.js";

describe("isV2Requested", () => {
  it("is true only for explicit --ui=v2", () => {
    expect(isV2Requested({ ui: "v2" }, {})).toBe(true);
    expect(isV2Requested({ ui: "V2" }, {})).toBe(true);
  });

  it("is true for CLAI_UI=v2 when no overriding flag", () => {
    expect(isV2Requested({}, { CLAI_UI: "v2" })).toBe(true);
  });

  it("is false by default", () => {
    expect(isV2Requested({}, {})).toBe(false);
  });

  it("an explicit non-v2 --ui flag overrides CLAI_UI=v2", () => {
    expect(isV2Requested({ ui: "legacy" }, { CLAI_UI: "v2" })).toBe(false);
    expect(isV2Requested({ ui: "tui" }, { CLAI_UI: "v2" })).toBe(false);
  });
});

describe("resolveUiChoice", () => {
  it("never returns v2 without opt-in (default stays legacy/tui)", () => {
    expect(resolveUiChoice({}, {})).toBe("tui");
    expect(resolveUiChoice({ classic: true }, {})).toBe("legacy");
  });

  it("honors --ui=v2 and CLAI_UI=v2", () => {
    expect(resolveUiChoice({ ui: "v2" }, {})).toBe("v2");
    expect(resolveUiChoice({}, { CLAI_UI: "v2" })).toBe("v2");
  });

  it("maps explicit flags", () => {
    expect(resolveUiChoice({ ui: "legacy" }, {})).toBe("legacy");
    expect(resolveUiChoice({ ui: "classic" }, {})).toBe("legacy");
    expect(resolveUiChoice({ ui: "tui" }, {})).toBe("tui");
  });

  it("explicit --ui wins over CLAI_UI", () => {
    expect(resolveUiChoice({ ui: "legacy" }, { CLAI_UI: "v2" })).toBe("legacy");
  });
});
