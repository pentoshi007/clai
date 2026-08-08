import { describe, expect, it } from "vitest";
import {
  normalizeBatchToolName,
  normalizeToolCall,
  runToolCall,
  unknownToolErrorMessage,
} from "../src/tools/registry.js";

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

  it("routes grep scalars to fs.search without synthesizing shell text (SEC-005)", () => {
    const out = normalizeToolCall({
      name: "grep",
      args: { pattern: "TODO", path: "src" },
    });
    expect(out.name).toBe("fs.search");
    expect(out.args).toEqual({ pattern: "TODO", path: "src" });
  });

  it("refuses content-shaped calls that would inject shell metacharacters", () => {
    for (const args of [
      { content: "hi; rm -rf /" },
      { path: "a.txt", content: "$(id)" },
      { body: "`id`" },
      { text: "x && curl evil" },
      { patch: "@@ -1 +1 @@" },
      { path: "a.txt", new_str: "b", old_str: "a" },
    ]) {
      const out = normalizeToolCall({ name: "write_file", args });
      expect(out.name).toBe("write_file");
      expect(out.args.command).toBeUndefined();
    }
  });

  it("shell-quotes argv elements that contain metacharacters", () => {
    const out = normalizeToolCall({
      name: "echo",
      args: { argv: ["hello world", "a;rm -rf /", "plain"] },
    });
    expect(out.name).toBe("shell.exec");
    expect(out.args.command).toBe(
      "echo 'hello world' 'a;rm -rf /' plain",
    );
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

  it("canonicalizes shell_exec and unwraps an object input envelope", () => {
    const out = normalizeToolCall({
      name: "shell_exec",
      args: { input: { command: "ls -la", cwd: "/tmp" } },
    });
    expect(out).toEqual({
      name: "shell.exec",
      args: { command: "ls -la", cwd: "/tmp" },
    });
  });

  it("unwraps JSON-string argument envelopes for canonical tools", () => {
    const out = normalizeToolCall({
      name: "fs.read",
      args: { arguments: '{"path":"x.ts"}' },
    });
    expect(out).toEqual({ name: "fs.read", args: { path: "x.ts" } });
  });

  it("unwraps object parameter envelopes after wire-name canonicalization", () => {
    const out = normalizeToolCall({
      name: "fs_list",
      args: { parameters: { path: "src" } },
    });
    expect(out).toEqual({ name: "fs.list", args: { path: "src" } });
  });

  it("does not unwrap an envelope when it is a legitimate sibling field", () => {
    const call = {
      name: "fs.write",
      args: { path: "x.json", input: { nested: true } },
    };
    expect(normalizeToolCall(call)).toBe(call);
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

describe("normalizeToolCall — runner meta tools", () => {
  it("maps underscore wire names of runner meta tools to canonical dots", () => {
    for (const [wire, canonical] of [
      ["task_update", "task.update"],
      ["task_add", "task.add"],
      ["task_move", "task.move"],
      ["task_read", "task.read"],
      ["plan_create", "plan.create"],
      ["job_read", "job.read"],
      ["agent_handoff", "agent.handoff"],
      ["loop_reset", "loop.reset"],
    ] as const) {
      const out = normalizeToolCall({ name: wire, args: { note: "x" } });
      expect(out.name).toBe(canonical);
    }
  });

  it("keeps args when canonicalizing meta tools", () => {
    const out = normalizeToolCall({
      name: "task_update",
      args: { taskId: "t2", state: "done" },
    });
    expect(out).toEqual({
      name: "task.update",
      args: { taskId: "t2", state: "done" },
    });
  });

  it("normalizeBatchToolName canonicalizes meta tool wire names", () => {
    expect(normalizeBatchToolName("task_update")).toBe("task.update");
    expect(normalizeBatchToolName("fs_read")).toBe("fs.read");
    expect(normalizeBatchToolName("task.update")).toBe("task.update");
  });
});

describe("unknown tool errors", () => {
  it("runToolCall rejects with the available tool list", async () => {
    await expect(
      runToolCall({ name: "fs.reed", args: { path: "x" } }),
    ).rejects.toThrow(/Unknown tool: fs\.reed/);
    await expect(
      runToolCall({ name: "fs.reed", args: { path: "x" } }),
    ).rejects.toThrow(/Available tools: .*fs\.read/);
    await expect(
      runToolCall({ name: "fs.reed", args: { path: "x" } }),
    ).rejects.toThrow(/task\.update/);
  });

  it("unknownToolErrorMessage explains the dotted format and lists tools", () => {
    const message = unknownToolErrorMessage("task_updat");
    expect(message).toContain("Unknown tool: task_updat");
    expect(message).toContain("task.update, not task_update");
    expect(message).toContain("Available tools:");
    expect(message).toContain("task.update");
    expect(message).toContain("shell.exec");
  });
});
