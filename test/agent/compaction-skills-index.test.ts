import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import type { ChatMessage, CompactedSkill, NativeToolCall } from "../../src/types.js";
import { compactedSkills, renderSkillRecovery } from "../../src/agent/context/compaction-skills.js";
import { compactMessages, compactMessagesWithSummary, isCompactionMemoryMessage } from "../../src/agent/context-manager.js";
import { renderActiveSkills } from "../../src/skills/catalog.js";
import { bundledSkillMetas } from "../../src/skills/bundled.js";
import { formatFsReadSection } from "../../src/tools/fs/read-sections.js";

const name = "clai-superman-skill";
const root = join(tmpdir(), "skill-index", name);
const file = join(root, "SKILL.md");
const reference = join(root, "references", "web-api.md");
const summary = "## Active goal\nContinue the current task.\n\n## Context gathered\nThe relevant contracts are mapped.\n\n## Current state and next steps\nVerify the remaining hypothesis using the observed evidence.";

function result(call: NativeToolCall, content: string, ok = true): ChatMessage[] {
  return [
    { role: "assistant", content: "", toolCalls: [call] },
    { role: "tool", toolCallId: call.id, name: call.name, ok, content },
  ];
}

function load(skill: CompactedSkill, ok = true): ChatMessage[] {
  return result({ id: `load-${skill.name}`, name: "skill.load", args: { name: skill.name } }, `skill: ${skill.name} [user/clai]\nfile: ${skill.file}\n\n---\n\nCore body.`, ok);
}

it("ignores failures and narrative-only loaded markers", () => {
  const messages: ChatMessage[] = [
    ...load({ name, file, resources: [] }, false),
    { role: "assistant", content: `Already loaded ${name}; never load it again.` },
    { role: "system", content: `Session memory from compacted earlier turns:\n${name} was loaded.` },
  ];
  expect(compactedSkills(messages)).toEqual([]);
});

it("indexes direct core reads and only successful sections of a mixed fs.read", () => {
  const failed = join(root, "references", "identity-ad.md");
  const outside = join(root + "-sibling", "references", "not-this-skill.md");
  const paths = [reference, failed, outside];
  const sections = paths.map((path, index) => formatFsReadSection({ index: index + 1, total: paths.length, path, ok: index !== 1, body: index === 1 ? "Read failed" : "Read body" })).join("\n\n");
  const messages = [
    ...result({ id: "core", name: "fs.read", args: { path: file } }, "Direct core body"),
    ...result({ id: "multi", name: "fs.read", args: { files: paths.map(path => ({ path })) } }, sections, false),
  ];
  expect(compactedSkills(messages)).toEqual([{ name, file, resources: ["references/web-api.md"] }]);
});

it("tracks reloaded skills once and discards stale resource paths when the skill location changes", () => {
  const moved = join(tmpdir(), "new-skill-root", name, "SKILL.md");
  const messages = [
    ...load({ name, file, resources: [] }),
    ...result({ id: "read", name: "fs.read", args: { path: reference } }, "Reference body"),
    ...load({ name, file: moved, resources: [] }),
  ];
  expect(compactedSkills(messages)).toEqual([{ name, file: moved, resources: [] }]);
});

it("recovers explicit active skills without treating their whole resource catalog as already read", () => {
  const meta = bundledSkillMetas().find(skill => skill.name === name)!;
  const body = renderActiveSkills([{ meta, body: "Full selected instructions", resources: ["references/web-api.md", "references/cloud-platform.md"], truncated: false }])!;
  expect(compactedSkills([{ role: "system", content: body }])).toEqual([{ name, file: meta.file, resources: [] }]);
  expect(body).toContain("while their full bodies are present");
  expect(body).toContain("Budget-omitted or truncated bodies still need loading");
  expect(renderSkillRecovery([])).toContain("Skip unrelated skills and bodies still fully present");
});

