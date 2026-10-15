import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, CompletionRequest } from "../../src/types.js";
import { invalidateInstructionCache, loadAgentInstructions } from "../../src/instructions/load.js";
import { compactMessages, compactMessagesWithSummary, estimateMessagesTokens, isCompactionMemoryMessage } from "../../src/agent/context-manager.js";
import { AGENT_INSTRUCTIONS_PREFIX, latestKeyedBlock, upsertAgentInstructionsMessage } from "../../src/agent/injected-blocks.js";
import { prepareCompactionCandidateMessages } from "../../src/agent/turn/compaction-candidate.js";
import { buildAnthropicBody } from "../../src/llm/anthropic.js";

const CLAI_RULE = "Keep public APIs compatible.";
const RECORDED_RULE = "Do not add comments to code.";
const SUMMARY = "## Work completed\n- Inspected the parser and confirmed the failing assertion.\n\n## Remaining work\n- Apply the verified fix and run regression checks.";
const METHODS = ["summary", "mechanical"] as const;
type Method = typeof METHODS[number];
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "clai-instruction-compaction-"));
  await mkdir(join(root, ".clai"));
  await writeFile(join(root, "package.json"), "{}\n");
  vi.stubEnv("CLAI_DATA_DIR", join(root, "global"));
  invalidateInstructionCache();
});

