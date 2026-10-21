import { describe, expect, it } from "vitest";
import type { ReaAvailability, ReaEngine } from "../../src/rea/availability.js";
import { describeEngines, engineSummary } from "../../src/rea/engine-report.js";
import type { EngineReport } from "../../src/rea/engine-status.js";
import type { EngineHost } from "../../src/rea/ghidra.js";

const engine = (id: string, ready: boolean, reason?: string): ReaEngine => ({
  id, name: id[0]!.toUpperCase() + id.slice(1), ready, code: ready ? undefined : "not_configured", reason, failed: [], java: undefined,
});

const availability = (...engines: ReaEngine[]): ReaAvailability => ({ engines, open: new Set(), deep: new Set(), blocked: new Set(), blockedGroups: [] });

const report = (host: EngineHost, overrides: Partial<EngineReport> = {}): EngineReport => ({
  rea: { state: "ready", installation: { version: "6.7.0", node: "/n", entry: "/e", directory: "/d" } },
  settings: {}, found: [], failure: undefined, host,
  availability: availability(engine("ghidra", false, "GHIDRA_INSTALL_DIR is not set"), engine("hopper", false, "launcher missing"), engine("ida", false), engine("kuna", false)),
  ...overrides,
});

const MAC: EngineHost = { platform: "darwin", arch: "arm64" };
const LINUX_X64: EngineHost = { platform: "linux", arch: "x64" };
const LINUX_ARM: EngineHost = { platform: "linux", arch: "arm64" };
const WINDOWS: EngineHost = { platform: "win32", arch: "x64" };

describe("engine report", () => {
  it("lists every engine with its reason and the command that fixes it", () => {
    const text = describeEngines(report(MAC));
    for (const command of ["/rea engines install ghidra", "/rea engines use ghidra <folder>", "/rea engines use hopper <launcher path>", "/rea engines use ida <registration.json>", "/rea engines use kuna <executable>"]) expect(text).toContain(`\`${command}\``);
    expect(text).toContain("REA 6.7.0 is installed.");
    expect(text).toContain("✗ Ghidra · GHIDRA_INSTALL_DIR is not set");
    expect(text).toContain("/rea engines install ghidra");
    expect(text).toContain("/rea engines use ghidra <folder>");
    expect(text).toContain("✗ Hopper · launcher missing");
    expect(text).toContain("/rea engines use hopper <launcher path>");
    expect(text).toContain("✗ IDA");
    expect(text).toContain("/rea engines use ida <registration.json>");
    expect(text).toContain("/rea engines use kuna <executable>");
    expect(text).toContain("the agent never installs or configures them");
    expect(text).toContain("Without an engine REA still handles");
  });

  it("explains the one-time decompiler build on systems whose release lacks it", () => {
    for (const host of [MAC, LINUX_ARM]) expect(describeEngines(report(host))).toContain("builds its native decompiler once (needs make, a C++ compiler and bison)");
    for (const host of [LINUX_X64, WINDOWS]) expect(describeEngines(report(host))).not.toContain("builds its native decompiler");
  });

  it("states what is unavailable or experimental on Windows", () => {
    const text = describeEngines(report(WINDOWS));
    expect(text).toContain("REA's Windows Ghidra support is experimental (x64 only)");
    expect(text).toContain("Hopper is not available on Windows");
    expect(text).toContain("Kuna is not supported on Windows");
    expect(text).not.toContain("hopperapp.com");
  });

  it("shows a ready engine without fix-it commands and points at installations it found", () => {
    const ready = describeEngines(report(LINUX_X64, { availability: availability(engine("ghidra", true), engine("hopper", false, "no launcher")) }));
    expect(ready).toContain("✓ Ghidra · ready");
    expect(ready).not.toContain("/rea engines install ghidra");
    const found = describeEngines(report(MAC, {
      settings: { ghidra: { dir: "/Users/me/.clai/tools/ghidra/12.1.4", managed: true, version: "12.1.4" } },
      found: [{ ok: true, dir: "/Applications/ghidra_12.1.3_PUBLIC", version: "12.1.3", decompiler: true }],
    }));
    expect(found).toContain("configured: `/Users/me/.clai/tools/ghidra/12.1.4` (installed by clai, 12.1.4)");
    expect(found).toContain("found 12.1.3 at `/Applications/ghidra_12.1.3_PUBLIC`");
    expect(found).toContain("`/rea engines use ghidra /Applications/ghidra_12.1.3_PUBLIC`");
    expect(found).toContain("/rea engines use ghidra /Applications/ghidra_12.1.3_PUBLIC");
    const bare = describeEngines(report(MAC, { found: [{ ok: true, dir: "/opt/ghidra", version: "12.1.2", decompiler: false }] }));
    expect(bare).toContain("found 12.1.2 at `/opt/ghidra` (no native decompiler for this machine)");
    expect(bare).not.toContain("/rea engines use ghidra /opt/ghidra");
  });

  it("degrades to a useful report when REA is missing or its engine list cannot be read", () => {
    const missing = describeEngines(report(MAC, { rea: { state: "missing" }, availability: undefined }));
    expect(missing).toContain("REA is not installed: run `/rea setup` first");
    expect(missing).toContain("✗ Ghidra");
    const failed = describeEngines(report(MAC, { availability: undefined, failure: "REA timed out" }));
    expect(failed).toContain("Could not read REA's engine report: REA timed out");
    expect(failed).toContain("✗ Ghidra · REA timed out");
  });

  it("lists prerequisites REA reports missing for other tasks, bounded", () => {
    const groups = Array.from({ length: 12 }, (_, index) => ({ tools: [`tool_${index}a`, `tool_${index}b`, `tool_${index}c`, `tool_${index}d`], remediation: `Install thing ${index}` }));
    const text = describeEngines(report(LINUX_X64), groups);
    expect(text).toContain("Other tasks that need extra tools on this machine:");
    expect(text).toContain("tool_0a, tool_0b, tool_0c, …: Install thing 0");
    expect(text).toContain("… and 4 more");
    expect(text).not.toContain("Install thing 8");
  });

  it("summarises readiness in one line", () => {
    expect(engineSummary(report(MAC))).toBe("no analysis engine ready · /rea engines");
    expect(engineSummary(report(MAC, { availability: availability(engine("ghidra", true), engine("kuna", true)) }))).toBe("engine ready: Ghidra, Kuna");
  });
});
