import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DENSITY_SECTIONS } from "../../src/prompts/candidate-density-embedded.js";
import { densifyLegacyPrompt, densityPromptProfile, densitySections } from "../../src/prompts/density-profile.js";
import { legacyPromptProfile } from "../../src/prompts/legacy-profile.js";
import { resolvePromptProfile } from "../../src/prompts/profile-catalog.js";
import { createPromptProfiles, parsePromptProfiles } from "../../src/prompts/profile-state.js";
import { validateProfileArtifacts } from "../../src/prompts/profile-binding.js";
import { createToolRouting } from "../../src/agent/turn/tool-routing.js";
import { ruleContracts } from "../../scripts/token-contract-ledger.js";

const obligations = [
  { id: "build-1", heading: "BUILDING SOFTWARE", fragments: ["leading `/`", "real project root", "never the agent package tree"] },
  { id: "build-2", heading: "BUILDING SOFTWARE", fragments: ["types, signatures, callers, schemas, config, API shapes and data flow", "package-lock→npm", "pnpm-lock→pnpm", "yarn.lock→yarn", "bun.lockb→bun", "sensible modern stack"] },
  { id: "build-3", heading: "BUILDING SOFTWARE", fragments: ["never re-scaffold", "official non-interactive", "NEW EMPTY", "not its parent", "cancellation is failure", "hidden temporary tree", "hand-write", "preserve config"] },
  { id: "build-4-5", heading: "BUILDING SOFTWARE", fragments: ["working feature, not a starter/scaffold", "explicit/implicit criteria and invariants", "empty, duplicate, error, persistence and reload", "add/list/toggle/delete", "Replace starter boilerplate"] },
  { id: "build-6-8", heading: "BUILDING SOFTWARE", fragments: ["contracts (types", "complete files in one call", "repair truncated writes", "typecheck/build/tests→live verification", "Fix failures", "only observed passes"] },
  { id: "build-9-10", heading: "BUILDING SOFTWARE", fragments: ["Never hardcode secrets", "validate input", "parameterize SQL", "disclose unauthenticated endpoints", "Preserve installed versions/conventions", "verify unfamiliar names"] },
  { id: "build-11", heading: "BUILDING SOFTWARE", fragments: ["track implement", "tracked background service", "readiness/behavior", "LEAVE it running", "URL + job id", "do not thrash proven ports", "Libraries/CLIs need tests/build, not servers"] },
  { id: "build-12", heading: "BUILDING SOFTWARE", fragments: ["remote pentest needs evidence on its remote target", "never a local dev server", "do not reopen completed tasks"] },
  { id: "style-intro", heading: "CODE STYLE", fragments: ["Repo/user steering (including requested comments) overrides", "Working verified code outranks", "do not rewrite working code"] },
  { id: "style-1-2", heading: "CODE STYLE", fragments: ["≲10 decisions", "≲3 nesting", "cyclomatic/cognitive complexity <22", "Halstead difficulty <80", "CRAP <25", "file <500 lines", "never game metrics", "surviving mutants"] },
  { id: "style-3", heading: "CODE STYLE", fragments: ["Comments explain only why", "Names beat narration", "no restating code", "banners", "stale/false or commented-out code"] },
  { id: "style-4", heading: "CODE STYLE", fragments: ["no `any` or laundering casts", "`unknown` belongs only at external edges", "narrow/parse immediately"] },
  { id: "style-5-8", heading: "CODE STYLE", fragments: ["early returns and named conditions", "Delete unnecessary branches and equivalent arms", "derive values", "Avoid nested ternaries", "one-shot helpers", "No unused abstraction", "type-impossible states", "Match the edited file's patterns"] },
  { id: "debug-1-4", heading: "DEBUGGING & FIXING", fragments: ["same failing command/URL and full error", "file:line/stack/status/assertion", "one primary cause", "confirming/refuting code/config"] },
  { id: "debug-5-7", heading: "DEBUGGING & FIXING", fragments: ["minimal root-cause fix", "prefer fs.edit", "rerun the original failure", "fails before/passes after", "nearby checks", "~2 similar failed attempts", "change layer/approach"] },
  { id: "debug-final", heading: "DEBUGGING & FIXING", fragments: ["symptom suppression is not a completed fix", "apply a known correction now", "then verify", "environment/tool versions/paths before rewriting"] },
];

