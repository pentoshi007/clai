import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSkillName } from "../src/skills/discover.js";
import { parseFrontmatter } from "../src/skills/frontmatter.js";
import type { BundledSkillDefinition } from "../src/skills/types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(root, "resources", "skills");
const outputRoot = join(root, "src", "skills");
const check = process.argv.includes("--check");

async function collectFiles(dir: string, prefix = ""): Promise<Record<string, string>> {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.name)) {
      throw new Error(`Unsupported bundled resource name: ${join(dir, entry.name)}`);
    }
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory() && !prefix) {
      Object.assign(files, await collectFiles(join(dir, entry.name), `${name}/`));
      continue;
    }
    if (!entry.isFile()) throw new Error(`Bundled resources must be regular files within two levels: ${name}`);
    const text = (await readFile(join(dir, entry.name), "utf8")).replace(/\r\n?/g, "\n");
    if (text.includes("\u0000") || Buffer.byteLength(text) > 48 * 1024) {
      throw new Error(`Bundled resource must be bounded text: ${name}`);
    }
    files[name] = text;
  }
  return files;
}

function definition(name: string, files: Readonly<Record<string, string>>): BundledSkillDefinition {
  const skill = files["SKILL.md"];
  if (!skill) throw new Error(`Missing ${name}/SKILL.md`);
  const parsed = parseFrontmatter(skill);
  const description = parsed.fields.description?.replace(/\s+/g, " ").trim();
  if (!parsed.present || parsed.fields.name !== name || normalizeSkillName(name) !== name) {
    throw new Error(`Bundled skill name/frontmatter mismatch: ${name}`);
  }
  if (!description || description.length > 420) throw new Error(`Invalid bundled description: ${name}`);
  const resources = Object.keys(files).filter((file) => file !== "SKILL.md");
  if (resources.length > 40) throw new Error(`Too many bundled resources: ${name}`);
  const digest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return {
    name,
    description,
    digest,
    resources,
    ...(parsed.fields.license ? { license: parsed.fields.license } : {}),
    ...(parsed.fields.compatibility ? { compatibility: parsed.fields.compatibility } : {}),
  };
}

async function emit(name: string, content: string): Promise<void> {
  const path = join(outputRoot, name);
  if (!check) {
    await writeFile(path, content, "utf8");
    return;
  }
  const current = await readFile(path, "utf8").catch(() => "");
  if (current !== content) throw new Error(`${name} is missing or stale; run npm run embed-skills`);
}

const entries = (await readdir(sourceRoot, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const catalog: BundledSkillDefinition[] = [];
const payloads: string[] = [];
for (const entry of entries) {
  if (!entry.isDirectory()) throw new Error(`Expected skill directory: ${entry.name}`);
  const files = await collectFiles(join(sourceRoot, entry.name));
  catalog.push(definition(entry.name, files));
  payloads.push(`  ${JSON.stringify(entry.name)}: {\n${Object.entries(files).map(([path, content]) => `    ${JSON.stringify(path)}: ${JSON.stringify(content)},`).join("\n")}\n  },`);
}
if (catalog.length === 0) throw new Error("No bundled skills found");
await emit("bundled-catalog.generated.ts", `import type { BundledSkillDefinition } from "./types.js";\n\nexport const BUNDLED_SKILLS: readonly BundledSkillDefinition[] = ${JSON.stringify(catalog, null, 2)};\n`);
await emit("bundled-content.generated.ts", `export const BUNDLED_SKILL_FILES: Readonly<Record<string, Readonly<Record<string, string>>>> = {\n${payloads.join("\n")}\n};\n`);
console.log(`Bundled skills ${check ? "match their sources" : "embedded"} (${catalog.length} skill, ${catalog.reduce((count, skill) => count + skill.resources.length, 0)} resources)`);
