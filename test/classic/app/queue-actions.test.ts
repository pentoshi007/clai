import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionRouter } from "../../../src/ui-core/actions/action-router.js";
import { createHarness, type Harness } from "./harness.js";

let harness: Harness | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

function withQueue(prompts: readonly string[]): Harness {
  harness = createHarness({ agent: { runTurn: async () => "" } });
  for (const prompt of prompts) harness.services.session.enqueue(prompt);
  return harness;
}

describe("queued prompt chords (W12)", () => {
  it("binds every queue action advertised in the queue header", () => {
    const router = new ActionRouter();
    expect(router.resolve("ctrl+alt+up", "composer")).toBe("queue.select-prev");
    expect(router.resolve("ctrl+alt+down", "composer")).toBe("queue.select-next");
    expect(router.resolve("ctrl+alt+enter", "composer")).toBe("queue.send-now");
    expect(router.resolve("ctrl+alt+e", "composer")).toBe("queue.edit");
    expect(router.resolve("ctrl+alt+backspace", "composer")).toBe("queue.remove");
  });

  it("wraps the selection in both directions", async () => {
    const { wiring, services } = withQueue(["one", "two", "three"]);
    expect(services.session.getState().queued).toHaveLength(3);
    wiring.actions.handle("queue.select-next", "ctrl+alt+down", { name: "down" });
    await vi.waitFor(() => expect(wiring.getSnapshot().queueSelected).toBe(1));
    wiring.actions.handle("queue.select-prev", "ctrl+alt+up", { name: "up" });
    wiring.actions.handle("queue.select-prev", "ctrl+alt+up", { name: "up" });
    await vi.waitFor(() => expect(wiring.getSnapshot().queueSelected).toBe(2));
  });

  it("send-now pulls the selected prompt out of the queue and sends it", async () => {
    const { wiring, services } = withQueue(["first", "second"]);
    wiring.actions.handle("queue.select-next", "ctrl+alt+down", { name: "down" });
    wiring.actions.handle("queue.send-now", "ctrl+alt+enter", { name: "return" });
    await vi.waitFor(() =>
      expect(services.session.getState().queued).not.toContain("second"),
    );
    await vi.waitFor(() => expect(wiring.getSnapshot().queueSelected).toBe(0));
  });

  it("edit takes the prompt out of the queue and into the composer", async () => {
    const { wiring, services } = withQueue(["fix the tests"]);
    wiring.actions.handle("queue.edit", "ctrl+alt+e", { name: "e" });
    expect(services.session.getState().queued).toHaveLength(0);
    await vi.waitFor(() =>
      expect(wiring.getSnapshot().composer.state.text).toBe("fix the tests"),
    );
  });

  it("remove drops the selected prompt", () => {
    const { wiring, services } = withQueue(["keep", "drop"]);
    wiring.actions.handle("queue.select-next", "ctrl+alt+down", { name: "down" });
    wiring.actions.handle("queue.remove", "ctrl+alt+backspace", { name: "backspace" });
    expect(services.session.getState().queued).toHaveLength(1);
    expect(services.session.getState().queued[0]).toContain("keep");
  });

  it("reports an empty queue instead of acting on nothing", () => {
    const { wiring, toastTexts } = withQueue([]);
    wiring.actions.handle("queue.remove", "ctrl+alt+backspace", { name: "backspace" });
    expect(toastTexts().some((text) => text.includes("no queued prompts"))).toBe(true);
  });
});
