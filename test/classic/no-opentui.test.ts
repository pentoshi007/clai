import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = fileURLToPath(new URL("../../src", import.meta.url));
const START_CLASSIC = resolve(srcRoot, "classic/bootstrap/start-classic.tsx");
const INDEX = resolve(srcRoot, "index.ts");

const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+["']([^"']+)["']/g;
const BARE_IMPORT = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

function specifiers(source: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const value = match[1];
    if (value) out.push(value);
  }
  return out;
}

function resolveLocal(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(fromFile), specifier).replace(/\.js$/, "");
  for (const candidate of [`${base}.ts`, `${base}.tsx`]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function staticGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, "utf8");
    const all = [
      ...specifiers(source, STATIC_IMPORT),
      ...specifiers(source, BARE_IMPORT),
    ];
    for (const specifier of all) {
      const local = resolveLocal(file, specifier);
      if (local) queue.push(local);
      else if (!specifier.startsWith(".")) packages.add(specifier);
    }
  }
  return { files, packages };
}

describe("the classic frontend never pulls in OpenTUI", () => {
  it("has a start-classic entry point", () => {
    expect(existsSync(START_CLASSIC)).toBe(true);
  });

  it("start-classic's static graph contains no OpenTUI package", () => {
    const { packages } = staticGraph(START_CLASSIC);
    expect([...packages].filter((p) => p.startsWith("@opentui"))).toEqual([]);
  });

  it("start-classic's static graph contains no src/tui-v2 module", () => {
    const { files } = staticGraph(START_CLASSIC);
    const offenders = [...files]
      .map((f) => relative(srcRoot, f))
      .filter((f) => f.startsWith("tui-v2"));
    expect(offenders).toEqual([]);
  });

  it("src/index.ts never statically imports OpenTUI or the tui-v2 tree", () => {
    const source = readFileSync(INDEX, "utf8");
    const all = [
      ...specifiers(source, STATIC_IMPORT),
      ...specifiers(source, BARE_IMPORT),
    ];
    expect(all.filter((s) => s.startsWith("@opentui"))).toEqual([]);
    expect(all.filter((s) => s.includes("tui-v2"))).toEqual([]);
  });

  it("src/index.ts reaches both frontends only through dynamic import", () => {
    const source = readFileSync(INDEX, "utf8");
    const dynamic = specifiers(source, DYNAMIC_IMPORT);
    expect(dynamic).toContain("./tui-v2/bootstrap/start-tui-v2.js");
    expect(dynamic).toContain("./classic/bootstrap/start-classic.js");
  });

  it("src/index.ts branches to classic before probing Bun or OpenTUI", () => {
    const source = readFileSync(INDEX, "utf8");
    const classicBranch = source.indexOf('ui === "classic"');
    const bunProbe = source.indexOf("isBunRuntime()");
    const tuiImport = source.indexOf("./tui-v2/bootstrap/start-tui-v2.js");
    expect(classicBranch).toBeGreaterThan(-1);
    expect(classicBranch).toBeLessThan(bunProbe);
    expect(classicBranch).toBeLessThan(tuiImport);
  });

  it("src/index.ts gates the whole interactive flow behind resolveUiChoice", () => {
    const source = readFileSync(INDEX, "utf8");
    const resolveCall = source.indexOf("resolveUiChoice(options)");
    const gateCall = source.indexOf("canUseTui()");
    expect(resolveCall).toBeGreaterThan(-1);
    expect(resolveCall).toBeLessThan(gateCall);
  });
});
