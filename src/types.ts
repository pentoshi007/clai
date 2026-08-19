export const providerIds = [
  "free",
  "gemini",
  "openrouter",
  "openai",
  "anthropic",
  "nvidia",
  "agentrouter",
  "aws-mantle",
  "ollama",
  "bynara",
  "qwen-cloud",
  "modal",
  "lightning",
  "tokenrouter",
  "meta",
  "fireworks",
  "hetzner",
  "orcarouter",
] as const;

export type ProviderId = (typeof providerIds)[number];
export type Mode = "ask" | "agent" | "plan";
export type RiskLevel = "safe" | "confirm" | "block";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ReasoningPreference {
  enabled: boolean;
  effort: ReasoningEffort;
}

export interface ChatImage {
  /** MIME type, e.g. "image/png", "image/jpeg". */
  mediaType: string;
  /** Base64-encoded image bytes (no data: prefix). */
  dataBase64: string;
  /** Original path, for display/debugging. */
  path?: string | undefined;
}

/** Structured tool call as returned by provider-native function calling. */
export interface NativeToolCall {
  id: string;
  /** Canonical dotted name (e.g. fs.write). */
  name: string;
  args: Record<string, unknown>;
  /** Original JSON arguments string when the provider sent one. */
  rawArguments?: string | undefined;
  /**
   * Gemini 3 "thought signature" — an opaque, encrypted token the model
   * attaches to a functionCall part so it can resume its reasoning state
   * when the tool result comes back. Must be echoed back verbatim on the
   * matching functionCall part in the next turn, or Gemini 3 returns a hard
   * HTTP 400. Unused by other providers.
   * https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
   */
  thoughtSignature?: string | undefined;
}

/** Partial native tool call while the provider stream is still open (P2-3). */
export interface ToolCallStreamDelta {
  index: number;
  id?: string | undefined;
  /** Canonical name when known (may arrive before args complete). */
  name?: string | undefined;
  /** Accumulated argument JSON byte length so far. */
  argumentsBytes?: number | undefined;
}

/** Provider-signed reasoning that must be replayed verbatim. */
export interface ReasoningBlock {
  text: string;
  /** Anthropic signature; without it a thinking block cannot be replayed. */
  signature?: string | undefined;
  /**
   * Provider-specific items replayed verbatim into the next request
   * (Meta Responses API encrypted reasoning items).
   */
  items?: Array<Record<string, unknown>> | undefined;
}

/** Canonical raw-state formats captured from reasoning-capable routes. */
export type ReasoningArtifactKind =
  | "plaintext"
  | "signed"
  | "encrypted"
  | "structured-details"
  | "thought-signature"
  | "summary";

/** Wire dialect that originally produced the artifact. */
export type ReasoningArtifactDialect =
  | "anthropic-messages"
  | "gemini-generate-content"
  | "meta-responses"
  | "openai-compatible"
  | "ollama-chat"
  | "legacy";

/** How long an artifact can legally remain on the provider replay timeline. */
export type ReasoningArtifactReplayScope =
  | "none"
  | "tool-turn"
  | "next-turn"
  | "all-history";

/** Whether a final assistant turn may persist the artifact. */
export type ReasoningArtifactPersistence =
  | "never"
  | "tool-turn"
  | "final-turn"
  | "all-turns";

/** Original part/call placement, preserved independently of display text. */
export interface ReasoningArtifactPosition {
  readonly sequence: number;
  readonly placement: "assistant" | "before-tool-call" | "on-tool-call";
  readonly toolCallId?: string | undefined;
  readonly toolCallIndex?: number | undefined;
}

/**
 * Origin metadata used for conservative replay. `endpointHash` is a SHA-256
 * identifier, never a raw endpoint/query string; legacy payloads predate full
 * route provenance and are restricted to their known protocol family.
 */
export interface ReasoningArtifactProvenance {
  readonly provider: ProviderId | "legacy";
  readonly model?: string | undefined;
  readonly endpointHash?: string | undefined;
  readonly dialect: ReasoningArtifactDialect;
  readonly legacy?: true | undefined;
}

/** Target route used at a serializer boundary for artifact compatibility. */
export interface ReasoningArtifactReplayTarget {
  readonly provider: ProviderId;
  readonly model: string;
  readonly endpointHash?: string | undefined;
  readonly dialect: ReasoningArtifactDialect;
}

/** Immutable raw provider state; text shown to users lives in `displaySummary`. */
export type ReasoningArtifactRaw =
  | string
  | Readonly<Record<string, unknown>>
  | readonly unknown[];

