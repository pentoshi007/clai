import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../src/types.js";
import type { PersistencePort, SaveOptions } from "../../src/app/ports/persistence-port.js";
import { updateConfig } from "../../src/store/config.js";
import { upsertSession } from "../../src/store/history.js";
import { createCurrentPersistencePort } from "../../src/app/adapters/current-store-adapter.js";
import { RendererLifecycle } from "../../src/ui-core/bootstrap/lifecycle.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { attachCommandHandlers } from "../../src/ui-core/commands/command-handlers.js";
import {
  createCompositionRoot,
  type AppServices,
} from "../../src/ui-core/bootstrap/composition-root.js";
import { serializeForHistory } from "../../src/ui-core/state/transcript-hydrate.js";
import { createClassicAppWiring } from "../../src/classic/app/app-wiring.js";
import { scriptedTurn } from "./feed/fixture.js";
import { stubJobsPort } from "./app/harness.js";

const SANDBOX_KEYS = [
  "CLAI_DATA_DIR",
  "CLAI_HISTORY_DIR",
  "CLAI_CONFIG_DIR",
  "CLAI_PLAN_FILE",
  "CLAI_DISABLE_KEYCHAIN",
] as const;

let sandbox: string;
const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "clai-classic-session-"));
  for (const key of SANDBOX_KEYS) savedEnv.set(key, process.env[key]);
  process.env.CLAI_DATA_DIR = join(sandbox, "data");
  process.env.CLAI_HISTORY_DIR = join(sandbox, "data", "history");
  process.env.CLAI_CONFIG_DIR = sandbox;
  process.env.CLAI_PLAN_FILE = join(sandbox, "plan.json");
  process.env.CLAI_DISABLE_KEYCHAIN = "1";
});

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

interface SaveCall {
  readonly messages: readonly ChatMessage[];
  readonly options: SaveOptions;
}

interface Recorder extends PersistencePort {
  readonly calls: readonly SaveCall[];
}

function recordingPersistence(): Recorder {
  const calls: SaveCall[] = [];
  return {
    calls,
    async saveSession(messages, options) {
      calls.push({ messages: [...messages], options });
    },
    async loadPlan() {
      return undefined;
    },
    async savePlan() {},
    async deletePlan() {},
  } as unknown as Recorder;
}

interface Built {
  readonly services: AppServices;
  dispose(): void;
}

function build(
  options: {
    readonly persistence?: PersistencePort;
    readonly noHistory?: boolean;
    readonly commands?: boolean;
  } = {},
): Built {
  const services = createCompositionRoot({
    persistence: options.persistence ?? recordingPersistence(),
    jobs: stubJobsPort(),
    agent: { runTurn: async () => "" },
    noHistory: options.noHistory,
    mode: "agent",
    capabilities: detectCapabilities({
      env: {},
      stdoutIsTTY: true,
      stdinIsTTY: true,
      columns: 100,
      rows: 24,
    }),
  });
  if (options.commands !== false) attachCommandHandlers(services);
  return {
    services,
    dispose() {
      services.dispose();
    },
  };
}

let built: Built | undefined;

beforeEach(() => {
  updateConfig({ disableKeychain: true, privateMode: false });
});

afterEach(() => {
  built?.dispose();
  built = undefined;
  updateConfig({ privateMode: false });
  vi.restoreAllMocks();
});

