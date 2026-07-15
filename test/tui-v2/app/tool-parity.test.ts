import { describe, expect, it } from "vitest";
import { availableToolNames } from "../../../src/tools/registry.js";
import { presentTool } from "../../../src/tui-v2/rendering/tool-presenter.js";
import type { ToolItem } from "../../../src/tui-v2/state/transcript-types.js";
import { asToolCallId, asTurnId } from "../../../src/app/events/app-event.js";

/** FEATURE_PARITY "Tool registry parity" minimum set (V2-082). */
const REQUIRED_TOOLS = [
  "shell.exec",
  "shell.start",
  "shell.jobs",
  "shell.tail",
  "shell.stop",
  "fs.read",
  "fs.list",
  "fs.search",
  "fs.write",
  "fs.writeMany",
  "fs.edit",
  "fs.replaceLines",
  "fs.delete",
  "pkg.install",
  "net.scan",
  "net.context",
  "net.pingSweep",
  "http.fetch",
  "web.search",
  "web.fetch",
  "dns.lookup",
  "whois.lookup",
  "pentest.recon",
  "tool.batch",
  "tool.check",
  "wordlist.find",
  "image.ocr",
  "pdf.read",
] as const;

function toolItem(name: string, overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    id: `tool-${name}`,
    sequence: 1,
    turnId: asTurnId("turn-1"),
    timestamp: 0,
    kind: "tool",
    toolCallId: asToolCallId(`call-${name}`),
    name,
    argsDisplay: "…",
    status: "ok",
    exitCode: 0,
    summary: "done",
    artifactPath: undefined,
    reason: undefined,
    outputBytes: 0,
    ...overrides,
  };
}

describe("tool registry parity for v2 (V2-082)", () => {
  it("registers every tool listed in FEATURE_PARITY", () => {
    const names = new Set(availableToolNames());
    const missing = REQUIRED_TOOLS.filter((name) => !names.has(name));
    expect(missing).toEqual([]);
  });

  it("presents every required tool shape without throwing", () => {
    for (const name of REQUIRED_TOOLS) {
      const presented = presentTool(toolItem(name));
      expect(presented.name).toContain(name);
      expect(presented.statusLabel.length).toBeGreaterThan(0);
    }
    const blocked = presentTool(
      toolItem("shell.exec", {
        status: "blocked",
        reason: "awaiting approval",
        summary: undefined,
        exitCode: undefined,
      }),
    );
    expect(blocked.statusLabel.toLowerCase()).toContain("block");
  });
});
