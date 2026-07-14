import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
const tuiV2Root = join(here, "..", "..", "src", "tui-v2");

/**
 * The renderer-independent core of the v2 UI (layout, actions, capabilities,
 * lifecycle, composition root, ui-selection) must not import the renderer
 * framework — only `src/tui-v2/app/**` and `bootstrap/start-tui-v2.ts` may.
 * This keeps the application/controller logic testable under Node and
 * swappable behind the same ports if the adapter ever changes.
 */
const RENDERER_ALLOWED = new Set<string>([
  join(tuiV2Root, "app", "App.tsx"),
  join(tuiV2Root, "app", "providers.tsx"),
  join(tuiV2Root, "bootstrap", "start-tui-v2.ts"),
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("src/tui-v2 architecture boundary", () => {
  const files = walk(tuiV2Root);

  it("finds the tui-v2 source tree", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("keeps the renderer framework out of renderer-independent modules", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (RENDERER_ALLOWED.has(file)) continue;
      const src = readFileSync(file, "utf8");
      if (/from\s+["']@opentui\//.test(src) || /from\s+["']react["']/.test(src)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never writes raw terminal bytes from renderer-independent modules", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (RENDERER_ALLOWED.has(file)) continue;
      const src = readFileSync(file, "utf8");
      if (/process\.stdout\.write|process\.stdin\.setRawMode|process\.stdin\.write/.test(src))
        offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
