import { describe, expect, it } from "vitest";

import {
  buildInventory,
  diffInventories,
  relocatedExports,
  stripDeclarationPaths,
  HOTSPOT_FILES,
  INVENTORY_SCHEMA_VERSION,
  readBaseline,
} from "../../scripts/quality/contract-inventory.mjs";

import * as runner from "../../src/agent/runner.js";
import {
  TOOL_DEFINITIONS,
  NON_REGISTRY_TOOL_NAMES,
  PLAN_TOOL_NAMES,
  RESPONDER_TOOL_NAMES,
  RUNNER_META_TOOL_NAMES,
} from "../../src/tools/definitions.js";
import { slashCommands } from "../../src/app/commands/catalog.js";
import { providerIds } from "../../src/types.js";

/**
 * Public contract inventory gate (Phase 0, P0-03).
 *
 * Phase 1 is hard-blocked until `runAgentLoop`/`runAgentTurn` signatures, runner
 * exports, and the runner's no-direct-write policy are protected. The compiled
 * inventory covers every Phase 1-6 hotspot; the runtime assertions below cover
 * aggregates that a type signature cannot express (tool order, command aliases,
 * provider identity).
 *
 * Regenerate intentionally, and only with a reviewed contract change:
 *   node scripts/quality/contract-inventory.mjs --write
 */

const RUNNER_MODULE = "src/agent/runner.ts";

describe("public contract inventory", () => {
  const baseline = readBaseline();
  const current = buildInventory();

  it("keeps the baseline schema and module set aligned", () => {
    expect(baseline.schemaVersion).toBe(INVENTORY_SCHEMA_VERSION);
    expect(current.modules.map((entry) => entry.module)).toEqual(
      [...HOTSPOT_FILES].sort((left, right) => left.localeCompare(right, "en-US")),
    );
    expect(baseline.modules.map((entry) => entry.module)).toEqual(
      current.modules.map((entry) => entry.module),
    );
  });

  it("reports no export or signature drift across Phase 1-6 hotspots", () => {
    // A readable list of differences is the point: a failure here names the
    // exact module, export and type change rather than dumping a whole file.
    expect(diffInventories(baseline, current)).toEqual([]);
  });

  it("detects a removed export, an added export, and a changed signature", () => {
    // Proves the comparator actually fails; a gate that cannot fail is not a gate.
    const mutated = structuredClone(current);
    const runnerModule = mutated.modules.find((entry) => entry.module === RUNNER_MODULE);
    expect(runnerModule).toBeDefined();
    const target = runnerModule!.exports.find((entry) => entry.name === "runAgentTurn");
    expect(target).toBeDefined();
    target!.type = "(prompt: string) => Promise<void>";
    runnerModule!.exports = runnerModule!.exports.filter(
      (entry) => entry.name !== "runAgentLoop",
    );
    runnerModule!.exports.push({ name: "zzNewExport", kind: "function", type: "() => void" });

    const differences = diffInventories(baseline, mutated);
    expect(differences).toContain(
      `removed export: ${RUNNER_MODULE}#runAgentLoop (function)`,
    );
    expect(differences).toContain(`added export: ${RUNNER_MODULE}#zzNewExport`);
    expect(
      differences.some((line) => line.startsWith(`changed type: ${RUNNER_MODULE}#runAgentTurn`)),
    ).toBe(true);
  });

  it("classifies re-exported declarations by their resolved kind", () => {
    // A compatibility re-export is the migration technique the program mandates,
    // so `export { x } from "./moved.js"` must report x's real declaration kind
    // instead of the structural "alias" it would otherwise resolve to.
    const kinds = new Set(
      current.modules.flatMap((entry) => entry.exports.map((item) => item.kind)),
    );
    expect(kinds.has("alias")).toBe(false);

    const httpModule = current.modules.find(
      (entry) => entry.module === "src/llm/http.ts",
    );
    expect(httpModule?.exports.find((entry) => entry.name === "readJson")?.kind).toBe(
      "function",
    );
  });

  it("separates a relocated declaration from a changed contract", () => {
    const qualify = (module: string) =>
      `(value: import("<repo>/src/${module}", { with: { "resolution-mode": "import" } }).Style) => string`;
    const moved = structuredClone(current);
    const runnerModule = moved.modules.find((entry) => entry.module === RUNNER_MODULE);
    const target = runnerModule!.exports.find((entry) => entry.name === "runAgentTurn");
    const baselineCopy = structuredClone(baseline);
    const baselineTarget = baselineCopy.modules
      .find((entry: { module: string }) => entry.module === RUNNER_MODULE)!
      .exports.find((entry: { name: string }) => entry.name === "runAgentTurn");
    baselineTarget!.type = qualify("agent/runner");
    target!.type = qualify("agent/turn/moved");

    expect(stripDeclarationPaths(qualify("agent/runner"))).toBe(
      stripDeclarationPaths(qualify("agent/turn/moved")),
    );
    expect(diffInventories(baselineCopy, moved)).toEqual([]);
    expect(relocatedExports(baselineCopy, moved)).toContain(
      `${RUNNER_MODULE}#runAgentTurn`,
    );
  });

  it("still reports a changed contract when the structure differs at the same path", () => {
    const mutated = structuredClone(current);
    const runnerModule = mutated.modules.find((entry) => entry.module === RUNNER_MODULE);
    const target = runnerModule!.exports.find((entry) => entry.name === "runAgentTurn");
    target!.type = target!.type.replace("prompt: string", "prompt: number");

    const differences = diffInventories(baseline, mutated);
    expect(
      differences.some((line) => line.startsWith(`changed type: ${RUNNER_MODULE}#runAgentTurn`)),
    ).toBe(true);
    expect(relocatedExports(baseline, mutated)).not.toContain(
      `${RUNNER_MODULE}#runAgentTurn`,
    );
  });

  it("still reports a kind change when a declaration kind really changes", () => {
    const mutated = structuredClone(current);
    const runnerModule = mutated.modules.find((entry) => entry.module === RUNNER_MODULE);
    const target = runnerModule!.exports.find((entry) => entry.name === "runAgentTurn");
    target!.kind = "variable";

    expect(diffInventories(baseline, mutated)).toContain(
      `changed kind: ${RUNNER_MODULE}#runAgentTurn: function -> variable`,
    );
  });
});

