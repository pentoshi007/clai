import { randomUUID, createHash } from "node:crypto";
import { hostname } from "node:os";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { getDataDir } from "./paths.js";
import { acquireStorageWriteLock } from "./history/jsonl-lock.js";
import { fixOwner } from "../os/permissions.js";
import { registerSensitiveText, registerKnownSecret } from "../security/known-secrets.js";
import { createKey, decryptVault, encryptVault, isMissing, readKey, syncCredentialDirectory } from "./credentials/crypto.js";

export interface Credential {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly kind: "freeform" | "sudo";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CredentialSummary = Omit<Credential, "content">;
export const MAX_CREDENTIAL_BYTES = 1_048_576;
const MAX_VAULT_BYTES = 24 * 1_048_576;

export function machineSudoId(): string {
  return `sudo:${createHash("sha256").update(hostname()).digest("hex").slice(0, 24)}`;
}

function vaultPaths(): { directory: string; vault: string; key: string; lock: string } {
  const directory = join(getDataDir(), "credentials");
  return { directory, vault: join(directory, "vault.json"), key: join(directory, "master.key"), lock: join(directory, "vault.lock") };
}

function isCredential(value: unknown): value is Credential {
  if (typeof value !== "object" || value === null) return false;
  return "id" in value && typeof value.id === "string" &&
    "title" in value && typeof value.title === "string" &&
    "content" in value && typeof value.content === "string" &&
    "kind" in value && (value.kind === "freeform" || value.kind === "sudo") &&
    "createdAt" in value && typeof value.createdAt === "string" &&
    "updatedAt" in value && typeof value.updatedAt === "string";
}

async function loadVault(): Promise<Credential[]> {
  const paths = vaultPaths();
  let text: string;
  try {
    const info = await lstat(paths.vault);
    if (!info.isFile() || info.size > MAX_VAULT_BYTES) throw new Error("Credential vault is not a regular file or exceeds its size limit.");
    text = await readFile(paths.vault, "utf8");
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const key = await readKey(paths.key);
  try {
    const data = decryptVault(text, key);
    if (!Array.isArray(data) || !data.every(isCredential)) throw new Error("Credential vault has an unsupported format; no credentials were changed.");
    return data;
  } finally {
    key.fill(0);
  }
}

async function saveVault(entries: readonly Credential[]): Promise<void> {
  const paths = vaultPaths();
  const key = await lstat(paths.key).then(() => readKey(paths.key)).catch((error: unknown) => {
    if (isMissing(error)) return createKey(paths.key);
    throw error;
  });
  let encrypted: string;
  try {
    encrypted = encryptVault(JSON.stringify(entries), key);
  } finally {
    key.fill(0);
  }
  if (Buffer.byteLength(encrypted) > MAX_VAULT_BYTES) throw new Error("Credential vault size limit reached; no credentials were changed.");
  const temporary = join(paths.directory, `.vault-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(encrypted);
      await file.sync();
      await fixOwner(temporary);
    } finally {
      await file.close();
    }
    await rename(temporary, paths.vault);
    await syncCredentialDirectory(paths.directory);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function updateVault(update: (entries: Credential[]) => Credential[]): Promise<void> {
  const paths = vaultPaths();
  await mkdir(getDataDir(), { recursive: true, mode: 0o700 });
  await fixOwner(getDataDir());
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await fixOwner(paths.directory);
  if (process.platform !== "win32") await chmod(paths.directory, 0o700);
  const release = await acquireStorageWriteLock(paths.lock, "credential");
  try {
    await saveVault(update(await loadVault()));
  } finally {
    await release();
  }
}

export async function listCredentials(): Promise<CredentialSummary[]> {
  return (await loadVault()).filter((entry) => entry.kind !== "sudo" || entry.id === machineSudoId()).map(({ content: _content, ...summary }) => summary);
}

export async function getCredential(id: string): Promise<Credential | undefined> {
  const entry = (await loadVault()).find((candidate) => candidate.id === id && candidate.kind === "freeform");
  if (entry) registerSensitiveText(entry.content);
  return entry;
}

export async function getMachineSudoPassword(): Promise<string | undefined> {
  const entry = (await loadVault()).find((candidate) => candidate.id === machineSudoId() && candidate.kind === "sudo");
  if (entry) registerKnownSecret(entry.content);
  return entry?.content;
}

export async function saveCredential(input: { id?: string | undefined; title: string; content: string }): Promise<string> {
  const title = input.title.trim();
  if (!title || title.length > 160 || /[\r\n\x00-\x1f\x7f]/.test(title)) throw new Error("Credential title must be one line of 1–160 characters.");
  if (!input.content || Buffer.byteLength(input.content) > MAX_CREDENTIAL_BYTES) throw new Error("Credential content must contain 1 byte to 1 MiB of text.");
  const id = input.id ?? randomUUID();
  await updateVault((entries) => {
    const previous = entries.find((entry) => entry.id === id);
    if (input.id && (!previous || previous.kind !== "freeform")) throw new Error("Credential no longer exists or is reserved for this machine.");
    const now = new Date().toISOString();
    return [...entries.filter((entry) => entry.id !== id), { id, title, content: input.content, kind: "freeform", createdAt: previous?.createdAt ?? now, updatedAt: now }];
  });
  registerSensitiveText(input.content);
  return id;
}

export async function setMachineSudoPassword(password: string): Promise<void> {
  if (!password || /[\r\n\x00]/.test(password) || Buffer.byteLength(password) > 4_096) throw new Error("Machine sudo password must be a single nonempty line of at most 4096 bytes.");
  const id = machineSudoId();
  await updateVault((entries) => {
    const previous = entries.find((entry) => entry.id === id);
    const now = new Date().toISOString();
    return [...entries.filter((entry) => entry.id !== id), { id, title: "Machine sudo password", content: password, kind: "sudo", createdAt: previous?.createdAt ?? now, updatedAt: now }];
  });
  registerKnownSecret(password);
}

export async function deleteCredential(id: string): Promise<void> {
  await updateVault((entries) => entries.filter((entry) => entry.id !== id || (entry.kind === "sudo" && id !== machineSudoId())));
}
