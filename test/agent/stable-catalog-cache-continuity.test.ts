import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentTurn } from "../../src/agent/runner.js";
import { createSessionPolicy } from "../../src/agent/session-policy.js";
import { successfulRequestSnapshot } from "../../src/llm/routing/attempt-request.js";
import { buildAnthropicBody } from "../../src/llm/anthropic.js";
import { geminiBody } from "../../src/llm/gemini.js";
import { buildChatBody } from "../../src/llm/wire/chat-body.js";
import { tokenHarborBreakpointMode } from "../../src/llm/tokenharbor-cache.js";
import { buildResponsesBody } from "../../src/llm/responses-request.js";
import { withSessionAffinity } from "../../src/llm/session-affinity.js";
import { META_STREAM_TERMINAL } from "../../src/llm/stream-terminal.js";
import type { ToolCallingMode } from "../../src/llm/tool-protocol.js";
import { McpManager, type McpTransportFactory } from "../../src/mcp/manager.js";
import { McpRuntime } from "../../src/mcp/runtime.js";
import type { McpTransport } from "../../src/mcp/transport.js";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpToolDescriptor,
} from "../../src/mcp/types.js";
import type { SkillMeta } from "../../src/skills/types.js";
import type { CompletionRequest, CompletionResult } from "../../src/types.js";

const streamMock = vi.hoisted(() => vi.fn());
const skillState = vi.hoisted(() => ({ skills: [] as SkillMeta[] }));
const extraTools = new Map<string, McpToolDescriptor[]>();
const remoteCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

vi.mock("../../src/llm/router.js", async (importActual) => ({
  ...await importActual<typeof import("../../src/llm/router.js")>(),
  streamWithProvider: (
    request: CompletionRequest,
    onToken: (token: string) => void,
    options: { onSuccessfulRequest?: (snapshot: ReturnType<typeof successfulRequestSnapshot>) => void } = {},
  ): Promise<CompletionResult> => streamMock(request, onToken, options),
}));

vi.mock("../../src/commands/providers.js", async (importActual) => ({
  ...await importActual<typeof import("../../src/commands/providers.js")>(),
  ensureProviderConfigured: async () => undefined,
}));

vi.mock("../../src/skills/registry.js", async (importActual) => ({
  ...await importActual<typeof import("../../src/skills/registry.js")>(),
  getSkillIndex: async () => ({
    skills: skillState.skills,
    roots: [],
    names: new Set(skillState.skills.map((skill) => skill.name)),
    scannedAt: Date.now(),
    truncated: false,
  }),
}));

class CatalogTransport implements McpTransport {
  readonly kind = "stdio" as const;

  constructor(private readonly serverName: string) {}

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
          serverInfo: { name: this.serverName, version: "1" },
        },
      });
    }
    if (message.method === "tools/list") {
      const tool = this.serverName === "docs"
        ? {
            name: "lookup",
            description: "Look up a documentation record",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
              additionalProperties: false,
            },
          }
        : {
            name: "query",
            description: "Query a search catalog",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
            },
          };
      return Promise.resolve({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: [tool, ...(extraTools.get(this.serverName) ?? [])] },
      });
    }
    if (message.method === "tools/call") {
      const params = message.params as { name: string; arguments: Record<string, unknown> };
      remoteCalls.push({ name: params.name, args: params.arguments });
      return Promise.resolve({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: `record:${String(params.arguments.id)}` }] },
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

const transportFactory: McpTransportFactory = (definition) =>
  new CatalogTransport(definition.name);

type CapturedRequest = Pick<CompletionRequest, "messages" | "tools">;

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, entry]) => [key, withoutCacheControl(entry)]),
  );
}

function contentBlocks(messages: Array<{ role: string; content: string | unknown[] }>): unknown[] {
  return messages.flatMap(({ role, content }) =>
    (typeof content === "string" ? [{ type: "text", text: content }] : content)
      .map((block) => ({ role, block: withoutCacheControl(block) })),
  );
}

