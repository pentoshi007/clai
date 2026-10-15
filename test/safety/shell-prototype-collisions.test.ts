import { describe, expect, it } from "vitest";
import { classifyInteractiveInput, classifyShellCommand } from "../../src/safety/shell-classification.js";
import { commandHasStatefulSysadminArg, commandIsScannerOnly } from "../../src/safety/patterns.js";

const prototypeNames = Object.getOwnPropertyNames(Object.prototype);

describe("shell command lookup boundaries", () => {
  it("classifies the exact interactive property counterexample", () => {
    const command = "isPrototypeOf  !";
    expect(classifyShellCommand(command).level).toBe("safe");
    expect(classifyInteractiveInput({
      ownerId: "owner",
      sessionId: "session",
      transport: "pipe",
      input: { kind: "text", text: command, submit: "enter" },
    }).level).toBe("safe");
  });

  it.each(prototypeNames)("does not treat %s as a registered command", (base) => {
    expect(classifyShellCommand(`${base} !`)).toEqual({
      level: "safe",
      reason: "Non-mutating command",
    });
  });

  it.each(prototypeNames)("does not treat %s as a network command", (base) => {
    expect(commandHasStatefulSysadminArg(`${base} !`)).toBe(false);
  });

  it.each(prototypeNames)("does not treat %s as scanner-only", (base) => {
    expect(commandIsScannerOnly(`nmap 192.0.2.1 && ${base} !`)).toBe(false);
  });

  it.each([
    ["git status", "safe"],
    ["npm view @pentoshi/clai version", "safe"],
    ["npm install example", "confirm"],
    ["ip addr show", "safe"],
    ["ip link set eth0 down", "confirm"],
    ["rm -rf /", "block"],
  ])("preserves %s classification", (command, level) => {
    expect(classifyShellCommand(command).level).toBe(level);
  });
});
