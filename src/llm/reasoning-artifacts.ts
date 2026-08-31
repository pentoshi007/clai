import { createHash } from "node:crypto";

import type {
  ChatMessage,
  NativeToolCall,
  ReasoningArtifact,
  ReasoningArtifactKind,
  ReasoningArtifactProvenance,
  ReasoningArtifactReplayDecision,
  ReasoningArtifactReplayTarget,
} from "../types.js";
import {
  legacyReasoningArtifacts,
  legacyReasoningBlockFromArtifacts,
} from "./artifacts/legacy-blocks.js";
export {
  reasoningArtifactReplayDecision,
  selectReasoningArtifactsForReplay,
} from "./artifacts/replay-selection.js";
export { legacyReasoningBlockFromArtifacts };

export interface CreateReasoningArtifactInput {
  readonly kind: ReasoningArtifactKind;
  readonly raw: ReasoningArtifact["raw"];
  readonly displaySummary?: string | undefined;
  readonly provenance: ReasoningArtifactProvenance;
  readonly replay: ReasoningArtifact["replay"];
  readonly position?: ReasoningArtifact["position"] | undefined;
}

export interface ReasoningArtifactReplayContext {
  readonly hasToolCalls?: boolean | undefined;
  readonly forceScope?: boolean | undefined;
}

function immutableClone(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => immutableClone(entry)));
  }
  if (value && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      copy[key] = immutableClone(entry);
    }
    return Object.freeze(copy);
  }
  return value;
}

function freezeRoute<T extends Record<string, unknown>>(route: T): Readonly<T> {
  return Object.freeze({ ...route });
}

function rawByteLength(raw: ReasoningArtifact["raw"]): number {
  const serialized = typeof raw === "string" ? raw : JSON.stringify(raw);
  return Buffer.byteLength(serialized ?? "", "utf8");
}

function estimateRawTokens(byteLength: number): number {
  return Math.ceil(byteLength / 3.3);
}

function endpointHash(endpoint: string): string {
  let normalized = endpoint;
  try {
    const url = new URL(endpoint);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    normalized = url.toString().replace(/\/$/, "");
  } catch {
  }
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

export function createReasoningArtifactProvenance(input: {
  provider: ReasoningArtifactProvenance["provider"];
  model?: string | undefined;
  dialect: ReasoningArtifactProvenance["dialect"];
  endpoint?: string | undefined;
  legacy?: true | undefined;
}): ReasoningArtifactProvenance {
  return freezeRoute({
    provider: input.provider,
    dialect: input.dialect,
    ...(input.model ? { model: input.model } : {}),
    ...(input.endpoint ? { endpointHash: endpointHash(input.endpoint) } : {}),
    ...(input.legacy ? { legacy: true as const } : {}),
  });
}

export function createReasoningArtifactReplayTarget(input: {
  provider: ReasoningArtifactReplayTarget["provider"];
  model: string;
  dialect: ReasoningArtifactReplayTarget["dialect"];
  endpoint?: string | undefined;
}): ReasoningArtifactReplayTarget {
  return freezeRoute({
    provider: input.provider,
    model: input.model,
    dialect: input.dialect,
    ...(input.endpoint ? { endpointHash: endpointHash(input.endpoint) } : {}),
  });
}

export function createReasoningArtifact(
  input: CreateReasoningArtifactInput,
): ReasoningArtifact {
  const raw = immutableClone(input.raw) as ReasoningArtifact["raw"];
  const byteLength = rawByteLength(raw);
  const position = freezeRoute({
    sequence: input.position?.sequence ?? 0,
    placement: input.position?.placement ?? "assistant",
    ...(input.position?.toolCallId
      ? { toolCallId: input.position.toolCallId }
      : {}),
    ...(input.position?.toolCallIndex !== undefined
      ? { toolCallIndex: input.position.toolCallIndex }
      : {}),
  });
  const replay = freezeRoute({
    scope: input.replay.scope,
    persistence: input.replay.persistence,
  });
  const accounting = freezeRoute({
    byteLength,
    estimatedTokens: estimateRawTokens(byteLength),
  });
  return Object.freeze({
    version: 1 as const,
    kind: input.kind,
    raw,
    ...(input.displaySummary !== undefined
      ? { displaySummary: input.displaySummary }
      : {}),
    provenance: freezeRoute({ ...input.provenance }),
    replay,
    position,
    accounting,
  });
}

function rawRecord(
  artifact: ReasoningArtifact,
): Readonly<Record<string, unknown>> | undefined {
  const raw = artifact.raw;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Readonly<Record<string, unknown>>)
    : undefined;
}

