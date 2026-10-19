import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adoptLegacyFile } from "../../src/store/legacy-location.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "clai-legacy-location-"));
  roots.push(path);
  return path;
}

describe("legacy storage location adoption", () => {
  it("moves a file written under a custom data directory to the released location", async () => {
    const base = await root();
    const legacy = join(base, "data", "keys.json");
    const target = join(base, "home", ".clai", "keys.json");
    await mkdir(join(base, "data"), { recursive: true });
    await writeFile(legacy, "{\"openai\":\"fixture\"}\n");
    await adoptLegacyFile(target, legacy);
    expect(await readFile(target, "utf8")).toBe("{\"openai\":\"fixture\"}\n");
    expect(existsSync(legacy)).toBe(false);
  });

  it("never overwrites an existing file at the released location", async () => {
    const base = await root();
    const legacy = join(base, "legacy-scope.json");
    const target = join(base, "scope.json");
    await writeFile(legacy, "legacy");
    await writeFile(target, "current");
    await adoptLegacyFile(target, legacy);
    expect(await readFile(target, "utf8")).toBe("current");
    expect(await readFile(legacy, "utf8")).toBe("legacy");
  });

  it("is a no-op when both locations are the same or nothing was written", async () => {
    const base = await root();
    const same = join(base, "keys.json");
    await writeFile(same, "same");
    await adoptLegacyFile(same, same);
    expect(await readFile(same, "utf8")).toBe("same");
    await adoptLegacyFile(join(base, "absent-target.json"), join(base, "absent-legacy.json"));
    expect(existsSync(join(base, "absent-target.json"))).toBe(false);
  });
});
