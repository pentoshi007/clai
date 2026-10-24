import { afterEach, describe, expect, it, vi } from "vitest";
import { McpManager } from "../../src/mcp/manager.js";
import type { McpTransport } from "../../src/mcp/transport.js";
import type { JsonRpcRequest, JsonRpcResponse, McpRequestOptions } from "../../src/mcp/types.js";
import { reaServerDefinition } from "../../src/rea/runtime.js";
import { reaStartupEnvironment } from "../../src/rea/timeouts.js";

const installation = { version: "6.7.0", node: process.execPath, entry: "/rea.mjs", directory: "/rea" };
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("managed REA startup deadlines", () => {
  it("uses two hours for analysis-engine startup and ten minutes for helper compilation", () => {
    expect(reaStartupEnvironment({})).toEqual({
      REA_GHIDRA_STARTUP_TIMEOUT_MS: "7200000",
      REA_HOPPER_STARTUP_TIMEOUT_MS: "7200000",
      REA_SWIFTC_COMPILE_TIMEOUT_MS: "600000",
    });
  });

  it.each(["1", "86400000", "2147483647"])("preserves timer-safe explicit deadlines: %s", (value) => {
    expect(reaStartupEnvironment({ REA_GHIDRA_STARTUP_TIMEOUT_MS: value })).toHaveProperty("REA_GHIDRA_STARTUP_TIMEOUT_MS", value);
  });

  it.each(["0", "-1", "", "1.5", "1e6", " 7200000", "01", "Infinity", "2147483648", "9007199254740993"])("rejects invalid deadlines instead of overflowing timers: %j", (value) => {
    expect(() => reaStartupEnvironment({ REA_GHIDRA_STARTUP_TIMEOUT_MS: value })).toThrow("REA_GHIDRA_STARTUP_TIMEOUT_MS");
  });

  it("honors ambient and explicit overrides and changes the connection signature", () => {
    vi.stubEnv("REA_GHIDRA_STARTUP_TIMEOUT_MS", "10800000");
    const ambient = reaServerDefinition(installation, "/root");
    const explicit = reaServerDefinition(installation, "/root", { REA_GHIDRA_STARTUP_TIMEOUT_MS: "14400000" });
    expect(ambient.config.transport === "stdio" && ambient.config.env).toHaveProperty("REA_GHIDRA_STARTUP_TIMEOUT_MS", "10800000");
    expect(explicit.config.transport === "stdio" && explicit.config.env).toHaveProperty("REA_GHIDRA_STARTUP_TIMEOUT_MS", "14400000");
    expect(explicit.signature).not.toBe(ambient.signature);
  });
});

class DeferredAnalysisTransport implements McpTransport {
  readonly kind = "stdio" as const;
  options: McpRequestOptions | undefined;
  private complete: (() => void) | undefined;
  async start(): Promise<void> {}
  request(message: JsonRpcRequest, options?: McpRequestOptions): Promise<JsonRpcResponse> {
    if (message.method === "initialize") return Promise.resolve({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "rea", version: "1" },
    } });
    if (message.method === "tools/list") return Promise.resolve({ jsonrpc: "2.0", id: message.id, result: {
      tools: [{ name: "open_binary", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }],
    } });
    this.options = options;
    return new Promise((resolve) => {
      this.complete = () => resolve({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "analyzed" }] } });
    });
  }
  finish(): void { this.complete?.(); }
  async notify(): Promise<void> {}
  async close(): Promise<void> { this.finish(); }
  sessionId(): undefined { return undefined; }
  setProtocolVersion(): void {}
}

it("survives global MCP budgets and two hours of silence while preserving per-call deadlines and cancellation", async () => {
  const transport = new DeferredAnalysisTransport();
  const manager = new McpManager({
    discovery: { workspaceFolder: "/nonexistent-clai-timeout-fixture", homeDir: "/nonexistent-clai-timeout-home", env: {}, platform: "linux" },
    requestTimeoutMs: 100,
    transportFactory: () => transport,
  });
  try {
    await manager.registerSessionServer(reaServerDefinition(installation, "/root"));
    vi.useFakeTimers();
    const pending = manager.callTool("mcp.clai-rea.open_binary", {});
    await vi.advanceTimersByTimeAsync(7_200_000);
    expect(transport.options?.timeoutMs).toBe(0);
    expect(transport.options?.signal?.aborted).toBe(false);
    transport.finish();
    await expect(pending).resolves.toMatchObject({ text: "analyzed" });

    const controller = new AbortController();
    const cancelled = manager.callTool("mcp.clai-rea.open_binary", {}, { signal: controller.signal });
    const cancellation = expect(cancelled).rejects.toMatchObject({ kind: "cancelled" });
    controller.abort();
    await cancellation;
    transport.finish();

    const bounded = manager.callTool("mcp.clai-rea.open_binary", {}, { timeoutMs: 250 });
    const timeout = expect(bounded).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(250);
    await timeout;
    transport.finish();
  } finally {
    await manager.closeAll();
  }
});
