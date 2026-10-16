import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenFixtures } from "./token-overhead-fixtures.js";
import { counterbalancedVariants, parseEvaluationConfig } from "./token-evaluation-config.js";
import { runEvaluationTrial } from "./token-evaluation-trial.js";
import { evaluationEnvironment, resolveEvaluationCredential } from "./token-evaluation-environment.js";
import { assertEvaluationSnapshot, evaluationSnapshot } from "./token-evaluation-provenance.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
interface TrialReceipt { readonly passed: boolean; readonly error: boolean; readonly admissions: number }
function parseReceipt(output: string): TrialReceipt {
  const raw: unknown = JSON.parse(output.trim().split("\n").at(-1) ?? "null");
  if (!raw || typeof raw !== "object" || !("passed" in raw) || !("error" in raw) || !("admissions" in raw) ||
    typeof raw.passed !== "boolean" || typeof raw.error !== "boolean" || typeof raw.admissions !== "number" || !Number.isInteger(raw.admissions) || raw.admissions < 0) {
    throw new Error("Invalid isolated trial receipt");
  }
  return { passed: raw.passed, error: raw.error, admissions: raw.admissions };
}
async function comparison(): Promise<void> {
  const [mode, configFile, baselinePath] = process.argv.slice(2);
  if ((mode !== "--dry-run" && mode !== "--run" && mode !== "--baseline") || !configFile || !baselinePath) {
    throw new Error("Usage: node --import tsx scripts/evaluate-token-overhead.ts <--dry-run|--run|--baseline> <nonsecret-config.json> <baseline-checkout>");
  }
  const raw: unknown = JSON.parse(await readFile(configFile, "utf8"));
  const config = parseEvaluationConfig(raw, tokenFixtures.map((fixture) => fixture.name));
  const baseline = resolve(baselinePath);
  if (!relative(sourceRoot, config.scratchRoot).startsWith("..")) throw new Error("Evaluation scratch must be outside the source checkout");
  for (const root of [sourceRoot, baseline]) await readFile(join(root, "src", "agent", "runner.ts"), "utf8");
  const trials = config.routes.length * config.fixtures.length * config.repeats * (mode === "--baseline" ? 1 : 2);
  if (mode === "--dry-run") {
    console.log(JSON.stringify({ status: "dry-run", trials, maxGenerationCalls: config.maxCalls, routes: config.routes, fixtures: config.fixtures,
      credentialAccess: false, providerRequests: 0, cacheEvidence: "unmeasured", releaseEligible: false }));
    return;
  }
  const snapshots = new Map(await Promise.all([...new Set([sourceRoot, baseline])].map(async (root) => [root, await evaluationSnapshot(root)] as const)));
  const verifySnapshots = async (): Promise<void> => {
    for (const [root, expected] of snapshots) assertEvaluationSnapshot(expected, await evaluationSnapshot(root));
  };
  const credentials = await Promise.all(config.routes.map(resolveEvaluationCredential));
  await mkdir(config.scratchRoot, { recursive: true });
  const reportRoot = await mkdtemp(join(config.scratchRoot, "token-evaluation-"));
  const pinnedConfig = join(reportRoot, "configuration.json");
  await writeFile(pinnedConfig, `${JSON.stringify(config)}\n`);
  const results: Array<TrialReceipt & { fixture: string; variant: string; repeat: number; routeIndex: number; report: string }> = [];
  let spent = 0;
  for (let routeIndex = 0; routeIndex < config.routes.length; routeIndex += 1) {
    for (let repeat = 1; repeat <= config.repeats; repeat += 1) {
      for (const fixture of config.fixtures) {
        const variants = mode === "--baseline" ? ["before"] as const : counterbalancedVariants(repeat);
        for (const variant of variants) {
          await verifySnapshots();
          const remaining = config.maxCalls - spent;
          if (remaining <= 0) throw new Error(`Generation budget exhausted; partial redacted reports retained at ${reportRoot}`);
          const workRoot = join(reportRoot, `trial-${String(results.length + 1).padStart(6, "0")}`);
          await Promise.all([workRoot, join(workRoot, ".evaluation", "home"), join(workRoot, ".evaluation", "tmp")].map((path) => mkdir(path, { recursive: true })));
          const env = evaluationEnvironment(config.routes[routeIndex]!, workRoot, process.env, credentials[routeIndex]);
          const output = await new Promise<string>((resolveOutput, reject) => {
            const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--trial",
              variant === "before" ? baseline : sourceRoot, workRoot, variant, fixture, String(repeat), pinnedConfig, String(routeIndex), String(remaining)],
            { cwd: sourceRoot, env, stdio: ["ignore", "pipe", "pipe"] });
            let stdout = "";
            child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 1_000_000) stdout += chunk.toString(); });
            child.stderr.on("data", () => {});
            child.on("error", reject);
            child.on("exit", (code) => code === 0 ? resolveOutput(stdout) : reject(new Error(`Trial exited ${code}; raw stderr is intentionally not persisted`)));
          });
          await verifySnapshots();
          const receipt = parseReceipt(output);
          spent += receipt.admissions;
          const record = { ...receipt, fixture, variant, repeat, routeIndex, report: relative(reportRoot, join(workRoot, ".evaluation", "report.json")) };
          results.push(record);
          await writeFile(join(reportRoot, "results.json"), `${JSON.stringify({ status: "evaluation-only", releaseEligible: false, snapshots: Object.fromEntries(snapshots), spent, maxCalls: config.maxCalls, results })}\n`);
          console.log(JSON.stringify(record));
          if (receipt.error || !receipt.passed) throw new Error(`Trial failed its outcome gate; candidate evaluation stopped. Reports: ${reportRoot}`);
        }
      }
    }
  }
  console.log(JSON.stringify({ status: "collected-not-release-approved", reportRoot, spent, trials: results.length, releaseEligible: false,
    pendingGates: ["route-specific warm cache/eligibility baseline", "complete scenario coverage", "paired uncertainty and holdout analysis"] }));
}

if (process.argv[2] === "--trial") await runEvaluationTrial(process.argv.slice(3));
else await comparison();
