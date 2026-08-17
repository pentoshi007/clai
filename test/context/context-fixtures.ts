import { estimateTokens } from "../../src/agent/context-manager.js";
import { SESSION_STATE_PREFIX } from "../../src/agent/session-state.js";
import { createReasoningArtifact } from "../../src/llm/reasoning-artifacts.js";
import type { ChatMessage, ReasoningArtifact, ToolDefinition } from "../../src/types.js";

const CHARS_PER_TOKEN = 3.3;
const MAX_FIT_ROUNDS = 200;

function sentence(index: number): string {
  return `record ${index}: inspected src/module-${index}.ts, confirmed the observed behavior, and noted the follow-up.`;
}

function filler(length: number): string {
  if (length <= 0) return "";
  let text = "";
  let index = 0;
  while (text.length < length) {
    text += `${sentence(index)} `;
    index += 1;
  }
  return text.slice(0, length);
}

function fitToTokens(
  target: number,
  measure: (filler: string) => number,
): string {
  let length = Math.max(0, Math.floor(target * CHARS_PER_TOKEN));
  for (let round = 0; round < MAX_FIT_ROUNDS; round += 1) {
    const candidate = filler(length);
    const actual = measure(candidate);
    if (actual === target) return candidate;
    const delta = Math.round((target - actual) * CHARS_PER_TOKEN);
    length += delta === 0 ? (actual < target ? 1 : -1) : delta;
    if (length < 0) length = 0;
  }
  throw new Error(`could not size fixture content to ${target} tokens`);
}

export function textOfTokens(target: number, prefix = ""): string {
  const body = fitToTokens(target, (candidate) =>
    estimateTokens(`${prefix}${candidate}`),
  );
  return `${prefix}${body}`;
}

export function toolsOfSchemaTokens(target: number): ToolDefinition[] {
  const build = (description: string): ToolDefinition[] => [
    {
      name: "fs.read",
      wireName: "fs_read",
      description,
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, lines: { type: "number" } },
        required: ["path"],
      },
      readOnly: true,
    },
    {
      name: "shell.run",
      wireName: "shell_run",
      description: "run a bounded shell command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, timeoutMs: { type: "number" } },
        required: ["command"],
      },
      mutates: true,
    },
  ];
  const description = fitToTokens(target, (candidate) =>
    estimateTokens(JSON.stringify(build(candidate))),
  );
  return build(description);
}

function fixtureReasoningArtifact(payload: string): ReasoningArtifact {
  return createReasoningArtifact({
    kind: "structured-details",
    raw: {
      reasoning_details: [
        { type: "opaque_reasoning", payload },
      ],
    },
    displaySummary: "fixture reasoning summary",
    provenance: {
      provider: "openrouter",
      model: "fixture-model",
      dialect: "openai-compatible",
    },
    replay: { scope: "all-history", persistence: "all-turns" },
    position: { sequence: 0, placement: "assistant" },
  });
}

export function reasoningArtifactsOfTokens(
  target: number,
): readonly ReasoningArtifact[] {
  const payload = fitToTokens(target, (candidate) =>
    fixtureReasoningArtifact(candidate).accounting.estimatedTokens,
  );
  return Object.freeze([fixtureReasoningArtifact(payload)]);
}

export interface SessionFixture {
  readonly systemMessages: ChatMessage[];
  readonly historySlice: ChatMessage[];
  readonly fullMessages: ChatMessage[];
  readonly tools: ToolDefinition[];
  readonly reasoningArtifacts: readonly ReasoningArtifact[];
}

export function buildSessionFixture(input: {
  historyTokens: number;
  systemTokens: number;
  toolSchemaTokens: number;
  reasoningTokens: number;
  historyMessages?: number;
}): SessionFixture {
  const messageCount = input.historyMessages ?? 8;
  const roleOverheadPerMessage = 4;
  const perMessage = Math.floor(
    input.historyTokens / messageCount - roleOverheadPerMessage,
  );
  const remainder =
    input.historyTokens -
    messageCount * (perMessage + roleOverheadPerMessage);

  const historySlice: ChatMessage[] = [];
  for (let index = 0; index < messageCount; index += 1) {
    const tokens = perMessage + (index === messageCount - 1 ? remainder : 0);
    historySlice.push({
      role: index % 2 === 0 ? "user" : "assistant",
      content: textOfTokens(tokens),
    });
  }

  const systemShare = Math.floor(input.systemTokens / 3) - roleOverheadPerMessage;
  const systemRemainder =
    input.systemTokens - 3 * (systemShare + roleOverheadPerMessage);
  const systemMessages: ChatMessage[] = [
    { role: "system", content: textOfTokens(systemShare, "# ROLE\n") },
    {
      role: "system",
      content: textOfTokens(systemShare, "ACTIVE PLAN\n"),
    },
    {
      role: "system",
      content: textOfTokens(
        systemShare + systemRemainder,
        `${SESSION_STATE_PREFIX}\n`,
      ),
    },
  ];

  const reasoningArtifacts = reasoningArtifactsOfTokens(input.reasoningTokens);
  const withArtifacts = historySlice.map((message, index) =>
    index === 1 && reasoningArtifacts[0]
      ? { ...message, reasoningArtifacts }
      : message,
  );

  return {
    systemMessages,
    historySlice: withArtifacts,
    fullMessages: [...systemMessages, ...withArtifacts],
    tools: toolsOfSchemaTokens(input.toolSchemaTokens),
    reasoningArtifacts,
  };
}

export function openAiUsagePayload(input: {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
}): Record<string, unknown> {
  return {
    prompt_tokens: input.promptTokens,
    completion_tokens: input.completionTokens,
    total_tokens: input.promptTokens + input.completionTokens,
    ...(input.cachedTokens === undefined
      ? {}
      : { prompt_tokens_details: { cached_tokens: input.cachedTokens } }),
    ...(input.reasoningTokens === undefined
      ? {}
      : {
          completion_tokens_details: { reasoning_tokens: input.reasoningTokens },
        }),
  };
}

export function geminiUsagePayload(input: {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  thoughtsTokens: number;
}): Record<string, unknown> {
  return {
    promptTokenCount: input.promptTokens,
    candidatesTokenCount: input.completionTokens,
    totalTokenCount: input.promptTokens + input.completionTokens,
    cachedContentTokenCount: input.cachedTokens,
    thoughtsTokenCount: input.thoughtsTokens,
  };
}

export function anthropicUsagePayload(input: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): Record<string, unknown> {
  return {
    input_tokens: input.inputTokens,
    output_tokens: input.outputTokens,
    cache_read_input_tokens: input.cacheReadTokens,
    cache_creation_input_tokens: input.cacheCreationTokens,
  };
}
