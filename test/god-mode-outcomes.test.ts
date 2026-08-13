import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createEvidence,
  createOutcome,
  deriveOutcomeStatus,
  linkEvidence,
  loadOutcomeState,
  openOutcomeState,
  recordAnswerEvidence,
  recordFailedHypothesis,
  recordToolEvidence,
  reviseOutcome,
  saveOutcomeState,
  validateCriterionEvidence,
} from "../src/agent/outcomes.js";

describe("durable outcome and evidence invariants", () => {
  it("does not let irrelevant or cross-criterion evidence prove work", () => {
    const outcome = createOutcome({ sessionId: "s", userIntent: "ship feature", kind: "build", criteria: [
      { id: "implemented", statement: "feature implemented", required: true, domain: "feature" },
      { id: "checked", statement: "behavior checked", required: true, domain: "feature" },
    ] });
    const read = createEvidence({ outcomeId: outcome.id, outcomeRevision: outcome.revision, criterionIds: ["checked"], source: { tool: "fs.read", callId: "c1" }, kind: "observation", freshness: "current", strength: "decisive", observation: "read unrelated README", result: "pass" });
    linkEvidence(outcome, read);
    expect(outcome.criteria.find((c) => c.id === "implemented")?.status).toBe("unproven");
    expect(deriveOutcomeStatus(outcome, [read])).toBe("partial");
  });

  it("rejects stale evidence and evidence from an old revision", () => {
    const outcome = createOutcome({ sessionId: "s", userIntent: "fix", kind: "bugfix", criteria: [{ id: "fixed", statement: "bug fixed", required: true, domain: "bugfix" }] });
    const revised = reviseOutcome(outcome, outcome.criteria);
    const old = createEvidence({ outcomeId: revised.id, outcomeRevision: 1, criterionIds: ["fixed"], source: { tool: "test", callId: "old" }, kind: "automated-check", freshness: "current", strength: "decisive", observation: "old pass", result: "pass" });
    expect(() => linkEvidence(revised, old)).toThrow(/revision/);
    const stale = { ...old, outcomeRevision: revised.revision, freshness: "stale" as const };
    expect(() => linkEvidence(revised, stale)).toThrow(/stale/);
  });

  it("proves a server criterion with any linked evidence (no triple-kind gate)", () => {
    const outcome = createOutcome({ sessionId: "s", userIntent: "serve", kind: "operation", criteria: [{ id: "server", statement: "server available", required: true, domain: "server" }] });
    const record = createEvidence({ outcomeId: outcome.id, outcomeRevision: outcome.revision, criterionIds: ["server"], source: { tool: "shell.start", callId: "c0" }, kind: "process-start", freshness: "current", strength: "decisive", observation: "started", result: "pass" });
    linkEvidence(outcome, record);
    expect(validateCriterionEvidence(outcome.criteria[0]!, [record]).ok).toBe(true);
  });

  it("does not promote scanner output to a verified finding", () => {
    const outcome = createOutcome({ sessionId: "s", userIntent: "assess local fixture", kind: "pentest", criteria: [{ id: "finding", statement: "finding verified", required: true, domain: "pentest-finding" }] });
    const lead = createEvidence({ outcomeId: outcome.id, outcomeRevision: outcome.revision, criterionIds: ["finding"], source: { tool: "net.scan", callId: "scan", artifact: "scan.txt" }, kind: "scanner-lead", freshness: "current", strength: "decisive", observation: "scanner lead", result: "pass" });
    linkEvidence(outcome, lead);
    expect(validateCriterionEvidence(outcome.criteria[0]!, [lead]).ok).toBe(false);
  });

  it("persists receipts and failed hypotheses across a restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clai-outcome-restart-"));
    const previous = process.env.CLAI_DATA_DIR;
    process.env.CLAI_DATA_DIR = dataDir;
    try {
      const state = await openOutcomeState({
        sessionId: "restart-session",
        userIntent: "build a checked feature",
        kind: "build",
      });
      recordToolEvidence(state, {
        tool: "fs.write",
        callId: "write-1",
        ok: true,
        output: "wrote feature.ts",
        artifact: "feature.ts",
        args: { path: "feature.ts" },
      });
      recordToolEvidence(state, {
        tool: "shell.exec",
        callId: "test-1",
        ok: true,
        output: "1 test passed",
        args: { command: "npm test -- --run" },
      });
      recordFailedHypothesis(state, {
        signature: "shell.exec:1",
        premise: "the old command would pass",
      });
      await saveOutcomeState(state);

      const restored = await loadOutcomeState("restart-session");
      expect(restored?.outcome.status).toBe("succeeded");
      expect(restored?.evidence).toHaveLength(2);
      expect(restored?.failedHypotheses).toEqual([
        expect.objectContaining({ signature: "shell.exec:1" }),
      ]);
    } finally {
      if (previous === undefined) delete process.env.CLAI_DATA_DIR;
      else process.env.CLAI_DATA_DIR = previous;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("persists bounded redacted signatures for successful read-only operations", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clai-operation-ledger-"));
    const previous = process.env.CLAI_DATA_DIR;
    process.env.CLAI_DATA_DIR = dataDir;
    try {
      const state = await openOutcomeState({
        sessionId: "operation-ledger",
        userIntent: "inspect the service",
        kind: "answer",
      });
      for (let index = 0; index < 45; index++) {
        recordToolEvidence(state, {
          tool: "fs.read",
          callId: `read-${index}`,
          ok: true,
          output: `contents ${index}`,
          args: { path: `file-${index}.txt`, token: "secret-value" },
        });
      }
      recordToolEvidence(state, {
        tool: "shell.exec",
        callId: "curl",
        ok: true,
        output: "HTTP 200",
        args: { command: "curl -H 'Authorization: Bearer sk-proj-secret' https://example.test" },
      });
      recordToolEvidence(state, {
        tool: "shell.exec",
        callId: "bad-curl",
        ok: false,
        exitCode: 6,
        output: "000",
        args: {
          command:
            'curl -s -o /dev/null -w "%{http_code}" https://images.picsum.photos/id/866/800/400',
        },
      });
      await saveOutcomeState(state);

      const restored = await loadOutcomeState("operation-ledger");
      expect(restored?.completedOperations).toHaveLength(40);
      const serialized = JSON.stringify(restored?.completedOperations);
      expect(serialized).not.toContain("secret-value");
      expect(serialized).not.toContain("sk-proj-secret");
      expect(
        restored?.completedOperations?.find(
          (operation) => operation.observation === "HTTP 200",
        ),
      ).toMatchObject({
        tool: "shell.exec",
        ok: true,
      });
      expect(restored?.completedOperations?.at(-1)).toMatchObject({
        tool: "shell.exec",
        observation: "000",
        ok: false,
        exitCode: 6,
      });
    } finally {
      if (previous === undefined) delete process.env.CLAI_DATA_DIR;
      else process.env.CLAI_DATA_DIR = previous;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("serializes parallel saves with unique temp files and keeps the newest snapshot", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clai-outcome-parallel-"));
    const previous = process.env.CLAI_DATA_DIR;
    process.env.CLAI_DATA_DIR = dataDir;
    try {
      const state = await openOutcomeState({
        sessionId: "parallel-session",
        userIntent: "inspect several files",
        kind: "answer",
      });
      const snapshots = Array.from({ length: 12 }, (_, index) => {
        const sibling = structuredClone(state);
        recordFailedHypothesis(sibling, {
          signature: `read:${index}`,
          premise: `parallel receipt ${index}`,
        });
        return sibling;
      });

      await Promise.all(snapshots.map((snapshot) => saveOutcomeState(snapshot)));

      const restored = await loadOutcomeState("parallel-session");
      expect(restored?.failedHypotheses).toHaveLength(12);
      const files = await readdir(join(dataDir, "outcomes"));
      expect(files).toEqual(["parallel-session.json"]);
    } finally {
      if (previous === undefined) delete process.env.CLAI_DATA_DIR;
      else process.env.CLAI_DATA_DIR = previous;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("merges decisive evidence from independent clones and recomputes criterion statuses", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clai-outcome-clones-"));
    const previous = process.env.CLAI_DATA_DIR;
    process.env.CLAI_DATA_DIR = dataDir;
    try {
      const outcome = createOutcome({
        sessionId: "clone-session",
        userIntent: "implement and verify a feature",
        kind: "build",
        criteria: [
          { id: "implemented", statement: "feature implemented", required: true, domain: "feature" },
          { id: "checked", statement: "feature verified", required: true, domain: "feature" },
        ],
      });
      const initial = { schemaVersion: 1 as const, outcome, evidence: [], failedHypotheses: [] };
      const implementation = structuredClone(initial);
      const check = structuredClone(initial);
      const implementationEvidence = createEvidence({
        outcomeId: outcome.id,
        outcomeRevision: outcome.revision,
        criterionIds: ["implemented"],
        source: { tool: "fs.write", callId: "write" },
        kind: "artifact",
        freshness: "current",
        strength: "decisive",
        observation: "feature written",
        result: "pass",
      });
      const checkEvidence = createEvidence({
        outcomeId: outcome.id,
        outcomeRevision: outcome.revision,
        criterionIds: ["checked"],
        source: { tool: "shell.exec", callId: "test" },
        kind: "automated-check",
        freshness: "current",
        strength: "decisive",
        observation: "feature test passed",
        result: "pass",
      });
      implementation.evidence.push(implementationEvidence);
      linkEvidence(implementation.outcome, implementationEvidence);
      check.evidence.push(checkEvidence);
      linkEvidence(check.outcome, checkEvidence);

      await Promise.all([saveOutcomeState(implementation), saveOutcomeState(check)]);

      const restored = await loadOutcomeState("clone-session");
      expect(restored?.evidence).toHaveLength(2);
      expect(restored?.outcome.criteria.map((criterion) => criterion.status)).toEqual([
        "proven",
        "proven",
      ]);
      expect(restored?.outcome.status).toBe("succeeded");
    } finally {
      if (previous === undefined) delete process.env.CLAI_DATA_DIR;
      else process.env.CLAI_DATA_DIR = previous;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("requires criterion-linked before and after evidence for bug completion", async () => {
    const state = await openOutcomeState({
      sessionId: "bug-before-after",
      userIntent: "fix the broken parser",
      kind: "bugfix",
    });
    recordToolEvidence(state, {
      tool: "shell.exec",
      callId: "before",
      ok: false,
      output: "parser test failed: expected token",
      args: { command: "npm test -- parser --run" },
    });
    recordToolEvidence(state, {
      tool: "fs.edit",
      callId: "fix",
      ok: true,
      output: "updated parser.ts",
      args: { path: "parser.ts" },
    });
    expect(state.outcome.status).toBe("partial");
    recordToolEvidence(state, {
      tool: "shell.exec",
      callId: "after",
      ok: true,
      output: "parser test passed",
      args: { command: "npm test -- parser --run" },
    });
    expect(state.outcome.status).toBe("succeeded");
    const reproduction = state.outcome.criteria.find((criterion) => criterion.id === "reproduction")!;
    expect(validateCriterionEvidence(reproduction, state.evidence)).toEqual({ ok: true });
  });

  it("operation criterion is proven by the final answer, not by tool evidence alone", async () => {
    const state = await openOutcomeState({
      sessionId: "server-receipts",
      userIntent: "start the web server",
      kind: "operation",
    });
    recordToolEvidence(state, {
      tool: "shell.start",
      callId: "start",
      ok: true,
      output: "pid 12",
      args: { command: "npm run dev" },
    });
    recordToolEvidence(state, {
      tool: "shell.tail",
      callId: "ready",
      ok: true,
      output: "ready - listening on localhost:3000",
      args: {},
    });
    recordToolEvidence(state, {
      tool: "http.fetch",
      callId: "probe",
      ok: true,
      output: "HTTP 200",
      args: { url: "http://localhost:3000" },
    });
    expect(state.outcome.status).toBe("partial");
    recordAnswerEvidence(state, "The server is running on localhost:3000.");
    expect(state.outcome.status).toBe("succeeded");
  });
});
