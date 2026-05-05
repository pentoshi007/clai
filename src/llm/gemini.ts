import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
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
        body: JSON.stringify({
          systemInstruction: systemInstruction(request.messages),
          contents: geminiContents(request.messages),
          generationConfig: {
            temperature: request.temperature ?? 0.2,
            maxOutputTokens: request.maxTokens ?? 1_024,
          },
        }),
      },
    );
    const data = await readJson<{
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    }>(response);
    const text = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!text) {
      throw new Error("Gemini returned no completion text");
    }
    return { text, provider: "gemini", model };
  },
};
