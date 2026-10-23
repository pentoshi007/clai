import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getSkillIndex, loadSkill } from "../src/skills/registry.js";
import { renderSkillCatalog } from "../src/skills/catalog.js";
import { fsRead } from "../src/tools/fs/read.js";

const index = await getSkillIndex();
const bundled = index.skills.filter((skill) => skill.scope === "bundled");
assert(bundled.some((skill) => skill.name === "clai-superman-skill"));
for (const meta of bundled) {
  assert(!existsSync(meta.dir), "Run this smoke check with a fresh isolated CLAI_DATA_DIR");
  const catalog = renderSkillCatalog({ skills: index.skills, prompt: "Investigate security vulnerabilities" })!;
  assert(catalog.includes(`load ${meta.name} before investigating`));
  assert(!catalog.includes("The investigation loop"));
  const loaded = await loadSkill(meta.name);
  assert(loaded && !loaded.truncated);
  assert(loaded.body.includes("The investigation loop"));
  assert(loaded.body.includes("Current knowledge and living mappings"));
  assert(loaded.resources.includes("references/novel-research.md"));
  for (const resource of loaded.resources) {
    const path = join(loaded.meta.dir, resource);
    const result = await fsRead(path);
    assert(result.ok, `${resource}: ${result.output}`);
    assert((await readFile(path, "utf8")).length > 100);
  }
  console.log(`${meta.name}: metadata-only discovery, full core, ${loaded.resources.length} readable references, ${process.platform}/${process.arch}`);
}
