import type { CompletionRequest, CompletionResult } from "../types.js";
import {
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import {
  imageCapableMessages,
  readJson,
  readStreamLines,
  streamIdleBudgets,
} from "./http.js";
import { generationFetch } from "./operation-usage.js";
import {
  parseOllamaToolCalls,
  toOllamaToolMessages,
  toOllamaTools,
} from "./adapters/ollama-tools.js";
import { modelContextWindow, parseOllamaUsage } from "./token-usage.js";
import { resolveSampling } from "./sampling.js";
import { compileRequestPlan } from "./request-plan.js";
import { OLLAMA_STREAM_TERMINAL, PartialStreamError } from "./stream-terminal.js";
import type { TokenUsage } from "../types.js";

const OLLAMA_MAX_NUM_CTX = 32_768;
const OLLAMA_DEFAULT_NUM_PREDICT = 4_096;
const OLLAMA_KEEP_ALIVE = "5m";

export function ollamaOptions(
  model: string,
  request: {
    temperature?: number | undefined;
    maxTokens?: number | undefined;
    reasoningEnabled?: boolean | undefined;
  },
): Record<string, unknown> {
  const sampling = resolveSampling({
    provider: "ollama",
    model,
    reasoningEnabled: request.reasoningEnabled,
    requestedTemperature: request.temperature,
  });
  return {
    temperature: sampling.temperature,
    ...(sampling.topP !== undefined ? { top_p: sampling.topP } : {}),
    num_ctx: Math.min(modelContextWindow(model, "ollama"), OLLAMA_MAX_NUM_CTX),
    num_predict: request.maxTokens ?? OLLAMA_DEFAULT_NUM_PREDICT,
  };
}

function base(auth: ProviderAuth): string {
  return (auth.baseUrl ?? auth.apiKey ?? "http://localhost:11434").replace(
    /\/$/,
    "",
  );
}

function ollamaChatBody(
  request: CompletionRequest,
  auth: ProviderAuth,
  stream: boolean,
): { model: string; body: Record<string, unknown> } {
  const model = request.model ?? defaultModels.ollama;
  const plan = compileRequestPlan({
    provider: "ollama",
    model,
    messages: request.messages,
    stream,
    endpoint: base(auth),
    reasoning: request.thinking,
    tools: request.tools,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
  });
  const body: Record<string, unknown> = {
    model,
    messages: toOllamaToolMessages(
      imageCapableMessages("ollama", model, [...plan.timeline.messages]),
    ),
    stream,
    options: ollamaOptions(model, {
      temperature: plan.controls.temperature,
      maxTokens: plan.controls.requestedMaxTokens,
      reasoningEnabled: Boolean(plan.controls.reasoning?.enabled),
    }),
    keep_alive: OLLAMA_KEEP_ALIVE,
  };
  if (plan.tools.definitions.length) {
    body.tools = toOllamaTools([...plan.tools.definitions]);
  }
  return { model, body };
}

export const ollamaProvider: LlmProvider = {
  id: "ollama",
  displayName: "Ollama",
  defaultModel: defaultModels.ollama,
  envVar: "OLLAMA_HOST",
  validateKey: (key: string) => /^https?:\/\/.+/.test(key),
  async ping(auth: ProviderAuth): Promise<void> {
    const response = await fetch(`${base(auth)}/api/tags`);
    await readJson<unknown>(response);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    const { model, body } = ollamaChatBody(request, auth, false);
    const response = await generationFetch(`${base(auth)}/api/chat`, {
      method: "POST",
      signal: request.signal ?? null,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await readJson<{
      message?: {
        content?: string;
        tool_calls?: Array<{
          id?: string;
          function?: {
            name?: string;
            arguments?: string | Record<string, unknown>;
          };
        }>;
      };
      prompt_eval_count?: number;
      eval_count?: number;
    }>(response);
    const toolCalls = parseOllamaToolCalls(data.message?.tool_calls);
    const text = data.message?.content?.trim() ?? "";
    if (!text && toolCalls.length === 0) {
      throw new Error("Ollama returned no completion text");
    }
    const usage = parseOllamaUsage({
      prompt_eval_count: data.prompt_eval_count,
      eval_count: data.eval_count,
    });
    return {
      text,
      provider: "ollama",
      model,
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(toolCalls.length ? { finishReason: "tool_calls" } : {}),
      ...(usage ? { usage } : {}),
    };
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    const { model, body } = ollamaChatBody(request, auth, true);
    const response = await generationFetch(`${base(auth)}/api/chat`, {
      method: "POST",
      signal: request.signal ?? null,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await readJson<unknown>(response);
    }
    if (!response.body) {
      throw new Error("Ollama returned no stream body");
    }
    let full = "";
    let toolCalls = parseOllamaToolCalls(undefined);
    let streamUsage: TokenUsage | undefined;

    for await (const line of readStreamLines(response, {
      signal: request.signal,
      ...streamIdleBudgets(Boolean(request.thinking?.enabled)),
      outputProgress: () => full.length + toolCalls.length,
    })) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as {
          error?: string;
          message?: {
            content?: string;
            tool_calls?: Array<{
              id?: string;
              function?: {
                name?: string;
                arguments?: string | Record<string, unknown>;
              };
            }>;
          };
          done?: boolean;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        if (typeof parsed.error === "string" && parsed.error.trim()) {
          throw new Error(`Ollama: ${parsed.error}`);
        }
        const token = parsed.message?.content;
        if (token) {
          full += token;
          onToken(token);
        }
        if (parsed.message?.tool_calls?.length) {
          toolCalls = [
            ...toolCalls,
            ...parseOllamaToolCalls(parsed.message.tool_calls),
          ];
        }
        if (parsed.done) {
          streamUsage =
            parseOllamaUsage({
              prompt_eval_count: parsed.prompt_eval_count,
              eval_count: parsed.eval_count,
            }) ?? streamUsage;
          return {
            text: full,
            provider: "ollama",
            model,
            ...(toolCalls.length ? { toolCalls } : {}),
            ...(toolCalls.length ? { finishReason: "tool_calls" } : {}),
            ...(streamUsage ? { usage: streamUsage } : {}),
          };
        }
      } catch (frameError) {
        if (!(frameError instanceof SyntaxError)) throw frameError;
      }
    }
    let ollamaToolArgumentBytes = 0;
    for (const call of toolCalls) {
      ollamaToolArgumentBytes += JSON.stringify(call.args ?? {}).length;
    }
    throw new PartialStreamError("Ollama", OLLAMA_STREAM_TERMINAL.proofs, {
      answerBytes: full.length,
      reasoningBytes: 0,
      toolArgumentBytes: ollamaToolArgumentBytes,
    });
  },
};
