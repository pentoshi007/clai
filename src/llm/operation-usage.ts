import { AsyncLocalStorage } from "node:async_hooks";

import type {
  CompletionRequest,
  CompletionResult,
  GenerationAttemptHandle,
  GenerationAttemptInput,
  GenerationAttemptOutcome,
  GenerationAttemptUsageSink,
  RequestFingerprintV1,
  TokenUsage,
} from "../types.js";
import { fingerprintFinalRequest } from "./request-fingerprint.js";
import { sessionCacheAffinityKey } from "./cache-affinity.js";
import { currentSessionAffinity } from "./session-affinity.js";

export type AttemptUsageValue =
  | { readonly kind: "known"; readonly value: TokenUsage }
  | { readonly kind: "unknown" };

export interface GenerationAttemptRecord extends GenerationAttemptInput {
  readonly sequence: number;
  readonly outcome: GenerationAttemptOutcome;
  readonly usage: AttemptUsageValue;
  readonly statusCode?: number | undefined;
}

export interface OperationUsageAggregate {
  readonly status: "known" | "partial" | "unknown";
  readonly knownAdmissions: number;
  readonly unknownAdmissions: number;
  readonly usage?: TokenUsage | undefined;
}

export interface OperationUsageSnapshot {
  readonly attempts: readonly GenerationAttemptRecord[];
  readonly aggregate: OperationUsageAggregate;
}

function immutableUsage(usage: TokenUsage): TokenUsage {
  return Object.freeze({ ...usage });
}

function immutableRequestFingerprint(
  fingerprint: RequestFingerprintV1,
): RequestFingerprintV1 {
  return Object.freeze({
    ...fingerprint,
    serializer: Object.freeze({ ...fingerprint.serializer }),
    body: Object.freeze({ ...fingerprint.body }),
    sections: Object.freeze(
      fingerprint.sections.map((section) => Object.freeze({ ...section })),
    ),
    prefixes: Object.freeze(
      fingerprint.prefixes.map((prefix) => Object.freeze({ ...prefix })),
    ),
  });
}

function aggregateAttempts(
  attempts: readonly GenerationAttemptRecord[],
): OperationUsageAggregate {
  const known = attempts.filter(
    (attempt): attempt is GenerationAttemptRecord & {
      readonly usage: { readonly kind: "known"; readonly value: TokenUsage };
    } => attempt.usage.kind === "known",
  );
  const unknownAdmissions = attempts.length - known.length;
  if (known.length === 0) {
    return Object.freeze({
      status: "unknown" as const,
      knownAdmissions: 0,
      unknownAdmissions,
    });
  }

  const allAdmissionsKnown = unknownAdmissions === 0;
  const usage: TokenUsage = immutableUsage({
    promptTokens: known.reduce(
      (total, attempt) => total + attempt.usage.value.promptTokens,
      0,
    ),
    completionTokens: known.reduce(
      (total, attempt) => total + attempt.usage.value.completionTokens,
      0,
    ),
    totalTokens: known.reduce(
      (total, attempt) => total + attempt.usage.value.totalTokens,
      0,
    ),
    exact: known.every((attempt) => attempt.usage.value.exact),
    ...(allAdmissionsKnown &&
    known.every(
      (attempt) => attempt.usage.value.cachedPromptTokens !== undefined,
    )
      ? {
          cachedPromptTokens: known.reduce(
            (total, attempt) =>
              total + attempt.usage.value.cachedPromptTokens!,
            0,
          ),
        }
      : {}),
    ...(allAdmissionsKnown &&
    known.every(
      (attempt) => attempt.usage.value.cacheCreationTokens !== undefined,
    )
      ? {
          cacheCreationTokens: known.reduce(
            (total, attempt) =>
              total + attempt.usage.value.cacheCreationTokens!,
            0,
          ),
        }
      : {}),
    ...(allAdmissionsKnown &&
    known.every(
      (attempt) => attempt.usage.value.uncachedPromptTokens !== undefined,
    )
      ? {
          uncachedPromptTokens: known.reduce(
            (total, attempt) =>
              total + attempt.usage.value.uncachedPromptTokens!,
            0,
          ),
        }
      : {}),
    ...(allAdmissionsKnown &&
    known.every(
      (attempt) => attempt.usage.value.reasoningTokens !== undefined,
    )
      ? {
          reasoningTokens: known.reduce(
            (total, attempt) => total + attempt.usage.value.reasoningTokens!,
            0,
          ),
        }
      : {}),
    ...(known.some((attempt) => attempt.usage.value.reasoningObserved)
      ? { reasoningObserved: true }
      : {}),
  });

  return Object.freeze({
    status: unknownAdmissions === 0 ? ("known" as const) : ("partial" as const),
    knownAdmissions: known.length,
    unknownAdmissions,
    usage,
  });
}

