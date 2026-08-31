/**
 * Deterministic test launcher for the refactor program (Phase 0, P0-01).
 *
 * Locale and timezone must be fixed *before* the test process starts, because
 * Node initializes ICU collation/number formatting and the default timezone at
 * startup. Setting `process.env.TZ` from inside the test process is therefore
 * not equivalent, and shell-only `LC_ALL=C ... npm test` syntax does not work
 * on Windows `cmd.exe`/PowerShell. This wrapper spawns Vitest as a child
 * process with the canonical environment applied to the child's env block, so
 * the same command is valid on Linux, macOS and Windows.
 *
 * Canonical environment (verified against the recorded baseline; see
 * refactor/baseline.md and refactor/evidence/phase-0/README.md):
 *   LC_ALL=C  LANG=C  LC_NUMERIC=C  LC_COLLATE=C  LC_TIME=C  TZ=UTC
 *
 * Usage:
 *   node scripts/run-tests.mjs [vitest args...]        # canonical environment
 *   node scripts/run-tests.mjs --host [vitest args...] # inherit host env
 *   node scripts/run-tests.mjs --print-env             # show the env, run nothing
 *
 * `--host` deliberately preserves a direct host-environment path so that
 * canonicalization cannot conceal accidental locale/timezone coupling.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The canonical, documented test environment. Keys are applied in this exact
 * order so the printed manifest is deterministic across platforms.
 */
export const CANONICAL_TEST_ENV = Object.freeze({
  LANG: "C",
  LC_ALL: "C",
  LC_COLLATE: "C",
  LC_NUMERIC: "C",
  LC_TIME: "C",
  TZ: "UTC",
});

/** Locale/timezone variables that must not leak in from the host. */
const LOCALE_ENV_KEYS = Object.freeze([
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "TZ",
]);

/**
 * Build the child environment for a run.
 *
 * @param {NodeJS.ProcessEnv} baseEnv host environment to derive from
 * @param {{ host?: boolean }} [options] when `host` is true the host locale is kept
 * @returns {NodeJS.ProcessEnv}
 */
export function buildTestEnv(baseEnv, options = {}) {
  const env = { ...baseEnv };
  if (options.host) return env;
  // Drop every inherited locale key first: a stale LANGUAGE or LC_CTYPE can
  // otherwise still influence ICU even when LC_ALL is set.
  for (const key of LOCALE_ENV_KEYS) delete env[key];
  for (const [key, value] of Object.entries(CANONICAL_TEST_ENV)) env[key] = value;
  return env;
}

/**
 * Split wrapper flags from arguments forwarded to Vitest.
 *
 * @param {readonly string[]} argv
 * @returns {{ host: boolean, printEnv: boolean, forwarded: string[] }}
 */
export function parseArgs(argv) {
  let host = false;
  let printEnv = false;
  const forwarded = [];
  for (const arg of argv) {
    if (arg === "--host") {
      host = true;
      continue;
    }
    if (arg === "--print-env") {
      printEnv = true;
      continue;
    }
    forwarded.push(arg);
  }
  return { host, printEnv, forwarded };
}

/**
 * Human-readable, stable description of the applied environment.
 *
 * @param {{ host: boolean }} options
 * @returns {string}
 */
export function describeEnv(options) {
  if (options.host) return "host environment (locale and timezone inherited)";
  return Object.entries(CANONICAL_TEST_ENV)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

/** @returns {never | void} */
function main() {
  const { host, printEnv, forwarded } = parseArgs(process.argv.slice(2));
  const env = buildTestEnv(process.env, { host });

  if (printEnv) {
    process.stdout.write(`${describeEnv({ host })}\n`);
    return;
  }

  process.stderr.write(`clai tests: ${describeEnv({ host })}\n`);

  const child = spawn(
    process.execPath,
    [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", ...forwarded],
    { cwd: ROOT, env, stdio: "inherit" },
  );

  child.on("error", (error) => {
    process.stderr.write(`clai tests: failed to start vitest: ${String(error)}\n`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      // Reproduce the conventional 128+signal status so CI reports the abort
      // faithfully instead of masking it as a generic failure.
      process.exit(128 + (typeof signal === "number" ? signal : 0) || 1);
    }
    process.exit(code ?? 1);
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) main();
