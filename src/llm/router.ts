import type {
  CompletionRequest,
  CompletionResult,
  ProviderId,
  SuccessfulRequestSnapshot,
  ToolCallStreamDelta,
} from "../types.js";
import {
  getConfig,
  providerUsesEndpoints,
  setDefaultProvider,
  setProviderModel,
} from "../store/config.js";
import { getProviderKeys } from "../store/keys.js";
import { streamAlreadyEmitted, streamEmittedBytes } from "./stream-progress.js";
import {
  isSemanticStreamOutputEvent,
  type ProviderStreamEvent,
  type ProviderStreamEventSink,
} from "./stream-events.js";
import { isKeyCircleStopError, type ProviderKeyEvent } from "./key-rotation.js";
import type { ProviderAuth } from "./provider.js";
import {
  OperationUsageRecorder,
  type OperationUsageSnapshot,
} from "./operation-usage.js";
import {
  isOperationPolicyError,
  OperationLedger,
  operationTerminalOutcome,
  turnOperationPolicy,
} from "./operation-ledger.js";
import { effortCandidatesFor } from "./routing/error-classification.js";
import {
  ProviderFailure,
  aggregateProviderError,
  failureMessageFor,
  formatFailures,
  shouldStopProviderFallback,
} from "./routing/failure-report.js";
import {
  buildFallbackChain,
  getProvider,
  providerAuth,
  requestedRealKeyCount,
} from "./routing/provider-selection.js";
import { requestForRoute } from "./routing/attempt-request.js";
import { makeKeyEmitter, runWithKeyRotation } from "./routing/key-rotation.js";
export { providers } from "./routing/provider-selection.js";
export { buildFallbackChain, getProvider, providerAuth };
export {
  AggregateProviderError,
  formatProviderFailureForUser,
} from "./routing/failure-report.js";
export { isEmptyCompletionError } from "./routing/error-classification.js";
export { effortCandidatesFor };

export const API_KEY_TOAST_KEY = "api-key-rotation";

export type ProviderKeyEventHandler = (event: ProviderKeyEvent) => void;

export interface StreamWithProviderOptions {
  readonly onStatus?: ((message: string) => void) | undefined;
  readonly onKeyEvent?: ProviderKeyEventHandler | undefined;
  readonly onStreamEvent?: ProviderStreamEventSink | undefined;
  readonly attemptUsage?: OperationUsageRecorder | undefined;
  readonly operation?: OperationLedger | undefined;
  readonly adoptFallback?: boolean | undefined;
  readonly onOperationUsage?:
    ((snapshot: OperationUsageSnapshot) => void) | undefined;
  readonly maxRetries?: number | undefined;
  readonly singleDispatch?: boolean | undefined;
  readonly onSuccessfulRequest?:
    ((snapshot: SuccessfulRequestSnapshot) => void) | undefined;
}

function resolveOperationLedger(
  options: StreamWithProviderOptions,
): OperationLedger {
  if (options.operation) return options.operation;
  return new OperationLedger(
    turnOperationPolicy(),
    options.attemptUsage ?? new OperationUsageRecorder(),
  );
}