/** Returns the plaintext payload only for plaintext/signed artifact formats. */
export function reasoningArtifactText(
  artifact: ReasoningArtifact,
): string | undefined {
  if (typeof artifact.raw === "string") return artifact.raw;
  const raw = rawRecord(artifact);
  if (!raw) return undefined;
  const text = raw.text ?? raw.thinking;
  return typeof text === "string" ? text : undefined;
}

export function reasoningArtifactSignature(
  artifact: ReasoningArtifact,
): string | undefined {
  if (
    artifact.kind === "thought-signature" &&
    typeof artifact.raw === "string"
  ) {
    return artifact.raw;
  }
  const raw = rawRecord(artifact);
  const signature = raw?.signature ?? raw?.thoughtSignature;
  return typeof signature === "string" ? signature : undefined;
}

export function reasoningArtifactItems(
  artifact: ReasoningArtifact,
): Array<Record<string, unknown>> {
  const source = Array.isArray(artifact.raw)
    ? artifact.raw
    : Array.isArray(rawRecord(artifact)?.items)
      ? (rawRecord(artifact)?.items as readonly unknown[])
      : rawRecord(artifact)?.encrypted_content !== undefined
        ? [artifact.raw]
        : [];
  return source.flatMap((item): Array<Record<string, unknown>> =>
    item && typeof item === "object" && !Array.isArray(item)
      ? [{ ...(item as Record<string, unknown>) }]
      : [],
  );
}

function normalizeArtifact(artifact: ReasoningArtifact): ReasoningArtifact {
  return createReasoningArtifact({
    kind: artifact.kind,
    raw: artifact.raw,
    ...(artifact.displaySummary !== undefined
      ? { displaySummary: artifact.displaySummary }
      : {}),
    provenance: artifact.provenance,
    replay: artifact.replay,
    position: artifact.position,
  });
}

export function reasoningArtifactsForMessage(
  message: ChatMessage,
): readonly ReasoningArtifact[] {
  if (message.reasoningArtifacts?.length) {
    return message.reasoningArtifacts.map(normalizeArtifact);
  }
  return legacyReasoningArtifacts(message);
}

function applyThoughtSignatures(
  toolCalls: readonly NativeToolCall[] | undefined,
  artifacts: readonly ReasoningArtifact[],
): NativeToolCall[] | undefined {
  if (!toolCalls?.length) return toolCalls ? [...toolCalls] : undefined;
  let changed = false;
  const calls = toolCalls.map((call, index) => {
    if (call.thoughtSignature) return call;
    const artifact = artifacts.find(
      (candidate) =>
        candidate.kind === "thought-signature" &&
        (candidate.position.toolCallId === call.id ||
          candidate.position.toolCallIndex === index),
    );
    const signature = artifact
      ? reasoningArtifactSignature(artifact)
      : undefined;
    if (!signature) return call;
    changed = true;
    return { ...call, thoughtSignature: signature };
  });
  return changed ? calls : [...toolCalls];
}

export function canonicalizeChatMessageReasoningArtifacts(
  message: ChatMessage,
): ChatMessage {
  const artifacts = reasoningArtifactsForMessage(message);
  if (artifacts.length === 0) return { ...message };
  const reasoningBlock =
    message.reasoningBlock ?? legacyReasoningBlockFromArtifacts(artifacts);
  const toolCalls = applyThoughtSignatures(message.toolCalls, artifacts);
  return {
    ...message,
    reasoningArtifacts: artifacts,
    ...(reasoningBlock ? { reasoningBlock } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  };
}

export function reasoningArtifactTokensForMessage(
  message: ChatMessage,
): number {
  return reasoningArtifactsForMessage(message).reduce(
    (sum, artifact) => sum + artifact.accounting.estimatedTokens,
    0,
  );
}

const REDACTED_DETAIL = /^\s*\[?redacted]?\s*$/i;

function detailVisibleField(
  entry: Record<string, unknown>,
): string | undefined {
  const type = typeof entry.type === "string" ? entry.type : "";
  if (type.includes("encrypted")) return undefined;
  for (const key of ["text", "summary"] as const) {
    const value = entry[key];
    if (typeof value !== "string" || !value.trim()) continue;
    if (REDACTED_DETAIL.test(value)) continue;
    return value;
  }
  return undefined;
}

export function visibleReasoningDetailText(
  raw: ReasoningArtifact["raw"] | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  const entries: unknown[] = Array.isArray(raw)
    ? [...raw]
    : raw && typeof raw === "object"
      ? [raw]
      : [];
  const parts: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const nested = record.reasoning_details;
    if (Array.isArray(nested)) {
      const inner = visibleReasoningDetailText(
        nested as ReasoningArtifact["raw"],
      );
      if (inner) parts.push(inner);
      continue;
    }
    const visible = detailVisibleField(record);
    if (visible) parts.push(visible);
  }
  const text = parts.join("");
  return text.trim() ? text : undefined;
}

