import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const uiCoreDir = join(root, "src/ui-core");
const CONTROL_SEQUENCE_ALLOWED = new Set([
  join(uiCoreDir, "ports", "pager-export-port.ts"),
  join(uiCoreDir, "rendering", "markdown.ts"),
]);

describe("ui-core stays renderer-neutral", () => {
  const files = walk(uiCoreDir);

  it("finds ui-core source to check", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("never imports Ink, OpenTUI, react-dom, or @inquirer", () => {
    const banned = /\bfrom\s+["'](?:ink|ink-[^"']+|@opentui\/[^"']+|react-dom|@inquirer\/[^"']+)["']/;
    const offenders = files.filter((f) => banned.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("imports React only from src/ui-core/react", () => {
    const banned = /\bfrom\s+["']react["']/;
    const offenders = files.filter(
      (f) => !f.includes(`src/ui-core/react/`) && banned.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("writes no raw terminal control sequences outside the pager export port", () => {
    const offenders = files.filter((f) => {
      if (CONTROL_SEQUENCE_ALLOWED.has(f)) return false;
      return /\\x1b\[|\\u001b\[/.test(readFileSync(f, "utf8"));
    });
    expect(offenders).toEqual([]);
  });

  it("never imports either renderer tree", () => {
    const banned = /\bfrom\s+["'][^"']*src[/\\](?:tui-v2|classic)[/\\]/;
    const rel = /\bfrom\s+["'](?:\.\.\/)+(?:tui-v2|classic)\//;
    const offenders = files.filter((f) => {
      const s = readFileSync(f, "utf8");
      return banned.test(s) || rel.test(s);
    });
    expect(offenders).toEqual([]);
  });
});

describe("renderer isolation", () => {
  const classicDir = join(root, "src/classic");
  const tuiV2Dir = join(root, "src/tui-v2");

  it("tui-v2 never imports classic", () => {
    const offenders = walk(tuiV2Dir).filter((f) =>
      /\bfrom\s+["'][^"']*classical?c[/\\]/.test(readFileSync(f, "utf8")) ||
      /\bfrom\s+["'](?:\.\.\/)+classic\//.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("classic never imports tui-v2 and never imports @opentui", () => {
    const offenders = walk(classicDir).filter((f) => {
      const s = readFileSync(f, "utf8");
      return (
        /\bfrom\s+["'](?:\.\.\/)+tui-v2\//.test(s) ||
        /\bfrom\s+["']@opentui\//.test(s)
      );
    });
    expect(offenders).toEqual([]);
  });

  it("tui-v2 never imports ink", () => {
    const offenders = walk(tuiV2Dir).filter((f) =>
      /\bfrom\s+["']ink["']|\bfrom\s+["']ink-[^"']+["']/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("renderers never import the agent runner, safety layer, or tool registry", () => {
    const banned =
      /\bfrom\s+["'](?:\.\.\/)+(?:modes\/agent|safety\/|tools\/registry)\.js["']/;
    const offenders = [...walk(tuiV2Dir), ...walk(classicDir)].filter((f) =>
      banned.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
