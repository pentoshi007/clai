import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeForSessionNaming } from "../../src/app/controllers/session-naming.js";
import { withRequestPurpose } from "../../src/llm/request-purpose.js";
import {
  emitTransportEvent, onTransportEvent, resetTransportEventsForTesting,
  type TransportEvent,
} from "../../src/llm/transport-events.js";
import { resetResponsesWireStatesForTesting } from "../../src/llm/wire/responses-first.js";
import { clearActiveSessionWorkspace } from "../../src/store/session-workspace.js";
import { createCompositionRoot, type AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";

const event: TransportEvent = {
  kind: "responses-fallback-endpoint", provider: "Free", model: "kilo-auto/free",
};
const received = vi.fn();
let unsubscribe: () => void;
let services: AppServices | undefined;

beforeEach(() => {
  resetTransportEventsForTesting();
  resetResponsesWireStatesForTesting();
  received.mockClear();
  unsubscribe = onTransportEvent(received);
});

afterEach(() => {
  unsubscribe();
  services?.dispose();
  services = undefined;
  clearActiveSessionWorkspace();
  vi.unstubAllGlobals();
});

describe("transport notices by request purpose", () => {
  it("suppresses auxiliary events across asynchronous work", async () => {
    await withRequestPurpose("auxiliary", async () => {
      await Promise.resolve();
      emitTransportEvent(event);
    });
    expect(received).not.toHaveBeenCalled();
  });

  it("does not consume a foreground notice's deduplication key during auxiliary work", () => {
    withRequestPurpose("auxiliary", () => emitTransportEvent(event));
    expect(received).not.toHaveBeenCalled();
    withRequestPurpose("turn", () => emitTransportEvent(event));
    withRequestPurpose("turn", () => emitTransportEvent(event));
    expect(received).toHaveBeenCalledExactlyOnceWith(event);
  });

  it.each(["turn", "compaction", undefined] as const)("retains deduplicated notices for %s", (purpose) => {
    withRequestPurpose(purpose, () => {
      emitTransportEvent(event);
      emitTransportEvent(event);
    });
    expect(received).toHaveBeenCalledExactlyOnceWith(event);
  });

  it("keeps foreground and auxiliary contexts separate during concurrent work", async () => {
    const foreground = { ...event, model: "foreground-model" };
    await Promise.all([
      withRequestPurpose("auxiliary", async () => {
        await Promise.resolve();
        emitTransportEvent(event);
      }),
      withRequestPurpose("turn", async () => {
        await Promise.resolve();
        emitTransportEvent(foreground);
      }),
    ]);
    expect(received).toHaveBeenCalledExactlyOnceWith(foreground);
  });

  it("names through Kilo's chat fallback without showing a transport toast", async () => {
    services = createCompositionRoot({
      capabilities: detectCapabilities({
        env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns: 100, rows: 30,
      }),
    });
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/responses")) {
        return Response.json({ error: { message: "Responses not supported" } }, { status: 404 });
      }
      if (url.endsWith("/chat/completions")) {
        return Response.json({
          choices: [{ message: { content: "SUMMARY: fix naming\nTITLE: Fix naming" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const title = await completeForSessionNaming([{ role: "user", content: "Fix naming" }], {});

    expect(title).toBe("SUMMARY: fix naming\nTITLE: Fix naming");
    expect(requests.some((url) => url.endsWith("/responses"))).toBe(true);
    expect(requests.at(-1)).toBe("https://api.kilo.ai/api/gateway/chat/completions");
    expect(received).not.toHaveBeenCalled();
    expect(services.toast.getToasts()).toEqual([]);
    emitTransportEvent(event);
    expect(services.toast.getToasts()).toEqual([
      expect.objectContaining({ message: expect.stringContaining("/responses not supported") }),
    ]);
  });
});
