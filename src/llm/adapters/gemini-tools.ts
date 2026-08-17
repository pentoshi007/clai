import type {
  ChatMessage,
  NativeToolCall,
  ReasoningArtifact,
  ReasoningArtifactReplayObserver,
  ReasoningArtifactReplayTarget,
  ToolDefinition,
} from "../../types.js";
import {
  reasoningArtifactSignature,
  reasoningArtifactsForMessage,
  selectReasoningArtifactsForReplay,
} from "../reasoning-artifacts.js";
import {
  fromWireName,
  mapToolChoiceToGemini,
  parseToolArguments,
  syntheticToolCallId,
  toWireName,
  type ToolChoice,
} from "../tool-protocol.js";
// Side-effect: register wire name map before fromWireName use.
import "../../tools/definitions.js";
import { normalizeSystemMessages } from "../system-messages.js";

/**
 * Gemini's function-calling `Schema` type only understands a specific subset
 * of JSON Schema (see https://ai.google.dev/api/caching#Schema): type,
 * format, title, description, nullable, enum, maxItems, minItems, properties,
 * required, minProperties, maxProperties, minLength, maxLength, pattern,
 * example, anyOf, propertyOrdering, default, items, minimum, maximum.
 *
 * Anything else — most commonly `additionalProperties` (rejected at ANY
 * nesting depth, not just the top level) and `oneOf` (Gemini only supports
 * `anyOf`) — makes the whole request fail with HTTP 400
 * ("Unknown name ... Cannot find field"). This walks the schema recursively
 * so nested array/object parameters (fs.writeMany, tool.batch, plan.create, …)
 * never leak unsupported keywords into the wire payload.
 */
const GEMINI_SCHEMA_KEYS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "minProperties",
  "maxProperties",
  "minLength",
  "maxLength",
  "pattern",
  "example",
  "anyOf",
  "propertyOrdering",
  "default",
  "items",
  "minimum",
  "maximum",
]);

function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => sanitizeGeminiSchema(entry));
  }
  if (!schema || typeof schema !== "object") return schema;
  const input = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // Gemini only supports `anyOf`, not `oneOf`/`allOf` — fold oneOf into anyOf
  // (loses the "exactly one" constraint, but the model still gets valid
  // alternatives instead of a hard-rejected request).
  const anyOfSource = input.anyOf ?? input.oneOf;
  for (const [key, value] of Object.entries(input)) {
    if (key === "oneOf") continue;
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    if (key === "properties" && value && typeof value === "object") {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(
        value as Record<string, unknown>,
      )) {
        props[propName] = sanitizeGeminiSchema(propSchema);
      }
      out.properties = props;
      continue;
    }
    if ((key === "items" || key === "anyOf") && value !== undefined) {
      out[key] = sanitizeGeminiSchema(value);
      continue;
    }
    out[key] = value;
  }
  if (!("anyOf" in out) && anyOfSource !== undefined) {
    out.anyOf = sanitizeGeminiSchema(anyOfSource);
  }
  return out;
}

export function toGeminiFunctionDeclarations(defs: ToolDefinition[]): Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}> {
  return defs.map((d) => {
    const parameters = sanitizeGeminiSchema({
      type: "object",
      properties: d.parameters.properties,
      ...(d.parameters.required?.length
        ? { required: d.parameters.required }
        : {}),
    }) as Record<string, unknown>;
    return {
      name: d.wireName,
      description: d.description,
      parameters,
    };
  });
}

export function geminiToolBodyFields(options: {
  tools?: ToolDefinition[] | undefined;
  toolChoice?: ToolChoice | undefined;
}): Record<string, unknown> {
  if (!options.tools?.length) return {};
  const fc = mapToolChoiceToGemini(options.toolChoice);
  return {
    tools: [
      {
        functionDeclarations: toGeminiFunctionDeclarations(options.tools),
      },
    ],
    toolConfig: {
      functionCallingConfig: {
        mode: fc.mode,
        ...(fc.allowedFunctionNames
          ? { allowedFunctionNames: fc.allowedFunctionNames }
          : {}),
      },
    },
  };
}

type GeminiPart =
  | ({ text: string; thought?: boolean; thoughtSignature?: string } & Record<string, unknown>)
  | { inlineData: { mimeType: string; data: string } }
  | {
      functionCall: {
        name: string;
        args?: Record<string, unknown>;
        id?: string;
      };
      thoughtSignature?: string;
    }
  | {
      functionResponse: {
        name: string;
        response: Record<string, unknown>;
        id?: string;
      };
    };

