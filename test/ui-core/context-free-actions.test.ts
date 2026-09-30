import { describe, expect, it } from "vitest";
import { ActionRouter } from "../../src/ui-core/actions/action-router.js";
import { resolveContextFreeAction } from "../../src/ui-core/actions/context-free.js";

describe("context-free actions", () => {
  const router = new ActionRouter();

  it("resolves the redraw key regardless of which surface owns the keyboard", () => {
    expect(resolveContextFreeAction(router, "f5")).toBe("app.redraw");
  });

  it("leaves every other binding to its own context", () => {
    for (const chord of ["ctrl+c", "escape", "enter", "tab", "ctrl+r", "shift+tab", "f6", "r"]) {
      expect(resolveContextFreeAction(router, chord), chord).toBeUndefined();
    }
  });
});
