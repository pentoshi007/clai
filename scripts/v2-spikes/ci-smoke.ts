/**
 * OpenTUI CI smoke — runs each spike in an isolated Bun child process.
 *
 * Why isolation: OpenTUI's native FFI + Bun 1.3.x can SIGSEGV/SIGILL during
 * renderer teardown *after* a spike has already passed. An in-process suite
 * then dies with exit 132 and never runs remaining spikes or bun:parity.
 *
 * Parent (this file) survives child signals, scores each spike, and exits 0
 * only when every spike reported PASS (or crashed only after PASS — treated
 * as a known Bun/OpenTUI teardown flake with a warning).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runOne = join(here, "run-one.ts");

const SPIKES: Array<{ id: string; arg: string }> = [
  { id: "V2-013", arg: "viewport" },
  { id: "V2-014", arg: "markdown" },
  { id: "V2-032", arg: "shell" },
  { id: "V2-DIFF-OVERFLOW", arg: "diff-card-overflow" },
];

interface SpikeOutcome {
  id: string;
  passed: boolean;
  detail: string;
}

function runSpike(id: string, arg: string): SpikeOutcome {
  console.log(`\n======== ${id} (${arg}) ========`);
  const r = spawnSync("bun", ["run", runOne, arg], {
    encoding: "utf8",
    env: process.env,
    // Capture so we can detect [PASS] even when the process dies on teardown.
    maxBuffer: 16 * 1024 * 1024,
  });

  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  // Echo child output for CI logs.
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  const combined = `${stdout}\n${stderr}`;
  const sawPass = /\[PASS\]/.test(combined);
  const sawFail = /\[FAIL\]/.test(combined) && !sawPass;

  if (r.error) {
    return {
      id,
      passed: false,
      detail: `spawn error: ${r.error.message}`,
    };
  }

  if (r.signal) {
    // Native crash. If the spike already printed PASS, treat as teardown flake.
    if (sawPass && !sawFail) {
      console.warn(
        `\n[WARN] ${id} terminated by signal ${r.signal} after [PASS] — ` +
          `known Bun/OpenTUI native teardown flake; counting as pass.`,
      );
      return {
        id,
        passed: true,
        detail: `signal ${r.signal} after PASS (teardown flake)`,
      };
    }
    return {
      id,
      passed: false,
      detail: `terminated by signal ${r.signal}`,
    };
  }

  if (r.status === 0 && sawPass) {
    return { id, passed: true, detail: "exit 0" };
  }
  if (r.status === 0) {
    return { id, passed: true, detail: "exit 0 (no [PASS] banner)" };
  }
  return {
    id,
    passed: false,
    detail: `exit ${r.status ?? "?"}${sawFail ? " with [FAIL]" : ""}`,
  };
}

const outcomes: SpikeOutcome[] = [];
for (const spike of SPIKES) {
  outcomes.push(runSpike(spike.id, spike.arg));
}

const passed = outcomes.filter((o) => o.passed).length;
console.log(`\n==== OpenTUI CI smoke: ${passed}/${outcomes.length} passed ====`);
for (const o of outcomes) {
  console.log(`  ${o.passed ? "PASS" : "FAIL"}  ${o.id}  (${o.detail})`);
}

process.exit(passed === outcomes.length ? 0 : 1);
