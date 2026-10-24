import { describe, expect, it, vi } from "vitest";
import { TurnController } from "../../src/app/controllers/turn-controller.js";
import { OutputSpool } from "../../src/app/events/event-buffer.js";
import { EventSequencer } from "../../src/app/events/sequencer.js";
import type { AnyAppEvent } from "../../src/app/events/app-event.js";
import type { RunTurnRequest } from "../../src/app/ports/agent-port.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";

const request: RunTurnRequest = { prompt: "inspect file:///tmp/image.png", displayPrompt: "inspect [Image 1]", mode: "agent" };

function setup() {
  const events: AnyAppEvent[] = [];
  const runTurn = vi.fn(async () => createTurnOutcome({ status: "succeeded", answer: "done", steps: 1, remainingCriteria: [] }));
  const controller = new TurnController({
    agent: { runTurn },
    sequencer: new EventSequencer(),
    spool: new OutputSpool(),
    emit: (event) => events.push(event),
  });
  return { controller, events, runTurn };
}

function preparationGate() {
  let release!: (request: RunTurnRequest) => void;
  const prepared = new Promise<RunTurnRequest>((resolve) => { release = resolve; });
  return { prepared, release };
}

describe("asynchronous turn preparation", () => {
  it("reserves the turn and publishes the prompt before preparing the model request", async () => {
    const { controller, events, runTurn } = setup();
    const gate = preparationGate();
    const pending = controller.run(request, { prepareRequest: () => gate.prepared });
    expect(controller.running).toBe(true);
    expect(events.filter((event) => event.type === "turn-started")).toMatchObject([
      { payload: { prompt: request.prompt, displayPrompt: "inspect [Image 1]" } },
    ]);
    expect(runTurn).not.toHaveBeenCalled();
    await expect(controller.run(request)).rejects.toThrow("a turn is already running");
    gate.release(request);
    expect((await pending).status).toBe("completed");
    expect(runTurn).toHaveBeenCalledOnce();
    expect(controller.running).toBe(false);
  });

  it("does not submit or acknowledge a turn cancelled during preparation", async () => {
    const { controller, events, runTurn } = setup();
    const gate = preparationGate();
    const onSubmitted = vi.fn();
    const pending = controller.run(request, { prepareRequest: () => gate.prepared, onSubmitted });
    controller.abort();
    gate.release(request);
    expect((await pending).status).toBe("aborted");
    expect(runTurn).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "turn-started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn-aborted")).toHaveLength(1);
    expect(controller.running).toBe(false);
  });

  it("settles a preparation failure and permits a later turn", async () => {
    const { controller, events, runTurn } = setup();
    const result = await controller.run(request, { prepareRequest: async () => { throw new Error("image disappeared"); } });
    expect(result).toMatchObject({ status: "error", error: { message: "image disappeared" } });
    expect(events.filter((event) => event.type === "turn-error")).toMatchObject([
      { payload: { message: "image disappeared" } },
    ]);
    expect(runTurn).not.toHaveBeenCalled();
    expect(controller.running).toBe(false);
    expect((await controller.run(request)).status).toBe("completed");
    expect(runTurn).toHaveBeenCalledOnce();
  });
});
