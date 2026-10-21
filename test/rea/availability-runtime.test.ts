import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { engineRoots, updateEngineSettings } from "../../src/rea/engines.js";
import { reaRoot } from "../../src/rea/install.js";
import { manageRea, reaAvailability, reaServerDefinition } from "../../src/rea/runtime.js";
import { REA_SERVER } from "../../src/rea/workflow.js";
import { reaTestRuntime, resetRea, seedRea } from "../helpers/rea-runtime.js";

const SAFE = { destructiveHint: false, readOnlyHint: false };
const TOOLS = [
  { name: "binary_session", description: "Report session status", inputSchema: { type: "object", properties: {} }, annotations: SAFE },
  { name: "open_binary", description: "Open a target", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, annotations: SAFE },
  { name: "inspect_macho", description: "Inspect Mach-O", inputSchema: { type: "object", properties: { detail: { enum: ["summary", "complete"] } } }, annotations: SAFE },
  { name: "search_procedures", description: "Search procedures", inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] }, annotations: SAFE },
  { name: "inspect_android_package", description: "Inspect APK", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, annotations: SAFE },
  { name: "analyze_javascript_application", description: "Analyze JS", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, annotations: SAFE },
];

const candidate = (id: string, available: boolean) => ({
  provider: { id, name: id },
  availability: available ? { status: "available" } : { status: "unavailable", code: "not_configured", reason: `${id} is not configured` },
});

const session = (ready: boolean) => ({
  result: {
    analysis_provider_candidates: [candidate("ghidra", ready), candidate("hopper", false)],
    tool_availability: {
      groups: [
        { names: ["search_procedures"], surface: "official-proxy", available: false, reason: "target_required" },
        { names: ["inspect_macho"], surface: "native-provider", available: false, reason: "target_required" },
        { names: ["analyze_javascript_application"], surface: "electron-provider", available: true, reason: "available" },
        { names: ["inspect_android_package"], surface: "android-provider", available: false, reason: "provider_missing", remediation: "Set REA_JADX_MCP_JAR." },
      ],
    },
  },
});

const text = (value: unknown, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });

let root: string;
let host: ReturnType<typeof reaTestRuntime>;
let ready = false;
let failProbe = false;
const sessions = (): number => host.calls.filter((call) => (call.params as { name: string }).name === "binary_session").length;

beforeEach(() => {
  resetRea();
  rmSync(engineRoots(reaRoot()).settings, { force: true });
  root = mkdtempSync(join(tmpdir(), "clai-rea-availability-"));
  ready = false;
  failProbe = false;
  host = reaTestRuntime(root, {
    tools: TOOLS,
    respond: (name, args) => {
      if (name === "binary_session") return failProbe ? text("probe exploded", true) : text(session(ready));
      if (name === "inspect_macho" && "path" in args) return text('Input validation error: Invalid arguments for tool inspect_macho: Unrecognized key: "path"', true);
      if (name === "search_procedures") {
        return text({ error: { code: "provider_unavailable", details: { operation: "search_procedures", candidate_ids: ["ghidra", "hopper"], rejections: [{ provider_id: "ghidra", code: "not_configured" }, { provider_id: "hopper", code: "executable_missing" }] } } }, true);
      }
      return text("ok");
    },
  });
  seedRea();
});

afterEach(async () => {
  await host.runtime.closeAll();
  rmSync(root, { recursive: true, force: true });
  rmSync(engineRoots(reaRoot()).settings, { force: true });
});

