import type { CompletionRequest, CompletionResult } from "../types.js";
import {
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import { readJson } from "./http.js";

const baseUrl = "https://api.anthropic.com/v1";
const anthropicVersion = "2023-06-01";

export const anthropicProvider: LlmProvider = {
  id: "anthropic",
  displayName: "Anthropic",
  defaultModel: defaultModels.anthropic,
  envVar: "ANTHROPIC_API_KEY",
  validateKey: (key: string) => /^sk-ant-[A-Za-z0-9_-]{12,}$/.test(key),
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("Anthropic API key is required");
    const response = await fetch(`${baseUrl}/models`, {
      headers: {
        "x-api-key": auth.apiKey,
        "anthropic-version": anthropicVersion,
      },
    });
    await readJson<unknown>(response);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Anthropic API key is required");
    const model = request.model ?? defaultModels.anthropic;
    const system = request.messages.find(
      (message) => message.role === "system",
    )?.content;
    const messages = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      }));
    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      signal: request.signal ?? null,
      headers: {
        "content-type": "application/json",
        "x-api-key": auth.apiKey,
        "anthropic-version": anthropicVersion,
      },
      body: JSON.stringify({
        model,
        system,
        messages,
        max_tokens: request.maxTokens ?? 1_024,
        temperature: request.temperature ?? 0.2,
      }),
    });
    const data = await readJson<{
      content?: Array<{ type: string; text?: string }>;
    }>(response);
    const text = data.content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!text) {
      throw new Error("Anthropic returned no completion text");
    }
    return { text, provider: "anthropic", model };
  },
};
