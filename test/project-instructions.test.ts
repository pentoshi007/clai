import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  instructionCandidates,
  scaffoldTargetDir,
} from "../src/instructions/locations.js";
import {
  AGENT_INSTRUCTIONS_PREFIX,
  invalidateInstructionCache,
  loadAgentInstructions,
} from "../src/instructions/load.js";
import { ensureProjectInstructionFiles } from "../src/instructions/scaffold.js";
import {
  normalizeInstructionEntry,
  parseRecordedInstructions,
  recordInstructions,
} from "../src/instructions/record.js";
import { instructionsRecordTool } from "../src/tools/instructions.js";
import {
  ACTIVE_SKILLS_PREFIX,
  upsertActiveSkillsMessage,
  upsertAgentInstructionsMessage,
} from "../src/agent/injected-blocks.js";
import { classifyToolCall } from "../src/safety/classifier.js";
import type { ChatMessage } from "../src/types.js";

let root: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  previousDataDir = process.env.CLAI_DATA_DIR;
  root = mkdtempSync(join(tmpdir(), "clai-instructions-"));
  process.env.CLAI_DATA_DIR = join(root, "global-clai");
  mkdirSync(process.env.CLAI_DATA_DIR, { recursive: true });
  invalidateInstructionCache();
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.CLAI_DATA_DIR;
  else process.env.CLAI_DATA_DIR = previousDataDir;
  invalidateInstructionCache();
  await rm(root, { recursive: true, force: true });
});

function project(name = "app"): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}", "utf8");
  return dir;
}

describe("scaffolding .clai", () => {
  it("creates CLAI.md and INSTRUCTIONS.md in a project root", async () => {
    const dir = project();
    const result = await ensureProjectInstructionFiles({ cwd: dir });
    expect(result).toBeDefined();
    expect(existsSync(join(dir, ".clai", "CLAI.md"))).toBe(true);
    expect(existsSync(join(dir, ".clai", "INSTRUCTIONS.md"))).toBe(true);
    expect(result!.created).toHaveLength(2);
  });

  it("never overwrites an existing CLAI.md", async () => {
    const dir = project();
    mkdirSync(join(dir, ".clai"), { recursive: true });
    writeFileSync(join(dir, ".clai", "CLAI.md"), "mine", "utf8");
    const result = await ensureProjectInstructionFiles({ cwd: dir });
    expect(readFileSync(join(dir, ".clai", "CLAI.md"), "utf8")).toBe("mine");
    expect(result!.created).toEqual([join(dir, ".clai", "INSTRUCTIONS.md")]);
  });

  it("is idempotent on a second pass", async () => {
    const dir = project();
    await ensureProjectInstructionFiles({ cwd: dir });
    const again = await ensureProjectInstructionFiles({ cwd: dir });
    expect(again!.created).toEqual([]);
  });

  it("refuses the home directory and the global clai data dir", () => {
    expect(scaffoldTargetDir({ cwd: homedir() })).toBeUndefined();
    expect(scaffoldTargetDir({ cwd: process.env.CLAI_DATA_DIR! })).toBeUndefined();
  });

  it("prefers the sticky project root over the process cwd", () => {
    const dir = project("real-project");
    expect(scaffoldTargetDir({ cwd: root, projectRoot: dir })).toBe(dir);
  });
});

