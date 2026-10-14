import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getActiveProjectRoot, setActiveProjectRoot } from "../src/agent/project-root.js";
import { USER_INSTRUCTION_COMPACTION_GUIDANCE } from "../src/agent/context/compaction-user-instructions.js";
import { invalidateInstructionCache, loadAgentInstructions } from "../src/instructions/load.js";
import { RECORDED_INSTRUCTIONS_TEMPLATE } from "../src/instructions/record.js";
import { TOOL_DEFINITIONS } from "../src/tools/definitions/aggregate.js";
import { instructionsRecordTool } from "../src/tools/instructions.js";

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  previousRoot = getActiveProjectRoot();
  root = mkdtempSync(join(tmpdir(), "clai-instruction-scope-"));
  writeFileSync(join(root, "package.json"), "{}", "utf8");
  setActiveProjectRoot(root);
  invalidateInstructionCache();
});

afterEach(async () => {
  setActiveProjectRoot(previousRoot);
  invalidateInstructionCache();
  await rm(root, { recursive: true, force: true });
});

function seed(): string {
  const path = join(root, ".clai", "INSTRUCTIONS.md");
  mkdirSync(join(root, ".clai"), { recursive: true });
  writeFileSync(path, "# INSTRUCTIONS.md\n\n## Active\n\n- Do not add comments to code.\n", "utf8");
  return path;
}

function unchanged(path: string, original: string, inode: number): void {
  expect(readFileSync(path, "utf8")).toBe(original);
  expect(statSync(path).ino).toBe(inode);
}

describe("project-wide instruction recording", () => {
  it.each([
    "Do not add comments to code.",
    "Write clean senior-level code throughout the project.",
    "Keep cyclomatic complexity below 10 for new functions.",
    "Follow the agreed cybersecurity approach across engagements.",
    "Preserve the prompt cache prefix across the project.",
    "Do not push to GitHub without approval.",
  ])("records an explicitly project-wide principle: %s", async (rule) => {
    const result = await instructionsRecordTool({ add: [rule], scope: "project" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain(rule);
    expect(readFileSync(join(root, ".clai", "INSTRUCTIONS.md"), "utf8")).toContain(`- ${rule}`);
    expect((await loadAgentInstructions({ cwd: root })).block).toContain(rule);
  });

  it.each([
    { add: ["Do not truncate fs.read inputs in the classic UI."] },
    { add: ["Cap this diff card at 20 rows."], scope: "task" },
    { add: ["Place this task icon one cell after the title."], scope: "turn" },
    { add: ["Use no comments for this session."], scope: "session" },
    { add: ["Fix this bug."], scope: "global" },
    { add: ["Fix this bug."], scope: true },
  ])("rejects task/turn/session or unclassified additions without creating files: %j", async (args) => {
    const result = await instructionsRecordTool(args);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/project-wide/i);
    expect(existsSync(join(root, ".clai"))).toBe(false);
  });

  it("leaves existing rules and requested removals untouched when addition scope is invalid", async () => {
    const path = seed();
    const original = readFileSync(path, "utf8");
    const inode = statSync(path).ino;
    const result = await instructionsRecordTool({
      add: ["Do not truncate fs.read inputs in the classic UI."],
      remove: ["Do not add comments to code."], scope: "task",
    });
    expect(result.ok).toBe(false);
    unchanged(path, original, inode);
  });

  it.each([{}, { add: [] }, { remove: [] }, { add: ["", " \n "] }, { add: [], scope: "task" }])(
    "skips empty recording requests without creating instruction files: %j", async (args) => {
      const result = await instructionsRecordTool(args);
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toMatch(/skipped/i);
      expect(existsSync(join(root, ".clai"))).toBe(false);
    },
  );

  it("does not rewrite an existing file when there is no eligible rule", async () => {
    const path = seed();
    const original = readFileSync(path, "utf8");
    const inode = statSync(path).ino;
    const result = await instructionsRecordTool({ add: [], remove: [] });
    expect(result.ok).toBe(true);
    unchanged(path, original, inode);
  });

  it("still removes outdated task-specific entries without requiring addition scope", async () => {
    const path = seed();
    writeFileSync(path, `${readFileSync(path, "utf8")}\n- Do not truncate fs.read inputs in the classic UI.\n`, "utf8");
    const result = await instructionsRecordTool({ remove: ["Do not truncate fs.read inputs in the classic UI."] });
    expect(result.ok).toBe(true);
    const body = readFileSync(path, "utf8");
    expect(body).toContain("Do not add comments to code.");
    expect(body).not.toContain("fs.read");
  });

  it("preserves removal, deduplication, and mixed project-wide updates", async () => {
    seed();
    const result = await instructionsRecordTool({
      scope: "project", remove: ["1"],
      add: ["Preserve the prompt cache prefix across the project.", "Preserve the prompt cache prefix across the project."],
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("active rules now (1)");
    expect(readFileSync(join(root, ".clai", "INSTRUCTIONS.md"), "utf8")).not.toContain("Do not add comments");
  });
});

describe("instruction scope contracts", () => {
  it("limits the recording tool to project-wide principles and explicitly allows skipping", () => {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === "instructions.record")!;
    expect(definition.description).toMatch(/project-wide/i);
    expect(definition.description).toMatch(/one-off/i);
    expect(definition.description).toMatch(/skip/i);
    expect(definition.parameters.properties.scope).toMatchObject({ type: "string", enum: ["project"] });
    expect(definition.parameters.required ?? []).not.toContain("scope");
  });

  it("keeps task instructions in scoped memory rather than project files", () => {
    expect(USER_INSTRUCTION_COMPACTION_GUIDANCE).toMatch(/not persist.*task/i);
    expect(RECORDED_INSTRUCTIONS_TEMPLATE).toMatch(/project-wide/i);
    const prompt = readFileSync(new URL("../src/prompts/system.agent.md", import.meta.url), "utf8");
    expect(prompt.includes("# PERSISTENT PROJECT INSTRUCTIONS")).toBe(true);
    expect(prompt.includes("skip instructions.record")).toBe(true);
    expect(prompt.includes("Do not infer project-wide scope from imperative wording")).toBe(true);
  });
});
