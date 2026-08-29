import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../src/agent/events.js";
import type { ChatMessage } from "../../src/types.js";
import { McpRuntime } from "../../src/mcp/runtime.js";
import type { ToolResult } from "../../src/types.js";

const stream = vi.fn();
const complete = vi.fn();

vi.mock("../../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/llm/router.js")>();
  return {
    ...actual,
    streamWithProvider: (
      req: unknown,
      onToken: (t: string) => void,
      opts?: { onStreamEvent?: (e: unknown) => void },
    ) => stream(req, onToken, opts),
    completeWithProvider: (req: unknown) => complete(req),
  };
});

vi.mock("../../src/commands/providers.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/commands/providers.js")>();
  return { ...actual, ensureProviderConfigured: async () => {} };
});

function makeSession(id: string) {
  return {
    sessionId: id,
    planApproved: { value: false },
    allow: new Set(),
    pentestAuthorized: { value: false },
  } as any;
}

function fakeRuntime(result: ToolResult): McpRuntime {
  const runtime = new McpRuntime({ cwd: mkdtempSync(join(tmpdir(), "clai-mcp-ctl-")) });
  const answer = async (): Promise<ToolResult> => result;
  return Object.assign(runtime, {
    agentList: answer,
    agentTools: answer,
    agentEnable: answer,
    agentConnect: answer,
    agentLogin: answer,
  });
}

async function driveMcpTool(
  sessionId: string,
  toolName: string,
  result: ToolResult,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const { runAgent } = await import("../../src/modes/agent.js");
  let round = 0;
  stream.mockImplementation(async (_req: unknown, onToken: (t: string) => void) => {
    round += 1;
    if (round === 1) {
      return {
        text: "",
        provider: "free",
        model: "test",
        finishReason: "tool_calls",
        toolCalls: [{ id: "call-1", name: toolName, arguments: "{}" }],
      };
    }
    onToken("done");
    return { text: "done", provider: "free", model: "test", finishReason: "stop" };
  });
  await runAgent("inspect mcp", {
    session: makeSession(sessionId),
    history: [{ role: "system", content: "sys" } as ChatMessage],
    maxSteps: 3,
    autoConfirm: true,
    mcp: fakeRuntime(result),
    onEvent: (e) => events.push(e),
  });
  return events;
}

function outputChunks(events: readonly AgentEvent[], id?: string): string[] {
  return events
    .filter(
      (event): event is Extract<AgentEvent, { type: "tool-output" }> =>
        event.type === "tool-output" && (id === undefined || event.id === id),
    )
    .map((event) => event.chunk);
}

function firstToolId(events: readonly AgentEvent[]): string {
  const call = events.find(
    (event): event is Extract<AgentEvent, { type: "tool-call" }> => event.type === "tool-call",
  );
  return call?.id ?? "";
}

describe("MCP control tools always surface a visible result", () => {
  beforeEach(() => {
    stream.mockReset();
    complete.mockReset();
  });

  it("shows the real listing instead of a bare ok for mcp.list", async () => {
    const events = await driveMcpTool("sess-mcp-list", "mcp.list", {
      ok: true,
      exitCode: 0,
      output: "MCP selection: all.\n- notion: ready; transport=http; tools=12",
    });
    const chunks = outputChunks(events, firstToolId(events)).join("");
    expect(chunks).toContain("MCP selection: all.");
    expect(chunks).toContain("notion: ready");
    expect(chunks.trim()).not.toBe("ok");
  });

  it("shows the enable confirmation text for mcp.enable", async () => {
    const events = await driveMcpTool("sess-mcp-enable", "mcp.enable", {
      ok: true,
      exitCode: 0,
      output: "Enabled MCP servers: io.github.github/github-mcp-server. Active tools: 44.",
    });
    const chunks = outputChunks(events, firstToolId(events)).join("");
    expect(chunks).toContain("Enabled MCP servers");
    expect(chunks).toContain("Active tools: 44");
  });

  it("emits the output before the result so the card body is never dropped", async () => {
    const events = await driveMcpTool("sess-mcp-order", "mcp.tools", {
      ok: true,
      exitCode: 0,
      output: "- mcp.notion.search [read-only]",
    });
    const id = firstToolId(events);
    const relevant = events.filter(
      (event) =>
        (event.type === "tool-output" || event.type === "tool-result") &&
        (event as { id?: string }).id === id,
    );
    expect(relevant[0]?.type).toBe("tool-output");
    expect(relevant.some((event) => event.type === "tool-result")).toBe(true);
  });

  it("substitutes an explicit note when a control tool succeeds with no text", async () => {
    const events = await driveMcpTool("sess-mcp-empty", "mcp.login", {
      ok: true,
      exitCode: 0,
      output: "",
    });
    const chunks = outputChunks(events, firstToolId(events)).join("");
    expect(chunks).toContain("mcp.login");
    expect(chunks).toContain("no textual output");
    expect(chunks.trim().length).toBeGreaterThan(0);
  });

  it("substitutes an explicit note when a control tool fails with no text", async () => {
    const events = await driveMcpTool("sess-mcp-empty-fail", "mcp.connect", {
      ok: false,
      exitCode: 1,
      output: "",
    });
    const chunks = outputChunks(events, firstToolId(events)).join("");
    expect(chunks).toContain("mcp.connect");
    expect(chunks).toContain("failed");
    expect(chunks).toContain("no textual output");
  });

  it("surfaces a real failure reason verbatim", async () => {
    const events = await driveMcpTool("sess-mcp-fail", "mcp.connect", {
      ok: false,
      exitCode: 1,
      output: 'Unknown MCP server "nope".',
    });
    const chunks = outputChunks(events, firstToolId(events)).join("");
    expect(chunks).toContain('Unknown MCP server "nope".');
  });
});
