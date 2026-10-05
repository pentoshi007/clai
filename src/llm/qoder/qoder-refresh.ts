import { getProviderKeys, replaceProviderKey } from "../../store/keys.js";
import { ProviderError } from "../http.js";
import type { ProviderAuth } from "../provider.js";
import {
  exchangeQoderPersonalToken,
  expiryMilliseconds,
  QoderAuthError,
  refreshQoderDeviceToken,
} from "./qoder-auth.js";
import { withQoderAccountMutation } from "./qoder-accounts.js";
import {
  encodeQoderCredential,
  parseQoderCredential,
  qoderCredentialExpiry,
  qoderCredentialMetadata,
  signQoderCredential,
  type QoderCredential,
} from "./qoder-credential.js";

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const REFRESH_GRACE_MS = 30 * 1000;
class QoderCredentialStoreError extends Error {}

interface RefreshedQoderCredential {
  credential: QoderCredential;
  value: string;
}

const refreshesInFlight = new Map<string, Promise<RefreshedQoderCredential>>();
const rotatedCredentials = new Map<string, RefreshedQoderCredential>();

function rememberRotation(oldValue: string, fresh: RefreshedQoderCredential): void {
  rotatedCredentials.set(oldValue, fresh);
  while (rotatedCredentials.size > 128) {
    const oldest = rotatedCredentials.keys().next().value;
    if (oldest === undefined) break;
    rotatedCredentials.delete(oldest);
  }
}

function resolveCredential(value: string): RefreshedQoderCredential {
  let current = { credential: parseQoderCredential(value), value };
  for (let i = 0; i < 128; i++) {
    const rotated = rotatedCredentials.get(current.value);
    if (!rotated || rotated.value === current.value) break;
    current = rotated;
  }
  return current;
}

function updateAuth(auth: ProviderAuth, fresh: RefreshedQoderCredential): void {
  auth.apiKey = fresh.value;
  auth.refreshToken = fresh.credential.refreshToken;
  auth.expiresAt = qoderCredentialExpiry(fresh.credential);
}

function renewable(credential: QoderCredential, auth: ProviderAuth): boolean {
  return Boolean(credential.personalAccessToken || credential.refreshToken || auth.refreshToken);
}

function isAuthFailure(error: unknown): boolean {
  if (error instanceof ProviderError) {
    return error.status === 401 || (error.status === 403 && /expired|invalid|unauthorized/i.test(error.message));
  }
  return error instanceof QoderAuthError && error.status === 401;
}

async function persistCredential(oldValue: string, fresh: RefreshedQoderCredential): Promise<void> {
  try {
    await withQoderAccountMutation(async () => {
      if (await replaceProviderKey("qoder", oldValue, fresh.value, qoderCredentialMetadata(fresh.credential))) return;
      const keys = await getProviderKeys("qoder");
      if (keys.source === "env" || keys.keys.some((key) => key.value === fresh.value)) return;
      throw new QoderCredentialStoreError("Qoder refreshed its credentials, but the matching clai account could not be found to save them.");
    });
  } catch (error) {
    if (error instanceof QoderCredentialStoreError) throw error;
    throw new QoderCredentialStoreError("Qoder refreshed its credentials, but clai could not save the rotated tokens. Sign in again through /set qoder.");
  }
  rememberRotation(oldValue, fresh);
}

