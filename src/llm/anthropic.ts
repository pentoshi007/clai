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
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
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
        stream: true,
      }),
    });
    if (!response.ok) {
      await readJson<unknown>(response);
    }
    if (!response.body) {
      throw new Error("Anthropic returned no stream body");
    }
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let full = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return { text: full, provider: "anthropic", model };
        try {
          const parsed = JSON.parse(payload) as {
            type?: string;
            delta?: { type?: string; text?: string };
          };
          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            full += parsed.delta.text;
            onToken(parsed.delta.text);
          }
        } catch {
          // Ignore malformed keepalive lines.
        }
      }
    }
    return { text: full, provider: "anthropic", model };
  },
};