function canonicalUsageFromError(error: unknown): TokenUsage | undefined {
  if (!error || typeof error !== "object" || !("usage" in error)) return undefined;
  const usage = (error as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const value = usage as Partial<TokenUsage>;
  if (
    typeof value.promptTokens !== "number" ||
    typeof value.completionTokens !== "number" ||
    typeof value.totalTokens !== "number" ||
    typeof value.exact !== "boolean"
  ) {
    return undefined;
  }
  return value as TokenUsage;
}

function statusCodeFromError(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  const status = Number((error as { status?: unknown }).status);
  return Number.isFinite(status) && status > 0 ? status : undefined;
}

function withSessionAffinityHeaders(
  init: RequestInit | undefined,
  sessionId: string,
): RequestInit {
  const headers = new Headers(init?.headers ?? undefined);
  if (!headers.has("x-clai-session")) headers.set("x-clai-session", sessionId);
  if (!headers.has("x-session-affinity")) {
    headers.set("x-session-affinity", sessionCacheAffinityKey(sessionId));
  }
  return { ...init, headers };
}

interface GenerationAttemptContext {
  readonly request: CompletionRequest;
  readonly input: GenerationAttemptInput;
  active?: GenerationAttemptHandle | undefined;
  admissions: number;
}

const generationAttemptContext = new AsyncLocalStorage<GenerationAttemptContext>();

function settleActiveAttempt(
  context: GenerationAttemptContext,
  outcome: GenerationAttemptOutcome,
  usage?: TokenUsage,
  statusCode?: number,
): void {
  context.active?.complete(outcome, usage, statusCode);
  context.active = undefined;
}

export function completeGenerationAttempt(
  outcome: GenerationAttemptOutcome,
  usage?: TokenUsage,
  statusCode?: number,
): void {
  const context = generationAttemptContext.getStore();
  if (!context) return;
  settleActiveAttempt(context, outcome, usage, statusCode);
}

export async function generationFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const affinity = currentSessionAffinity();
  if (affinity) init = withSessionAffinityHeaders(init, affinity);
  const context = generationAttemptContext.getStore();
  if (!context?.request.attemptUsage) return fetch(input, init);
  if (context.active) {
    throw new Error("generation admission started before the prior admission settled");
  }
  const reason =
    context.admissions === 0 ? context.input.reason : "provider-retry";
  const requestFingerprint = fingerprintFinalRequest(context.input, init?.body);
  context.admissions += 1;
  context.active = context.request.attemptUsage.begin({
    provider: context.input.provider,
    model: context.input.model,
    mode: context.input.mode,
    reason,
    ...(requestFingerprint ? { requestFingerprint } : {}),
  });
  try {
    const response = await fetch(input, init);
    if (!response.ok) {
      settleActiveAttempt(context, "failure", undefined, response.status);
    }
    return response;
  } catch (error) {
    settleActiveAttempt(
      context,
      context.request.signal?.aborted ? "cancelled" : "failure",
      canonicalUsageFromError(error),
      statusCodeFromError(error),
    );
    throw error;
  }
}

export async function runGenerationAttempt(
  request: CompletionRequest,
  input: GenerationAttemptInput,
  run: () => Promise<CompletionResult>,
): Promise<CompletionResult> {
  const context: GenerationAttemptContext = { request, input, admissions: 0 };
  return generationAttemptContext.run(context, async () => {
    try {
      const result = await run();
      settleActiveAttempt(context, "success", result.usage);
      return result;
    } catch (error) {
      settleActiveAttempt(
        context,
        request.signal?.aborted ? "cancelled" : "failure",
        canonicalUsageFromError(error),
        statusCodeFromError(error),
      );
      throw error;
    }
  });
}

export class OperationUsageRecorder implements GenerationAttemptUsageSink {
  private nextSequence = 1;
  private readonly records = new Map<number, GenerationAttemptRecord>();

  begin(input: GenerationAttemptInput): GenerationAttemptHandle {
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    let completed = false;
    return Object.freeze({
      complete: (
        outcome: GenerationAttemptOutcome,
        usage?: TokenUsage,
        statusCode?: number,
      ): void => {
        if (completed) return;
        completed = true;
        const { requestFingerprint, ...attemptInput } = input;
        const record: GenerationAttemptRecord = Object.freeze({
          ...attemptInput,
          ...(requestFingerprint
            ? { requestFingerprint: immutableRequestFingerprint(requestFingerprint) }
            : {}),
          sequence,
          outcome,
          usage: usage
            ? Object.freeze({ kind: "known" as const, value: immutableUsage(usage) })
            : Object.freeze({ kind: "unknown" as const }),
          ...(statusCode !== undefined ? { statusCode } : {}),
        });
        this.records.set(sequence, record);
      },
    });
  }

  snapshot(): OperationUsageSnapshot {
    const attempts = Object.freeze(
      [...this.records.values()].sort((left, right) => left.sequence - right.sequence),
    );
    return Object.freeze({ attempts, aggregate: aggregateAttempts(attempts) });
  }
}
