
import { createHmac, randomBytes } from "node:crypto";
import { auditLog } from "../store/logs.js";
import type {
  SessionOperation,
  SessionState,
  SessionTransportKind,
  StableErrorCode,
  TerminationReason,
} from "./types.js";

const AUDIT_EVENT = "tool.terminal_session";
/** Per-process key so a redacted id cannot be correlated across runs. */
const idKey = randomBytes(32);

export function redactSessionId(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  return createHmac("sha256", idKey).update(sessionId).digest("hex").slice(0, 12);
}

export interface TelemetryEvent {
  readonly operation: SessionOperation;
  readonly sessionId?: string | undefined;
  readonly durationMs: number;
  readonly result: "ok" | StableErrorCode;
  readonly state?: SessionState | undefined;
  readonly transport?: SessionTransportKind | undefined;
  readonly inputBytes?: number | undefined;
  readonly outputBytes?: number | undefined;
  readonly queueDepth?: number | undefined;
  readonly retryCount?: number | undefined;
  readonly terminationReason?: TerminationReason | undefined;
  readonly cleanupVerified?: boolean | undefined;
}

export class SessionTelemetry {
  constructor(private readonly sink: typeof auditLog = auditLog) {}

  record(event: TelemetryEvent): void {
    const payload = {
      operation: event.operation,
      ...(event.sessionId !== undefined
        ? { session: redactSessionId(event.sessionId) }
        : {}),
      durationMs: Math.max(0, Math.round(event.durationMs)),
      result: event.result,
      ...(event.state !== undefined ? { state: event.state } : {}),
      ...(event.transport !== undefined ? { transport: event.transport } : {}),
      ...(event.inputBytes !== undefined ? { inputBytes: event.inputBytes } : {}),
      ...(event.outputBytes !== undefined ? { outputBytes: event.outputBytes } : {}),
      ...(event.queueDepth !== undefined ? { queueDepth: event.queueDepth } : {}),
      ...(event.retryCount !== undefined ? { retryCount: event.retryCount } : {}),
      ...(event.terminationReason !== undefined
        ? { terminationReason: event.terminationReason }
        : {}),
      ...(event.cleanupVerified !== undefined
        ? { cleanupVerified: event.cleanupVerified }
        : {}),
    };
    void this.sink(AUDIT_EVENT, payload);
  }
}
