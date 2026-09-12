import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../src/agent/events.js";
import { runAgentTurn } from "../../src/agent/runner.js";
import type { CompletionRequest, CompletionResult } from "../../src/types.js";
import type { ToolCallingMode } from "../../src/llm/tool-protocol.js";
import { McpManager, type McpTransportFactory } from "../../src/mcp/manager.js";
import { McpRuntime } from "../../src/mcp/runtime.js";
import { MCP_AGENT_TOOL_NAMES } from "../../src/tools/definitions.js";
import type { McpTransport } from "../../src/mcp/transport.js";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../../src/mcp/types.js";

const streamMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/llm/router.js")>();
  return {
    ...actual,
    streamWithProvider: (
      request: CompletionRequest,
      onToken: (token: string) => void,
    ): Promise<CompletionResult> => streamMock(request, onToken),
  };
});

vi.mock("../../src/commands/providers.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/commands/providers.js")>();
  return { ...actual, ensureProviderConfigured: async () => undefined };
});

const remoteCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let readOnly = true;

class RunnerTransport implements McpTransport {
  readonly kind = "stdio" as const;

  start(): Promise<void> {
    return Promise.resolve();
  }

  request(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (message.method === "initialize") {
      return Promise.resolve({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          serverInfo: { name: "docs", version: "1" },
        },
      });
    }
    if (message.method === "tools/list") {
      return Promise.resolve({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "lookup",
              description: "Look up a documentation record",
              inputSchema: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
                additionalProperties: false,
              },
              annotations: { readOnlyHint: readOnly },
            },
          ],
        },
      });
    }
    if (message.method === "tools/call") {
      const params = message.params as {
        name: string;
        arguments: Record<string, unknown>;
      };
      remoteCalls.push({ name: params.name, args: params.arguments });
      return Promise.resolve({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: `record:${String(params.arguments.id)}` }],
        },
      });
    }
    return Promise.resolve({ jsonrpc: "2.0", id: message.id, result: {} });
  }

  notify(_message: JsonRpcNotification): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  sessionId(): string | undefined {
    return undefined;
  }

  setProtocolVersion(): void {}
}

const factory: McpTransportFactory = () => new RunnerTransport();

let root: string;
let workspace: string;
let home: string;
let previousCwd: string;
let runtime: McpRuntime;

beforeEach(async () => {
  streamMock.mockReset();
  remoteCalls.length = 0;
  readOnly = true;
  previousCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), "clai-mcp-runner-"));
  workspace = join(root, "project");
  home = join(root, "home");
  mkdirSync(join(workspace, ".clai"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(workspace, ".clai", "mcp.json"),
    JSON.stringify({ servers: { docs: { command: "docs-server" } } }),
  );
  process.chdir(workspace);
  runtime = new McpRuntime({
    manager: new McpManager({
      discovery: {
        workspaceFolder: workspace,
        homeDir: home,
        env: { XDG_CONFIG_HOME: join(home, ".config") },
        platform: "linux",
      },
      transportFactory: factory,
    }),
  });
  await runtime.refresh();
  await runtime.selectServer("docs");
});

afterEach(async () => {
  await runtime.closeAll();
  process.chdir(previousCwd);
  rmSync(root, { recursive: true, force: true });
});

async function run(events: AgentEvent[], toolCalling: ToolCallingMode) {
  return await runAgentTurn("Look up documentation record one and report it", {
    mcp: runtime,
    provider: "openai",
    model: "gpt-4o-mini",
    maxSteps: 3,
    toolCalling,
    onEvent: (event) => events.push(event),
  });
}

