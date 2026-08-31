import type {
  NativeToolCall,
  ProviderId,
  ToolChoice,
  ToolDefinition,
} from "../types.js";
import { parseToolArguments } from "./tool-wire/argument-repair.js";
export { repairConcatenatedToolArguments } from "./tool-wire/argument-repair.js";
export { parseToolArguments };

export type { NativeToolCall, ToolChoice, ToolDefinition };

export type ToolDialect = "openai" | "anthropic" | "gemini" | "ollama" | "none";

export type ToolCallingMode = "auto" | "native" | "text";

export const MAX_TOOL_ARG_BYTES = 32 * 1024 * 1024;

export function toWireName(canonical: string): string {
  return canonical.replace(/\./g, "_");
}

export function toSnakeWireName(canonical: string): string {
  return canonical
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/\./g, "_")
    .toLowerCase();
}

const wireToCanonical = new Map<string, string>();

export function registeredCanonicalForWire(wire: string): string | undefined {
  return wireToCanonical.get(wire);
}

export function registerWireName(canonical: string, wire?: string): void {
  const w = wire ?? toWireName(canonical);
  const existing = wireToCanonical.get(w);
  if (existing !== undefined && existing !== canonical) {
    throw new Error(
      `Tool wire name collision: ${w} maps to both ${existing} and ${canonical}`,
    );
  }
  wireToCanonical.set(w, canonical);
  if (!wireToCanonical.has(canonical))
    wireToCanonical.set(canonical, canonical);
}

export function registerWireNamesFor(canonical: string): string {
  const wire = toWireName(canonical);
  registerWireName(canonical, wire);
  const snake = toSnakeWireName(canonical);
  if (snake !== wire) {
    registerWireName(canonical, snake);
  }
  return wire;
}

export function sanitizeToolName(raw: string): string {
  let n = raw.trim();
  if (!n) return n;
  n = n.replace(/<\|[^|]*\|>/g, "");
  n = n.replace(/<\/?[A-Za-z][^>]*>/g, "");
  n = n.replace(/^(?:functions\.|tools\.|tool\.)/i, "");
  n = n.replace(/:\d+$/, "");
  n = n.replace(/[^A-Za-z0-9._/-]+.*$/, "");
  n = n.replace(
    /(?:commentary|analysis|channel|tool_call|toolcall|final)$/i,
    "",
  );
  n = n.replace(/(?:[_./-]+(?:commentary|analysis|channel|final))+$/i, "");
  n = n.trim().replace(/^[_./-]+|[_./-]+$/g, "");
  return n;
}

function longestRegisteredPrefix(cleaned: string): string | undefined {
  if (!cleaned) return undefined;
  if (wireToCanonical.has(cleaned)) return cleaned;
  let best: string | undefined;
  for (const [wire] of wireToCanonical) {
    if (
      cleaned === wire ||
      cleaned.startsWith(wire + "_") ||
      cleaned.startsWith(wire + ".") ||
      cleaned.startsWith(wire + "<")
    ) {
      if (!best || wire.length > best.length) best = wire;
    }
  }
  return best;
}

function normalizedWireCandidates(cleaned: string): string[] {
  const underscored = cleaned
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_");
  const dashless = underscored.replace(/-/g, "_");
  return [
    cleaned,
    underscored,
    dashless,
    underscored.toLowerCase(),
    dashless.toLowerCase(),
  ];
}

function hashlessStem(wire: string): string {
  return wire.replace(/_[0-9a-f]{8,}$/i, "").toLowerCase();
}

function uniqueStemMatch(candidates: readonly string[]): string | undefined {
  const targets = new Set(candidates.map(hashlessStem));
  let found: string | undefined;
  for (const [wire, canonical] of wireToCanonical) {
    if (!targets.has(hashlessStem(wire))) continue;
    if (found !== undefined && found !== canonical) return undefined;
    found = canonical;
  }
  return found;
}

function resolveRegistered(cleaned: string): string | undefined {
  const candidates = normalizedWireCandidates(cleaned);
  for (const candidate of candidates) {
    const hit = wireToCanonical.get(candidate);
    if (hit) return hit;
  }
  return uniqueStemMatch(candidates);
}