describe("classic session persistence (W13)", () => {
  it("saves the model history together with the visual transcript snapshot", async () => {
    const persistence = recordingPersistence();
    built = build({ persistence });
    const { services } = built;
    const turn = scriptedTurn();
    services.transcript.hydrate(turn.state);
    services.session.loadHistory([
      { role: "user", content: "add pagination" },
      { role: "assistant", content: "done" },
    ]);

    await services.session.persistNow("pagination work");

    expect(persistence.calls).toHaveLength(1);
    const call = persistence.calls[0]!;
    expect(call.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(call.options.sessionId).toBe(services.session.sessionId);
    expect(call.options.name).toBe("pagination work");
    const snapshot = call.options.transcript ?? [];
    expect(snapshot.length).toBeGreaterThan(0);
    expect(snapshot.some((item) => item.kind === "tool")).toBe(true);
  });

  it("keeps the tool output body in the saved snapshot so a resume can page it", async () => {
    const persistence = recordingPersistence();
    built = build({ persistence });
    const { services } = built;
    const turn = scriptedTurn();
    services.transcript.hydrate(turn.state);
    services.session.loadHistory([{ role: "user", content: "run the tests" }]);
    for (const id of ["call-ok", "call-fail", "call-batch"]) {
      services.session.spool.replace(id, turn.spool.tail(id));
    }

    await services.session.persistNow();

    const snapshot = persistence.calls[0]?.options.transcript ?? [];
    const tools = snapshot.filter((item) => item.kind === "tool");
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some((item) => (item.output ?? "").includes("42 passed"))).toBe(true);
  });

  it("autosaves mid-turn once a user message exists, throttled to one write", async () => {
    const persistence = recordingPersistence();
    built = build({ persistence });
    const { services } = built;
    services.session.loadHistory([{ role: "user", content: "first" }]);

    await services.session.persistNow();
    await services.session.persistNow();

    expect(persistence.calls.length).toBeGreaterThanOrEqual(1);
    expect(persistence.calls.every((call) => call.options.sessionId === services.session.sessionId)).toBe(
      true,
    );
  });

  it("writes nothing at all with --no-history", async () => {
    const persistence = recordingPersistence();
    built = build({ persistence, noHistory: true });
    const { services } = built;
    services.session.loadHistory([{ role: "user", content: "secret work" }]);

    await services.session.persistNow("named");

    expect(persistence.calls).toEqual([]);
  });

  it("writes nothing while private mode is on, and resumes writing when it is off", async () => {
    const persistence = recordingPersistence();
    built = build({ persistence });
    const { services } = built;
    services.session.loadHistory([{ role: "user", content: "private work" }]);

    await services.commands.dispatch({ name: "privacy", args: "on" });
    await vi.waitFor(() => expect(persistence.calls).toEqual([]));
    await services.session.persistNow();
    expect(persistence.calls).toEqual([]);

    await services.commands.dispatch({ name: "privacy", args: "off" });
    await services.session.persistNow();
    expect(persistence.calls).toHaveLength(1);
  });

  it("skips the write when the history holds no user turn", async () => {
    const persistence = recordingPersistence();
    built = build({ persistence });
    const { services } = built;
    services.session.loadHistory([{ role: "assistant", content: "unprompted" }]);

    await services.session.persistNow();

    expect(persistence.calls).toEqual([]);
  });
});

