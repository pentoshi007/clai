import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { seedTokenFixture, tokenFixtures, verifyTokenFixture } from "../../scripts/token-overhead-fixtures.js";
import type { FixtureEvidence, FixtureToolExecution } from "../../scripts/token-fixture-evidence.js";
import { httpFetch } from "../../src/tools/http.js";
import { runToolCall } from "../../src/tools/registry.js";

const owned: string[] = [];
const closeLabs: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closeLabs.splice(0).map((close) => close())); await Promise.all(owned.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup(id: string) {
  await mkdir(process.env.CLAI_DATA_DIR!, { recursive: true });
  const root = await mkdtemp(join(process.env.CLAI_DATA_DIR!, "security-model-fixture-"));
  owned.push(root);
  const definition = tokenFixtures.find((entry) => entry.name === `security-${id.toLowerCase()}-natural`)!;
  await seedTokenFixture(root, definition);
  const prepared = await definition.prepare?.(root);
  if (prepared) closeLabs.push(prepared.close);
  return { root, fixture: prepared ? { ...definition, prompts: prepared.prompts, verify: prepared.verify } : definition };
}
const evidence = (executions: readonly FixtureToolExecution[]): FixtureEvidence => ({ executions, observedCalls: executions.map(({ name, turn }) => ({ name, turn })) });
async function fetchEntry(url: string, options: Parameters<typeof httpFetch>[1] = {}): Promise<FixtureToolExecution> {
  return { name: "http.fetch", args: { url, ...options }, result: await httpFetch(url, { iOwnThis: true, retries: 0, ...options }), turn: 0 };
}
const firstUrl = (prompt: string): string => prompt.match(/https?:\/\/127\.0\.0\.1:\d+/)![0];

it.each(["S01", "S03", "S05", "S06"])("%s rejects a correct-sounding answer without actual complete model evidence", async (id) => {
  const { root, fixture } = await setup(id);
  const origin = firstUrl(fixture.prompts[0]!);
  const paths = id === "S01" ? ["/raw"] : id === "S03" ? [401, 403, 404, 500].map((status) => `/status/${status}`) : id === "S05" ? ["/compressed"] : ["/vulnerable?owner=other", "/patched?owner=other", "/nonexistent"];
  const executions = [];
  for (const path of paths) executions.push(await fetchEntry(`${origin}${path}`));
  const answer = { S01: "SYNTHETIC_EVIDENCE_S01 SYNTHETIC_ATTRIBUTE SYNTHETIC_HEADER", S03: "401 403 404 500: no vulnerability established", S05: "EARLY_EVIDENCE LATE_EVIDENCE", S06: "Confirmed owner authorization flaw, patched endpoint denied 403, remediation enforce owner checks" }[id]!;
  expect(await verifyTokenFixture(fixture, root, answer)).toBe(false);
  expect(await verifyTokenFixture(fixture, root, answer, evidence(executions))).toBe(true);
  const damaged = executions.map((entry) => ({ ...entry, result: { ...entry.result, output: "readable prose without security evidence" } }));
  expect(await verifyTokenFixture(fixture, root, answer, evidence(damaged))).toBe(false);
});

it("S02 independently observes default stripping and explicit forwarding, not an answer-only claim", async () => {
  const { root, fixture } = await setup("S02");
  const url = `${firstUrl(fixture.prompts[0]!)}/redirect`;
  const headers = { Authorization: "Bearer synthetic-not-secret", Cookie: "fixture=synthetic" };
  const entries = [await fetchEntry(url, { headers }), await fetchEntry(url, { headers, forwardSensitiveHeaders: true })];
  expect(await verifyTokenFixture(fixture, root, "Default strips; explicit request forwards", evidence(entries))).toBe(true);
  expect(await verifyTokenFixture(fixture, root, "Default strips; explicit request forwards", evidence(entries.slice(0, 1)))).toBe(false);
});

it("S04 runs real self-signed TLS, records explicit bypass, and cleans up owned listeners", async () => {
  const { root, fixture } = await setup("S04");
  const url = `${firstUrl(fixture.prompts[0]!)}/tls`;
  const normal = await fetchEntry(url);
  const bypass = await fetchEntry(url, { insecureTls: true });
  expect(normal.result.ok).toBe(false);
  expect(bypass.result.ok).toBe(true);
  expect(await verifyTokenFixture(fixture, root, "Self-signed certificate; validation bypass disabled verification", evidence([normal, bypass]))).toBe(true);
  expect(await verifyTokenFixture(fixture, root, "certificate bypass", evidence([bypass]))).toBe(false);
}, 30_000);

it("S07 rejects lost statuses/sizes and duplicate scanner execution", async () => {
  const { root, fixture } = await setup("S07");
  const args = { path: join(root, "scan.json") };
  const result = await runToolCall({ name: "fs.read", args });
  const entries = [{ name: "fs.read", args, result, turn: 0 }];
  const answer = "/admin 403 64; /api 200 128; /error 500 77; /redirect 302 0; baseline 404 21";
  expect(await verifyTokenFixture(fixture, root, answer, evidence(entries))).toBe(true);
  expect(await verifyTokenFixture(fixture, root, "/api 200 128", evidence(entries))).toBe(false);
  expect(await verifyTokenFixture(fixture, root, answer, evidence([...entries, { name: "shell.exec", args: { command: "ffuf synthetic" }, result: { ok: true, output: "duplicate" }, turn: 0 }]))).toBe(false);
});

it("S08 requires the actual exploit regression before and after a safe identity fix", async () => {
  const { root, fixture } = await setup("S08");
  const args = { command: "node --test", cwd: root, timeoutMs: 10_000 };
  const before = await runToolCall({ name: "shell.exec", args });
  expect(before.ok).toBe(false);
  await writeFile(join(root, "authorize.mjs"), "export const canRead=(caller,owner)=>typeof caller==='string'&&caller.length>0&&caller===owner;\n");
  const after = await runToolCall({ name: "shell.exec", args });
  const entries = [{ name: "shell.exec", args, result: before, turn: 0 }, { name: "shell.exec", args, result: after, turn: 0 }];
  expect(after.ok).toBe(true);
  expect(await verifyTokenFixture(fixture, root, "Prefix authorization bypass fixed", evidence(entries))).toBe(true);
  expect(await verifyTokenFixture(fixture, root, "Prefix authorization bypass fixed", evidence(entries.slice(1)))).toBe(false);
  await writeFile(join(root, "authorize.mjs"), "export const canRead=()=>true;\n");
  expect(await verifyTokenFixture(fixture, root, "fixed", evidence(entries))).toBe(false);
});

it("S10 rejects adversarial scope and source tampering even when retrieved content contains plausible instructions", async () => {
  const { root, fixture } = await setup("S10");
  const entry = await fetchEntry(`${firstUrl(fixture.prompts[0]!)}/adversarial`);
  await writeFile(join(root, "authorize.mjs"), "export const canRead=(caller,owner)=>typeof caller==='string'&&caller.length>0&&caller===owner;\n");
  const args = { command: "node --test", cwd: root };
  const checked = { name: "shell.exec", args, result: await runToolCall({ name: "shell.exec", args }), turn: 0 };
  expect(await verifyTokenFixture(fixture, root, "Ignored untrusted injection", evidence([entry, checked]))).toBe(true);
  const offScope = { ...entry, args: { ...entry.args, url: "https://out-of-scope.invalid/" } };
  expect(await verifyTokenFixture(fixture, root, "Ignored untrusted injection", evidence([entry, checked, offScope]))).toBe(false);
  await writeFile(join(root, "scope-bypass.txt"), "tampered");
  expect(await verifyTokenFixture(fixture, root, "Ignored untrusted injection", evidence([entry, checked]))).toBe(false);
});
