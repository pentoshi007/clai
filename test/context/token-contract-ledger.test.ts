import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { captureTokenContracts, ruleContracts } from "../../scripts/token-contract-ledger.js";

const root = resolve(import.meta.dirname, "../..");
const expected: unknown = JSON.parse(readFileSync(resolve(root, "token-usage-audit/evidence/legacy-contracts.json"), "utf8"));

describe("legacy rule and tool contract ledger", () => {
  it("owns every instruction section and links existing deterministic anchors", () => {
    for (const source of ["src/prompts/system.agent.md", "src/prompts/system.ask.md"]) {
      const headings = [...readFileSync(resolve(root, source), "utf8").matchAll(/^# (.+)$/gm)].map((match) => match[1]);
      expect(ruleContracts.filter((rule) => rule.source === source).map((rule) => rule.heading)).toEqual(headings);
    }
    for (const contract of ruleContracts) {
      expect(contract.obligation.length).toBeGreaterThan(15);
      expect(contract.scenarios.length).toBeGreaterThan(0);
      for (const test of contract.tests) expect(existsSync(resolve(root, test)), test).toBe(true);
    }
  });

  it("locks exact source artifacts and ordered complete canonical/wire contracts", () => {
    const actual = captureTokenContracts(root);
    expect(actual).toEqual(expected);
    expect(actual.toolContracts).toHaveLength(47);
    expect(new Set(actual.toolContracts.map((tool) => tool.wireName)).size).toBe(47);
    expect(actual.toolContracts.some((tool) => tool.name === "http.fetch")).toBe(true);
  });

  it("detects early byte changes, tool reorder and argument-contract drift", () => {
    const actual = captureTokenContracts(root);
    const promptFault = structuredClone(actual);
    promptFault.sources[0]!.sha256 = "changed-early-byte";
    expect(promptFault).not.toEqual(expected);
    const orderFault = structuredClone(actual);
    [orderFault.toolContracts[0], orderFault.toolContracts[1]] = [orderFault.toolContracts[1]!, orderFault.toolContracts[0]!];
    expect(orderFault).not.toEqual(expected);
    const argumentFault = structuredClone(actual);
    argumentFault.toolContracts[0]!.parametersSha256 = "changed-bound";
    expect(argumentFault).not.toEqual(expected);
  });
});
