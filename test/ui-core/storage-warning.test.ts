import { expect, it } from "vitest";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { createTurnEventEmitter } from "../../src/agent/turn/event-emitter.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";

it("shows output-storage warnings in shared UI toasts and session events", async () => {
  const warning = "Storage quota exceeded (EDQUOT). Free space or choose a writable TMPDIR.";
  const services = createCompositionRoot({
    noHistory: true,
    captureEvents: true,
    provider: "openai",
    model: "offline-test",
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
    agent: {
      async runTurn(_request, handlers) {
        handlers.onEvent({ type: "turn-start", prompt: "run a command" });
        const emitter = createTurnEventEmitter({ emit: handlers.onEvent }, { visibleCommitted: false });
        emitter.writeToolCall("storage-tool", { name: "shell.exec", args: { command: "printf ok" } });
        emitter.emitToolResult("storage-tool", { ok: true, output: "ok", warning }, "ok");
        const outcome = createTurnOutcome({ status: "succeeded", answer: "done", steps: 1, remainingCriteria: [] });
        handlers.onEvent({ type: "turn-end", outcome, finalAnswer: "done", steps: 1 });
        return outcome;
      },
    },
  });
  try {
    await services.session.submit("run a command");
    expect(services.toast.getToasts()).toContainEqual(expect.objectContaining({ level: "warn", message: warning }));
    expect(services.recordedEvents).toContainEqual(expect.objectContaining({ type: "notice", payload: { level: "warn", text: warning } }));
  } finally {
    services.dispose();
  }
});
