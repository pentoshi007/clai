import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../src/types.js";
import { updateConfig } from "../../src/store/config.js";
import { createCurrentPersistencePort } from "../../src/app/adapters/current-store-adapter.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { attachCommandHandlers } from "../../src/ui-core/commands/command-handlers.js";
import {
  createCompositionRoot,
  type AppServices,
} from "../../src/ui-core/bootstrap/composition-root.js";
import type { TranscriptState } from "../../src/ui-core/state/transcript-types.js";
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
  sandbox = mkdtempSync(join(tmpdir(), "clai-cross-renderer-"));
  for (const key of SANDBOX_KEYS) savedEnv.set(key, process.env[key]);
  process.env.CLAI_DATA_DIR = join(sandbox, "data");
  process.env.CLAI_HISTORY_DIR = join(sandbox, "data", "history");
  process.env.CLAI_CONFIG_DIR = sandbox;
  process.env.CLAI_PLAN_FILE = join(sandbox, "plan.json");
  process.env.CLAI_DISABLE_KEYCHAIN = "1";
  updateConfig({ disableKeychain: true, privateMode: false });
});

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

type Renderer = "opentui" | "classic";

const open: AppServices[] = [];

/**
 * Both frontends assemble the same composition root; the only renderer-specific
 * part of the session path is the classic wiring, which is attached for the
 * classic side so its subscriptions and repaint scheduler participate in the
 * resume exactly as they do in the shell.
 */
function shell(renderer: Renderer): AppServices {
  const services = createCompositionRoot({
    persistence: createCurrentPersistencePort(),
    jobs: stubJobsPort(),
    agent: { runTurn: async () => "" },
    mode: "agent",
    capabilities: detectCapabilities({
      env: {},
      stdoutIsTTY: true,
      stdinIsTTY: true,
      columns: 100,
      rows: 24,
    }),
  });
  attachCommandHandlers(services);
  if (renderer === "classic") {
    const wiring = createClassicAppWiring({
      services,
      mouse: false,
      resizeSource: { columns: 100, rows: 24, on: () => undefined, off: () => undefined },
    });
    services.dispose = ((original) => () => {
      wiring.dispose();
      original();
    })(services.dispose.bind(services));
  }
  open.push(services);
  return services;
}

afterEach(() => {
  for (const services of open.splice(0)) services.dispose();
  vi.restoreAllMocks();
});

const MESSAGES: readonly ChatMessage[] = [
  { role: "user", content: "add pagination to the users endpoint" },
  { role: "assistant", content: "done — three files touched" },
];

interface Fingerprint {
  readonly kinds: readonly string[];
  readonly tools: readonly string[];
  readonly diffPaths: readonly string[];
  readonly thinking: readonly string[];
  readonly compacted: readonly string[];
  readonly messages: readonly string[];
}

/**
 * `serializeForHistory` settles a tool that was still running when the snapshot
 * was taken, so a live `running`/`queued` card and its resumed `ok` card are the
 * same tool. Normalising here keeps the comparison about content, not timing.
 */
function persistedStatus(status: string): string {
  return status === "running" || status === "queued" ? "ok" : status;
}

function fingerprint(services: AppServices): Fingerprint {
  const state: TranscriptState = services.transcript.getState();
  const items = state.order.flatMap((id) => {
    const item = state.byId.get(id);
    return item ? [item] : [];
  });
  return {
    kinds: items.map((item) => item.kind),
    tools: items.flatMap((item) =>
      item.kind === "tool" ? [`${item.name}:${persistedStatus(item.status)}`] : [],
    ),
    diffPaths: items.flatMap((item) =>
      item.kind === "tool"
        ? (item.fileChanges ?? []).map((change) => change.path)
        : [],
    ),
    thinking: items.flatMap((item) => (item.kind === "thinking" ? [item.content] : [])),
    compacted: items.flatMap((item) => (item.kind === "compacted" ? [item.summary] : [])),
    messages: services.session.messages.map(
      (message) => `${message.role}:${message.content}`,
    ),
  };
}

