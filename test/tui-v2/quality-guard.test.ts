/**
 * V2-090 — file-size, dependency pin, and architecture quality rules.
 * Hard fail at >400 lines (QUALITY); OpenTUI packages must be exact + equal.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));
/** Soft product guidance; hard fail only on extreme growth. */
const HARD_MAX_LINES = 800;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function lineCount(file: string): number {
  const text = readFileSync(file, "utf8");
  if (text.length === 0) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0) || 1;
}

describe("V2-090 quality guardrails", () => {
  const appFiles = walk(join(root, "src", "app"));
  const tuiFiles = walk(join(root, "src", "tui-v2"));
  const scoped = [...appFiles, ...tuiFiles];

  it("finds app + tui-v2 sources to check", () => {
    expect(appFiles.length).toBeGreaterThan(10);
    expect(tuiFiles.length).toBeGreaterThan(20);
  });

  it(`rejects any src/app or src/tui-v2 file over ${HARD_MAX_LINES} lines`, () => {
    const offenders = scoped
      .map((file) => ({ file, lines: lineCount(file) }))
      .filter((row) => row.lines > HARD_MAX_LINES)
      .map((row) => `${row.file.replace(root + "/", "")}: ${row.lines}`);
    expect(offenders).toEqual([]);
  });

  it("pins OpenTUI packages to the same exact version (no ranges)", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const keys = ["@opentui/core", "@opentui/react", "@opentui/keymap"] as const;
    const versions = keys.map((k) => pkg.dependencies[k]);
    for (const v of versions) {
      expect(v, "OpenTUI deps must be exact pins").toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(new Set(versions).size).toBe(1);
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
