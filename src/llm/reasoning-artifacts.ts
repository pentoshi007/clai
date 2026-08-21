import { createHash } from "node:crypto";

import type {
  ChatMessage,
  NativeToolCall,
  ReasoningArtifact,
  ReasoningArtifactKind,
  ReasoningArtifactProvenance,
  ReasoningArtifactReplayDecision,
  ReasoningArtifactReplayObserver,
  ReasoningArtifactReplayTarget,
  ReasoningBlock,
} from "../types.js";

/** Input accepted by the canonical artifact factory before it is frozen. */
export interface CreateReasoningArtifactInput {
  readonly kind: ReasoningArtifactKind;
  /** Raw provider payload; never use this for display or telemetry. */
  readonly raw: ReasoningArtifact["raw"];
  /** Display-only projection, intentionally separate from the raw payload. */
  readonly displaySummary?: string | undefined;
  readonly provenance: ReasoningArtifactProvenance;
  readonly replay: ReasoningArtifact["replay"];
  readonly position?: ReasoningArtifact["position"] | undefined;
}

/** Metadata needed at a serializer boundary to decide whether replay is safe. */
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
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
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
  // Match the repository-wide conservative mixed text/JSON estimate without
  // importing the agent layer into the LLM artifact model.
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
    // A malformed custom endpoint remains comparable by hash, but its raw
    // value is never retained in the artifact or emitted as telemetry.
  }
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

/**
 * Builds privacy-safe route provenance. Endpoint identity is a one-way hash so
 * persisted artifacts and replay diagnostics never retain custom URL/query data.
 */
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

/** Creates a safe serialization target without retaining the endpoint itself. */
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

/**
 * Clones and freezes raw provider state before attaching byte/token accounting.
 * The factory is the only supported way to create artifacts from provider data.
 */
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

/** Returns the opaque signature only for signed/thought-signature artifacts. */
export function reasoningArtifactSignature(
  artifact: ReasoningArtifact,
): string | undefined {
  if (artifact.kind === "thought-signature" && typeof artifact.raw === "string") {
    return artifact.raw;
  }
  const raw = rawRecord(artifact);
  const signature = raw?.signature ?? raw?.thoughtSignature;
  return typeof signature === "string" ? signature : undefined;
}

/** Preserves encrypted items exactly as opaque JSON records for Meta replay. */
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

function legacyProvenance(kind: ReasoningArtifactKind): ReasoningArtifactProvenance {
  switch (kind) {
    case "signed":
      return createReasoningArtifactProvenance({
        provider: "anthropic",
        dialect: "anthropic-messages",
        legacy: true,
      });
    case "encrypted":
      return createReasoningArtifactProvenance({
        provider: "meta",
        dialect: "meta-responses",
        legacy: true,
      });
    case "thought-signature":
      return createReasoningArtifactProvenance({
        provider: "gemini",
        dialect: "gemini-generate-content",
        legacy: true,
      });
    default:
      return createReasoningArtifactProvenance({
        provider: "legacy",
        dialect: "openai-compatible",
        legacy: true,
      });
  }
}

function legacyReasoningArtifacts(message: ChatMessage): ReasoningArtifact[] {
  const artifacts: ReasoningArtifact[] = [];
  let sequence = 0;
  const block = message.reasoningBlock;
  if (block?.signature && block.text) {
    artifacts.push(
      createReasoningArtifact({
        kind: "signed",
        raw: { thinking: block.text, signature: block.signature },
        displaySummary: block.text,
        provenance: legacyProvenance("signed"),
        replay: { scope: "tool-turn", persistence: "tool-turn" },
        position: { sequence: sequence++, placement: "before-tool-call" },
      }),
    );
  } else if (block?.text) {
    artifacts.push(
      createReasoningArtifact({
        kind: "plaintext",
        raw: block.text,
        displaySummary: block.text,
        provenance: legacyProvenance("plaintext"),
        replay: { scope: "all-history", persistence: "all-turns" },
        position: { sequence: sequence++, placement: "assistant" },
      }),
    );
  }
  if (block?.items?.length) {
    artifacts.push(
      createReasoningArtifact({
        kind: "encrypted",
        raw: { items: block.items },
        displaySummary: block.text || undefined,
        provenance: legacyProvenance("encrypted"),
        replay: { scope: "tool-turn", persistence: "tool-turn" },
        position: { sequence: sequence++, placement: "before-tool-call" },
      }),
    );
  }
  for (let index = 0; index < (message.toolCalls?.length ?? 0); index += 1) {
    const call = message.toolCalls![index]!;
    if (!call.thoughtSignature) continue;
    artifacts.push(
      createReasoningArtifact({
        kind: "thought-signature",
        raw: call.thoughtSignature,
        provenance: legacyProvenance("thought-signature"),
        replay: { scope: "tool-turn", persistence: "tool-turn" },
        position: {
          sequence: sequence++,
          placement: "on-tool-call",
          toolCallId: call.id,
          toolCallIndex: index,
        },
      }),
    );
  }
  return artifacts;
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

/**
 * Returns canonical artifacts for a message. Legacy fields are converted only
 * when canonical data is absent, preventing duplicate replay after migration.
 */
export function reasoningArtifactsForMessage(
  message: ChatMessage,
): readonly ReasoningArtifact[] {
  if (message.reasoningArtifacts?.length) {
    return message.reasoningArtifacts.map(normalizeArtifact);
  }
  return legacyReasoningArtifacts(message);
}

/** Projects canonical artifacts back onto the existing legacy replay surface. */
export function legacyReasoningBlockFromArtifacts(
  artifacts: readonly ReasoningArtifact[],
): ReasoningBlock | undefined {
  let text: string | undefined;
  let signature: string | undefined;
  const items: Array<Record<string, unknown>> = [];
  for (const artifact of [...artifacts].sort(
    (left, right) => left.position.sequence - right.position.sequence,
  )) {
    if (artifact.kind === "signed") {
      text ??= reasoningArtifactText(artifact);
      signature ??= reasoningArtifactSignature(artifact);
      continue;
    }
    if (artifact.kind === "plaintext") {
      text ??= reasoningArtifactText(artifact);
      continue;
    }
    if (artifact.kind === "encrypted") {
      items.push(...reasoningArtifactItems(artifact));
    }
  }
  if (text === undefined && !signature && items.length === 0) return undefined;
  return {
    text: text ?? "",
    ...(signature ? { signature } : {}),
    ...(items.length ? { items } : {}),
  };
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
    const signature = artifact ? reasoningArtifactSignature(artifact) : undefined;
    if (!signature) return call;
    changed = true;
    return { ...call, thoughtSignature: signature };
  });
  return changed ? calls : [...toolCalls];
}

