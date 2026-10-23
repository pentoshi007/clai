import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledSkillMetas, bundledSkillRoot } from "../src/skills/bundled.js";
import { BUNDLED_SKILLS } from "../src/skills/bundled-catalog.generated.js";
import { renderActiveSkills, renderSkillCatalog, rankSkills } from "../src/skills/catalog.js";
import { dedupeSkills } from "../src/skills/discover.js";
import { skillScopeLabel } from "../src/skills/format.js";
import { getSkillIndex, invalidateSkillIndex, loadSkill } from "../src/skills/registry.js";
import { skillListTool, skillLoadTool } from "../src/tools/skills.js";
import { fsRead } from "../src/tools/fs/read.js";
import { loadTurnInstructions } from "../src/agent/turn/workspace-setup.js";
import type { SkillMeta } from "../src/skills/types.js";

const name = "clai-superman-skill";
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "clai-bundled-skills-"));
  vi.stubEnv("CLAI_DATA_DIR", join(root, "data"));
  vi.stubEnv("CLAI_SKILLS_PATH", "");
  invalidateSkillIndex();
});

afterEach(async () => {
  invalidateSkillIndex();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function bundled(): SkillMeta {
  return bundledSkillMetas().find((skill) => skill.name === name)!;
}

async function writeOverride(path: string, body = "Controlled local instructions."): Promise<void> {
  const dir = join(path, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Local security assessment guidance.\n---\n\n${body}\n`);
}

describe("bundled skill discovery and progressive loading", () => {
  it("discovers a fallback without materializing files or exposing instruction bodies", async () => {
    const index = await getSkillIndex({ cwd: root });
    const meta = index.skills.find((skill) => skill.name === name)!;
    expect(meta.scope).toBe("bundled");
    expect(skillScopeLabel(meta)).toBe("bundled/clai");
    expect(index.names.has(name)).toBe(true);
    expect(index.roots).toContainEqual(bundledSkillRoot());
    expect(existsSync(meta.dir)).toBe(false);
    expect(existsSync(meta.root)).toBe(false);
    const catalog = renderSkillCatalog({ skills: index.skills, prompt: "Perform a security assessment" })!;
    expect(catalog).toContain(`${name} [bundled]`);
    expect(catalog).toContain("skill.load");
    expect(catalog).not.toContain("The investigation loop");
    expect(catalog).not.toContain("references/novel-research.md");
    expect(renderSkillCatalog({ skills: index.skills, prompt: "Perform a security assessment" })).toBe(catalog);
  });

  it("keeps explicit named routing even when the description is omitted by the catalog budget", () => {
    const other: SkillMeta[] = Array.from({ length: 20 }, (_, index) => ({
      ...bundled(), name: `worksheet-${index}`, description: "Format spreadsheet cells and build financial charts.", scope: "user",
    }));
    const prompt = "Format spreadsheet cells and build financial charts";
    const catalog = renderSkillCatalog({ skills: [...other, bundled()], prompt, maxTokens: 40 })!;
    expect(catalog).not.toContain(bundled().description);
    expect(catalog).toContain("load clai-superman-skill before investigating unless already loaded");
    expect(catalog).toContain("ANY domain");
    expect(catalog).not.toContain("The investigation loop");
    expect(renderSkillCatalog({ skills: other, prompt })).not.toContain("clai-superman-skill");
    expect(existsSync(bundled().root)).toBe(false);
  });

  it("loads the full core and readable references through the real tools", async () => {
    const result = await skillLoadTool({ name });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("[bundled/clai]");
    expect(result.output).toContain("references/novel-research.md");
    const loaded = (await loadSkill(name, { cwd: root }))!;
    expect(loaded.truncated).toBe(false);
    expect(loaded.body).toContain("The investigation loop");
    expect(loaded.body).not.toContain("description:");
    expect(loaded.resources).toEqual(BUNDLED_SKILLS[0]!.resources);
    for (const resource of loaded.resources) {
      const read = await fsRead(join(loaded.meta.dir, resource));
      expect(read.ok, resource).toBe(true);
      expect(read.output!.length).toBeGreaterThan(100);
    }
    const active = renderActiveSkills([loaded])!;
    expect(active).toContain(loaded.body);
    expect(active).not.toContain("A useful harness:");
    expect((await skillListTool({ query: "pentesting" })).output).toContain(name);
  });

  it("only inlines an explicitly mentioned skill during turn setup", async () => {
    const index = await getSkillIndex({ cwd: root });
    const input = {
      scanInput: { cwd: root },
      scaffoldInstructionFiles: false,
      skillNames: index.names,
      notify: vi.fn(),
    };
    const normal = await loadTurnInstructions({ ...input, prompt: "Assess this API's tenant authorization" });
    expect(normal.selectedSkillNames).toEqual([]);
    expect(normal.skillsBlock).toBeUndefined();
    expect(existsSync(bundled().dir)).toBe(false);
    const explicit = await loadTurnInstructions({ ...input, prompt: `skill:${name} assess this API` });
    expect(explicit.selectedSkillNames).toEqual([name]);
    expect(explicit.skillsBlock).toContain("The investigation loop");
    expect(explicit.skillsBlock).not.toContain("A useful harness:");
    expect(existsSync(bundled().file)).toBe(true);
  });

  it.each([
    "Perform an API pentesting assessment of tenant authorization",
    "Research novel vulnerabilities in a native protocol parser",
    "Assess Active Directory identity security and red teaming",
    "Investigate Android mobile application security",
    "Assess wireless IoT firmware security",
    "Audit cloud systems and AI LLM agents for security issues",
    "Investigate incident detection and security operations",
  ])("ranks the bundle above unrelated skills for %s", (prompt) => {
    const unrelated: SkillMeta[] = Array.from({ length: 12 }, (_, index) => ({
      ...bundled(), name: `worksheet-${index}`, description: "Format spreadsheet cells and build financial charts.", scope: "user",
    }));
    const ranked = rankSkills(prompt, [...unrelated, bundled()]);
    expect(ranked[0]!.name).toBe(name);
    expect(renderSkillCatalog({ skills: ranked, prompt, maxTokens: 260 })).toContain(`${name} [bundled]`);
  });

  it("retains ordinary skill relevance for unrelated tasks without loading security instructions", async () => {
    const ui: SkillMeta = { ...bundled(), name: "ui-copy", description: "Change button labels and other UI copy.", scope: "user" };
    const ranked = rankSkills("Change this button label from Continue to Save", [bundled(), ui]);
    expect(ranked[0]!.name).toBe("ui-copy");
    expect(existsSync(bundled().dir)).toBe(false);
  });
});

describe("bundle override and index contracts", () => {
  it.each(["extra", "project", "user"] as const)("always prefers a %s override regardless of enumeration order", (scope) => {
    const override: SkillMeta = { ...bundled(), scope, file: join(root, scope, "SKILL.md") };
    for (const entries of [[bundled(), override], [override, bundled()]]) {
      const [winner] = dedupeSkills(entries);
      expect(winner!.scope).toBe(scope);
      expect(winner!.shadowed).toContain(bundled().file);
    }
  });

  it.each(["extra", "project", "user"] as const)("loads the actual %s override rather than the embedded body", async (scope) => {
    const path = scope === "extra" ? join(root, "custom") : scope === "project" ? join(root, ".clai", "skills") : join(root, "data", "skills");
    await writeOverride(path);
    if (scope === "extra") vi.stubEnv("CLAI_SKILLS_PATH", path);
    const loaded = (await loadSkill(name, { cwd: root }))!;
    expect(loaded.meta.scope).toBe(scope);
    expect(loaded.body).toBe("Controlled local instructions.");
    expect(existsSync(bundled().dir)).toBe(false);
  });

  it("preserves the fallback after local discovery reaches its total cap", async () => {
    const paths: string[] = [];
    for (let group = 0; group < 3; group += 1) {
      const path = join(root, `group-${group}`);
      paths.push(path);
      await mkdir(path);
      for (let index = 0; index < 120; index += 1) {
        const dir = join(path, `sample-${group}-${index}`);
        await mkdir(dir);
        await writeFile(join(dir, "SKILL.md"), `---\nname: sample-${group}-${index}\ndescription: A small test skill.\n---\nbody`);
      }
    }
    const { delimiter } = await import("node:path");
    vi.stubEnv("CLAI_SKILLS_PATH", paths.join(delimiter));
    const index = await getSkillIndex({ cwd: root });
    expect(index.truncated).toBe(true);
    expect(index.skills).toHaveLength(301);
    expect(index.names.has(name)).toBe(true);
  });

  it("changes cache identity when configured roots or data directory change", async () => {
    const initial = await getSkillIndex({ cwd: root });
    const extra = join(root, "extra");
    await writeOverride(extra);
    vi.stubEnv("CLAI_SKILLS_PATH", extra);
    const overridden = await getSkillIndex({ cwd: root });
    expect(overridden).not.toBe(initial);
    expect(overridden.skills.find((skill) => skill.name === name)!.scope).toBe("extra");
    vi.stubEnv("CLAI_SKILLS_PATH", "");
    vi.stubEnv("CLAI_DATA_DIR", join(root, "different-data"));
    const relocated = await getSkillIndex({ cwd: root });
    expect(relocated.skills.find((skill) => skill.name === name)!.dir).toContain("different-data");
  });
});

describe("bundle materialization integrity and lifecycle", () => {
  it("atomically shares concurrent loads and reuses identical cached files", async () => {
    const loaded = await Promise.all(Array.from({ length: 6 }, () => loadSkill(name, { cwd: root })));
    expect(new Set(loaded.map((skill) => skill!.meta.dir)).size).toBe(1);
    const meta = loaded[0]!.meta;
    const before = await stat(meta.file);
    await loadSkill(name, { cwd: root });
    expect((await stat(meta.file)).mtimeMs).toBe(before.mtimeMs);
    expect(await readdir(join(meta.root, name))).toEqual([BUNDLED_SKILLS[0]!.digest]);
  });

  it("does not silently accept a modified core or reference", async () => {
    const loaded = (await loadSkill(name, { cwd: root }))!;
    const path = join(loaded.meta.dir, "references", "web-api.md");
    const content = await readFile(path, "utf8");
    await writeFile(path, content.replace("Web", "Bad"));
    const result = await skillLoadTool({ name });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("integrity check");
    expect(result.output).toContain(loaded.meta.dir);
  });

  it("refuses missing or extra cached resources rather than listing untrusted additions", async () => {
    await loadSkill(name, { cwd: root });
    await writeFile(join(bundled().dir, "extra.md"), "Untrusted extra instructions");
    await expect(loadSkill(name, { cwd: root })).rejects.toThrow("integrity check");
    await rm(join(bundled().dir, "extra.md"));
    await rm(join(bundled().dir, "references", "web-api.md"));
    await expect(loadSkill(name, { cwd: root })).rejects.toThrow("integrity check");
  });

  it.skipIf(process.platform === "win32")("refuses symlinked cache roots, cores and reference directories", async () => {
    const meta = bundled();
    const outside = join(root, "outside");
    await mkdir(outside);
    await mkdir(join(root, "data"));
    await symlink(outside, meta.root, "dir");
    await expect(loadSkill(name, { cwd: root })).rejects.toThrow("must not be linked");
    expect(await readdir(outside)).toEqual([]);
    await rm(meta.root);
    await loadSkill(name, { cwd: root });
    const original = await readFile(meta.file);
    const copy = join(outside, "SKILL.md");
    await writeFile(copy, original);
    await rm(meta.file);
    await symlink(copy, meta.file);
    await expect(loadSkill(name, { cwd: root })).rejects.toThrow("integrity check");
    await rm(meta.dir, { recursive: true });
    await loadSkill(name, { cwd: root });
    await rm(join(meta.dir, "references"), { recursive: true });
    await symlink(outside, join(meta.dir, "references"), "dir");
    await expect(loadSkill(name, { cwd: root })).rejects.toThrow("integrity check");
  });

  it("reports storage failure and can retry after the prerequisite is fixed", async () => {
    await writeFile(join(root, "not-a-directory"), "blocked");
    vi.stubEnv("CLAI_DATA_DIR", join(root, "not-a-directory"));
    const result = await skillLoadTool({ name });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Could not load skill");
    await rm(join(root, "not-a-directory"));
    expect((await skillLoadTool({ name })).ok).toBe(true);
  });
});