describe("runner contract hard gate", () => {
  const runnerExports = () => {
    const inventory = buildInventory();
    const module = inventory.modules.find((entry) => entry.module === RUNNER_MODULE);
    if (!module) throw new Error("runner module missing from inventory");
    return new Map(module.exports.map((entry) => [entry.name, entry]));
  };

  it("exposes runAgentLoop and runAgentTurn with unchanged signatures", () => {
    const exportsByName = runnerExports();
    expect(exportsByName.get("runAgentLoop")?.type).toBe(
      '(prompt: string, options?: import("<repo>/src/agent/runner", { with: { "resolution-mode": "import" } }).AgentRunOptions) => Promise<string>',
    );
    expect(exportsByName.get("runAgentTurn")?.type).toBe(
      '(prompt: string, options?: import("<repo>/src/agent/runner", { with: { "resolution-mode": "import" } }).AgentRunOptions) => Promise<import("<repo>/src/agent/turn-outcome", { with: { "resolution-mode": "import" } }).TurnOutcome>',
    );
  }, 120_000);

  it("keeps both entrypoints callable with a single prompt argument", () => {
    expect(typeof runner.runAgentLoop).toBe("function");
    expect(typeof runner.runAgentTurn).toBe("function");
    expect(runner.runAgentLoop.length).toBe(1);
    expect(runner.runAgentTurn.length).toBe(1);
  });

  it("does not lose runtime exports from the runner module", () => {
    const baseline = readBaseline();
    const module = baseline.modules.find((entry) => entry.module === RUNNER_MODULE);
    const expectedRuntimeNames = module!.exports
      .filter((entry) => entry.kind === "function" || entry.kind === "variable")
      .map((entry) => entry.name)
      .sort();
    const actual = Object.keys(runner as Record<string, unknown>).sort();
    for (const name of expectedRuntimeNames) expect(actual).toContain(name);
  });
});

describe("runtime aggregate contracts", () => {
  it("preserves tool names, wire names, and their declared order", () => {
    const names = TOOL_DEFINITIONS.map((definition) => definition.name);
    expect(names.length).toBe(new Set(names).size);
    expect(
      TOOL_DEFINITIONS.map((definition) => ({
        name: definition.name,
        wireName: definition.wireName,
      })),
    ).toMatchSnapshot("tool-definition-order");
  });

  it("preserves each tool's parameter property order and flags", () => {
    const schemaOrder = TOOL_DEFINITIONS.map((definition) => ({
      name: definition.name,
      properties: Object.keys(definition.parameters.properties ?? {}),
      required: [...(definition.parameters.required ?? [])],
      mutates: definition.mutates ?? false,
      readOnly: definition.readOnly ?? false,
      askMode: definition.askMode ?? false,
    }));
    expect(schemaOrder).toMatchSnapshot("tool-schema-order");
  });

  it("preserves the special-purpose tool name sets", () => {
    expect([...PLAN_TOOL_NAMES].sort()).toMatchSnapshot("plan-tool-names");
    expect([...RESPONDER_TOOL_NAMES].sort()).toMatchSnapshot("responder-tool-names");
    expect([...RUNNER_META_TOOL_NAMES].sort()).toMatchSnapshot("runner-meta-tool-names");
    expect([...NON_REGISTRY_TOOL_NAMES].sort()).toMatchSnapshot("non-registry-tool-names");
  });

  it("preserves slash command names, usage, and order", () => {
    const commands = slashCommands.map((command) => ({
      command: command.command,
      usage: command.usage ?? null,
    }));
    expect(commands.map((entry) => entry.command).length).toBe(
      new Set(commands.map((entry) => entry.command)).size,
    );
    expect(commands).toMatchSnapshot("slash-command-catalog");
  });

  it("preserves built-in provider identity and order", () => {
    expect([...providerIds]).toMatchSnapshot("provider-ids");
  });
});
