import { describe, expect, it } from "vitest";

import { resolveBuiltInProfile } from "../../src/llm/provider-profiles.js";
import { emitReasoningControls } from "../../src/llm/reasoning-controls.js";
import {
  isReasoningUnsupportedError,
  ProviderError,
} from "../../src/llm/http.js";
import { isUnattributableRequestBodyError } from "../../src/llm/reasoning-errors.js";

const TOKENROUTER_422 = JSON.stringify({
  error: {
    message: "openai_error",
    type: "bad_response_status_code",
    param: "",
    code: "bad_response_status_code",
  },
  id: 71496,
  org_id: "",
  role: 1,
});

const BYNARA_400 = JSON.stringify({
  error: {
    type: "bad_request",
    message:
      "The model rejected this request. It may not support the input you sent (e.g. images on a text-only model) or a parameter is invalid.",
  },
});

function controlsFor(provider: string, model: string, effort: "xhigh" | "medium") {
  return emitReasoningControls({
    profile: resolveBuiltInProfile({ provider: provider as never, model }),
    preference: { enabled: true, effort },
    model,
    willReplayReasoning: false,
  });
}

describe("an endpoint's control dialect outranks the model family", () => {
  it("never sends DashScope enable_thinking to an OpenAI-compatible gateway", () => {
    for (const [provider, model] of [
      ["fireworks", "accounts/fireworks/models/qwen3p8-max"],
      ["bynara", "qwen-3.8-max-free"],
      ["tokenrouter", "qwen/qwen3.8-max-free"],
    ] as const) {
      expect(controlsFor(provider, model, "medium")).not.toHaveProperty(
        "enable_thinking",
      );
    }
  });

  it("keeps enable_thinking on DashScope itself", () => {
    expect(controlsFor("qwen-cloud", "qwen3.8-max", "medium")).toHaveProperty(
      "enable_thinking",
      true,
    );
  });

  it("does not leak a vendor-native replay flag onto a gateway", () => {
    const body = controlsFor("fireworks", "accounts/fireworks/models/kimi-k2p6", "medium");
    expect(body).not.toHaveProperty("preserve_thinking");
    expect(body).toHaveProperty("reasoning_effort");
  });

  it("leaves vLLM chat-template routes alone", () => {
    expect(
      controlsFor("hetzner", "Qwen/Qwen3.6-35B-A3B-FP8", "medium"),
    ).toHaveProperty("chat_template_kwargs");
  });

  it("restores reasoning_effort on tokenrouter kimi", () => {
    expect(controlsFor("tokenrouter", "moonshotai/kimi-k3", "xhigh")).toEqual({
      reasoning_effort: "max",
    });
  });
});

describe("qwen3.8 gateways only advertise what they can serve", () => {
  it("caps tokenrouter and bynara at the highest effort that returns 200", () => {
    for (const [provider, model] of [
      ["tokenrouter", "qwen/qwen3.8-max-free"],
      ["bynara", "qwen-3.8-max-free"],
    ] as const) {
      const profile = resolveBuiltInProfile({ provider: provider as never, model });
      expect(profile.reasoning.acceptedEfforts).toEqual(["low", "medium"]);
      expect(controlsFor(provider, model, "xhigh")).toEqual({
        reasoning_effort: "medium",
      });
    }
  });

  it("keeps xhigh where the endpoint serves it", () => {
    expect(
      controlsFor("fireworks", "accounts/fireworks/models/qwen3p8-max", "xhigh"),
    ).toEqual({ reasoning_effort: "xhigh" });
  });
});

describe("an opaque body rejection degrades instead of failing the turn", () => {
  it("classifies the TokenRouter 422 and the Bynara 400 as unattributable", () => {
    for (const [status, body] of [
      [422, TOKENROUTER_422],
      [400, BYNARA_400],
    ] as const) {
      const error = new ProviderError(
        "provider rejected the request body",
        status,
        body,
      );
      expect(isReasoningUnsupportedError(error)).toBe(false);
      expect(isUnattributableRequestBodyError(error)).toBe(true);
    }
  });

  it("leaves a body that names a reasoning field to the existing classifier", () => {
    const error = new ProviderError(
      "bad request",
      400,
      JSON.stringify({
        error: { message: "Extra inputs are not permitted, field: 'enable_thinking'" },
      }),
    );
    expect(isReasoningUnsupportedError(error)).toBe(true);
    expect(isUnattributableRequestBodyError(error)).toBe(false);
  });

  it("does not treat a 500 or a 429 as a body rejection", () => {
    for (const status of [429, 500, 503] as const) {
      const error = new ProviderError("upstream failure", status, "{}");
      expect(isUnattributableRequestBodyError(error)).toBe(false);
    }
  });
});
