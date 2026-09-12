import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  capHits,
  filterHitsByGlob,
  fsSearch,
  globToPathRegExp,
  parseEngineOutput,
  parseHitLine,
} from "../src/tools/fs/search.js";

function makeTree(): string {
  const dir = mkdtempSync(join(process.cwd(), ".test-tmp-fssearch-"));
  mkdirSync(join(dir, "src", "nested"), { recursive: true });
  writeFileSync(
    join(dir, "src", "a.ts"),
    'stubGlobal("fetch");\nconst piped = source.stream(1);\nconst plain = 2;\n',
  );
  writeFileSync(
    join(dir, "src", "nested", "b.tsx"),
    "export const B = () => source.stream(2);\n",
  );
  writeFileSync(join(dir, "notes.md"), "stubGlobal is mentioned here\n");
  return dir;
}

const withoutRipgrep = (): (() => void) => {
  const previous = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  return () => {
    process.env.PATH = previous;
  };
};

describe("fsSearch", () => {
  const dirs: string[] = [];
  const restores: Array<() => void> = [];

  afterEach(() => {
    for (const restore of restores) restore();
    restores.length = 0;
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    dirs.length = 0;
  });

  it("matches an alternation pattern with escaped parentheses", async () => {
    const dir = makeTree();
    dirs.push(dir);
    const result = await fsSearch("stubGlobal|\\.stream\\(", dir);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("src/a.ts");
    expect(result.output).toContain("nested/b.tsx");
    expect(result.output).not.toMatch(/Unmatched|not balanced/i);
  });

  it("keeps filename context when searching one file", async () => {
    const dir = makeTree();
    dirs.push(dir);
    const path = join(dir, "evidence.txt");
    writeFileSync(path, "Picker spacing\ntype to filter\nFirst option\n");
    const result = await fsSearch("Picker spacing|type to filter|First option", path);
    expect(result.ok).toBe(true);
    expect(result.output).toContain(`${path}:1:Picker spacing`);
    expect(result.output).toContain(`${path}:2:type to filter`);
    expect(result.output).toContain(`${path}:3:First option`);
    expect(result.output).not.toContain("# no matches");
  });

  it.runIf(process.platform !== "win32")(
    "matches the same pattern through the grep fallback",
    async () => {
      const dir = makeTree();
      dirs.push(dir);
      restores.push(withoutRipgrep());
      const result = await fsSearch("stubGlobal|\\.stream\\(", dir);
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("src/a.ts");
      expect(result.output).toContain("nested/b.tsx");
      expect(result.output).not.toMatch(/Unmatched|not balanced|exit 2/i);
    },
  );

  it("falls back to a literal search when the pattern is not a valid regex", async () => {
    const dir = makeTree();
    dirs.push(dir);
    const result = await fsSearch("stream(1", dir);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("searched it as a literal string");
    expect(result.output).toContain("src/a.ts");
  });

  it.runIf(process.platform !== "win32")(
    "falls back to a literal search through grep as well",
    async () => {
      const dir = makeTree();
      dirs.push(dir);
      restores.push(withoutRipgrep());
      const result = await fsSearch("stream(1", dir);
      expect(result.ok).toBe(true);
      expect(result.output).toContain("src/a.ts");
    },
  );

  it("keeps a lookahead pattern usable", async () => {
    const dir = makeTree();
    dirs.push(dir);
    const result = await fsSearch("source(?=\\.stream)", dir);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("src/a.ts");
    expect(result.output).toContain("pcre2");
  });

  it("honors a path glob with directory separators on either engine", async () => {
    const dir = makeTree();
    dirs.push(dir);
    const scoped = await fsSearch("stream", dir, { glob: "src/**/*.tsx" });
    expect(scoped.ok).toBe(true);
    expect(scoped.output).toContain("nested/b.tsx");
    expect(scoped.output).not.toContain("a.ts");

    restores.push(withoutRipgrep());
    const viaGrep = await fsSearch("stream", dir, { glob: "src/**/*.tsx" });
    expect(viaGrep.ok).toBe(true);
    expect(viaGrep.output).toContain("nested/b.tsx");
    expect(viaGrep.output).not.toContain("a.ts");
  });

  it("reports no matches without failing, and hints at literal retry", async () => {
    const dir = makeTree();
    dirs.push(dir);
    const result = await fsSearch("neverPresent\\(", dir);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("# no matches");
    expect(result.output).toContain("fixedString=true");
  });

  it("reports engine errors instead of returning a false no-match result", async () => {
    const missing = join(process.cwd(), ".test-missing-fs-search-target");
    const result = await fsSearch("needle", missing, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/fs\.search failed/);
    expect(result.output).not.toContain("# no matches");
  });

  it("treats fixedString patterns literally", async () => {
    const dir = makeTree();
    dirs.push(dir);
    const result = await fsSearch("source.stream(1)", dir, {
      fixedString: true,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("src/a.ts");
    expect(result.output).not.toContain("nested/b.tsx");
  });

  it("caps returned hits at maxMatches", async () => {
    const dir = makeTree();
    dirs.push(dir);
    const result = await fsSearch("s", dir, { maxMatches: 1 });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.output).toContain("capped at 1");
  });

  it("rejects an empty pattern", async () => {
    const result = await fsSearch("   ");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("non-empty");
  });

  it("maps globs onto anchored path regexes", () => {
    expect(globToPathRegExp("*.ts")?.test("/a/b/c.ts")).toBe(true);
    expect(globToPathRegExp("*.ts")?.test("/a/b/c.tsx")).toBe(false);
    expect(globToPathRegExp("src/**/*.tsx")?.test("/p/src/x/y.tsx")).toBe(true);
    expect(globToPathRegExp("src/**/*.tsx")?.test("/p/src/y.tsx")).toBe(true);
    expect(globToPathRegExp("src/**/*.tsx")?.test("/p/lib/y.tsx")).toBe(false);
  });
});

describe("engine output parsing", () => {
  const OUTPUT = [
    "/repo/test/a.test.ts-87-  it(\"coalesces\", () => {",
    "/repo/test/a.test.ts:88:    vi.useFakeTimers();",
    "/repo/test/a.test.ts-89-    try {",
    "--",
    "/repo/src/b.ts-110-  before",
    "/repo/src/b.ts:111:    vi.useFakeTimers();",
    "--",
  ].join("\n");

  it("drops group separators instead of counting them as hits", () => {
    const hits = parseEngineOutput(OUTPUT, false);
    expect(hits.map((hit) => hit.line)).toEqual([87, 88, 89, 110, 111]);
    expect(hits.filter((hit) => hit.match).map((hit) => hit.line)).toEqual([
      88, 111,
    ]);
  });

  it("attributes context lines to their file and keeps the match text", () => {
    expect(parseHitLine("/repo/src/b.ts:111:    vi.useFakeTimers();")).toEqual({
      path: "/repo/src/b.ts",
      line: 111,
      match: true,
      text: "    vi.useFakeTimers();",
    });
    expect(parseHitLine("/repo/src/b.ts-110-  before")).toMatchObject({
      path: "/repo/src/b.ts",
      line: 110,
      match: false,
    });
    expect(parseHitLine("--")).toBeUndefined();
    expect(parseHitLine("C:\\repo\\src\\b.ts:9:hit")).toMatchObject({
      path: "C:\\repo\\src\\b.ts",
      line: 9,
    });
  });

  it("drops every line of a file the glob excludes, separators included", () => {
    const filtered = filterHitsByGlob(
      parseEngineOutput(OUTPUT, false),
      "src/**/*.ts",
    );
    expect(filtered.map((hit) => hit.path)).toEqual([
      "/repo/src/b.ts",
      "/repo/src/b.ts",
    ]);
    expect(filterHitsByGlob(parseEngineOutput(OUTPUT, false), "**/*.tsx")).toEqual(
      [],
    );
  });

  it("caps on matches rather than rendered lines and never ends on context", () => {
    const capped = capHits(parseEngineOutput(OUTPUT, false), 1);
    expect(capped.matches).toBe(1);
    expect(capped.truncated).toBe(true);
    expect(capped.hits.map((hit) => hit.line)).toEqual([87, 88]);
  });

  it("keeps whole files in filesOnly mode", () => {
    expect(parseEngineOutput("/repo/a.ts\n/repo/b.ts\n", true)).toEqual([
      { path: "/repo/a.ts", line: 0, match: true, text: "" },
      { path: "/repo/b.ts", line: 0, match: true, text: "" },
    ]);
  });
});
