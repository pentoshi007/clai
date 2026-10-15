import { describe, expect, it } from "vitest";
import type { SubagentRun } from "../../../src/agent/subagents/types.js";
import { formatSubagentRun } from "../../../src/ui-core/rendering/subagent-source.js";
import { subagentReadUsage, subagentToolUsage } from "../../../src/ui-core/rendering/subagent-tool-usage.js";
import { TOOL_USAGE_LINE, toolUsageLabel } from "../../../src/ui-core/rendering/tool-usage-label.js";

function call(name: string, args: Record<string, unknown>): string {
  return `Calling ${name}: ${JSON.stringify(args)}`;
}

function snapshot(texts: readonly string[]): SubagentRun {
  return {
    id: "usage", parentSessionId: "parent", title: "Inspect usage", prompt: "Inspect tool usage",
    cwd: "/workspace", provider: "openai", model: "test", attempt: 1, status: "completed",
    createdAt: 1, updatedAt: 2,
    events: texts.map((text, sequence) => ({ kind: "tool", sequence, timestamp: sequence, text })),
    report: "Status: complete\nVerified report with evidence.",
  };
}

describe("compact subagent tool usage", () => {
  it.each([
    ["shell.exec", "Shell", { command: "printf '**literal** `input` <br>'" }, "printf '**literal** `input` <br>'"],
    ["web.search", "Searched the web", { query: "terminal UI" }, "terminal UI"],
    ["web.fetch", "Opened", { url: "https://example.test" }, "https://example.test"],
    ["http.fetch", "Fetched", { url: "https://example.test" }, "https://example.test"],
    ["fs.edit", "Edited", { path: "src/main.ts", newText: "PRIVATE_EDIT_BODY" }, "src/main.ts"],
    ["fs.write", "Wrote", { path: "src/main.ts", content: "PRIVATE_WRITE_BODY" }, "src/main.ts"],
    ["fs.append", "Appended", { path: "notes.md", content: "PRIVATE_APPEND_BODY" }, "notes.md"],
    ["fs.delete", "Deleted", { path: "notes.md" }, "notes.md"],
    ["pdf.read", "Read PDF", { path: "report.pdf", firstPage: 2 }, "report.pdf"],
    ["subagent.read", "Agent report", { id: "child", view: "report" }, "child · report"],
  ] as const)("uses the Classic label for %s", (name, label, args, input) => {
    const usage = subagentToolUsage(call(name, args));
    expect(usage).toBe(`→ ${label} ${input}`);
    expect(TOOL_USAGE_LINE.exec(usage!)?.[4]).toBe(label);
    expect(usage).not.toMatch(/PRIVATE_.*_BODY/);
  });

  it("matches longest multiword labels and safely falls back for unknown names", () => {
    expect(TOOL_USAGE_LINE.exec("✓ Wrote files 2 file(s): a, b")?.[4]).toBe("Wrote files");
    expect(TOOL_USAGE_LINE.exec("✓ Terminal output session")?.[4]).toBe("Terminal output");
    expect(toolUsageLabel("constructor")).toBe("constructor");
    expect(toolUsageLabel("isPrototypeOf")).toBe("isPrototypeOf");
    expect(toolUsageLabel("custom.inspect", "Inspector")).toBe("Inspector");
    expect(subagentToolUsage(call("custom.inspect", { id: "child" }))).toBe('→ custom.inspect {"id":"child"}');
    expect(subagentToolUsage("Success: PRIVATE_RESULT_BODY")).toBeUndefined();
  });

  it("shows only paths in single and multi-file read lists", () => {
    expect(subagentToolUsage(call("fs.read", { path: "docs/with spaces.md", offset: 12, limit: 20, pattern: "private" }))).toBe("→ Explored\n  └ Read docs/with spaces.md");
    expect(subagentToolUsage(call("fs.read", { path: "docs.md", startLine: 2, endLine: 9 }))).toBe("→ Explored\n  └ Read docs.md");
    expect(subagentToolUsage(call("fs.read", { files: [
      { path: "one.md", offset: 12, limit: 20 },
      { path: "日本語.md", pattern: "private", context: 3 },
    ] }))).toBe("→ Explored\n  └ Read one.md\n    Read 日本語.md");
  });

  it("previews the first logical input line and marks omitted multiline input", () => {
    const command = "printf '**literal**'\r\nprintf MULTILINE_INPUT_END";
    expect(subagentToolUsage(call("shell.exec", { command }))).toBe("→ Shell printf '**literal**' …");
    expect(subagentToolUsage(call("shell.exec", { command: "" }))).toBe("→ Shell");
  });

  it.each(["{PRIVATE_INPUT", "null", "[]", '"PRIVATE_INPUT"', "true"])("hides malformed input: %s", input => {
    expect(subagentToolUsage(`Calling shell.exec: ${input}`)).toBe("→ Shell [input unavailable]");
  });

  it("summarizes batches with named tools and no nested arguments or results", () => {
    const calls = ["shell.exec", "fs.read", "web.search", "web.fetch", "pdf.read"].map(name => ({ name, args: { secret: "PRIVATE_NESTED_INPUT" } }));
    expect(subagentToolUsage(call("tool.batch", { calls }))).toBe("→ Tools 5 call(s): Shell, Explored, Searched the web, Opened, …");
    expect(subagentToolUsage(call("tool.batch", { calls: [null, {}, { name: 1 }] }))).toBe("→ Tools 3 call(s)");
    expect(subagentToolUsage(call("tool.batch", {}))).toBe("→ Tools 0 call(s)");
  });

  it("redacts tool inputs and sanitizes terminal controls", () => {
    const usage = subagentToolUsage(call("shell.exec", { command: "printf gsk_FAKE_TEST_ONLY_123456\u001b[31mred\u001b[0m\u0000" }));
    expect(usage).toContain("gsk_••••••");
    expect(usage).not.toMatch(/FAKE_TEST_ONLY|\u001b|\u0000/);
    const read = subagentReadUsage([{ path: "\u001b[31mone.md\u001b[0m" }, { path: "missing.md", ok: false }]);
    expect(read).toEqual(["  └ Read one.md", "    Read ✗ missing.md"]);
  });
});

