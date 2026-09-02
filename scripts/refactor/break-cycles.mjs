/**
 * Breaks facade/child import cycles created by mechanical moves.
 *
 * When a declaration moves out of a module, the new module may still need a
 * helper that stayed behind, which produces `facade -> child -> facade`. That
 * cycle makes load order significant and hides the real dependency direction.
 * This relocates every name a child imports back from its facade into a leaf
 * module that both sides import, leaving a single direction.
 *
 *   node scripts/refactor/break-cycles.mjs --facade src/tools/shell.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const facade = flag("facade");
if (!facade) {
  console.error("usage: break-cycles.mjs --facade <file>");
  process.exit(2);
}

const facadeJs = basename(facade).replace(/\.tsx?$/, ".js");
const sources = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.tsx?$/.test(full)) sources.push(full);
  }
};
walk("src");

// Only modules the facade itself imports can form a cycle with it; a module that
// merely consumes the facade is a legitimate one-directional dependency and must
// not be repointed.
const facadeImports = new Set();
{
  const text = readFileSync(facade, "utf8");
  for (const match of text.matchAll(/from\s+"(\.[^"]+)";/g)) {
    const resolved = join(dirname(facade), match[1]).replace(/\.js$/, "");
    for (const candidate of [`${resolved}.ts`, `${resolved}.tsx`]) {
      facadeImports.add(candidate);
    }
  }
}

const backImporters = [];
const names = new Set();
for (const file of sources) {
  if (file === facade) continue;
  if (!facadeImports.has(file)) continue;
  const text = readFileSync(file, "utf8");
  let importsFacade = false;
  for (const match of text.matchAll(
    /^(\s*)import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)";$/gm,
  )) {
    if (basename(match[4]) !== facadeJs) continue;
    if (match[2]) continue;
    importsFacade = true;
    for (const part of match[3].split(",")) {
      const name = part.trim().split(" as ")[0].trim();
      if (name) names.add(name);
    }
  }
  if (importsFacade) backImporters.push(file);
}

if (names.size === 0) {
  console.log(`break-cycles: no value back-imports of ${facade}`);
  process.exit(0);
}

const facadeText = readFileSync(facade, "utf8");
const declaredHere = new Set();
for (const match of facadeText.matchAll(
  /^export\s+(?:async\s+)?(?:function|const|let|var|class|enum)\s+(\w+)/gm,
)) {
  declaredHere.add(match[1]);
}
const movable = [...names].filter((name) => declaredHere.has(name)).sort();
if (movable.length === 0) {
  console.log(
    `break-cycles: ${facade} back-imports are re-exports only: ${[...names].sort().join(", ")}`,
  );
  process.exit(0);
}

const shared = `${dirname(facade)}/${basename(facade, ".ts")}/shared-internals.ts`;
execFileSync(
  "node",
  [
    "scripts/refactor/move-symbols.mjs",
    "move",
    "--from",
    facade,
    "--to",
    shared,
    "--symbols",
    movable.join(","),
  ],
  { stdio: "inherit" },
);

for (const file of backImporters) {
  let text = readFileSync(file, "utf8");
  let changed = false;
  for (const match of [
    ...text.matchAll(/^(\s*)import\s+\{([^}]*)\}\s+from\s+"([^"]+)";$/gm),
  ]) {
    if (basename(match[3]) !== facadeJs) continue;
    const parts = match[2]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const moved = parts.filter((part) =>
      movable.includes(part.split(" as ")[0].trim()),
    );
    if (moved.length === 0) continue;
    const kept = parts.filter((part) => !moved.includes(part));
    let specifier = relative(dirname(file), shared.replace(/\.ts$/, ".js"))
      .split(sep)
      .join("/");
    if (!specifier.startsWith(".")) specifier = `./${specifier}`;
    const lines = [];
    if (kept.length > 0) {
      lines.push(`${match[1]}import { ${kept.join(", ")} } from "${match[3]}";`);
    }
    lines.push(`${match[1]}import { ${moved.join(", ")} } from "${specifier}";`);
    text = text.replace(match[0], lines.join("\n"));
    changed = true;
  }
  if (changed) {
    writeFileSync(file, text);
    console.log(`  repointed ${file}`);
  }
}
console.log(
  `break-cycles: relocated ${movable.length} declaration(s) out of ${facade}: ${movable.join(", ")}`,
);
