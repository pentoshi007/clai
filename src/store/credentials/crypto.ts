import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fixOwner } from "../../os/permissions.js";

const AAD = Buffer.from("clai.credentials.v1");

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function protectWindowsKey(key: string, decrypt: boolean): Promise<string> {
  const method = decrypt ? "Unprotect" : "Protect";
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
    "$inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); " +
    `$outputBytes=[Security.Cryptography.ProtectedData]::${method}($inputBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    "[Console]::Out.Write([Convert]::ToBase64String($outputBytes))";
  const executable = process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let output = "";
    const timer = setTimeout(() => child.kill(), 15_000);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.resume();
    child.stdin.on("error", () => undefined);
    child.once("error", () => { clearTimeout(timer); reject(new Error("Windows credential key protection is unavailable.")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && /^[A-Za-z0-9+/=]+$/.test(output.trim())) resolve(output.trim());
      else reject(new Error("Windows credential key protection failed for this account."));
    });
    child.stdin.end(key);
  });
}

export async function syncCredentialDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function readKey(path: string): Promise<Buffer> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536) throw new Error("Invalid credential key file.");
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) await chmod(path, 0o600);
    const raw = (await readFile(path, "utf8")).trim();
    const encoded = raw.startsWith("dpapi:")
      ? await protectWindowsKey(raw.slice(6), true)
      : raw;
    if (process.platform === "win32" && !raw.startsWith("dpapi:")) throw new Error("Unprotected Windows credential key.");
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) throw new Error("Invalid key length.");
    return key;
  } catch {
    throw new Error("Credential vault key is missing, damaged, or unavailable to this account. Restore the matching key; the vault was not changed.");
  }
}

export async function createKey(path: string): Promise<Buffer> {
  const key = randomBytes(32);
  const encoded = key.toString("base64");
  const stored = process.platform === "win32" ? `dpapi:${await protectWindowsKey(encoded, false)}` : encoded;
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(stored);
    await file.sync();
    await fixOwner(path);
  } finally {
    await file.close();
  }
  await syncCredentialDirectory(dirname(path));
  return key;
}

export function encryptVault(text: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
}

export function decryptVault(text: string, key: Buffer): unknown {
  try {
    const envelope: unknown = JSON.parse(text);
    if (!record(envelope) || envelope.version !== 1 || typeof envelope.iv !== "string" || typeof envelope.tag !== "string" || typeof envelope.data !== "string") throw new Error("Invalid vault.");
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid envelope.");
    const cipher = createDecipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(AAD);
    cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.data, "base64")), cipher.final()]).toString("utf8"));
  } catch {
    throw new Error("Credential vault cannot be decrypted. Restore the matching vault and key; no credentials were changed.");
  }
}
