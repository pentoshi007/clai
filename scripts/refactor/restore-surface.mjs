/**
 * Restores a module's public surface after mechanical moves.
 *
 * Moving a declaration out of a module can require widening a helper that stayed
 * behind, which would add a new public export to a frozen module. This relocates
 * every export that the module did not have at a reference revision into a shared
 * internal module, and repoints the importers that were reading it from the
 * facade.
 *
 *   node scripts/refactor/restore-surface.mjs --file src/tools/shell.ts \
 *     --internals src/tools/shell/internals.ts [--rev HEAD]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const file = flag("file");
const internals = flag("internals");
const rev = flag("rev") ?? "HEAD";
if (!file || !internals) {
  console.error(
    "usage: restore-surface.mjs --file <f> --internals <f> [--rev <rev>]",
  );
  process.exit(2);
}

const exportedNames = (text) => {
  const names = new Set();
  const pattern =
    /^export\s+(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\s+(\w+)/gm;
  for (const match of text.matchAll(pattern)) names.add(match[1]);
  return names;
};

const before = exportedNames(
  execFileSync("git", ["show", `${rev}:${file}`], { encoding: "utf8" }),
);
const current = readFileSync(file, "utf8");
const added = [...exportedNames(current)].filter((name) => !before.has(name));
if (added.length === 0) {
  console.log(`restore-surface: ${file} surface already matches ${rev}`);
  process.exit(0);
}

let text = current;
for (const name of added) {
  text = text.replace(
    new RegExp(
      `^export\\s+((?:async\\s+)?(?:function|const|let|var|class|type|interface|enum)\\s+${name}\\b)`,
      "m",
    ),
    "$1",
  );
}
writeFileSync(file, text);

execFileSync(
  "node",
  [
    "scripts/refactor/move-symbols.mjs",
    "move",
    "--from",
    file,
    "--to",
    internals,
    "--symbols",
    added.join(","),
  ],
  { stdio: "inherit" },
);

const facadeSpecifiers = new Set([
  `./${file.split("/").pop().replace(/\.ts$/, ".js")}`,
  `../${file.split("/").pop().replace(/\.ts$/, ".js")}`,
]);
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!full.endsWith(".ts") && !full.endsWith(".tsx")) continue;
    if (full === file || full === internals) continue;
    let source = readFileSync(full, "utf8");
    let changed = false;
    for (const match of [
      ...source.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)";$/gm),
    ]) {
      if (!facadeSpecifiers.has(match[3])) continue;
      const names = match[2].split(",").map((part) => part.trim()).filter(Boolean);
      const moved = names.filter((name) =>
        added.includes(name.split(" as ")[0].trim()),
      );
      if (moved.length === 0) continue;
      const kept = names.filter((name) => !moved.includes(name));
      let specifier = relative(
        dirname(full),
        internals.replace(/\.ts$/, ".js"),
      )
        .split(sep)
        .join("/");
      if (!specifier.startsWith(".")) specifier = `./${specifier}`;
      const lines = [];
      if (kept.length > 0) {
        lines.push(
          `import ${match[1] ?? ""}{ ${kept.join(", ")} } from "${match[3]}";`,
        );
      }
      lines.push(
        `import ${match[1] ?? ""}{ ${moved.join(", ")} } from "${specifier}";`,
      );
      source = source.replace(match[0], lines.join("\n"));
      changed = true;
    }
    if (changed) {
      writeFileSync(full, source);
      console.log(`repointed ${full}`);
    }
  }
};
walk("src");

console.log(
  `restore-surface: moved ${added.length} widened export(s) out of ${file}: ${added.join(", ")}`,
);