export function reasoningArtifactsObserved(
  artifacts: readonly ReasoningArtifact[] | undefined,
): boolean {
  return (artifacts?.length ?? 0) > 0;
}

export interface SignedThinkingArtifactInput {
  readonly sequence: number;
  readonly thinking: string;
  readonly signature?: string | undefined;
  readonly raw: ReasoningArtifact["raw"];
  readonly toolCallIndex?: number | undefined;
}

export function createSignedThinkingArtifacts(input: {
  blocks: readonly SignedThinkingArtifactInput[];
  provenance: ReasoningArtifactProvenance;
}): readonly ReasoningArtifact[] {
  return input.blocks.map((block) => {
    const replayable = Boolean(block.thinking && block.signature);
    return createReasoningArtifact({
      kind: replayable ? "signed" : "plaintext",
      raw: block.raw,
      ...(block.thinking ? { displaySummary: block.thinking } : {}),
      provenance: input.provenance,
      replay: replayable
        ? { scope: "tool-turn", persistence: "tool-turn" }
        : { scope: "none", persistence: "never" },
      position: {
        sequence: block.sequence,
        placement:
          block.toolCallIndex === undefined ? "assistant" : "before-tool-call",
        ...(block.toolCallIndex === undefined
          ? {}
          : { toolCallIndex: block.toolCallIndex }),
      },
    });
  });
}

export function rebindReasoningArtifactsToToolCalls(input: {
  artifacts: readonly ReasoningArtifact[] | undefined;
  toolCalls: readonly NativeToolCall[];
}): readonly ReasoningArtifact[] | undefined {
  if (!input.artifacts?.length) return undefined;
  return input.artifacts.map((artifact) => {
    const byIndex = artifact.position.toolCallIndex;
    const index =
      byIndex !== undefined
        ? byIndex
        : artifact.position.toolCallId
          ? input.toolCalls.findIndex(
              (call) => call.id === artifact.position.toolCallId,
            )
          : -1;
    const toolCall = index >= 0 ? input.toolCalls[index] : undefined;
    if (!toolCall || artifact.position.toolCallId === toolCall.id)
      return artifact;
    return createReasoningArtifact({
      kind: artifact.kind,
      raw: artifact.raw,
      ...(artifact.displaySummary !== undefined
        ? { displaySummary: artifact.displaySummary }
        : {}),
      provenance: artifact.provenance,
      replay: artifact.replay,
      position: {
        ...artifact.position,
        toolCallId: toolCall.id,
        ...(byIndex === undefined ? { toolCallIndex: index } : {}),
      },
    });
  });
}

export function reasoningArtifactsForPersistence(input: {
  artifacts: readonly ReasoningArtifact[] | undefined;
  hasToolCalls: boolean;
}): readonly ReasoningArtifact[] | undefined {
  if (!input.artifacts?.length) return undefined;
  const retained = input.artifacts.filter((artifact) =>
    input.hasToolCalls
      ? artifact.replay.scope !== "none" ||
        artifact.replay.persistence === "tool-turn"
      : artifact.replay.persistence === "final-turn" ||
        artifact.replay.persistence === "all-turns",
  );
  return retained.length ? retained : undefined;
}

export function decision(
  artifact: ReasoningArtifact,
  target: ReasoningArtifactReplayTarget,
  action: ReasoningArtifactReplayDecision["action"],
  reason?: ReasoningArtifactReplayDecision["reason"] | undefined,
): ReasoningArtifactReplayDecision {
  return Object.freeze({
    version: 1 as const,
    action,
    kind: artifact.kind,
    ...(reason ? { reason } : {}),
    source: artifact.provenance,
    target,
    byteLength: artifact.accounting.byteLength,
  });
}
