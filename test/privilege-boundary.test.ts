import { describe, expect, it } from "vitest";
import { runToolCall } from "../src/tools/registry.js";
import { getAllowInteractiveStdinInherit } from "../src/tools/shell.js";

describe("universal managed privilege boundary", () => {
  it("disables unmanaged inherited password prompts by default in every frontend", async () => {
    expect(getAllowInteractiveStdinInherit()).toBe(false);
    const result = await runToolCall({ name: "shell.exec", args: { command: "sudo whoami" } });
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.output).toMatch(/secure password modal|run without elevation/);
    expect(result.output).not.toMatch(/Password:/);
  });

  it("does not echo a cancelled SecretPort value into results", async () => {
    const secret = "never-log-this-password";
    const result = await runToolCall(
      { name: "shell.exec", args: { command: "sudo whoami" } },
      { requestSecret: async () => { void secret; return undefined; } },
    );
    if (process.platform === "win32") {
      expect(result).toMatchObject({ ok: false, exitCode: 1 });
    } else {
      expect(result).toMatchObject({ ok: false, exitCode: 130 });
    }
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("sudo stdin privilege boundary", () => {
  it("does not let bare sudo -S bypass the managed password prompt", async () => {
    const result = await runToolCall({
      name: "shell.exec",
      args: { command: "sudo -S whoami", background: "never" },
    });

    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.output).toMatch(/secure password modal|run without elevation/);
    expect(result.output).not.toMatch(/Password:/);
  });
});
