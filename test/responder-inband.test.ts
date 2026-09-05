import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/agent/events.js";
import type { CompletionRequest, CompletionResult } from "../src/types.js";

const streamMock = vi.hoisted(() => vi.fn());
const jobsHarness = vi.hoisted(() => {
  const notification = {
    id: "completion:inband-job",
    ownerSessionId: "inband-session",
    jobId: "inband-job",
    taskId: "t2",
    status: "exited" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:02.000Z",
    exitCode: 0,
    stdoutArtifact: {
      path: "/tmp/inband-job.stdout.log",
      chunks: [] as string[],
      bytes: 88,
      droppedBytes: 0,
      redacted: false,
      sha256: "abc",
    },
    stderrArtifact: {
      path: "/tmp/inband-job.stderr.log",
      chunks: [] as string[],
      bytes: 0,
      droppedBytes: 0,
      redacted: false,
      sha256: "def",
    },
    commandDisplay: "scan target",
    wakeOnCompletion: true,
    responder: true,
    responderLeaseId: "lease-inband",
    deliveredAt: undefined as string | undefined,
    readAt: undefined as string | undefined,
    analyzedAt: undefined as string | undefined,
  };
  let ready = false;
  let responderRunning = false;
  let normalRunning = false;
  const runningJob = {
    id: "running-responder-job",
    command: "nmap example.test",
    commandDisplay: "nmap example.test",
    cwd: "/tmp",
    status: "running" as const,
    startedAt: "2026-01-01T00:00:00.000Z",
    artifactPath: "/tmp/running-responder-job.stdout.log",
    stdoutArtifact: "/tmp/running-responder-job.stdout.log",
    stderrArtifact: "/tmp/running-responder-job.stderr.log",
    artifacts: {
      stdout: {
        path: "/tmp/running-responder-job.stdout.log",
        chunks: [] as string[],
        bytes: 0,
        droppedBytes: 0,
        redacted: false,
        sha256: "",
      },
      stderr: {
        path: "/tmp/running-responder-job.stderr.log",
        chunks: [] as string[],
        bytes: 0,
        droppedBytes: 0,
        redacted: false,
        sha256: "",
      },
    },
    redactionProfile: "provider-secrets-v1",
    ownerSessionId: "inband-session",
    responder: true,
  };
  const normalJob = {
    ...runningJob,
    id: "normal-server-job",
    command: "npm run dev",
    commandDisplay: "npm run dev",
    artifactPath: "/tmp/normal-server-job.stdout.log",
    stdoutArtifact: "/tmp/normal-server-job.stdout.log",
    stderrArtifact: "/tmp/normal-server-job.stderr.log",
    artifacts: {
      stdout: {
        ...runningJob.artifacts.stdout,
        path: "/tmp/normal-server-job.stdout.log",
      },
      stderr: {
        ...runningJob.artifacts.stderr,
        path: "/tmp/normal-server-job.stderr.log",
      },
    },
    responder: false,
  };
  const visibleJobs = () => [
    ...(responderRunning ? [runningJob] : []),
    ...(normalRunning ? [normalJob] : []),
  ];
  const manager = {
    getRunningJobs: vi.fn(() => visibleJobs()),
    getRecentJobs: vi.fn(() => visibleJobs()),
    getJob: vi.fn((id: string) => visibleJobs().find((job) => job.id === id)),
    registerJob: vi.fn(),
    updateJobStatus: vi.fn(),
    listJobs: vi.fn(() => {
      if (responderRunning && !normalRunning) {
        return {
          ok: true,
          output:
            "shell.jobs was not dispatched because the only running background job(s) (running-responder-job) are Responder-owned.",
          exitCode: 0,
          suppressedRepeat: true,
        };
      }
      return {
        ok: true,
        output: "Session background jobs (1 total):\n[normal-server-job] running npm run dev",
      };
    }),
    getPendingNotifications: vi.fn(() =>
      ready && !notification.analyzedAt ? [notification] : [],
    ),
    getResponderLeaseId: vi.fn(() => "lease-inband"),
    claimNextResponderNotification: vi.fn(() =>
      ready && !notification.deliveredAt && !notification.analyzedAt
        ? notification
        : undefined,
    ),
    markDeliveryStarted: vi.fn((id: string) => {
      if (id !== notification.id) return false;
      notification.deliveryStartedAt = "2026-01-01T00:00:02.000Z";
      return true;
    }),
    markDelivered: vi.fn((id: string) => {
      if (id !== notification.id) return false;
      notification.deliveredAt = "2026-01-01T00:00:03.000Z";
      return true;
    }),
    markRead: vi.fn((id: string, sessionId: string) => {
      if (
        id !== notification.id ||
        sessionId !== notification.ownerSessionId
      ) {
        return false;
      }
      notification.deliveredAt ??= "2026-01-01T00:00:03.000Z";
      notification.readAt = "2026-01-01T00:00:04.000Z";
      return true;
    }),
    markAnalyzed: vi.fn((id: string) => {
      if (id !== notification.id || !notification.deliveredAt) return false;
      notification.analyzedAt = "2026-01-01T00:00:04.000Z";
      return true;
    }),
  };
  return {
    manager,
    notification,
    complete: () => {
      ready = true;
    },
    startRunning: () => {
      responderRunning = true;
    },
    startNormal: () => {
      normalRunning = true;
    },
    prepareWake: () => {
      ready = true;
      notification.deliveredAt = "2026-01-01T00:00:03.000Z";
    },
    reset: () => {
      ready = false;
      responderRunning = false;
      normalRunning = false;
      notification.deliveredAt = undefined;
      notification.readAt = undefined;
      notification.analyzedAt = undefined;
      manager.getRunningJobs.mockClear();
      manager.getRecentJobs.mockClear();
      manager.getJob.mockClear();
      manager.registerJob.mockClear();
      manager.updateJobStatus.mockClear();
      manager.listJobs.mockClear();
      manager.getPendingNotifications.mockClear();
      manager.getResponderLeaseId.mockClear();
      manager.claimNextResponderNotification.mockClear();
      manager.markDeliveryStarted.mockClear();
      manager.markDelivered.mockClear();
      manager.markRead.mockClear();
      manager.markAnalyzed.mockClear();
    },
  };
});

