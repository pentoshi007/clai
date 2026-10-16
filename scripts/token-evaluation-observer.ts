import { performance } from "node:perf_hooks";
import type { CompletionRequest, GenerationAttemptInput, GenerationAttemptUsageSink, RequestFingerprintV1 } from "../src/types.js";
import type { EvaluationAttempt, EvaluationWire } from "./token-evaluation-metrics.js";

export class EvaluationObserver {
  readonly attempts: EvaluationAttempt[] = [];
  readonly wires: EvaluationWire[] = [];
  providerInvocations = 0;
  primaryInvocations = 0;
  auxiliaryInvocations = 0;
  assemblyMilliseconds = 0;
  private nextAttempt = 0;
  private currentPurpose: "turn" | "auxiliary" = "turn";

  noteRequest(request: CompletionRequest): void {
    this.providerInvocations += 1;
    this.currentPurpose = request.purpose === "compaction" || request.purpose === "auxiliary" ? "auxiliary" : "turn";
    if (this.currentPurpose === "auxiliary") this.auxiliaryInvocations += 1;
    else this.primaryInvocations += 1;
  }

  begin(input: GenerationAttemptInput, delegate: GenerationAttemptUsageSink): ReturnType<GenerationAttemptUsageSink["begin"]> {
    const started = performance.now();
    const ordinal = ++this.nextAttempt;
    const purpose = this.currentPurpose;
    const handle = delegate.begin(input);
    let settled = false;
    return { complete: (outcome, usage, statusCode) => {
      if (settled) return;
      settled = true;
      handle.complete(outcome, usage, statusCode);
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
    const generation = /\/(?:chat\/completions|responses|messages|api\/chat)(?:\?|$)|:(?:streamGenerateContent|generateContent)(?:\?|$)/.test(url);
    if (!generation) return options.fetch(input, init);
    if (this.wires.length >= options.maxCalls) throw new Error("Explicit evaluation generation-call budget exhausted");
    const fingerprintStart = performance.now();
    const fingerprint = options.fingerprint(init?.body) ?? null;
    this.assemblyMilliseconds += performance.now() - fingerprintStart;
    const ordinal = this.wires.length + 1;
    const started = performance.now();
    this.wires.push({ ordinal, fingerprint, elapsedMs: 0, statusCode: null });
    try {
      const response = await options.fetch(input, init);
      this.wires[ordinal - 1] = { ordinal, fingerprint, elapsedMs: performance.now() - started, statusCode: response.status };
      return response;
    } catch (error) {
      this.wires[ordinal - 1] = { ordinal, fingerprint, elapsedMs: performance.now() - started, statusCode: null };
      throw error;
    }
  }
}