async function completeWithProviderOperation(
  request: CompletionRequest,
  options: StreamWithProviderOptions,
  ledger: OperationLedger,
): Promise<CompletionResult> {
  const config = getConfig();
  const singleDispatch = options.singleDispatch === true;
  const requested = request.provider ?? config.defaultProvider;
  const providerImpl = getProvider(requested);
  const isDefaultModel =
    !request.model || request.model === providerImpl.defaultModel;
  const fallbackEnabled =
    !singleDispatch &&
    config.providerFallback &&
    (await requestedRealKeyCount(requested)) !== 1 &&
    (isDefaultModel || request.allowModelFallback === true);
  const order = singleDispatch
    ? [requested]
    : buildFallbackChain(
        requested,
        config.freeOnly,
        fallbackEnabled,
        request.preferModelFallback === true,
      );
  const failures: ProviderFailure[] = [];
  const emitKey = makeKeyEmitter(options?.onStatus, options?.onKeyEvent);

  for (const providerId of order) {
    request.signal?.throwIfAborted();
    const provider = getProvider(providerId);
    const multi = await getProviderKeys(providerId);
    const hasAuth = multi.keys.length > 0;
    if (!hasAuth) {
      failures.push({ provider: providerId, message: "no API key configured" });
      continue;
    }

    const model =
      providerId === requested
        ? (request.model ?? provider.defaultModel)
        : provider.defaultModel;
    const routeRequest: CompletionRequest = {
      ...requestForRoute(request, providerId, model),
      attemptUsage: ledger,
    };

    try {
      const result = await runWithKeyRotation<CompletionResult>({
        providerId,
        provider,
        request: routeRequest,
        model,
        emitKey,
        mode: "complete",
        initialAttemptReason: providerId === requested ? "initial" : "fallback",
        ...(options?.onStatus ? { onStatus: options.onStatus } : {}),
        ...(options?.maxRetries !== undefined
          ? { maxRetries: options.maxRetries }
          : {}),
        ...(singleDispatch ? { singleDispatch: true } : {}),
      });
      if (providerId !== requested) {
        if (options?.adoptFallback === true) {
          setDefaultProvider(providerId);
          setProviderModel(providerId, result.model || model);
        }
        options?.onStatus?.(
          `switching to ${providerId}/${result.model || model} after ${requested} failed`,
        );
      }
      return result;
    } catch (error) {
      if (isOperationPolicyError(error)) {
        if (failures.length === 0) throw error;
        throw aggregateProviderError(
          `No provider could complete the request.${formatFailures(failures)}`,
          failures,
        );
      }
      failures.push({
        provider: providerId,
        message: failureMessageFor(providerId, error),
        error,
      });
      if (isKeyCircleStopError(error) || shouldStopProviderFallback(error)) {
        throw aggregateProviderError(
          `No provider could complete the request.${formatFailures(failures)}`,
          failures,
        );
      }
    }
  }

  throw aggregateProviderError(
    `No provider could complete the request.${formatFailures(failures)}`,
    failures,
  );
}

