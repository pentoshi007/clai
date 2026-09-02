
export type SessionOperation =
  | "start"
  | "send"
  | "read"
  | "status"
  | "list"
  | "resize"
  | "close";

export type SessionState =
  | "starting"
  | "running"
  | "closing"
  | "exited"
  | "failed"
  | "closed";

export const TERMINAL_SESSION_STATES: readonly SessionState[] = [
  "exited",
  "failed",
  "closed",
];

export function isTerminalState(state: SessionState): boolean {
  return TERMINAL_SESSION_STATES.includes(state);
}

export type TerminationReason =
  | "process-exit"
  | "explicit-close"
  | "cancelled"
  | "idle-timeout"
  | "lifetime-timeout"
  | "conversation-teardown"
  | "app-shutdown"
  | "output-limit"
  | "launch-failure";

export type SessionTransportKind = "pty" | "pipe";
export type TerminalMode = "required" | "preferred" | "pipe";
export type OutputStream = "terminal" | "stdout" | "stderr";
export type OutputView = "plain" | "encoded";

export interface TerminalDimensions {
  readonly columns: number;
  readonly rows: number;
}

export type ControlInput =
  | "interrupt"
  | "eof"
  | "suspend"
  | "escape"
  | "tab"
  | "backspace"
  | "up"
  | "down"
  | "left"
  | "right";

export const CONTROL_INPUTS: readonly ControlInput[] = [
  "interrupt",
  "eof",
  "suspend",
  "escape",
  "tab",
  "backspace",
  "up",
  "down",
  "left",
  "right",
];

export type SubmitBehavior = "enter" | "none";

export type SessionInput =
  | { readonly kind: "text"; readonly text: string; readonly submit: SubmitBehavior }
  | { readonly kind: "secret"; readonly value: string; readonly submit: SubmitBehavior }
  | { readonly kind: "control"; readonly control: ControlInput }
  | { readonly kind: "eof" };

export type SessionInputKind = SessionInput["kind"];


export interface ProcessOutcome {
  readonly exitCode?: number | undefined;
  readonly signal?: string | undefined;
  readonly endedAt: number;
}

export type ProcessIdentityComparison = "match" | "mismatch" | "gone" | "unknown";


export interface OutputEvent {
  readonly startCursor: number;
  readonly endCursor: number;
  readonly stream: OutputStream;
  readonly observedAt: number;
  readonly bytes: Uint8Array;
}

export interface PresentedOutputEvent {
  readonly startCursor: number;
  readonly endCursor: number;
  readonly stream: OutputStream;
  readonly observedAt: number;
  readonly content: string;
  readonly decodingLoss?: boolean | undefined;
}

export interface ArtifactReference {
  readonly path: string;
  readonly bytes: number;
  readonly droppedBytes: number;
  readonly redacted: boolean;
}

export interface ArtifactReceipt extends ArtifactReference {
  readonly chunks: readonly string[];
  readonly sha256: string;
}

export interface OutputPage {
  readonly events: readonly PresentedOutputEvent[];
  readonly requestedCursor: number;
  readonly nextCursor: number;
  readonly hasMore: boolean;
  readonly earliestAvailableCursor: number;
  readonly latestCursor: number;
  readonly view: OutputView;
  readonly decodingLoss: boolean;
  readonly omittedBytes?: number | undefined;
  readonly artifact: ArtifactReference;
}


export interface InteractiveSessionRecord {
  readonly id: string;
  readonly ownerId: string;
  state: SessionState;
  transport: SessionTransportKind;
  readonly startedAt: number;
  lastActivityAt: number;
  endedAt?: number | undefined;
  dimensions?: TerminalDimensions | undefined;
  degradedReason?: "PTY_UNAVAILABLE" | undefined;
  processOutcome?: ProcessOutcome | undefined;
  terminationReason?: TerminationReason | undefined;
  artifact: ArtifactReceipt;
  earliestCursor: number;
  latestCursor: number;
  inputClosed: boolean;
  cleanupVerified?: boolean | undefined;
}

export interface SessionSummary {
  readonly id: string;
  readonly state: SessionState;
  readonly transport: SessionTransportKind;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly endedAt?: number | undefined;
  readonly dimensions?: TerminalDimensions | undefined;
  readonly degradedReason?: "PTY_UNAVAILABLE" | undefined;
  readonly processOutcome?: ProcessOutcome | undefined;
  readonly terminationReason?: TerminationReason | undefined;
  readonly earliestCursor: number;
  readonly latestCursor: number;
  readonly inputClosed: boolean;
  readonly artifact: ArtifactReference;
  readonly cleanupVerified?: boolean | undefined;
}