function missingObligations(value: string): string[] {
  const sections = densitySections(value);
  return obligations.filter((obligation) => obligation.fragments.some((fragment) => !sections.get(obligation.heading)?.includes(fragment))).map((obligation) => obligation.id);
}

const root = resolve(import.meta.dirname, "../..");
describe("isolated density profile source contracts", () => {
  it("embeds the exact candidate source and retains every mapped source obligation", () => {
    expect(readFileSync(resolve(root, "src/prompts/candidate-density-sections.md"), "utf8")).toBe(DENSITY_SECTIONS);
    expect([...densitySections(DENSITY_SECTIONS).keys()]).toEqual(["BUILDING SOFTWARE", "CODE STYLE", "DEBUGGING & FIXING"]);
    expect(missingObligations(DENSITY_SECTIONS)).toEqual([]);
    for (const obligation of obligations) {
      expect(ruleContracts.some((rule) => rule.heading === obligation.heading && rule.scenarios.length > 0)).toBe(true);
      expect(missingObligations(DENSITY_SECTIONS.replace(obligation.fragments[0]!, "removed-obligation"))).toContain(obligation.id);
    }
  });

  it("replaces only the three named sections and keeps every other section byte-identical", () => {
    const source = readFileSync(resolve(root, "src/prompts/system.agent.md"), "utf8");
    const before = densitySections(source);
    const candidate = densitySections(densifyLegacyPrompt(source));
    expect([...candidate.keys()]).toEqual([...before.keys()]);
    for (const [heading, section] of before) {
      expect(candidate.get(heading)).toBe(densitySections(DENSITY_SECTIONS).get(heading) ?? section);
    }
    const untouched = (value: string) => value.replace(/^# (BUILDING SOFTWARE|CODE STYLE|DEBUGGING & FIXING)\n[\s\S]*?(?=^# |$(?![\s\S]))/gm, "<candidate-section>\n");
    expect(untouched(densifyLegacyPrompt(source))).toBe(untouched(source));
    expect(densifyLegacyPrompt("# OTHER\nno candidate heading\n")).toBe("# OTHER\nno candidate heading\n");
  });

  it("resolves only explicit candidate identity, preserves schemas and restores exact bindings", () => {
    const profile = densityPromptProfile();
    expect(resolvePromptProfile("density-v1")).toBe(profile);
    expect(profile.digest).not.toBe(legacyPromptProfile().digest);
    expect(profile.tools(["http.fetch", "fs.read"])).toEqual(legacyPromptProfile().tools(["http.fetch", "fs.read"]));
    const state = createPromptProfiles(profile.id);
    const routing = createToolRouting({ mode: "agent", mcpPresent: true, toolCalling: "native", useCompactSystemPrompt: () => false, promptProfiles: state });
    const before = routing.buildStableSystemContent(true, "openai", "gpt-4o");
    const restored = parsePromptProfiles(JSON.parse(JSON.stringify(state)))!;
    validateProfileArtifacts(restored);
    const continued = createToolRouting({ mode: "agent", mcpPresent: false, toolCalling: "native", useCompactSystemPrompt: () => true, promptProfiles: restored });
    expect(continued.buildStableSystemContent(true, "openai", "gpt-4o")).toBe(before);
    expect(continued.selectToolDefs(true, true, "openai", "gpt-4o")).toEqual(routing.selectToolDefs(true, false, "openai", "gpt-4o"));
    expect(continued.executionRulesInSystem(true, "openai", "gpt-4o")).toBe(true);
    expect(createPromptProfiles().defaultProfile).toBe("legacy-v1");
  });
});
