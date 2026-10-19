import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearModelCatalogFacts,
  displayReasoningEfforts,
  effectiveThinkingEffort,
  registerModelCatalogFacts,
  resetReasoningKnowledge,
} from "../../src/llm/capabilities.js";
import { completeWithProvider, streamWithProvider } from "../../src/llm/router.js";
import { sse } from "./river-fixtures.js";
import { reasoningOptionValues } from "../../src/ui-core/commands/pickers/search-reasoning.js";
import { needsEffortPreflight, resetEffortPreflightForTesting } from "../../src/llm/wire/effort-preflight.js";
import { resetResponsesWireStatesForTesting } from "../../src/llm/wire/responses-first.js";
import { installTransport, type RecordedRequest } from "../conformance/fake-transport.js";
import { jsonResponse } from "../conformance/wire-fixtures.js";
import { providerIds, type ProviderId, type ReasoningEffort } from "../../src/types.js";
import type { FreebuffAdmission } from "../../src/llm/freebuff-session.js";

vi.mock("../../src/store/keys.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/store/keys.js")>(),
  getProviderKeys: async (provider: string) => ({
    keys: [{ id: "env", value: provider === "modal" ? "wk-fixture:ws-fixture" : `rv_main_${provider}`, createdAt: 0 }],
    activeIndex: 0,
    source: "env" as const,
  }),
}));

vi.mock("../../src/store/config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/store/config.js")>(),
  getProviderEndpoints: () => ({ urls: ["https://effort-fixture.test/v1"], activeIndex: 0, disabledUrls: [] }),
  getActiveProviderEndpoint: () => "https://effort-fixture.test/v1",
}));

vi.mock("../../src/llm/freebuff-session.js", () => ({
  freebuffSessionManager: () => ({
    withAdmission: async <T>(_token: string, model: string, _signal: AbortSignal | undefined, run: (admission: FreebuffAdmission) => Promise<T>) =>
      run({ instanceId: "fixture", model, expiresAt: undefined, metadata: {} }),
  }),
}));

vi.mock("../../src/llm/freebuff-run.js", () => ({
  startFreebuffRun: async () => ({ runId: "fixture", clientId: "fixture", agentId: "fixture", startedAt: "2026-10-19" }),
  finishFreebuffRun: async () => {},
}));

const model = "unknown/new-reasoner";
const messages = [{ role: "user" as const, content: "Real conversation" }];
const providers: ProviderId[] = [
  "river", "mistral", "agentrouter", "bynara", "lightning", "fireworks",
  "modal", "openai", "openrouter", "orcarouter", "merge-gateway", "explabs",
  "vercel", "meta", "tokenharbor", "freebuff", "cline",
];

function bodyOf(request: RecordedRequest): Record<string, unknown> {
  return request.body as Record<string, unknown>;
}

function effortOf(request: RecordedRequest): unknown {
  const body = bodyOf(request);
  const nested = body.reasoning as Record<string, unknown> | undefined;
  return body.reasoning_effort ?? nested?.effort;
}

function successful(request: RecordedRequest): Response {
  if (request.url.endsWith("/responses")) {
    return jsonResponse({
      id: "resp_effort", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
    });
  }
  return jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
}

function request(provider: ProviderId, effort: ReasoningEffort = "max") {
  return { provider, model, messages, purpose: "turn" as const, thinking: { enabled: effort !== "none", effort } };
}

function rejectingTransport(accepted: readonly string[], nativeResponses = false) {
  return installTransport((record) => {
    if (record.url.endsWith("/responses") && !nativeResponses) {
      return jsonResponse({ error: { message: "not found" } }, 404);
    }
    return accepted.includes(String(effortOf(record)))
      ? successful(record)
      : jsonResponse({ error: { message: "reasoning_effort is unsupported" } }, 400);
  });
}

afterEach(() => {
  resetEffortPreflightForTesting();
  resetResponsesWireStatesForTesting();
  clearModelCatalogFacts();
  resetReasoningKnowledge();
  vi.unstubAllGlobals();
});

