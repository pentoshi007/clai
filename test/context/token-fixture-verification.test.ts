import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { tokenFixtures, seedTokenFixture, verifyTokenFixture } from "../../scripts/token-overhead-fixtures.js";
import type { FixtureEvidence } from "../../scripts/token-fixture-evidence.js";

const roots: string[] = [];
async function fixtureRoot(name: string) {
  const parent = process.env.CLAI_DATA_DIR ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "token-verifier-"));
  roots.push(root);
  const fixture = tokenFixtures.find((entry) => entry.name === name)!;
  await seedTokenFixture(root, fixture);
  return { root, fixture };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("independent token-fixture outcomes", () => {
  it("rejects a background answer without process and wait evidence", async () => {
    const { root, fixture } = await fixtureRoot("background-wait");
    expect(await fixture.verify(root, "READY_CHECK: 42")).toBe(false);
    expect(await verifyTokenFixture(fixture, root, "READY_CHECK: 42")).toBe(false);
  });

  it("rejects passing visible tests when hidden quantity and fractional cases fail", async () => {
    const { root, fixture } = await fixtureRoot("search-edit");
    await writeFile(join(root, "price.mjs"), "export const subtotal = items => items.length ? 19 : 0;\n");
    expect(await verifyTokenFixture(fixture, root, "verified")).toBe(false);
    await writeFile(join(root, "price.mjs"), "export const subtotal = items => items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n");
    expect(await verifyTokenFixture(fixture, root, "verified")).toBe(true);
    await writeFile(join(root, "price.test.mjs"), "");
    expect(await verifyTokenFixture(fixture, root, "verified")).toBe(false);
  });

  it("rejects immutable fixture deletion, modified package scripts and missing files", async () => {
    const { root, fixture } = await fixtureRoot("independent-reads");
    const answer = "alpha port 4123 enabled true; beta port 5124 enabled false";
    const evidence: FixtureEvidence = { observedCalls: [{ name: "fs.read", turn: 0 }], executions: [{ name: "fs.read", args: { files: [{ path: "alpha.json" }, { path: "beta.json" }] }, result: { ok: true, output: "alpha 4123 true; beta 5124 false" }, turn: 0 }] };
    expect(await verifyTokenFixture(fixture, root, answer)).toBe(false);
    expect(await verifyTokenFixture(fixture, root, answer, evidence)).toBe(true);
    const original = await readFile(join(root, "package.json"), "utf8");
    await writeFile(join(root, "package.json"), '{}\n');
    expect(await verifyTokenFixture(fixture, root, answer, evidence)).toBe(false);
    await writeFile(join(root, "package.json"), original);
    await rm(join(root, "alpha.json"));
    expect(await verifyTokenFixture(fixture, root, answer, evidence)).toBe(false);
  });

  it("rejects mutation or plan side effects during a question following a build", async () => {
    const { root, fixture } = await fixtureRoot("question-after-build");
    await writeFile(join(root, "price.mjs"), "export const subtotal = items => items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n");
    const priorEdit: FixtureEvidence = { observedCalls: [{ name: "fs.edit", turn: 0 }], executions: [] };
    expect(await verifyTokenFixture(fixture, root, "An empty sum starts at zero.", priorEdit)).toBe(true);
    for (const name of ["fs.edit", "plan.create", "task.add", "terminal.start"]) {
      expect(await verifyTokenFixture(fixture, root, "explanation", { ...priorEdit, observedCalls: [...priorEdit.observedCalls, { name, turn: 1 }] })).toBe(false);
    }
    const writeAfterRead: FixtureEvidence = { observedCalls: [{ name: "shell.exec", turn: 1 }], executions: [
      { name: "shell.exec", turn: 1, args: { command: "cat price.mjs" }, result: { ok: true, output: "current implementation" } },
      { name: "shell.exec", turn: 1, args: { command: "npm install synthetic" }, result: { ok: true, output: "changed" } },
    ] };
    expect(await verifyTokenFixture(fixture, root, "explanation", writeAfterRead)).toBe(false);
  });

  it("verifies actual pollable process execution and a terminal wait with the production tools", async () => {
    const { root, fixture } = await fixtureRoot("background-wait");
    const { toolRegistry } = await import("../../src/tools/registry.js");
    const { jobManager } = await import("../../src/tools/jobs.js");
    const args = { command: "node check.mjs", cwd: root, background: "always", name: "fixture-check", responder: false };
    const started = await toolRegistry["shell.exec"]!(args, { sessionId: "verifier-real-job" });
    const id = started.backgroundJob?.id;
    expect(id).toBeTruthy();
    try {
      const waited = await toolRegistry["shell.wait"]!({ id: id!, timeoutMs: 10_000 }, { sessionId: "verifier-real-job" });
      const job = jobManager.getJob(id!)!;
      const evidence: FixtureEvidence = {
        observedCalls: [{ name: "shell.exec", turn: 0 }, { name: "shell.wait", turn: 0 }],
        executions: [
          { name: "shell.exec", args, result: started, turn: 0 },
          { name: "shell.wait", args: { id: id! }, result: waited, turn: 0,
            job: { id: job.id, status: job.status, artifactPath: job.artifactPath ?? "", exitCode: job.exitCode } },
        ],
      };
      expect(waited.output).toMatch(/READY_CHECK:\s*42/);
      expect(await verifyTokenFixture(fixture, root, "READY_CHECK: 42", evidence)).toBe(true);
    } finally {
      if (id && jobManager.getJob(id)?.status === "running") await jobManager.stopJob(id);
    }
  });

  it("requires a successful matching terminal receipt, not a launch or wait on another job", async () => {
    const { root, fixture } = await fixtureRoot("background-wait");
    const evidence: FixtureEvidence = {
      observedCalls: [{ name: "shell.exec", turn: 0 }, { name: "shell.wait", turn: 0 }],
      executions: [
        { name: "shell.exec", turn: 0, args: { command: "node check.mjs", background: "always", responder: false }, result: { ok: true, output: "started", backgroundJob: { id: "owned-job", status: "running", artifactPath: "/synthetic/job.log" } } },
        { name: "shell.wait", turn: 0, args: { id: "owned-job" }, result: { ok: true, output: "READY_CHECK: 42", exitCode: 0 }, job: { id: "owned-job", status: "exited", exitCode: 0, artifactPath: "/synthetic/job.log" } },
      ],
    };
    expect(await verifyTokenFixture(fixture, root, "READY_CHECK: 42", evidence)).toBe(true);
    const wrongWait = structuredClone(evidence);
    const mismatched: FixtureEvidence = { ...wrongWait, executions: [wrongWait.executions[0]!, { ...wrongWait.executions[1]!, args: { id: "another-job" } }] };
    expect(await verifyTokenFixture(fixture, root, "READY_CHECK: 42", mismatched)).toBe(false);
    expect(await verifyTokenFixture(fixture, root, "READY_CHECK: 42", { ...evidence, executions: evidence.executions.slice(0, 1) })).toBe(false);
  });
});
