/**
 * Registers modules that received code moved verbatim out of a frozen legacy
 * file. A pure move must not read as new debt, and it must not silently vanish
 * either: the moved findings are declared at their new path with their origin,
 * so `quality:changed` reports them as relocated and `quality:ratchet` keeps
 * holding them until the receiving module is decomposed.
 *
 *   node scripts/refactor/register-relocation.mjs --origin src/llm/http.ts \
 *     --files src/llm/wire/openai-stream.ts,src/llm/wire/stream-framing.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { measureFunctions } from "../quality/ast-metrics.mjs";
import { LIMITS, lineLimitFor } from "../quality/config.mjs";
import { countPhysicalLines } from "../quality/report.mjs";

const BASELINE = "refactor/evidence/phase-0/baselines/metrics-baseline.json";
const CONFIG = "scripts/quality/config.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const origin = flag("origin");
const files = (flag("files") ?? "").split(",").filter(Boolean);
if (!origin || files.length === 0) {
  console.error(
    "usage: register-relocation.mjs --origin <file> --files a.ts,b.ts",
  );
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
const add = (list, value) => {
  if (!list.includes(value)) list.push(value);
};

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (countPhysicalLines(text) >= lineLimitFor(file)) {
    add(baseline.filesOverLineLimit, file);
  }
  for (const unit of measureFunctions(sourceFile)) {
    const id = `${file}#${unit.name}@${unit.line}`;
    if (unit.cyclomatic >= LIMITS.cyclomatic) {
      add(baseline.functionsOverCyclomatic, id);
    }
    if (unit.cognitive >= LIMITS.cognitive) {
      add(baseline.functionsOverCognitive, id);
    }
    if (unit.halstead.difficulty >= LIMITS.halsteadDifficulty) {
      add(baseline.functionsOverHalstead, id);
    }
  }
}
baseline.filesOverLineLimit.sort();
baseline.functionsOverCyclomatic.sort();
baseline.functionsOverCognitive.sort();
baseline.functionsOverHalstead.sort();
writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);

let config = readFileSync(CONFIG, "utf8");
const marker = "export const RELOCATED_LEGACY_FILES = Object.freeze({";
const insertAt = config.indexOf(marker) + marker.length;
const additions = files
  .filter((file) => !config.includes(`"${file}"`))
  .map((file) => `\n  "${file}": "${origin}",`)
  .join("");
config = config.slice(0, insertAt) + additions + config.slice(insertAt);
writeFileSync(CONFIG, config);

console.log(
  `registered ${files.length} relocated module(s) from ${origin}; baseline and config updated`,
);
