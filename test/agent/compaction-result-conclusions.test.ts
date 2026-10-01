import { describe, expect, it } from "vitest";
import {
  WorkLedger,
  buildDurableEnvelope,
  summarizeCarriedWork,
} from "../../src/agent/durable-envelope.js";
import {
  collectCompactionEnvelopeInput,
  createCompactionDurableEnvelopeBuilder,
  type CompactionDurableEnvelopePorts,
} from "../../src/agent/turn/compaction-durable-envelope.js";
import {
  RESPONDER_RESULT_LEDGER_PREFIX,
  responderResultLedgerEntry,
} from "../../src/agent/responder-context.js";
import type { SubagentRun } from "../../src/agent/subagents/types.js";
import type { SessionPlan } from "../../src/store/plan.js";
import type { ResponderNotification } from "../../src/tools/jobs.js";
import type { ChatMessage } from "../../src/types.js";

const consumed = (
  jobId: string,
  resultDigest?: string,
): ResponderNotification =>
  ({
    id: `completion:${jobId}`,
    jobId,
    status: "exited",
    readAt: "2026-01-01T00:00:00.000Z",
    analyzedAt: "2026-01-01T00:00:01.000Z",
    stdoutArtifact: { path: `/data/${jobId}.log`, chunks: [], bytes: 1 },
    stderrArtifact: { path: `/data/${jobId}.err`, chunks: [], bytes: 0 },
    ...(resultDigest ? { resultDigest } : {}),
  }) as ResponderNotification;

const ledgerMessage = (...notifications: ResponderNotification[]): ChatMessage => ({
  role: "system",
  content: `${RESPONDER_RESULT_LEDGER_PREFIX}\n${notifications.map(responderResultLedgerEntry).join("\n")}`,
});

const run = (index: number, overrides: Partial<SubagentRun> = {}): SubagentRun => ({
  title: `Run ${index}`,
  prompt: "p",
  cwd: "/w",
  provider: "openai",
  model: "m",
  id: `sa-${index}`,
  parentSessionId: "s",
  attempt: 1,
  status: "completed",
  createdAt: index,
  updatedAt: index,
  events: [],
  report: "## Findings\n- done",
  resultAcknowledged: true,
  ...overrides,
});

const ports = (
  overrides: Partial<CompactionDurableEnvelopePorts> = {},
): CompactionDurableEnvelopePorts => ({
  messages: [],
  loadPlan: async () => undefined,
  getProjectRoot: () => undefined,
  detectPackageManager: () => undefined,
  getPendingNotifications: () => [],
  getRunningJobs: () => [],
  getRecentJobs: () => [],
  getSubagents: () => [],
  ...overrides,
});

const job = (index: number, status = "running") => ({
  id: `job-${index}`,
  status,
  command: `cmd ${index}`,
  commandDisplay: `cmd ${index}`,
});

describe("result conclusions across compaction", () => {
  it("lists the conclusion recorded when each responder result was read", async () => {
    const envelope =
      (await createCompactionDurableEnvelopeBuilder(
        ports({
          messages: [
            ledgerMessage(
              consumed("job-a", "Login issues a JWT at /api/login"),
              consumed("job-b", "14 routes, 3 unauthenticated"),
              consumed("job-c"),
            ),
          ],
        }),
      )()) ?? "";

    expect(envelope).toContain("Consumed responder results (never re-read): completion:job-a, completion:job-b, completion:job-c");
    expect(envelope).toContain("Result conclusions (recorded when each result was read; rely on these instead of re-reading):");
    expect(envelope).toContain("- [job-a] Login issues a JWT at /api/login");
    expect(envelope).toContain("- [job-b] 14 routes, 3 unauthenticated");
    expect(envelope).not.toContain("- [job-c]");
  });

  it("drops the conclusion of an older revision when the newest read recorded none", async () => {
    const input = await collectCompactionEnvelopeInput(
      ports({
        messages: [
          ledgerMessage(consumed("job-a", "stale conclusion")),
          ledgerMessage(consumed("job-a")),
        ],
      }),
    );
    expect(input.responder?.conclusions).toBeUndefined();
  });

  it("keeps the newest conclusion per job and the order jobs were first read in", async () => {
    const input = await collectCompactionEnvelopeInput(
      ports({
        messages: [
          ledgerMessage(consumed("job-a", "first a"), consumed("job-b", "first b")),
          ledgerMessage(consumed("job-a", "final a"), consumed("job-b", "first b")),
        ],
      }),
    );
    expect(input.responder?.conclusions).toEqual([
      { jobId: "job-a", conclusion: "final a" },
      { jobId: "job-b", conclusion: "first b" },
    ]);
  });

  it("renders the same bytes for the same state so the compacted prefix stays cacheable", async () => {
    const build = () =>
      createCompactionDurableEnvelopeBuilder(
        ports({
          messages: [ledgerMessage(consumed("job-a", "stable"))],
          getSubagents: () => [run(1), run(2, { resultAcknowledged: false })],
          getRunningJobs: () => [job(1)],
        }),
      )();
    expect(await build()).toBe(await build());
  });
});