/**
 * Versioned reasoning state. Raw payloads are immutable replay data and must
 * never be used as transcript/display text or operation telemetry.
 */
export interface ReasoningArtifact {
  readonly version: 1;
  readonly kind: ReasoningArtifactKind;
  readonly raw: ReasoningArtifactRaw;
  readonly displaySummary?: string | undefined;
  readonly provenance: ReasoningArtifactProvenance;
  readonly replay: {
    readonly scope: ReasoningArtifactReplayScope;
    readonly persistence: ReasoningArtifactPersistence;
  };
  readonly position: ReasoningArtifactPosition;
  readonly accounting: {
    readonly byteLength: number;
    readonly estimatedTokens: number;
  };
}

/** Metadata-only serializer decision. It intentionally contains no raw state. */
export type ReasoningArtifactOmissionReason =
  | "replay-disabled"
  | "not-a-tool-turn"
  | "provider-mismatch"
  | "model-mismatch"
  | "endpoint-mismatch"
  | "endpoint-unknown"
  | "dialect-mismatch";

export interface ReasoningArtifactReplayDecision {
  readonly version: 1;
  readonly action: "replayed" | "omitted";
  readonly kind: ReasoningArtifactKind;
  readonly reason?: ReasoningArtifactOmissionReason | undefined;
  readonly source: ReasoningArtifactProvenance;
  readonly target: ReasoningArtifactReplayTarget;
  readonly byteLength: number;
}

export type ReasoningArtifactReplayObserver = (
  decision: ReasoningArtifactReplayDecision,
) => void;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /**
   * Optional image attachments for this message. Only populated for user
   * turns when the active model supports vision; providers that understand
   * images serialize these into their multimodal message format, and
   * providers/models without vision ignore them (the text content still
   * carries a note so the agent can fall back to OCR tools).
   */
  images?: ChatImage[] | undefined;
  /** For role "tool": id of the assistant tool_call this result answers. */
  toolCallId?: string | undefined;
  /** For assistant turns that requested tools. */
  toolCalls?: NativeToolCall[] | undefined;
  /** Optional tool name (some providers require it on tool results). */
  name?: string | undefined;
  /** For role "tool": whether the tool succeeded (Anthropic is_error). */
  ok?: boolean | undefined;
  /**
   * Signed reasoning block for providers that require the model's own thinking
   * to be replayed verbatim on the assistant turn that carries tool_use
   * (Anthropic extended thinking, ). Additive: adapters that do not
   * understand it ignore it.
   */
  reasoningBlock?: ReasoningBlock | undefined;
  /** Canonical immutable artifact timeline; legacy `reasoningBlock` remains additive. */
  reasoningArtifacts?: readonly ReasoningArtifact[] | undefined;
  /**
   * Model-only recovery / governor nudge. Kept in API history so the agent
   * continues correctly, but never rendered as a YOU bubble or WARN notice
   * in the chat transcript.
   */
  internal?: boolean | undefined;
}

/** True for system-injected recovery prompts that must stay out of the chat UI. */
export function isInternalChatMessage(message: ChatMessage): boolean {
  if (message.internal) return true;
  if (message.role !== "user") return false;
  const text = message.content.trim();
  // Implement / plan-accept directives injected by the UI (not typed by user).
  if (/^Plan approved\.\s+Execute\b/i.test(text)) return true;
  if (/^Plan revision request from the user\b/i.test(text)) return true;
  // Legacy recovery texts that predate the `internal` flag.
  return /^(?:You diagnosed an error and described the fix|You wrote a message but called NO tool|You described (?:an action|work|security work)|You claimed a search\/fetch|You wrote the plan as prose|INCOMPLETE: the user asked for a working product feature|This is a local app build: do not stop|The local HTTP probe failed|You have not finished the approved plan|Coverage looks thin \(ports|You are in plan mode and tried to finish without a durable plan)\b/i.test(
    text,
  );
}

/** Tool choice for native function calling (canonical names). */
export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; name: string };

/** JSON Schema object used for tool parameters. */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[] | undefined;
  additionalProperties?: boolean | undefined;
}

/** Canonical tool definition exposed to providers. */
export interface ToolDefinition {
  name: string;
  wireName: string;
  description: string;
  parameters: JsonSchemaObject;
  mutates?: boolean | undefined;
  readOnly?: boolean | undefined;
  askMode?: boolean | undefined;
}

export type GenerationAttemptMode = "complete" | "stream";

export type GenerationAttemptReason =
  | "initial"
  | "retry"
  | "fallback"
  | "adaptation"
  | "provider-retry";

