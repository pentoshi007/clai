import type { CompletionRequest, CompletionResult } from "../types.js";
import {
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import { readJson } from "./http.js";

function base(auth: ProviderAuth): string {
  return (auth.baseUrl ?? auth.apiKey ?? "http://localhost:11434").replace(
    /\/$/,
    "",
  );
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
    const model = request.model ?? defaultModels.ollama;
    const response = await fetch(`${base(auth)}/api/chat`, {
      method: "POST",
      signal: request.signal ?? null,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: request.messages.map((message) => ({
          role: message.role === "tool" ? "user" : message.role,
          content: message.content,
        })),
        stream: false,
        options: { temperature: request.temperature ?? 0.2 },
      }),
    });
    const data = await readJson<{ message?: { content?: string } }>(response);
    const text = data.message?.content?.trim();
    if (!text) {
      throw new Error("Ollama returned no completion text");
    }
    return { text, provider: "ollama", model };
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    const model = request.model ?? defaultModels.ollama;
    const response = await fetch(`${base(auth)}/api/chat`, {
      method: "POST",
      signal: request.signal ?? null,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: request.messages.map((message) => ({
          role: message.role === "tool" ? "user" : message.role,
          content: message.content,
        })),
        stream: true,
        options: { temperature: request.temperature ?? 0.2 },
      }),
    });
    if (!response.ok) {
      await readJson<unknown>(response);
    }
    if (!response.body) {
      throw new Error("Ollama returned no stream body");
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
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as {
            message?: { content?: string };
            done?: boolean;
          };
          const token = parsed.message?.content;
          if (token) {
            full += token;
            onToken(token);
          }
          if (parsed.done) {
            return { text: full, provider: "ollama", model };
          }
        } catch {
          // Ignore malformed lines.
        }
      }
    }
    return { text: full, provider: "ollama", model };
  },
};
