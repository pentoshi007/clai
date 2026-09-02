import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ReasoningPreference,
  TokenUsage,
} from "../types.js";
import {
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import {
  ProviderError,
  createSseFrameAssembler,
  imageCapableMessages,
  readJson,
  readStreamLines,
  streamIdleBudgets,
} from "./http.js";
import { generationFetch } from "./operation-usage.js";
import { registerProviderModels } from "./capabilities.js";
import {
  geminiToolBodyFields,
  parseGeminiFunctionCalls,
  toGeminiToolContents,
  type GeminiReasoningPart,
} from "./adapters/gemini-tools.js";
import { fromWireName } from "./tool-protocol.js";
import {
  parseGeminiUsage,
  withReasoningObservation,
} from "./token-usage.js";
import {
  emitStreamReasoningArtifacts,
  emitStreamReasoningDelta,
} from "./stream-events.js";
import { GEMINI_STREAM_TERMINAL, requireTerminalProof } from "./stream-terminal.js";
import {
  firstSystemPrompt,
  requestContextSystemPrompts,
  withoutRequestContextSystemMessages,
} from "./system-messages.js";
import {
  createReasoningArtifact,
  createReasoningArtifactProvenance,
} from "./reasoning-artifacts.js";
import { compileRequestPlan, type RequestPlanV1 } from "./request-plan.js";

const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function geminiReasoningArtifacts(
  model: string,
  parts: readonly GeminiReasoningPart[],
) {
  const provenance = createReasoningArtifactProvenance({
    provider: "gemini",
    model,
    dialect: "gemini-generate-content",
    endpoint: GEMINI_API_BASE_URL,
  });
  const artifacts = parts.map((part) => {
    const boundToTool = part.toolCallIndex !== undefined;
    return createReasoningArtifact({
      kind: part.kind === "thought" ? "plaintext" : "thought-signature",
      raw: part.raw,
      ...(part.displaySummary ? { displaySummary: part.displaySummary } : {}),
      provenance,
      replay: boundToTool
        ? { scope: "tool-turn", persistence: "tool-turn" }
        : { scope: "none", persistence: "never" },
      position: {
        sequence: part.sequence,
        placement: boundToTool
          ? part.kind === "thought-signature"
            ? "on-tool-call"
            : "before-tool-call"
          : "assistant",
        ...(boundToTool ? { toolCallIndex: part.toolCallIndex } : {}),
      },
    });
  });
  return artifacts.length ? artifacts : undefined;
}

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

function geminiContents(
  messages: ChatMessage[],
  model: string,
  observe: CompletionRequest["onReasoningArtifactReplayDecision"],
  target: RequestPlanV1["replay"]["target"],
): Array<{ role: "user" | "model"; parts: GeminiPart[] }> {
  return toGeminiToolContents(
    withoutRequestContextSystemMessages(messages),
    {
      target,
      observe,
    },
  ) as Array<{
    role: "user" | "model";
    parts: GeminiPart[];
  }>;
}

function systemInstruction(
  messages: ChatMessage[],
): { parts: Array<{ text: string }> } | undefined {
  const parts = [
    firstSystemPrompt(messages),
    ...requestContextSystemPrompts(messages),
  ]
    .filter((text): text is string => Boolean(text))
    .map((text) => ({ text }));
  return parts.length > 0 ? { parts } : undefined;
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
    const effort = reasoning?.effort ?? "medium";
    const wantsMinimal = !reasoning?.enabled || effort === "none" || effort === "minimal";
    const isPro = /gemini-3(?:\.\d)?-pro/i.test(model);
    const thinkingLevel = wantsMinimal
      ? isPro
        ? "low"
        : "minimal"
      : effort === "low"
        ? "low"
        : effort === "high" || effort === "xhigh" || effort === "max"
          ? "high"
          : "medium";
    return {
      thinkingLevel,
      ...(reasoning?.enabled ? { includeThoughts: true } : {}),
    };
  }

  if (!/gemini-2\.5/i.test(model)) return undefined;
  if (!reasoning?.enabled) {
    return /gemini-2\.5-(?:flash|flash-lite)/i.test(model)
      ? { thinkingBudget: 0 }
      : undefined;
  }
  switch (reasoning.effort) {
    case "low":
      return { thinkingBudget: 1_024, includeThoughts: true };
    case "high":
    case "xhigh":
    case "max":
      return { thinkingBudget: 16_384, includeThoughts: true };
    default:
      return { thinkingBudget: 4_096, includeThoughts: true };
  }
}

/**
 * Gemini's default thresholds are `BLOCK_MEDIUM_AND_ABOVE`, which blocks a
 * meaningful share of legitimate sysadmin/pentest turns (exploit discussion,
 * credential handling, payload text). Blocked turns surfaced only as a generic
 * empty completion. Ask for the least restrictive thresholds the account allows
 * and name the cause when a block happens anyway.
 */
