import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentTurn } from "../../src/agent/runner.js";
import { createSessionPolicy } from "../../src/agent/session-policy.js";
import { successfulRequestSnapshot } from "../../src/llm/routing/attempt-request.js";
import { McpManager, type McpTransportFactory } from "../../src/mcp/manager.js";
import { McpRuntime } from "../../src/mcp/runtime.js";
import type { McpTransport } from "../../src/mcp/transport.js";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../../src/mcp/types.js";
import type { SkillMeta } from "../../src/skills/types.js";
import type { CompletionRequest, CompletionResult } from "../../src/types.js";

const streamMock = vi.hoisted(() => vi.fn());
const skillState = vi.hoisted(() => ({ skills: [] as SkillMeta[] }));

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
        result: { tools: [tool] },
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

let root: string;
let workspace: string;
let previousCwd: string;
let runtime: McpRuntime;

beforeEach(async () => {
  streamMock.mockReset();
  skillState.skills = [];
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
  it("keeps stable tools, the leading system prompt, and every prior request message across catalog transitions", async () => {
    const requests: Array<Pick<CompletionRequest, "messages" | "tools">> = [];
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
        toolCalling: "native",
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
    expect(stableTools?.some((tool) => tool.name === "mcp.call")).toBe(true);
    expect(stableTools?.some((tool) => tool.name === "skill.load")).toBe(true);
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
  });
});
