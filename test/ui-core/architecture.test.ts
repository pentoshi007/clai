import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiCoreRoot = fileURLToPath(new URL("../../src/ui-core", import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function isUnderReactDir(file: string): boolean {
  return relative(uiCoreRoot, file).split(sep)[0] === "react";
}

const RENDERER_IMPORT = /from\s+["'](?:ink|ink-[^"']*|@opentui\/[^"']*|solid-js|react-dom|@inquirer\/[^"']*)["']/;
const REACT_IMPORT = /from\s+["']react["']/;
const TERMINAL_WRITE = /process\.stdout\.write|process\.stderr\.write|process\.stdin\.setRawMode/;
const RENDERER_TREE_IMPORT = /from\s+["'][^"']*\/(?:tui-v2|classic|noninteractive)\//;
const REPL_IMPORT = /from\s+["'][^"']*\/repl(?:\.js|\/[^"']*)["']/;
const TERMINAL_WRITE_ALLOWED = new Set([
  join(uiCoreRoot, "ports", "pager-export-port.ts"),
]);

describe("src/ui-core stays renderer-neutral", () => {
  const files = existsSync(uiCoreRoot) ? walk(uiCoreRoot) : [];

  it("finds the ui-core source tree", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("never imports a renderer package", () => {
    const offenders = files.filter((file) => RENDERER_IMPORT.test(readFileSync(file, "utf8")));
    expect(offenders.map((f) => relative(uiCoreRoot, f))).toEqual([]);
  });

  it("imports react only under ui-core/react/", () => {
    const offenders = files.filter(
      (file) => !isUnderReactDir(file) && REACT_IMPORT.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((f) => relative(uiCoreRoot, f))).toEqual([]);
  });

  it("never writes terminal bytes", () => {
    const offenders = files.filter(
      (file) =>
        !TERMINAL_WRITE_ALLOWED.has(file) &&
        TERMINAL_WRITE.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((f) => relative(uiCoreRoot, f))).toEqual([]);
  });

  it("never imports a renderer tree", () => {
    const offenders = files.filter((file) => RENDERER_TREE_IMPORT.test(readFileSync(file, "utf8")));
    expect(offenders.map((f) => relative(uiCoreRoot, f))).toEqual([]);
  });

  it("never imports the classic REPL", () => {
    const offenders = files.filter((file) => REPL_IMPORT.test(readFileSync(file, "utf8")));
    expect(offenders.map((f) => relative(uiCoreRoot, f))).toEqual([]);
  });

  it("has no barrel index files", () => {
    const offenders = files.filter((file) => /(?:^|[\\/])index\.tsx?$/.test(file));
    expect(offenders.map((f) => relative(uiCoreRoot, f))).toEqual([]);
  });
});
