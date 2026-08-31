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
  "merge-gateway",
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
  mediaType: string;
  dataBase64: string;
  path?: string | undefined;
}

export interface NativeToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  rawArguments?: string | undefined;
  thoughtSignature?: string | undefined;
}

export interface ToolCallStreamDelta {
  index: number;
  id?: string | undefined;
  name?: string | undefined;
  argumentsBytes?: number | undefined;
}

export interface ReasoningBlock {
  text: string;
  signature?: string | undefined;
  items?: Array<Record<string, unknown>> | undefined;
}

export type ReasoningArtifactKind =
  | "plaintext"
  | "signed"
  | "encrypted"
  | "structured-details"
  | "thought-signature"
  | "summary";

export type ReasoningArtifactDialect =
  | "anthropic-messages"
  | "gemini-generate-content"
  | "meta-responses"
  | "openai-compatible"
  | "ollama-chat"
  | "legacy";

export type ReasoningArtifactReplayScope =
  | "none"
  | "tool-turn"
  | "next-turn"
  | "all-history";

export type ReasoningArtifactPersistence =
  | "never"
  | "tool-turn"
  | "final-turn"
  | "all-turns";

export interface ReasoningArtifactPosition {
  readonly sequence: number;
  readonly placement: "assistant" | "before-tool-call" | "on-tool-call";
  readonly toolCallId?: string | undefined;
  readonly toolCallIndex?: number | undefined;
}

export interface ReasoningArtifactProvenance {
  readonly provider: ProviderId | "legacy";
  readonly model?: string | undefined;
  readonly endpointHash?: string | undefined;
  readonly dialect: ReasoningArtifactDialect;
  readonly legacy?: true | undefined;
}

export interface ReasoningArtifactReplayTarget {
  readonly provider: ProviderId;
  readonly model: string;
  readonly endpointHash?: string | undefined;
  readonly dialect: ReasoningArtifactDialect;
}

export type ReasoningArtifactRaw =
  | string
  | Readonly<Record<string, unknown>>
  | readonly unknown[];

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
  images?: ChatImage[] | undefined;
  toolCallId?: string | undefined;
  toolCalls?: NativeToolCall[] | undefined;
  name?: string | undefined;
  ok?: boolean | undefined;
  reasoningBlock?: ReasoningBlock | undefined;
  reasoningArtifacts?: readonly ReasoningArtifact[] | undefined;
  internal?: boolean | undefined;
}

export function isInternalChatMessage(message: ChatMessage): boolean {
  if (message.internal) return true;
  if (message.role !== "user") return false;
  const text = message.content.trim();
  if (/^Plan approved\.\s+Execute\b/i.test(text)) return true;
  if (/^Plan revision request from the user\b/i.test(text)) return true;
  return /^(?:You diagnosed an error and described the fix|You wrote a message but called NO tool|You described (?:an action|work|security work)|You claimed a search\/fetch|You wrote the plan as prose|INCOMPLETE: the user asked for a working product feature|This is a local app build: do not stop|The local HTTP probe failed|You have not finished the approved plan|Coverage looks thin \(ports|You are in plan mode and tried to finish without a durable plan)\b/i.test(
    text,
  );
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; name: string };

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[] | undefined;
  additionalProperties?: boolean | undefined;
}

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
  purpose?: CompletionRequestPurpose | undefined;
  attemptUsage?: GenerationAttemptUsageSink | undefined;
  attemptReason?: GenerationAttemptReason | undefined;
  allowModelFallback?: boolean | undefined;
  preferModelFallback?: boolean | undefined;
  messages: ChatMessage[];
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
  thinking?: ReasoningPreference | undefined;
  forceReasoningReplay?: boolean | undefined;
  tools?: ToolDefinition[] | undefined;
  toolChoice?: ToolChoice | undefined;
  parallelToolCalls?: boolean | undefined;
  onToolCallDelta?: ((delta: ToolCallStreamDelta) => void) | undefined;
  onReasoningArtifactReplayDecision?: ReasoningArtifactReplayObserver | undefined;
  onStreamEvent?: import("./llm/stream-events.js").ProviderStreamEventSink | undefined;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly promptTokensKnown?: false | undefined;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly exact: boolean;
  readonly cachedPromptTokens?: number | undefined;
  readonly cacheCreationTokens?: number | undefined;
  readonly uncachedPromptTokens?: number | undefined;
  readonly reasoningTokens?: number | undefined;
  readonly reasoningObserved?: true | undefined;
}

export interface CompletionResult {
  text: string;
  provider: ProviderId;
  model: string;
  toolCalls?: NativeToolCall[] | undefined;
  finishReason?: "stop" | "tool_calls" | "length" | "error" | string | undefined;
  rawAssistantMessage?: unknown | undefined;
  usage?: TokenUsage | undefined;
  operationUsage?: import("./llm/operation-usage.js").OperationUsageSnapshot | undefined;
  reasoningBlock?: ReasoningBlock | undefined;
  reasoningArtifacts?: readonly ReasoningArtifact[] | undefined;
}

export interface ProviderStatus {
  provider: ProviderId;
  label: string;
  active: boolean;
  configured: boolean;
  source: "env" | "keychain" | "fallback" | "local" | "missing";
  maskedKey?: string | undefined;
  keyCount?: number | undefined;
  maskedKeys?: string[] | undefined;
  activeMaskedKey?: string | undefined;
  model: string;
  note?: string | undefined;
  endpoints?: string[] | undefined;
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
  responder?: boolean | undefined;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  exitCode?: number | undefined;
  outputPath?: string | undefined;
  backgroundJob?: BackgroundJobReceipt | undefined;
  truncated?: boolean | undefined;
  suppressedRepeat?: boolean | undefined;
  partial?: boolean | undefined;
  stats?: ToolStats | undefined;
  fileChanges?: import("./tools/file-diff.js").FileChange[] | undefined;
  interactiveSession?:
    | import("./interactive-session/types.js").InteractiveSessionToolResult
    | undefined;
  images?: ChatImage[] | undefined;
}