/**
 * Hydrates persisted legacy data into canonical artifacts while retaining the
 * original fields for older consumers and provider adapters.
 */
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

/** Canonical artifact accounting for a message, including un-migrated history. */
export function reasoningArtifactTokensForMessage(message: ChatMessage): number {
  return reasoningArtifactsForMessage(message).reduce(
    (sum, artifact) => sum + artifact.accounting.estimatedTokens,
    0,
  );
}

const REDACTED_DETAIL = /^\s*\[?redacted]?\s*$/i;

function detailVisibleField(entry: Record<string, unknown>): string | undefined {
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
      const inner = visibleReasoningDetailText(nested as ReasoningArtifact["raw"]);
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

/** Builds signed Anthropic-family artifacts without deriving replay state from display text. */
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

/**
 * Rebinds artifact positions only after duplicate and empty tool-call ids have
 * been repaired. Raw artifact bytes stay immutable; only the history position
 * receives the durable call id.
 */
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
    if (!toolCall || artifact.position.toolCallId === toolCall.id) return artifact;
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

/** Retain active tool artifacts unconditionally; retain final turns only by policy. */
export function reasoningArtifactsForPersistence(input: {
  artifacts: readonly ReasoningArtifact[] | undefined;
  hasToolCalls: boolean;
}): readonly ReasoningArtifact[] | undefined {
  if (!input.artifacts?.length) return undefined;
  const retained = input.artifacts.filter((artifact) =>
    input.hasToolCalls
      ? artifact.replay.scope !== "none" || artifact.replay.persistence === "tool-turn"
      : artifact.replay.persistence === "final-turn" ||
        artifact.replay.persistence === "all-turns",
  );
  return retained.length ? retained : undefined;
}

function decision(
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

/**
 * Conservative compatibility predicate used at final serialization only. It
 * never mutates stored history and never returns raw payloads in its decision.
 */
export function reasoningArtifactReplayDecision(
  artifact: ReasoningArtifact,
  target: ReasoningArtifactReplayTarget,
  context: ReasoningArtifactReplayContext = {},
): ReasoningArtifactReplayDecision {
  if (!context.forceScope) {
    if (artifact.replay.scope === "none") {
      return decision(artifact, target, "omitted", "replay-disabled");
    }
    if (artifact.replay.scope === "tool-turn" && !context.hasToolCalls) {
      return decision(artifact, target, "omitted", "not-a-tool-turn");
    }
  }

  const source = artifact.provenance;
  const legacyPlaintext =
    source.legacy === true &&
    (artifact.kind === "plaintext" || artifact.kind === "summary");
  if (legacyPlaintext) {
    return target.dialect === "openai-compatible"
      ? decision(artifact, target, "replayed")
      : decision(artifact, target, "omitted", "dialect-mismatch");
  }
  if (source.provider !== target.provider) {
    return decision(artifact, target, "omitted", "provider-mismatch");
  }
  if (source.dialect !== target.dialect) {
    return decision(artifact, target, "omitted", "dialect-mismatch");
  }
  if (source.model && source.model !== target.model) {
    return decision(artifact, target, "omitted", "model-mismatch");
  }
  if (source.endpointHash && !target.endpointHash) {
    return decision(artifact, target, "omitted", "endpoint-unknown");
  }
  if (source.endpointHash && source.endpointHash !== target.endpointHash) {
    return decision(artifact, target, "omitted", "endpoint-mismatch");
  }
  return decision(artifact, target, "replayed");
}

/**
 * Filters only the wire projection. Omitted artifacts remain unchanged in the
 * message/persistence timeline, while callers can emit the metadata-only
 * decisions to their operation telemetry.
 */
export function selectReasoningArtifactsForReplay(input: {
  artifacts: readonly ReasoningArtifact[] | undefined;
  target: ReasoningArtifactReplayTarget;
  context?: ReasoningArtifactReplayContext | undefined;
  observe?: ReasoningArtifactReplayObserver | undefined;
}): readonly ReasoningArtifact[] {
  if (!input.artifacts?.length) return [];
  const selected: ReasoningArtifact[] = [];
  for (const artifact of input.artifacts) {
    const replay = reasoningArtifactReplayDecision(
      artifact,
      input.target,
      input.context,
    );
    input.observe?.(replay);
    if (replay.action === "replayed") selected.push(artifact);
  }
  return selected;
}