describe("main-agent effort discovery", () => {
  it.each(providers)("probes actual efforts and synchronizes wire and display for %s", async (provider) => {
    const transport = rejectingTransport(["high"], provider === "vercel" || provider === "meta");
    expect((await completeWithProvider(request(provider))).text).toBe("ok");
    const sends = transport.generations.filter((record) => !record.url.endsWith("/responses") || provider === "vercel" || provider === "meta");
    expect(sends.map(effortOf)).toEqual(["max", "xhigh", "high", "high"]);
    for (const probe of sends.slice(0, -1)) {
      const body = bodyOf(probe);
      expect(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens).toBeLessThanOrEqual(16);
      expect(body.tools).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("Real conversation");
    }
    expect(displayReasoningEfforts(provider, model)).toEqual(["high"]);
    expect(reasoningOptionValues(provider, model).filter((effort) => effort !== "off")).toEqual(["high"]);
    expect(effectiveThinkingEffort(provider, model, request(provider).thinking)).toBe("high");
    const before = transport.generations.length;
    await completeWithProvider(request(provider));
    expect(transport.generations.length - before).toBe(1);
    expect(effortOf(transport.generations.at(-1)!)).toBe("high");
  });

  it("only probes lower after an explicit lower selection and preserves the verified ceiling", async () => {
    const transport = rejectingTransport(["high", "low"]);
    await completeWithProvider(request("river"));
    const before = transport.generations.length;
    await completeWithProvider(request("river", "medium"));
    expect(transport.generations.slice(before).map(effortOf)).toEqual(["medium", "low", "low"]);
    expect(displayReasoningEfforts("river", model)).toEqual(["low", "high"]);
    expect(effectiveThinkingEffort("river", model, request("river", "medium").thinking)).toBe("low");
    const settled = transport.generations.length;
    await completeWithProvider(request("river", "max"));
    expect(transport.generations.slice(settled).map(effortOf)).toEqual(["high"]);
  });

  it("accepts a reasoning-only truncated probe without increasing its output budget", async () => {
    const transport = installTransport((record) => {
      const body = bodyOf(record);
      if (body.max_tokens === 16) {
        return jsonResponse({ choices: [{ message: { content: "", reasoning_content: "Checking" }, finish_reason: "length" }] });
      }
      return successful(record);
    });
    expect((await completeWithProvider(request("river"))).text).toBe("ok");
    expect(transport.generations.map(effortOf)).toEqual(["max", "max"]);
    expect(displayReasoningEfforts("river", model)).toEqual(["max"]);
  });

  it("continues on opaque validation errors without probing real conversations", async () => {
    const transport = installTransport((record) => effortOf(record) === "high"
      ? successful(record)
      : jsonResponse({ error: { message: "Invalid inference request. Check the model's supported parameters and input limits." } }, 400));
    await completeWithProvider(request("river"));
    expect(transport.generations.map(effortOf)).toEqual(["max", "xhigh", "high", "high"]);
  });

  it.each([401, 403, 429, 503])("does not learn effort rejection from HTTP %s", async (status) => {
    const transport = installTransport(() => jsonResponse({ error: { message: "Service failure" } }, status));
    const signal = AbortSignal.timeout(100);
    await expect(completeWithProvider({ ...request("river"), signal })).rejects.toThrow();
    expect(displayReasoningEfforts("river", model)).toBeUndefined();
    expect(transport.generations.filter((record) => bodyOf(record).max_tokens === 16).length).toBeLessThanOrEqual(1);
  });

  it("does not probe explicit negative metadata", async () => {
    registerModelCatalogFacts("river", { id: model, reasoning: { supported: false } });
    const transport = installTransport(successful);
    await completeWithProvider(request("river"));
    expect(transport.generations).toHaveLength(1);
    expect(effortOf(transport.generations[0]!)).toBeUndefined();
  });
});

