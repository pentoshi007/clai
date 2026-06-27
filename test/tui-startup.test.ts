import { describe, expect, it } from "vitest";
import { TUI_ENTER_SEQUENCE, TUI_EXIT_SEQUENCE } from "../src/tui/index.js";
import { DISABLE_MOUSE_REPORTING, ENABLE_MOUSE_REPORTING } from "../src/tui/mouse.js";

describe("TUI terminal startup sequences", () => {
  it("does not capture the mouse globally so native text selection/copy keeps working", () => {
    // Some terminals translate trackpad scroll to arrow keys unless mouse
    // reporting is enabled, but enabling it breaks ordinary selection/copy.
    // clai keeps copy/select native and reserves Up/Down for prompt history.
    expect(TUI_ENTER_SEQUENCE).not.toContain("\x1b[?1000h");
    expect(TUI_ENTER_SEQUENCE).not.toContain("\x1b[?1006h");
    expect(TUI_EXIT_SEQUENCE).toContain("\x1b[?1006l");
    expect(TUI_EXIT_SEQUENCE).toContain("\x1b[?1000l");
  });

  it("exposes explicit mouse-reporting toggles for touchpad chat scrolling", () => {
    expect(ENABLE_MOUSE_REPORTING).toContain("\x1b[?1002h");
    expect(ENABLE_MOUSE_REPORTING).toContain("\x1b[?1006h");
    expect(DISABLE_MOUSE_REPORTING).toContain("\x1b[?1006l");
    expect(DISABLE_MOUSE_REPORTING).toContain("\x1b[?1002l");
  });
});
