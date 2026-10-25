import { afterEach, expect, it, vi } from "vitest";
import { createCompositionRoot, type AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { footerMetrics } from "../../src/ui-core/rendering/footer-metrics.js";
import { transcriptItems } from "../../src/ui-core/state/transcript-types.js";
import { installTransport } from "../conformance/fake-transport.js";

const encoder = new TextEncoder();
let services: AppServices | undefined;
afterEach(() => { services?.dispose(); services = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([false, true])("streams real provider throughput into the session footer before completion (aborted=%s)", async (aborted) => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  let wire: ReadableStreamDefaultController<Uint8Array> | undefined;
  const transport = installTransport(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) { wire = controller; },
  }), { headers: { "content-type": "application/x-ndjson" } }));
  services = createCompositionRoot({
    provider: "ollama", model: "fixture-model", noHistory: true,
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  });
  const session = services.session;
  const pending = session.submit("Reply with a short answer and do not use tools.");
  try {
    await vi.waitFor(() => { expect(transport.generations).toHaveLength(1); expect(wire).toBeDefined(); });
    now = 1_000;
    wire!.enqueue(encoder.encode(`${JSON.stringify({ message: { role: "assistant", content: "x".repeat(99) }, done: false })}\n`));
    await vi.waitFor(() => expect(session.getState().generation).toEqual({ outputTokens: 30, durationMs: 1_000, estimated: true }));
    expect(session.getState().running).toBe(true);
    const live = session.getState();
    expect(footerMetrics(live.contextUsage!, live.generation, 80).rate).toBe("~30.0 tps");
    now = 2_000;
    await vi.waitFor(() => expect(session.getState().generation).toEqual({ outputTokens: 30, durationMs: 2_000, estimated: true }));
    expect(footerMetrics(session.getState().contextUsage!, session.getState().generation, 80).rate).toBe("~15.0 tps");
    now = 3_000;
    if (aborted) {
      session.abort();
    } else {
      wire!.enqueue(encoder.encode(`${JSON.stringify({ message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 1_000, eval_count: 120 })}\n`));
      wire!.close();
    }
    await pending;
    const idle = session.getState();
    expect(idle.running).toBe(false);
    expect(footerMetrics(idle.contextUsage!, idle.generation, 80).rate).toBe(aborted ? "~15.0 tps" : "40.0 tps");
    const summary = transcriptItems(services.transcript.getState()).find((item) => item.kind === "turn-summary");
    expect(summary?.generation).toEqual(aborted ? undefined : { outputTokens: 120, durationMs: 3_000 });
  } finally {
    services.dispose();
    await pending.catch(() => undefined);
  }
}, 15_000);