describe("minimal effort discovery", () => {
  it.each(providerIds)("never probes published effort lists for %s", (provider) => {
    registerModelCatalogFacts(provider, {
      id: model,
      reasoning: { supported: true, supportedEfforts: ["low", "high", "max"] },
    });
    expect(needsEffortPreflight({ providerId: provider, model, requested: "max", purpose: "turn" })).toBe(false);
  });

  it.each(["deepseek-ai/DeepSeek-V4.1-Flash", "deepseek-ai/DeepSeek-V4.1-Flash-1017", "zai-org/GLM-5.3-Flash"])("sends known River %s without effort probes", async (knownModel) => {
    const transport = installTransport(successful);
    await completeWithProvider({ ...request("river"), model: knownModel });
    expect(transport.generations).toHaveLength(1);
    expect(effortOf(transport.generations[0]!)).toBe("max");
  });

  it("uses short preflights only after a known effort is rejected", async () => {
    const knownModel = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
    const transport = rejectingTransport(["high"]);
    await completeWithProvider({ ...request("river"), model: knownModel });
    expect(transport.generations.map(effortOf)).toEqual(["max", "high", "high"]);
    expect(bodyOf(transport.generations[0]!).max_tokens).toBeGreaterThan(16);
    expect(bodyOf(transport.generations[1]!).max_tokens).toBe(16);
    expect(bodyOf(transport.generations[2]!).max_tokens).toBeGreaterThan(16);
  });

  it("recovers a previously accepted level without repeating the rejected level", async () => {
    let accepts = "max";
    const transport = installTransport((record) => effortOf(record) === accepts
      ? successful(record) : jsonResponse({ error: { message: "reasoning_effort is unsupported" } }, 400));
    await completeWithProvider(request("river"));
    accepts = "high";
    const before = transport.generations.length;
    await completeWithProvider(request("river"));
    expect(transport.generations.slice(before).map(effortOf)).toEqual(["max", "xhigh", "high", "high"]);
    expect(effectiveThinkingEffort("river", model, request("river").thinking)).toBe("high");
  });
});

describe("streamed main-agent effort discovery", () => {
  function streamingTransport() {
    return installTransport((record) => {
      if (effortOf(record) !== "high") return jsonResponse({ error: { message: "reasoning_effort is unsupported" } }, 400);
      return bodyOf(record).stream
        ? sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]) : successful(record);
    });
  }

  it("discovers unknown efforts before starting a stream and reuses the same effort", async () => {
    const transport = streamingTransport();
    const tokens: string[] = [];
    const result = await streamWithProvider(request("river"), (token) => tokens.push(token), () => {});
    expect(result.text).toBe("ok");
    expect(tokens.join("")).toBe("ok");
    expect(transport.generations.map(effortOf)).toEqual(["max", "xhigh", "high", "high"]);
    expect(transport.generations.map((record) => bodyOf(record).stream)).toEqual([false, false, false, true]);
    const before = transport.generations.length;
    await streamWithProvider(request("river"), () => {});
    expect(transport.generations.slice(before).map(effortOf)).toEqual(["high"]);
  });

  it("uses a short probe after a known streaming effort is rejected", async () => {
    const transport = streamingTransport();
    await streamWithProvider({ ...request("river"), model: "deepseek-ai/DeepSeek-V4.1-Flash-1017" }, () => {});
    expect(transport.generations.map(effortOf)).toEqual(["max", "high", "high"]);
    expect(transport.generations.map((record) => bodyOf(record).stream)).toEqual([true, false, true]);
  });

  it("does not turn reasoning back on after an explicit off selection", async () => {
    const transport = installTransport(successful);
    await completeWithProvider(request("river"));
    await completeWithProvider({ ...request("river"), thinking: { enabled: false, effort: "max" } });
    expect(transport.generations).toHaveLength(3);
    expect(effortOf(transport.generations.at(-1)!)).toBeUndefined();
  });
});

it("reuses a validation response's supported list instead of issuing more effort probes", async () => {
  const transport = installTransport((record) => ["low", "high"].includes(String(effortOf(record)))
    ? successful(record)
    : jsonResponse({ error: { message: "reasoning_effort must be one of low, high" } }, 400));
  await completeWithProvider(request("river"));
  expect(transport.generations.map(effortOf)).toEqual(["max", "high"]);
  expect(displayReasoningEfforts("river", model)).toEqual(["low", "high"]);
  const before = transport.generations.length;
  await completeWithProvider(request("river", "low"));
  expect(transport.generations.slice(before).map(effortOf)).toEqual(["low"]);
});

it("does not repeat rejected efforts when the entire ladder is unsupported", async () => {
  const transport = installTransport((record) => effortOf(record) === undefined
    ? successful(record)
    : jsonResponse({ error: { message: "reasoning_effort is unsupported" } }, 400));
  await completeWithProvider(request("river"));
  expect(transport.generations.map(effortOf)).toEqual(["max", "xhigh", "high", "medium", "low", "minimal", "none", undefined]);
  const before = transport.generations.length;
  await completeWithProvider(request("river"));
  expect(transport.generations.slice(before).map(effortOf)).toEqual([undefined]);
});
