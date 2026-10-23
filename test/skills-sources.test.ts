import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BUNDLED_SKILLS } from "../src/skills/bundled-catalog.generated.js";
import { BUNDLED_SKILL_FILES } from "../src/skills/bundled-content.generated.js";
import { parseFrontmatter } from "../src/skills/frontmatter.js";

const root = process.cwd();
const tsxLoader = resolve(root, "node_modules/tsx/dist/loader.mjs");

function generate(cwd: string, check = true): void {
  execFileSync(process.execPath, ["--import", tsxLoader, "scripts/embed-skills.ts", ...(check ? ["--check"] : [])], { cwd, stdio: "pipe" });
}

describe("shipped security skill sources", () => {
  it("keeps metadata, content digest and every embedded file identical to the Markdown sources", async () => {
    expect(() => generate(root)).not.toThrow();
    for (const skill of BUNDLED_SKILLS) {
      const files = BUNDLED_SKILL_FILES[skill.name]!;
      const source = join(root, "resources", "skills", skill.name);
      for (const [path, content] of Object.entries(files)) {
        expect(await readFile(join(source, path), "utf8")).toBe(content);
        expect(content.split("\n").length).toBeLessThanOrEqual(500);
        for (const [, target] of content.matchAll(/\]\(([^)]+)\)/g)) {
          if (target!.includes("://") || target!.startsWith("#")) continue;
          const destination = resolve(dirname(join(source, path)), target!.split("#")[0]!);
          const pathFromRoot = relative(source, destination);
          expect(pathFromRoot.startsWith("..")).toBe(false);
          expect(isAbsolute(pathFromRoot)).toBe(false);
          expect(await readFile(destination, "utf8")).not.toHaveLength(0);
        }
      }
      const parsed = parseFrontmatter(files["SKILL.md"]!);
      expect(parsed.fields.name).toBe(skill.name);
      expect(parsed.fields.description).toBe(skill.description);
      expect(skill.description.length).toBeLessThanOrEqual(420);
      expect(skill.digest).toBe(createHash("sha256").update(JSON.stringify(files)).digest("hex"));
      expect(Object.keys(files).filter((path) => path !== "SKILL.md")).toEqual(skill.resources);
      expect(parsed.body.length).toBeLessThan(12_000);
    }
  });

  it("fails on source/generated drift and rejects invalid bundles without mutating the checkout", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "clai-skill-drift-"));
    try {
      await mkdir(join(fixture, "scripts"), { recursive: true });
      await mkdir(join(fixture, "src", "skills"), { recursive: true });
      await writeFile(join(fixture, "package.json"), '{"type":"module"}\n');
      await cp(join(root, "scripts", "embed-skills.ts"), join(fixture, "scripts", "embed-skills.ts"));
      for (const file of ["discover.ts", "frontmatter.ts", "types.ts", "bundled-catalog.generated.ts", "bundled-content.generated.ts"]) {
        await cp(join(root, "src", "skills", file), join(fixture, "src", "skills", file));
      }
      await cp(join(root, "resources"), join(fixture, "resources"), { recursive: true });
      expect(() => generate(fixture)).not.toThrow();
      const path = join(fixture, "resources", "skills", "clai-superman-skill", "SKILL.md");
      const original = await readFile(path, "utf8");
      await writeFile(path, `${original}\nChanged source.\n`);
      expect(() => generate(fixture)).toThrow();
      generate(fixture, false);
      expect(() => generate(fixture)).not.toThrow();
      await writeFile(path, original.replace("name: clai-superman-skill", "name: wrong-name"));
      expect(() => generate(fixture, false)).toThrow();
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }, 15_000);

  it("ships the library and drift checks through npm, standalone builds and CI", async () => {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      files: string[];
      scripts: Record<string, string>;
    };
    expect(manifest.files).toContain("resources/skills");
    expect(manifest.files).toContain("guides/security-skill.md");
    expect(manifest.files).toContain("test/fixtures/security-skill-scenarios.json");
    expect(manifest.scripts.build).toContain("scripts/embed-skills.ts");
    expect(manifest.scripts.compile).toContain("scripts/build.ts");
    expect(await readFile(join(root, "scripts", "build.ts"), "utf8")).toContain("scripts/embed-skills.ts");
    expect(await readFile(join(root, ".github", "workflows", "ci.yml"), "utf8")).toContain("npm run embed-skills:check");
  });
});
