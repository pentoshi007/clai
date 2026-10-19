import { createHash } from "node:crypto";
import { freebuffCatalogHandle, freebuffCatalogSnapshot, refreshFreebuffCatalog } from "./freebuff-models.js";
import { ProviderError } from "./http.js";
import { settleWithin } from "../os/settle-within.js";
import {
  callFreebuffSession,
  freebuffSessionMetadata,
  FreebuffSessionRequestError,
  FreebuffSessionResponse,
  freebuffHeartbeatDelay,
  freebuffHeartbeatRetryDelay,
  newFreebuffCliInstanceId,
  type FreebuffSessionCallOptions,
} from "./freebuff-session-api.js";

export interface FreebuffAdmission {
  readonly instanceId: string;
  readonly model: string;
  readonly expiresAt: number | undefined;
  readonly metadata: Record<string, string>;
}

interface ActiveClaim {
  readonly instanceId: string;
  readonly model: string;
  readonly token: string;
  expiresAt: number | undefined;
  heartbeat: NodeJS.Timeout | undefined;
  consecutiveFailures: number;
}

type SessionDeps = Pick<FreebuffSessionCallOptions, "baseUrl" | "fetch">;

const SESSION_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  session_superseded: "This Freebuff session has ended. Start a new session to try again.",
  session_expired: "This Freebuff session has ended. Start a new session to try again.",
  session_model_mismatch: "The active Freebuff session is locked to another model. End it before switching.",
  session_limit_reached: "Your Freebuff concurrent-session limit is reached; end another session and retry.",
  waiting_room_required: "Freebuff is holding this model behind a waiting room right now; retry shortly.",
  waiting_room_queued: "Freebuff queued this request behind other users; retry shortly.",
  model_at_capacity: "This Freebuff model is at capacity right now; retry shortly or pick another model.",
  model_unavailable: "This Freebuff model is unavailable right now.",
};

function refusalMessage(response: FreebuffSessionResponse): string {
  switch (response.status) {
    case "consent_required":
      return `Freebuff needs explicit consent to spend ${response.walletConsent.walletSpend} wallet Freebucks (price ${response.walletConsent.price}). clai never spends automatically; start this model from the Freebuff CLI to confirm.`;
    case "first_tab_discount_changed":
      return "Freebuff pricing changed before admission. Retry to pick up the current price.";
    case "model_locked":
      return `Freebuff already has an active session on ${response.currentModel}; end it before switching to ${response.requestedModel}.`;
    case "model_unavailable":
      return response.withdrawn
        ? `Freebuff model ${response.requestedModel} is withdrawn from free mode.`
        : `Freebuff model ${response.requestedModel} is unavailable right now${response.availableHours ? ` (${response.availableHours})` : ""}.`;
    case "premium_slot_taken":
    case "purchase_in_use":
    case "purchase_capacity":
      return "Your Freebuff concurrent-session limit is reached; end another session and retry.";
    case "purchase_claim_released":
      return "This Freebuff session claim was released; retry to start a new session.";
    case "rate_limited":
      return "Freebuff free-session quota is exhausted for now; try again later.";
    case "spend_limited":
      return response.message ?? "Freebuff daily provider-spend budget reached; try again later.";
    case "ip_capped":
      return "Too many Freebuff free sessions on this network; try again shortly.";
    case "country_blocked":
      return `Freebuff free mode is not available in your country${response.countryCode ? ` (${response.countryCode})` : ""}.`;
    case "banned":
      return response.message ?? "This Freebuff account cannot start a session.";
    case "superseded":
      return "Another client took over this Freebuff session.";
    default:
      return `Freebuff admission returned status "${response.status}".`;
  }
}

function admissionStatusCode(response: FreebuffSessionResponse): number {
  switch (response.status) {
    case "rate_limited":
    case "spend_limited":
    case "ip_capped":
      return 429;
    case "country_blocked":
    case "banned":
      return 403;
    default:
      return 409;
  }
}