describe("loading instructions", () => {
  it("ignores a freshly scaffolded template with no real content", async () => {
    const dir = project();
    await ensureProjectInstructionFiles({ cwd: dir });
    const loaded = await loadAgentInstructions({ cwd: dir });
    expect(loaded.block).toBeUndefined();
  });

  it("picks up CLAI.md once the user writes a rule", async () => {
    const dir = project();
    mkdirSync(join(dir, ".clai"), { recursive: true });
    writeFileSync(
      join(dir, ".clai", "CLAI.md"),
      "# CLAI.md\n\n- Never add comments to code.\n",
      "utf8",
    );
    const loaded = await loadAgentInstructions({ cwd: dir });
    expect(loaded.block).toContain(AGENT_INSTRUCTIONS_PREFIX);
    expect(loaded.block).toContain("Never add comments to code.");
  });

  it("reads AGENTS.md so cross-tool instruction files work", async () => {
    const dir = project();
    writeFileSync(join(dir, "AGENTS.md"), "Run pnpm, never npm.\n", "utf8");
    const loaded = await loadAgentInstructions({ cwd: dir });
    expect(loaded.block).toContain("Run pnpm, never npm.");
  });

  it("orders global before project, and recorded instructions last", async () => {
    writeFileSync(
      join(process.env.CLAI_DATA_DIR!, "CLAI.md"),
      "Global rule.\n",
      "utf8",
    );
    const dir = project();
    writeFileSync(join(dir, "AGENTS.md"), "Project rule.\n", "utf8");
    mkdirSync(join(dir, ".clai"), { recursive: true });
    writeFileSync(
      join(dir, ".clai", "INSTRUCTIONS.md"),
      "# INSTRUCTIONS.md\n\n## Active\n\n- Recorded rule.\n",
      "utf8",
    );
    const loaded = await loadAgentInstructions({ cwd: dir });
    const order = loaded.files.map((file) => file.scope);
    expect(order[0]).toBe("user");
    expect(order[order.length - 1]).toBe("recorded");
    const block = loaded.block!;
    expect(block.indexOf("Global rule.")).toBeLessThan(
      block.indexOf("Project rule."),
    );
    expect(block.indexOf("Project rule.")).toBeLessThan(
      block.indexOf("Recorded rule."),
    );
  });

  it("does not spend tokens on the template's own guidance comment", async () => {
    const dir = project();
    await ensureProjectInstructionFiles({ cwd: dir });
    writeFileSync(
      join(dir, ".clai", "CLAI.md"),
      `${readFileSync(join(dir, ".clai", "CLAI.md"), "utf8")}\n- Use pnpm, never npm.\n`,
      "utf8",
    );
    const loaded = await loadAgentInstructions({ cwd: dir });
    expect(loaded.block).toContain("Use pnpm, never npm.");
    expect(loaded.block).not.toContain("<!--");
    expect(loaded.block).not.toContain("Text inside the");
    expect(loaded.chars).toBeLessThan(200);
  });

  it("discovers each instruction file once on a case-insensitive filesystem", async () => {
    const dir = project();
    mkdirSync(join(dir, ".clai"), { recursive: true });
    writeFileSync(join(dir, ".clai", "CLAI.md"), "Only rule.\n", "utf8");
    const loaded = await loadAgentInstructions({ cwd: dir });
    expect(loaded.files).toHaveLength(1);
    expect(loaded.block!.match(/Only rule\./g)).toHaveLength(1);
  });

  it("states that instruction files cannot waive confirmations", async () => {
    const dir = project();
    writeFileSync(join(dir, "AGENTS.md"), "Some rule.\n", "utf8");
    const loaded = await loadAgentInstructions({ cwd: dir });
    expect(loaded.block).toMatch(/cannot waive/i);
  });

  it("truncates an oversized instruction file instead of blowing up context", async () => {
    const dir = project();
    writeFileSync(join(dir, "AGENTS.md"), "x".repeat(40_000), "utf8");
    const loaded = await loadAgentInstructions({ cwd: dir });
    expect(loaded.files[0]!.truncated).toBe(true);
    expect(loaded.chars).toBeLessThanOrEqual(24 * 1024);
  });

  it("never discovers instruction files by walking into the home directory", () => {
    const candidates = instructionCandidates({ cwd: homedir() });
    expect(candidates.every((entry) => entry.scope === "user")).toBe(true);
  });
});

