import { describe, expect, it, vi } from "vitest";

const spawnSpy = vi.fn();
const execSpy = vi.fn();
const execFileSpy = vi.fn();
const execSyncSpy = vi.fn(() => Buffer.from(""));
const spawnSyncSpy = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return {
    ...actual,
    default: actual,
    spawn: spawnSpy,
    exec: execSpy,
    execFile: execFileSpy,
    execSync: execSyncSpy,
    spawnSync: spawnSyncSpy,
  };
});

const { classifyToolCall } = await import("../../src/safety/classifier.js");

const INJECTIONS = [
  "node; touch /tmp/clai-pwned",
  "node && rm -rf /",
  "node $(id)",
  "node `id`",
  "node | tee /tmp/x",
  'node" & calc.exe &"',
  "node\nid",
  "../../bin/sh",
  "/bin/sh",
  "node & whoami",
];

describe("SEC-001 classifier never executes model-controlled text", () => {
  it("launches no child process while classifying pkg.install", () => {
    for (const checkBinary of INJECTIONS) {
      const decision = classifyToolCall({
        name: "pkg.install",
        args: { tool: "nmap", checkBinary },
      });
      expect(decision.level).toBe("confirm");
    }
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(execSpy).not.toHaveBeenCalled();
    expect(execFileSpy).not.toHaveBeenCalled();
    expect(execSyncSpy).not.toHaveBeenCalled();
    expect(spawnSyncSpy).not.toHaveBeenCalled();
  });

  it("confirms when the binary is genuinely missing", () => {
    const decision = classifyToolCall({
      name: "pkg.install",
      args: { tool: "definitely-not-a-real-binary-xyz" },
    });
    expect(decision.level).toBe("confirm");
  });
});
