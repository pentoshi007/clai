import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDataDir } from "../store/paths.js";

const STORE_VERSION = 1;
const FALLBACK_SESSION_ID = "ses_ec1a2485dffeqSjTelY6sDMR5K";
const FALLBACK_USER_AGENT = "opencode/latest/2.0.29/cli";
const SERVE_TIMEOUT_MS = 15_000;
const REGISTRATION_GRACE_MS = 2_500;
const RETRY_BACKOFF_MS = 2_000;
const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]+$/;

interface ZenIdentity {
  sessionId: string;
  clientVersion?: string | undefined;
}

const identity: ZenIdentity = load();

function storeFile(): string {
  return join(getDataDir(), "zen-identity.json");
}

function load(): ZenIdentity {
  try {
    const parsed = JSON.parse(readFileSync(storeFile(), "utf8")) as {
      version?: unknown;
      sessionId?: unknown;
      clientVersion?: unknown;
    };
    if (parsed.version !== STORE_VERSION) return { sessionId: FALLBACK_SESSION_ID };
    if (typeof parsed.sessionId !== "string" || !SESSION_ID_PATTERN.test(parsed.sessionId)) {
      return { sessionId: FALLBACK_SESSION_ID };
    }
    return {
      sessionId: parsed.sessionId,
      ...(typeof parsed.clientVersion === "string" && parsed.clientVersion.trim()
        ? { clientVersion: parsed.clientVersion.trim() }
        : {}),
    };
  } catch {
    return { sessionId: FALLBACK_SESSION_ID };
  }
}

function persist(): void {
  const file = storeFile();
  const temp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(getDataDir(), { recursive: true });
    writeFileSync(
      temp,
      `${JSON.stringify({ version: STORE_VERSION, ...identity })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temp, file);
  } catch {
    try {
      rmSync(temp, { force: true });
    } catch {}
  }
}

export function currentZenSessionId(): string {
  return identity.sessionId;
}

export function zenUserAgent(): string {
  return identity.clientVersion
    ? `opencode/latest/${identity.clientVersion}/cli`
    : FALLBACK_USER_AGENT;
}

export function setZenIdentity(next: ZenIdentity): void {
  identity.sessionId = next.sessionId;
  identity.clientVersion = next.clientVersion;
  persist();
}

export function resetZenIdentityForTesting(): void {
  identity.sessionId = FALLBACK_SESSION_ID;
  identity.clientVersion = undefined;
  try {
    rmSync(storeFile(), { force: true });
  } catch {}
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectClientVersion(): string | undefined {
  try {
    const probe = spawnSync("opencode", ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const version = probe.status === 0 ? probe.stdout?.trim().split("\n")[0] : undefined;
    return version && /^\d+\.\d+\.\d+/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

function parseServeOutput(output: string): { port: string; password: string } | undefined {
  const port = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
  const password = output.match(/server password (\S+)/)?.[1];
  return port && password ? { port, password } : undefined;
}

async function createSession(port: string, password: string): Promise<string | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      },
      body: JSON.stringify({ title: "clai" }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { data?: { id?: unknown } };
    const id = payload.data?.id;
    return typeof id === "string" && SESSION_ID_PATTERN.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

let minting: Promise<string | undefined> | undefined;

export async function mintZenSession(): Promise<string | undefined> {
  minting ??= mintOnce().finally(() => {
    minting = undefined;
  });
  return minting;
}

async function mintOnce(): Promise<string | undefined> {
  const version = detectClientVersion();
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(
    "opencode",
    ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
    { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  try {
    const deadline = Date.now() + SERVE_TIMEOUT_MS;
    let parsed: { port: string; password: string } | undefined;
    while (Date.now() < deadline) {
      parsed = parseServeOutput(output);
      if (parsed || child.exitCode !== null) break;
      await delay(150);
    }
    if (!parsed) return undefined;
    const sessionId = await createSession(parsed.port, parsed.password);
    if (!sessionId) return undefined;
    await delay(REGISTRATION_GRACE_MS);
    return sessionId;
  } finally {
    child.kill("SIGTERM");
  }
}

export async function recoverZenIdentity(): Promise<boolean> {
  const version = detectClientVersion();
  const sessionId = await mintZenSession();
  if (sessionId) {
    setZenIdentity({ sessionId, ...(version ? { clientVersion: version } : {}) });
    return true;
  }
  await delay(RETRY_BACKOFF_MS);
  return true;
}