export type GenerationAttemptOutcome = "success" | "failure" | "cancelled";

export type RequestFingerprintSerializerId =
  | "chat-completions"
  | "anthropic-messages"
  | "gemini-generate-content"
  | "meta-responses"
  | "ollama-chat";

export type RequestFingerprintSectionKind =
  | "instructions"
  | "tools"
  | "history"
  | "settings";

export interface RequestFingerprintSection {
  readonly section: RequestFingerprintSectionKind;
  readonly byteLength: number;
  readonly sha256: string;
  readonly itemCount?: number | undefined;
}

export interface RequestFingerprintPrefix {
  readonly ordinal: number;
  readonly section: RequestFingerprintSectionKind | "wire";
  readonly boundary: "field" | "history-item" | "wire";
  readonly byteLength: number;
  readonly sha256: string;
  readonly historyItems?: number | undefined;
}

/** Metadata-only digest of a final request body; never contains wire values. */
export interface RequestFingerprintV1 {
  readonly version: 1;
  readonly serializer: {
    readonly id: RequestFingerprintSerializerId;
    readonly version: 1;
  };
  readonly body: {
    readonly byteLength: number;
    readonly sha256: string;
  };
  readonly sections: readonly RequestFingerprintSection[];
  readonly prefixes: readonly RequestFingerprintPrefix[];
}

export interface GenerationAttemptInput {
  readonly provider: ProviderId;
  readonly model: string;
  readonly mode: GenerationAttemptMode;
  readonly reason: GenerationAttemptReason;
  /** Final-wire metadata only; no body, header, URL, or request value is retained. */
  readonly requestFingerprint?: RequestFingerprintV1 | undefined;
}

export interface GenerationAttemptHandle {
  complete(
    outcome: GenerationAttemptOutcome,
    usage?: TokenUsage | undefined,
    statusCode?: number | undefined,
  ): void;
}

export interface GenerationAttemptUsageSink {
  begin(input: GenerationAttemptInput): GenerationAttemptHandle;
}

/**
 * Logical role of a request. Turn and compaction requests deliberately share a
 * cache identity so a compaction prompt can reuse the turn's cached prefix;
 * auxiliary requests (titles, classifications) are isolated so their unrelated
 * short prefix can never evict it.
 */
export type CompletionRequestPurpose = "turn" | "compaction" | "auxiliary";

export interface SuccessfulRequestSnapshot {
  readonly provider: ProviderId;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number | undefined;
  readonly thinking?: ReasoningPreference | undefined;
  readonly tools?: readonly ToolDefinition[] | undefined;
  readonly toolChoice?: ToolChoice | undefined;
  readonly parallelToolCalls?: boolean | undefined;
}

export interface CompletionRequest {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  /** Scopes provider cache-affinity keys; defaults to a turn request. */
  purpose?: CompletionRequestPurpose | undefined;
  /** Internal per-operation admission accounting; serializers must ignore it. */
  attemptUsage?: GenerationAttemptUsageSink | undefined;
  /** Internal reason for providers that issue nested physical admissions. */
  attemptReason?: GenerationAttemptReason | undefined;
  /**
   * Permit the configured provider chain to use each fallback provider's
   * default model when the explicitly selected model cannot produce a usable
   * completion. Agent turns opt in so a reasoning-only stream never ends the
   * user's turn without an answer.
   */
  allowModelFallback?: boolean | undefined;
  /**
   * On a recovery attempt, try configured alternate providers before replaying
   * the selected route. Used only after a live-connection stall: that route has
   * already repeated expensive partial work, while ordinary requests still
   * honor the selected provider first. The selected route remains last in the
   * chain so recovery still works when no alternate is configured.
   */
  preferModelFallback?: boolean | undefined;
  messages: ChatMessage[];
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
  thinking?: ReasoningPreference | undefined;
  forceReasoningReplay?: boolean | undefined;
  /** Native tool definitions (canonical). Adapters convert to wire format. */
  tools?: ToolDefinition[] | undefined;
  toolChoice?: ToolChoice | undefined;
  parallelToolCalls?: boolean | undefined;
  /** Fired as native tool_call name/args stream in (early UI cards). */
  onToolCallDelta?: ((delta: ToolCallStreamDelta) => void) | undefined;
  /** Metadata-only artifact replay decisions emitted during request serialization. */
  onReasoningArtifactReplayDecision?: ReasoningArtifactReplayObserver | undefined;
  onStreamEvent?: import("./llm/stream-events.js").ProviderStreamEventSink | undefined;
}