const GEMINI_SAFETY_SETTINGS = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" }));

const GEMINI_BLOCKING_FINISH_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
]);

export function assertGeminiFinishReasonAllowed(
  finishReason: string | undefined,
): void {
  if (!finishReason) return;
  if (!GEMINI_BLOCKING_FINISH_REASONS.has(finishReason.toUpperCase())) return;
  throw new ProviderError(
    `Gemini blocked the response (finishReason=${finishReason}). Try another provider with /provider, or rephrase the request.`,
  );
}

export function clampGeminiThinkingBudget(
  thinkingConfig: Record<string, unknown> | undefined,
  maxOutputTokens: number,
): Record<string, unknown> | undefined {
  if (!thinkingConfig) return thinkingConfig;
  const budget = thinkingConfig.thinkingBudget;
  if (typeof budget !== "number" || budget <= 0) return thinkingConfig;
  const allowed = Math.max(1, Math.floor(maxOutputTokens / 2));
  if (budget <= allowed) return thinkingConfig;
  return { ...thinkingConfig, thinkingBudget: allowed };
}

export function geminiBody(request: CompletionRequest, stream = false): string {
  const model = request.model ?? defaultModels.gemini;
  const plan = compileRequestPlan({
    provider: "gemini",
    model,
    messages: request.messages,
    stream,
    endpoint: GEMINI_API_BASE_URL,
    reasoning: request.thinking,
    tools: request.tools,
    toolChoice: request.toolChoice,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
  });
  const defaultMaxTokens = plan.controls.reasoning?.enabled ? 8_192 : 4_096;
  const maxOutputTokens = plan.controls.requestedMaxTokens ?? defaultMaxTokens;
  const thinkingConfig = clampGeminiThinkingBudget(
    geminiThinkingConfig(plan.controls.reasoning, model),
    maxOutputTokens,
  );
  const body: Record<string, unknown> = {
    contents: geminiContents(
      imageCapableMessages("gemini", model, [...plan.timeline.messages]),
      model,
      request.onReasoningArtifactReplayDecision,
      plan.replay.target,
    ),
    generationConfig: {
      temperature: plan.controls.temperature,
      ...(plan.controls.topP !== undefined ? { topP: plan.controls.topP } : {}),
      maxOutputTokens,
      ...(thinkingConfig !== undefined
        ? { thinkingConfig }
        : {}),
    },
    safetySettings: GEMINI_SAFETY_SETTINGS,
    ...geminiToolBodyFields({
      tools: plan.tools.definitions.length
        ? [...plan.tools.definitions]
        : undefined,
      toolChoice: plan.tools.choice,
    }),
  };
  const sys = systemInstruction([...plan.timeline.messages]);
  if (sys) body.systemInstruction = sys;
  return JSON.stringify(body);
}

