import { describe, expect, it, vi } from "vitest";
import { TurnController } from "../../src/app/controllers/turn-controller.js";
import { OutputSpool } from "../../src/app/events/event-buffer.js";
import { EventSequencer } from "../../src/app/events/sequencer.js";
import type { AgentPort } from "../../src/app/ports/agent-port.js";
import {
  getAllThinking,
  getLastThinking,
  rememberThinking,
} from "../../src/ui/thinking.js";

describe("TurnController thinking retention", () => {
  it("does not accumulate prior turns' reasoning across turns", async () => {
    const spool = new OutputSpool();
    const sequencer = new EventSequencer();
    const emit = (): void => {};
    const agent: AgentPort = {
      runTurn: async (_request, options) => {
        options.onEvent?.({ type: "assistant-delta", text: "ok" } as never);
        return { kind: "final", text: "done" } as never;
      },
    } as unknown as AgentPort;

    const controller = new TurnController({
      agent,
      sequencer,
      spool,
      emit,
    });

    rememberThinking("reasoning from a prior turn that must not persist");
    expect(getAllThinking().length).toBeGreaterThan(0);

    await controller.run({ prompt: "next" } as never);

    expect(getAllThinking()).toEqual([]);
    expect(getLastThinking()).toBe("");
  });

  it("bounds thinking to the current turn even across many sequential turns", async () => {
    const spool = new OutputSpool();
    const sequencer = new EventSequencer();
    const emit = (): void => {};
    const agent: AgentPort = {
      runTurn: async (_request, options) => {
        options.onEvent?.({ type: "assistant-delta", text: "ok" } as never);
        return { kind: "final", text: "done" } as never;
      },
    } as unknown as AgentPort;

    const controller = new TurnController({
      agent,
      sequencer,
      spool,
      emit,
    });

    for (let turn = 0; turn < 500; turn += 1) {
      rememberThinking(`distinct reasoning block ${turn}`);
    }
    await controller.run({ prompt: "x" } as never);
    await controller.run({ prompt: "y" } as never);

    expect(getAllThinking()).toEqual([]);
  });
});