function chatMessages(messages: Array<Record<string, unknown>>): unknown[] {
  return messages.map((message) => {
    const clean = withoutCacheControl(message) as Record<string, unknown>;
    const content = clean.content;
    if (Array.isArray(content) && content.length === 1 && content[0]?.type === "text") {
      clean.content = content[0].text;
    }
    return clean;
  });
}

function expectWirePrefixes(requests: readonly CapturedRequest[]): void {
  withSessionAffinity("mcp-cache-regression", () => {
    const bodies = requests.map((request) => {
      const anthropic = JSON.parse(buildAnthropicBody({
        ...request, provider: "anthropic", model: "claude-sonnet-4-5",
      }, false));
      const gemini = JSON.parse(geminiBody({ ...request, provider: "gemini", model: "gemini-2.5-pro" }));
      const responses = JSON.parse(buildResponsesBody({
        baseUrl: "https://api.openai.com/v1",
        providerId: "openai",
        displayName: "OpenAI",
        artifactDialect: "openai-compatible",
        terminalPolicy: META_STREAM_TERMINAL,
        instructionsField: "leading-instructions",
        buildHeaders: () => ({}),
        reasoningPayload: () => undefined,
        bodyExtras: () => ({}),
      }, { ...request, model: "gpt-4o-mini", stream: false }));
      return [
        ...([
          ["openai", "gpt-4o-mini"],
          ["mistral", "mistral-large-latest"],
          ["openrouter", "gpt-4o-mini"],
          ["explabs", "gpt-4o-mini"],
          ["fireworks", "gpt-4o-mini"],
          ["cline", "anthropic/claude-sonnet-4.6"],
          ["cline", "qwen/qwen3-coder"],
          ["tokenharbor", "claude-sonnet-5.5"],
          ["tokenharbor", "kimi-k3"],
        ] as const).map(([providerId, model]) => {
          const chat = JSON.parse(buildChatBody({
            ...request, providerId, model, stream: false,
            ...(providerId === "tokenharbor" ? { ephemeralCacheBreakpoints: tokenHarborBreakpointMode(model) } : {}),
          }));
          return {
            prefix: { tools: chat.tools, key: chat.prompt_cache_key ?? chat.session_id ?? chat.prompt_cache_isolation_key },
            timeline: chatMessages(chat.messages),
          };
        }),
        { prefix: { tools: anthropic.tools, system: anthropic.system }, timeline: contentBlocks(anthropic.messages) },
        {
          prefix: { tools: gemini.tools, system: gemini.systemInstruction },
          timeline: gemini.contents.flatMap(({ role, parts }: { role: string; parts: unknown[] }) =>
            parts.map((part) => ({ role, part })),
          ) as unknown[],
        },
        { prefix: { tools: responses.tools, instructions: responses.instructions }, timeline: responses.input as unknown[] },
      ];
    });
    for (let index = 1; index < bodies.length; index++) {
      for (let dialect = 0; dialect < bodies[index]!.length; dialect++) {
        const previous = bodies[index - 1]![dialect]!;
        const current = bodies[index]![dialect]!;
        expect(JSON.stringify(current.prefix)).toBe(JSON.stringify(previous.prefix));
        expect(JSON.stringify(current.timeline.slice(0, previous.timeline.length))).toBe(
          JSON.stringify(previous.timeline),
        );
      }
    }
  });
}

let root: string;
let workspace: string;
let previousCwd: string;
let runtime: McpRuntime;

beforeEach(async () => {
  streamMock.mockReset();
  skillState.skills = [];
  extraTools.clear();
  remoteCalls.length = 0;
  previousCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), "clai-stable-catalog-cache-"));
  workspace = join(root, "workspace");
  mkdirSync(join(workspace, ".clai"), { recursive: true });
  writeFileSync(
    join(workspace, ".clai", "mcp.json"),
    JSON.stringify({
      servers: {
        docs: { command: "docs-server" },
        search: { command: "search-server" },
      },
    }),
  );
  process.chdir(workspace);
  runtime = new McpRuntime({
    manager: new McpManager({
      discovery: {
        workspaceFolder: workspace,
        homeDir: join(root, "home"),
        env: { XDG_CONFIG_HOME: join(root, "home", ".config") },
        platform: "linux",
      },
      transportFactory,
    }),
  });
  await runtime.refresh();
  runtime.selectOff();
});

