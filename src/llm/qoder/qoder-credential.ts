import type { ProviderAuth } from "../provider.js";
import type { ProviderKeyMetadata } from "../../store/keys.js";
import {
  asRecord,
  expiryMilliseconds,
  pickString,
  QoderAuthError,
  type QoderStoredUser,
} from "./qoder-auth.js";
import { loadSignerModule, type QoderUserInfo } from "./qoder-signer.js";

export interface QoderMachineIdentity {
  machineId: string;
  machineCode?: string | undefined;
  machineToken: string;
  machineType?: string | undefined;
}

export interface QoderCredential extends QoderUserInfo, QoderMachineIdentity {
  accessToken: string;
  refreshToken?: string | undefined;
  expireTime?: number | undefined;
  refreshTokenExpireTime?: number | undefined;
  personalAccessToken?: string | undefined;
  loginMethod?: "browser" | "token" | "job_token" | undefined;
  email?: string | undefined;
  name?: string | undefined;
  dataPolicyAgreed?: boolean | undefined;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function parseQoderCredential(value: string | undefined): QoderCredential {
  if (!value) throw new QoderAuthError("Qoder authentication required. Run `clai auth qoder` or sign in through /provider qoder.");
  let record: Record<string, unknown> | undefined;
  try {
    record = asRecord(JSON.parse(value));
  } catch {
    throw new QoderAuthError("Qoder credential is not valid JSON.");
  }
  if (!record) throw new QoderAuthError("Qoder credential must be an object.");
  const accessToken = pickString(record, "accessToken");
  if (!accessToken) throw new QoderAuthError("Qoder credential is missing an access token.");
  const method = record.loginMethod;
  return {
    accessToken,
    uid: pickString(record, "uid"),
    email: pickString(record, "email"),
    name: pickString(record, "name"),
    encryptUserInfo: pickString(record, "encryptUserInfo"),
    key: pickString(record, "key"),
    refreshToken: pickString(record, "refreshToken"),
    expireTime: optionalNumber(record, "expireTime"),
    refreshTokenExpireTime: optionalNumber(record, "refreshTokenExpireTime"),
    personalAccessToken: pickString(record, "personalAccessToken"),
    loginMethod: method === "token" || method === "job_token" || method === "browser" ? method : undefined,
    machineId: pickString(record, "machineId") ?? "",
    machineCode: pickString(record, "machineCode"),
    machineToken: pickString(record, "machineToken") ?? "",
    machineType: pickString(record, "machineType"),
    dataPolicyAgreed: record.dataPolicyAgreed === true,
  };
}

export function encodeQoderCredential(credential: QoderCredential): string {
  return JSON.stringify(credential);
}

export function qoderCredentialFromImport(
  imported: Partial<QoderStoredUser> & { uid: string; accessToken: string } & Partial<QoderMachineIdentity>,
): QoderCredential {
  return {
    ...imported,
    machineId: imported.machineId ?? "",
    machineToken: imported.machineToken ?? "",
  };
}

export function qoderCredentialExpiry(credential: QoderCredential, auth?: ProviderAuth): number | undefined {
  return expiryMilliseconds(credential.expireTime) ?? auth?.expiresAt;
}

export function qoderCredentialMetadata(credential: QoderCredential): ProviderKeyMetadata {
  return { refreshToken: credential.refreshToken, expiresAt: qoderCredentialExpiry(credential) };
}

export function qoderAccountLabel(value: string): string {
  try {
    const credential = parseQoderCredential(value);
    return credential.email ?? credential.name ?? credential.uid ?? "Qoder account";
  } catch {
    return "Qoder account (sign in again)";
  }
}

export async function signQoderCredential(credential: QoderCredential): Promise<QoderCredential> {
  const module = await loadSignerModule();
  const fields = asRecord(JSON.parse(module.generate_runtime_auth_fields(JSON.stringify({
    uid: credential.uid ?? "",
    security_oauth_token: credential.accessToken,
    access_token: credential.accessToken,
    expire_time: credential.expireTime,
    data_policy_agreed: credential.dataPolicyAgreed === true,
  }))));
  const encryptUserInfo = pickString(fields ?? {}, "encrypt_user_info");
  const key = pickString(fields ?? {}, "key");
  if (!encryptUserInfo || !key) throw new QoderAuthError("Qoder could not generate runtime authentication fields.");
  return { ...credential, encryptUserInfo, key };
}