vi.mock("../src/tools/jobs.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/tools/jobs.js")>();
  return { ...actual, jobManager: jobsHarness.manager };
});

vi.mock("../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/llm/router.js")>();
  return {
    ...actual,
    streamWithProvider: (
      request: CompletionRequest,
      onToken: (token: string) => void,
    ): Promise<CompletionResult> => streamMock(request, onToken),
  };
});

vi.mock("../src/commands/providers.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/commands/providers.js")>();
  return { ...actual, ensureProviderConfigured: async () => undefined };
});

describe("ordinary-turn responder delivery", () => {
  beforeEach(() => {
    streamMock.mockReset();
    jobsHarness.reset();
  });

  it("delivers a mid-work completion at the next safe provider request", async () => {
    const requests: CompletionRequest[] = [];
    streamMock.mockImplementation(
      async (
        request: CompletionRequest,
        onToken: (token: string) => void,
      ): Promise<CompletionResult> => {
        requests.push({
          ...request,
          messages: request.messages.map((message) => ({ ...message })),
        });
        if (requests.length === 1) {
          jobsHarness.complete();
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              {
                id: "call-plan-step",
                name: "task.update",
                args: { taskId: "t1", state: "in_progress" },
              },
            ],
            finishReason: "tool_calls",
          };
        }

        expect(jobsHarness.notification.deliveryStartedAt).toBeTruthy();
        if (requests.length === 2) {
          expect(jobsHarness.notification.readAt).toBeUndefined();
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              {
                id: "call-read-responder",
                name: "job.read",
                args: { jobId: jobsHarness.notification.jobId },
              },
            ],
            finishReason: "tool_calls",
          };
        }
        onToken("done");
        return {
          text: "done",
          provider: "openai",
          model: "gpt-test",
          finishReason: "stop",
        };
      },
    );

    const [{ runAgentTurn }, { createSessionPolicy }] = await Promise.all([
      import("../src/agent/runner.js"),
      import("../src/agent/session-policy.js"),
    ]);
    let history = [] as Array<{ role: string; content: string }>;
    const outcome = await runAgentTurn("continue autonomous work", {
      provider: "openai",
      model: "gpt-4o-mini",
      maxSteps: 4,
      session: createSessionPolicy("inband-session"),
      onEvent: () => undefined,
      onMessages: (messages) => {
        history = messages;
      },
    });

    expect(outcome.answer).toBe("done");
    expect(requests).toHaveLength(3);
    const latestInbox = (
      messages: Array<{ role: string; content: string }>,
    ): { content: string } | undefined =>
      [...messages]
        .reverse()
        .find(
          (message) =>
            message.role === "system" &&
            message.content.startsWith("RESPONDER / DURABLE JOB INBOX"),
        );
    const inbox = latestInbox(requests[1]!.messages);
    expect(inbox?.content).toContain("notification=completion:inband-job");
    expect(inbox?.content).toContain("MANDATORY READ RECEIPT");
    expect(latestInbox(requests[2]!.messages)?.content).toBe(
      "RESPONDER / DURABLE JOB INBOX\n(cleared)",
    );
    expect(jobsHarness.manager.markDelivered).toHaveBeenCalledTimes(1);
    expect(jobsHarness.manager.markRead).toHaveBeenCalledWith(
      jobsHarness.notification.id,
      "inband-session",
    );
    expect(jobsHarness.manager.markRead).toHaveBeenCalledTimes(1);
    expect(jobsHarness.notification.readAt).toBeTruthy();
    expect(jobsHarness.manager.markAnalyzed).not.toHaveBeenCalled();
    const readReceiptInNextRequest = requests[2]!.messages.find(
      (message) =>
        message.role === "tool" && message.toolCallId === "call-read-responder",
    );
    expect(readReceiptInNextRequest).toMatchObject({
      name: "job.read",
      ok: true,
    });
    expect(readReceiptInNextRequest?.content).toContain(
      "marked delivered and read after model analysis",
    );
    expect(readReceiptInNextRequest?.content).not.toMatch(
      /No stored body|\[context-note\]/i,
    );
    expect(
      history.find((message) =>
        message.content.startsWith(
          "RESPONDER RESULT LEDGER (authoritative consumed results)",
        ),
      )?.content,
    ).toContain("notification=completion:inband-job");
  });

  it("suppresses repeated Responder-only shell.jobs polls with visible receipts", async () => {
    jobsHarness.startRunning();
    const events: AgentEvent[] = [];
    let requestCount = 0;
    streamMock.mockImplementation(
      async (
        _request: CompletionRequest,
        onToken: (token: string) => void,
      ): Promise<CompletionResult> => {
        requestCount += 1;
        if (requestCount <= 4) {
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              {
                id: `call-jobs-${requestCount}`,
                name: "shell.jobs",
                args: {},
              },
            ],
            finishReason: "tool_calls",
          };
        }
        onToken("continued without polling");
        return {
          text: "continued without polling",
          provider: "openai",
          model: "gpt-test",
          finishReason: "stop",
        };
      },
    );

    const [{ runAgentTurn }, { createSessionPolicy }] = await Promise.all([
      import("../src/agent/runner.js"),
      import("../src/agent/session-policy.js"),
    ]);
    const outcome = await runAgentTurn("continue autonomous work", {
      provider: "openai",
      model: "gpt-4o-mini",
      maxSteps: 6,
      session: createSessionPolicy("inband-session"),
      onEvent: (event) => events.push(event),
    });

    expect(outcome.answer).toContain("Stopped an identical action cycle");
    expect(outcome.answer).toContain("shell.jobs");
    const calls = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool-call" }> =>
        event.type === "tool-call" && event.name === "shell.jobs",
    );
    const starts = events.filter(
      (event) => event.type === "tool-start" && calls.some((call) => call.id === event.id),
    );
    const outputs = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool-output" }> =>
        event.type === "tool-output" && calls.some((call) => call.id === event.id),
    );
    const results = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool-result" }> =>
        event.type === "tool-result" && calls.some((call) => call.id === event.id),
    );

    expect(calls).toHaveLength(2);
    expect(starts).toHaveLength(2);
    expect(outputs).toHaveLength(2);
    expect(results).toHaveLength(2);
    expect(outputs.every((event) => event.chunk.trim().length > 0)).toBe(true);
    expect(outputs[0]!.chunk).toContain("was not dispatched");
    expect(outputs[1]!.chunk).toContain("was not dispatched");
    expect(results.every((event) => event.ok)).toBe(true);
  });

  it("executes repeated shell.jobs polling without sequence suppression", async () => {
    jobsHarness.startNormal();
    const events: AgentEvent[] = [];
    let requestCount = 0;
    streamMock.mockImplementation(
      async (
        _request: CompletionRequest,
        onToken: (token: string) => void,
      ): Promise<CompletionResult> => {
        requestCount += 1;
        if (requestCount <= 4) {
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              {
                id: `call-sequence-jobs-${requestCount}`,
                name: "shell.jobs",
                args: {},
              },
            ],
            finishReason: "tool_calls",
          };
        }
        onToken("done");
        return {
          text: "done",
          provider: "openai",
          model: "gpt-test",
          finishReason: "stop",
        };
      },
    );

    const [{ runAgentTurn }, { createSessionPolicy }] = await Promise.all([
      import("../src/agent/runner.js"),
      import("../src/agent/session-policy.js"),
    ]);
    await runAgentTurn("check the normal server", {
      provider: "openai",
      model: "gpt-4o-mini",
      maxSteps: 5,
      session: createSessionPolicy("inband-session"),
      onEvent: (event) => events.push(event),
    });

    expect(jobsHarness.manager.listJobs).toHaveBeenCalledTimes(4);
    const calls = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool-call" }> =>
        event.type === "tool-call" && event.name === "shell.jobs",
    );
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      const output = events.find(
        (event): event is Extract<AgentEvent, { type: "tool-output" }> =>
          event.type === "tool-output" && event.id === call.id,
      );
      expect(output?.chunk).toContain("normal-server-job");
      expect(output?.chunk).not.toContain("same action sequence already ran");
    }
  });

  it("keeps a state-identical normal-job suppression visible after a failed sibling", async () => {
    jobsHarness.startNormal();
    const events: AgentEvent[] = [];
    let requestCount = 0;
    streamMock.mockImplementation(
      async (
        _request: CompletionRequest,
        onToken: (token: string) => void,
      ): Promise<CompletionResult> => {
        requestCount += 1;
        if (requestCount === 1) {
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              {
                id: "call-normal-jobs-1",
                name: "shell.jobs",
                args: {},
              },
              {
                id: "call-missing-read",
                name: "fs.read",
                args: { path: "/definitely/missing/responder-poll-policy" },
              },
            ],
            finishReason: "tool_calls",
          };
        }
        if (requestCount === 2) {
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              {
                id: "call-normal-jobs-2",
                name: "shell.jobs",
                args: {},
              },
            ],
            finishReason: "tool_calls",
          };
        }
        onToken("done");
        return {
          text: "done",
          provider: "openai",
          model: "gpt-test",
          finishReason: "stop",
        };
      },
    );

    const [{ runAgentTurn }, { createSessionPolicy }] = await Promise.all([
      import("../src/agent/runner.js"),
      import("../src/agent/session-policy.js"),
    ]);
    await runAgentTurn("check the normal server", {
      provider: "openai",
      model: "gpt-4o-mini",
      maxSteps: 5,
      session: createSessionPolicy("inband-session"),
      onEvent: (event) => events.push(event),
    });

    expect(jobsHarness.manager.listJobs.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(jobsHarness.manager.listJobs.mock.calls.length).toBeLessThanOrEqual(2);
    const calls = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool-call" }> =>
        event.type === "tool-call" && event.name === "shell.jobs",
    );
    expect(calls).toHaveLength(2);
    const secondOutput = events.find(
      (event): event is Extract<AgentEvent, { type: "tool-output" }> =>
        event.type === "tool-output" && event.id === calls[1]!.id,
    );
    expect(secondOutput?.chunk.trim()).toBeTruthy();
    expect(secondOutput?.chunk).toMatch(
      /normal-server-job|identical arguments|state change/i,
    );
  });
});


