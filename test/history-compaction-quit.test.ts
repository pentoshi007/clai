import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPort } from "../src/app/ports/agent-port.js";
import { createTurnOutcome } from "../src/agent/turn-outcome.js";
import { detectCapabilities } from "../src/ui-core/bootstrap/capabilities.js";
import {
  RendererLifecycle,
  type ProcessLike,
  type RendererHandle,
} from "../src/ui-core/bootstrap/lifecycle.js";
import { serializeTranscriptForCompaction } from "../src/ui-core/state/transcript-compaction.js";

const completeWithProvider = vi.hoisted(() => vi.fn());
const streamWithProvider = vi.hoisted(() => vi.fn());
vi.mock("../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/llm/router.js")>();
  return {
    ...actual,
    completeWithProvider: (...args: unknown[]) => completeWithProvider(...args),
    streamWithProvider: (...args: unknown[]) => streamWithProvider(...args),
  };
});

const dataEnvKeys = [
  "CLAI_DATA_DIR",
  "CLAI_HISTORY_DIR",
  "CLAI_PLAN_DIR",
  "CLAI_LOG_DIR",
  "CLAI_ARTIFACT_DIR",
  "CLAI_JOBS_DIR",
  "CLAI_CONFIG_DIR",
] as const;

let dataDir: string;
let originalEnv: Partial<Record<(typeof dataEnvKeys)[number], string | undefined>>;

beforeEach(() => {
  const summary =
    "Earlier turns in this session, summarized: the user asked, the assistant answered.";
  completeWithProvider.mockReset();
  completeWithProvider.mockResolvedValue({ text: summary });
  streamWithProvider.mockReset();
  streamWithProvider.mockImplementation(
    async (_request: unknown, onToken: (token: string) => void) => {
      onToken(summary);
      return { text: summary };
    },
  );
  originalEnv = {};
  for (const key of dataEnvKeys) originalEnv[key] = process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), "clai-compact-quit-"));
  for (const key of dataEnvKeys) process.env[key] = dataDir;
  process.env.CLAI_LOG_DIR = join(dataDir, "logs");
  vi.resetModules();
});

afterEach(async () => {
  for (const key of dataEnvKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  vi.resetModules();
});

function scriptedAgent(answer: string): AgentPort {
  return {
    async runTurn(request, handlers) {
      const requestMessages = [
        { role: "system" as const, content: "main system prompt" },
        ...(request.history ?? []),
        { role: "user" as const, content: request.prompt },
      ];
      handlers.onSuccessfulRequest?.({
        provider: request.provider ?? ("groq" as never),
        model: request.model ?? "test-model",
        messages: requestMessages,
        temperature: 0.2,
        thinking: { enabled: false, effort: "none" },
      });
      handlers.onEvent({ type: "turn-start", prompt: request.prompt });
      handlers.onEvent({ type: "assistant-message", text: answer });
      handlers.onMessages?.([
        ...(request.history ?? []),
        { role: "user", content: request.prompt },
        { role: "assistant", content: answer },
      ]);
      const outcome = createTurnOutcome({
        status: "succeeded",
        answer,
        steps: 0,
        remainingCriteria: [],
      });
      handlers.onEvent({ type: "turn-end", outcome, finalAnswer: answer, steps: 0 });
      return outcome;
    },
  };
}

class FakeProcess implements ProcessLike {
  readonly exitCalls: number[] = [];
  on(): unknown {
    return this;
  }
  off(): unknown {
    return this;
  }
  exit(code = 0): void {
    this.exitCalls.push(code);
  }
}

const capabilities = () =>
  detectCapabilities({
    env: {},
    stdoutIsTTY: true,
    stdinIsTTY: true,
    columns: 120,
    rows: 40,
  });

describe("terminal compaction survives quit (regression)", () => {
  it("persists the compacted card + compacted context when /compact is the last action before a racing Ctrl+C quit", async () => {
    const { createCompositionRoot } = await import(
      "../src/ui-core/bootstrap/composition-root.js"
    );
    const { getSession } = await import("../src/store/history.js");

    const services = createCompositionRoot({
      agent: scriptedAgent("a fairly detailed answer " + "z ".repeat(60)),
      provider: "groq" as never,
      model: "test-model",
      capabilities: capabilities(),
    });
    const sessionId = services.session.sessionId;

    // Wire the exact disposer start-tui-v2 uses: flush chat + visual transcript.
    const handle: RendererHandle = { start: () => {}, destroy: () => {} };
    const proc = new FakeProcess();
    const lifecycle = new RendererLifecycle({
      handle,
      process: proc,
      disposers: [
        async () => {
          await services.session.persistNow().catch(() => undefined);
        },
      ],
    });
    await lifecycle.start();

    await services.session.submit("first question " + "x ".repeat(50));
    await services.session.submit("second question " + "y ".repeat(50));

    // Terminal /compact — the user's failing case (no turn afterwards).
    const transcript = serializeTranscriptForCompaction(
      services.transcript.getState(),
      (id) => services.session.spool.tail(id),
    );
    const result = await services.session.compact(transcript || undefined, 2);
    expect(result.summarized).toBe(true);

    // Two racing exit triggers (App Ctrl+C path + SIGINT-driven quit).
    await Promise.all([
      lifecycle.shutdownAndExit(0),
      lifecycle.shutdownAndExit(130),
    ]);
    expect(proc.exitCalls.length).toBeGreaterThanOrEqual(1);

    // Relaunch: fresh modules read the on-disk store.
    vi.resetModules();
    const { getSession: reload } = await import("../src/store/history.js");
    const record = (await reload(sessionId)) ?? (await getSession(sessionId));
    expect(record).toBeDefined();

    const hasCompactedCard = (record!.transcript ?? []).some(
      (item) => item.kind === "compacted",
    );
    const hasCompactedContext = record!.messages.some(
      (m) => m.role === "system" && m.content.includes("summarized"),
    );
    expect(hasCompactedCard).toBe(true);
    expect(hasCompactedContext).toBe(true);
  });
});
