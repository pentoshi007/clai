import { describe, expect, it } from "vitest";
import { TerminalModeState } from "../../src/session-runtime/terminal-modes.js";

describe("terminal mode restoration across reattach", () => {
  it("re-emits mouse reporting, bracketed paste, and alternate screen the child enabled", () => {
    const modes = new TerminalModeState();
    modes.observe("\u001b[?1049h");
    modes.observe("\u001b[?1000h\u001b[?1002h\u001b[?1006h");
    modes.observe("\u001b[?2004h");

    const restore = modes.restoreSequence();
    expect(restore).toContain("\u001b[?1049h");
    expect(restore).toContain("\u001b[?1000h");
    expect(restore).toContain("\u001b[?1006h");
    expect(restore).toContain("\u001b[?2004h");
  });

  it("does not re-emit a mode the child later disabled", () => {
    const modes = new TerminalModeState();
    modes.observe("\u001b[?1000h\u001b[?2004h");
    modes.observe("\u001b[?1000l");

    const active = modes.enabledModes();
    expect(active).not.toContain("1000");
    expect(active).toContain("2004");
    expect(modes.restoreSequence()).not.toContain("\u001b[?1000h");
  });

  it("honors multi-parameter mode sets and the newest state wins", () => {
    const modes = new TerminalModeState();
    modes.observe("\u001b[?1000;1002;1003;1006h");
    modes.observe("\u001b[?1002;1003l");

    const active = modes.enabledModes();
    expect(active).toContain("1000");
    expect(active).toContain("1006");
    expect(active).not.toContain("1002");
    expect(active).not.toContain("1003");
  });

  it("detects a mode toggle split across relay chunk boundaries", () => {
    const modes = new TerminalModeState();
    modes.observe(Buffer.from("frame tail\u001b[?10", "utf8"));
    modes.observe(Buffer.from("06h", "utf8"));
    expect(modes.enabledModes()).toContain("1006");
  });

  it("ignores private modes it should not restore and non-escape payload", () => {
    const modes = new TerminalModeState();
    modes.observe("\u001b[?2026h");
    modes.observe(Buffer.from("café 日本語 ✅ plain text", "utf8"));
    expect(modes.enabledModes()).toEqual([]);
    expect(modes.restoreSequence()).toBe("");
  });

  it("orders alternate screen ahead of mouse and paste modes", () => {
    const modes = new TerminalModeState();
    modes.observe("\u001b[?2004h\u001b[?1006h\u001b[?1049h");
    expect(modes.enabledModes()[0]).toBe("1049");
  });
});