export interface OwnerScoped {
  readonly ownerId: string;
}

export interface StartRequest extends OwnerScoped {
  readonly command: string;
  readonly cwd?: string | undefined;
  readonly terminalMode?: TerminalMode | undefined;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  readonly idleTimeoutMs?: number | undefined;
  readonly lifetimeTimeoutMs?: number | undefined;
  readonly deadlineMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface SendRequest extends OwnerScoped {
  readonly id: string;
  readonly input: SessionInput;
  readonly cursor?: number | undefined;
  readonly quietMs?: number | undefined;
  readonly deadlineMs?: number | undefined;
  readonly view?: OutputView | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface ReadRequest extends OwnerScoped {
  readonly id: string;
  readonly cursor: number;
  readonly waitMs?: number | undefined;
  readonly view?: OutputView | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface ResizeRequest extends OwnerScoped, TerminalDimensions {
  readonly id: string;
}

export interface CloseRequest extends OwnerScoped {
  readonly id: string;
  readonly deadlineMs?: number | undefined;
}


export interface StartResult {
  readonly operation: "start";
  readonly sessionId: string;
  readonly state: SessionState;
  readonly transport: SessionTransportKind;
  readonly dimensions?: TerminalDimensions | undefined;
  readonly degradedReason?: "PTY_UNAVAILABLE" | undefined;
  readonly cursor: number;
  readonly artifact: ArtifactReference;
  readonly retriedLaunch?: boolean | undefined;
}

export type DeliveryStatus = "delivered" | "not-delivered" | "unknown";

export interface SendResult {
  readonly operation: "send";
  readonly sessionId: string;
  readonly inputSequence: number;
  readonly delivery: DeliveryStatus;
  readonly deliveredBytes: number;
  readonly state: SessionState;
  readonly page?: OutputPage | undefined;
  readonly error?: StableError | undefined;
}

export interface ReadResult {
  readonly operation: "read";
  readonly sessionId: string;
  readonly state: SessionState;
  readonly page?: OutputPage | undefined;
  readonly error?: StableError | undefined;
}

export interface StatusResult {
  readonly operation: "status";
  readonly session: SessionSummary;
}

export interface ListResult {
  readonly operation: "list";
  readonly sessions: readonly SessionSummary[];
}

export interface ResizeResult {
  readonly operation: "resize";
  readonly sessionId: string;
  readonly state: SessionState;
  readonly dimensions: TerminalDimensions;
}

export interface CloseResult {
  readonly operation: "close";
  readonly sessionId: string;
  readonly state: SessionState;
  readonly terminationReason?: TerminationReason | undefined;
  readonly processOutcome?: ProcessOutcome | undefined;
  readonly cleanupVerified: boolean;
  readonly artifact: ArtifactReference;
  readonly error?: StableError | undefined;
}

export interface CloseOwnerResult {
  readonly closed: number;
  readonly failures: readonly StableError[];
}

export interface CloseAllResult extends CloseOwnerResult {
  readonly owners: number;
}

export type InteractiveSessionToolResult =
  | StartResult
  | SendResult
  | ReadResult
  | StatusResult
  | ListResult
  | ResizeResult
  | CloseResult;


export const STABLE_ERROR_CODES = [
  "INVALID_REQUEST",
  "INVALID_CONFIGURATION",
  "SESSION_NOT_FOUND",
  "LIMIT_REACHED",
  "PTY_UNAVAILABLE",
  "SESSION_NOT_RUNNING",
  "SESSION_CLOSING",
  "INPUT_CLOSED",
  "INPUT_REJECTED",
  "INPUT_DELIVERY_UNKNOWN",
  "UNSUPPORTED_CONTROL",
  "UNSUPPORTED_OPERATION",
  "BACKPRESSURE",
  "DEADLINE_EXCEEDED",
  "CANCELLED",
  "OUTPUT_GAP",
  "LAUNCH_FAILED",
  "PERSIST_FAILED",
  "CLEANUP_FAILED",
] as const;

export type StableErrorCode = (typeof STABLE_ERROR_CODES)[number];

export type StableErrorDetailValue = string | number | boolean;

export const STABLE_ERROR_DETAIL_KEYS = [
  "earliestAvailableCursor",
  "latestCursor",
  "requestedCursor",
  "omittedBytes",
  "deliveredBytes",
  "queuedBytes",
  "limitBytes",
  "liveSessions",
  "limit",
  "inputSequence",
  "control",
  "transport",
  "terminalMode",
  "field",
  "columns",
  "rows",
  "elapsedMs",
  "deadlineMs",
  "survivingDescendants",
  "cleanupVerified",
  "terminationReason",
  "reason",
  "artifactPath",
] as const;

export type StableErrorDetailKey = (typeof STABLE_ERROR_DETAIL_KEYS)[number];

export interface StableError {
  readonly code: StableErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly operation: SessionOperation;
  readonly sessionId?: string | undefined;
  readonly state?: SessionState | undefined;
  readonly details?: Readonly<Partial<Record<StableErrorDetailKey, StableErrorDetailValue>>> | undefined;
}

const MAX_ERROR_MESSAGE_CHARS = 400;
const MAX_ERROR_DETAIL_CHARS = 120;

const NON_RETRYABLE_CODES = new Set<StableErrorCode>([
  "INVALID_REQUEST",
  "INVALID_CONFIGURATION",
  "SESSION_NOT_FOUND",
  "PTY_UNAVAILABLE",
  "SESSION_NOT_RUNNING",
  "SESSION_CLOSING",
  "INPUT_CLOSED",
  "INPUT_REJECTED",
  "INPUT_DELIVERY_UNKNOWN",
  "UNSUPPORTED_CONTROL",
  "UNSUPPORTED_OPERATION",
  "DEADLINE_EXCEEDED",
  "CANCELLED",
  "OUTPUT_GAP",
  "CLEANUP_FAILED",
]);

const RETRYABLE_CODES = new Set<StableErrorCode>([
  "LIMIT_REACHED",
  "BACKPRESSURE",
]);

export interface SessionErrorInit {
  readonly code: StableErrorCode;
  readonly operation: SessionOperation;
  readonly message: string;
  readonly sessionId?: string | undefined;
  readonly state?: SessionState | undefined;
  readonly details?: Readonly<Partial<Record<StableErrorDetailKey, StableErrorDetailValue>>> | undefined;
  readonly retryable?: boolean | undefined;
}

function boundDetailValue(value: StableErrorDetailValue): StableErrorDetailValue {
  if (typeof value !== "string") return value;
  return value.length > MAX_ERROR_DETAIL_CHARS
    ? `${value.slice(0, MAX_ERROR_DETAIL_CHARS)}…`
    : value;
}

function resolveRetryable(init: SessionErrorInit): boolean {
  if (NON_RETRYABLE_CODES.has(init.code)) return false;
  if (RETRYABLE_CODES.has(init.code)) return init.retryable ?? true;
  return init.retryable ?? false;
}

export function sessionError(init: SessionErrorInit): StableError {
  const details: Partial<Record<StableErrorDetailKey, StableErrorDetailValue>> = {};
  for (const key of STABLE_ERROR_DETAIL_KEYS) {
    const value = init.details?.[key];
    if (value !== undefined) details[key] = boundDetailValue(value);
  }
  const message =
    init.message.length > MAX_ERROR_MESSAGE_CHARS
      ? `${init.message.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`
      : init.message;
  return {
    code: init.code,
    message,
    retryable: resolveRetryable(init),
    operation: init.operation,
    ...(init.sessionId !== undefined ? { sessionId: init.sessionId } : {}),
    ...(init.state !== undefined ? { state: init.state } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

export class SessionErrorException extends Error {
  constructor(readonly stable: StableError) {
    super(stable.message);
    this.name = "SessionErrorException";
  }
}

export function throwSessionError(init: SessionErrorInit): never {
  throw new SessionErrorException(sessionError(init));
}

export function asStableError(
  value: unknown,
  fallback: SessionErrorInit,
): StableError {
  return value instanceof SessionErrorException
    ? value.stable
    : sessionError(fallback);
}

export function toSummary(record: InteractiveSessionRecord): SessionSummary {
  return {
    id: record.id,
    state: record.state,
    transport: record.transport,
    startedAt: record.startedAt,
    lastActivityAt: record.lastActivityAt,
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    ...(record.dimensions ? { dimensions: { ...record.dimensions } } : {}),
    ...(record.degradedReason ? { degradedReason: record.degradedReason } : {}),
    ...(record.processOutcome ? { processOutcome: { ...record.processOutcome } } : {}),
    ...(record.terminationReason ? { terminationReason: record.terminationReason } : {}),
    earliestCursor: record.earliestCursor,
    latestCursor: record.latestCursor,
    inputClosed: record.inputClosed,
    artifact: artifactReference(record.artifact),
    ...(record.cleanupVerified !== undefined
      ? { cleanupVerified: record.cleanupVerified }
      : {}),
  };
}

export function artifactReference(receipt: ArtifactReceipt): ArtifactReference {
  return {
    path: receipt.path,
    bytes: receipt.bytes,
    droppedBytes: receipt.droppedBytes,
    redacted: receipt.redacted,
  };
}
