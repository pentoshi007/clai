import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ALT_SCREEN_OFF,
  AltScreenTracker,
} from "../../src/session-runtime/alt-screen.js";
import { terminalRestoreSequence } from "../../src/session-runtime/client.js";

const ATTACH_RESET = "\u001b[?1049h\u001b[H\u001b[J";

describe("relayed alternate-screen tracking", () => {
  it("clears the attaching terminal with erase-to-end so a reattach cannot push a stale frame into scrollback", () => {
    const attachReset = readFileSync(
      new URL("../../src/session-runtime/host.ts", import.meta.url),
      "utf8",
    );
    expect(attachReset).toContain('"\\u001b[?1049h\\u001b[H\\u001b[J"');
    expect(attachReset).not.toContain("\\u001b[2J");
  });

  it("follows enter and leave transitions across the relayed stream", () => {
    const tracker = new AltScreenTracker();
    expect(tracker.isActive).toBe(false);

    tracker.observe(ATTACH_RESET);
    expect(tracker.isActive).toBe(true);

    tracker.observe("\u001b[?1049h");
    tracker.observe("FULLSCREEN FRAME");
    expect(tracker.isActive).toBe(true);

    tracker.observe("\u001b[?1049l");
    expect(tracker.isActive).toBe(false);
  });

  it("detects a transition split across relay chunk boundaries", () => {
    const tracker = new AltScreenTracker();
    tracker.observe(ATTACH_RESET);

    tracker.observe(Buffer.from("frame tail\u001b[?10", "utf8"));
    expect(tracker.isActive).toBe(true);
    tracker.observe(Buffer.from("49l", "utf8"));
    expect(tracker.isActive).toBe(false);
  });

  it("stays accurate for legacy modes, multi-parameter sets, and repeated scans", () => {
    const tracker = new AltScreenTracker();
    tracker.observe("\u001b[?47h");
    expect(tracker.isActive).toBe(true);
    tracker.observe("\u001b[?47l");
    expect(tracker.isActive).toBe(false);

    tracker.observe("\u001b[?1047h");
    expect(tracker.isActive).toBe(true);

    tracker.observe("\u001b[?25;1049l");
    expect(tracker.isActive).toBe(false);

    tracker.observe("");
    tracker.observe("plain output with no private modes");
    expect(tracker.isActive).toBe(false);
  });

  it("ignores unrelated private modes and UTF-8 payload bytes", () => {
    const tracker = new AltScreenTracker();
    tracker.observe(ATTACH_RESET);
    tracker.observe("\u001b[?25l\u001b[?1002h\u001b[?2004h");
    expect(tracker.isActive).toBe(true);
    tracker.observe(Buffer.from("café 日本語 ✅ ✻ Worked for 1m16s", "utf8"));
    expect(tracker.isActive).toBe(true);
  });
});

describe("client terminal restore sequence", () => {
  it("omits alternate-screen exit once the child already returned to the normal screen", () => {
    const tracker = new AltScreenTracker();
    tracker.observe(ATTACH_RESET);
    tracker.observe("\u001b[?1049h");
    tracker.observe("\u001b[?1049l");
    tracker.observe("clai sign-off card\r\n");

    const restore = terminalRestoreSequence(tracker.isActive);
    expect(restore).not.toContain("1049");
    expect(restore).not.toContain(ALT_SCREEN_OFF);
    expect(restore).toContain("\u001b[?25h");
    expect(restore).toContain("\u001b[?2004l");
    expect(restore).toContain("\u001b[?1002l");
  });

  it("still leaves the alternate screen when a detach interrupts a live full-screen UI", () => {
    const tracker = new AltScreenTracker();
    tracker.observe(ATTACH_RESET);
    tracker.observe("live frame while the agent is working");

    const restore = terminalRestoreSequence(tracker.isActive);
    expect(restore.endsWith(ALT_SCREEN_OFF)).toBe(true);
    expect(restore).toContain("\u001b[?25h");
  });
});