function attachOperationUsageToError(
  error: unknown,
  snapshot: OperationUsageSnapshot,
): unknown {
  if (error && typeof error === "object" && Object.isExtensible(error)) {
    try {
      Object.defineProperty(error, "operationUsage", {
        configurable: true,
        enumerable: false,
        value: snapshot,
      });
      return error;
    } catch {}
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string" && error.trim()
        ? error
        : "Provider operation failed";
  const wrapped = new Error(message, { cause: error });
  Object.defineProperty(wrapped, "operationUsage", {
    configurable: true,
    enumerable: false,
    value: snapshot,
  });
  return wrapped;
}

export async function completeWithProvider(
  request: CompletionRequest,
  options: StreamWithProviderOptions = {},
): Promise<CompletionResult> {
  const ledger = resolveOperationLedger(options);
  try {
    const result = await completeWithProviderOperation(
      request,
      options,
      ledger,
    );
    ledger.settle("completed");
    return { ...result, operationUsage: ledger.snapshot() };
  } catch (error) {
    ledger.settle(operationTerminalOutcome(error, request.signal));
    throw attachOperationUsageToError(error, ledger.snapshot());
  } finally {
    options.onOperationUsage?.(ledger.snapshot());
  }
}

async function streamWithProviderOperation(
  request: CompletionRequest,
  onToken: (token: string) => void,
  onStatusOrOptions?: ((message: string) => void) | StreamWithProviderOptions,
  ledger?: OperationLedger,
): Promise<CompletionResult> {
  const options: StreamWithProviderOptions =
    typeof onStatusOrOptions === "function"
      ? { onStatus: onStatusOrOptions }
      : (onStatusOrOptions ?? {});
  const operation = ledger ?? resolveOperationLedger(options);
  const relayToken = (token: string): void => {
    operation.noteSemanticOutput();
    onToken(token);
  };
  const downstreamToolDelta = request.onToolCallDelta;

  const config = getConfig();
  const singleDispatch = options.singleDispatch === true;
  const requested = request.provider ?? config.defaultProvider;
  const providerImpl = getProvider(requested);
  const isDefaultModel =
    !request.model || request.model === providerImpl.defaultModel;
  const fallbackEnabled =
    !singleDispatch &&
    config.providerFallback &&
    (await requestedRealKeyCount(requested)) !== 1 &&
    (isDefaultModel || request.allowModelFallback === true);
  const order = singleDispatch
    ? [requested]
    : buildFallbackChain(
        requested,
        config.freeOnly,
        fallbackEnabled,
        request.preferModelFallback === true,
      );
  const failures: ProviderFailure[] = [];
  const emitStatus = options.onStatus ?? ((message) => onToken(message));
  const emitKey = makeKeyEmitter(emitStatus, options.onKeyEvent);

  for (const providerId of order) {
    request.signal?.throwIfAborted();
    const provider = getProvider(providerId);
    const multi = await getProviderKeys(providerId);
    if (multi.keys.length === 0) {
      failures.push({ provider: providerId, message: "no API key configured" });
      continue;
    }

    const model =
      providerId === requested
        ? (request.model ?? provider.defaultModel)
        : provider.defaultModel;
    const routeRequest: CompletionRequest = {
      ...requestForRoute(request, providerId, model),
      attemptUsage: operation,
      ...(downstreamToolDelta
        ? {
            onToolCallDelta: (delta: ToolCallStreamDelta): void => {
              operation.noteSemanticOutput();
              downstreamToolDelta(delta);
            },
          }
        : {}),
      ...(options.onStreamEvent
        ? {
            onStreamEvent: (event: ProviderStreamEvent): void => {
              if (isSemanticStreamOutputEvent(event)) {
                operation.noteSemanticOutput();
              }
              options.onStreamEvent!(event);
            },
          }
        : {}),
    };

    try {
      const result = await runWithKeyRotation<CompletionResult>({
        providerId,
        provider,
        request: routeRequest,
        model,
        emitKey,
        mode: "stream",
        initialAttemptReason: providerId === requested ? "initial" : "fallback",
        onToken: relayToken,
        onStatus: emitStatus,
        ...(options.maxRetries !== undefined
          ? { maxRetries: options.maxRetries }
          : {}),
        ...(singleDispatch ? { singleDispatch: true } : {}),
        ...(options.onSuccessfulRequest
          ? { onSuccessfulRequest: options.onSuccessfulRequest }
          : {}),
      });
      if (providerId !== requested) {
        if (options.adoptFallback === true) {
          setDefaultProvider(providerId);
          setProviderModel(providerId, result.model || model);
        }
        options.onStatus?.(
          `switching to ${providerId}/${result.model || model} after ${requested} failed`,
        );
      }
      return result;
    } catch (error) {
      if (isOperationPolicyError(error)) {
        if (failures.length === 0) throw error;
        throw aggregateProviderError(
          `No provider could stream the request.${formatFailures(failures)}`,
          failures,
          streamEmittedBytes(error),
        );
      }
      failures.push({
        provider: providerId,
        message: failureMessageFor(providerId, error),
        error,
      });
      if (
        isKeyCircleStopError(error) ||
        shouldStopProviderFallback(error) ||
        streamAlreadyEmitted(error)
      ) {
        throw aggregateProviderError(
          `No provider could stream the request.${formatFailures(failures)}`,
          failures,
          streamEmittedBytes(error),
        );
      }
    }
  }

  throw aggregateProviderError(
    `No provider could stream the request.${formatFailures(failures)}`,
    failures,
  );
}

export async function streamWithProvider(
  request: CompletionRequest,
  onToken: (token: string) => void,
  onStatusOrOptions?: ((message: string) => void) | StreamWithProviderOptions,
): Promise<CompletionResult> {
  const options: StreamWithProviderOptions =
    typeof onStatusOrOptions === "function"
      ? { onStatus: onStatusOrOptions }
      : (onStatusOrOptions ?? {});
  const ledger = resolveOperationLedger(options);
  try {
    const result = await streamWithProviderOperation(
      request,
      onToken,
      options,
      ledger,
    );
    ledger.settle("completed");
    return { ...result, operationUsage: ledger.snapshot() };
  } catch (error) {
    ledger.settle(operationTerminalOutcome(error, request.signal));
    throw attachOperationUsageToError(error, ledger.snapshot());
  } finally {
    options.onOperationUsage?.(ledger.snapshot());
  }
}

export async function pingProvider(
  providerId: ProviderId,
  secretOverride?: string,
): Promise<void> {
  const provider = getProvider(providerId);
  const resolved = await providerAuth(providerId);
  const auth: ProviderAuth =
    providerId === "ollama"
      ? { baseUrl: secretOverride ?? resolved.baseUrl }
      : providerUsesEndpoints(providerId)
        ? {
            apiKey: secretOverride ?? resolved.apiKey,
            ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
          }
        : { apiKey: secretOverride ?? resolved.apiKey };
  await provider.ping(auth);
}
