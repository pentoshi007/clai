import { describe, expect, it } from "vitest";
import { pagerCommandTone, pagerCommandColor } from "../../../src/ui-core/rendering/pager-regions.js";
import { themeFor } from "../../../src/ui-core/rendering/theme.js";

describe("pager command status colors", () => {
  it.each(["queued", "running", "starting", "stopping"] as const)("keeps %s yellow", (status) => {
    expect(pagerCommandTone(status)).toBe("running");
  });

  it.each(["failed", "blocked", "killed", "lost"] as const)("marks %s red", (status) => {
    expect(pagerCommandTone(status)).toBe("failed");
  });

  it("only marks successful results green", () => {
    expect(pagerCommandTone("ok")).toBe("success");
    expect(pagerCommandTone("exited", 0)).toBe("success");
    expect(pagerCommandTone("exited", 1)).toBe("failed");
    expect(pagerCommandTone("exited")).toBe("failed");
    expect(pagerCommandTone(undefined)).toBe("running");
  });

  it.each(["dark", "light"] as const)("uses semantic colors in the %s theme", (hint) => {
    const theme = themeFor(hint);
    expect(pagerCommandColor("success")).toBe("success");
    expect(theme[pagerCommandColor("running")]).toBe(theme.userBorder);
    expect(theme[pagerCommandColor("failed")]).toBe(theme.diffDel);
  });
});
