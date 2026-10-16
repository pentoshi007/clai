import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { seedTokenFixture, tokenFixtures, verifyTokenFixture } from "../../scripts/token-overhead-fixtures.js";
import { runIndependentAssertions, type FixtureEvidence } from "../../scripts/token-fixture-evidence.js";
import { runToolCall } from "../../src/tools/registry.js";

const owned: string[] = [];
afterEach(async () => { await Promise.all(owned.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function setup(name: string) {
  await mkdir(process.env.CLAI_DATA_DIR!, { recursive: true });
  const root = await mkdtemp(join(process.env.CLAI_DATA_DIR!, "coding-fixture-"));
  owned.push(root);
  const fixture = tokenFixtures.find((entry) => entry.name === name)!;
  await seedTokenFixture(root, fixture);
  return { root, fixture };
}
const evidence: FixtureEvidence = { executions: [{ name: "shell.exec", args: { command: "node --test" }, result: { ok: true, output: "synthetic verification receipt" }, turn: 0 }], observedCalls: [{ name: "shell.exec", turn: 0 }] };

it("rejects incomplete persistence and accepts independent reload/invalid/IO boundaries without weakening tests", async () => {
  const { root, fixture } = await setup("persistent-feature-natural");
  expect(await verifyTokenFixture(fixture, root, "done", evidence)).toBe(false);
  await writeFile(join(root, "notes.mjs"), "import {readFile,writeFile} from 'node:fs/promises'; const validate=notes=>{if(!Array.isArray(notes)||notes.some(n=>typeof n!=='string'||!n.length))throw new TypeError('Invalid notes');return notes;}; export async function loadNotes(path){try{return validate(JSON.parse(await readFile(path,'utf8')));}catch(error){if(error.code==='ENOENT')return [];throw error;}} export async function saveNotes(path,notes){validate(notes);await writeFile(path,JSON.stringify(notes));}\n");
  expect(await verifyTokenFixture(fixture, root, "done", evidence)).toBe(true);
  const npmEvidence: FixtureEvidence = { ...evidence, executions: evidence.executions.map((entry) => ({ ...entry, args: { command: "npm test" } })) };
  expect(await verifyTokenFixture(fixture, root, "done", npmEvidence)).toBe(true);
  expect(await verifyTokenFixture(fixture, root, "done", { ...evidence, executions: [] })).toBe(false);
  await writeFile(join(root, "notes.test.mjs"), "");
  expect(await verifyTokenFixture(fixture, root, "done", evidence)).toBe(false);
});

it("keeps successful per-file evidence when one known file is missing and rejects missing or repeated evidence", async () => {
  const { root, fixture } = await setup("partial-read-natural");
  const args = { files: ["alpha.json", "missing.json", "beta.json"].map((name) => ({ path: join(root, name) })) };
  const result = await runToolCall({ name: "fs.read", args });
  const observed: FixtureEvidence = { executions: [{ name: "fs.read", args, result, turn: 0 }], observedCalls: [{ name: "fs.read", turn: 0 }] };
  const answer = "alpha 4123; beta 5124; missing.json is missing";
  expect(result.output).toContain("4123");
  expect(result.output).toContain("5124");
  expect(await verifyTokenFixture(fixture, root, answer, observed)).toBe(true);
  expect(await verifyTokenFixture(fixture, root, answer)).toBe(false);
  expect(await verifyTokenFixture(fixture, root, answer, { ...observed, executions: [...observed.executions, ...observed.executions] })).toBe(false);
});

it("checks an intermediate phase boundary separately from final whole-roadmap completion", async () => {
  const { root, fixture } = await setup("roadmap-continuation-natural");
  expect(runIndependentAssertions(root, fixture.turnAssertions![0]!)).toBe(false);
  await writeFile(join(root, "first.mjs"), "export const first=n=>n*2;\n");
  expect(runIndependentAssertions(root, fixture.turnAssertions![0]!)).toBe(true);
  expect(await verifyTokenFixture(fixture, root, "all done", evidence)).toBe(false);
  await writeFile(join(root, "second.mjs"), "export const second=n=>n+3;\n");
  await writeFile(join(root, "combined.mjs"), "import {first} from './first.mjs'; import {second} from './second.mjs'; export const combined=n=>second(first(n));\n");
  expect(await verifyTokenFixture(fixture, root, "verified", evidence)).toBe(true);
  expect(runIndependentAssertions(root, fixture.turnAssertions![0]!)).toBe(false);
});

it("rejects Unicode/CRLF corruption and a claimed edit without fresh source evidence", async () => {
  const { root, fixture } = await setup("unicode-stale-edit-natural");
  const readEvidence: FixtureEvidence = { observedCalls: [{ name: "fs.read", turn: 0 }], executions: [{ name: "fs.read", args: { path: "settings.mjs" }, result: { ok: true, output: fixture.files["settings.mjs"]! }, turn: 0 }] };
  await writeFile(join(root, "settings.mjs"), "export const label = '界🙂';\r\nexport const attempts = 3;\r\n");
  expect(await verifyTokenFixture(fixture, root, "verified", readEvidence)).toBe(true);
  expect(await verifyTokenFixture(fixture, root, "verified")).toBe(false);
  await writeFile(join(root, "settings.mjs"), "export const label = '界🙂';\nexport const attempts = 3;\n");
  expect(await verifyTokenFixture(fixture, root, "verified", readEvidence)).toBe(false);
});
