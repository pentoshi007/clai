/**
 * Resolves import cycles by moving the back-imported declarations down into the
 * module that needs them, so dependencies point one way.
 *
 * A cycle here always has the shape `facade -> child -> facade`: the child holds
 * relocated code that still calls a helper left in the facade. Moving that helper
 * into the child removes the edge without changing any behavior, and the facade
 * keeps re-exporting it for outside callers.
 *
 *   node scripts/refactor/fix-cycles.mjs [--limit 5] [--dry]
 */
import { execFileSync } from "node:child_process";
import {
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const limit = Number(flag("limit") ?? "100");
const scope = flag("scope") ?? "src";
const dry = args.includes("--dry");

const sources = () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(full)) files.push(full);
    }
  };
  walk("src");
  return files;
};

const resolveSpecifier = (from, specifier) => {
  const base = resolve(dirname(from), specifier).replace(/\.js$/, "");
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (existsSync(candidate)) return candidate.replace(`${process.cwd()}/`, "");
  }
  return undefined;
};

/** Value imports only: a type-only edge cannot create a load-order problem. */
const valueImports = (file) => {
  const text = readFileSync(file, "utf8");
  const edges = new Map();
  for (const match of text.matchAll(
    /^\s*import\s+(type\s+)?(?:\{([^}]*)\}|(\w+))\s+from\s+"(\.[^"]+)";$/gm,
  )) {
    if (match[1]) continue;
    const names = match[2]
      ? match[2]
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part && !part.startsWith("type "))
          .map((part) => part.split(" as ")[0].trim())
      : [match[3]];
    if (names.length === 0) continue;
    const target = resolveSpecifier(file, match[4]);
    if (!target) continue;
    edges.set(target, [...(edges.get(target) ?? []), ...names]);
  }
  return edges;
};

const declaredExports = (file) => {
  const names = new Set();
  for (const match of readFileSync(file, "utf8").matchAll(
    /^export\s+(?:async\s+)?(?:function|const|let|var|class|enum)\s+(\w+)/gm,
  )) {
    names.add(match[1]);
  }
  return names;
};

let fixed = 0;
for (let round = 0; round < limit; round += 1) {
  const files = sources();
  const graph = new Map(files.map((file) => [file, valueImports(file)]));
  let target;
  for (const [file, edges] of graph) {
    if (!file.startsWith(scope)) continue;
    for (const child of edges.keys()) {
      if (!child.startsWith(scope)) continue;
      const back = graph.get(child);
      if (!back || !back.has(file)) continue;
      const names = [...new Set(back.get(file))].filter((name) =>
        declaredExports(file).has(name),
      );
      if (names.length === 0) continue;
      target = { facade: file, child, names };
      break;
    }
    if (target) break;
  }
  if (!target) {
    console.log(`fix-cycles: no resolvable facade cycles left (${fixed} fixed)`);
    break;
  }
  console.log(
    `cycle ${target.facade} <-> ${target.child}: pulling ${target.names.join(", ")}`,
  );
  if (dry) break;
  execFileSync(
    "node",
    [
      "scripts/refactor/move-symbols.mjs",
      "move",
      "--from",
      target.facade,
      "--to",
      target.child,
      "--symbols",
      target.names.join(","),
      "--append",
    ],
    { stdio: "inherit" },
  );
  // The child now declares these names itself, so its import of them from the
  // facade must go or TypeScript sees a merged declaration.
  {
    const childText = readFileSync(target.child, "utf8");
    let updated = childText;
    for (const match of childText.matchAll(
      /^\s*import\s+\{([^}]*)\}\s+from\s+"([^"]+)";$/gm,
    )) {
      const resolved = resolveSpecifier(target.child, match[2]);
      if (resolved !== target.facade) continue;
      const kept = match[1]
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .filter((part) => !target.names.includes(part.split(" as ")[0].trim()));
      updated = updated.replace(
        match[0],
        kept.length > 0
          ? `import { ${kept.join(", ")} } from "${match[2]}";`
          : "",
      );
    }
    if (updated !== childText) writeFileSync(target.child, updated);
  }
  fixed += 1;
}
