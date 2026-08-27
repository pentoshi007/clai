import { describe, expect, it } from "vitest";
import {
  assertDefinitionRegistryConsistency,
  canonicalNameFor,
  getToolDefinitions,
  TOOL_DEFINITIONS,
  wireNameFor,
} from "../../src/tools/definitions.js";
import { availableToolNames, toolRegistry } from "../../src/tools/registry.js";
import { fromWireName, toWireName } from "../../src/llm/tool-protocol.js";

describe("tool definitions", () => {
  it("every registry key has a definition", () => {
    expect(() =>
      assertDefinitionRegistryConsistency(availableToolNames()),
    ).not.toThrow();
  });

  it("wire names are unique and reverse-map (camel + snake aliases)", () => {
    const wires = new Set<string>();
    for (const d of TOOL_DEFINITIONS) {
      expect(wires.has(d.wireName)).toBe(false);
      wires.add(d.wireName);
      expect(d.wireName).toBe(toWireName(d.name));
      expect(fromWireName(d.wireName)).toBe(d.name);
      expect(canonicalNameFor(d.wireName)).toBe(d.name);
      expect(wireNameFor(d.name)).toBe(d.wireName);
    }
    // Models may emit pure snake_case for multi-word segments.
    expect(fromWireName("fs_write_many")).toBe("fs.writeMany");
    expect(fromWireName("fs_replace_lines")).toBe("fs.replaceLines");
    expect(fromWireName("net_ping_sweep")).toBe("net.pingSweep");
    expect(canonicalNameFor("fs_write_many")).toBe("fs.writeMany");
    expect(canonicalNameFor("fs_replace_lines")).toBe("fs.replaceLines");
    expect(canonicalNameFor("net_ping_sweep")).toBe("net.pingSweep");
  });

  it("ask mode excludes mutators", () => {
    const ask = getToolDefinitions({ askMode: true });
    expect(ask.every((d) => d.askMode)).toBe(true);
    expect(ask.some((d) => d.name === "fs.write")).toBe(false);
    expect(ask.some((d) => d.name === "web.search")).toBe(true);
  });

  it("core file tools have required fields matching handlers", () => {
    const write = TOOL_DEFINITIONS.find((d) => d.name === "fs.write")!;
    expect(write.parameters.required).toEqual(["path", "content"]);
    expect(toolRegistry["fs.write"]).toBeTypeOf("function");
  });

  it("task.update includes failed; agent.handoff is defined", () => {
    const task = TOOL_DEFINITIONS.find((d) => d.name === "task.update")!;
    const state = task.parameters.properties.state as {
      enum?: string[];
    };
    expect(state.enum).toContain("failed");
    const read = TOOL_DEFINITIONS.find((d) => d.name === "task.read")!;
    expect(read.parameters.required).toEqual(["notificationId"]);
    expect(read.mutates).toBe(true);
    const handoff = TOOL_DEFINITIONS.find((d) => d.name === "agent.handoff")!;
    expect(handoff.parameters.required).toEqual(["task", "reason"]);
    expect(handoff.askMode).toBeFalsy();
  });

  it("plan tools expose outcome criteria without prescribing tool steps", () => {
    const plan = TOOL_DEFINITIONS.find((d) => d.name === "plan.create")!;
    const tasks = plan.parameters.properties.tasks as {
      items?: { oneOf?: Array<Record<string, unknown>> };
    };
    const objectVariant = tasks.items?.oneOf?.find(
      (variant) => variant.type === "object",
    ) as { properties?: Record<string, unknown> } | undefined;
    expect(objectVariant?.properties).toHaveProperty("acceptanceCriteria");
    expect(objectVariant?.properties).toHaveProperty("dependencies");
    expect(objectVariant?.properties).toHaveProperty("resourceLocks");

    const add = TOOL_DEFINITIONS.find((d) => d.name === "task.add")!;
    expect(add.parameters.properties).toHaveProperty("acceptanceCriteria");
  });

  it("web.fetch responseMode enum matches runtime RESPONSE_MODES", () => {
    const fetch = TOOL_DEFINITIONS.find((d) => d.name === "web.fetch")!;
    const mode = fetch.parameters.properties.responseMode as {
      enum?: string[];
    };
    expect(mode.enum).toEqual(["readable", "raw"]);
  });

  it("tool.check schema uses tools not name", () => {
    const check = TOOL_DEFINITIONS.find((d) => d.name === "tool.check")!;
    expect(check.parameters.required).toEqual(["tools"]);
    expect(check.parameters.properties.tools).toBeDefined();
  });

  it("does not expose a generic execution deadline for shell.start", () => {
    const start = TOOL_DEFINITIONS.find((definition) => definition.name === "shell.start")!;
    const exec = TOOL_DEFINITIONS.find((definition) => definition.name === "shell.exec")!;
    expect(start.parameters.properties.timeoutMs).toBeUndefined();
    expect(exec.parameters.properties.timeoutMs).toBeDefined();
  });

  it("distinguishes finite, unattended, and prompt-driven execution tools", () => {
    const exec = TOOL_DEFINITIONS.find((definition) => definition.name === "shell.exec")!;
    const start = TOOL_DEFINITIONS.find((definition) => definition.name === "shell.start")!;
    const terminal = TOOL_DEFINITIONS.find(
      (definition) => definition.name === "terminal.start",
    )!;
    const send = TOOL_DEFINITIONS.find((definition) => definition.name === "terminal.send")!;

    expect(exec.description).toMatch(/finite shell command/i);
    expect(exec.description).toMatch(/shell\.start for persistent servers/i);
    expect(start.description).toMatch(/persistent server\/watcher\/listener/i);
    expect(start.description).toMatch(/readiness probe/i);
    expect(terminal.description).toMatch(/interactive process or REPL/i);
    expect(terminal.description).toMatch(/need later input/i);
    expect(terminal.description).toMatch(/shell\.start for unattended services/i);
    expect(send.description).toMatch(/never resend/i);
  });

  it("compact set includes recon essentials (P2-2)", () => {
    const compact = getToolDefinitions({ compact: true });
    const names = new Set(compact.map((d) => d.name));
    for (const n of [
      "dns.lookup",
      "whois.lookup",
      "http.fetch",
      "net.context",
      "pentest.recon",
      "wordlist.find",
      "web.search",
      "fs.write",
      "shell.exec",
    ]) {
      expect(names.has(n)).toBe(true);
    }
    // Keep compact: net.scan (confirm/sudo heavy) still out of compact set.
    expect(names.has("net.scan")).toBe(false);
    expect(names.has("pkg.install")).toBe(false);
  });
});
