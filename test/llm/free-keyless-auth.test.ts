import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CompletionRequest } from "../../src/types.js";
import { freeProvider } from "../../src/llm/free.js";
import { OperationLedger, singleAdmissionOperationPolicy } from "../../src/llm/operation-ledger.js";
import { runGenerationAttempt } from "../../src/llm/operation-usage.js";
import { withSessionAffinity } from "../../src/llm/session-affinity.js";
import { resetResponsesWireStatesForTesting } from "../../src/llm/wire/responses-first.js";

const staleAuth = { apiKey: "stale-mac-credential" };
const museModel = "free-1/muse-spark-1.3-contributor-free";
const modes = ["complete", "stream"] as const;

function failure(status = 401): Response {
  return new Response(JSON.stringify({
    error: { type: "server_error", message: "Upstream request failed: Invalid credential" },
  }), { status, headers: { "content-type": "application/json" } });
}

function sse(events: readonly Record<string, unknown>[]): Response {
  const data = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(`${data}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function success(url: string): Response {
  if (!url.endsWith("/responses")) {
    return sse([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }]);
  }
  return new Response(JSON.stringify({
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
    usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
  }), { headers: { "content-type": "application/json" } });
}

function credentialMock() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("authorization");
    return authorization === `Bearer ${staleAuth.apiKey}` ? failure() : success(String(input));
  });
}

function request(model = museModel): CompletionRequest {
  return { model, messages: [{ role: "user", content: "Reply OK" }] };
}

async function run(mode: typeof modes[number], req = request(), auth = staleAuth) {
  const tokens: string[] = [];
  const onStatus = vi.fn();
  const result = mode === "complete"
    ? await freeProvider.complete(req, auth, onStatus)
    : await freeProvider.stream!(req, auth, token => tokens.push(token), onStatus);
  return { result, tokens, onStatus };
}

beforeEach(() => resetResponsesWireStatesForTesting());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(modes)("uses public Zen authentication on the first %s request despite a saved key", async mode => {
  const fetchMock = credentialMock();
  vi.stubGlobal("fetch", fetchMock);
  const { result, tokens, onStatus } = await withSessionAffinity("mac-keyless-session", () => run(mode));
  expect(result.text).toBe("OK");
  expect(result.model).toBe(museModel);
  expect(tokens.join("")).toBe(mode === "stream" ? "OK" : "");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const headers = new Headers(fetchMock.mock.calls[0]![1]?.headers);
  expect(headers.get("authorization")).toBe("Bearer public");
  expect(headers.get("x-opencode-session")).toMatch(/^ses_/);
  expect(headers.get("x-session-affinity")).toBeTruthy();
  expect(staleAuth.apiKey).toBe("stale-mac-credential");
  expect(onStatus).not.toHaveBeenCalled();
});

it.each(modes)("uses public access for unfamiliar and unprefixed Zen models in %s mode", async mode => {
  const fetchMock = credentialMock();
  vi.stubGlobal("fetch", fetchMock);
  for (const model of ["free-1/future-model-free", "future-model-free", "big-pickle"]) {
    expect((await run(mode, request(model))).result.text).toBe("OK");
  }
  expect(fetchMock).toHaveBeenCalledTimes(3);
  for (const [url, init] of fetchMock.mock.calls) {
    expect(String(url)).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer public");
  }
});

it.each(modes)("preserves the prompt body and cache affinity across public %s calls", async mode => {
  const fetchMock = credentialMock();
  vi.stubGlobal("fetch", fetchMock);
  await withSessionAffinity("stable-public-session", async () => {
    await run(mode);
    await run(mode, request(), { apiKey: "another-stored-key" });
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const first = fetchMock.mock.calls[0]![1]!;
  const second = fetchMock.mock.calls[1]![1]!;
  expect(second.body).toBe(first.body);
  for (const name of ["authorization", "x-opencode-session", "x-session-affinity"]) {
    expect(new Headers(second.headers).get(name)).toBe(new Headers(first.headers).get(name));
  }
});

it.each(modes)("uses keyless Kilo authentication from the first %s request despite a saved key", async mode => {
  const fetchMock = credentialMock();
  vi.stubGlobal("fetch", fetchMock);
  const { result, onStatus } = await run(mode, request("free-2/future-model:free"));
  expect(result.text).toBe("OK");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (const [url, init] of fetchMock.mock.calls) {
    expect(String(url)).toContain("https://api.kilo.ai/api/gateway/");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
  }
  expect(onStatus).not.toHaveBeenCalled();
  expect(staleAuth.apiKey).toBe("stale-mac-credential");
});

it.each(["free-1/premium-model", "free-1/muse-spark-1.3", "free-2/premium-model"])("preserves valid configured authentication for %s", async model => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => success(String(input)));
  vi.stubGlobal("fetch", fetchMock);
  expect((await run("stream", request(model))).result.text).toBe("OK");
  expect(new Headers(fetchMock.mock.calls.at(-1)![1]?.headers).get("authorization")).toBe(`Bearer ${staleAuth.apiKey}`);
});

it.each(["free-1/premium-model", "free-2/premium-model"])("does not drop authentication for %s", async model => {
  const fetchMock = credentialMock();
  vi.stubGlobal("fetch", fetchMock);
  await expect(run("stream", request(model))).rejects.toMatchObject({ status: 401 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([400, 401, 402, 403, 429, 503])("does not retry a public Zen HTTP %s response", async status => {
  const fetchMock = vi.fn(async () => failure(status));
  vi.stubGlobal("fetch", fetchMock);
  await expect(run("stream")).rejects.toMatchObject({ status });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([{}, { apiKey: "public" }, staleAuth])("does not retry public Zen authentication (%j)", async auth => {
  const fetchMock = vi.fn(async () => failure());
  vi.stubGlobal("fetch", fetchMock);
  await expect(freeProvider.complete(request(), auth)).rejects.toMatchObject({ status: 401 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("does not dispatch after cancellation", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const fetchMock = credentialMock();
  vi.stubGlobal("fetch", fetchMock);
  await expect(run("stream", { ...request(), signal: controller.signal })).rejects.toThrow("cancelled");
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(modes)("needs only one admission even when a stored key exists in %s mode", async mode => {
  const fetchMock = credentialMock();
  vi.stubGlobal("fetch", fetchMock);
  const ledger = new OperationLedger(singleAdmissionOperationPolicy("compaction"));
  const req = { ...request(), attemptUsage: ledger };
  const result = await runGenerationAttempt(req, { provider: "free", model: museModel, mode, reason: "initial" },
    async () => (await run(mode, req)).result);
  expect(result.text).toBe("OK");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(ledger.snapshot().attempts).toHaveLength(1);
  expect(ledger.snapshot().attempts[0]).toMatchObject({ outcome: "success", reason: "initial" });
});

it.each(["answer", "reasoning", "tool"] as const)("does not regenerate after %s output followed by an in-stream auth error", async output => {
  const progress = {
    answer: { type: "response.output_text.delta", delta: "partial" },
    reasoning: { type: "response.reasoning_summary_text.delta", delta: "thinking" },
    tool: { type: "response.output_item.added", output_index: 0,
      item: { type: "function_call", id: "fc1", call_id: "c1", name: "read", arguments: "" } },
  };
  const fetchMock = vi.fn(async () => sse([
    progress[output],
    { type: "error", error: { type: "authentication_error", message: "Invalid credential" } },
  ]));
  vi.stubGlobal("fetch", fetchMock);
  const req: CompletionRequest = { ...request(),
    tools: [{ name: "read", parameters: { type: "object" } }],
    onStreamEvent: vi.fn(), onToolCallDelta: vi.fn(), thinking: { enabled: true },
  };
  const tokens: string[] = [];
  await expect(freeProvider.stream!(req, staleAuth, token => tokens.push(token)))
    .rejects.toMatchObject({ name: "ProviderError", status: 401 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  if (output === "answer") expect(tokens).toEqual(["partial"]);
  if (output === "reasoning") expect(req.onStreamEvent).toHaveBeenCalledWith({ type: "reasoning_delta", text: "thinking" });
  if (output === "tool") expect(req.onToolCallDelta).toHaveBeenCalled();
});

it.each(modes)("omits configured credentials for Kilo aliases and preserves cache affinity in %s mode", async mode => {
  const fetchMock = credentialMock();
  vi.stubGlobal("fetch", fetchMock);
  for (const model of ["free-2/kilo-auto/free", "free-2/openrouter/free", "free-2/stepfun/step-3.7-flash:free"]) {
    resetResponsesWireStatesForTesting();
    await withSessionAffinity("stable-kilo-session", async () => {
      const req = request(model);
      await run(mode, req);
      const first = fetchMock.mock.calls.at(-1)![1]!;
      await run(mode, req, { apiKey: "another-stored-key" });
      const second = fetchMock.mock.calls.at(-1)![1]!;
      expect(second.body).toBe(first.body);
      expect(new Headers(second.headers).get("x-session-affinity"))
        .toBe(new Headers(first.headers).get("x-session-affinity"));
    });
  }
  for (const [, init] of fetchMock.mock.calls) {
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
  }
});

it.each([400, 401, 402, 403, 429, 503])("does not perform a credential retry after a keyless Kilo HTTP %s error", async status => {
  const fetchMock = vi.fn(async () => failure(status));
  vi.stubGlobal("fetch", fetchMock);
  const onStatus = vi.fn();
  await expect(freeProvider.stream!(request("free-2/future-model:free"), staleAuth, vi.fn(), onStatus))
    .rejects.toMatchObject({ status });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).has("authorization")).toBe(false);
  expect(onStatus).not.toHaveBeenCalled();
});

it("does not dispatch a keyless Kilo request after cancellation", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const fetchMock = credentialMock();
  vi.stubGlobal("fetch", fetchMock);
  await expect(run("stream", { ...request("free-2/kilo-auto/free"), signal: controller.signal }))
    .rejects.toThrow("cancelled");
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(modes)("needs only one generation admission for keyless Kilo in %s mode", async mode => {
  const fetchMock = credentialMock();
  vi.stubGlobal("fetch", fetchMock);
  const ledger = new OperationLedger(singleAdmissionOperationPolicy("compaction"));
  const model = "free-2/future-model:free";
  const req = { ...request(model), attemptUsage: ledger };
  const result = await runGenerationAttempt(req, { provider: "free", model, mode, reason: "initial" },
    async () => (await run(mode, req)).result);
  expect(result.text).toBe("OK");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(ledger.snapshot().attempts).toHaveLength(1);
  expect(ledger.snapshot().attempts[0]).toMatchObject({ outcome: "success", reason: "initial" });
});
