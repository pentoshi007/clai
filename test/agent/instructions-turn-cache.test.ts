import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "../../src/types.js";
import { invalidateInstructionCache } from "../../src/instructions/load.js";
import { isAgentInstructionsMessage } from "../../src/agent/injected-blocks.js";
import { compactMessages } from "../../src/agent/context-manager.js";
import { buildTurnHistory } from "../../src/agent/tool-call-parser.js";
import { composeTurnMessages } from "../../src/agent/turn/setup/turn-messages.js";
import {
  loadTurnInstructions,
  orientTurnWorkspace,
} from "../../src/agent/turn/workspace-setup.js";
import { clearActiveProjectRoot } from "../../src/agent/project-root.js";

const STABLE_SYSTEM = "Stable execution rules and tool contracts.";
const RULE = "Use pnpm, never npm.";

describe("project instructions across turns", () => {
  let root: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clai-instructions-turns-"));
    mkdirSync(join(root, ".clai"));
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, ".clai", "CLAI.md"), `# CLAI.md\n\n- ${RULE}\n`);
    previousDataDir = process.env.CLAI_DATA_DIR;
    process.env.CLAI_DATA_DIR = join(root, "global");
    invalidateInstructionCache();
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.CLAI_DATA_DIR;
    else process.env.CLAI_DATA_DIR = previousDataDir;
    invalidateInstructionCache();
    clearActiveProjectRoot();
    rmSync(root, { recursive: true, force: true });
  });

  const turn = async (
    prompt: string,
    history: ChatMessage[] | undefined,
  ): Promise<ChatMessage[]> => {
    const orientation = orientTurnWorkspace({ prompt, plan: undefined, cwd: root });
    const instructions = await loadTurnInstructions({
      prompt,
      scanInput: orientation.instructionScanInput,
      scaffoldInstructionFiles: false,
      skillNames: new Set<string>(),
      notify: () => undefined,
    });
    return composeTurnMessages({
      prompt,
      displayPrompt: prompt,
      images: undefined,
      history,
      mode: "agent",
      systemSections: [],
      selectedSkillNames: [],
      nativeToolsActive: true,
      inputTokenBudget: undefined,
      stableSystemContent: () => STABLE_SYSTEM,
      instructionsBlock: instructions.block,
      skillsBlock: undefined,
      plan: undefined,
      planApproved: false,
    }).messages;
  };

  const instructionMessages = (messages: readonly ChatMessage[]): ChatMessage[] =>
    messages.filter(
      (message) => message.role === "system" && isAgentInstructionsMessage(message.content),
    );

  it("delivers the rules once and keeps every earlier request byte as a prefix", async () => {
    const first = await turn("create a watch website", undefined);
    expect(first[0]).toEqual({ role: "system", content: STABLE_SYSTEM });
    expect(instructionMessages(first)).toHaveLength(1);
    expect(instructionMessages(first)[0]!.content).toContain(RULE);

    const second = await turn("fix the header", buildTurnHistory(first, "Built it."));
    expect(JSON.stringify(second.slice(0, first.length))).toBe(JSON.stringify(first));
    expect(instructionMessages(second)).toHaveLength(1);
  });

  it("keeps the rules known after compaction without touching the stable prefix", async () => {
    let history: ChatMessage[] | undefined;
    let sent: ChatMessage[] = [];
    for (let index = 0; index < 6; index += 1) {
      sent = await turn(`fix parser module ${index}`, history);
      history = buildTurnHistory(sent, `Verified parser module ${index}.`);
    }
    const compacted = compactMessages(sent, { budgetTokens: 0, keepRecent: 2 });
    expect(compacted[0]).toEqual(sent[0]);
    expect(instructionMessages(compacted)).toHaveLength(1);
    expect(instructionMessages(compacted)[0]!.content).toContain(RULE);

    const next = await turn("continue", buildTurnHistory(compacted, "Resumed."));
    expect(JSON.stringify(next.slice(0, compacted.length))).toBe(JSON.stringify(compacted));
    expect(instructionMessages(next)).toHaveLength(1);
  });
});