describe("standalone responder report continuation", () => {
  beforeEach(() => {
    streamMock.mockReset();
    jobsHarness.reset();
  });

  it("does not defer the final report because of the receipt currently being analyzed", async () => {
    const sessionId = "inband-session";
    const [{ createPlan, savePlan, deletePlan }, { createSessionPolicy }, { runAgentTurn }] =
      await Promise.all([
        import("../src/store/plan.js"),
        import("../src/agent/session-policy.js"),
        import("../src/agent/runner.js"),
      ]);
    const plan = createPlan({
      sessionId,
      goal: "assessment",
      detail: "analyze then report",
      kind: "pentest",
      taskTitles: ["Enumerate endpoints", "Compile final report"],
    });
    plan.status = "in_progress";
    plan.tasks[0]!.state = "done";
    plan.tasks[1]!.state = "pending";
    await savePlan(plan);
    jobsHarness.prepareWake();
    const abort = new AbortController();
    const requests: CompletionRequest[] = [];
    streamMock.mockImplementation(
      async (request: CompletionRequest): Promise<CompletionResult> => {
        requests.push({
          ...request,
          messages: request.messages.map((message) => ({ ...message })),
        });
        if (requests.length === 1) {
          return {
            text: "Confirmed IDOR on /api/users/{id}; another user's record was accessible.",
            provider: "openai",
            model: "gpt-test",
            finishReason: "stop",
          };
        }
        if (requests.length === 2) {
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              {
                id: "call-read-responder",
                name: "task.read",
                args: { notificationId: jobsHarness.notification.id },
              },
            ],
            finishReason: "tool_calls",
          };
        }
        abort.abort();
        throw abort.signal.reason;
      },
    );
    const policy = createSessionPolicy(sessionId);
    policy.planApproved.value = true;

    try {
      const outcome = await runAgentTurn(
        [
          "Responder result arrived while the model was idle.",
          "notification=completion:inband-job",
          "job=inband-job",
        ].join("\n"),
        {
          provider: "openai",
          model: "gpt-4o-mini",
          maxSteps: 4,
          signal: abort.signal,
          displayPrompt: null,
          session: policy,
          onEvent: () => undefined,
        },
      );

      expect(outcome.status).toBe("aborted");
      expect(requests).toHaveLength(3);
      expect(
        requests[1]?.messages.some(
          (message) =>
            message.role === "user" &&
            message.content.includes("MUST call job.read"),
        ),
      ).toBe(true);
      expect(
        requests[2]?.messages.some(
          (message) =>
            message.role === "system" &&
            message.content.includes("Compile final report"),
        ),
      ).toBe(true);
    } finally {
      await deletePlan(sessionId);
    }
  });

  it("settles an exact stale internal wake without retrying an impossible read", async () => {
    const [{ createSessionPolicy }, { runAgentTurn }] = await Promise.all([
      import("../src/agent/session-policy.js"),
      import("../src/agent/runner.js"),
    ]);
    const requests: CompletionRequest[] = [];
    streamMock.mockImplementation(
      async (request: CompletionRequest): Promise<CompletionResult> => {
        requests.push(request);
        if (requests.length === 1) {
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              {
                id: "call-read-stale",
                name: "job.read",
                args: { notificationId: jobsHarness.notification.id },
              },
            ],
            finishReason: "tool_calls",
          };
        }
        return {
          text: "The cancelled scan was discarded.",
          provider: "openai",
          model: "gpt-test",
          finishReason: "stop",
        };
      },
    );

    const outcome = await runAgentTurn(
      [
        "Responder result arrived while the model was idle.",
        `notification=${jobsHarness.notification.id}`,
        `job=${jobsHarness.notification.jobId}`,
        "resultRevision=1",
      ].join("\n"),
      {
        provider: "openai",
        model: "gpt-4o-mini",
        maxSteps: 3,
        displayPrompt: null,
        session: createSessionPolicy("inband-session"),
        onEvent: () => undefined,
      },
    );

    expect(outcome.status).toBe("succeeded");
    expect(outcome.answer).toContain("cancelled scan was discarded");
    expect(requests).toHaveLength(2);
    expect(jobsHarness.manager.markRead).not.toHaveBeenCalled();
  });
});