describe("usage-only activity", () => {
  it("omits success, failure and legacy result bodies while retaining report and failure status", () => {
    const run = { ...snapshot([
      call("shell.exec", { command: "inspect evidence" }), "Success: PRIVATE_SUCCESS_BODY",
      call("web.fetch", { url: "https://example.test" }), "Error: PRIVATE_ERROR_BODY",
      "Legacy PRIVATE_LEGACY_BODY",
      call("fs.read", { path: "secret.md" }), "Error: Tool denied: PRIVATE_DENIAL_BODY",
    ]), error: "Provider unavailable" };
    const original = JSON.stringify(run);
    const text = formatSubagentRun(run);
    expect(text).toContain("✓ Shell inspect evidence");
    expect(text).toContain("✗ Opened https://example.test\n  Failed");
    expect(text).toContain("✗ Explored\n  └ Read secret.md\n  Denied");
    expect(text).toContain("Verified report with evidence.");
    expect(text).toContain("Provider unavailable");
    expect(text).not.toMatch(/PRIVATE_.*_BODY|Success:|Error: Tool/);
    expect(JSON.stringify(run)).toBe(original);
  });

  it("retains orphan read usage and mixed failure markers but never file bodies", () => {
    const text = formatSubagentRun(snapshot([
      'Success: # fs.read file=1/2 path="one.md" status=ok\nPRIVATE_READ_BODY\n# end fs.read file=1/2\n\n# fs.read file=2/2 path="missing.md" status=failed\nPRIVATE_FAILED_BODY\n# end fs.read file=2/2',
    ]));
    expect(text).toContain("✗ Explored\n  └ Read one.md\n    Read ✗ missing.md");
    expect(text).not.toMatch(/PRIVATE_.*_BODY|# fs.read/);
  });

  it("preserves generic completion and failure status for orphan results", () => {
    expect(formatSubagentRun(snapshot(["Success: PRIVATE_RESULT_BODY"]))).toContain("✓ Read-only tool completed");
    expect(formatSubagentRun(snapshot(["Error: PRIVATE_RESULT_BODY"]))).toContain("✗ Tool failed");
    expect(formatSubagentRun(snapshot(["Error: Tool denied: PRIVATE_RESULT_BODY"]))).toContain("✗ Tool denied");
  });
});
