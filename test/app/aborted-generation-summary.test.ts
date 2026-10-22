import { afterEach, expect, it, vi } from "vitest";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { tokensPerSecondLabel, turnSummaryLabel } from "../../src/ui-core/rendering/duration.js";
import { hydrateFromClassicTranscript, serializeForHistory } from "../../src/ui-core/state/transcript-hydrate.js";
import { transcriptItems } from "../../src/ui-core/state/transcript-types.js";
import { installTransport } from "../conformance/fake-transport.js";
import { textStreamResponse } from "../conformance/wire-fixtures.js";

const encoder = new TextEncoder();
afterEach(() => vi.unstubAllGlobals());

it("retains measured throughput when the next real provider stream is aborted after tool execution", async () => {
  let round = 0;
  const transport = installTransport(() => {
    round += 1;
    if (round === 1) {
      return textStreamResponse([
        `${JSON.stringify({ message: { role: "assistant", content: "Reading the file.", tool_calls: [{ function: { name: "fs_read", arguments: { path: "README.md", limit: 1 } } }] }, done: false })}\n`,
        `${JSON.stringify({ message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 1_000, eval_count: 100 })}\n`,
      ]);
    }
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ message: { role: "assistant", content: "Still analyzing the result." }, done: false })}\n`));
      },
    }), { headers: { "content-type": "application/x-ndjson" } });
  });
  const services = createCompositionRoot({
    provider: "ollama", model: "fixture-model", noHistory: true,
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  });
  const pending = services.session.submit("Read README.md, then explain the result without further tools.");
  try {
    await vi.waitFor(() => {
      expect(transport.generations).toHaveLength(2);
      expect(transcriptItems(services.transcript.getState()).some((item) => item.kind === "assistant" && item.text.includes("Still analyzing"))).toBe(true);
    });
    services.session.abort();
    await pending;
    const state = services.transcript.getState();
    expect(transcriptItems(state).some((item) => item.kind === "tool" && item.status === "ok")).toBe(true);
    const summary = transcriptItems(state).find((item) => item.kind === "turn-summary");
    expect(summary).toMatchObject({ status: "aborted", generation: { outputTokens: 100, durationMs: expect.any(Number) } });
    expect(tokensPerSecondLabel(summary?.generation)).toMatch(/\d+\.\d tok\/s/);
    if (summary?.kind !== "turn-summary") throw new Error("missing turn summary");
    expect(turnSummaryLabel(summary.durationMs, summary.status, summary.changes, summary.generation)).toContain("tok/s");
    const saved = serializeForHistory(state, (id) => services.session.spool.tail(id));
    const restored = transcriptItems(hydrateFromClassicTranscript(saved).state).find((item) => item.kind === "turn-summary");
    expect(restored?.generation).toEqual(summary.generation);
  } finally {
    services.dispose();
    await pending.catch(() => undefined);
  }
}, 15_000);
