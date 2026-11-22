import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createCurrentAgentPort } from "../src/app/adapters/current-agent-adapter.js";
import { createCurrentJobsPort } from "../src/app/adapters/current-jobs-adapter.js";
import { SessionController } from "../src/app/controllers/session-controller.js";
import type { TurnResult } from "../src/app/controllers/turn-controller.js";
import { RESPONDER_CONTEXT_PREFIX, RESPONDER_RESULT_LEDGER_PREFIX } from "../src/agent/responder-context.js";
import { ProviderError } from "../src/llm/http.js";
import { jobManager } from "../src/tools/jobs.js";
import type { ChatMessage, CompletionRequest, CompletionResult } from "../src/types.js";

const stream = vi.hoisted(() => vi.fn<(request: CompletionRequest) => Promise<CompletionResult>>());

vi.mock("../src/llm/router.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/llm/router.js")>(),
  streamWithProvider: stream,
}));
vi.mock("../src/commands/providers.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/commands/providers.js")>(),
  ensureProviderConfigured: async () => undefined,
}));
vi.mock("../src/llm/catalog-prefetch.js", () => ({ prefetchProviderCatalog: async () => undefined }));

const digest = "The fixture completed successfully and wrote its expected output.";
const nextStep = {
  text: "", provider: "openai", model: "gpt-4o-mini", finishReason: "tool_calls",
  toolCalls: [{ id: "fixture-step", name: "task.update", args: { taskId: "t1", state: "in_progress" } }],
} satisfies CompletionResult;

function finalAnswer(provider: "openai" | "anthropic", model: string, text: string): CompletionResult {
  return {
    provider, model, text, finishReason: "stop",
    toolCalls: [{ id: "finish", name: "turn.end", args: { reason: "answered" } }],
  };
}

async function completedJob(sessionId: string): Promise<string> {
  const started = await jobManager.startJob({
    command: process.execPath,
    argv: ["-e", "console.log('responder fixture output')"],
  }, { ownerSessionId: sessionId, responder: true, wakeOnCompletion: true });
  const id = started.backgroundJob?.id;
  if (!id) throw new Error(started.output);
  await vi.waitFor(() => expect(jobManager.getPendingNotifications(sessionId)).toEqual([
    expect.objectContaining({ jobId: id, exitCode: 0 }),
  ]), { timeout: 5_000 });
  return id;
}

describe("Responder provider recovery", () => {
  beforeEach(() => {
    stream.mockReset();
    stream.mockRejectedValue(new ProviderError("insufficient credits", 402));
  });

  it.each(["foreground", "idle wake"])("redelivers a completion after the %s request runs out of credits", async (delivery) => {
    const sessionId = `responder-provider-${delivery.replace(" ", "-")}`;
    const saved = vi.fn<(messages: ChatMessage[]) => Promise<void>>().mockResolvedValue(undefined);
    const session = new SessionController({
      sessionId, provider: "openai", model: "gpt-4o-mini",
      agent: createCurrentAgentPort(), jobs: createCurrentJobsPort(), emit: () => undefined,
      persistence: { saveSession: saved, loadPlan: async () => undefined, savePlan: async () => {}, deletePlan: async () => {} },
    });
    onTestFinished(() => session.dispose());
    const ends = vi.fn<(result: TurnResult) => void>();
    session.onTurnEnd(ends);
    let jobId: string;
    if (delivery === "foreground") {
      let completed: string | undefined;
      stream.mockImplementationOnce(async () => { completed = await completedJob(sessionId); return nextStep; });
      expect(await session.submit("Keep working on the fixture")).toMatchObject({ status: "error" });
      expect(completed).toBeDefined();
      jobId = completed!;
    } else {
      stream.mockResolvedValueOnce(finalAnswer("openai", "gpt-4o-mini", "Waiting for the fixture."));
      await session.submit("Prepare for the fixture result");
      jobId = await completedJob(sessionId);
      await vi.waitFor(() => expect(ends).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error" })));
    }
    expect(ends).toHaveBeenLastCalledWith(expect.objectContaining({ error: expect.objectContaining({ status: 402 }) }));
    expect(session.getState().responder).toMatchObject({ ready: 1, delivered: 0 });
    const receipt = jobManager.getPendingNotifications(sessionId).find((candidate) => candidate.jobId === jobId);
    if (!receipt) throw new Error(`missing durable receipt for ${jobId}`);
    expect(receipt.deliveryStartedAt).toEqual(expect.any(String));
    expect(receipt.deliveredAt).toBeUndefined();

    const requests: ChatMessage[][] = [];
    const model = "claude-3-5-haiku-20241022";
    session.setProvider("anthropic");
    session.setModel(model);
    stream.mockImplementation(async (request) => {
      expect(request.provider).toBe("anthropic");
      requests.push(request.messages.map((message) => ({ ...message })));
      if (requests.length > 1) return finalAnswer("anthropic", model, digest);
      return { provider: "anthropic", model, text: "", finishReason: "tool_calls",
        toolCalls: [{ id: "acknowledge", name: "job.read", args: { jobId, summary: digest } }] };
    });
    const markRead = vi.spyOn(jobManager, "markRead");
    onTestFinished(() => { markRead.mockRestore(); });

    const resumed = await session.submit("continue");
    expect(requests[1]?.find((message) => message.toolCallId === "acknowledge")).toMatchObject({
      ok: true, content: expect.stringContaining("marked delivered and read after model analysis"),
    });
    expect(resumed).toMatchObject({ status: "completed", finalAnswer: digest });
    const inbox = requests[0]?.find((message) => message.content.startsWith(RESPONDER_CONTEXT_PREFIX));
    expect(inbox?.content).toContain(`job=${jobId} status=exited exit=0`);
    expect(markRead).toHaveBeenCalledExactlyOnceWith(receipt.id, sessionId);
    expect(jobManager.getPendingNotifications(sessionId)).toEqual([]);
    expect(session.getState().responder).toMatchObject({ ready: 0, delivered: 0 });
    const ledger = saved.mock.lastCall?.[0].find((message) => message.content.startsWith(RESPONDER_RESULT_LEDGER_PREFIX));
    expect(ledger?.content).toContain(`job=${jobId} status=exited consumed=true`);
    expect(ledger?.content).toContain(`summary=${JSON.stringify(digest)}`);
  }, 12_000);
});
