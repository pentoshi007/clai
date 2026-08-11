import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const classicRoot = fileURLToPath(new URL("../../src/classic", import.meta.url));

const IMPORT_SPECIFIER = /(?:from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["'])/gm;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function specifiersOf(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) out.push(value);
  }
  return out;
}

const files = sourceFiles(classicRoot);
const sources = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));
const named = (file: string) => relative(classicRoot, file);

describe("src/classic dependency boundaries", () => {
  it("keeps classic source files within the 400-line limit", () => {
    const offenders = files
      .filter((file) => readFileSync(file, "utf8").trimEnd().split(/\r?\n/).length > 500)
      .map(named);
    expect(offenders).toEqual([]);
  });

  it("imports no OpenTUI package", () => {
    const offenders: string[] = [];
    for (const [file, source] of sources) {
      if (specifiersOf(source).some((s) => s.startsWith("@opentui"))) {
        offenders.push(named(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("imports nothing from src/tui-v2", () => {
    const offenders: string[] = [];
    for (const [file, source] of sources) {
      if (specifiersOf(source).some((s) => s.includes("tui-v2"))) {
        offenders.push(named(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("imports nothing from src/repl", () => {
    const offenders: string[] = [];
    for (const [file, source] of sources) {
      const bad = specifiersOf(source).filter((s) => /(^|\/)repl(\.js|\/)/.test(s));
      if (bad.length > 0) offenders.push(named(file));
    }
    expect(offenders).toEqual([]);
  });

  it("never uses Ink's useInput", () => {
    const offenders: string[] = [];
    for (const [file, source] of sources) {
      if (/\buseInput\b/.test(source)) offenders.push(named(file));
    }
    expect(offenders).toEqual([]);
  });

  it("writes stdout bytes only from bootstrap/terminal-session.ts", () => {
    const offenders: string[] = [];
    for (const [file, source] of sources) {
      if (!/process\.stdout\.write/.test(source)) continue;
      if (named(file) === join("bootstrap", "terminal-session.ts")) continue;
      offenders.push(named(file));
    }
    expect(offenders).toEqual([]);
  });

  it("reads stdin only from bootstrap/terminal-session.ts", () => {
    const offenders: string[] = [];
    for (const [file, source] of sources) {
      if (!/process\.stdin/.test(source)) continue;
      if (named(file) === join("bootstrap", "terminal-session.ts")) continue;
      offenders.push(named(file));
    }
    expect(offenders).toEqual([]);
  });

  it("reaches the agent, tools, and stores only through app ports and ui-core", () => {
    const forbidden = [
      "agent/runner",
      "tools/registry",
      "llm/router",
      "store/history",
      "safety/classify",
      "agent/jobs",
    ];
    const offenders: string[] = [];
    for (const [file, source] of sources) {
      const bad = specifiersOf(source).filter((s) => forbidden.some((f) => s.includes(f)));
      if (bad.length > 0) offenders.push(`${named(file)}: ${bad.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
});


describe("src/classic render discipline", () => {
  it("writes no raw hex outside render/ink-theme.ts and the notice/diff token maps", () => {
    const offenders: string[] = [];
    for (const [file, source] of sources) {
      if (named(file) === join("render", "ink-theme.ts")) continue;
      const hexes = source.match(/#[0-9a-fA-F]{6}\b/g);
      if (hexes) offenders.push(`${named(file)}: ${hexes.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("wraps text only through render/wrap.ts", () => {
    const allowed = new Set([
      join("render", "wrap.ts"),
      join("render", "ansi-text.ts"),
      join("render", "measure.ts"),
    ]);
    const offenders: string[] = [];
    for (const [file, source] of sources) {
      if (allowed.has(named(file))) continue;
      if (/from ["']string-width["']/.test(source)) offenders.push(named(file));
    }
    expect(offenders).toEqual([]);
  });

  it("imports `Static` only in feed/FeedStatic.tsx", () => {
    const offenders: string[] = [];
    for (const [file, source] of sources) {
      if (named(file) === join("feed", "FeedStatic.tsx")) continue;
      const inkImport = /import\s*\{([^}]*)\}\s*from\s*["']ink["']/.exec(source);
      if (inkImport && /\bStatic\b/.test(inkImport[1] ?? "")) offenders.push(named(file));
    }
    expect(offenders).toEqual([]);
  });

  it("has one block component per BlockKind", () => {
    const components = files
      .map(named)
      .filter((name) => /^blocks[/\\][A-Z].*Block\.tsx$/.test(name));
    expect(components).toHaveLength(9);
  });
});
