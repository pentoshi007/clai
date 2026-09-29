import { createHash } from "node:crypto";
import { ProviderError } from "./http.js";
import {
  callFreebuffSession,
  freebuffSessionMetadata,
  FreebuffSessionRequestError,
  FreebuffSessionResponse,
  FREEBUFF_HEARTBEAT_INTERVAL_MS,
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
}

type SessionDeps = Pick<FreebuffSessionCallOptions, "baseUrl" | "fetch">;

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
  private closing = false;
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly deps: SessionDeps = {}) {}

  private scope(token: string, model: string): string {
    return `${createHash("sha256").update(token).digest("hex").slice(0, 16)}:${model}`;
  }

  async ensureAdmission(
    token: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<FreebuffAdmission> {
    if (this.closing) throw new ProviderError("Freebuff session manager is shutting down.");
    const key = this.scope(token, model);
    const claim = this.claims.get(key);
    if (claim && (claim.expiresAt === undefined || claim.expiresAt > Date.now() + 5_000)) {
      return this.toAdmission(claim);
    }
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const attempt = this.claim(key, token, model, signal).finally(() => {
      if (this.inflight.get(key) === attempt) this.inflight.delete(key);
    });
    this.inflight.set(key, attempt);
    return attempt;
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
      response = await callFreebuffSession("POST", token, {
        ...this.deps,
        instanceId,
        model,
        walletSpendLimit: 0,
        signal,
      });
    } catch (error) {
      if (error instanceof FreebuffSessionRequestError && error.errorCode === "session_superseded") {
        response = await callFreebuffSession("POST", token, {
          ...this.deps,
          instanceId,
          model,
          walletSpendLimit: 0,
          signal,
        }).catch((retryError: unknown) => {
          if (retryError instanceof FreebuffSessionRequestError) {
            throw new ProviderError(
              `Freebuff session admission failed (${retryError.statusCode}). ${retryError.message}`,
              retryError.statusCode,
              undefined,
              retryError.retryAfterMs ? Math.ceil(retryError.retryAfterMs / 1_000) : undefined,
            );
          }
          throw retryError;
        });
      } else {
        await callFreebuffSession("DELETE", token, {
          ...this.deps,
          instanceId,
        }).catch(() => undefined);
        if (error instanceof FreebuffSessionRequestError) {
          throw new ProviderError(
            `Freebuff session admission failed (${error.statusCode}). ${error.message}`,
            error.statusCode,
            undefined,
            error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1_000) : undefined,
          );
        }
        throw error;
      }
    }
    if (response.status !== "active") {
      throw new ProviderError(refusalMessage(response), admissionStatusCode(response));
    }
    const activeInstance = response.instanceId || instanceId;
    const claim: ActiveClaim = {
      instanceId: activeInstance,
      model,
      token,
      expiresAt: expiryMs(response),
      heartbeat: undefined,
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

  private scheduleHeartbeat(key: string, token: string, claim: ActiveClaim): void {
    if (claim.heartbeat) clearInterval(claim.heartbeat);
    const timer = setInterval(() => {
      void this.beat(key, token, claim);
    }, FREEBUFF_HEARTBEAT_INTERVAL_MS);
    if (typeof timer.unref === "function") timer.unref();
    claim.heartbeat = timer;
  }

  private async beat(key: string, token: string, claim: ActiveClaim): Promise<void> {
    if (this.claims.get(key) !== claim) return;
    try {
      const response = await callFreebuffSession("GET", token, {
        ...this.deps,
        instanceId: claim.instanceId,
        heartbeat: true,
        compact: true,
      });
      if (this.claims.get(key) !== claim) return;
      if (response.status === "active") {
        claim.expiresAt = expiryMs(response);
        return;
      }
      if (response.status === "superseded" || response.status === "none" || response.status === "ended") {
        this.clearClaim(key, claim);
      }
    } catch {
      return;
    }
  }

  private clearClaim(key: string, claim: ActiveClaim): void {
    if (claim.heartbeat) clearInterval(claim.heartbeat);
    claim.heartbeat = undefined;
    if (this.claims.get(key) === claim) this.claims.delete(key);
  }

  private async releaseKey(key: string, token: string, signal?: AbortSignal): Promise<void> {
    const claim = this.claims.get(key);
    if (!claim) return;
    this.clearClaim(key, claim);
    await callFreebuffSession("DELETE", token, {
      ...this.deps,
      instanceId: claim.instanceId,
      ...(signal ? { signal } : {}),
    }).catch(() => undefined);
  }

  async release(token: string, model?: string, signal?: AbortSignal): Promise<void> {
    if (model) {
      await this.releaseKey(this.scope(token, model), token, signal);
      return;
    }
    const prefix = `${createHash("sha256").update(token).digest("hex").slice(0, 16)}:`;
    await Promise.all(
      [...this.claims.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => this.releaseKey(key, token, signal)),
    );
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.closing = true;
    this.disposePromise = (async () => {
      await Promise.all([...this.inflight.values()].map((request) => request.catch(() => undefined)));
      const claims = [...this.claims.values()];
      this.claims.clear();
      this.inflight.clear();
      await Promise.all(
        claims.map(async (claim) => {
          if (claim.heartbeat) clearInterval(claim.heartbeat);
          await callFreebuffSession("DELETE", claim.token, {
            ...this.deps,
            instanceId: claim.instanceId,
          }).catch(() => undefined);
        }),
      );
    })();
    return this.disposePromise;
  }

  hasActiveClaim(token: string, model: string): boolean {
    return this.claims.has(this.scope(token, model));
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

export async function runFreebuffSessionShutdownCleanup(
  runEpilogue?: () => void | Promise<void>,
): Promise<void> {
  try {
    await disposeFreebuffSessionManager();
  } finally {
    await runEpilogue?.();
  }
}
