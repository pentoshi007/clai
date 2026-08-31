/**
 * Public contract inventory generator (Phase 0, P0-03).
 *
 * Emits a deterministic, sorted description of the exported surface of every
 * Phase 1-6 hotspot: exported names, their kind, and their resolved type text.
 * `test/contracts/public-contracts.test.ts` compares the live inventory with
 * the committed baseline so an accidental signature or export change fails with
 * a readable diff instead of surfacing later as a runtime behavior break.
 *
 * The type checker (not a text snapshot) is the source of truth, so pure code
 * movement inside a module does not create noise while an actual contract
 * change does.
 *
 * Usage:
 *   node scripts/quality/contract-inventory.mjs            # print JSON
 *   node scripts/quality/contract-inventory.mjs --write    # update baseline
 *   node scripts/quality/contract-inventory.mjs --check    # exit 1 on drift
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const BASELINE_PATH = join(
  ROOT,
  "refactor",
  "evidence",
  "phase-0",
  "public-contracts.json",
);

/** Schema version for the emitted inventory. Bump only with a reviewed change. */
export const INVENTORY_SCHEMA_VERSION = 1;

/**
 * Phase 1-6 hotspots. Every entry is either an oversized legacy file frozen in
 * `test/architecture/legacy-baseline.json` or a facade whose exports the phase
 * plans promise to preserve.
 */
export const HOTSPOT_FILES = Object.freeze([
  // Phase 1 — agent orchestration
  "src/agent/runner.ts",
  "src/agent/tool-call-parser.ts",
  "src/agent/plan-tool.ts",
  "src/agent/task-evidence.ts",
  "src/agent/loop-guard.ts",
  // Phase 2 — LLM transport and routing
  "src/llm/http.ts",
  "src/llm/router.ts",
  // Phase 3 — tools, jobs, files, shell
  "src/tools/definitions.ts",
  "src/tools/registry.ts",
  "src/tools/jobs.ts",
  "src/tools/fs.ts",
  "src/tools/shell.ts",
  "src/tools/http.ts",
  // Phase 4 — persistence
  "src/store/history.ts",
  "src/store/plan.ts",
  // Phase 5 — web and interactive sessions
  "src/tools/web/fetch-core.ts",
  "src/interactive-session/manager.ts",
  // Phase 6 — UI core
  "src/ui-core/commands/picker-commands.ts",
  "src/ui-core/rendering/markdown.ts",
  "src/ui-core/rendering/syntax-highlight.ts",
]);

function symbolKind(symbol) {
  const flags = symbol.getFlags();
  if (flags & ts.SymbolFlags.Alias) return "alias";
  if (flags & ts.SymbolFlags.Class) return "class";
  if (flags & ts.SymbolFlags.Interface) return "interface";
  if (flags & ts.SymbolFlags.TypeAlias) return "type";
  if (flags & ts.SymbolFlags.Enum) return "enum";
  if (flags & ts.SymbolFlags.Function) return "function";
  if (flags & ts.SymbolFlags.Variable) return "variable";
  if (flags & ts.SymbolFlags.Property) return "property";
  return "other";
}

/**
 * Normalize checker output so the inventory is diff-friendly and does not
 * depend on the absolute checkout path or on incidental whitespace.
 */
function normalizeTypeText(text) {
  return text
    .split(ROOT)
    .join("<repo>")
    .replace(/\s+/g, " ")
    .trim();
}

