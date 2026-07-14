// Phase 1 spike harness (V2-011..V2-014).
//
// These spikes run ONLY under Bun, which is where OpenTUI's native FFI renderer
// loads (see docs/v2/adr-007-bun-runtime.md). They are intentionally kept out
// of the Node vitest suite. Per ROADMAP V2-016 this is disposable spike code:
// it is promoted behind proper interfaces or deleted once ADRs are written.
//
// Run: bun run scripts/v2-spikes/run-all.ts

export interface SpikeResult {
  id: string;
  title: string;
  passed: boolean;
  checks: Array<{ label: string; ok: boolean; detail?: string }>;
  measurements: Record<string, number | string>;
  notes: string[];
}

export function makeResult(id: string, title: string): SpikeResult {
  return { id, title, passed: true, checks: [], measurements: {}, notes: [] };
}

export function check(
  result: SpikeResult,
  label: string,
  ok: boolean,
  detail?: string,
): void {
  result.checks.push(detail === undefined ? { label, ok } : { label, ok, detail });
  if (!ok) result.passed = false;
}

export function measure(
  result: SpikeResult,
  key: string,
  value: number | string,
): void {
  result.measurements[key] = value;
}

export function note(result: SpikeResult, text: string): void {
  result.notes.push(text);
}

export function printResult(result: SpikeResult): void {
  const status = result.passed ? "PASS" : "FAIL";
  console.log(`\n[${status}] ${result.id} — ${result.title}`);
  for (const c of result.checks) {
    const mark = c.ok ? "ok  " : "FAIL";
    console.log(`   ${mark} ${c.label}${c.detail ? `  (${c.detail})` : ""}`);
  }
  const keys = Object.keys(result.measurements);
  if (keys.length > 0) {
    console.log("   measurements:");
    for (const k of keys) console.log(`     - ${k}: ${result.measurements[k]}`);
  }
  for (const n of result.notes) console.log(`   note: ${n}`);
}