describe("recording instructions", () => {
  it("appends rules, de-duplicates, and keeps them readable", async () => {
    const dir = project();
    const first = await recordInstructions({
      cwd: dir,
      add: ["Never add comments to code.", "Do not push to GitHub."],
    });
    expect(first!.active).toEqual([
      "Never add comments to code.",
      "Do not push to GitHub.",
    ]);
    const second = await recordInstructions({
      cwd: dir,
      add: ["never add comments to code."],
    });
    expect(second!.added).toEqual([]);
    expect(second!.active).toHaveLength(2);
    const body = readFileSync(join(dir, ".clai", "INSTRUCTIONS.md"), "utf8");
    expect(body).toContain("## Active");
    expect(body).toContain("- Never add comments to code.");
  });

  it("removes a rule by text or by number", async () => {
    const dir = project();
    await recordInstructions({ cwd: dir, add: ["Rule one.", "Rule two."] });
    const byText = await recordInstructions({ cwd: dir, remove: ["Rule one"] });
    expect(byText!.removed).toEqual(["Rule one."]);
    const byIndex = await recordInstructions({ cwd: dir, remove: ["1"] });
    expect(byIndex!.removed).toEqual(["Rule two."]);
    expect(byIndex!.active).toEqual([]);
  });

  it("survives a round trip through the file", async () => {
    const dir = project();
    await recordInstructions({ cwd: dir, add: ["Commit after each change."] });
    const parsed = parseRecordedInstructions(
      readFileSync(join(dir, ".clai", "INSTRUCTIONS.md"), "utf8"),
    );
    expect(parsed.active).toEqual(["Commit after each change."]);
  });

  it("caps the list so the file cannot grow without bound", async () => {
    const dir = project();
    const many = Array.from({ length: 12 }, (_, i) => `Rule ${i}.`);
    for (let round = 0; round < 4; round += 1) {
      await recordInstructions({
        cwd: dir,
        add: many.map((rule) => `${rule} round ${round}`),
      });
    }
    const parsed = parseRecordedInstructions(
      readFileSync(join(dir, ".clai", "INSTRUCTIONS.md"), "utf8"),
    );
    expect(parsed.active.length).toBeLessThanOrEqual(40);
  });

  it("normalizes bullet prefixes and multi-line input", () => {
    expect(normalizeInstructionEntry("- never  push\nto main")).toBe(
      "never push to main",
    );
    expect(normalizeInstructionEntry("  ")).toBeUndefined();
  });

  it("records through the tool and echoes the active list back", async () => {
    const dir = project();
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      const result = await instructionsRecordTool({ add: ["No comments."] });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("No comments.");
      expect(result.output).toContain("re-injected after compaction");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("rejects an empty call", async () => {
    const result = await instructionsRecordTool({});
    expect(result.ok).toBe(false);
  });

  it("is classified safe so it never prompts for confirmation", () => {
    expect(
      classifyToolCall({ name: "instructions.record", args: { add: ["x"] } }).level,
    ).toBe("safe");
  });
});

describe("injected block placement (prompt cache safety)", () => {
  const constitution = "CONSTITUTION BYTES";

  function baseMessages(): ChatMessage[] {
    return [
      { role: "system", content: constitution },
      { role: "user", content: "first turn" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second turn" },
      { role: "system", content: "REQUEST CONTEXT\nenv" },
    ];
  }

  it("appends at the tail and never touches the cached system head", () => {
    const messages = baseMessages();
    upsertAgentInstructionsMessage(messages, `${AGENT_INSTRUCTIONS_PREFIX}\nrule`);
    expect(messages[0]!.content).toBe(constitution);
    expect(messages[messages.length - 1]!.content).toContain("rule");
  });

  it("appends the new copy instead of rewriting the sent one", () => {
    const messages = baseMessages();
    upsertAgentInstructionsMessage(messages, `${AGENT_INSTRUCTIONS_PREFIX}\nv1`);
    const lengthAfterFirst = messages.length;
    upsertAgentInstructionsMessage(messages, `${AGENT_INSTRUCTIONS_PREFIX}\nv2`);
    expect(messages.length).toBe(lengthAfterFirst + 1);
    const copies = messages.filter((message) =>
      message.content.startsWith(AGENT_INSTRUCTIONS_PREFIX),
    );
    expect(copies).toHaveLength(2);
    expect(copies[0]!.content).toContain("v1");
    expect(copies[1]!.content).toContain("v2");
  });

  it("leaves the block untouched when the content is unchanged", () => {
    const messages = baseMessages();
    upsertAgentInstructionsMessage(messages, `${AGENT_INSTRUCTIONS_PREFIX}\nrule`);
    const lengthAfterFirst = messages.length;
    upsertAgentInstructionsMessage(messages, `${AGENT_INSTRUCTIONS_PREFIX}\nrule`);
    expect(messages.length).toBe(lengthAfterFirst);
  });

  it("removes the block when the instruction files disappear", () => {
    const messages = baseMessages();
    upsertAgentInstructionsMessage(messages, `${AGENT_INSTRUCTIONS_PREFIX}\nrule`);
    upsertAgentInstructionsMessage(messages, undefined);
    expect(
      messages.some((message) =>
        message.content.startsWith(AGENT_INSTRUCTIONS_PREFIX),
      ),
    ).toBe(false);
  });

  it("keeps instructions and active skills as separate keyed blocks", () => {
    const messages = baseMessages();
    upsertAgentInstructionsMessage(messages, `${AGENT_INSTRUCTIONS_PREFIX}\nrule`);
    upsertActiveSkillsMessage(messages, `${ACTIVE_SKILLS_PREFIX}\nbody`);
    upsertAgentInstructionsMessage(messages, `${AGENT_INSTRUCTIONS_PREFIX}\nrule2`);
    expect(
      messages.filter((m) => m.content.startsWith(ACTIVE_SKILLS_PREFIX)),
    ).toHaveLength(1);
    expect(messages[0]!.content).toBe(constitution);
  });
});
