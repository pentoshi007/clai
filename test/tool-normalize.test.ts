import { describe, expect, it } from "vitest";
import { normalizeToolCall } from "../src/tools/registry.js";

describe("normalizeToolCall — unknown CLI names → shell.exec", () => {
  it("reroutes a bare command name, prefixing the binary", () => {
    const out = normalizeToolCall({
      name: "sed",
      args: { command: "-i 's/a/b/' file.txt" },
    });
    expect(out.name).toBe("shell.exec");
    expect(out.args.command).toBe("sed -i 's/a/b/' file.txt");
  });

  it("does not double the binary when command already includes it", () => {
    const out = normalizeToolCall({
      name: "sed",
      args: { command: "sed -i 's/a/b/' file.txt" },
    });
    expect(out.name).toBe("shell.exec");
    expect(out.args.command).toBe("sed -i 's/a/b/' file.txt");
  });

  it("recovers a command from an 'args' field", () => {
    const out = normalizeToolCall({
      name: "awk",
      args: { args: "'{print $1}' data.txt" },
    });
    expect(out.name).toBe("shell.exec");
    expect(out.args.command).toBe("awk '{print $1}' data.txt");
  });

  it("falls back to joining scalar arg values in order", () => {
    const out = normalizeToolCall({
      name: "grep",
      args: { pattern: "TODO", path: "src" },
    });
    expect(out.name).toBe("shell.exec");
    expect(out.args.command).toBe("grep TODO src");
  });

  it("handles an argv array", () => {
    const out = normalizeToolCall({
      name: "git",
      args: { argv: ["log", "--oneline", "-5"] },
    });
    expect(out.name).toBe("shell.exec");
    expect(out.args.command).toBe("git log --oneline -5");
  });

  it("passes through cwd and timeoutMs", () => {
    const out = normalizeToolCall({
      name: "ls",
      args: { command: "-la", cwd: "/tmp", timeoutMs: 5000 },
    });
    expect(out.name).toBe("shell.exec");
    expect(out.args.command).toBe("ls -la");
    expect(out.args.cwd).toBe("/tmp");
    expect(out.args.timeoutMs).toBe(5000);
  });

  it("leaves a name-only command runnable", () => {
    const out = normalizeToolCall({ name: "whoami", args: {} });
    expect(out.name).toBe("shell.exec");
    expect(out.args.command).toBe("whoami");
  });

  it("leaves registered tools untouched", () => {
    const call = { name: "fs.read", args: { path: "x" } };
    expect(normalizeToolCall(call)).toBe(call);
  });

  it("leaves an unknown NAMESPACED tool untouched (surfaces a real error)", () => {
    const call = { name: "fs.reed", args: { path: "x" } };
    const out = normalizeToolCall(call);
    expect(out.name).toBe("fs.reed");
  });
});
