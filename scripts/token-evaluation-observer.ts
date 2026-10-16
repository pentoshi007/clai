import { performance } from "node:perf_hooks";
import { evaluationFailure, type EvaluationFailure } from "./token-evaluation-failures.js";
import type { CompletionRequest, GenerationAttemptInput, GenerationAttemptUsageSink, RequestFingerprintV1 } from "../src/types.js";
import type { EvaluationAttempt, EvaluationWire } from "./token-evaluation-metrics.js";
import type { EvaluationCacheObservation } from "./token-evaluation-cache.js";

export class EvaluationObserver {
  readonly attempts: EvaluationAttempt[] = [];
  readonly wires: EvaluationWire[] = [];
  readonly cacheObservations: EvaluationCacheObservation[] = [];
  readonly failures: EvaluationFailure[] = [];
  private readonly successfulPurposes = new Set<"turn" | "auxiliary">();
  providerInvocations = 0;
  primaryInvocations = 0;
  auxiliaryInvocations = 0;
  assemblyMilliseconds = 0;
  private nextAttempt = 0;
  private unrecordedAdmissions = 0;
  private admissionPending = false;
  private currentPurpose: "turn" | "auxiliary" = "turn";
  private currentCacheLane: "turn" | "auxiliary" = "turn";

  constructor(private readonly maxCalls: number = Number.POSITIVE_INFINITY, private readonly sensitiveValues: readonly string[] = []) {}

  get generationAdmissions(): number {
    return this.nextAttempt + this.unrecordedAdmissions;
  }

  noteRequest(request: CompletionRequest): void {
    this.providerInvocations += 1;
    this.currentPurpose = request.purpose === "compaction" || request.purpose === "auxiliary" ? "auxiliary" : "turn";
    this.currentCacheLane = request.purpose === "auxiliary" ? "auxiliary" : "turn";
    if (this.currentPurpose === "auxiliary") this.auxiliaryInvocations += 1;
    else this.primaryInvocations += 1;
  }

  begin(input: GenerationAttemptInput, delegate: GenerationAttemptUsageSink): ReturnType<GenerationAttemptUsageSink["begin"]> {
    const started = performance.now();
    if (this.generationAdmissions >= this.maxCalls) throw new Error("Explicit evaluation generation-call budget exhausted");
    const ordinal = ++this.nextAttempt;
    this.admissionPending = true;
    const purpose = this.currentPurpose;
    const cacheLane = this.currentCacheLane;
    const temperature = this.successfulPurposes.has(cacheLane) ? "warm" : "cold";
    const handle = delegate.begin(input);
    let settled = false;
    return { complete: (outcome, usage, statusCode) => {
      if (settled) return;
      settled = true;
      this.admissionPending = false;
      handle.complete(outcome, usage, statusCode);
      if (outcome === "success") this.successfulPurposes.add(cacheLane);
      this.cacheObservations.push({ temperature, eligibility: "unknown", eligiblePrefixTokens: null,
        cachedInputTokens: usage?.cachedPromptTokens ?? null, cacheWriteTokens: usage?.cacheCreationTokens ?? null });
      this.attempts.push({ ordinal, purpose, route: { provider: input.provider, model: input.model, mode: input.mode, reason: input.reason },
        outcome, usage: usage ? structuredClone(usage) : null, elapsedMs: performance.now() - started,
        fingerprint: input.requestFingerprint ?? null, statusCode: statusCode ?? null });
    } };
  }

  async fetch(input: string | URL | Request, init: RequestInit | undefined, options: {
    readonly maxCalls: number;
    readonly fetch: typeof globalThis.fetch;
    readonly fingerprint: (body: BodyInit | null | undefined) => RequestFingerprintV1 | undefined;
  }): Promise<Response> {
    const url = input instanceof Request ? input.url : String(input);
    const generation = this.admissionPending || /\/(?:chat\/completions|responses|messages|api\/chat)(?:\?|$)|:(?:streamGenerateContent|generateContent)(?:\?|$)/.test(url);
    if (!generation) return options.fetch(input, init);
    if (!this.admissionPending) {
      if (this.generationAdmissions >= Math.min(this.maxCalls, options.maxCalls)) throw new Error("Explicit evaluation generation-call budget exhausted");
      this.unrecordedAdmissions += 1;
    }
    this.admissionPending = false;
    const fingerprintStart = performance.now();
    const fingerprint = options.fingerprint(init?.body) ?? null;
    this.assemblyMilliseconds += performance.now() - fingerprintStart;
    const ordinal = this.wires.length + 1;
    const started = performance.now();
    this.wires.push({ ordinal, fingerprint, elapsedMs: 0, statusCode: null });
    try {
      const response = await options.fetch(input, init);
      this.wires[ordinal - 1] = { ordinal, fingerprint, elapsedMs: performance.now() - started, statusCode: response.status };
      if (!response.ok) this.failures.push(await evaluationFailure(response, this.sensitiveValues));
      return response;
    } catch (error) {
      this.wires[ordinal - 1] = { ordinal, fingerprint, elapsedMs: performance.now() - started, statusCode: null };
      throw error;
    }
  }
}