describe("envelope never truncates silently", () => {
  const plan = (taskCount: number): SessionPlan => ({
    sessionId: "s",
    goal: "g",
    detail: "d",
    status: "active",
    kind: "build",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      id: `t${index + 1}`,
      title: `Task ${index + 1}`,
      state: "in_progress" as const,
      responderOwned: true,
      jobId: `job-${index + 1}`,
    })),
  });

  it("states how many earlier subagents, jobs and delegated tasks were left out", () => {
    const envelope =
      buildDurableEnvelope({
        plan: plan(23),
        subagents: Array.from({ length: 22 }, (_, index) => ({
          id: `sa-${index}`,
          title: `Run ${index}`,
          status: "completed",
          attempt: 1,
          result: "read" as const,
        })),
        liveJobs: Array.from({ length: 25 }, (_, index) => job(index)),
        finishedJobs: Array.from({ length: 21 }, (_, index) => job(index, "exited")),
        responder: {
          unread: [],
          consumed: [],
          conclusions: Array.from({ length: 21 }, (_, index) => ({
            jobId: `job-${index}`,
            conclusion: `c${index}`,
          })),
        },
      }) ?? "";

    expect(envelope).toContain("(+2 earlier runs omitted)");
    expect(envelope).toContain("(+5 earlier jobs omitted)");
    expect(envelope).toContain("(+1 earlier jobs omitted)");
    expect(envelope).toContain("(+3 earlier tasks omitted)");
    expect(envelope).toContain("(+1 earlier conclusions omitted)");
    expect(envelope).not.toContain("[sa-0]");
    expect(envelope).toContain("[sa-21]");
  });

  it("adds no marker when everything fits", () => {
    const envelope =
      buildDurableEnvelope({
        plan: plan(20),
        liveJobs: Array.from({ length: 20 }, (_, index) => job(index)),
      }) ?? "";
    expect(envelope).not.toContain("omitted");
  });
});

describe("carried work summary", () => {
  it("counts what will survive compaction and nothing else", () => {
    expect(summarizeCarriedWork({})).toBeUndefined();
    expect(
      summarizeCarriedWork({
        subagents: [
          { id: "a", title: "A", status: "completed", attempt: 1, result: "read" },
          { id: "b", title: "B", status: "running", attempt: 1, result: "running" },
        ],
        liveJobs: [job(1)],
        finishedJobs: [job(2, "exited"), job(3, "exited")],
        responder: {
          unread: [],
          consumed: ["n1"],
          conclusions: [{ jobId: "j1", conclusion: "x" }],
        },
        credentials: ["A=1"],
        ledger: new WorkLedger(),
      }),
    ).toBe(
      "2 subagents (1 read) · 1 live job · 2 finished jobs · 1 responder result read (1 with a conclusion) · 1 credential",
    );
  });

  it("never prints credential values", () => {
    const secret = ["API_TOKEN=", "tok_", "000000000001"].join("");
    expect(summarizeCarriedWork({ credentials: [secret] })).toBe("1 credential");
  });
});
