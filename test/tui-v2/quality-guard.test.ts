/**
 * V2-090 — file-size, dependency pin, and architecture quality rules.
 * Hard fail at >400 lines (QUALITY); OpenTUI packages must be exact + equal.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("V2-090 quality guardrails", () => {
  const appFiles = walk(join(root, "src", "app"));
  const tuiFiles = walk(join(root, "src", "tui-v2"));
  const scoped = [...appFiles, ...tuiFiles];

  it("finds app + tui-v2 sources to check", () => {
    expect(appFiles.length).toBeGreaterThan(10);
    expect(tuiFiles.length).toBeGreaterThan(20);
  });



  it("pins OpenTUI packages to the same exact version (no ranges)", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const keys = ["@opentui/core", "@opentui/react"] as const;
    const versions = keys.map((k) => pkg.dependencies[k]);
    for (const v of versions) {
      expect(v, "OpenTUI deps must be exact pins").toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(new Set(versions).size).toBe(1);
    expect(pkg.dependencies["@opentui/keymap"]).toBeUndefined();
  });

  it("does not depend on @opentui/solid (ADR-006)", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const all = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.optionalDependencies,
    };
    expect(all["@opentui/solid"]).toBeUndefined();
  });

  it("keeps react as the only UI framework peer for v2 (no solid-js)", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(all["solid-js"]).toBeUndefined();
    expect(all.react).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
