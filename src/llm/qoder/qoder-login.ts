import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  exchangeQoderPersonalToken,
  importQoderCliCredential,
  parseQoderToken,
  pickString,
  qoderAuthHeaders,
  QoderAuthError,
  QODER_OPENAPI_ORIGIN,
  readQoderAuthResponse,
  readQoderMachineId,
  readQoderMachineIdentity,
  type QoderAuthRequestOptions,
  type QoderRefreshedToken,
} from "./qoder-auth.js";
import {
  qoderCredentialFromImport,
  signQoderCredential,
  type QoderCredential,
  type QoderMachineIdentity,
} from "./qoder-credential.js";

export const QODER_WEB_ORIGIN = "https://qoder.com";
export const QODER_PAT_URL = `${QODER_WEB_ORIGIN}/account/integrations`;
export const QODER_DEVICE_CLIENT_ID = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb";
export const QODER_UI_LOGIN_TIMEOUT_MS = 180_000;

export function canOpenQoderBrowser(env = process.env, platform = process.platform): boolean {
  if (env.CLAI_NO_BROWSER || env.CI || env.DEBIAN_FRONTEND === "noninteractive") return false;
  if (env.BROWSER === "none" || env.BROWSER === "www-browser") return false;
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
  return platform !== "linux" || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY || env.MIR_SOCKET);
}

async function localMachineId(claiHome: string): Promise<string> {
  const path = join(claiHome, "qoder-machine-id");
  try {
    const stored = (await readFile(path, "utf8")).trim();
    if (stored) return stored;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await mkdir(claiHome, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  try {
    await writeFile(path, id, { mode: 0o600, flag: "wx" });
    return id;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const stored = (await readFile(path, "utf8")).trim();
    if (!stored) throw new QoderAuthError("Qoder machine identity is empty. Remove ~/.clai/qoder-machine-id and retry.");
    return stored;
  }
}

export async function getQoderLoginIdentity(options: {
  qoderHome?: string | undefined;
  claiHome?: string | undefined;
} = {}): Promise<QoderMachineIdentity> {
  const [cliId, machine] = await Promise.all([
    readQoderMachineId(options.qoderHome),
    readQoderMachineIdentity(options.qoderHome),
  ]);
  return {
    machineId: cliId ?? await localMachineId(options.claiHome ?? join(homedir(), ".clai")),
    machineToken: machine?.machineToken ?? "",
    machineCode: machine?.machineCode,
    machineType: machine?.machineType,
  };
}

export interface QoderDeviceAuthStart {
  readonly authUrl: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly identity: QoderMachineIdentity;
}

export async function startQoderDeviceAuth(options: QoderAuthRequestOptions & {
  identity?: QoderMachineIdentity | undefined;
} = {}): Promise<QoderDeviceAuthStart> {
  options.signal?.throwIfAborted();
  const identity = options.identity ?? await getQoderLoginIdentity();
  options.signal?.throwIfAborted();
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const nonce = randomUUID();
  const params = new URLSearchParams({
    challenge,
    challenge_method: "S256",
    nonce,
    machine_id: identity.machineId,
    client_id: QODER_DEVICE_CLIENT_ID,
  });
  if (identity.machineToken) params.set("machine_token", identity.machineToken);
  return { authUrl: `${QODER_WEB_ORIGIN}/device/selectAccounts?${params}`, nonce, verifier, identity };
}

async function finishQoderLogin(
  tokens: QoderRefreshedToken,
  identity: QoderMachineIdentity,
  loginMethod: "browser" | "token",
  options: QoderAuthRequestOptions,
  personalAccessToken?: string,
): Promise<QoderCredential> {
  const timeout = AbortSignal.timeout(20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  signal.throwIfAborted();
  const response = await (options.fetcher ?? fetch)(`${QODER_OPENAPI_ORIGIN}/api/v1/userinfo`, {
    headers: { ...qoderAuthHeaders(), Authorization: `Bearer ${tokens.accessToken}` },
    signal,
  });
  const profile = await readQoderAuthResponse(response);
  const uid = pickString(profile, "id", "user_id", "uid");
  if (!uid) throw new QoderAuthError("Qoder profile did not include an account id.");
  const credential = await signQoderCredential({
    ...identity,
    uid,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expireTime: tokens.expiresAt !== undefined ? Math.floor(tokens.expiresAt / 1000) : undefined,
    refreshTokenExpireTime: tokens.refreshTokenExpiresAt !== undefined ? Math.floor(tokens.refreshTokenExpiresAt / 1000) : undefined,
    email: pickString(profile, "email"),
    name: pickString(profile, "name", "username", "user_name"),
    personalAccessToken,
    loginMethod,
    dataPolicyAgreed: profile.data_policy_agreed === true || profile.dataPolicyAgreed === true,
  });
  signal.throwIfAborted();
  return credential;
}

export async function pollQoderDeviceAuth(start: QoderDeviceAuthStart, options: QoderAuthRequestOptions & {
  timeoutMs?: number | undefined;
  intervalMs?: number | undefined;
} = {}): Promise<QoderCredential> {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? QODER_UI_LOGIN_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const params = new URLSearchParams({ nonce: start.nonce, verifier: start.verifier, challenge_method: "S256" });
  const url = `${QODER_OPENAPI_ORIGIN}/api/v1/deviceToken/poll?${params}`;
  let failures = 0;
  for (;;) {
    signal.throwIfAborted();
    let response: Response | undefined;
    try {
      response = await (options.fetcher ?? fetch)(url, {
        headers: qoderAuthHeaders(),
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      });
      failures = 0;
    } catch (error) {
      signal.throwIfAborted();
      if (++failures >= 3) throw error;
    }
    if (response && response.status !== 404) {
      const tokens = parseQoderToken(await readQoderAuthResponse(response));
      return finishQoderLogin(tokens, start.identity, "browser", { ...options, signal });
    }
    await response?.body?.cancel();
    await delay(options.intervalMs ?? 1000, undefined, { signal });
  }
}

export async function loginQoderWithPat(personalAccessToken: string, options: QoderAuthRequestOptions & {
  identity?: QoderMachineIdentity | undefined;
} = {}): Promise<QoderCredential> {
  const pat = personalAccessToken.trim();
  if (!pat) throw new QoderAuthError("A Qoder personal access token is required.");
  options.signal?.throwIfAborted();
  const identity = options.identity ?? await getQoderLoginIdentity();
  const tokens = await exchangeQoderPersonalToken({
    ...options,
    personalAccessToken: pat,
    machineId: identity.machineCode || identity.machineId,
    machineToken: identity.machineToken,
  });
  return finishQoderLogin(tokens, identity, "token", options, pat);
}

export async function importQoderAccount(): Promise<QoderCredential> {
  const imported = await importQoderCliCredential();
  const identity = await getQoderLoginIdentity();
  return qoderCredentialFromImport({ ...imported, ...identity });
}