/** @returns {{ schemaVersion: number, typescript: string, modules: Array }} */
export function buildInventory() {
  const configPath = join(ROOT, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    ROOT,
  );
  const program = ts.createProgram({
    rootNames: HOTSPOT_FILES.map((file) => join(ROOT, file)),
    options: { ...parsed.options, noEmit: true },
  });
  const checker = program.getTypeChecker();

  const modules = [];
  for (const file of HOTSPOT_FILES) {
    const source = program.getSourceFile(join(ROOT, file));
    if (!source) throw new Error(`contract-inventory: missing source file ${file}`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    const exports = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];

    const entries = exports
      .map((symbol) => {
        const declaration = symbol.declarations?.[0];
        const resolved =
          symbol.getFlags() & ts.SymbolFlags.Alias
            ? checker.getAliasedSymbol(symbol)
            : symbol;
        const declarationForType = resolved.declarations?.[0] ?? declaration;
        let typeText = "unresolved";
        if (declarationForType) {
          typeText = normalizeTypeText(
            checker.typeToString(
              checker.getTypeOfSymbolAtLocation(resolved, declarationForType),
              undefined,
              ts.TypeFormatFlags.NoTruncation |
                ts.TypeFormatFlags.UseFullyQualifiedType,
            ),
          );
        }
        return {
          name: symbol.getName(),
          // Classified from the resolved declaration so that a compatibility
          // re-export (the mandated migration technique) is not reported as a
          // contract change while a genuinely changed declaration kind still is.
          kind: symbolKind(resolved),
          type: typeText,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name, "en-US"));

    modules.push({ module: file, exportCount: entries.length, exports: entries });
  }

  modules.sort((left, right) => left.module.localeCompare(right.module, "en-US"));
  return {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    typescript: ts.version,
    modules,
  };
}

/** Produces a readable list of differences between two inventories. */
export function diffInventories(baseline, current) {
  const differences = [];
  const key = (module, name) => `${module}#${name}`;
  const flatten = (inventory) => {
    const map = new Map();
    for (const mod of inventory.modules) {
      for (const entry of mod.exports) {
        map.set(key(mod.module, entry.name), { ...entry, module: mod.module });
      }
    }
    return map;
  };
  const before = flatten(baseline);
  const after = flatten(current);

  for (const [id, entry] of before) {
    if (!after.has(id)) {
      differences.push(`removed export: ${id} (${entry.kind})`);
      continue;
    }
    const now = after.get(id);
    if (now.kind !== entry.kind) {
      differences.push(`changed kind: ${id}: ${entry.kind} -> ${now.kind}`);
    }
    if (now.type !== entry.type) {
      differences.push(
        `changed type: ${id}\n  baseline: ${entry.type}\n  current:  ${now.type}`,
      );
    }
  }
  for (const id of after.keys()) {
    if (!before.has(id)) differences.push(`added export: ${id}`);
  }
  return differences.sort();
}

export function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      // A missing inventory must fail loudly with a fix instruction. Crashing on
      // ENOENT (or, worse, regenerating silently) would leave the Phase 1 runner
      // hard gate unenforced on a fresh checkout.
      throw new Error(
        `contract-inventory: missing baseline ${BASELINE_PATH}. ` +
          "It must be committed. Create it deliberately with: " +
          "node scripts/quality/contract-inventory.mjs --write",
      );
    }
    throw error;
  }
}

function main() {
  const write = process.argv.includes("--write");
  const check = process.argv.includes("--check");
  const inventory = buildInventory();
  const serialized = `${JSON.stringify(inventory, null, 2)}\n`;

  if (write) {
    mkdirSync(dirname(BASELINE_PATH), { recursive: true });
    writeFileSync(BASELINE_PATH, serialized);
    process.stdout.write(
      `contract-inventory: wrote ${relative(ROOT, BASELINE_PATH)} (${inventory.modules.length} modules)\n`,
    );
    return;
  }

  if (check) {
    let baseline;
    try {
      baseline = readBaseline();
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
    const differences = diffInventories(baseline, inventory);
    if (differences.length > 0) {
      process.stderr.write(
        `contract-inventory: ${differences.length} contract difference(s)\n${differences.join("\n")}\n`,
      );
      process.exit(1);
    }
    process.stdout.write("contract-inventory: public contracts unchanged\n");
    return;
  }

  process.stdout.write(serialized);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) main();
