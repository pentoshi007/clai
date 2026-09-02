import { describe, expect, it, vi } from "vitest";
import {
  WorkLedger,
  buildDurableEnvelope,
} from "../../src/agent/durable-envelope.js";
import type { OutcomeEnvelope } from "../../src/agent/outcomes.js";
import type { SessionPlan } from "../../src/store/plan.js";
import { createCompactionDurableEnvelopeBuilder } from "../../src/agent/turn/compaction-durable-envelope.js";

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
      getUnreadNotificationIds: () => {
        lookupOrder.push("unread");
        return ["notice-unread"];
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

  it("uses the active root and tolerates plan-load failure", async () => {
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
      getUnreadNotificationIds: () => [],
      getRunningJobs: () => [],
      getRecentJobs: () => [],
    });

    await expect(buildEnvelope()).resolves.toBe(
      buildDurableEnvelope({
        outcome,
        ledger: new WorkLedger(),
        projectRoot: "/workspace/active",
        packageManager: "npm",
        responder: { unread: [], consumed: [] },
      }),
    );
    expect(detectPackageManager).toHaveBeenCalledWith("/workspace/active");
  });
});
