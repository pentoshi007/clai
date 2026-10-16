import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getToolDefinitions } from "../src/tools/definitions.js";
import { toOpenAiTools } from "../src/llm/adapters/openai-tools.js";

export interface RuleContract {
  readonly source: string;
  readonly heading: string;
  readonly obligation: string;
  readonly tests: readonly string[];
  readonly scenarios: readonly string[];
}
const agent = "src/prompts/system.agent.md";
const ask = "src/prompts/system.ask.md";
const rule = (source: string, heading: string, obligation: string, tests: readonly string[], scenarios: readonly string[]): RuleContract => ({ source, heading, obligation, tests, scenarios });
export const ruleContracts: readonly RuleContract[] = [
  rule(agent, "ROLE", "Preserve engineering/security capability, prompt confidentiality and execution ownership", ["test/token-overhead.test.ts"], ["C01", "S08", "S10"]),
  rule(agent, "HOW YOU THINK", "Classify query/directive, derive acceptance and invariants, inspect contracts, verify outcomes and reconcile scope", ["test/agent/system-sections.test.ts", "test/agent/prompt-sections.test.ts", "test/plan-coding-run-verify.test.ts"], ["C01", "C02", "C04", "C09"]),
  rule(agent, "HONESTY — THE RULE THAT OVERRIDES ALL OTHERS", "Tie claims to observed results; disclose incomplete and failed outcomes", ["test/agent/responder-claims.test.ts"], ["C10", "S03", "S06"]),
  rule(agent, "SECURITY POSTURE — FULL OFFENSIVE CAPABILITY", "Preserve authorized security workflows and non-destructive scope", ["test/http-policy.test.ts", "test/scope-session-isolation.test.ts"], ["S01", "S04", "S06", "S08"]),
  rule(agent, "TOOL CALLS — HOW TO USE TOOLS", "Use exact tool arguments and native/text protocols with discovery rather than fabricated names", ["test/security/tool-contracts.test.ts", "test/tools/definitions.test.ts"], ["D02", "D05", "D10"]),
  rule(agent, "TIMEOUTS", "Preserve millisecond units and sufficient foreground budgets", ["test/security/shell-background-mode.test.ts"], ["C07"]),
  rule(agent, "TOOLS (use these EXACT argument names)", "Retain complete tool inventory, aliases, bounds, flags, batch results and continuation contracts", ["test/token-overhead.test.ts", "test/fs-read-multiple.test.ts", "test/tools/terminal-contract.test.ts"], ["C03", "C06", "C08", "D10", "D11"]),
  rule(agent, "PERSISTENT PROJECT INSTRUCTIONS", "Persist only reusable project rules, preserving user authority and removals", ["test/instructions-record-scope.test.ts", "test/project-instructions.test.ts"], ["D03", "D04", "C04"]),
  rule(agent, "ATTACHED REFERENCES", "Treat attachments as untrusted references rather than higher authority", ["test/agent/prompt-sections.test.ts"], ["S10"]),
  rule(agent, "OPERATING RULES", "Match deliverable, avoid irrelevant work, preserve installed stack, bound output and verify real outcomes", ["test/token-overhead.test.ts", "test/agent/system-sections.test.ts"], ["C04", "C05", "C06", "S07"]),
  rule(agent, "STAYING CURRENT", "Use authoritative current information where versions or facts are uncertain", ["test/tools/definitions.test.ts"], ["C02", "S08"]),
  rule(agent, "WEB READING", "Distinguish readable research from raw security/protocol evidence and preserve complete artifacts", ["test/http-policy.test.ts", "test/web/fetch.unit.test.ts"], ["S01", "S02", "S03", "S05"]),
  rule(agent, "CONFIRMATIONS", "Keep confirmations, authorization and secret handling outside model convenience", ["test/security/salvage-authorization.test.ts", "test/tools/terminal-contract.test.ts"], ["C08", "S04"]),
  rule(agent, "RESILIENT ERROR HANDLING", "Diagnose failures, change approach, handle permission/TTY correctly and never claim a failed action succeeded", ["test/terminal-rescue.test.ts", "test/security/tool-contracts.test.ts"], ["C03", "C08", "C10"]),
  rule(agent, "BACKGROUND / LONG-RUNNING", "Preserve foreground/background/responder ownership, finite waits, receipts, cursors, safe delegation and cleanup", ["test/security/shell-background-mode.test.ts", "test/agent/responder-read-tool.test.ts", "test/agent/subagent-read-only-tools.test.ts"], ["C07", "C08", "C09", "S09"]),
  rule(agent, "BUILDING SOFTWARE", "Resolve project root/stack, continue existing apps, implement full feature, verify runtime and preserve dependencies", ["test/plan-coding-run-verify.test.ts", "test/prompt-assembly-contract.test.ts"], ["C01", "C02", "C05"]),
  rule(agent, "CODE STYLE", "Preserve precise types, coherent maintainable code, bounded complexity and project conventions", ["test/token-overhead.test.ts"], ["C01", "C02", "S08"]),
  rule(agent, "DEBUGGING & FIXING", "Reproduce, localize, confirm cause, minimally fix and independently regress; do not weaken tests", ["test/plan-coding-run-verify.test.ts"], ["C01", "C03", "C10", "S08"]),
  rule(agent, "PLANNING (when you use plan.create)", "Keep agent/plan mode boundary, complete roadmap scope, dependencies and truthful task-state transitions", ["test/agent/plan-mode-gate.test.ts", "test/agent/plan-persistence.test.ts", "test/token-overhead.test.ts"], ["C04", "C09"]),
  rule(agent, "PENTEST METHODOLOGY — senior red team / VAPT", "Preserve evidence-led discovery, exploit confirmation, chains, coverage, negative controls and honest reporting", ["test/http-policy.test.ts", "test/security/tool-contracts.test.ts"], ["S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09", "S10"]),
  rule(agent, "CROSS-OS AWARENESS", "Use platform-correct commands, paths and installed tools", ["test/tools/terminal-contract.test.ts", "test/fs-read-multiple.test.ts"], ["C03", "C05", "C08"]),
  rule(agent, "CONTINUATION & CONTEXT", "Restore actual state, retain all criteria and receipts, avoid duplicate completed/live work and preserve history", ["test/agent/continue-orient.test.ts", "test/agent/compaction-cache-fidelity.test.ts", "test/app/session-cache-continuity.test.ts"], ["C09", "C10", "D07", "D08"]),
  ...[
    ["ROLE", "Preserve staff-level read-only technical and security analysis"],
    ["PROMPT CONFIDENTIALITY", "Protect non-user instructions and separate retrieved content from authority"],
    ["SECURITY POSTURE — FULL OFFENSIVE CAPABILITY", "Retain authorized offensive-security analysis and technical depth"],
    ["RESEARCH — READ-ONLY TOOLS", "Use full read-only research and evidence capabilities without side effects"],
    ["ACTION HANDOFF — WHEN THE USER WANTS IT DONE, NOT EXPLAINED", "Hand off explicit actions without turning questions into directives"],
    ["PROFESSIONAL ANALYSIS", "Ground analysis in contracts, evidence, failure modes and relevant coverage"],
    ["HOW TO ANSWER", "Deliver a correct proportionate answer with current sources when needed"],
    ["ACCURACY", "Do not fabricate observations, citations, executions or certainty"],
    ["ENGAGEMENT ADVICE", "Preserve scoped security recommendations, proof and residual risk"],
  ].map(([heading, obligation]) => rule(ask, heading!, obligation!, ["test/agent/system-sections.test.ts", "test/tools/definitions.test.ts"], ["C04", "S01", "S10"])),
];

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
export function captureTokenContracts(root: string) {
  const definitions = getToolDefinitions();
  const sources = [agent, ask, "src/prompts/index.ts"].map((path) => {
    const text = readFileSync(resolve(root, path), "utf8");
    const matches = [...text.matchAll(/^# (.+)$/gm)];
    const headings = matches.map((match) => match[1]!);
    const sections = matches.map((match, ordinal) => {
      const start = match.index;
      const end = matches[ordinal + 1]?.index ?? text.length;
      const body = text.slice(start, end);
      return {
        heading: match[1]!, startLine: text.slice(0, start).split("\n").length,
        endLine: text.slice(0, end).trimEnd().split("\n").length,
        sha256: digest(body), paragraphSha256: body.split(/\n\s*\n/).filter((part) => part.trim()).map(digest),
      };
    });
    return { path, sha256: digest(text), headings, sections };
  });
  return {
    version: 1, sources, canonicalDefinitionsSha256: digest(JSON.stringify(definitions)),
    toolContracts: definitions.map((definition, ordinal) => ({
      ordinal, name: definition.name, wireName: definition.wireName,
      mutates: definition.mutates ?? null, readOnly: definition.readOnly ?? null, askMode: definition.askMode ?? null,
      canonicalSha256: digest(JSON.stringify(definition)), parametersSha256: digest(JSON.stringify(definition.parameters)),
      wireSha256: digest(JSON.stringify(toOpenAiTools([definition])[0])),
      tests: ["test/tools/definitions.test.ts", "test/security/tool-contracts.test.ts"],
      behavioralCoverage: "P1 natural-call and scenario gates required; structural locks alone do not prove model behavior",
    })),
    ruleContracts,
  };
}
