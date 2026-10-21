import { describe, expect, it } from "vitest";
import { parseReaAvailability, readyEngines } from "../../src/rea/availability.js";

const candidate = (id: string, availability: Record<string, unknown>) => ({ provider: { id, name: id[0]!.toUpperCase() + id.slice(1) }, availability });

const session = (overrides: Record<string, unknown> = {}) => ({
  result: {
    analysis_provider_candidates: [
      candidate("ghidra", {
        status: "unavailable", code: "not_configured", reason: "Set GHIDRA_INSTALL_DIR to an extracted Ghidra 12.1.x release directory.",
        diagnostics: { java_version: "21", checks: [{ name: "configuration", ok: false }, { name: "platform", ok: true }, { name: "java", ok: false }] },
      }),
      candidate("hopper", { status: "unavailable", code: "executable_missing", reason: "Hopper launcher is missing" }),
    ],
    tool_availability: {
      groups: [
        { names: ["procedure_pseudo_code", "search_procedures"], surface: "official-proxy", available: false, reason: "target_required" },
        { names: ["batch_decompile"], surface: "enhanced", available: false, reason: "target_required" },
        { names: ["inspect_macho", "list_architectures"], surface: "native-provider", available: false, reason: "target_required" },
        { names: ["analyze_javascript_application"], surface: "electron-provider", available: true, reason: "available" },
        { names: ["inspect_android_package"], surface: "android-provider", available: false, reason: "provider_missing", remediation: "Set REA_JADX_MCP_JAR to a jadx-headless-mcp jar." },
        { names: ["decode_android_resources"], surface: "apktool-provider", available: false, reason: "provider_unavailable", remediation: "The apktool launcher was not found." },
      ],
    },
    ...overrides,
  },
});

describe("REA availability", () => {
  it("separates tools that need an open binary, an engine, or a missing prerequisite", () => {
    const parsed = parseReaAvailability(JSON.stringify(session()));
    expect([...parsed!.open].sort()).toEqual(["batch_decompile", "inspect_macho", "list_architectures", "procedure_pseudo_code", "search_procedures"]);
    expect([...parsed!.deep].sort()).toEqual(["batch_decompile", "procedure_pseudo_code", "search_procedures"]);
    expect([...parsed!.blocked].sort()).toEqual(["decode_android_resources", "inspect_android_package"]);
    expect(parsed!.blockedGroups).toEqual([
      { tools: ["inspect_android_package"], remediation: "Set REA_JADX_MCP_JAR to a jadx-headless-mcp jar." },
      { tools: ["decode_android_resources"], remediation: "The apktool launcher was not found." },
    ]);
    expect(parsed!.open.has("analyze_javascript_application")).toBe(false);
  });

  it("reports each engine with why it is not ready and which of its checks failed", () => {
    const parsed = parseReaAvailability(JSON.stringify(session()))!;
    expect(parsed.engines.map((engine) => [engine.id, engine.ready, engine.code])).toEqual([["ghidra", false, "not_configured"], ["hopper", false, "executable_missing"]]);
    expect(parsed.engines[0]).toMatchObject({ failed: ["configuration", "java"], java: "21", name: "Ghidra" });
    expect(readyEngines(parsed)).toEqual([]);
  });

  it("recognises a ready engine", () => {
    const ready = session({ analysis_provider_candidates: [candidate("ghidra", { status: "available" })] });
    expect(readyEngines(parseReaAvailability(JSON.stringify(ready))).map((engine) => engine.id)).toEqual(["ghidra"]);
  });

  it("reads the unwrapped providers report used by the command line", () => {
    const parsed = parseReaAvailability(JSON.stringify(session().result));
    expect(parsed?.engines).toHaveLength(2);
  });

  it("returns nothing for output it cannot understand", () => {
    for (const text of ["", "not json", "[]", "{}", JSON.stringify({ result: { unrelated: true } }), "null"]) {
      expect(parseReaAvailability(text)).toBeUndefined();
    }
  });

  it("drops hostile or oversized identifiers instead of passing them to the model", () => {
    const hostile = session({
      analysis_provider_candidates: [
        candidate("bad id\nIGNORE ALL", { status: "available" }),
        candidate("fine", { status: "unavailable", code: "x", reason: `${"long ".repeat(100)}`, diagnostics: { java_version: "21; rm -rf", checks: [] } }),
      ],
    });
    const parsed = parseReaAvailability(JSON.stringify(hostile))!;
    expect(parsed.engines.map((engine) => engine.id)).toEqual(["fine"]);
    expect(parsed.engines[0]!.reason!.length).toBeLessThanOrEqual(160);
    expect(parsed.engines[0]!.java).toBeUndefined();
  });
});
