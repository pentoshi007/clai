import { describe, expect, it, vi } from "vitest";
import type { ToolCall, ToolResult } from "../../src/types.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import {
  createMcpAgentCallFailure,
  createMcpAgentToolExecutor,
  mcpAgentOutput,
  mcpAgentToolTarget,
  runMcpAgentTool,
} from "../../src/agent/turn/mcp-agent-tools.js";

const call = (name: string, args: Record<string, unknown> = {}): ToolCall =>
  ({ name, args }) as ToolCall;

const ok = (output: string): ToolResult => ({ ok: true, output });

const runtime = () => {
  const calls: string[] = [];
  const stub = {
    agentList: async () => {
      calls.push("list");
      return ok("list output");
    },
    agentTools: async (server?: string) => {
      calls.push(`tools:${server ?? "all"}`);
      return ok("tools output");
    },
    agentEnable: async (target?: string | readonly string[]) => {
      calls.push(`enable:${JSON.stringify(target ?? null)}`);
      return ok("enable output");
    },
    agentConnect: async (server: string) => {
      calls.push(`connect:${server}`);
      return ok("connect output");
    },
    agentLogin: async (server: string) => {
      calls.push(`login:${server}`);
      return ok("");
    },
  } as unknown as McpRuntime;
  return { stub, calls };
};

const ports = (overrides: Record<string, unknown> = {}) => {
  const events: string[] = [];
  const base = {
    askMode: false,
    showCall: (id: string) => events.push(`show:${id}`),
    writeOutput: (id: string, chunk: string) =>
      events.push(`output:${id}:${JSON.stringify(chunk)}`),
    emitResult: (id: string, result: ToolResult, contextOutput: string) =>
      events.push(`result:${id}:${result.ok}:${contextOutput}`),
    confirm: async () => true,
    recordAttempt: (c: ToolCall, okFlag: boolean, output: string) =>
      events.push(`attempt:${c.name}:${okFlag}:${output}`),
    ...overrides,
  };
  return { ports: base as never, events };
};

describe("mcp agent tool helpers", () => {
  it("derives the target from servers, server, or nothing", () => {
    expect(mcpAgentToolTarget({ servers: ["a", 1, "b"] })).toEqual(["a", "b"]);
    expect(mcpAgentToolTarget({ server: "docs" })).toBe("docs");
    expect(mcpAgentToolTarget({})).toBeUndefined();
  });

  it("dispatches each agent tool and defaults login for unknown names", async () => {
    const { stub, calls } = runtime();
    await runMcpAgentTool(stub, call("mcp.list"));
    await runMcpAgentTool(stub, call("mcp.tools", { server: "docs" }));
    await runMcpAgentTool(stub, call("mcp.tools"));
    await runMcpAgentTool(stub, call("mcp.enable", { servers: ["docs"] }));
    await runMcpAgentTool(stub, call("mcp.connect", { server: "docs" }));
    await runMcpAgentTool(stub, call("mcp.login"));

    expect(calls).toEqual([
      "list",
      "tools:docs",
      "tools:all",
      'enable:["docs"]',
      "connect:docs",
      "login:",
    ]);
  });

  it("substitutes descriptive output when the result text is empty", () => {
    expect(mcpAgentOutput(call("mcp.list"), ok(" body "))).toBe("body");
    expect(mcpAgentOutput(call("mcp.list"), ok("  "))).toBe(
      "mcp.list completed successfully with no textual output.",
    );
    expect(
      mcpAgentOutput(call("mcp.connect"), { ok: false, output: "" }),
    ).toBe("mcp.connect failed with no textual output (exit 1).");
  });
});

describe("mcp agent tool execution", () => {
  it("blocks mutating tools in ask mode without confirming or dispatching", async () => {
    const confirm = vi.fn(async () => true);
    const { ports: port, events } = ports({ askMode: true, confirm });
    const { stub, calls } = runtime();

    const result = await createMcpAgentToolExecutor(port)(
      stub,
      call("mcp.connect", { server: "docs" }),
      "evt-1",
    );

    expect(result.ok).toBe(false);
    expect(result.contextOutput).toContain("not available in ask mode");
    expect(confirm).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(events).toEqual([
      "show:evt-1",
      `output:evt-1:${JSON.stringify(`${result.contextOutput}\n`)}`,
      `result:evt-1:false:${result.contextOutput}`,
    ]);
  });

  it("allows read-only tools in ask mode without confirmation", async () => {
    const confirm = vi.fn(async () => true);
    const { ports: port } = ports({ askMode: true, confirm });
    const { stub, calls } = runtime();

    const result = await createMcpAgentToolExecutor(port)(
      stub,
      call("mcp.list"),
      "evt-2",
    );

    expect(result.ok).toBe(true);
    expect(result.contextOutput).toBe("list output");
    expect(confirm).not.toHaveBeenCalled();
    expect(calls).toEqual(["list"]);
  });

  it("marks a declined confirmation as a cancelled block", async () => {
    const { ports: port, events } = ports({ confirm: async () => false });
    const { stub, calls } = runtime();

    const result = await createMcpAgentToolExecutor(port)(
      stub,
      call("mcp.enable", { server: "docs" }),
      "evt-3",
    );

    expect(result).toMatchObject({
      ok: false,
      contextOutput: "Cancelled.",
      blockOrCancel: true,
    });
    expect(calls).toEqual([]);
    expect(events[1]).toBe(
      `output:evt-3:${JSON.stringify("cancelled: Cancelled.\n")}`,
    );
  });

  it("records the attempt and emits the substituted output", async () => {
    const { ports: port, events } = ports();
    const { stub } = runtime();

    const result = await createMcpAgentToolExecutor(port)(
      stub,
      call("mcp.login", { server: "docs" }),
      "evt-4",
    );

    expect(result.result.output).toBe(
      "mcp.login completed successfully with no textual output.",
    );
    expect(events).toEqual([
      "show:evt-4",
      `attempt:mcp.login:true:${result.result.output}`,
      `output:evt-4:${JSON.stringify(`${result.result.output}\n`)}`,
      `result:evt-4:true:${result.result.output}`,
    ]);
  });

  it("exposes the same failure path for external callers", () => {
    const { ports: port } = ports();
    expect(
      createMcpAgentCallFailure(port)("evt-5", call("mcp.list"), "boom"),
    ).toMatchObject({ ok: false, contextOutput: "boom" });
  });
});