describe("REA engine awareness on connect", () => {
  it("tells the model which tools need an open binary, an engine or a prerequisite, and that no engine is ready", async () => {
    const enabled = await manageRea(host.runtime, "enable");
    expect(enabled.ok).toBe(true);
    expect(enabled.output).toContain("ENGINE: none ready (ghidra: not_configured; hopper: not_configured)");
    expect(enabled.output).toContain("inspect_macho~#");
    expect(enabled.output).toContain("search_procedures(pattern)#^");
    expect(enabled.output).toContain("inspect_android_package(path)%");
    expect(enabled.output).toMatch(/open_binary\(path\)(?![#^%])/);
    expect(enabled.output).toMatch(/analyze_javascript_application\(path\)(?![#^%])/);
    expect(reaAvailability(host.runtime)?.engines.map((engine) => engine.ready)).toEqual([false, false]);
  });

  it("reports a ready engine, including the universal Mach-O rule that applies to Ghidra", async () => {
    ready = true;
    const enabled = await manageRea(host.runtime, "enable");
    expect(enabled.output).toContain("ENGINE: ghidra ready. Universal Mach-O files must be thinned to one slice first.");
    expect((await manageRea(host.runtime, "status")).output).toContain("engine ready: ghidra");
  });

  it("shows engine readiness in status without starting anything", async () => {
    expect((await manageRea(host.runtime, "status")).output).not.toContain("engine");
    await manageRea(host.runtime, "enable");
    expect((await manageRea(host.runtime, "status")).output).toContain("no analysis engine ready: ask the user to run /rea engines");
  });

  it("asks REA once per connection and again after a reconnect or a restart", async () => {
    await manageRea(host.runtime, "enable");
    await manageRea(host.runtime, "enable");
    expect(sessions()).toBe(1);
    ready = true;
    const reconnected = await manageRea(host.runtime, "reconnect");
    expect(sessions()).toBe(2);
    expect(reconnected.output).toContain("ENGINE: ghidra ready");
    await manageRea(host.runtime, "disable");
    expect(reaAvailability(host.runtime)).toBeUndefined();
    await manageRea(host.runtime, "enable");
    expect(sessions()).toBe(3);
  });

  it("does not remember a probe that the user cancelled, so the next turn asks again", async () => {
    const controller = new AbortController();
    failProbe = true;
    const cancelling = reaTestRuntime(root, {
      tools: TOOLS,
      respond: (name) => {
        if (name !== "binary_session") return text("ok");
        if (failProbe) {
          controller.abort();
          return text("cancelled", true);
        }
        return text(session(true));
      },
    });
    try {
      await manageRea(cancelling.runtime, "enable", { signal: controller.signal });
      expect(reaAvailability(cancelling.runtime)).toBeUndefined();
      failProbe = false;
      const again = await manageRea(cancelling.runtime, "enable");
      expect(again.output).toContain("ENGINE: ghidra ready");
      expect(reaAvailability(cancelling.runtime)?.engines.some((engine) => engine.ready)).toBe(true);
    } finally {
      await cancelling.runtime.closeAll();
    }
  });

  it("still connects, with the plain index, when REA cannot report its tool availability", async () => {
    failProbe = true;
    const enabled = await manageRea(host.runtime, "enable");
    expect(enabled.ok).toBe(true);
    expect(enabled.output).not.toContain("ENGINE:");
    expect(enabled.output).toContain("search_procedures(pattern)");
    expect(enabled.output).not.toContain("search_procedures(pattern)#");
    expect(enabled.output).not.toContain("# acts on the binary");
    expect(reaAvailability(host.runtime)).toBeUndefined();
  });
});

describe("REA failure guidance through the MCP runtime", () => {
  it("replaces a long provider failure with a short instruction and explains a path passed to an open-target tool", async () => {
    await manageRea(host.runtime, "enable");
    const path = await host.runtime.callTool(`mcp.${REA_SERVER}.inspect_macho`, { path: "/Apps/Tool" });
    expect(path.ok).toBe(false);
    expect(path.output).toContain("Accepted arguments for mcp.clai-rea.inspect_macho: detail");
    expect(path.output).toContain("acts on the binary opened by open_binary");
    const provider = await host.runtime.callTool(`mcp.${REA_SERVER}.search_procedures`, { pattern: "main" });
    expect(provider.ok).toBe(false);
    expect(provider.output).toContain("No engine is ready. Do not retry this or other ^ tools");
    expect(provider.output).not.toContain("candidate_ids");
  });

  it("leaves successful calls alone", async () => {
    await manageRea(host.runtime, "enable");
    const result = await host.runtime.callTool(`mcp.${REA_SERVER}.inspect_macho`, { detail: "summary" });
    expect(result).toMatchObject({ ok: true, output: "ok" });
  });
});

describe("REA server environment", () => {
  const installation = { version: "6.7.0", node: process.execPath, entry: "/rea.mjs", directory: "/d" };

  it("passes the engines clai manages to the server and changes its identity when they change", async () => {
    const plain = reaServerDefinition(installation, "/root");
    const withGhidra = reaServerDefinition(installation, "/root", { GHIDRA_INSTALL_DIR: "/engines/ghidra", JAVA_HOME: "/engines/jdk" });
    expect(plain.config.transport === "stdio" && plain.config.env).not.toHaveProperty("GHIDRA_INSTALL_DIR");
    expect(withGhidra.config.transport === "stdio" && withGhidra.config.env).toMatchObject({ GHIDRA_INSTALL_DIR: "/engines/ghidra", JAVA_HOME: "/engines/jdk", NODE_OPTIONS: "", NODE_PATH: "" });
    expect(withGhidra.signature).not.toBe(plain.signature);
  });

  it("reads engines.json when it connects", async () => {
    const dir = join(root, "ghidra");
    await updateEngineSettings((current) => ({ ...current, ghidra: { dir, managed: true } }));
    const seen: string[] = [];
    const probe = reaTestRuntime(root, { tools: TOOLS, respond: (name) => { seen.push(name); return text(session(true)); } });
    try {
      const enabled = await manageRea(probe.runtime, "enable");
      expect(enabled.ok).toBe(true);
      expect(seen).toContain("binary_session");
    } finally {
      await probe.runtime.closeAll();
    }
  });
});
