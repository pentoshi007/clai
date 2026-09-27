import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const ALLOWED_IDP_HOSTS: readonly string[] = [
  "login.microsoftonline.com",
  "login.microsoftonline.us",
  "login.partner.microsoftonline.cn",
  "login.microsoft.com",
  "login.windows.net",
  "sts.windows.net",
  ".okta.com",
  ".oktapreview.com",
  ".okta-emea.com",
  ".auth0.com",
  ".onelogin.com",
  ".pingidentity.com",
  ".pingone.com",
  "accounts.google.com",
  "oauth2.googleapis.com",
  ".amazoncognito.com",
];

export function validateExternalIdpTokenEndpoint(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("external IdP tokenEndpoint must be a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("external IdP tokenEndpoint must use https");
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = ALLOWED_IDP_HOSTS.some((suffix) =>
    suffix.startsWith(".") ? host.endsWith(suffix) : host === suffix
  );
  if (!allowed) {
    throw new Error(`external IdP tokenEndpoint host is not allowed: ${host}`);
  }
  return parsed.toString();
}

export function normalizeIdpScope(value: unknown): string | undefined {
  const scope = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").join(" ")
    : typeof value === "string"
      ? value
      : "";
  return scope.trim() || undefined;
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function secretPair(record: Record<string, unknown> | undefined): {
  clientId: string;
  clientSecret: string;
} | undefined {
  const clientId = record?.clientId;
  const clientSecret = record?.clientSecret;
  return typeof clientId === "string" && clientId &&
    typeof clientSecret === "string" && clientSecret
    ? { clientId, clientSecret }
    : undefined;
}

export async function linkedSsoClientRegistration(
  tokenPath: string,
  token: Record<string, unknown>,
): Promise<{ clientId: string; clientSecret: string } | undefined> {
  const directory = dirname(tokenPath);
  if (typeof token.clientIdHash === "string" && /^[\w-]+$/.test(token.clientIdHash)) {
    const linked = secretPair(await readJson(join(directory, `${token.clientIdHash}.json`)));
    if (linked) return linked;
  }
  if (typeof token.clientId !== "string" || !token.clientId) return undefined;
  const files = await readdir(directory).catch(() => [] as string[]);
  for (const file of files) {
    if (!file.endsWith(".json") || file === basename(tokenPath)) continue;
    const candidate = secretPair(await readJson(join(directory, file)));
    if (candidate?.clientId === token.clientId) return candidate;
  }
  return undefined;
}

export function kiroIdeProfilePaths(home = homedir()): string[] {
  const tail = ["User", "globalStorage", "kiro.kiroagent", "profile.json"];
  return [
    join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Kiro", ...tail),
    join(home, ".config", "Kiro", ...tail),
    join(home, "Library", "Application Support", "Kiro", ...tail),
  ];
}

export async function readKiroIdeProfileArn(): Promise<string | undefined> {
  for (const path of kiroIdeProfilePaths()) {
    const arn = (await readJson(path))?.arn;
    if (typeof arn === "string" && arn.startsWith("arn:")) return arn;
  }
  return undefined;
}

export function preferKiroSsoTokenFiles(files: readonly string[]): string[] {
  const preferred = ["kiro-auth-token.json", "amazon-q-auth-token.json"];
  return [
    ...preferred.filter((name) => files.includes(name)),
    ...files.filter((name) => name.endsWith(".json") && !preferred.includes(name)),
  ];
}

export function parseStoredExpiry(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