async function writeSession(renderer: Renderer, id: string): Promise<Fingerprint> {
  const services = shell(renderer);
  const turn = scriptedTurn();
  services.transcript.hydrate(turn.state);
  services.session.loadHistory([...MESSAGES], { sessionId: id });
  for (const call of ["call-ok", "call-fail", "call-batch"]) {
    services.session.spool.replace(call, turn.spool.tail(call));
  }
  await services.session.persistNow("pagination work");
  return fingerprint(services);
}

async function resumeSession(renderer: Renderer, id: string): Promise<Fingerprint> {
  const services = shell(renderer);
  await services.commands.dispatch({ name: "history", args: "" });
  await vi.waitFor(() => expect(services.overlay.getState().kind).toBe("picker"));
  const overlay = services.overlay.getState();
  if (overlay.kind !== "picker") throw new Error("history picker did not open");
  expect(overlay.request.options.some((option) => option.value === id)).toBe(true);
  overlay.onSelect(id);
  await vi.waitFor(() => expect(services.session.sessionId).toBe(id));
  await vi.waitFor(() =>
    expect(
      [...services.transcript.getState().byId.values()].some((item) => item.kind === "tool"),
    ).toBe(true),
  );
  return fingerprint(services);
}

describe("cross-renderer history (W13)", () => {
  it("a session written by the OpenTUI shell resumes identically in classic", async () => {
    const id = `x-opentui-${Date.now()}`;
    const written = await writeSession("opentui", id);
    const resumed = await resumeSession("classic", id);

    expect(resumed.tools).toEqual(written.tools);
    expect(resumed.diffPaths).toEqual(written.diffPaths);
    expect(resumed.thinking).toEqual(written.thinking);
    expect(resumed.compacted).toEqual(written.compacted);
    expect(resumed.messages).toEqual(written.messages);
  });

  it("a session written by the classic shell resumes identically in OpenTUI", async () => {
    const id = `x-classic-${Date.now()}`;
    const written = await writeSession("classic", id);
    const resumed = await resumeSession("opentui", id);

    expect(resumed.tools).toEqual(written.tools);
    expect(resumed.diffPaths).toEqual(written.diffPaths);
    expect(resumed.thinking).toEqual(written.thinking);
    expect(resumed.compacted).toEqual(written.compacted);
    expect(resumed.messages).toEqual(written.messages);
  });

  it("both renderers reconstruct the same item kinds from one stored session", async () => {
    const id = `x-both-${Date.now()}`;
    await writeSession("classic", id);
    const viaClassic = await resumeSession("classic", id);
    const viaOpentui = await resumeSession("opentui", id);

    expect(viaClassic.kinds).toEqual(viaOpentui.kinds);
    expect(viaClassic.tools).toEqual(viaOpentui.tools);
    expect(viaClassic.diffPaths).toEqual(viaOpentui.diffPaths);
  });

  it("tool output bodies survive the round trip in both directions", async () => {
    const id = `x-output-${Date.now()}`;
    await writeSession("opentui", id);
    const services = shell("classic");
    await services.commands.dispatch({ name: "history", args: "" });
    await vi.waitFor(() => expect(services.overlay.getState().kind).toBe("picker"));
    const overlay = services.overlay.getState();
    if (overlay.kind !== "picker") throw new Error("history picker did not open");
    overlay.onSelect(id);
    await vi.waitFor(() => expect(services.session.sessionId).toBe(id));

    await vi.waitFor(() => {
      const tools = [...services.transcript.getState().byId.values()].flatMap((item) =>
        item.kind === "tool" ? [item] : [],
      );
      expect(tools.length).toBeGreaterThan(0);
      const bodies = tools.map((tool) => services.session.spool.tail(tool.toolCallId));
      expect(bodies.some((body) => body.includes("42 passed"))).toBe(true);
    });
  });
});
