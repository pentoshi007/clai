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
import { ProviderError, readJson, readStreamLines } from "./http.js";

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

function geminiContents(
  messages: ChatMessage[],
): Array<{ role: "user" | "model"; parts: GeminiPart[] }> {
  const contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];

  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "model" : "user";
    const parts: GeminiPart[] = [];
    if (message.content.trim()) parts.push({ text: message.content });
    if (role === "user" && message.images) {
      for (const img of message.images) {
        parts.push({
          inlineData: { mimeType: img.mediaType, data: img.dataBase64 },
        });
      }
    }

    // Never serialize an empty content part. Apart from being meaningless,
    // Gemini can subsequently return empty candidates after an empty `model`
    // turn. If a caller omitted an assistant turn, merge the adjacent user
    // instructions instead to retain Gemini's alternating-role invariant.
    if (parts.length === 0) continue;
    const previous = contents.at(-1);
    if (previous?.role === role) {
      previous.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  }
  return contents;
}

function systemInstruction(
  messages: ChatMessage[],
): { parts: Array<{ text: string }> } | undefined {
  const system = messages.find((message) => message.role === "system");
  return system ? { parts: [{ text: system.content }] } : undefined;
}

function isGemini3Model(model: string): boolean {
  return /gemini-3(?:[.-]|$)/i.test(model);
}

function geminiThinkingConfig(
  reasoning: ReasoningPreference | undefined,
  model: string,
): Record<string, unknown> | undefined {
  if (!reasoning) return undefined;
  if (isGemini3Model(model)) {
    // Gemini 3 models use `thinkingLevel`, not Gemini 2.5's token budget.
    // Flash-Lite supports `minimal`, which is the closest available recovery
    // mode when the runner needs a visible answer instead of a long thought.
    // 3.1 Pro does not support `minimal`, so `low` is its least costly mode.
    const effort = reasoning?.effort ?? "medium";
    const wantsMinimal = !reasoning?.enabled || effort === "none" || effort === "minimal";
    const isPro = /gemini-3(?:\.\d)?-pro/i.test(model);
    const thinkingLevel = wantsMinimal
      ? isPro
        ? "low"
        : "minimal"
      : effort === "low"
        ? "low"
        : effort === "high" || effort === "xhigh"
          ? "high"
          : "medium";
    return {
      thinkingLevel,
      // On a recovery retry, keep Gemini's minimal internal reasoning but do
      // not stream thought summaries back as an apparent empty completion.
      ...(reasoning?.enabled ? { includeThoughts: true } : {}),
    };
  }

  if (!/gemini-2\.5/i.test(model)) return undefined;
  if (!reasoning?.enabled) {
    // Flash and Flash-Lite support an explicit zero budget. Gemini 2.5 Pro
    // cannot disable thinking, so omit the control rather than send an
    // invalid value.
    return /gemini-2\.5-(?:flash|flash-lite)/i.test(model)
      ? { thinkingBudget: 0 }
      : undefined;
  }
  switch (reasoning.effort) {
    case "low":
      return { thinkingBudget: 1_024, includeThoughts: true };
    case "high":
    case "xhigh":
      return { thinkingBudget: 16_384, includeThoughts: true };
    default:
      return { thinkingBudget: 4_096, includeThoughts: true };
  }
}

export function geminiBody(request: CompletionRequest): string {
  const model = request.model ?? defaultModels.gemini;
  const thinkingConfig = geminiThinkingConfig(request.thinking, model);
  const defaultMaxTokens = request.thinking?.enabled ? 8_192 : 4_096;
  const body: Record<string, unknown> = {
    contents: geminiContents(request.messages),
    generationConfig: {
      temperature: request.temperature ?? 0.2,
      maxOutputTokens: request.maxTokens ?? defaultMaxTokens,
      ...(thinkingConfig !== undefined
        ? { thinkingConfig }
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
  async listModels(auth: ProviderAuth): Promise<string[]> {
    if (!auth.apiKey) throw new Error("Gemini API key is required");
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(auth.apiKey)}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to list Gemini models: HTTP ${response.status}`);
    }
    const data = await readJson<{
      models?: Array<{
        name?: string;
        supportedGenerationMethods?: string[];
      }>;
    }>(response);
    return (
      data.models
        ?.filter((m) => m.name && m.supportedGenerationMethods?.includes("generateContent"))
        .map((m) => m.name!.replace(/^models\//, ""))
        .sort() ?? []
    );
  },
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
      throw new ProviderError("Gemini completed without a visible answer.");
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
    let full = "";
    let visible = "";
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

    for await (const line of readStreamLines(response, {
      signal: request.signal,
    })) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        exitThought();
        if (!visible.trim()) {
          throw new ProviderError("Gemini completed without a visible answer.");
        }
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
            visible += part.text;
            full += part.text;
            onToken(part.text);
          }
        }
      } catch {
        // Ignore malformed keepalive lines.
      }
    }
    exitThought();
    if (!visible.trim()) {
      throw new ProviderError("Gemini completed without a visible answer.");
    }
    return { text: full, provider: "gemini", model };
  },
};