afterEach(async () => {
  await runtime.closeAll();
  process.chdir(previousCwd);
  rmSync(root, { recursive: true, force: true });
});

describe("stable skill and MCP catalogs preserve agent request cache prefixes", () => {
  it.each(["native", "text"] satisfies ToolCallingMode[])("keeps stable tools, the system prompt, and prior wire content across %s catalog transitions", async (toolCalling) => {
    const requests: CapturedRequest[] = [];
    streamMock.mockImplementation(
      async (
        request: CompletionRequest,
        onToken: (token: string) => void,
        options: { onSuccessfulRequest?: (snapshot: ReturnType<typeof successfulRequestSnapshot>) => void },
      ): Promise<CompletionResult> => {
        requests.push({
          messages: structuredClone(request.messages),
          ...(request.tools ? { tools: structuredClone(request.tools) } : {}),
        });
        options.onSuccessfulRequest?.(
          successfulRequestSnapshot("openai", "gpt-4o-mini", request),
        );
        const answer = `turn ${requests.length} complete`;
        onToken(answer);
        return {
          text: answer,
          provider: "openai",
          model: "gpt-4o-mini",
          finishReason: "stop",
        };
      },
    );

    const skill: SkillMeta = {
      name: "release-audit",
      description: "Audit release readiness and CI evidence.",
      dir: join(workspace, ".clai", "skills", "release-audit"),
      file: join(workspace, ".clai", "skills", "release-audit", "SKILL.md"),
      scope: "project",
      tool: "clai",
      root: workspace,
    };
    const session = createSessionPolicy("stable-catalog-cache");
    let history = [
      { role: "user" as const, content: `Synthetic retained evidence:\n${"evidence ".repeat(18_000)}` },
      { role: "assistant" as const, content: "The retained evidence has been reviewed." },
    ];

    const turn = async (prompt: string): Promise<void> => {
      await runAgentTurn(prompt, {
        mcp: runtime,
        provider: "openai",
        model: "gpt-4o-mini",
        history,
        session,
        maxSteps: 1,
        toolCalling,
        onMessages: (messages) => {
          history = messages;
        },
      });
    };

    await turn("Continue reviewing the retained evidence without using tools.");
    skillState.skills = [skill];
    runtime.selectServer("docs");
    await turn("Continue reviewing the retained evidence after catalog changes.");
    runtime.selectServer("search");
    await turn("Continue reviewing the retained evidence after catalog changes.");
    runtime.selectOff();
    await turn("Continue reviewing the retained evidence after catalog changes.");
    runtime.selectServer("docs");
    await turn("Continue reviewing the retained evidence after catalog changes.");
    runtime.selectOff();
    await turn("Continue reviewing the retained evidence after catalog changes.");

    expect(requests).toHaveLength(6);
    const stableTools = requests[0]!.tools;
    const stableSystem = requests[0]!.messages[0];
    if (toolCalling === "native") {
      expect(stableTools?.some((tool) => tool.name === "mcp.call")).toBe(true);
      expect(stableTools?.some((tool) => tool.name === "skill.load")).toBe(true);
    } else expect(stableTools).toBeUndefined();
    expect(stableSystem?.role).toBe("system");

    for (let index = 1; index < requests.length; index += 1) {
      const previous = requests[index - 1]!;
      const current = requests[index]!;
      expect(current.tools).toEqual(stableTools);
      expect(current.messages[0]).toEqual(stableSystem);
      expect(current.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
    }

    const latestMcpContext = (index: number): string =>
      [...requests[index]!.messages]
        .reverse()
        .find((message) => message.content.includes("MCP TOOL CONTEXT"))
        ?.content ?? "";
    expect(requests[1]!.messages.some((message) => message.content.includes("AVAILABLE SKILLS"))).toBe(true);
    expect(latestMcpContext(0)).toContain("Selection: off");
    expect(latestMcpContext(1)).toContain("mcp.docs.lookup");
    expect(latestMcpContext(2)).toContain("mcp.search.query");
    expect(latestMcpContext(3)).toContain("Selection: off");
    expect(latestMcpContext(4)).toContain("mcp.docs.lookup");
    expect(latestMcpContext(5)).toContain("Selection: off");
    expectWirePrefixes(requests);
  });

  it("preserves prefixes across discovery, paging, calls, reconnects, sign-in results, and catalog refresh", async () => {
    extraTools.set("docs", Array.from({ length: 20 }, (_, index) => ({
      name: `record_${String(index).padStart(2, "0")}`,
      description: "Retrieve a documentation record",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    })));
    await runtime.refresh({ force: true });
    const requests: CapturedRequest[] = [];
    const controls: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: "mcp.list", args: {} },
      { name: "mcp.enable", args: { server: "docs" } },
      { name: "mcp.tools", args: { server: "docs", query: "record", limit: 1 } },
      { name: "mcp.tools", args: { server: "docs", query: "record", limit: 1 } },
      { name: "mcp.tools", args: { server: "docs", query: "lookup" } },
      { name: "mcp.call", args: { name: "mcp.docs.lookup", arguments: { id: "one" } } },
      { name: "mcp.connect", args: { server: "docs" } },
      { name: "mcp.login", args: { server: "docs" } },
    ];
    vi.spyOn(runtime, "agentLogin").mockResolvedValue({ ok: true, output: "Signed in; server docs is ready." });
    streamMock.mockImplementation(async (
      request: CompletionRequest,
      onToken: (token: string) => void,
      options: { onSuccessfulRequest?: (snapshot: ReturnType<typeof successfulRequestSnapshot>) => void },
    ): Promise<CompletionResult> => {
      requests.push({
        messages: structuredClone(request.messages),
        ...(request.tools ? { tools: structuredClone(request.tools) } : {}),
      });
      options.onSuccessfulRequest?.(successfulRequestSnapshot("openai", "gpt-4o-mini", request));
      const control = controls[requests.length - 1];
      if (control) {
        if (requests.length === 4) {
          const cursor = /Next cursor: ([a-f0-9]+:\d+)/.exec(request.messages.at(-1)!.content)![1]!;
          control.args = { ...control.args, cursor };
        }
        return {
          text: "", provider: "openai", model: "gpt-4o-mini", finishReason: "tool_calls",
          toolCalls: [{ id: `control-${requests.length}`, name: control.name, args: control.args }],
        };
      }
      onToken("Verified record one.");
      return { text: "Verified record one.", provider: "openai", model: "gpt-4o-mini", finishReason: "stop" };
    });
    let history: CompletionRequest["messages"] = [];
    const session = createSessionPolicy("mcp-lifecycle-cache");
    const run = () => runAgentTurn("Continue inspecting the documentation records.", {
      mcp: runtime, provider: "openai", model: "gpt-4o-mini", session, history,
      maxSteps: 12, toolCalling: "native", autoConfirm: true,
      onMessages: (messages) => { history = messages; },
    });
    await run();
    expect(requests).toHaveLength(9);
    expect(remoteCalls).toEqual([{ name: "lookup", args: { id: "one" } }]);
    const retained = structuredClone(history);
    extraTools.get("docs")!.push({ name: "new_record", description: "Newly published record lookup", inputSchema: { type: "object" } });
    await runtime.refresh({ force: true });
    await run();
    expect(requests).toHaveLength(10);
    expect(requests[9]!.messages.slice(1, retained.length + 1)).toEqual(retained);
    expect(requests[9]!.messages.some((message) => message.content.includes("new_record"))).toBe(true);
    expectWirePrefixes(requests);
  });
});