async function rotateCredential(credential: QoderCredential, auth: ProviderAuth): Promise<QoderCredential> {
  const refreshToken = credential.refreshToken ?? auth.refreshToken;
  const refreshExpiresAt = expiryMilliseconds(credential.refreshTokenExpireTime);
  if (!credential.personalAccessToken && refreshExpiresAt !== undefined && refreshExpiresAt <= Date.now()) {
    throw new QoderAuthError("Qoder refresh token has expired. Sign in again through /set qoder.", 401);
  }
  const options = {
    machineId: credential.machineId,
    machineType: credential.machineType,
    machineCode: credential.machineCode,
    loginMethod: credential.loginMethod,
  };
  let result;
  if (credential.personalAccessToken) {
    result = await exchangeQoderPersonalToken({
      personalAccessToken: credential.personalAccessToken,
      machineId: credential.machineCode || credential.machineId,
      machineToken: credential.machineToken,
    });
  } else {
    if (!refreshToken) throw new ProviderError("Qoder access token expired and no refresh token is available; sign in again through /set qoder.", 401);
    result = await refreshQoderDeviceToken({ ...options, refreshToken });
  }
  return signQoderCredential({
    ...credential,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken ?? refreshToken,
    ...(result.expiresAt !== undefined ? { expireTime: Math.floor(result.expiresAt / 1000) } : {}),
    ...(result.refreshTokenExpiresAt !== undefined ? { refreshTokenExpireTime: Math.floor(result.refreshTokenExpiresAt / 1000) } : {}),
  });
}

async function refreshCredential(current: RefreshedQoderCredential, auth: ProviderAuth): Promise<RefreshedQoderCredential> {
  const identity = current.credential.personalAccessToken ?? current.credential.refreshToken ?? auth.refreshToken ?? current.value;
  let refresh = refreshesInFlight.get(identity);
  if (!refresh) {
    refresh = (async () => {
      const credential = await rotateCredential(current.credential, auth);
      const fresh = { credential, value: encodeQoderCredential(credential) };
      await persistCredential(current.value, fresh);
      return fresh;
    })();
    refreshesInFlight.set(identity, refresh);
  }
  try {
    const fresh = await refresh;
    updateAuth(auth, fresh);
    return fresh;
  } finally {
    if (refreshesInFlight.get(identity) === refresh) refreshesInFlight.delete(identity);
  }
}

export async function refreshQoderAccount(slotId: string): Promise<QoderCredential> {
  const keys = await getProviderKeys("qoder");
  const slot = keys.source === "env" ? undefined : keys.keys.find((key) => key.id === slotId);
  if (!slot) throw new QoderAuthError("Qoder account was not found.");
  const current = resolveCredential(slot.value);
  const auth: ProviderAuth = { apiKey: current.value, refreshToken: slot.refreshToken, expiresAt: slot.expiresAt };
  return (await refreshCredential(current, auth)).credential;
}

export async function withQoderCredential<T>(
  auth: ProviderAuth,
  run: (credential: QoderCredential) => Promise<T>,
  onStatus?: ((message: string) => void) | undefined,
  canRetry: () => boolean = () => true,
): Promise<T> {
  if (typeof auth.apiKey !== "string") throw new QoderAuthError("Qoder authentication required. Sign in through /provider qoder.");
  let current = resolveCredential(auth.apiKey);
  if (current.value !== auth.apiKey) updateAuth(auth, current);
  const expiresAt = qoderCredentialExpiry(current.credential, auth);
  if (renewable(current.credential, auth) && expiresAt !== undefined && expiresAt <= Date.now() + REFRESH_BUFFER_MS) {
    onStatus?.("ℹ Qoder authentication expiring — refreshing token");
    try {
      current = await refreshCredential(current, auth);
      onStatus?.("ℹ Qoder token refreshed");
    } catch (error) {
      if (error instanceof QoderCredentialStoreError) throw error;
      if (error instanceof QoderAuthError && error.status && [400, 401, 403].includes(error.status)) throw error;
      if (expiresAt - Date.now() <= REFRESH_GRACE_MS) throw error;
      onStatus?.("ℹ Qoder refresh temporarily failed; using the current token until it expires");
    }
  } else if (!renewable(current.credential, auth) && expiresAt !== undefined && expiresAt <= Date.now()) {
    throw new ProviderError("Qoder access token expired and no refresh token is available; sign in again through /set qoder.", 401);
  }
  try {
    return await run(current.credential);
  } catch (error) {
    if (!isAuthFailure(error) || !renewable(current.credential, auth) || !canRetry()) throw error;
    onStatus?.("ℹ Qoder authentication rejected — refreshing token");
    const fresh = await refreshCredential(current, auth);
    onStatus?.("ℹ Qoder token refreshed — retrying request");
    return run(fresh.credential);
  }
}
