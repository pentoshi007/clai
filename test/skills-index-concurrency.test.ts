import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as discovery from "../src/skills/discover.js";
import { getSkillIndex, invalidateSkillIndex, skillIndexSnapshot } from "../src/skills/registry.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "clai-skill-index-"));
  vi.stubEnv("CLAI_DATA_DIR", join(root, "data"));
  vi.stubEnv("CLAI_SKILLS_PATH", "");
  invalidateSkillIndex();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  invalidateSkillIndex();
  await rm(root, { recursive: true, force: true });
});

async function project(name: string): Promise<string> {
  const cwd = join(root, name);
  const dir = join(cwd, ".clai", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Test project-specific skill.\n---\nbody`);
  return cwd;
}

describe("skill index concurrency", () => {
  it("does not share an in-flight project result with a different project", async () => {
    const alpha = await project("alpha");
    const beta = await project("beta");
    const [a, b] = await Promise.all([getSkillIndex({ cwd: alpha }), getSkillIndex({ cwd: beta })]);
    expect(a.names.has("alpha")).toBe(true);
    expect(a.names.has("beta")).toBe(false);
    expect(b.names.has("beta")).toBe(true);
    expect(b.names.has("alpha")).toBe(false);
    expect(a.names.has("clai-superman-skill")).toBe(true);
    expect(b.names.has("clai-superman-skill")).toBe(true);
  });

  it("shares concurrent scans only for the same key", async () => {
    const scan = vi.spyOn(discovery, "discoverSkills");
    const [first, second] = await Promise.all([getSkillIndex({ cwd: root }), getSkillIndex({ cwd: root })]);
    expect(first).toBe(second);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("does not let an invalidated scan replace a newer result", async () => {
    type ScanResult = Awaited<ReturnType<typeof discovery.discoverSkills>>;
    let settle: (result: ScanResult) => void = () => { throw new Error("scan not started"); };
    vi.spyOn(discovery, "discoverSkills").mockImplementationOnce(() => new Promise<ScanResult>((resolve) => { settle = resolve; }));
    const first = getSkillIndex({ cwd: root });
    invalidateSkillIndex();
    const second = await getSkillIndex({ cwd: root });
    settle({ skills: [], truncated: true });
    expect((await first).truncated).toBe(true);
    expect(skillIndexSnapshot()).toBe(second);
    expect((await getSkillIndex({ cwd: root }))).toBe(second);
  });

  it("retains the bundle and signals incomplete coverage if local scanning fails", async () => {
    vi.spyOn(discovery, "discoverSkills").mockRejectedValueOnce(new Error("failed local scan"));
    const index = await getSkillIndex({ cwd: root });
    expect(index.truncated).toBe(true);
    expect(index.names.has("clai-superman-skill")).toBe(true);
    expect(index.skills.find((skill) => skill.name === "clai-superman-skill")!.scope).toBe("bundled");
  });
});
