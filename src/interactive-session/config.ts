
import {
  throwSessionError,
  type SessionOperation,
  type TerminalDimensions,
} from "./types.js";

export interface InteractiveSessionConfig {
  enabled: boolean;
  liveSessionLimit: number;
  quietIntervalMs: number;
  startDeadlineMs: number;
  sendDeadlineMs: number;
  closeDeadlineMs: number;
  gracefulCloseMs: number;
  pageBytes: number;
  memoryWindowBytes: number;
  queuedInputBytes: number;
  artifactCaptureBytes: number;
  artifactChunkBytes: number;
  persistenceQueueBytes: number;
  idleTimeoutMs: number | undefined;
  lifetimeTimeoutMs: number | undefined;
  onOutputLimit: "terminate" | "continue";
  redactionOverlapBytes: number;
}

interface Range {
  readonly min: number;
  readonly max: number;
}

export const INTERACTIVE_SESSION_RANGES = {
  liveSessionLimit: { min: 1, max: 32 },
  quietIntervalMs: { min: 25, max: 5_000 },
  startDeadlineMs: { min: 100, max: 120_000 },
  sendDeadlineMs: { min: 100, max: 120_000 },
  closeDeadlineMs: { min: 100, max: 120_000 },
  gracefulCloseMs: { min: 0, max: 30_000 },
  pageBytes: { min: 1_024, max: 1_048_576 },
  memoryWindowBytes: { min: 65_536, max: 16_777_216 },
  queuedInputBytes: { min: 1_024, max: 1_048_576 },
  artifactCaptureBytes: { min: 1_048_576, max: 1_073_741_824 },
  artifactChunkBytes: { min: 65_536, max: 16_777_216 },
  persistenceQueueBytes: { min: 65_536, max: 16_777_216 },
  idleTimeoutMs: { min: 1_000, max: 86_400_000 },
  lifetimeTimeoutMs: { min: 1_000, max: 604_800_000 },
  redactionOverlapBytes: { min: 256, max: 65_536 },
} as const satisfies Record<string, Range>;

export type RangedConfigField = keyof typeof INTERACTIVE_SESSION_RANGES;

export const DIMENSION_RANGE: Range = { min: 2, max: 1_000 };
export const DEFAULT_DIMENSIONS: TerminalDimensions = { columns: 80, rows: 24 };
export const MAX_READ_WAIT_MS = 30_000;
export const MAX_LIST_SUMMARIES = 50;

export const INTERACTIVE_SESSION_DEFAULTS: InteractiveSessionConfig = {
  enabled: true,
  liveSessionLimit: 4,
  quietIntervalMs: 250,
  startDeadlineMs: 10_000,
  sendDeadlineMs: 30_000,
  closeDeadlineMs: 10_000,
  gracefulCloseMs: 2_000,
  pageBytes: 12_000,
  memoryWindowBytes: 1_048_576,
  queuedInputBytes: 65_536,
  artifactCaptureBytes: 67_108_864,
  artifactChunkBytes: 1_048_576,
  persistenceQueueBytes: 1_048_576,
  idleTimeoutMs: undefined,
  lifetimeTimeoutMs: undefined,
  onOutputLimit: "terminate",
  redactionOverlapBytes: 4_096,
};

export const KILL_SWITCH_ENV = "CLAI_DISABLE_INTERACTIVE_SESSIONS";

function envDisabled(): boolean {
  const raw = process.env[KILL_SWITCH_ENV];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function invalid(
  field: string,
  message: string,
  operation: SessionOperation,
): never {
  throwSessionError({
    code: "INVALID_CONFIGURATION",
    operation,
    message,
    details: { field },
  });
}

function checkRange(
  field: RangedConfigField,
  value: number,
  operation: SessionOperation,
): number {
  const { min, max } = INTERACTIVE_SESSION_RANGES[field];
  if (!Number.isInteger(value) || value < min || value > max) {
    invalid(
      field,
      `${field} must be an integer between ${min} and ${max}.`,
      operation,
    );
  }
  return value;
}

export type InteractiveSessionOverrides = Partial<InteractiveSessionConfig>;

export function resolveInteractiveSessionConfig(
  overrides: InteractiveSessionOverrides = {},
  operation: SessionOperation = "start",
): InteractiveSessionConfig {
  const merged = { ...INTERACTIVE_SESSION_DEFAULTS, ...overrides };
  for (const field of Object.keys(INTERACTIVE_SESSION_RANGES) as RangedConfigField[]) {
    const value = merged[field];
    if (value === undefined) continue;
    if (typeof value !== "number") {
      invalid(field, `${field} must be a number.`, operation);
    }
    checkRange(field, value, operation);
  }
  if (merged.artifactChunkBytes > merged.artifactCaptureBytes) {
    invalid(
      "artifactChunkBytes",
      "artifactChunkBytes cannot exceed artifactCaptureBytes.",
      operation,
    );
  }
  if (merged.onOutputLimit !== "terminate" && merged.onOutputLimit !== "continue") {
    invalid("onOutputLimit", "onOutputLimit must be terminate or continue.", operation);
  }
  return { ...merged, enabled: merged.enabled && !envDisabled() };
}

export function isInteractiveSessionsEnabled(
  config: InteractiveSessionConfig = resolveInteractiveSessionConfig(),
): boolean {
  return config.enabled;
}

export function resolveDeadline(
  field: "startDeadlineMs" | "sendDeadlineMs" | "closeDeadlineMs",
  override: number | undefined,
  config: InteractiveSessionConfig,
  operation: SessionOperation,
): number {
  if (override === undefined) return config[field];
  return checkRange(field, override, operation);
}

export function resolveQuietInterval(
  override: number | undefined,
  config: InteractiveSessionConfig,
  operation: SessionOperation,
): number {
  if (override === undefined) return config.quietIntervalMs;
  return checkRange("quietIntervalMs", override, operation);
}

export function resolveOptionalTimeout(
  field: "idleTimeoutMs" | "lifetimeTimeoutMs",
  override: number | undefined,
  config: InteractiveSessionConfig,
  operation: SessionOperation,
): number | undefined {
  if (override === undefined) return config[field];
  return checkRange(field, override, operation);
}

export function resolveDimensions(
  columns: number | undefined,
  rows: number | undefined,
  operation: SessionOperation,
): TerminalDimensions {
  const resolved = {
    columns: columns ?? DEFAULT_DIMENSIONS.columns,
    rows: rows ?? DEFAULT_DIMENSIONS.rows,
  };
  for (const [field, value] of Object.entries(resolved)) {
    if (
      !Number.isInteger(value) ||
      value < DIMENSION_RANGE.min ||
      value > DIMENSION_RANGE.max
    ) {
      throwSessionError({
        code: "INVALID_REQUEST",
        operation,
        message: `${field} must be an integer between ${DIMENSION_RANGE.min} and ${DIMENSION_RANGE.max}.`,
        details: { field },
      });
    }
  }
  return resolved;
}

export function clampReadWait(waitMs: number | undefined): number {
  if (waitMs === undefined) return 0;
  if (!Number.isFinite(waitMs) || waitMs < 0) return 0;
  return Math.min(Math.floor(waitMs), MAX_READ_WAIT_MS);
}
