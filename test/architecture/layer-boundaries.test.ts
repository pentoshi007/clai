import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  countLines,
  importedRepoModules,
  importSpecifiersFromText,
  isRuntimePolicyModule,
  listSourceFiles,
  NEW_FILE_MAX_LINES,
  RENDERER_ROOTS,
  REPO_ROOT,
  SRC_ROOT,
  toRepoPath,
  UI_CORE_ROOT,
} from "./boundaries.js";

const VALIDATION_COMMAND = "npm run test:arch";

const baseline = JSON.parse(
  readFileSync(join(REPO_ROOT, "test/architecture/legacy-baseline.json"), "utf8"),
) as {
  oversizedSourceFiles: string[];
  uiCoreRuntimePolicyImports: string[];
};

describe(`architecture boundaries — validate with \`${VALIDATION_COMMAND}\``, () => {
  it("discovers every supported module import form", () => {
    expect(
      importSpecifiersFromText(`
        import "./side-effect.js";
        import type { LocalType } from "./types.js";
        export { value } from "./value.js";
        export * from "./all.js";
        void import("./lazy.js");
      `),
    ).toEqual([
      "./side-effect.js",
      "./types.js",
      "./value.js",
      "./all.js",
      "./lazy.js",
    ]);
  });
  it("keeps provider, retry, and compaction policy out of renderer modules", () => {
    const violations: string[] = [];
    for (const root of RENDERER_ROOTS) {
      for (const file of listSourceFiles(root)) {
        for (const imported of importedRepoModules(file)) {
          if (isRuntimePolicyModule(imported)) {
            violations.push(`${file} -> ${imported}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("does not let ui-core acquire new runtime policy dependencies", () => {
    const found: string[] = [];
    for (const file of listSourceFiles(UI_CORE_ROOT)) {
      for (const imported of importedRepoModules(file)) {
        if (isRuntimePolicyModule(imported)) found.push(`${file} -> ${imported}`);
      }
    }
    const added = found.filter(
      (edge) => !baseline.uiCoreRuntimePolicyImports.includes(edge),
    );
    expect(added).toEqual([]);
    expect([...found].sort()).toEqual([...baseline.uiCoreRuntimePolicyImports].sort());
  });

  it("rejects new source files over the line limit while ignoring legacy files", () => {
    const legacy = new Set(baseline.oversizedSourceFiles);
    const offenders = listSourceFiles(toRepoPath(SRC_ROOT))
      .filter((file) => !legacy.has(file))
      .filter((file) => countLines(file) > NEW_FILE_MAX_LINES);
    expect(offenders).toEqual([]);
  });

  it("keeps the legacy baseline free of stale entries", () => {
    const present = new Set(listSourceFiles(toRepoPath(SRC_ROOT)));
    const missing = baseline.oversizedSourceFiles.filter((file) => !present.has(file));
    expect(missing).toEqual([]);
    const shrunk = baseline.oversizedSourceFiles.filter(
      (file) => countLines(file) <= NEW_FILE_MAX_LINES,
    );
    expect(shrunk).toEqual([]);
    const sorted = [...baseline.oversizedSourceFiles].sort();
    expect(baseline.oversizedSourceFiles).toEqual(sorted);
  });
});
