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
