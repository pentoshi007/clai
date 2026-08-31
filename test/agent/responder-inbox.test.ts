import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../src/types.js";
import type {
  BackgroundJob,
  ResponderNotification,
} from "../../src/tools/jobs.js";
import { RESPONDER_CONTEXT_PREFIX } from "../../src/agent/responder-context.js";
import {
  createResponderInboxRefresher,
  findResponderWakeNotification,
  parseResponderWake,
  responderWakeMatchesRevision,
} from "../../src/agent/turn/responder-inbox.js";

const wakePrompt = [
  "Responder result arrived for a background job.",
  "notification=n-1",
  "job=job-1",
  "resultRevision=3",
].join("\n");

const notification = (
  id: string,
  overrides: Partial<ResponderNotification> = {},
): ResponderNotification =>
  ({
    id,
    ownerSessionId: "session-1",
    jobId: "job-1",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    exitCode: 0,
    stdoutArtifact: { path: "/artifacts/out.log", bytes: 0, chunks: [] },
    stderrArtifact: { path: "/artifacts/err.log", bytes: 0, chunks: [] },
    commandDisplay: "npm test",
    wakeOnCompletion: true,
    responder: true,
    ...overrides,
  }) as ResponderNotification;

const job = (id: string, responder: boolean): BackgroundJob =>
  ({
    id,
    responder,
    status: "running",
    pid: 1234,
    commandDisplay: `run ${id}`,
  }) as unknown as BackgroundJob;

describe("responder wake parsing", () => {
  it("parses identity only for a hidden responder wake prompt", () => {
    expect(parseResponderWake({ prompt: wakePrompt, displayPrompt: null })).toEqual(
      {
        wakeTurn: true,
        notificationId: "n-1",
        jobId: "job-1",
        resultRevision: 3,
      },
    );
    expect(
      parseResponderWake({ prompt: wakePrompt, displayPrompt: "shown" }),
    ).toEqual({
      wakeTurn: false,
      notificationId: undefined,
      jobId: undefined,
      resultRevision: undefined,
    });
    expect(
      parseResponderWake({ prompt: "ordinary prompt", displayPrompt: null }),
    ).toEqual({
      wakeTurn: false,
      notificationId: undefined,
      jobId: undefined,
      resultRevision: undefined,
    });
  });

  it("treats a zero or absent revision as unconstrained", () => {
    const wake = parseResponderWake({
      prompt: "Responder result arrived\nnotification=n-1\nresultRevision=0",
      displayPrompt: null,
    });
    expect(wake.resultRevision).toBeUndefined();
    expect(responderWakeMatchesRevision(wake, notification("n-1"))).toBe(true);
  });

  it("matches the wake notification by id, job, and revision", () => {
    const wake = parseResponderWake({
      prompt: wakePrompt,
      displayPrompt: null,
    });
    const pending = [
      notification("n-1", { jobId: "other", resultRevision: 3 }),
      notification("n-1", { resultRevision: 2 }),
      notification("n-1", { resultRevision: 3 }),
    ];
    expect(findResponderWakeNotification(wake, pending)).toBe(pending[2]);
    expect(
      findResponderWakeNotification(
        { ...wake, notificationId: undefined },
        pending,
      ),
    ).toBeUndefined();
  });
});

describe("responder inbox refresh", () => {
  const runningJobs = [job("job-1", true), job("job-2", false)];

  it("shows at most one claimed matching receipt on a wake turn without claiming", () => {
    const messages: ChatMessage[] = [];
    const claimNextNotification = vi.fn();
    const refresher = createResponderInboxRefresher({
      messages,
      wake: parseResponderWake({ prompt: wakePrompt, displayPrompt: null }),
      claims: { add: () => undefined, has: () => true },
      getRunningJobs: () => runningJobs,
      getPendingNotifications: () => [
        notification("n-1", { resultRevision: 2 }),
        notification("n-1", { resultRevision: 3 }),
        notification("n-2", { resultRevision: 3 }),
      ],
      getResponderLeaseId: () => "lease-1",
      claimNextNotification,
    });

    expect(refresher()).toBeUndefined();
    expect(claimNextNotification).not.toHaveBeenCalled();
    const block = messages.find((message) =>
      message.content.startsWith(RESPONDER_CONTEXT_PREFIX),
    );
    expect(block).toBeDefined();
    expect(block!.content).toContain("job=job-1");
    expect(block!.content).not.toContain("job=job-2");
  });

  it("claims the next delivery and bounds pending receipts to twelve", () => {
    const messages: ChatMessage[] = [];
    const claimed = new Set<string>();
    const delivered = notification("n-delivered");
    const pending = Array.from({ length: 20 }, (_, index) =>
      notification(`n-${index}`),
    );
    const refresher = createResponderInboxRefresher({
      messages,
      wake: parseResponderWake({ prompt: "work", displayPrompt: "work" }),
      claims: {
        add: (id) => claimed.add(id),
        has: (id) => claimed.has(id) || pending.some((n) => n.id === id),
      },
      getRunningJobs: () => runningJobs,
      getPendingNotifications: () => pending,
      getResponderLeaseId: () => "lease-1",
      claimNextNotification: () => delivered,
    });

    expect(refresher()).toBe(delivered);
    expect(claimed.has("n-delivered")).toBe(true);
    const block = messages.find((message) =>
      message.content.startsWith(RESPONDER_CONTEXT_PREFIX),
    )!;
    expect(block.content.match(/n-\d+/g)?.length).toBeLessThanOrEqual(12);
  });

  it("skips delivery when no responder lease exists", () => {
    const messages: ChatMessage[] = [];
    const claimNextNotification = vi.fn();
    const refresher = createResponderInboxRefresher({
      messages,
      wake: parseResponderWake({ prompt: "work", displayPrompt: "work" }),
      claims: { add: () => undefined, has: () => false },
      getRunningJobs: () => [],
      getPendingNotifications: () => [],
      getResponderLeaseId: () => undefined,
      claimNextNotification,
    });

    expect(refresher()).toBeUndefined();
    expect(claimNextNotification).not.toHaveBeenCalled();
  });
});
