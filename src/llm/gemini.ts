import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ReasoningPreference,
} from "../types.js";
import {
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import { readJson } from "./http.js";

function geminiContents(
  messages: ChatMessage[],
): Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));
}

function systemInstruction(
  messages: ChatMessage[],
): { parts: Array<{ text: string }> } | undefined {
  const system = messages.find((message) => message.role === "system");
  return system ? { parts: [{ text: system.content }] } : undefined;
}

function geminiThinkingBudget(reasoning: ReasoningPreference | undefined): number | undefined {
  if (!reasoning?.enabled) return undefined;
  switch (reasoning.effort) {
    case "low":
      return 1_024;
    case "high":
      return 16_384;
    default:
      return 4_096;
  }
}

function geminiBody(request: CompletionRequest): string {
  const thinkingBudget = geminiThinkingBudget(request.thinking);
  const body: Record<string, unknown> = {
    contents: geminiContents(request.messages),
    generationConfig: {
      temperature: request.temperature ?? 0.2,
      maxOutputTokens: request.maxTokens ?? 1_024,
      ...(thinkingBudget !== undefined
        ? { thinkingConfig: { thinkingBudget, includeThoughts: true } }
        : {}),
    },
  };
  const sys = systemInstruction(request.messages);
  if (sys) body.systemInstruction = sys;
  return JSON.stringify(body);
}

export const geminiProvider: LlmProvider = {
  id: "gemini",
  displayName: "Google Gemini",
  defaultModel: defaultModels.gemini,
  envVar: "GEMINI_API_KEY",
  validateKey: (key: string) => /^AIza[0-9A-Za-z_-]{12,}$/.test(key),
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("Gemini API key is required");
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(auth.apiKey)}`,
    );
    await readJson<unknown>(response);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Gemini API key is required");
    const model = request.model ?? defaultModels.gemini;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(auth.apiKey)}`,
      {
        method: "POST",
        signal: request.signal ?? null,
        headers: { "content-type": "application/json" },
        body: geminiBody(request),
      },
    );
    const data = await readJson<{
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string; thought?: boolean }>;
        };
      }>;
    }>(response);
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const thought = parts
      .filter((part) => part.thought)
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    const text = parts
      .filter((part) => !part.thought)
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!text) {
      throw new Error("Gemini returned no completion text");
    }
    const final = thought ? `<think>${thought}</think>${text}` : text;
    return { text: final, provider: "gemini", model };
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Gemini API key is required");
    const model = request.model ?? defaultModels.gemini;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(auth.apiKey)}`,
      {
        method: "POST",
        signal: request.signal ?? null,
        headers: { "content-type": "application/json" },
        body: geminiBody(request),
      },
    );
    if (!response.ok) {
      await readJson<unknown>(response);
    }
    if (!response.body) {
      throw new Error("Gemini returned no stream body");
    }
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let full = "";
    let inThought = false;

    const enterThought = (): void => {
      if (inThought) return;
      inThought = true;
      full += "<think>";
      onToken("<think>");
    };
    const exitThought = (): void => {
      if (!inThought) return;
      inThought = false;
      full += "</think>";
      onToken("</think>");
    };

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
        if (payload === "[DONE]") {
          exitThought();
          return { text: full, provider: "gemini", model };
        }
        try {
          const parsed = JSON.parse(payload) as {
            candidates?: Array<{
              content?: {
                parts?: Array<{ text?: string; thought?: boolean }>;
              };
            }>;
          };
          const parts = parsed.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            if (!part.text) continue;
            if (part.thought) {
              enterThought();
              full += part.text;
              onToken(part.text);
            } else {
              if (inThought) exitThought();
              full += part.text;
              onToken(part.text);
            }
          }
        } catch {
          // Ignore malformed keepalive lines.
        }
      }
    }
    exitThought();
    return { text: full, provider: "gemini", model };
  },
};