export function fromWireName(wire: string): string | undefined {
  const cleaned = sanitizeToolName(wire);
  if (!cleaned) return undefined;
  const registered = resolveRegistered(cleaned);
  if (registered) return registered;
  const prefix = longestRegisteredPrefix(cleaned);
  if (prefix) return wireToCanonical.get(prefix);
  if (wireToCanonical.has(wire)) return wireToCanonical.get(wire);
  if (cleaned.includes(".")) return cleaned;
  const idx = cleaned.indexOf("_");
  if (idx <= 0) return undefined;
  return `${cleaned.slice(0, idx)}.${cleaned.slice(idx + 1).replace(/_/g, ".")}`;
}

let syntheticToolCallSequence = 0;

export function syntheticToolCallId(index: number): string {
  syntheticToolCallSequence += 1;
  return `call_${index}_${Date.now().toString(36)}_${syntheticToolCallSequence.toString(36)}`;
}

const TOOLS_PARAMETER_NAMES = new Set([
  "tools",
  "tool",
  "tool_choice",
  "toolchoice",
  "functions",
  "function_call",
  "functioncall",
]);

function offendingParameterName(hay: string): string | undefined {
  const patterns = [
    /unrecognized (?:request )?(?:argument|parameter|field)(?:s)? supplied:?\s*['"`]?([a-z0-9_.]+)/,
    /unknown (?:request )?(?:argument|parameter|field):?\s*['"`]?([a-z0-9_.]+)/,
    /unexpected keyword argument ['"`]?([a-z0-9_.]+)/,
    /extra inputs are not permitted[^a-z0-9_]*['"`]?([a-z0-9_.]+)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(hay);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function isToolsUnsupportedError(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: number }).status)
      : undefined;
  const body =
    error && typeof error === "object" && "body" in error
      ? String((error as { body?: string }).body ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  const hay = `${message}\n${body}`.toLowerCase();

  const offending = offendingParameterName(hay);
  if (offending && !TOOLS_PARAMETER_NAMES.has(offending)) return false;

  if (
    /tools?\s+(is|are)\s+not\s+supported|does not support tools|function calling is not enabled|tool[_ ]?use is not supported|tools? not supported|tool calling is not supported|does not support function|function[_ ]?call(ing)? (is )?(not supported|disabled|unavailable)|unknown (request )?parameter ['"]?tools?|['"]tools?['"] is not (a )?valid|tool_choice.*(not supported|unknown|disabled)/i.test(
      hay,
    )
  ) {
    return true;
  }

  if (
    status === 400 &&
    /\btools?\b|\btool_choice\b|\bfunction[_ ]?call/i.test(hay)
  ) {
    if (
      /invalid schema|invalid argument|missing required|parse error|type error|validation|must be|expected/i.test(
        hay,
      )
    ) {
      return false;
    }
    return /not support|unsupported|disabled|not enabled|not available|unknown parameter|unrecognized/i.test(
      hay,
    );
  }
  return false;
}

export function mapToolChoiceToOpenAi(choice: ToolChoice | undefined): unknown {
  if (choice === undefined || choice === "auto") return "auto";
  if (choice === "none") return "none";
  if (choice === "required") return "required";
  if (typeof choice === "object" && choice.type === "function") {
    return {
      type: "function",
      function: { name: toWireName(choice.name) },
    };
  }
  return "auto";
}

export function mapToolChoiceToAnthropic(
  choice: ToolChoice | undefined,
): unknown {
  if (choice === undefined || choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  if (typeof choice === "object" && choice.type === "function") {
    return { type: "tool", name: toWireName(choice.name) };
  }
  return { type: "auto" };
}

export function mapToolChoiceToGemini(choice: ToolChoice | undefined): {
  mode: string;
  allowedFunctionNames?: string[];
} {
  if (choice === "none") return { mode: "NONE" };
  if (choice === "required") return { mode: "ANY" };
  if (typeof choice === "object" && choice.type === "function") {
    return {
      mode: "ANY",
      allowedFunctionNames: [toWireName(choice.name)],
    };
  }
  return { mode: "AUTO" };
}

const textOnlyModels = new Set<string>();

export function textOnlyKey(provider: ProviderId, model: string): string {
  return `${provider}::${model}`;
}

export function markTextOnlyModel(provider: ProviderId, model: string): void {
  textOnlyModels.add(textOnlyKey(provider, model));
}

export function isTextOnlyModel(provider: ProviderId, model: string): boolean {
  return textOnlyModels.has(textOnlyKey(provider, model));
}

export function clearTextOnlyModels(): void {
  textOnlyModels.clear();
}

export interface OpenAiToolCallAccumulator {
  id?: string;
  name?: string;
  arguments: string;
}

export interface AccumulateToolCallDeltaResult {
  index: number;
  id?: string | undefined;
  name?: string | undefined;
  nameBecameKnown: boolean;
  argumentsBytes: number;
}

export function accumulateOpenAiToolCallDelta(
  state: Map<number, OpenAiToolCallAccumulator>,
  entry: {
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string | Record<string, unknown> };
  },
): AccumulateToolCallDeltaResult {
  const index = entry.index ?? 0;
  let acc = state.get(index);
  if (!acc) {
    acc = { arguments: "" };
    state.set(index, acc);
  }
  const hadName = Boolean(acc.name);
  if (entry.id) acc.id = entry.id;
  if (entry.function?.name) {
    const nextName =
      sanitizeToolName(entry.function.name) || entry.function.name;
    if (
      acc.name &&
      nextName &&
      acc.name !== nextName &&
      sanitizeToolName(acc.name) !== sanitizeToolName(nextName)
    ) {
    } else {
      acc.name = nextName;
    }
  }
  if (typeof entry.function?.arguments === "string") {
    const fragment = entry.function.arguments;
    const snapshotRepeat = fragment.length > 0 && acc.arguments === fragment;
    if (!snapshotRepeat) {
      acc.arguments += fragment;
    }
    if (acc.arguments.length > MAX_TOOL_ARG_BYTES) {
      throw new Error(
        `Tool call arguments exceeded ${MAX_TOOL_ARG_BYTES} bytes — split the file or reduce content size.`,
      );
    }
  } else if (
    entry.function?.arguments &&
    typeof entry.function.arguments === "object"
  ) {
    const serializedArguments = JSON.stringify(entry.function.arguments) ?? "";
    if (serializedArguments.length > MAX_TOOL_ARG_BYTES) {
      throw new Error(
        `Tool call arguments exceeded ${MAX_TOOL_ARG_BYTES} bytes — split the file or reduce content size.`,
      );
    }
    acc.arguments = serializedArguments;
  }
  return {
    index,
    ...(acc.id !== undefined ? { id: acc.id } : {}),
    ...(acc.name !== undefined ? { name: acc.name } : {}),
    nameBecameKnown: Boolean(acc.name) && !hadName,
    argumentsBytes: acc.arguments.length,
  };
}

export function finalizeOpenAiToolCalls(
  state: Map<number, OpenAiToolCallAccumulator>,
): NativeToolCall[] {
  const indices = [...state.keys()].sort((a, b) => a - b);
  const out: NativeToolCall[] = [];
  for (const index of indices) {
    const acc = state.get(index)!;
    const wire = acc.name ?? "";
    const canonical = fromWireName(wire) ?? wire;
    const rawArguments = acc.arguments;
    const args = parseToolArguments(rawArguments);
    const replayArguments = args._parseError
      ? rawArguments
      : JSON.stringify(args);
    out.push({
      id: acc.id ?? syntheticToolCallId(index),
      name: canonical,
      args,
      ...(replayArguments ? { rawArguments: replayArguments } : {}),
    });
  }
  return out;
}

export function parseOpenAiMessageToolCalls(
  toolCalls:
    | Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>
    | undefined,
): NativeToolCall[] {
  if (!toolCalls?.length) return [];
  return toolCalls.map((tc, i) => {
    const wire = tc.function?.name ?? "";
    const rawArguments = tc.function?.arguments ?? "";
    const args = parseToolArguments(rawArguments);
    const replayArguments = args._parseError
      ? rawArguments
      : JSON.stringify(args);
    return {
      id: tc.id ?? syntheticToolCallId(i),
      name: fromWireName(wire) ?? wire,
      args,
      ...(replayArguments ? { rawArguments: replayArguments } : {}),
    };
  });
}