function expiryMs(response: Extract<FreebuffSessionResponse, { status: "active" }>): number | undefined {
  if (typeof response.remainingMs === "number") return Date.now() + response.remainingMs;
  if (response.expiresAt) {
    const parsed = Date.parse(response.expiresAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export class FreebuffSessionManager {
  private readonly claims = new Map<string, ActiveClaim>();
  private readonly inflight = new Map<string, Promise<FreebuffAdmission>>();
  private readonly generations = new Map<string, Promise<void>>();
  private closing = false;
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly deps: SessionDeps = {}) {}

  private scope(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  async withAdmission<T>(
    token: string,
    model: string,
    signal: AbortSignal | undefined,
    run: (admission: FreebuffAdmission) => Promise<T>,
  ): Promise<T> {
    if (this.closing) throw new ProviderError("Freebuff session manager is shutting down.");
    signal?.throwIfAborted();
    const key = this.scope(token);
    const previous = this.generations.get(key) ?? Promise.resolve();
    const result = previous.then(async () => {
      signal?.throwIfAborted();
      const admission = await this.ensureAdmission(token, model, signal);
      signal?.throwIfAborted();
      return run(admission);
    });
    const settled = result.then(() => {}, () => {}).finally(() => {
      if (this.generations.get(key) === settled) this.generations.delete(key);
    });
    this.generations.set(key, settled);
    return result;
  }

  async ensureAdmission(
    token: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<FreebuffAdmission> {
    if (this.closing) throw new ProviderError("Freebuff session manager is shutting down.");
    signal?.throwIfAborted();
    const key = this.scope(token);
    const existing = this.inflight.get(key);
    if (existing) {
      const admission = await existing;
      signal?.throwIfAborted();
      if (admission.model === model) return admission;
      return this.ensureAdmission(token, model, signal);
    }
    const claim = this.claims.get(key);
    if (claim?.model === model && (claim.expiresAt === undefined || claim.expiresAt > Date.now() + 5_000)) {
      return this.toAdmission(claim);
    }
    const attempt = this.claim(key, token, model, signal).finally(() => {
      if (this.inflight.get(key) === attempt) this.inflight.delete(key);
    });
    this.inflight.set(key, attempt);
    return attempt;
  }

  private catalog(token: string): { fetchId?: string | undefined } | undefined {
    const snapshot = freebuffCatalogSnapshot(token);
    return snapshot ? { fetchId: snapshot.fetchId } : undefined;
  }

  private admit(
    token: string,
    instanceId: string,
    model: string,
    signal: AbortSignal | undefined,
  ): Promise<FreebuffSessionResponse> {
    const catalog = this.catalog(token);
    return callFreebuffSession("POST", token, {
      ...this.deps,
      instanceId,
      model: freebuffCatalogHandle(token, model) ?? model,
      ...(catalog ? { catalog } : {}),
      signal,
    });
  }

  private admissionError(error: unknown): unknown {
    if (!(error instanceof FreebuffSessionRequestError)) return error;
    const detail = (error.errorCode ? SESSION_ERROR_MESSAGES[error.errorCode] : undefined) ?? error.message;
    return new ProviderError(
      `Freebuff session admission failed (${error.statusCode}). ${detail}`,
      error.statusCode,
      undefined,
      error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1_000) : undefined,
    );
  }

  private async releaseAttempt(token: string, instanceId: string, signal?: AbortSignal): Promise<void> {
    const catalog = this.catalog(token);
    await callFreebuffSession("DELETE", token, {
      ...this.deps,
      instanceId,
      ...(catalog ? { catalog } : {}),
      ...(signal ? { signal } : {}),
    }).catch(() => undefined);
  }

  private async claim(
    key: string,
    token: string,
    model: string,
    signal: AbortSignal | undefined,
  ): Promise<FreebuffAdmission> {
    if (this.closing) throw new ProviderError("Freebuff session manager is shutting down.");
    await this.releaseKey(key, token).catch(() => undefined);
    if (this.closing) throw new ProviderError("Freebuff session manager is shutting down.");
    const instanceId = newFreebuffCliInstanceId();
    let response: FreebuffSessionResponse;
    try {
      response = await this.admit(token, instanceId, model, signal);
    } catch (error) {
      if (error instanceof FreebuffSessionRequestError && error.errorCode === "freebuff_catalog_stale") {
        await refreshFreebuffCatalog(token, signal, this.deps).catch(() => null);
        response = await this.admit(token, instanceId, model, signal).catch(async (retryError: unknown) => {
          await this.releaseAttempt(token, instanceId, signal);
          throw this.admissionError(retryError);
        });
      } else if (error instanceof FreebuffSessionRequestError && error.errorCode === "session_superseded") {
        response = await this.admit(token, instanceId, model, signal).catch(async (retryError: unknown) => {
          await this.releaseAttempt(token, instanceId, signal);
          throw this.admissionError(retryError);
        });
      } else {
        await this.releaseAttempt(token, instanceId, signal);
        throw this.admissionError(error);
      }
    }
    if (response.status !== "active") {
      await this.releaseAttempt(token, instanceId, signal);
      throw new ProviderError(refusalMessage(response), admissionStatusCode(response));
    }
    const activeInstance = response.instanceId || instanceId;
    const claim: ActiveClaim = {
      instanceId: activeInstance,
      model,
      token,
      expiresAt: expiryMs(response),
      heartbeat: undefined,
      consecutiveFailures: 0,
    };
    this.claims.set(key, claim);
    this.scheduleHeartbeat(key, token, claim);
    return this.toAdmission(claim);
  }

  private toAdmission(claim: ActiveClaim): FreebuffAdmission {
    return {
      instanceId: claim.instanceId,
      model: claim.model,
      expiresAt: claim.expiresAt,
      metadata: freebuffSessionMetadata(claim.instanceId),
    };
  }

  private scheduleHeartbeat(key: string, token: string, claim: ActiveClaim, delay = freebuffHeartbeatDelay(claim.expiresAt)): void {
    if (claim.heartbeat) clearTimeout(claim.heartbeat);
    const timer = setTimeout(() => {
      claim.heartbeat = undefined;
      void this.beat(key, token, claim);
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
    claim.heartbeat = timer;
  }

  private async beat(key: string, token: string, claim: ActiveClaim): Promise<void> {
    if (this.claims.get(key) !== claim) return;
    try {
      const catalog = this.catalog(token);
      const response = await callFreebuffSession("GET", token, {
        ...this.deps,
        instanceId: claim.instanceId,
        heartbeat: true,
        compact: true,
        ...(catalog ? { catalog } : {}),
      });
      if (this.claims.get(key) !== claim) return;
      if (response.status === "active") {
        claim.expiresAt = expiryMs(response);
        claim.consecutiveFailures = 0;
        this.scheduleHeartbeat(key, token, claim);
        return;
      }
      this.clearClaim(key, claim);
    } catch (error) {
      if (this.claims.get(key) !== claim) return;
      claim.consecutiveFailures += 1;
      const retryAfter = error instanceof FreebuffSessionRequestError ? error.retryAfterMs : undefined;
      this.scheduleHeartbeat(key, token, claim, freebuffHeartbeatRetryDelay(claim.consecutiveFailures, retryAfter));
    }
  }

  private clearClaim(key: string, claim: ActiveClaim): void {
    if (claim.heartbeat) clearTimeout(claim.heartbeat);
    claim.heartbeat = undefined;
    if (this.claims.get(key) === claim) this.claims.delete(key);
  }

  private async releaseKey(key: string, token: string, signal?: AbortSignal): Promise<void> {
    const claim = this.claims.get(key);
    if (!claim) return;
    this.clearClaim(key, claim);
    const catalog = this.catalog(token);
    await callFreebuffSession("DELETE", token, {
      ...this.deps,
      instanceId: claim.instanceId,
      ...(catalog ? { catalog } : {}),
      ...(signal ? { signal } : {}),
    }).catch(() => undefined);
  }

  async release(token: string, model?: string, signal?: AbortSignal): Promise<void> {
    const key = this.scope(token);
    await this.generations.get(key);
    await this.inflight.get(key)?.catch(() => undefined);
    if (model && this.claims.get(key)?.model !== model) return;
    await this.releaseKey(key, token, signal);
  }

  discard(token: string, model?: string): boolean {
    const key = this.scope(token);
    const claim = this.claims.get(key);
    if (!claim) return false;
    if (model && claim.model !== model) return false;
    this.clearClaim(key, claim);
    const catalog = this.catalog(token);
    void callFreebuffSession("DELETE", token, {
      ...this.deps,
      instanceId: claim.instanceId,
      ...(catalog ? { catalog } : {}),
    }).catch(() => undefined);
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.closing = true;
    this.disposePromise = (async () => {
      await Promise.all([...this.generations.values()]);
      await Promise.all([...this.inflight.values()].map((request) => request.catch(() => undefined)));
      const claims = [...this.claims.values()];
      this.claims.clear();
      this.inflight.clear();
      await Promise.all(
        claims.map(async (claim) => {
          if (claim.heartbeat) clearTimeout(claim.heartbeat);
          const catalog = this.catalog(claim.token);
          await callFreebuffSession("DELETE", claim.token, {
            ...this.deps,
            instanceId: claim.instanceId,
            ...(catalog ? { catalog } : {}),
          }).catch(() => undefined);
        }),
      );
    })();
    return this.disposePromise;
  }

  hasActiveClaim(token: string, model: string): boolean {
    return this.claims.get(this.scope(token))?.model === model;
  }
}

let sharedManager: FreebuffSessionManager | undefined;

export function freebuffSessionManager(): FreebuffSessionManager {
  if (!sharedManager) sharedManager = new FreebuffSessionManager();
  return sharedManager;
}

export async function disposeFreebuffSessionManager(): Promise<void> {
  const manager = sharedManager;
  if (!manager) return;
  await manager.dispose();
  if (sharedManager === manager) sharedManager = undefined;
}

export const FREEBUFF_SHUTDOWN_BUDGET_MS = 1_000;

export async function runFreebuffSessionShutdownCleanup(
  runEpilogue?: () => void | Promise<void>,
  budgetMs = FREEBUFF_SHUTDOWN_BUDGET_MS,
): Promise<void> {
  try {
    await settleWithin(disposeFreebuffSessionManager(), budgetMs);
  } finally {
    await runEpilogue?.();
  }
}