export interface GeminiReasoningPart {
  readonly kind: "thought" | "thought-signature";
  readonly raw: ReasoningArtifact["raw"];
  readonly sequence: number;
  readonly displaySummary?: string | undefined;
  readonly toolCallIndex?: number | undefined;
}

function artifactToolCallIndex(
  artifact: ReasoningArtifact,
  toolCalls: readonly NativeToolCall[] | undefined,
): number | undefined {
  if (artifact.position.toolCallIndex !== undefined) {
    return artifact.position.toolCallIndex;
  }
  if (!artifact.position.toolCallId || !toolCalls?.length) return undefined;
  const index = toolCalls.findIndex(
    (toolCall) => toolCall.id === artifact.position.toolCallId,
  );
  return index >= 0 ? index : undefined;
}

function thoughtPartFromArtifact(
  artifact: ReasoningArtifact,
): GeminiPart | undefined {
  if (
    artifact.kind !== "plaintext" ||
    !artifact.raw ||
    typeof artifact.raw !== "object" ||
    Array.isArray(artifact.raw)
  ) {
    return undefined;
  }
  const raw = artifact.raw as Record<string, unknown>;
  if (raw.thought !== true || typeof raw.text !== "string") return undefined;
  const {
    functionCall: _functionCall,
    thoughtSignature: _thoughtSignature,
    ...thoughtPart
  } = raw;
  return {
    ...thoughtPart,
    text: raw.text,
    thought: true,
  } as GeminiPart;
}

interface GeminiReasoningReplayOptions {
  readonly target: ReasoningArtifactReplayTarget;
  readonly observe?: ReasoningArtifactReplayObserver | undefined;
}

function assistantReasoningParts(
  message: ChatMessage,
  replay?: GeminiReasoningReplayOptions,
): {
  thoughts: Array<{ part: GeminiPart; toolCallIndex?: number | undefined }>;
  signatureForTool: (toolCall: NativeToolCall, toolCallIndex: number) => string | undefined;
} {
  const artifacts = replay
    ? [
        ...selectReasoningArtifactsForReplay({
          artifacts: reasoningArtifactsForMessage(message),
          target: replay.target,
          context: { hasToolCalls: Boolean(message.toolCalls?.length) },
          observe: replay.observe,
        }),
      ].sort((left, right) => left.position.sequence - right.position.sequence)
    : [];
  const thoughts = artifacts.flatMap((artifact) => {
    const part = thoughtPartFromArtifact(artifact);
    if (!part) return [];
    const toolCallIndex = artifactToolCallIndex(artifact, message.toolCalls);
    return [{ part, ...(toolCallIndex === undefined ? {} : { toolCallIndex }) }];
  });
  return {
    thoughts,
    signatureForTool: (toolCall, toolCallIndex) => {
      const artifact = artifacts.find(
        (candidate) =>
          candidate.kind === "thought-signature" &&
          (candidate.position.toolCallId === toolCall.id ||
            artifactToolCallIndex(candidate, message.toolCalls) === toolCallIndex),
      );
      return artifact ? reasoningArtifactSignature(artifact) : undefined;
    },
  };
}

/**
 * Convert dialect-neutral history to Gemini contents with functionCall /
 * functionResponse parts. The first system message is owned by
 * `systemInstruction`; later system messages become marked user turns in place
 *.
 */
