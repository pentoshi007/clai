import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(
  fileURLToPath(new URL("../../src/app", import.meta.url)),
);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

// The Phase 2 gate: no app-layer module imports the UI framework(s). Also guard
// against pulling terminal-prompt libraries into the renderer-independent layer.
const FORBIDDEN_IMPORT =
  /\bfrom\s+["'](?:@opentui\/[^"']+|ink|ink-[^"']+|solid-js|react|react-dom|@inquirer\/[^"']+)["']/;

describe("V2-025 src/app stays renderer-independent", () => {
  const files = walk(appDir);

  it("finds application-layer source files to check", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("never imports Ink, OpenTUI, Solid, React, or inquirer", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (FORBIDDEN_IMPORT.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("does not write terminal control bytes from the app layer", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (/process\.stdout\.write\s*\(/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
