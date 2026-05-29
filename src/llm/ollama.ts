import type { ChatMessage, CompletionRequest, CompletionResult } from "../types.js";
import {
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import { readJson, readStreamLines } from "./http.js";

function base(auth: ProviderAuth): string {
  return (auth.baseUrl ?? auth.apiKey ?? "http://localhost:11434").replace(
    /\/$/,
    "",
  );
}

/** Ollama's /api/chat takes a per-message `images` array of base64 strings. */
function toOllamaMessages(
  messages: ChatMessage[],
): Array<{ role: string; content: string; images?: string[] }> {
  return messages.map((message) => {
    const role = message.role === "tool" ? "user" : message.role;
    if (role === "user" && message.images && message.images.length > 0) {
      return {
        role,
        content: message.content,
        images: message.images.map((img) => img.dataBase64),
      };
    }
    return { role, content: message.content };
  });
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
        messages: toOllamaMessages(request.messages),
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
        messages: toOllamaMessages(request.messages),
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
    let full = "";

    for await (const line of readStreamLines(response, {
      signal: request.signal,
    })) {
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
    return { text: full, provider: "ollama", model };
  },
};
