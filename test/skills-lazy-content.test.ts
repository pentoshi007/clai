import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loaded = vi.hoisted(() => vi.fn());
vi.mock("../src/skills/bundled-content.generated.js", async (original) => {
  loaded();
  return original<typeof import("../src/skills/bundled-content.generated.js")>();
});

import { getSkillIndex, invalidateSkillIndex, loadSkill } from "../src/skills/registry.js";

let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  invalidateSkillIndex();
  if (root) await rm(root, { recursive: true, force: true });
});

it("does not import instruction/reference content until loading the bundled skill", async () => {
  root = await mkdtemp(join(tmpdir(), "clai-skill-lazy-"));
  vi.stubEnv("CLAI_DATA_DIR", join(root, "data"));
  invalidateSkillIndex();
  const index = await getSkillIndex({ cwd: root });
  expect(index.names.has("clai-superman-skill")).toBe(true);
  expect(loaded).not.toHaveBeenCalled();
  expect((await loadSkill("clai-superman-skill", { cwd: root }))!.truncated).toBe(false);
  expect(loaded).toHaveBeenCalledTimes(1);
});