/** Provider-reported or estimated token counts for one completion. */
export interface TokenUsage {
  readonly promptTokens: number;
  /**
   * Present only when another provider counter arrived without a prompt count.
   * Absence preserves legacy callers: any supplied promptTokens value is known,
   * including an explicit zero.
   */
  readonly promptTokensKnown?: false | undefined;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /** true when values came from the provider API. */
  readonly exact: boolean;
  /** Prompt tokens served from provider cache, when reported. */
  readonly cachedPromptTokens?: number | undefined;
  /** Prompt tokens written into the provider cache, when reported. */
  readonly cacheCreationTokens?: number | undefined;
  /** Prompt tokens explicitly not served from provider cache, when reported. */
  readonly uncachedPromptTokens?: number | undefined;
  /** Reasoning tokens inside the completion, when reported. */
  readonly reasoningTokens?: number | undefined;
}

export interface CompletionResult {
  text: string;
  provider: ProviderId;
  model: string;
  toolCalls?: NativeToolCall[] | undefined;
  finishReason?: "stop" | "tool_calls" | "length" | "error" | string | undefined;
  /** Optional raw assistant payload for perfect replay (e.g. Anthropic blocks). */
  rawAssistantMessage?: unknown | undefined;
  /** Exact usage when the provider reported it; omit when unknown. */
  usage?: TokenUsage | undefined;
  /** Per-admission usage for the logical operation that produced this result. */
  operationUsage?: import("./llm/operation-usage.js").OperationUsageSnapshot | undefined;
  /** Signed reasoning block to replay on the next request. */
  reasoningBlock?: ReasoningBlock | undefined;
  /** Canonical immutable replay artifacts emitted by the provider. */
  reasoningArtifacts?: readonly ReasoningArtifact[] | undefined;
}

export interface ProviderStatus {
  provider: ProviderId;
  label: string;
  active: boolean;
  configured: boolean;
  source: "env" | "keychain" | "fallback" | "local" | "missing";
  /** Masked active (or sole) key for compact listings. */
  maskedKey?: string | undefined;
  /** Number of stored API keys (env-only counts as 1 when present). */
  keyCount?: number | undefined;
  /** All masked keys in storage order (multi-key). */
  maskedKeys?: string[] | undefined;
  /** Masked sticky-active key when multiple are configured. */
  activeMaskedKey?: string | undefined;
  model: string;
  note?: string | undefined;
  /** Stored endpoint URLs, in order, for providers with a user-supplied base URL. */
  endpoints?: string[] | undefined;
  /** Index of the sticky active endpoint within `endpoints`. */
  activeEndpointIndex?: number | undefined;
  keyDisabled?: boolean[] | undefined;
  disabledEndpoints?: string[] | undefined;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolStats {
  bytesRead: number;
  bytesDropped: number;
  linesRead: number;
  elapsedMs: number;
  captureLimitHit?: boolean | undefined;
}

export interface BackgroundJobReceipt {
  id: string;
  status: string;
  artifactPath: string;
  profile?: string | undefined;
  estimatedSeconds?: number | undefined;
  nextOffset?: number | undefined;
  exitCode?: number | undefined;
  signal?: string | undefined;
  /** True when completion is delivered by the Responder; false/absent means pollable. */
  responder?: boolean | undefined;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  exitCode?: number | undefined;
  outputPath?: string | undefined;
  backgroundJob?: BackgroundJobReceipt | undefined;
  truncated?: boolean | undefined;
  /** Internal: the tool intentionally returned policy/repeat feedback without polling. */
  suppressedRepeat?: boolean | undefined;
  /**
   * Set by aggregate tools (tool.batch) when some children succeeded and some
   * failed. `ok` stays false so no layer records a partial run as success,
   * while callers can distinguish partial results from a full failure/abort.
   */
  partial?: boolean | undefined;
  stats?: ToolStats | undefined;
  /**
   * Structured before/after diffs for file mutation tools (fs.edit / write / …).
   * UI renders Cursor-style green/red hunks; model history uses `output` only.
   */
  fileChanges?: import("./tools/file-diff.js").FileChange[] | undefined;
  interactiveSession?:
    | import("./interactive-session/types.js").InteractiveSessionToolResult
    | undefined;
  /**
   * Images the tool wants the model to actually look at (image.view).
   *
   * Tool-result messages are text-only on every provider wire we support, so
   * the agent replays these as a follow-up user turn carrying the real bytes —
   * the same path user attachments already take. Providers without vision drop
   * them and the `output` text still explains what was inspected.
   */
  images?: ChatImage[] | undefined;
}
