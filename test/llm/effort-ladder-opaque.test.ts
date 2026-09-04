import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearReasoningUnsupported,
  displayReasoningEfforts,
  resetReasoningKnowledge,
} from "../../src/llm/capabilities.js";
import { ProviderError } from "../../src/llm/http.js";
import { streamWithProvider } from "../../src/llm/router.js";
import {
  effortCandidatesFor,
  shouldEnterEffortLadder,
} from "../../src/llm/routing/error-classification.js";
import { installTransport } from "../conformance/fake-transport.js";
import {
  jsonResponse,
  textStreamResponse,
} from "../conformance/wire-fixtures.js";
import type { ChatMessage, ReasoningEffort } from "../../src/types.js";

vi.mock("../../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/store/keys.js")
  >();
  return {
    ...actual,
    getProviderKeys: async (provider: string) => ({
      keys: [{ id: "env", value: `sk-${provider}-testkey`, createdAt: 0 }],
      activeIndex: 0,
      source: "env" as const,
    }),
  };
});

const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
const MODEL = "free-1/mimo-v2.5-free";

const ZEN_PARAMETER_REJECTION = {
  error: {
    type: "server_error",
    message:
      "Error from provider (Console): Upstream request failed: [400] Invalid request parameters",
  },
};

function okStream(): Response {
  return textStreamResponse([
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "hm" } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: "ok" } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
    "data: [DONE]\n\n",
  ]);
}

function zenGatewayRejectingExtendedEfforts() {
  return installTransport((req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const effort = body["reasoning_effort"];
    if (effort === "xhigh" || effort === "minimal") {
      return jsonResponse(ZEN_PARAMETER_REJECTION, 400);
    }
    return okStream();
  });
}

const effortsOf = (t: ReturnType<typeof installTransport>): unknown[] =>
  t.generations.map((g) => (g.body as Record<string, unknown>)["reasoning_effort"]);

const thinking = (effort: ReasoningEffort) => ({ enabled: true, effort });

beforeEach(() => {
  resetReasoningKnowledge();
});

afterEach(() => {
  clearReasoningUnsupported();
  resetReasoningKnowledge();
  vi.unstubAllGlobals();
});

describe("effort ladder entry for opaque gateway rejections", () => {
  const zen400 = new ProviderError(
    "Free (model=mimo-v2.5-free): Provider request failed with HTTP 400 — Error from provider (Console): Upstream request failed: [400] Invalid request parameters",
    400,
    JSON.stringify(ZEN_PARAMETER_REJECTION),
  );
  const zen500 = new ProviderError(
    "Free (model=mimo-v2.5-free): Provider request failed with HTTP 500 — Internal server error",
    500,
    "Internal server error",
  );

  it("enters the ladder when an extended effort meets an opaque rejection", () => {
    expect(shouldEnterEffortLadder(zen400, thinking("xhigh"), "free", MODEL, false)).toBe(true);
    expect(shouldEnterEffortLadder(zen500, thinking("xhigh"), "free", MODEL, false)).toBe(true);
    expect(shouldEnterEffortLadder(zen400, thinking("minimal"), "free", MODEL, false)).toBe(true);
  });

  it("stays out of the ladder for universal efforts and unrelated failures", () => {
    expect(shouldEnterEffortLadder(zen400, thinking("high"), "free", MODEL, false)).toBe(false);
    expect(shouldEnterEffortLadder(zen500, thinking("medium"), "free", MODEL, false)).toBe(false);
    expect(shouldEnterEffortLadder(zen400, undefined, "free", MODEL, false)).toBe(false);
    expect(
      shouldEnterEffortLadder(
        new ProviderError("rate limited", 429),
        thinking("xhigh"),
        "free",
        MODEL,
        false,
      ),
    ).toBe(false);
    expect(
      shouldEnterEffortLadder(
        new ProviderError("model not supported", 401),
        thinking("xhigh"),
        "free",
        MODEL,
        false,
      ),
    ).toBe(false);
    expect(
      shouldEnterEffortLadder(
        new ProviderError(
          "Provider request failed with HTTP 400 — Model is unavailable",
          400,
          "Model is unavailable",
        ),
        thinking("xhigh"),
        "free",
        MODEL,
        false,
      ),
    ).toBe(false);
  });

  it("steps down within the declared efforts when the gateway rejects one", () => {
    expect(effortCandidatesFor("free", MODEL, "xhigh")).toEqual(["high"]);
    expect(effortCandidatesFor("free", MODEL, "minimal")).toEqual(["none"]);
  });
});

describe("zen free model rejecting extended efforts", () => {
  it("recovers the turn through the ladder and learns the route", async () => {
    const transport = zenGatewayRejectingExtendedEfforts();
    const statuses: string[] = [];

    const result = await streamWithProvider(
      {
        provider: "free",
        model: MODEL,
        messages,
        thinking: thinking("xhigh"),
      },
      () => {},
      (message) => statuses.push(message),
    );

    expect(result.text).toContain("ok");
    expect(effortsOf(transport)).toEqual(["xhigh", "high"]);
    expect(statuses.some((message) => /retrying with high/.test(message))).toBe(true);
    expect(displayReasoningEfforts("free", MODEL)).not.toContain("xhigh");
  });

  it("maps the rejected effort before the wire on later turns", async () => {
    zenGatewayRejectingExtendedEfforts();
    await streamWithProvider(
      {
        provider: "free",
        model: MODEL,
        messages,
        thinking: thinking("xhigh"),
      },
      () => {},
    );

    const second = zenGatewayRejectingExtendedEfforts();
    const result = await streamWithProvider(
      {
        provider: "free",
        model: MODEL,
        messages,
        thinking: thinking("xhigh"),
      },
      () => {},
    );

    expect(result.text).toContain("ok");
    expect(effortsOf(second)).toEqual(["high"]);
  });

  it("falls back to disabling reasoning when no lower effort exists", async () => {
    const transport = zenGatewayRejectingExtendedEfforts();

    const result = await streamWithProvider(
      {
        provider: "free",
        model: MODEL,
        messages,
        thinking: thinking("minimal"),
      },
      () => {},
    );

    expect(result.text).toContain("ok");
    expect(effortsOf(transport)).toEqual(["minimal", "none"]);
    expect(displayReasoningEfforts("free", MODEL)).not.toContain("minimal");
  });
});
