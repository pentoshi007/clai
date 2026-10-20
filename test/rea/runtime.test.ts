import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { manageRea } from "../../src/rea/runtime.js";
import { REA_SERVER, REA_WORKFLOW } from "../../src/rea/workflow.js";
import { classifyToolCall } from "../../src/safety/classifier.js";
import { createMcpAgentToolExecutor } from "../../src/agent/turn/mcp-agent-tools.js";
import type { ToolCall } from "../../src/types.js";
import { reaTestRuntime, seedRea } from "../helpers/rea-runtime.js";

let root: string;
let host: ReturnType<typeof reaTestRuntime>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clai-rea-runtime-"));
  host = reaTestRuntime(root);
});
afterEach(async () => {
  await host.runtime.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe("native REA capability", () => {
  it("keeps status and guidance read-only, bounded and completely lazy", async () => {
    expect((await manageRea(host.runtime, "status")).output).toContain("not started (lazy)");
    const guide = await manageRea(host.runtime, "guide");
    expect(guide.output.length).toBeLessThan(5_000);
    expect(guide.output).toContain("retained Evidence");
    expect(host.starts).toEqual([]);
  });

  it("reports missing installation without installing or starting anything", async () => {
    expect(await manageRea(host.runtime, "enable")).toMatchObject({ ok: false, output: expect.stringContaining("/rea install") });
    expect(host.starts).toEqual([]);
  });

  it("enables during a turn and calls freshly discovered tools without changing native schemas", async () => {
    seedRea();
    const lease = host.runtime.beginTurn();
    expect((await manageRea(host.runtime, "enable")).ok).toBe(true);
    expect(host.starts).toEqual([REA_SERVER]);
    const catalog = await host.runtime.agentTools(REA_SERVER, { query: "inspect_go_binary", limit: 1 });
    expect(catalog.output).toContain(`mcp.${REA_SERVER}.inspect_go_binary`);
    expect(catalog.output.length).toBeLessThan(4_000);
    const call = await host.runtime.callTool(`mcp.${REA_SERVER}.inspect_go_binary`, { path: "/artifact" });
    expect(call.ok).toBe(true);
    expect(host.calls).toHaveLength(1);
    expect(host.runtime.promptContext({ nativeTools: true })!.length).toBeLessThan(6_000);
    lease.release();
  });

  it("deduplicates activation, reuses the analysis, and stops only its own server", async () => {
    seedRea();
    mkdirSync(join(root, ".clai"));
    writeFileSync(join(root, ".clai", "mcp.json"), JSON.stringify({ servers: { docs: { command: "docs" } } }));
    await host.runtime.start();
    host.runtime.selectServer("docs");
    await Promise.all([manageRea(host.runtime, "enable"), manageRea(host.runtime, "enable")]);
    await manageRea(host.runtime, "enable");
    expect(host.starts.filter((name) => name === REA_SERVER)).toHaveLength(1);
    expect(host.runtime.getState().selection).toEqual({ mode: "servers", serverNames: ["docs", REA_SERVER] });
    await manageRea(host.runtime, "disable");
    expect(host.closes).toEqual([REA_SERVER]);
    expect(host.runtime.getState().selection).toEqual({ mode: "servers", serverNames: ["docs"] });
    await manageRea(host.runtime, "enable");
    expect(host.starts.filter((name) => name === REA_SERVER)).toHaveLength(2);
  });

  it("retains session registration through refresh but never writes an agent config", async () => {
    seedRea();
    await manageRea(host.runtime, "enable");
    await host.runtime.refresh();
    expect(host.starts).toEqual([REA_SERVER]);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(root, ".clai", "mcp.json"))).toBe(false);
    expect(existsSync(join(root, "home", ".claude.json"))).toBe(false);
  });

  it("does not hijack or stop a user-configured server with the managed name", async () => {
    seedRea();
    mkdirSync(join(root, ".clai"));
    writeFileSync(join(root, ".clai", "mcp.json"), JSON.stringify({ servers: { [REA_SERVER]: { command: "unrelated" } } }));
    await host.runtime.start();
    expect((await manageRea(host.runtime, "enable")).ok).toBe(false);
    expect((await manageRea(host.runtime, "disable")).ok).toBe(false);
    expect(host.closes).toEqual([]);
    expect(host.runtime.getState().selection.mode).toBe("off");
  });

  it("enforces ask/plan boundaries and confirmation for state changes", async () => {
    const confirm = vi.fn(async () => true);
    const ports = { askMode: true, confirm, showCall: vi.fn(), writeOutput: vi.fn(), emitResult: vi.fn(), recordAttempt: vi.fn() };
    const run = createMcpAgentToolExecutor(ports);
    const call = (action: string): ToolCall => ({ id: action, name: "rea.manage", args: { action } });
    expect((await run(host.runtime, call("guide"), "guide")).ok).toBe(true);
    expect((await run(host.runtime, call("install"), "install")).ok).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    const plan = createMcpAgentToolExecutor({ ...ports, askMode: false, planMode: true });
    expect((await plan(host.runtime, call("setup"), "setup")).ok).toBe(false);
    const declined = createMcpAgentToolExecutor({ ...ports, askMode: false, confirm: async () => false });
    expect(await declined(host.runtime, call("enable"), "enable")).toMatchObject({ ok: false, blockOrCancel: true });
    expect(classifyToolCall(call("status")).level).toBe("safe");
    expect(classifyToolCall(call("install")).level).toBe("confirm");
  });

  it("keeps the practical upstream workflow compact and distinguishes provider failures", () => {
    expect(REA_WORKFLOW).toContain("summary");
    expect(REA_WORKFLOW).toContain("host timeout");
    expect(REA_WORKFLOW).toContain("Ordinary source-repository");
  });
});