export function toGeminiToolContents(
  messages: ChatMessage[],
  replay?: GeminiReasoningReplayOptions,
): Array<{ role: "user" | "model"; parts: GeminiPart[] }> {
  const contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];

  let i = 0;
  const nonSystem = normalizeSystemMessages(messages).rest;

  while (i < nonSystem.length) {
    const message = nonSystem[i]!;

    if (message.role === "tool") {
      const parts: GeminiPart[] = [];
      while (i < nonSystem.length && nonSystem[i]!.role === "tool") {
        const tr = nonSystem[i]!;
        const wire = tr.name ? toWireName(tr.name) : "unknown";
        parts.push({
          functionResponse: {
            name: wire,
            response: { result: tr.content },
            ...(tr.toolCallId ? { id: tr.toolCallId } : {}),
          },
        });
        i += 1;
      }
      contents.push({ role: "user", parts });
      continue;
    }

    const reasoning = assistantReasoningParts(message, replay);
    if (message.role === "assistant" && message.toolCalls?.length) {
      const parts: GeminiPart[] = [];
      const leadingThoughts = reasoning.thoughts.filter(
        (thought) => thought.toolCallIndex === undefined,
      );
      const thoughtsByTool = new Map<number, GeminiPart[]>();
      for (const thought of reasoning.thoughts) {
        if (thought.toolCallIndex === undefined) continue;
        const current = thoughtsByTool.get(thought.toolCallIndex) ?? [];
        current.push(thought.part);
        thoughtsByTool.set(thought.toolCallIndex, current);
      }
      parts.push(...leadingThoughts.map((thought) => thought.part));
      parts.push(...(thoughtsByTool.get(0) ?? []));
      if (message.content.trim()) {
        parts.push({ text: message.content });
      }
      for (const [toolCallIndex, tc] of message.toolCalls.entries()) {
        if (toolCallIndex > 0) {
          parts.push(...(thoughtsByTool.get(toolCallIndex) ?? []));
        }
        const thoughtSignature = reasoning.signatureForTool(tc, toolCallIndex);
        parts.push({
          functionCall: {
            name: toWireName(tc.name),
            args: tc.args ?? {},
            ...(tc.id ? { id: tc.id } : {}),
          },
          ...(thoughtSignature ? { thoughtSignature } : {}),
        });
      }
      contents.push({ role: "model", parts });
      i += 1;
      continue;
    }

    const role = message.role === "assistant" ? "model" : "user";
    const parts: GeminiPart[] = [];
    if (role === "model") {
      parts.push(...reasoning.thoughts.map((thought) => thought.part));
    }
    if (message.content.trim()) parts.push({ text: message.content });
    if (role === "user" && message.images) {
      for (const img of message.images) {
        parts.push({
          inlineData: { mimeType: img.mediaType, data: img.dataBase64 },
        });
      }
    }
    if (parts.length === 0) {
      i += 1;
      continue;
    }
    const previous = contents.at(-1);
    if (previous?.role === role) {
      previous.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
    i += 1;
  }

  return contents;
}

export function parseGeminiFunctionCalls(
  parts:
    | Array<{
        text?: string;
        thought?: boolean;
        thoughtSignature?: string;
        functionCall?: {
          name?: string;
          args?: Record<string, unknown>;
          id?: string;
        };
      }>
    | undefined,
): {
  text: string;
  toolCalls: NativeToolCall[];
  reasoningParts: GeminiReasoningPart[];
} {
  let text = "";
  const toolCalls: NativeToolCall[] = [];
  const reasoningParts: GeminiReasoningPart[] = [];
  const thoughtParts: Array<Omit<GeminiReasoningPart, "toolCallIndex">> = [];
  const toolCallSequences: Array<{ sequence: number; toolCallIndex: number }> = [];
  if (!parts) return { text, toolCalls, reasoningParts };

  for (const [sequence, part] of parts.entries()) {
    let toolCallIndex: number | undefined;
    if (part.functionCall?.name) {
      const wire = part.functionCall.name;
      const args = part.functionCall.args
        ? parseToolArguments(part.functionCall.args)
        : {};
      toolCallIndex = toolCalls.length;
      toolCalls.push({
        id: part.functionCall.id ?? syntheticToolCallId(toolCallIndex),
        name: fromWireName(wire) ?? wire,
        args,
        ...(part.thoughtSignature
          ? { thoughtSignature: part.thoughtSignature }
          : {}),
      });
      toolCallSequences.push({ sequence, toolCallIndex });
      if (part.thoughtSignature) {
        reasoningParts.push({
          kind: "thought-signature",
          raw: part.thoughtSignature,
          sequence,
          toolCallIndex,
        });
      }
    }
    if (part.thought && typeof part.text === "string" && part.text) {
      thoughtParts.push({
        kind: "thought",
        raw: { ...part },
        sequence,
        displaySummary: part.text,
      });
    } else if (part.thoughtSignature && toolCallIndex === undefined) {
      reasoningParts.push({
        kind: "thought-signature",
        raw: part.thoughtSignature,
        sequence,
      });
    }
    if (part.thought) continue;
    if (typeof part.text === "string" && part.text) {
      text += part.text;
    }
  }
  for (const thought of thoughtParts) {
    const followingTool = toolCallSequences.find(
      (toolCall) => toolCall.sequence > thought.sequence,
    );
    reasoningParts.push(
      followingTool
        ? { ...thought, toolCallIndex: followingTool.toolCallIndex }
        : thought,
    );
  }
  reasoningParts.sort((left, right) => left.sequence - right.sequence);
  return { text: text.trim(), toolCalls, reasoningParts };
}
