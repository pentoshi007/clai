import { createElement } from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { PersistencePort } from "../../src/app/ports/persistence-port.js";
import { ClassicApp, statusRowText } from "../../src/classic/app/ClassicApp.js";
import {
  createClassicAppWiring,
  type ClassicAppWiring,
} from "../../src/classic/app/app-wiring.js";
import { allocateChrome } from "../../src/classic/chrome/row-budget.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import {
  createCompositionRoot,
  type AppServices,
} from "../../src/ui-core/bootstrap/composition-root.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";

function fakePersistence(): PersistencePort {
  return {
    async saveSession() {},
    async loadPlan() {
      return undefined;
    },
    async savePlan() {},
    async deletePlan() {},
  };
}

function buildServices(columns = 80): AppServices {
  return createCompositionRoot({
    persistence: fakePersistence(),
    mode: "ask",
    model: "llama-3.3-70b",
    capabilities: detectCapabilities({
      env: {},
      stdoutIsTTY: true,
      stdinIsTTY: true,
      columns,
      rows: 24,
    }),
  });
}

function buildWiring(services: AppServices, columns = 100, rows = 24): ClassicAppWiring {
  return createClassicAppWiring({
    services,
    mouse: false,
    resizeSource: {
      columns,
      rows,
      on: () => undefined,
      off: () => undefined,
    },
  });
}

describe("statusRowText", () => {
  it("shows the mode, model, and exit hint", () => {
    expect(
      statusRowText({ mode: "agent", model: "gpt-oss", running: false, columns: 80 }),
    ).toBe("AGENT · gpt-oss · ctrl+c twice to exit");
  });

  it("reports a missing model", () => {
    expect(
      statusRowText({ mode: "ask", model: undefined, running: false, columns: 80 }),
    ).toContain("no model");
  });

  it("replaces the hint while a turn runs", () => {
    expect(
      statusRowText({ mode: "ask", model: "m", running: true, columns: 80 }),
    ).toBe("ASK · m · working");
  });

  it("never exceeds the usable width", () => {
    for (const columns of [1, 2, 8, 20, 40, 80]) {
      const row = statusRowText({
        mode: "agent",
        model: "a-very-long-model-identifier",
        running: false,
        columns,
      });
      expect(row.length).toBeLessThanOrEqual(Math.max(1, columns - 1));
    }
  });
});

describe("ClassicApp", () => {
  it("renders the chrome at the allocated height with the status row last", () => {
    const services = buildServices();
    const wiring = buildWiring(services);
    const { lastFrame, unmount } = render(
      createElement(ServicesProvider, {
        services,
        children: createElement(ClassicApp, { wiring }),
      }),
    );
    const rows = (lastFrame() ?? "").split("\n");
    const layout = allocateChrome({
      rows: 24,
      columns: 100,
      composerTextRows: 1,
      statusRowsWanted: 1,
      toastCount: 0,
      queueCount: 0,
      responderVisible: false,
      planVisible: false,
      planRowsWanted: 0,
      overlay: undefined,
    });
    expect(rows.length).toBeGreaterThanOrEqual(layout.total);
    expect(layout).toBeDefined();
    // The full-height allocator intentionally fills the terminal exactly.
    expect(layout.total).toBe(24);
    // Single status row under the composer carries the mode badge…
    expect(rows.at(-1)).toContain("ASK");
    // …while the model rides on the composer's top border meta.
    expect(lastFrame()).toContain("llama-3.3-70b");
    unmount();
    wiring.dispose();
    services.dispose();
  });

  it("keeps every rendered row inside the terminal width", () => {
    const services = buildServices();
    const wiring = buildWiring(services);
    const { lastFrame, unmount } = render(
      createElement(ServicesProvider, {
        services,
        children: createElement(ClassicApp, { wiring }),
      }),
    );
    for (const line of (lastFrame() ?? "").split("\n")) {
      expect(line.replace(/\x1b\[[0-9;]*m/g, "").length).toBeLessThanOrEqual(99);
    }
    unmount();
    wiring.dispose();
    services.dispose();
  });
});


describe("degenerate terminal sizes", () => {
  it("falls back to the default size when the tty reports zero", () => {
    const capabilities = detectCapabilities({
      env: {},
      stdoutIsTTY: true,
      stdinIsTTY: true,
      columns: 0,
      rows: 0,
    });
    expect(capabilities.columns).toBe(80);
    expect(capabilities.rows).toBe(24);
  });
});