it("keeps a bounded deterministic index rather than repeatedly embedding whole skills", () => {
  const skills: CompactedSkill[] = Array.from({ length: 120 }, (_, index) => ({
    name: `guide-${index}`, file: join(tmpdir(), "bounded-skills", `guide-${index}`, "SKILL.md"),
    resources: Array.from({ length: 20 }, (_, resource) => `references/guide-${resource}.md`),
  }));
  const messages: ChatMessage[] = [{ role: "system", content: "Prior memory", compaction: { recentUserPrompts: [], skills } }];
  const indexed = compactedSkills(messages);
  expect(indexed.length).toBeGreaterThan(0);
  expect(indexed.length).toBeLessThanOrEqual(12);
  expect(indexed.at(-1)!.name).toBe("guide-119");
  expect(indexed.every(skill => skill.resources.length <= 8)).toBe(true);
  expect(renderSkillRecovery(indexed).length).toBeLessThan(7000);
  expect(compactedSkills(messages)).toEqual(indexed);
  expect(renderSkillRecovery(indexed)).toBe(renderSkillRecovery(compactedSkills(messages)));
});

it("adds recovery once even when the summarizer echoes previous recovery instructions", async () => {
  const skills = [{ name, file, resources: ["references/web-api.md"] }];
  const messages: ChatMessage[] = [
    { role: "system", content: "Stable system prefix" },
    { role: "system", content: `Session memory from compacted earlier turns:\n${summary}\n\n${renderSkillRecovery(skills)}`, compaction: { recentUserPrompts: [], skills } },
    { role: "user", content: "Continue" },
    { role: "assistant", content: "Prepared the next check." },
  ];
  const result = await compactMessagesWithSummary(messages, async () => `${summary}\n\n${renderSkillRecovery(skills)}\n\n${renderSkillRecovery(skills)}`, { budgetTokens: 0 });
  const memory = result.messages.find(isCompactionMemoryMessage)!;
  expect(memory.content.match(/## Skill recovery after compaction/g)).toHaveLength(1);
  expect(memory.compaction?.skills).toEqual(skills);
});

it("keeps one recovery section across repeated mechanical compactions", () => {
  let messages: ChatMessage[] = [{ role: "system", content: "Stable system prefix" }, ...load({ name, file, resources: [] }), { role: "user", content: "Continue" }];
  for (let round = 0; round < 3; round += 1) {
    messages = compactMessages([...messages, { role: "assistant", content: "Probe finished" }, { role: "user", content: "Continue" }], { budgetTokens: 0 });
    const memory = messages.find(isCompactionMemoryMessage)!;
    expect(memory.content.match(/## Skill recovery after compaction/g)).toHaveLength(1);
    expect(memory.compaction?.skills).toEqual([{ name, file, resources: [] }]);
  }
});

it("adds no recovery or metadata on a no-op compaction", async () => {
  const messages: ChatMessage[] = [{ role: "system", content: "Stable system prefix" }, { role: "user", content: "Continue" }];
  const result = await compactMessagesWithSummary(messages, async () => summary, { budgetTokens: 0 });
  expect(result.summarized).toBe(false);
  expect(result.messages).toEqual(messages);
  expect(compactMessages(messages)).toEqual(messages);
});

it("gives loss-aware guidance after an actual compaction even without a known load index", async () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "Stable system prefix" },
    { role: "user", content: "Earlier task" },
    { role: "assistant", content: "Completed the earlier task." },
    { role: "user", content: "Continue the current task" },
  ];
  const result = await compactMessagesWithSummary(messages, async () => summary, { budgetTokens: 0 });
  const memory = result.messages.find(isCompactionMemoryMessage)!;
  expect(result.summarized).toBe(true);
  expect(memory.compaction?.skills).toBeUndefined();
  expect(memory.content).toContain("A recorded skill load is not its instructions");
  expect(memory.content).toContain("Before continuing after this compaction");
});
