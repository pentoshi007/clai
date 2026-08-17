import type { ProviderKeySlot } from "../../src/store/keys.js";
import type { ChatMessage } from "../../src/types.js";
import type { FakeTransport } from "../conformance/fake-transport.js";

export function response(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function chatCompletion(
  text: string,
  model: string,
  finishReason = "stop",
): Response {
  return response({
    id: "chatcmpl_admission",
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });
}

function providerError(
  status: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return response({ error: { message } }, status, headers);
}

export function rateLimitedWithoutBackoff(): Response {
  return providerError(429, "rate limit reached for this key", {
    "retry-after": "0",
  });
}

export function upstreamUnavailable(): Response {
  return providerError(500, "upstream is temporarily unavailable");
}

export function quotaExhausted(): Response {
  return providerError(402, "insufficient credits for this key");
}

export function authRejected(): Response {
  return providerError(401, "invalid api key");
}

export function modelNotFound(): Response {
  return providerError(404, "the model does not exist");
}

export function contextTooLarge(): Response {
  return providerError(413, "request entity too large for this model");
}

export function toolsUnsupported(): Response {
  return providerError(400, "tools are not supported by this model");
}

export function reasoningControlUnsupported(): Response {
  return providerError(400, "unknown request argument supplied: reasoning_effort");
}

export function imageInputUnsupported(): Response {
  return providerError(400, "image_url is not supported by this model");
}

export function metaBudgetIncomplete(model: string): Response {
  return response({
    id: "resp_admission",
    object: "response",
    model,
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [
      {
        type: "reasoning",
        id: "rs_admission",
        summary: [],
        encrypted_content: "ENCRYPTED-ADMISSION-ARTIFACT",
      },
    ],
    usage: { input_tokens: 12, output_tokens: 64, total_tokens: 76 },
  });
}

export function keySlots(values: readonly string[]): ProviderKeySlot[] {
  return values.map((value, index) => ({
    id: `slot-${index + 1}`,
    value,
    createdAt: index,
  }));
}

export function disabledSlots(values: readonly string[]): ProviderKeySlot[] {
  return keySlots(values).map((slot) => ({ ...slot, disabled: true }));
}

export function admittedHosts(transport: FakeTransport): string[] {
  return transport.generations.map((request) => new URL(request.url).host);
}

export function admittedKeys(transport: FakeTransport): string[] {
  return transport.generations.map((request) =>
    (request.headers.authorization ?? "").replace(/^Bearer\s+/i, ""),
  );
}

export function userTurn(content = "baseline turn"): ChatMessage[] {
  return [{ role: "user", content }];
}
