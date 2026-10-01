import { describe, expect, it, vi } from "vitest";
import {
  WorkLedger,
  buildDurableEnvelope,
} from "../../src/agent/durable-envelope.js";
import type { OutcomeEnvelope } from "../../src/agent/outcomes.js";
import type { SessionPlan } from "../../src/store/plan.js";
import { createCompactionDurableEnvelopeBuilder } from "../../src/agent/turn/compaction-durable-envelope.js";
import type { SubagentRun } from "../../src/agent/subagents/types.js";

const stagingKey = ["7f3a9c2e", "41b8d6f0"].join("");

const outcome: OutcomeEnvelope = {
  schemaVersion: 1,
  outcome: {
    schemaVersion: 1,
    id: "outcome-1",
    sessionId: "session-1",
    userIntent: "finish the refactor",
    kind: "build",
    criteria: [],
    assumptions: [],
    constraints: [],
    status: "active",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  evidence: [],
  failedHypotheses: [],
};

const plan: SessionPlan = {
  sessionId: "session-1",
  goal: "finish the refactor",
  detail: "preserve behavior",
  tasks: [],
  status: "active",
  kind: "build",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  meta: {
    projectRoot: "/workspace/from-plan",
    packageManager: "pnpm",
  },
};

describe("compaction durable envelope builder", () => {
  it("preserves plan fallback, responder IDs, projected job state, and lookup order", async () => {
    const detectPackageManager = vi.fn(() => "npm");
    const lookupOrder: string[] = [];
    const buildEnvelope = createCompactionDurableEnvelopeBuilder({
      messages: [
        {
          role: "system",
          content:
            "RESPONDER RESULT LEDGER (authoritative consumed results)\nnotification=notice-read\nnotification=notice-read",
        },
      ],
      outcome,
      ledger: new WorkLedger(),
      loadPlan: async () => plan,
      getProjectRoot: () => undefined,
      detectPackageManager,
      getPendingNotifications: () => {
        lookupOrder.push("unread");
        return [{ id: "notice-unread", jobId: "job-unread" }];
      },
      getRunningJobs: () => {
        lookupOrder.push("running");
        return [
          {
            id: "job-live",
            status: "running",
            command: "npm test",
            commandDisplay: "test suite",
            taskId: "task-1",
            stdoutArtifact: "/artifacts/live.log",
          },
        ];
      },
      getRecentJobs: () => {
        lookupOrder.push("recent");
        return [
          {
            id: "job-live",
            status: "running",
            command: "npm test",
            commandDisplay: "test suite",
          },
          {
            id: "job-done",
            status: "completed",
            command: "npm run build",
            commandDisplay: "",
            stdoutArtifact: "/artifacts/build.log",
          },
        ];
      },
      getSubagents: () => [],
    });

    await expect(buildEnvelope()).resolves.toBe(
      buildDurableEnvelope({
        plan,
        outcome,
        ledger: new WorkLedger(),
        projectRoot: "/workspace/from-plan",
        packageManager: "pnpm",
        responder: {
          unread: ["notice-unread"],
          consumed: ["notice-read"],
          unreadJobs: ["job-unread"],
          consumedJobs: [],
        },
        liveJobs: [
          {
            id: "job-live",
            status: "running",
            command: "test suite",
            taskId: "task-1",
            artifact: "/artifacts/live.log",
          },
        ],
        finishedJobs: [
          {
            id: "job-done",
            status: "completed",
            command: "npm run build",
            artifact: "/artifacts/build.log",
          },
        ],
      }),
    );
    expect(detectPackageManager).not.toHaveBeenCalled();
    expect(lookupOrder).toEqual(["unread", "running", "recent"]);
  });

  it("carries subagents, jobs, delegated tasks and user credentials, summarising results already read", async () => {
    const run = (overrides: Partial<SubagentRun>): SubagentRun => ({
      title: "Audit",
      prompt: "audit",
      cwd: "/workspace",
      provider: "openai",
      model: "gpt-test",
      id: "sa-0",
      parentSessionId: "session-1",
      attempt: 1,
      status: "completed",
      createdAt: 0,
      updatedAt: 0,
      events: [],
      ...overrides,
    });
    const delegatedPlan: SessionPlan = {
      ...plan,
      tasks: [
        {
          id: "t4",
          title: "Scan staging host",
          state: "in_progress",
          responderOwned: true,
          parentTaskId: "t2",
          jobId: "job-scan",
        },
      ],
    };
    const buildEnvelope = createCompactionDurableEnvelopeBuilder({
      messages: [
        { role: "user", content: `staging API key: ${stagingKey}\nusername: qa-bot` },
        {
          role: "system",
          content:
            "RESPONDER RESULT LEDGER (authoritative consumed results)\n- notification=notice-1 job=job-scan status=completed consumed=true",
        },
      ],
      outcome,
      ledger: new WorkLedger(),
      loadPlan: async () => delegatedPlan,
      getProjectRoot: () => "/workspace",
      detectPackageManager: () => "npm",
      getPendingNotifications: () => [],
      getRunningJobs: () => [
        {
          id: "job-dev",
          status: "running",
          command: "npm run dev",
          commandDisplay: "npm run dev",
          name: "Dev server",
        },
      ],
      getRecentJobs: () => [
        {
          id: "job-scan",
          status: "completed",
          command: "nmap -sV staging",
          commandDisplay: "nmap -sV staging",
          exitCode: 0,
          responder: true,
          taskId: "t4",
        },
      ],
      getSubagents: () => [
        run({
          id: "sa-1",
          title: "Map the auth flow",
          report: "## Findings\n- Login issues a JWT at /api/login\n- Refresh is cookie based",
          resultAcknowledged: true,
        }),
        run({ id: "sa-2", title: "Inventory routes", report: "## Findings\n- 14 routes", resultAcknowledged: false }),
        run({ id: "sa-3", title: "Fuzz uploads", status: "running" }),
      ],
    });

    const envelope = (await buildEnvelope()) ?? "";

    expect(envelope).toContain("[sa-1] Map the auth flow (completed, attempt 1, result read) — Login issues a JWT at /api/login Refresh is cookie based");
    expect(envelope).toContain("[sa-2] Inventory routes (completed, attempt 1, result pending delivery)");
    expect(envelope).not.toContain("14 routes");
    expect(envelope).toContain("[sa-3] Fuzz uploads (running, attempt 1)");
    expect(envelope).toContain('[job-dev] "Dev server" running — npm run dev');
    expect(envelope).toContain("[job-scan] completed exit=0 responder task=t4 — nmap -sV staging");
    expect(envelope).toContain("[t4] Scan staging host (in_progress) parent=t2 job=job-scan completed exit=0, result read");
    expect(envelope).toContain("Consumed responder results (never re-read): notice-1");
    expect(envelope).toContain(`- staging API key: ${stagingKey}`);
    expect(envelope).toContain("- username: qa-bot");
  });

  it("propagates plan-load failure before building the envelope", async () => {
    const detectPackageManager = vi.fn(() => "npm");
    const buildEnvelope = createCompactionDurableEnvelopeBuilder({
      messages: [],
      outcome,
      ledger: new WorkLedger(),
      loadPlan: async () => {
        throw new Error("store unavailable");
      },
      getProjectRoot: () => "/workspace/active",
      detectPackageManager,
      getPendingNotifications: () => [],
      getRunningJobs: () => [],
      getRecentJobs: () => [],
      getSubagents: () => [],
    });

    await expect(buildEnvelope()).rejects.toThrow("store unavailable");
    expect(detectPackageManager).not.toHaveBeenCalled();
  });
});
