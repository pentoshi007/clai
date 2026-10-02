import type { ProviderAuth } from "./provider.js";
import { CHATGPT_SUBSCRIPTION_DISPLAY_NAME } from "./provider-identity.js";
import { ProviderError } from "./http.js";
import {
  accountIdFromIdToken,
  decodeCodexKey,
  expiresAtFromAccessToken,
  extractResidency,
  maybeRefreshCodexCredential,
} from "./codex-auth.js";
import { currentRequestPurpose } from "./request-purpose.js";
import { getProviderKeys, setProviderKeys } from "../store/keys.js";

const pendingRefreshes = new Map<string, Promise<string | undefined>>();

async function refreshKey(key: string): Promise<string | undefined> {
  const pending = pendingRefreshes.get(key);
  if (pending) return pending;
  const task = (async () => {
    const fresh = await maybeRefreshCodexCredential(key);
    if (fresh && fresh !== key) {
      await replaceCodexKey(key, fresh).catch(() => undefined);
    }
    return fresh;
  })();
  pendingRefreshes.set(key, task);
  try {
    return await task;
  } finally {
    pendingRefreshes.delete(key);
  }
}

function requireKey(auth: ProviderAuth): string {
  if (!auth.apiKey) {
    throw new Error(
      `${CHATGPT_SUBSCRIPTION_DISPLAY_NAME} authentication required. Run \`clai auth chatgpt\` (browser sign-in) or add a key with \`clai set chatgpt <token>\`.`,
    );
  }
  return auth.apiKey;
}

export function credentialFor(auth: ProviderAuth) {
  const key = requireKey(auth);
  const decoded = decodeCodexKey(key);
  if (decoded) return decoded;
  const accountId = accountIdFromIdToken(key);
  if (!accountId) {
    throw new Error(
      `${CHATGPT_SUBSCRIPTION_DISPLAY_NAME} credential is malformed. Run \`clai auth chatgpt\` to sign in again.`,
    );
  }
  return {
    accessToken: key,
    accountId,
    expiresAt: expiresAtFromAccessToken(key),
    residency: extractResidency(key),
  };
}

export async function withCodexCredential<T>(
  auth: ProviderAuth,
  run: (credential: ReturnType<typeof credentialFor>) => Promise<T>,
): Promise<T> {
  let key = requireKey(auth);
  let credential = credentialFor(auth);
  if (
    credential.refreshToken &&
    credential.expiresAt !== undefined &&
    credential.expiresAt <= Date.now() + 60_000
  ) {
    const fresh = await refreshKey(key).catch(() => undefined);
    if (fresh && fresh !== key) {
      key = fresh;
      credential = credentialFor({ ...auth, apiKey: fresh });
    }
  }
  try {
    return await run(credential);
  } catch (error) {
    const status = error instanceof ProviderError ? error.status : undefined;
    const purpose = currentRequestPurpose();
    const renewable =
      (status === 401 || status === 403) && (purpose === undefined || purpose === "turn");
    if (!renewable) throw error;
    const fresh = await refreshKey(key);
    if (!fresh || fresh === key) {
      if (!credential.refreshToken) {
        throw new ProviderError(
          `${CHATGPT_SUBSCRIPTION_DISPLAY_NAME} token expired and has no refresh token. Run \`clai auth chatgpt\` to sign in again.`,
          status ?? 401,
        );
      }
      throw error;
    }
    const renewed = credentialFor({ ...auth, apiKey: fresh });
    return run(renewed);
  }
}

async function replaceCodexKey(oldKey: string, newKey: string): Promise<void> {
  const multi = await getProviderKeys("codex");
  if (multi.source === "env") return;
  if (!multi.keys.some((slot) => slot.value === oldKey)) return;
  if (multi.keys.some((slot) => slot.value === newKey)) return;
  const values = multi.keys.map((slot) =>
    slot.value === oldKey ? newKey : slot.value,
  );
  const disabled = multi.keys
    .filter((slot) => slot.disabled === true)
    .map((slot) => (slot.value === oldKey ? newKey : slot.value));
  await setProviderKeys("codex", values, multi.activeIndex, disabled);
}
