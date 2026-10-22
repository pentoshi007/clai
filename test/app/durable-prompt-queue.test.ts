import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import { createCurrentPersistencePort } from "../../src/app/adapters/current-store-adapter.js";
import { createCurrentAgentPort } from "../../src/app/adapters/current-agent-adapter.js";
import { installTransport } from "../conformance/fake-transport.js";
import type { AgentPort, RunTurnHandlers, RunTurnRequest } from "../../src/app/ports/agent-port.js";
import type { PersistencePort } from "../../src/app/ports/persistence-port.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { loadQueuedPrompts } from "../../src/store/session-queue.js";
import { getConfig, updateConfig } from "../../src/store/config.js";

const sessions: SessionController[] = [];
const succeeded = () => createTurnOutcome({ status: "succeeded", answer: "done", steps: 1, remainingCriteria: [] });
const persistence = (): PersistencePort => ({ ...createCurrentPersistencePort(), async saveSession() {} });
const defaultAgent: AgentPort = { reportsModelSubmission: true, async runTurn(_request, handlers) {
  handlers.onEvent({ type: "model-submitted" });
  return succeeded();
} };
function session(id: string, agent = defaultAgent, port = persistence(), noHistory = false) {
  const notices: string[] = [];
  const value = new SessionController({ sessionId: id, agent, persistence: port, noHistory,
    emit: (event) => { if (event.type === "notice") notices.push(event.payload.text); },
  });
  sessions.push(value);
  return { value, notices };
}
function heldAgent() {
  let active: { request: RunTurnRequest; handlers: RunTurnHandlers } | undefined;
  const port: AgentPort = { reportsModelSubmission: true, async runTurn(request, handlers) {
    active = { request, handlers };
    await new Promise<void>((_resolve, reject) => {
      handlers.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    return succeeded();
  } };
  return { port, active: () => active };
}
const pending = (id: string) => loadQueuedPrompts(id).map((entry) => entry.text);
afterEach(() => { for (const value of sessions.splice(0)) value.dispose(); vi.unstubAllGlobals(); });

describe("durable queued prompts", () => {
  it("consumes through the real runner/provider path as soon as HTTP accepts the request", async () => {
    const transport = installTransport(() => new Response(new ReadableStream<Uint8Array>(),
      { headers: { "content-type": "application/x-ndjson" } }));
    const value = session("durable-wire", createCurrentAgentPort()).value;
    value.setProvider("ollama");
    value.setModel("fixture-model");
    value.enqueue("respond briefly");
    value.sendQueuedNow(0);
    try {
      await vi.waitFor(() => expect(transport.generations.length).toBeGreaterThan(0));
      await vi.waitFor(() => expect(pending(value.sessionId)).toEqual([]));
      expect(value.getState().running).toBe(true);
      expect(session(value.sessionId).value.queued()).toEqual([]);
    } finally { value.dispose(); }
  });

  it("saves enqueue/edit/reorder/cancel synchronously and restores only the resumed session", () => {
    const { value } = session("durable-edits");
    value.enqueue("first");
    value.enqueue("second", { displayPrompt: "visible second" });
    value.enqueue("cancel this");
    value.editQueued(0, "first edited");
    value.reorderQueued(1, 0);
    value.removeQueued(2);
    expect(pending(value.sessionId)).toEqual(["second", "first edited"]);
    value.dispose();
    const resumed = session("durable-edits").value;
    expect(resumed.queued()).toEqual(["second", "first edited"]);
    expect(loadQueuedPrompts(resumed.sessionId)[0]?.displayPrompt).toBe("visible second");
    expect(session("durable-other").value.queued()).toEqual([]);
    resumed.editQueued(0, "   ");
    expect(pending(resumed.sessionId)).toEqual(["first edited"]);
  });

  it("keeps a dequeued prompt durable while setup waits, including after shutdown", async () => {
    const agent = heldAgent();
    const value = session("durable-setup", agent.port).value;
    value.enqueue("must reach the model");
    value.sendQueuedNow(0);
    await vi.waitFor(() => expect(agent.active()?.request.prompt).toBe("must reach the model"));
    expect(value.queued()).toEqual([]);
    expect(pending(value.sessionId)).toEqual(["must reach the model"]);
    value.dispose();
    expect(session("durable-setup").value.queued()).toEqual(["must reach the model"]);
  });

  it("consumes only the accepted entry, immediately and exactly once, before generation finishes", async () => {
    const agent = heldAgent();
    const value = session("durable-consumed", agent.port).value;
    value.enqueue("identical prompt");
    value.enqueue("identical prompt");
    value.sendQueuedNow(1);
    await vi.waitFor(() => expect(agent.active()).toBeDefined());
    expect(pending(value.sessionId)).toHaveLength(2);
    agent.active()!.handlers.onEvent({ type: "model-submitted" });
    agent.active()!.handlers.onEvent({ type: "model-submitted" });
    expect(pending(value.sessionId)).toEqual(["identical prompt"]);
    value.dispose();
    expect(session("durable-consumed").value.queued()).toEqual(["identical prompt"]);
  });

  it.each(["error", "abort", "no-dispatch"])("retains and pauses an unsubmitted entry on %s", async (failure) => {
    const agent: AgentPort = { reportsModelSubmission: true, async runTurn() {
      if (failure === "error") throw new Error("setup failed");
      if (failure === "abort") throw new DOMException("aborted", "AbortError");
      return succeeded();
    } };
    const id = `durable-${failure}`;
    const value = session(id, agent).value;
    value.enqueue("retry me");
    value.enqueue("later");
    const results = await value.drain();
    expect(results).toHaveLength(1);
    expect(value.queued()).toEqual(["retry me", "later"]);
    expect(session(id).value.queued()).toEqual(["retry me", "later"]);
  });

  it("does not replay a submitted prompt when the stream fails afterward", async () => {
    const agent: AgentPort = { reportsModelSubmission: true, async runTurn(_request, handlers) {
      handlers.onEvent({ type: "model-submitted" });
      throw new Error("stream disconnected");
    } };
    const value = session("durable-stream-failed", agent).value;
    value.enqueue("sent");
    value.enqueue("not sent");
    await value.drain();
    expect(value.queued()).toEqual(["not sent"]);
    expect(session(value.sessionId).value.queued()).toEqual(["not sent"]);
  });

  it("retains a prompt moved into the composer and consumes its edited replacement only on submission", async () => {
    const value = session("durable-composer").value;
    value.enqueue("original");
    expect(value.takeQueued(0)).toBe("original");
    expect(value.queued()).toEqual([]);
    expect(pending(value.sessionId)).toEqual(["original"]);
    expect(session(value.sessionId).value.queued()).toEqual(["original"]);
    await value.submit("edited replacement");
    expect(pending(value.sessionId)).toEqual([]);
    expect(session(value.sessionId).value.queued()).toEqual([]);
  });

  it("keeps old-session queues on a new-session reset and cancels on an explicit same-session reset", () => {
    const value = session("durable-switch").value;
    value.enqueue("old session only");
    value.reset({ mintNewId: true });
    expect(value.queued()).toEqual([]);
    expect(pending("durable-switch")).toEqual(["old session only"]);
    value.loadHistory([], { sessionId: "durable-switch" });
    expect(value.queued()).toEqual(["old session only"]);
    value.reset();
    expect(session("durable-switch").value.queued()).toEqual([]);
  });

  it("honors no-history and private mode without reading or altering stored prompts", () => {
    const port = persistence();
    const load = vi.spyOn(port, "loadQueuedPrompts");
    const save = vi.spyOn(port, "saveQueuedPrompts");
    session("durable-no-history", defaultAgent, port, true).value.enqueue("private");
    const previous = getConfig().privateMode;
    try {
      updateConfig({ privateMode: true });
      session("durable-private", defaultAgent, port).value.enqueue("also private");
      expect(load).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    } finally { updateConfig({ privateMode: previous }); }
  });

  it.each(["idle", "in-flight", "editing", "submitted"])("preserves unsent prompts through graceful shutdown while %s", async (stage) => {
    const agent = heldAgent();
    const value = session(`durable-shutdown-${stage}`, agent.port).value;
    value.enqueue("first unsent prompt");
    value.enqueue("second unsent prompt");
    if (stage === "editing") value.takeQueued(0);
    if (stage === "in-flight" || stage === "submitted") {
      value.sendQueuedNow(0);
      await vi.waitFor(() => expect(agent.active()).toBeDefined());
      if (stage === "submitted") agent.active()!.handlers.onEvent({ type: "model-submitted" });
    }
    await value.shutdown();
    value.dispose();
    const expected = stage === "submitted" ? ["second unsent prompt"] : ["first unsent prompt", "second unsent prompt"];
    expect(pending(value.sessionId)).toEqual(expected);
    expect(session(value.sessionId).value.queued()).toEqual(expected);
  });

  it("reports persistence failures instead of silently claiming durability", () => {
    const port = persistence();
    port.saveQueuedPrompts = () => { throw new Error("disk full"); };
    const { value, notices } = session("durable-io-error", defaultAgent, port);
    value.enqueue("still visible");
    expect(value.queued()).toEqual(["still visible"]);
    expect(notices).toContain("could not save queued prompts: disk full");
  });
});
