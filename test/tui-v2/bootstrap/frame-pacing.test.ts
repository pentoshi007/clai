import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OPEN_TUI_FRAME_PACING } from "../../../src/tui-v2/bootstrap/frame-pacing.js";

describe("OpenTUI frame pacing", () => {
  it("caps active animation and input frames at 60 FPS", () => {
    expect(OPEN_TUI_FRAME_PACING).toEqual({ targetFps: 60, maxFps: 60 });
  });

  it.each(["start-tui-v2.ts", "runtime-view.ts"])("keeps %s on demand with the same frame cap", (file) => {
    const source = readFileSync(`src/tui-v2/bootstrap/${file}`, "utf8");
    expect(source).toContain("...OPEN_TUI_FRAME_PACING,");
    expect(source).not.toContain("renderer.start(");
    expect(source).not.toContain("renderer.requestLive(");
  });
});
