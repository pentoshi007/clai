import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { loadSignerModule } from "./qoder-signer.js";

export const QODER_CLI_VERSION = "1.1.65";
export const QODER_CLIENT_TYPE = "5";

export const QODER_OPENAPI_ORIGIN = "https://openapi.qoder.sh";
export const QODER_INFERENCE_ORIGIN = "https://api1.qoder.sh";

export function qoderConfigHome(): string {
  return process.env.QODER_CONFIG_DIR?.trim() || join(homedir(), ".qoder");
}

export interface QoderStoredUser {
  uid: string;
  name?: string | undefined;
  email?: string | undefined;
  accessToken: string;
  refreshToken?: string | undefined;
  expireTime?: number | undefined;
  refreshTokenExpireTime?: number | undefined;
  personalAccessToken?: string | undefined;
  loginMethod?: "browser" | "token" | "job_token" | undefined;
  encryptUserInfo?: string | undefined;
  key?: string | undefined;
  dataPolicyAgreed?: boolean | undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function pickString(
  source: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

async function readTrimmed(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, "utf8");
    const trimmed = text.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

export async function readQoderMachineId(
  home = qoderConfigHome(),
): Promise<string | undefined> {
  return readTrimmed(join(home, ".auth", "machine_id"));
}

export async function readQoderMachineIdentity(
  home = qoderConfigHome(),
): Promise<{
  machineToken: string;
  machineType: string;
  machineCode: string;
} | undefined> {
  const raw = await readTrimmed(join(home, "umid-cache.json"));
  if (!raw) return undefined;
  try {
    const parsed = asRecord(JSON.parse(raw));
    const info = asRecord(parsed?.info);
    const machineToken = pickString(info ?? {}, "machineToken");
    const machineType = pickString(info ?? {}, "machineType");
    const machineCode = pickString(info ?? {}, "machineCode");
    if (!machineToken) return undefined;
    return {
      machineToken,
      machineType: machineType ?? "",
      machineCode: machineCode ?? "",
    };
  } catch {
    return undefined;
  }
}

export class QoderAuthError extends Error {
  constructor(message: string, readonly status?: number | undefined) {
    super(message);
    this.name = "QoderAuthError";
  }
}

export interface QoderRefreshedToken {
  accessToken: string;
  refreshToken?: string | undefined;
  expiresAt?: number | undefined;
  refreshTokenExpiresAt?: number | undefined;
}

export function expiryMilliseconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 1e11 ? value : value * 1000;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1e11 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function tokenExpiry(absolute: unknown, relative: unknown): number | undefined {
  const timestamp = expiryMilliseconds(absolute);
  if (timestamp !== undefined) return timestamp;
  const seconds = typeof relative === "number" || typeof relative === "string" ? Number(relative) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : undefined;
}

export function parseQoderToken(payload: unknown): QoderRefreshedToken {
  const values = asRecord(payload) ?? {};
  const accessToken = pickString(values, "device_token", "token", "access_token");
  if (!accessToken) throw new QoderAuthError("Qoder response did not include an access token.");
  return {
    accessToken,
    refreshToken: pickString(values, "refresh_token", "refreshToken"),
    expiresAt: tokenExpiry(values.expires_at ?? values.expiresAt, values.expires_in ?? values.expiresIn),
    refreshTokenExpiresAt: tokenExpiry(
      values.refresh_token_expires_at ?? values.refreshTokenExpiresAt,
      values.refresh_token_expires_in ?? values.refreshTokenExpiresIn,
    ),
  };
}

export function qoderAuthHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Cosy-Version": QODER_CLI_VERSION,
    "Cosy-ClientType": QODER_CLIENT_TYPE,
    "Cosy-MachineOS": `${process.arch === "arm64" ? "aarch64" : process.arch}_${process.platform}`,
    "User-Agent": "Bun/1.4.2",
  };
}

export interface QoderAuthRequestOptions {
  signal?: AbortSignal | undefined;
  fetcher?: typeof fetch | undefined;
}

export async function readQoderAuthResponse(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  let payload: Record<string, unknown> | undefined;
  try {
    payload = asRecord(JSON.parse(raw));
  } catch {
    payload = undefined;
  }
  if (!response.ok || !payload) {
    const detail = pickString(payload ?? {}, "error_description", "errorMessage", "message", "errorCode");
    throw new QoderAuthError(
      `Qoder authentication failed (HTTP ${response.status}): ${detail ?? "unexpected response"}`,
      response.status,
    );
  }
  return payload;
}