afterEach(async () => {
  invalidateInstructionCache();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function instructionFiles(lowercase = false): Promise<string> {
  await writeFile(join(root, ".clai", lowercase ? "clai.md" : "CLAI.md"), `# CLAI.md\n\n- ${CLAI_RULE}\n`);
  await writeFile(join(root, ".clai", lowercase ? "instructions.md" : "INSTRUCTIONS.md"), `# INSTRUCTIONS.md\n\n## Active\n\n- ${RECORDED_RULE}\n`);
  const loaded = await loadAgentInstructions({ cwd: root });
  if (!loaded.block) throw new Error("instruction fixture was not loaded");
  return loaded.block;
}

function history(block: string): ChatMessage[] {
  return [
    { role: "system", content: "Stable execution rules and tool contracts." },
    { role: "system", content: block },
    ...Array.from({ length: 8 }, (_, index) => [
      { role: "user" as const, content: `Inspect parser module ${index}.` },
      { role: "assistant" as const, content: `Verified parser evidence ${index}.` },
    ]).flat(),
  ];
}

async function compact(method: Method, messages: ChatMessage[]): Promise<ChatMessage[]> {
  if (method === "mechanical") return compactMessages(messages, { budgetTokens: 0, keepRecent: 2 });
  const result = await compactMessagesWithSummary(messages, async () => SUMMARY, {
    budgetTokens: 0, keepRecent: 2, forceDirectSinglePass: true,
  });
  expect(result.afterTokens).toBe(estimateMessagesTokens(result.messages));
  return result.messages;
}

function request(messages: ChatMessage[]): CompletionRequest {
  return {
    provider: "anthropic", model: "claude-sonnet-4-5", messages,
    tools: [{ name: "fs.read", description: "Read files", parameters: { type: "object", properties: {} } }],
    toolChoice: "auto",
  };
}

describe("project-file instruction continuity across compaction", () => {
  it.each(METHODS)("keeps both real instruction files verbatim through six %s compactions", async (method) => {
    for (const lowercase of [false, true]) {
      if (lowercase) {
        await rm(join(root, ".clai", "CLAI.md"));
        await rm(join(root, ".clai", "INSTRUCTIONS.md"));
      }
      const block = await instructionFiles(lowercase);
      let messages = history(block);
      const stableSystem = messages[0];
      for (let round = 0; round < 6; round += 1) {
        const before = structuredClone(messages);
        const compacted = await compact(method, messages);
        expect(messages).toEqual(before);
        expect(compacted[0]).toEqual(stableSystem);
        expect(compacted.filter(message => message.role === "system" && message.content === block)).toHaveLength(1);
        expect(latestKeyedBlock(compacted, AGENT_INSTRUCTIONS_PREFIX)).toBe(block);
        const memory = compacted.find(isCompactionMemoryMessage);
        expect(memory?.content).not.toContain(CLAI_RULE);
        expect(memory?.content).not.toContain(RECORDED_RULE);
        const wire = buildAnthropicBody(request(compacted), false);
        expect(wire).toContain(CLAI_RULE);
        expect(wire).toContain(RECORDED_RULE);
        const candidate = prepareCompactionCandidateMessages({
          messages: compacted, agentInstructionsBlock: block, activeSkillsBlock: undefined,
          livePlan: undefined, planApproved: false,
        });
        expect(candidate).toEqual(compacted);
        messages = [...candidate,
          { role: "user", content: `Continue parser review ${round}.` },
          { role: "assistant", content: `Parser review ${round} completed.` },
        ];
      }
    }
  });

  it.each(METHODS)("retains only the latest file revision and honors file removal after %s compaction", async (method) => {
    const block = await instructionFiles();
    const messages = history(block);
    const prefix = structuredClone(messages);
    const replacement = "Use the approved versioned API migration.";
    await writeFile(join(root, ".clai", "CLAI.md"), `# CLAI.md\n\n- ${replacement}\n`);
    const updated = await loadAgentInstructions({ cwd: root });
    upsertAgentInstructionsMessage(messages, updated.block);
    expect(messages.slice(0, prefix.length)).toEqual(prefix);
    const compacted = await compact(method, messages);
    expect(latestKeyedBlock(compacted, AGENT_INSTRUCTIONS_PREFIX)).toBe(updated.block);
    expect(compacted.filter(message => message.role === "system" && message.content.startsWith(AGENT_INSTRUCTIONS_PREFIX))).toHaveLength(1);
    expect(JSON.stringify(compacted)).not.toContain(CLAI_RULE);
    await rm(join(root, ".clai", "CLAI.md"));
    const remaining = await loadAgentInstructions({ cwd: root });
    upsertAgentInstructionsMessage(compacted, remaining.block);
    const afterRemoval = await compact(method, compacted);
    const retained = latestKeyedBlock(afterRemoval, AGENT_INSTRUCTIONS_PREFIX);
    expect(retained).toBe(remaining.block);
    expect(retained).toContain(RECORDED_RULE);
    expect(retained).not.toContain(replacement);
  });

  it.each(METHODS)("does not resurrect explicitly cleared instructions after %s compaction", async (method) => {
    const messages = history(await instructionFiles());
    const prefix = structuredClone(messages);
    upsertAgentInstructionsMessage(messages, undefined);
    expect(messages.slice(0, prefix.length)).toEqual(prefix);
    const compacted = await compact(method, messages);
    expect(latestKeyedBlock(compacted, AGENT_INSTRUCTIONS_PREFIX)).toBeUndefined();
    expect(JSON.stringify(compacted)).not.toContain(CLAI_RULE);
    expect(JSON.stringify(compacted)).not.toContain(RECORDED_RULE);
  });

  it("keeps ordinary request bytes unchanged for repeated loads and non-substantive file edits", async () => {
    const block = await instructionFiles();
    const messages = history(block);
    const before = structuredClone(messages);
    const wire = buildAnthropicBody(request(messages), false);
    for (let round = 0; round < 4; round += 1) {
      const loaded = await loadAgentInstructions({ cwd: root });
      upsertAgentInstructionsMessage(messages, loaded.block);
    }
    await writeFile(join(root, ".clai", "CLAI.md"), `# CLAI.md\r\n\r\n- ${CLAI_RULE}\r\n<!-- ignored authoring note -->\r\n`);
    const normalized = await loadAgentInstructions({ cwd: root });
    expect(normalized.block).toBe(block);
    upsertAgentInstructionsMessage(messages, normalized.block);
    expect(messages).toEqual(before);
    expect(buildAnthropicBody(request(messages), false)).toBe(wire);
  });
});
