import { writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assembleTokenFixture, assemblyFixtureMatrix, measureTokenAssembly } from "../../scripts/token-assembly-fixtures.js";
import { getToolDefinitions } from "../../src/tools/definitions.js";
import { estimateTextTokens } from "../../src/agent/request-accounting.js";
import baseline from "../../token-usage-audit/evidence/assembly-baseline.json" with { type: "json" };

vi.mock("../../src/os/detect.js", () => ({
  detectSystem: () => ({ platform: "linux", osName: "Linux", arch: "arm64", release: "synthetic", shell: "/bin/bash", cwd: "/project" }),
}));
vi.mock("../../src/os/cwd.js", () => ({ safeCwd: () => "/project" }));
vi.mock("../../src/store/session-workspace.js", async (load) => ({
  ...await load<typeof import("../../src/store/session-workspace.js")>(),
  getActiveSessionScratchDir: () => "/scratch/fixture",
}));
vi.mock("../../src/store/scope.js", async (load) => ({
  ...await load<typeof import("../../src/store/scope.js")>(),
  loadScopeForSession: async () => ({ name: "synthetic-lab", authorizedTargets: ["127.0.0.1"], excludedTargets: ["example.com"], allowedMethods: ["GET", "HEAD"], maxRate: 2 }),
}));

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T09:00:00.000Z"));
  vi.stubEnv("CLAI_SLIM_NATIVE_PROMPT", "true");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Offline assembly must not access the network"); }));
});
afterAll(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("isolated full-assembly baseline", () => {
  it("covers every declared task, protocol, catalog and modality combination", () => {
    expect(assemblyFixtureMatrix).toHaveLength(64);
    expect(new Set(assemblyFixtureMatrix.map((fixture) => fixture.id)).size).toBe(64);
    expect(new Set(assemblyFixtureMatrix.map((fixture) => fixture.kind))).toEqual(new Set(["coding", "security", "ask", "plan"]));
  });

  it.each(assemblyFixtureMatrix)("accounts for $id without changing its contracts", async (fixture) => {
    const assembled = await assembleTokenFixture(fixture);
    const measurement = measureTokenAssembly(fixture, assembled);
    const { messages, tools, prompt, history } = assembled;
    const locked = baseline.records.find((record) => record.id === fixture.id);
    expect(locked).toBeDefined();
    expect(measurement.components.stablePrompt).toEqual(locked!.components.stablePrompt);
    expect(measurement.components.canonicalTools).toEqual(locked!.components.canonicalTools);
    expect(measurement.components.wireTools).toEqual(locked!.components.wireTools);
    expect(measurement.providerUsage).toBeNull();
    expect(measurement.precision).toBe("character-estimate");
    expect(measurement.userTaskCopies).toBe(1);
    expect(messages[0]?.content).toBe(assembled.stablePrompt);
    expect(messages.slice(1, 1 + history.length)).toEqual(history);
    expect(measurement.components.messageContent.characters).toBe(
      measurement.components.stablePrompt.characters + measurement.components.history.characters + measurement.components.currentTask.characters + measurement.components.dynamicContext.characters,
    );
    expect(measurement.components.currentTask.characters).toBe(prompt.length);
    expect(measurement.components.canonicalTools.estimatedTokens).toBe(estimateTextTokens(JSON.stringify(tools ?? [])));
    expect(measurement.finalWire.bytes).toBeGreaterThan(measurement.components.messageContent.bytes);
    const mcpCount = fixture.kind === "ask" ? 3 : 7;
    const selectedCount = 37 + (fixture.mcp ? mcpCount : 0) + Number(fixture.vision);
    expect(measurement.toolCount).toBe(fixture.native ? selectedCount : 0);
    expect(tools?.map((tool) => tool.name) ?? []).toEqual(
      getToolDefinitions().filter((tool) => assembled.toolNames.includes(tool.name) && fixture.native).map((tool) => tool.name),
    );
    expect(messages.some((message) => message.content.includes("Preserve synthetic project constraints in full"))).toBe(true);
    expect(messages.some((message) => message.content.includes("synthetic-review"))).toBe(true);
    expect(measurement.accounting.imageCount).toBe(fixture.vision ? 1 : 0);
    expect(measurement.accounting.artifactTokens).toBeGreaterThan(0);
    if (fixture.kind === "plan") {
      expect(messages.some((message) => message.content.includes("Verify invalid signatures and replay boundaries without dropping criteria"))).toBe(true);
      expect(messages.some((message) => message.content.startsWith("ACTIVE PLAN"))).toBe(true);
    }
    if (fixture.kind === "security") expect(messages.some((message) => message.content.includes("synthetic-lab"))).toBe(true);
    expect(measureTokenAssembly(fixture, await assembleTokenFixture(fixture))).toEqual(measurement);
  });

  it("writes only bounded counts, digests and synthetic provenance when explicitly requested", async () => {
    const destination = process.env.CLAI_ASSEMBLY_REPORT;
    if (!destination) return;
    const records = [];
    for (const fixture of assemblyFixtureMatrix) records.push(measureTokenAssembly(fixture, await assembleTokenFixture(fixture)));
    const report = {
      version: 1,
      provenance: "Synthetic inputs through buildSystemSections, composeTurnMessages, accountAssembledRequest and chatCompletionsBodyFromPlan; no provider calls",
      environment: "Fixed date, synthetic Linux arm64 /project, isolated config, synthetic project/skill/plan/scope/history/image/reasoning inputs",
      records,
    };
    const { records: measured, ...metadata } = report;
    const serialized = `${JSON.stringify(metadata).slice(0, -1)},\n"records":[\n${measured.map((record) => JSON.stringify(record)).join(",\n")}\n]}`;
    expect(serialized).not.toContain("dataBase64");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("Preserve synthetic project constraints in full");
    await writeFile(destination, `${serialized}\n`);
  });
});
