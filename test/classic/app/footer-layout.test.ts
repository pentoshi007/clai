import type { RunTurnHandlers } from "../../../src/app/ports/agent-port.js";
import { createTurnOutcome } from "../../../src/agent/turn-outcome.js";
import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { ClassicApp } from "../../../src/classic/app/ClassicApp.js";
import { ServicesProvider } from "../../../src/ui-core/react/providers.js";
import { createHarness, type Harness } from "./harness.js";

let harness: Harness | undefined;
let ui: ReturnType<typeof render> | undefined;

afterEach(() => {
  ui?.unmount();
  ui?.cleanup();
  harness?.dispose();
  ui = undefined;
  harness = undefined;
});

it.each([[40, 12], [80, 24], [120, 40], [160, 50]])("keeps classic footer on the last row at %i×%i", async (columns, rows) => {
  harness = createHarness({ columns, rows });
  ui = render(createElement(ServicesProvider, {
    services: harness.services, children: createElement(ClassicApp, { wiring: harness.wiring }),
  }));
  await vi.waitFor(() => {
    const frame = ui!.lastFrame()!.split("\n");
    expect(frame).toHaveLength(rows);
    expect(frame[rows - 1]).toMatch(/AGENT/);
  });
  harness.wiring.composer.setText("draft line\n".repeat(8));
  await vi.waitFor(() => {
    const frame = ui!.lastFrame()!.split("\n");
    expect(frame).toHaveLength(rows);
    expect(frame[rows - 1]).toMatch(/AGENT/);
  });
});

it.each([40, 80])("renders live, exact, idle, and next-turn TPS below the classic composer at %i columns", async (columns) => {
  let handlers: RunTurnHandlers | undefined;
  let finish: (() => void) | undefined;
  const h = createHarness({
    columns, rows: 24,
    agent: {
      async runTurn(_request, next) {
        handlers = next;
        await new Promise<void>((resolve) => { finish = resolve; });
        return createTurnOutcome({ status: "succeeded", answer: "done", steps: 1, remainingCriteria: [] });
      },
    },
  });
  harness = h;
  const rendered = render(createElement(ServicesProvider, {
    services: h.services, children: createElement(ClassicApp, { wiring: h.wiring }),
  }));
  ui = rendered;
  const footer = () => rendered.lastFrame()!.split("\n")[23]!;
  let pending = h.services.session.submit("measure generation");
  try {
    await vi.waitFor(() => expect(handlers).toBeDefined());
    handlers!.onEvent?.({ type: "generation-progress", metrics: { outputTokens: 100, durationMs: 2_000, estimated: true } });
    await vi.waitFor(() => expect(footer()).toContain("~50.0 tps"));
    expect(h.services.session.getState().running).toBe(true);
    handlers!.onEvent?.({ type: "generation-completed", metrics: { outputTokens: 123, durationMs: 2_000 } });
    finish?.();
    await pending;
    await vi.waitFor(() => expect(footer()).toContain("61.5 tps"));
    expect(footer()).not.toMatch(/~|tok\/s/);
    handlers = undefined;
    pending = h.services.session.submit("next generation");
    await vi.waitFor(() => expect(handlers).toBeDefined());
    expect(footer()).toContain("61.5 tps");
    handlers!.onEvent?.({ type: "generation-progress", metrics: { outputTokens: 80, durationMs: 2_000, estimated: true } });
    await vi.waitFor(() => expect(footer()).toContain("~40.0 tps"));
  } finally {
    finish?.();
    await pending;
  }
});