describe("agent MCP integration", () => {
  const reply = (text = "Finished checking documentation."): CompletionResult => ({
    text,
    provider: "openai",
    model: "gpt-4o-mini",
    finishReason: "stop",
  });
  const toolReply = (name: string, args: Record<string, unknown>): CompletionResult => ({
    ...reply(""),
    toolCalls: [{ id: `call-${name}`, name, args }],
    finishReason: "tool_calls",
  });

  it("discovers required schemas and calls an MCP tool after enabling it mid-turn", async () => {
    runtime.selectOff();
    const requests: CompletionRequest[] = [];
    streamMock.mockImplementation((request: CompletionRequest) => {
      requests.push({ ...request, messages: structuredClone(request.messages), tools: structuredClone(request.tools) });
      if (requests.length === 1) return toolReply("mcp.enable", { server: "docs" });
      if (requests.length === 2) {
        expect(request.messages.at(-1)?.content).toContain("mcp.tools");
        return toolReply("mcp.tools", { server: "docs" });
      }
      if (requests.length === 3) {
        expect(request.messages.at(-1)?.content).toContain('"required":["id"]');
        return toolReply("mcp.call", { name: "mcp.docs.lookup", arguments: { id: "one" } });
      }
      return reply();
    });

    await runAgentTurn("Look up documentation record one", {
      mcp: runtime,
      provider: "openai",
      model: "gpt-4o-mini",
      maxSteps: 5,
      toolCalling: "native",
      autoConfirm: true,
    });

    expect(requests).toHaveLength(4);
    expect(remoteCalls).toEqual([{ name: "lookup", args: { id: "one" } }]);
    for (const request of requests.slice(1)) {
      expect(request.tools).toEqual(requests[0]?.tools);
      expect(request.messages[0]).toEqual(requests[0]?.messages[0]);
    }
  });

  it.each([
    { name: "fs.delete", arguments: { path: "never-delete" } },
    { name: "mcp.enable", arguments: { server: "all" } },
    { name: "mcp.call", arguments: { name: "fs.delete", arguments: {} } },
    { name: "mcp.missing.lookup", arguments: {} },
    { name: "mcp.docs.lookup", arguments: "{}" },
    { name: "mcp.docs.lookup", arguments: [] },
    { name: "mcp.docs.lookup" },
  ])("rejects invalid MCP wrapper arguments without dispatch: %j", async (args) => {
    streamMock.mockResolvedValueOnce(toolReply("mcp.call", args)).mockResolvedValue(reply());
    const events: AgentEvent[] = [];
    await run(events, "native");
    expect(remoteCalls).toEqual([]);
    expect(events.some((event) => event.type === "tool-result" && !event.ok &&
      event.summary.includes("mcp.call requires an active MCP tool"))).toBe(true);
  });

  it("rejects inactive MCP wrapper targets", async () => {
    runtime.selectOff();
    streamMock.mockResolvedValueOnce(toolReply("mcp.call", {
      name: "mcp.docs.lookup", arguments: { id: "one" },
    })).mockResolvedValue(reply());
    const events: AgentEvent[] = [];
    await run(events, "native");
    expect(remoteCalls).toEqual([]);
    expect(events.some((event) => event.type === "tool-result" && !event.ok)).toBe(true);
  });

  it.each([true, false])("enforces ask-mode read-only targets (readOnly=%s)", async (isReadOnly) => {
    readOnly = isReadOnly;
    await runtime.reconnect("docs");
    expect(runtime.getTool("mcp.docs.lookup")?.readOnly).toBe(isReadOnly);
    const requests: CompletionRequest[] = [];
    streamMock.mockImplementation((request: CompletionRequest) => {
      requests.push({ ...request, messages: structuredClone(request.messages), tools: structuredClone(request.tools) });
      return requests.length === 1
        ? toolReply("mcp.call", { name: "mcp_docs_lookup", arguments: { id: "one" } })
        : reply();
    });
    const events: AgentEvent[] = [];
    await runAgentTurn("Look up documentation record one", {
      mcp: runtime,
      provider: "openai",
      model: "gpt-4o-mini",
      mode: "ask",
      maxSteps: 3,
      toolCalling: "native",
      autoConfirm: true,
      onEvent: (event) => events.push(event),
    });
    expect(requests[0]?.tools?.some((tool) => tool.name === "mcp.call")).toBe(true);
    expect(remoteCalls).toEqual(isReadOnly ? [{ name: "lookup", args: { id: "one" } }] : []);
    if (!isReadOnly) {
      expect(events.some((event) => event.type === "tool-result" && !event.ok &&
        event.summary.includes("Ask mode permits only active read-only MCP tools"))).toBe(true);
    }
  });

  it("keeps native MCP schemas stable and dispatches calls through the wrapper", async () => {
    const requests: CompletionRequest[] = [];
    streamMock.mockImplementation(
      async (
        request: CompletionRequest,
        onToken: (token: string) => void,
      ): Promise<CompletionResult> => {
        requests.push(request);
        if (requests.length === 1) {
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              {
                id: "call-mcp-native",
                name: "mcp.call",
                args: { name: "mcp.docs.lookup", arguments: { id: "one" } },
              },
            ],
            finishReason: "tool_calls",
          };
        }
        onToken("record one found");
        return {
          text: "record one found",
          provider: "openai",
          model: "gpt-test",
          finishReason: "stop",
        };
      },
    );

    const events: AgentEvent[] = [];
    const outcome = await run(events, "native");

    expect(outcome.answer).toContain("record one found");
    expect(requests[0]?.tools?.some((tool) => tool.name === "mcp.call")).toBe(true);
    expect(requests[0]?.tools?.some((tool) => tool.name === "mcp.docs.lookup")).toBe(false);
    expect(
      requests[0]?.messages.some(
        (message) =>
          message.role === "system" && message.content.includes("MCP TOOL CONTEXT"),
      ),
    ).toBe(true);
    expect(remoteCalls).toEqual([{ name: "lookup", args: { id: "one" } }]);
    expect(
      events.some(
        (event) => event.type === "tool-result" && event.ok && event.summary.includes("record:one"),
      ),
    ).toBe(true);
  });

  it("reports MCP-off state without discovering or exposing remote tools", async () => {
    runtime.selectOff();
    const ensureReady = vi.spyOn(runtime, "ensureReady");
    let request: CompletionRequest | undefined;
    streamMock.mockImplementation(
      async (
        value: CompletionRequest,
        onToken: (token: string) => void,
      ): Promise<CompletionResult> => {
        request = value;
        onToken("no MCP needed");
        return {
          text: "no MCP needed",
          provider: "openai",
          model: "gpt-test",
          finishReason: "stop",
        };
      },
    );

    const outcome = await run([], "native");

    expect(outcome.answer).toContain("no MCP needed");
    expect(ensureReady).not.toHaveBeenCalled();
    expect(
      request?.tools?.some(
        (tool) => tool.name.startsWith("mcp.") && !MCP_AGENT_TOOL_NAMES.has(tool.name),
      ),
    ).toBe(false);
    expect(
      request?.messages.some(
        (message) =>
          message.role === "system" && message.content.includes("Selection: off"),
      ),
    ).toBe(true);
  });

  it("dispatches canonical MCP calls parsed from fenced text protocol", async () => {
    let requests = 0;
    streamMock.mockImplementation(
      async (
        request: CompletionRequest,
        onToken: (token: string) => void,
      ): Promise<CompletionResult> => {
        requests += 1;
        expect(request.tools).toBeUndefined();
        if (requests === 1) {
          return {
            text: "```tool\n{\"name\":\"mcp.docs.lookup\",\"args\":{\"id\":\"two\"}}\n```",
            provider: "openai",
            model: "gpt-test",
            finishReason: "stop",
          };
        }
        onToken("record two found");
        return {
          text: "record two found",
          provider: "openai",
          model: "gpt-test",
          finishReason: "stop",
        };
      },
    );

    const events: AgentEvent[] = [];
    const outcome = await run(events, "text");

    expect(outcome.answer).toContain("record two found");
    expect(remoteCalls).toEqual([{ name: "lookup", args: { id: "two" } }]);
    expect(requests).toBe(2);
  });
});