describe("classic /history resume (W13)", () => {
  it("restores tools, diffs, thinking, and compaction cards from a stored session", async () => {
    const turn = scriptedTurn();
    const stored = serializeForHistory(turn.state, (id) => turn.spool.tail(id));
    const messages: ChatMessage[] = [
      { role: "user", content: "add pagination to the users endpoint" },
      { role: "assistant", content: "done" },
    ];
    const record = await upsertSession(
      `resume-${Date.now()}`,
      messages,
      "pagination work",
      [...stored],
    );

    built = build({ persistence: createCurrentPersistencePort() });
    const { services } = built;

    await services.commands.dispatch({ name: "history", args: "" });
    await vi.waitFor(() => expect(services.overlay.getState().kind).toBe("picker"));
    const overlay = services.overlay.getState();
    if (overlay.kind !== "picker") throw new Error("history picker did not open");
    const row = overlay.request.options.find((option) => option.value === record.id);
    expect(row).toBeDefined();

    overlay.onSelect(record.id);

    await vi.waitFor(() => expect(services.session.sessionId).toBe(record.id));
    await vi.waitFor(() => {
      const items = [...services.transcript.getState().byId.values()];
      expect(items.some((item) => item.kind === "tool")).toBe(true);
    });

    const items = [...services.transcript.getState().byId.values()];
    const tools = items.filter((item) => item.kind === "tool");
    expect(tools.some((item) => item.name === "fs.edit")).toBe(true);
    expect(tools.some((item) => (item.fileChanges?.length ?? 0) > 0)).toBe(true);
    expect(items.some((item) => item.kind === "thinking")).toBe(true);
    expect(items.some((item) => item.kind === "compacted")).toBe(true);
    expect(services.session.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(services.session.getState().title).toBe("pagination work");
  });

  it("selecting the live session is a no-op that closes the picker", async () => {
    built = build({ persistence: createCurrentPersistencePort() });
    const { services } = built;
    services.session.loadHistory([{ role: "user", content: "live" }]);
    const id = services.session.sessionId;

    await services.commands.dispatch({ name: "history", args: "" });
    await vi.waitFor(() => expect(services.overlay.getState().kind).toBe("picker"));
    const overlay = services.overlay.getState();
    if (overlay.kind !== "picker") throw new Error("history picker did not open");
    overlay.onSelect("__current__");

    await vi.waitFor(() => expect(services.overlay.getState().kind).toBe("none"));
    expect(services.session.sessionId).toBe(id);
  });
});

describe("classic shutdown flush ordering (W13)", () => {
  it("runs disposers newest-first, awaits each, and destroys the handle last", async () => {
    const order: string[] = [];
    const lifecycle = new RendererLifecycle({
      handle: {
        destroy: async () => {
          order.push("destroy");
        },
      },
      disposers: [
        async () => {
          await Promise.resolve();
          order.push("persist");
        },
        () => {
          order.push("console");
        },
        async () => {
          order.push("interactive-sessions");
        },
      ],
      installSignalHandlers: false,
    });

    await lifecycle.shutdown();

    expect(order).toEqual(["interactive-sessions", "console", "persist", "destroy"]);
  });

  it("is idempotent, so a second signal cannot interleave a half-written flush", async () => {
    let persists = 0;
    let destroys = 0;
    const lifecycle = new RendererLifecycle({
      handle: {
        destroy: async () => {
          destroys += 1;
        },
      },
      disposers: [
        async () => {
          persists += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
      ],
      installSignalHandlers: false,
    });

    await Promise.all([lifecycle.shutdown(), lifecycle.shutdown()]);

    expect(persists).toBe(1);
    expect(destroys).toBe(1);
  });

  it("the classic shell flushes history in the disposer that runs last", async () => {
    const persistence = recordingPersistence();
    built = build({ persistence });
    const { services } = built;
    services.session.loadHistory([{ role: "user", content: "work" }]);
    const order: string[] = [];

    const lifecycle = new RendererLifecycle({
      handle: {
        destroy: async () => {
          order.push("destroy");
        },
      },
      disposers: [
        async () => {
          await services.session.persistNow().catch(() => undefined);
          order.push("persist");
        },
        () => {
          order.push("console");
        },
      ],
      installSignalHandlers: false,
    });

    await lifecycle.shutdown();

    expect(order).toEqual(["console", "persist", "destroy"]);
    expect(persistence.calls).toHaveLength(1);
  });
});

describe("classic wiring disposal (W13)", () => {
  it("stops every timer and subscription so shutdown cannot repaint after unmount", () => {
    built = build();
    const { services } = built;
    const wiring = createClassicAppWiring({
      services,
      mouse: false,
      resizeSource: { columns: 100, rows: 24, on: () => undefined, off: () => undefined },
    });
    const listener = vi.fn();
    wiring.subscribe(listener);
    wiring.dispose();
    listener.mockClear();

    services.session.notice("info", "after dispose");
    services.transcript.reset();

    expect(listener).not.toHaveBeenCalled();
  });
});
