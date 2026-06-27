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
import { readJson, readStreamLines } from "./http.js";

const baseUrl = "https://bedrock-mantle.ap-south-1.api.aws/anthropic/v1";
const modelsBaseUrl = "https://bedrock-mantle.ap-south-1.api.aws";
const anthropicVersion = "2023-06-01";

function getWorkspaceId(): string {
  return process.env.ANTHROPIC_WORKSPACE_ID ?? "default";
}

type AnthropicBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

function toAnthropicMessages(
  messages: ChatMessage[],
): Array<{ role: "user" | "assistant"; content: string | AnthropicBlock[] }> {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const role = message.role === "assistant" ? "assistant" : "user";
      if (role === "user" && message.images && message.images.length > 0) {
        const blocks: AnthropicBlock[] = [];
        if (message.content) blocks.push({ type: "text", text: message.content });
        for (const img of message.images) {
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: img.mediaType,
              data: img.dataBase64,
            },
          });
        }
        return { role, content: blocks };
      }
      return { role, content: message.content };
    });
}

function anthropicThinkingBudget(reasoning: ReasoningPreference | undefined): number | undefined {
  if (!reasoning?.enabled) return undefined;
  switch (reasoning.effort) {
    case "low":
      return 1_024;
    case "high":
      return 8_192;
    default:
      return 4_096;
  }
}

export const mantleProvider: LlmProvider = {
  id: "aws-mantle",
  displayName: "AWS Mantle",
  defaultModel: defaultModels["aws-mantle"],
  envVar: "ANTHROPIC_API_KEY",
  validateKey: (key: string) => /^[A-Za-z0-9+/=_-]{8,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    if (!auth.apiKey) throw new Error("Mantle API key is required");
    const response = await fetch(`${modelsBaseUrl}/v1/models`, {
      headers: {
        "x-api-key": auth.apiKey,
        "anthropic-version": anthropicVersion,
      },
    });
    const data = await readJson<
      | Array<{ id?: string } | string>
      | { data?: Array<{ id?: string } | string>; models?: Array<{ id?: string } | string> }
    >(response);
    const entries = Array.isArray(data) ? data : (data.data ?? data.models ?? []);
    return entries
      .map((entry) => typeof entry === "string" ? entry : entry.id)
      .filter((id): id is string => Boolean(id))
      .sort();
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("Mantle API key is required");
    const response = await fetch(`${modelsBaseUrl}/v1/models`, {
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
    if (!auth.apiKey) throw new Error("Mantle API key is required");
    const model = request.model ?? defaultModels["aws-mantle"];
    const system = request.messages.find(
      (message) => message.role === "system",
    )?.content;
    const messages = toAnthropicMessages(request.messages);
    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      signal: request.signal ?? null,
      headers: {
        "content-type": "application/json",
        "x-api-key": auth.apiKey,
        "anthropic-version": anthropicVersion,
        "anthropic-workspace-id": getWorkspaceId(),
      },
      body: JSON.stringify({
        model,
        system,
        messages,
        max_tokens: request.maxTokens ?? 1_024,
        temperature: request.temperature ?? 0.2,
        ...(anthropicThinkingBudget(request.thinking) !== undefined
          ? {
              thinking: {
                type: "enabled",
                budget_tokens: anthropicThinkingBudget(request.thinking),
              },
            }
          : {}),
      }),
    });
    const data = await readJson<{
      content?: Array<{ type: string; text?: string; thinking?: string }>;
    }>(response);
    const thinkingText = data.content
      ?.filter((part) => part.type === "thinking")
      .map((part) => part.thinking ?? "")
      .join("")
      .trim();
    const text = data.content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!text) {
      throw new Error("Mantle returned no completion text");
    }
    const final = thinkingText ? `<thinking>${thinkingText}</thinking>${text}` : text;
    return { text: final, provider: "aws-mantle", model };
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Mantle API key is required");
    const model = request.model ?? defaultModels["aws-mantle"];
    const system = request.messages.find(
      (message) => message.role === "system",
    )?.content;
    const messages = toAnthropicMessages(request.messages);
    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      signal: request.signal ?? null,
      headers: {
        "content-type": "application/json",
        "x-api-key": auth.apiKey,
        "anthropic-version": anthropicVersion,
        "anthropic-workspace-id": getWorkspaceId(),
      },
      body: JSON.stringify({
        model,
        system,
        messages,
        max_tokens: request.maxTokens ?? 1_024,
        temperature: request.temperature ?? 0.2,
        stream: true,
        ...(anthropicThinkingBudget(request.thinking) !== undefined
          ? {
              thinking: {
                type: "enabled",
                budget_tokens: anthropicThinkingBudget(request.thinking),
              },
            }
          : {}),
      }),
    });
    if (!response.ok) {
      await readJson<unknown>(response);
    }
    if (!response.body) {
      throw new Error("Mantle returned no stream body");
    }
    let full = "";
    let inThinking = false;

    const enterThinking = (): void => {
      if (inThinking) return;
      inThinking = true;
      full += "<thinking>";
      onToken("<thinking>");
    };
    const exitThinking = (): void => {
      if (!inThinking) return;
      inThinking = false;
      full += "</thinking>";
      onToken("</thinking>");
    };

    for await (const line of readStreamLines(response, {
      signal: request.signal,
    })) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        exitThinking();
        return { text: full, provider: "aws-mantle", model };
      }
      try {
        const parsed = JSON.parse(payload) as {
          type?: string;
          delta?: { type?: string; text?: string; thinking?: string };
        };
        if (parsed.type === "content_block_delta") {
          const deltaType = parsed.delta?.type;
          if (deltaType === "thinking_delta" && parsed.delta?.thinking) {
            enterThinking();
            full += parsed.delta.thinking;
            onToken(parsed.delta.thinking);
          } else if (deltaType === "text_delta" && parsed.delta?.text) {
            if (inThinking) exitThinking();
            full += parsed.delta.text;
            onToken(parsed.delta.text);
          }
        }
      } catch {
        // Ignore malformed keepalive lines.
      }
    }
    exitThinking();
    return { text: full, provider: "aws-mantle", model };
  },
};
