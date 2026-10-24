import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reaConnection } from "../../src/rea/connection.js";
import { manageRea, reaMentionContext, reaServerDefinition } from "../../src/rea/runtime.js";
import { REA_SERVER, REA_WORKFLOW } from "../../src/rea/workflow.js";
import { classifyToolCall } from "../../src/safety/classifier.js";
import { createMcpAgentToolExecutor } from "../../src/agent/turn/mcp-agent-tools.js";
import type { ToolCall } from "../../src/types.js";
import { reaTestRuntime, resetRea, seedRea } from "../helpers/rea-runtime.js";

let root: string;
let host: ReturnType<typeof reaTestRuntime>;
beforeEach(() => {
  resetRea();
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
    expect(await manageRea(host.runtime, "enable")).toMatchObject({ ok: false, output: expect.stringContaining("rea.manage action=setup") });
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

  it("delivers the workflow and the live tool index on every enable without restarting", async () => {
    seedRea();
    const first = await manageRea(host.runtime, "enable");
    expect(first.output).toContain("REA WORKFLOW");
    expect(first.output).toContain("REA TOOLS (151;");
    expect(first.output).toContain("inspect_go_binary(path)");
    const again = await manageRea(host.runtime, "enable");
    expect(again.ok).toBe(true);
    expect(again.output).toContain("already connected");
    expect(again.output).toContain("REA TOOLS (151;");
    expect(host.starts).toEqual([REA_SERVER]);
  });

  it("runs a reconnect after an enable that is still connecting instead of dropping it", async () => {
    seedRea();
    const enabling = manageRea(host.runtime, "enable");
    const reconnecting = manageRea(host.runtime, "reconnect");
    expect((await enabling).ok).toBe(true);
    expect((await reconnecting).ok).toBe(true);
    expect(host.starts.filter((name) => name === REA_SERVER)).toHaveLength(2);
    expect(host.closes).toEqual([REA_SERVER]);
    expect(reaConnection(host.runtime).selected).toBe(true);
  });

  it("adds the tool index to the guide only while connected", async () => {
    seedRea();
    const before = await manageRea(host.runtime, "guide");
    expect(before.output).toContain("REA WORKFLOW");
    expect(before.output).not.toContain("REA TOOLS (");
    expect(before.output).toContain("rea.manage action=enable");
    await manageRea(host.runtime, "enable");
    const after = await manageRea(host.runtime, "guide");
    expect(after.output).toContain("REA TOOLS (151;");
    expect(after.output).not.toContain("rea.manage action=enable");
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
    expect(REA_WORKFLOW.length).toBeLessThan(5_000);
    expect(REA_WORKFLOW).toContain("summary");
    expect(REA_WORKFLOW).toContain("A timeout does not prove");
    expect(REA_WORKFLOW).toContain("ordinary source-repository");
    expect(REA_WORKFLOW).toContain("target_unavailable");
  });

  it("teaches strict arguments, the index and the recovery path without naming a missing tool", () => {
    for (const phrase of ["every REA schema is strict", "REA TOOLS index", "open_binary does not accept it", "rea.manage setup"]) {
      expect(REA_WORKFLOW).toContain(phrase);
    }
  });
});

describe("@rea turn context", () => {
  it("connects an installed REA before the turn and returns the workflow with the live index", async () => {
    seedRea();
    const context = await reaMentionContext(host.runtime);
    expect(context.startsWith("REA WORKFLOW")).toBe(true);
    expect(context).toContain("REA TOOLS (151;");
    expect(context).toContain("Skill directory:");
    expect(host.starts).toEqual([REA_SERVER]);
    expect(host.runtime.getState().selection).toEqual({ mode: "servers", serverNames: [REA_SERVER] });
    expect(await reaMentionContext(host.runtime)).toBe(context);
    expect(host.starts).toEqual([REA_SERVER]);
  });

  it("selects an already connected REA that another selection displaced", async () => {
    seedRea();
    mkdirSync(join(root, ".clai"));
    writeFileSync(join(root, ".clai", "mcp.json"), JSON.stringify({ servers: { docs: { command: "docs" } } }));
    await host.runtime.start();
    await manageRea(host.runtime, "enable");
    host.runtime.selectServers(["docs"]);
    await reaMentionContext(host.runtime);
    expect(host.runtime.getState().selection).toEqual({ mode: "servers", serverNames: ["docs", REA_SERVER] });
    expect(host.starts.filter((name) => name === REA_SERVER)).toHaveLength(1);
  });

  it("keeps the running version when an update was only staged on disk", async () => {
    seedRea("6.7.0");
    await manageRea(host.runtime, "enable");
    seedRea("6.8.0");
    const context = await reaMentionContext(host.runtime);
    expect(context).toContain(join("versions", "6.7.0"));
    expect(context).not.toContain(join("versions", "6.8.0"));
  });

  it("is a short directive when REA is not installed, and starts nothing", async () => {
    const context = await reaMentionContext(host.runtime, { root: join(root, "absent") });
    expect(context).toContain("rea.manage action=setup");
    expect(context).not.toContain("REA TOOLS");
    expect(context.length).toBeLessThan(400);
    expect(host.starts).toEqual([]);
  });

  it("reports a failed connection instead of throwing", async () => {
    seedRea();
    const failing = reaTestRuntime(root, { failStart: true });
    try {
      const context = await reaMentionContext(failing.runtime);
      expect(context.startsWith("REA WORKFLOW\nREA did not connect")).toBe(true);
      expect(context).not.toContain("REA TOOLS");
    } finally {
      await failing.runtime.closeAll();
    }
  });

  it("never claims a user-configured server with the managed name", async () => {
    seedRea();
    mkdirSync(join(root, ".clai"));
    writeFileSync(join(root, ".clai", "mcp.json"), JSON.stringify({ servers: { [REA_SERVER]: { command: "unrelated" } } }));
    await host.runtime.start();
    const context = await reaMentionContext(host.runtime);
    expect(context).toContain("configured outside the managed REA integration");
    expect(context).not.toContain("REA TOOLS");
    expect(host.runtime.getState().selection.mode).toBe("off");
  });

  it("propagates cancellation so an aborted turn does not continue", async () => {
    seedRea();
    const controller = new AbortController();
    controller.abort();
    await expect(reaMentionContext(host.runtime, { signal: controller.signal })).rejects.toThrow();
    expect(host.starts).toEqual([]);
  });

  it("stops waiting for a connection that hangs as soon as the turn is cancelled", async () => {
    seedRea();
    const hanging = reaTestRuntime(root, { hangStart: true });
    try {
      const controller = new AbortController();
      const pending = reaMentionContext(hanging.runtime, { signal: controller.signal });
      await vi.waitFor(() => expect(hanging.starts).toEqual([REA_SERVER]));
      controller.abort(new Error("cancelled by user"));
      await expect(pending).rejects.toThrow("cancelled by user");
    } finally {
      await hanging.runtime.closeAll();
    }
  });
});

it("extends engine startup without imposing an outer analysis deadline", () => {
  const definition = reaServerDefinition({
    version: "6.7.0", node: process.execPath, entry: join(root, "rea.mjs"), directory: root,
  }, root);
  expect(definition.config.connectTimeoutMs).toBe(60_000);
  expect(definition.config.timeoutMs).toBe(0);
  expect(definition.config.transport === "stdio" && definition.config.env).toMatchObject({
    REA_GHIDRA_STARTUP_TIMEOUT_MS: "7200000",
    REA_HOPPER_STARTUP_TIMEOUT_MS: "7200000",
    REA_SWIFTC_COMPILE_TIMEOUT_MS: "600000",
  });
});
