import { describe, expect, it } from "vitest";
import { pendingRuntimeInputCommand, runtimeInputCommand } from "../../src/session-runtime/input-commands.js";

describe("shared session terminal shortcuts", () => {
  it.each(["\x1d", "\x1b[93;5u", "\x1b[93;5:1u", "\x1b[93;5:2u", "\x1b[27;5;93~"])("recognizes Ctrl+] in %j", (input) => {
    expect(runtimeInputCommand(input)).toBe("claim-input");
  });

  it.each(["\x03", "\x1b[99;5u", "\x1b[67;5u", "\x1b[99;5:1u", "\x1b[27;5;99~"])("recognizes observer Ctrl+C in %j", (input) => {
    expect(runtimeInputCommand(input)).toBe("detach");
  });

  it("retains only partial shortcut sequences and ignores releases, queries, and pasted text", () => {
    for (const fragment of ["\x1b", "\x1b[", "\x1b[93;5", "\x1b[93;5:"]) expect(pendingRuntimeInputCommand(fragment)).toBe(true);
    for (const text of ["", "a", "\x1b[93;5:3u", "\x1b[?1;2c", "\x1b[12;40R", "\x1b[200~\x1d\x1b[201~"]) {
      expect(runtimeInputCommand(text)).toBeUndefined();
      expect(pendingRuntimeInputCommand(text)).toBe(false);
    }
  });
});
