import { homedir } from "node:os";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

// The wiring's async branch refresh shells out to `git rev-parse --abbrev-ref
// HEAD` and overwrites `branchValue` shortly after mount. In release CI the
// checkout is a detached tag (git reports "HEAD"), which would clobber the
// value these tests set and make the directory-row assertions depend on the
// ambient git state. Pin git to "main" so they stay deterministic everywhere.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  type ExecCallback = (
    error: Error | null,
    result?: { stdout: string; stderr: string },
  ) => void;
  function execFile(
    file: string,
    args: readonly string[],
    options: unknown,
    callback?: ExecCallback,
  ): unknown {
    const cb = typeof options === "function" ? (options as ExecCallback) : callback;
    if (file === "git" && cb) {
      queueMicrotask(() => cb(null, { stdout: "main\n", stderr: "" }));
      return undefined;
    }
    return (actual.execFile as unknown as (...a: never[]) => unknown)(
      ...([file, args, options, callback] as never[]),
    );
  }
  return { ...actual, execFile };
});
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
import { relativizeHome } from "../../src/classic/chrome/status-rows.js";
import type { SessionPlan } from "../../src/store/plan.js";
import { getConfig, updateConfig } from "../../src/store/config.js";

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

function activePlan(sessionId: string): SessionPlan {
  return {
    sessionId,
    goal: "Test active plan",
    detail: "",
    tasks: [{ id: "t1", title: "Run test", state: "in_progress" }],
    status: "in_progress",
    kind: "testing",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
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
  it("shows the enabled model effort on the composer boundary", () => {
    const previousThinking = getConfig().thinking;
    updateConfig({ thinking: { enabled: true, effort: "high" } });
    const services = buildServices();
    const wiring = buildWiring(services);
    const { lastFrame, unmount } = render(
      createElement(ServicesProvider, {
        services,
        children: createElement(ClassicApp, { wiring }),
      }),
    );

    try {
      expect(lastFrame()).toContain("llama-3.3-70b(high)");
    } finally {
      unmount();
      wiring.dispose();
      services.dispose();
      updateConfig({ thinking: previousThinking });
    }
  });

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

  it("places the collapsed active-task hint directly after directory and branch", async () => {
    const services = buildServices();
    const wiring = buildWiring(services, 140);
    wiring.branchValue = "main";
    services.plan.observe({
      type: "plan-updated",
      payload: {
        planId: services.session.sessionId,
        plan: activePlan(services.session.sessionId),
      },
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const { lastFrame, unmount } = render(
      createElement(ServicesProvider, {
        services,
        children: createElement(ClassicApp, { wiring }),
      }),
    );

    try {
      const row = (lastFrame() ?? "")
        .split("\n")
        .find((line) => line.includes("Tasks active . cntrl+H to expand"));
      expect(row).toBeDefined();
      const plain = row?.replace(/\x1b\[[0-9;]*m/g, "") ?? "";
      const cwd = relativizeHome(wiring.getSnapshot().cwd, homedir());
      expect(plain.indexOf(cwd)).toBeLessThan(plain.indexOf("main"));
      expect(plain.indexOf("main")).toBeLessThan(
        plain.indexOf("Tasks active . cntrl+H to expand"),
      );
      expect(plain.slice(plain.indexOf("main") + 4)).toMatch(
        /^   Tasks active \. cntrl\+H to expand/,
      );
      expect(plain).not.toContain("plan active");

      wiring.setPlanVisible(true);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(lastFrame()).not.toContain("Tasks active . cntrl+H to expand");
    } finally {
      unmount();
      wiring.dispose();
      services.dispose();
    }
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
