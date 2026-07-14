import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/modes/agent.js";
import { deletePlan } from "../src/store/plan.js";
import type { AgentEvent } from "../src/agent/events.js";
import type { ChatMessage } from "../src/types.js";

const stream = vi.fn();
const complete = vi.fn();
const runTool = vi.fn();

vi.mock("../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/llm/router.js")>();
  return {
    ...actual,
    streamWithProvider: (req: unknown, onToken: (t: string) => void) =>
      stream(req, onToken),
    completeWithProvider: (req: unknown) => complete(req),
  };
});

vi.mock("../src/tools/registry.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/tools/registry.js")>();
  return {
    ...actual,
    runToolCall: (call: unknown, opts: unknown) => runTool(call, opts),
  };
});

vi.mock("../src/commands/providers.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../src/commands/providers.js")>();
  return { ...actual, ensureProviderConfigured: async () => {} };
});

function streamReply(text: string) {
  return (_req: unknown, onToken: (t: string) => void) => {
    onToken(text);
    return Promise.resolve({ text, provider: "nvidia", model: "test-model" });
  };
}

const SUMMARY_KEYWORD = "PostgreSQL";
const SUMMARY_TEXT = `User asked to set up a ${SUMMARY_KEYWORD} cluster with replication. Decisions: use ${SUMMARY_KEYWORD} 15, streaming replication. Work completed: installed binaries, initialized data dir. Remaining work: configure replication slots and failover.`;

describe("auto-compaction display (Chunk 3)", () => {
  beforeEach(async () => {
    stream.mockReset();
    complete.mockReset();
    runTool.mockReset();
    await deletePlan("session-compaction").catch(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "emits a compacted event carrying the actual summary text when auto-compaction fires",
    async () => {
      // Build a history large enough that estimateMessagesTokens > 60_000
      // (AUTO_COMPACT_TOKEN_BUDGET). 240 KB of content / 4 chars/token ~= 60_000.
      const history: ChatMessage[] = [
        { role: "system", content: "system prompt" },
      ];
      for (let i = 0; i < 60; i += 1) {
        const role: ChatMessage["role"] = i % 2 === 0 ? "user" : "assistant";
        history.push({
          role,
          content: `${role}-${i} ${"x".repeat(12_000)}`,
        });
      }

      // The agent loop will stream one assistant reply (no tool call) and end
      // the turn. completeWithProvider returns the compaction summary.
      stream.mockImplementation(
        streamReply("All set; nothing else to do."),
      );
      complete.mockImplementation(
        async () => ({
          text: SUMMARY_TEXT,
          provider: "nvidia",
          model: "test-model",
        }),
      );

      const events: AgentEvent[] = [];
      await runAgent("continue with the next step", {
        session: {
          sessionId: "session-compaction",
          planApproved: { value: false },
          allow: new Set(),
          pentestAuthorized: { value: false },
        } as any,
        history,
        maxSteps: 1,
        onEvent: (e) => events.push(e),
      });

      const compacted = events.find((e) => e.type === "compacted");
      expect(
        compacted,
        "expected a compacted event to be emitted during auto-compaction",
      ).toBeDefined();

      if (compacted && compacted.type === "compacted") {
        expect(compacted.summary).toContain(SUMMARY_KEYWORD);
        expect(compacted.summary).toMatch(/cluster with replication/i);
        expect(typeof compacted.beforeTokens).toBe("number");
        expect(typeof compacted.afterTokens).toBe("number");
        expect(compacted.beforeTokens).toBeGreaterThan(0);
        expect(compacted.afterTokens).toBeGreaterThan(0);
        // Token stats must be surfaced (compaction should shrink context).
        expect(compacted.afterTokens).toBeLessThanOrEqual(compacted.beforeTokens);
      }

      // Sanity check: the summary keyword must NOT only appear in stats —
      // verify it's present in a non-stats payload (the compacted event).
      const statsEvents = events.filter((e) => e.type === "notice");
      for (const ev of statsEvents) {
        if (ev.type === "notice") {
          expect(ev.text).not.toContain(SUMMARY_KEYWORD);
        }
      }
    },
    30_000,
  );
});