export const geminiProvider: LlmProvider = {
  id: "gemini",
  displayName: "Google Gemini",
  defaultModel: defaultModels.gemini,
  envVar: "GEMINI_API_KEY",
  validateKey: (key: string) =>
    /^AIza[0-9A-Za-z_-]{12,}$/.test(key) ||
    /^AQ\.[A-Za-z0-9_-]{20,}$/.test(key),
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
    const models =
      data.models
        ?.filter((m) => m.name && m.supportedGenerationMethods?.includes("generateContent"))
        .map((m) => m.name!.replace(/^models\//, ""))
        .sort() ?? [];
    registerProviderModels("gemini", models);
    return models;
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
    const response = await generationFetch(
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
          parts?: Array<{
            text?: string;
            thought?: boolean;
            thoughtSignature?: string;
            functionCall?: {
              name?: string;
              args?: Record<string, unknown>;
              id?: string;
            };
          }>;
        };
        finishReason?: string;
      }>;
      usageMetadata?: unknown;
    }>(response);
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const parsed = parseGeminiFunctionCalls(parts);
    const reasoningArtifacts = geminiReasoningArtifacts(
      model,
      parsed.reasoningParts,
    );
    if (!parsed.text && parsed.toolCalls.length === 0) {
      assertGeminiFinishReasonAllowed(data.candidates?.[0]?.finishReason);
      throw new ProviderError("Gemini completed without a visible answer.");
    }
    const usage = withReasoningObservation(
      parseGeminiUsage(data.usageMetadata),
      parsed.reasoningParts.length > 0,
    );
    return {
      text: parsed.text,
      provider: "gemini",
      model,
      api: "gemini-generate-content",
      ...(parsed.toolCalls.length ? { toolCalls: parsed.toolCalls } : {}),
      ...(reasoningArtifacts ? { reasoningArtifacts } : {}),
      ...(data.candidates?.[0]?.finishReason
        ? { finishReason: data.candidates[0].finishReason }
        : parsed.toolCalls.length
          ? { finishReason: "tool_calls" }
          : {}),
      ...(usage ? { usage } : {}),
    };
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Gemini API key is required");
    const model = request.model ?? defaultModels.gemini;
    const response = await generationFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(auth.apiKey)}`,
      {
        method: "POST",
        signal: request.signal ?? null,
        headers: { "content-type": "application/json" },
        body: geminiBody(request, true),
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
    let reasoningChars = 0;
    const collectedParts: Array<{
      text?: string;
      thought?: boolean;
      thoughtSignature?: string;
      functionCall?: {
        name?: string;
        args?: Record<string, unknown>;
        id?: string;
      };
    }> = [];
    let finishReason: string | undefined;
    let streamUsage: TokenUsage | undefined;

    const sseFrames = createSseFrameAssembler();
    for await (const line of readStreamLines(response, {
      signal: request.signal,
      ...streamIdleBudgets(Boolean(request.thinking?.enabled)),
      outputProgress: () => full.length + reasoningChars + collectedParts.length,
    })) {
      const payload = sseFrames.pushLine(line);
      if (payload === undefined) continue;
      if (payload === "[DONE]") break;
      try {
        const parsed = JSON.parse(payload) as {
          usageMetadata?: unknown;
          candidates?: Array<{
            finishReason?: string;
            content?: {
              parts?: Array<{
                text?: string;
                thought?: boolean;
                thoughtSignature?: string;
                functionCall?: {
                  name?: string;
                  args?: Record<string, unknown>;
                  id?: string;
                };
              }>;
            };
          }>;
        };
        const u = parseGeminiUsage(parsed.usageMetadata);
        if (u) streamUsage = u;
        const candidate = parsed.candidates?.[0];
        if (candidate?.finishReason) finishReason = candidate.finishReason;
        const parts = candidate?.content?.parts ?? [];
        for (const part of parts) {
          collectedParts.push(part);
          if (part.functionCall) {
            if (request.onToolCallDelta && part.functionCall.name) {
              const idx =
                collectedParts.filter((p) => p.functionCall).length - 1;
              const wire = part.functionCall.name;
              request.onToolCallDelta({
                index: idx,
                ...(part.functionCall.id
                  ? { id: part.functionCall.id }
                  : {}),
                name: fromWireName(wire) ?? wire,
                argumentsBytes: JSON.stringify(part.functionCall.args ?? {})
                  .length,
              });
            }
            continue;
          }
          if (!part.text) continue;
          if (part.thought) {
            reasoningChars += part.text.length;
            emitStreamReasoningDelta(request.onStreamEvent, part.text);
          } else {
            visible += part.text;
            full += part.text;
            onToken(part.text);
          }
        }
      } catch (frameError) {
        if (!(frameError instanceof SyntaxError)) throw frameError;
      }
    }
    let geminiToolArgumentBytes = 0;
    for (const part of collectedParts) {
      if (part.functionCall) {
        geminiToolArgumentBytes += JSON.stringify(
          part.functionCall.args ?? {},
        ).length;
      }
    }
    requireTerminalProof({
      provider: "Gemini",
      policy: GEMINI_STREAM_TERMINAL,
      signal: finishReason ? "finish-reason" : undefined,
      answerBytes: visible.length,
      reasoningBytes: reasoningChars,
      toolArgumentBytes: geminiToolArgumentBytes,
    });
    const toolParsed = parseGeminiFunctionCalls(collectedParts);
    const reasoningArtifacts = geminiReasoningArtifacts(
      model,
      toolParsed.reasoningParts,
    );
    emitStreamReasoningArtifacts(request.onStreamEvent, reasoningArtifacts);
    if (!visible.trim() && toolParsed.toolCalls.length === 0) {
      assertGeminiFinishReasonAllowed(finishReason);
      throw new ProviderError("Gemini completed without a visible answer.");
    }
    const usage = withReasoningObservation(
      streamUsage,
      toolParsed.reasoningParts.length > 0,
    );
    return {
      text: full,
      provider: "gemini",
      model,
      api: "gemini-generate-content",
      ...(toolParsed.toolCalls.length
        ? { toolCalls: toolParsed.toolCalls }
        : {}),
      ...(reasoningArtifacts ? { reasoningArtifacts } : {}),
      ...(finishReason
        ? { finishReason }
        : toolParsed.toolCalls.length
          ? { finishReason: "tool_calls" }
          : {}),
      ...(usage ? { usage } : {}),
    };
  },
};
