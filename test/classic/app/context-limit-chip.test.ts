import { createElement } from "react";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { clearModelCatalogFacts, registerModelCatalogFacts } from "../../../src/llm/capabilities.js";
import { ClassicApp } from "../../../src/classic/app/ClassicApp.js";
import { ServicesProvider } from "../../../src/ui-core/react/providers.js";
import type { MouseEvent } from "../../../src/classic/input/key-event.js";
import { createHarness, type Harness } from "./harness.js";

let harness: Harness | undefined;
let view: ReturnType<typeof render> | undefined;

function mouse(x: number, y: number, overrides: Partial<MouseEvent> = {}): MouseEvent {
  return {
    x, y, button: "left", release: false, drag: false, scroll: undefined,
    ctrl: false, alt: false, shift: false, ...overrides,
  };
}

async function mount(columns = 120): Promise<Harness> {
  harness = createHarness({ columns, commands: true });
  harness.services.session.setProvider("anthropic");
  harness.services.session.setModel("claude-sonnet-4");
  harness.services.session.setContextLimitTokens(undefined);
  registerModelCatalogFacts("anthropic", { id: "claude-sonnet-4", contextTokens: 200_000 });
  view = render(createElement(ServicesProvider, {
    services: harness.services,
    children: createElement(ClassicApp, { wiring: harness.wiring }),
  }));
  await expect.poll(() => harness?.wiring.contextLimitHitRegion).toBeDefined();
  return harness;
}

afterEach(() => {
  view?.unmount();
  harness?.services.session.setContextLimitTokens(undefined);
  harness?.dispose();
  clearModelCatalogFacts();
  harness = undefined;
  view = undefined;
});

describe("Classic context chip", () => {
  it.each([120, 80, 50, 24])("opens the detected limit from the rendered chip at %s columns", async (columns) => {
    const h = await mount(columns);
    const region = h.wiring.contextLimitHitRegion!;
    const frame = view!.lastFrame()!.split("\n");
    expect(frame[region.top]?.slice(region.left, region.left + region.width)).toMatch(/(?:ctx )?0(?:\/200k)?/);
    h.wiring.handleMouse(mouse(region.left, region.top));
    expect(h.wiring.contextLimitEditingValue).toBe(true);
    expect(h.wiring.contextLimitDraftValue).toBe("200000");
    expect(h.services.focus.activeContext()).toBe("composer");
  });

  it("saves above and below the provider default, cancels, and resets without losing the draft", async () => {
    const h = await mount();
    h.wiring.composer.setText("keep this prompt");
    const region = h.wiring.contextLimitHitRegion!;
    h.wiring.handleMouse(mouse(region.left + region.width - 1, region.top));
    h.wiring.handleData("\x15");
    h.wiring.handleData("\x1b[200~500k\x1b[201~");
    h.wiring.handleData("\r");
    expect(h.services.session.getState().contextUsage?.contextLimit).toBe(500_000);
    expect(h.wiring.contextLimitEditingValue).toBe(false);
    await expect.poll(() => view?.lastFrame()).toContain("ctx 0/500k");

    h.wiring.handleData("\x0c");
    h.wiring.handleData("\x15");
    h.wiring.handleData("\x1b[200~100k\x1b[201~");
    h.wiring.handleData("\r");
    expect(h.services.session.getState().contextUsage?.contextLimit).toBe(100_000);

    h.wiring.handleData("\x0c");
    h.wiring.handleData("\x15");
    h.wiring.handleData("\x1b[200~1m\x1b[201~");
    h.wiring.handleData("\x1b");
    await expect.poll(() => h.wiring.contextLimitEditingValue).toBe(false);
    expect(h.services.session.getState().contextUsage?.contextLimit).toBe(100_000);
    expect(h.wiring.contextLimitEditingValue).toBe(false);

    h.wiring.handleData("\x0c");
    h.wiring.handleData("\x15");
    h.wiring.handleData("\x1b[200~10k\x1b[201~");
    h.wiring.handleData("\r");
    expect(h.wiring.contextLimitEditingValue).toBe(true);
    expect(h.services.session.getState().contextUsage?.contextLimit).toBe(100_000);
    expect(h.toastTexts()).toContain("context limit must be at least 20k (for example 253k)");
    await new Promise((resolve) => setTimeout(resolve, 40));
    h.wiring.handleData("\x15");
    h.wiring.handleData("\r");
    await expect.poll(() => h.services.session.getState().contextUsage?.contextLimit).toBe(200_000);
    expect(h.wiring.composer.getSnapshot().state.text).toBe("keep this prompt");
    expect(h.services.focus.activeContext()).toBe("composer");
  });

  it("ignores nearby clicks, drags, releases, other buttons, and blocked overlays", async () => {
    const h = await mount();
    const region = h.wiring.contextLimitHitRegion!;
    for (const event of [
      mouse(region.left - 1, region.top),
      mouse(region.left + region.width, region.top),
      mouse(region.left, region.top - 1),
      mouse(region.left, region.top, { button: "right" }),
      mouse(region.left, region.top, { drag: true }),
      mouse(region.left, region.top, { release: true }),
    ]) {
      h.wiring.handleMouse(event);
      expect(h.wiring.contextLimitEditingValue).toBe(false);
    }
    h.services.overlay.openPicker(
      { title: "Pick", options: [{ value: "a", label: "a", description: "" }] },
      () => undefined,
    );
    h.wiring.handleMouse(mouse(region.left, region.top));
    expect(h.wiring.contextLimitEditingValue).toBe(false);
    await expect.poll(() => h.wiring.contextLimitHitRegion).toBeUndefined();
  });
});