async function requestQoderToken(
  path: string,
  body: Record<string, string>,
  options: QoderAuthRequestOptions,
): Promise<QoderRefreshedToken> {
  options.signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(20_000);
  const response = await (options.fetcher ?? fetch)(`${QODER_OPENAPI_ORIGIN}${path}`, {
    method: "POST",
    headers: qoderAuthHeaders(),
    body: JSON.stringify(body),
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  return parseQoderToken(await readQoderAuthResponse(response));
}

export async function refreshQoderDeviceToken(options: QoderAuthRequestOptions & {
  refreshToken: string;
  machineId?: string | undefined;
  machineType?: string | undefined;
  machineCode?: string | undefined;
  loginMethod?: "browser" | "token" | "job_token" | undefined;
}): Promise<QoderRefreshedToken> {
  const body = {
    refresh_token: options.refreshToken,
    ...(options.machineId ? { machine_id: options.machineId } : {}),
    ...(options.machineType ? { machine_type: options.machineType } : {}),
    ...(options.machineCode ? { machine_code: options.machineCode } : {}),
  };
  const path = options.loginMethod === "job_token" ? "/api/v1/jobToken/refresh" : "/api/v1/deviceToken/refresh";
  return requestQoderToken(path, body, options);
}

export async function exchangeQoderPersonalToken(options: QoderAuthRequestOptions & {
  personalAccessToken: string;
  machineId?: string | undefined;
  machineToken?: string | undefined;
}): Promise<QoderRefreshedToken> {
  return requestQoderToken("/api/v1/jobToken/exchange", {
    personal_token: options.personalAccessToken,
    ...(options.machineId ? { machine_id: options.machineId } : {}),
    ...(options.machineToken ? { machine_token: options.machineToken } : {}),
  }, options);
}

const MACHINE_ID_KEY_BYTES = 16;

export async function decryptQoderUserBlob(
  home = qoderConfigHome(),
): Promise<QoderStoredUser | undefined> {
  const machineId = await readQoderMachineId(home);
  if (!machineId) return undefined;
  const raw = await readTrimmed(join(home, ".auth", "user"));
  if (!raw) return undefined;
  const module = await loadSignerModule();
  const key = machineId.slice(0, MACHINE_ID_KEY_BYTES);
  let plaintext: Uint8Array | string;
  try {
    plaintext = module.credential_storage_decrypt(raw, key);
  } catch (error) {
    throw new QoderAuthError(
      `Could not decrypt the Qoder credential store (${error instanceof Error ? error.message : String(error)}). Run \`qodercli login\` again.`,
    );
  }
  const text = typeof plaintext === "string"
    ? plaintext
    : new TextDecoder().decode(plaintext);
  const record = asRecord(JSON.parse(text));
  if (!record) return undefined;
  const accessToken = pickString(record, "access_token", "accessToken", "security_oauth_token");
  if (!accessToken) return undefined;
  return {
    uid: pickString(record, "uid") ?? "",
    name: pickString(record, "name"),
    email: pickString(record, "email"),
    accessToken,
    refreshToken: pickString(record, "refresh_token", "refreshToken"),
    expireTime: typeof record.expire_time === "number" ? record.expire_time : undefined,
    refreshTokenExpireTime:
      typeof record.refresh_token_expire_time === "number"
        ? record.refresh_token_expire_time
        : undefined,
    personalAccessToken: pickString(record, "personal_access_token", "personalAccessToken"),
    loginMethod: record.login_method === "token" || record.login_method === "job_token" ? record.login_method : "browser",
    encryptUserInfo: pickString(record, "encrypt_user_info", "encryptUserInfo"),
    key: pickString(record, "key"),
    dataPolicyAgreed: record.data_policy_agreed === true,
  };
}

export async function importQoderCliCredential(
  home = qoderConfigHome(),
): Promise<QoderStoredUser> {
  const user = await decryptQoderUserBlob(home);
  if (!user) {
    throw new QoderAuthError(
      "No Qoder CLI credential found. Run `qodercli login` first, then `clai auth qoder`.",
    );
  }
  return user;
}