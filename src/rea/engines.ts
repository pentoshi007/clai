import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { withMcpStorageLock } from "../mcp/storage-lock.js";
import { publish, reaRoot } from "./install.js";

export const ENGINE_IDS = ["ghidra", "hopper", "ida", "kuna"] as const;
export type EngineId = typeof ENGINE_IDS[number];

export interface EngineSettings {
  readonly ghidra?: { readonly dir: string; readonly managed: boolean; readonly version?: string };
  readonly java?: { readonly home: string; readonly managed: boolean; readonly version?: string };
  readonly hopper?: { readonly launcher: string };
  readonly ida?: { readonly config: string };
  readonly kuna?: { readonly command: string };
}

export interface EngineRoots {
  readonly settings: string;
  readonly ghidra: string;
  readonly java: string;
}

const MAX_PATH_CHARS = 1_024;
const VERSION = /^[0-9A-Za-z._+-]{1,40}$/;
const WINDOWS_PATH_LIMIT = 259;
const STAGING_NAME = /^\.(?:staging-[0-9a-f-]{36}|s-[0-9a-f]{8})$/;

export function engineRoots(root = reaRoot()): EngineRoots {
  const base = resolve(root);
  return {
    settings: join(base, "engines.json"),
    ghidra: join(dirname(base), "ghidra"),
    java: join(dirname(base), "jdk"),
  };
}

export function stagingName(): string {
  return `.s-${randomUUID().slice(0, 8)}`;
}

export async function clearStaging(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && STAGING_NAME.test(entry.name))
    .map((entry) => removeTree(join(directory, entry.name)).catch(() => undefined)));
}

export function removeTree(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

export function windowsPathProblem(platform: NodeJS.Platform, directory: string, deepestEntry: number): string | undefined {
  if (platform !== "win32") return undefined;
  const longest = join(directory, stagingName(), "t").length + 1 + deepestEntry;
  if (longest <= WINDOWS_PATH_LIMIT) return undefined;
  return `${directory} is too deep for Windows, whose path limit is ${WINDOWS_PATH_LIMIT + 1} characters (this install needs ${longest}). Move clai's data folder somewhere shorter by setting CLAI_DATA_DIR, for example C:\\clai, then run the command again.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function absolutePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_CHARS || value.includes("\0")) return undefined;
  return isAbsolute(value) ? value : undefined;
}

function version(value: unknown): { version: string } | Record<string, never> {
  return typeof value === "string" && VERSION.test(value) ? { version: value } : {};
}

export function parseEngineSettings(text: string): EngineSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const settings: { -readonly [K in keyof EngineSettings]: EngineSettings[K] } = {};
  if (isRecord(parsed.ghidra)) {
    const dir = absolutePath(parsed.ghidra.dir);
    if (dir) settings.ghidra = { dir, managed: parsed.ghidra.managed === true, ...version(parsed.ghidra.version) };
  }
  if (isRecord(parsed.java)) {
    const home = absolutePath(parsed.java.home);
    if (home) settings.java = { home, managed: parsed.java.managed === true, ...version(parsed.java.version) };
  }
  if (isRecord(parsed.hopper)) {
    const launcher = absolutePath(parsed.hopper.launcher);
    if (launcher) settings.hopper = { launcher };
  }
  if (isRecord(parsed.ida)) {
    const config = absolutePath(parsed.ida.config);
    if (config) settings.ida = { config };
  }
  if (isRecord(parsed.kuna)) {
    const command = absolutePath(parsed.kuna.command);
    if (command) settings.kuna = { command };
  }
  return settings;
}

export async function readEngineSettings(root = reaRoot()): Promise<EngineSettings> {
  try {
    return parseEngineSettings(await readFile(engineRoots(root).settings, "utf8"));
  } catch {
    return {};
  }
}

async function writeEngineSettings(settings: EngineSettings, root: string): Promise<void> {
  const file = engineRoots(root).settings;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(file), `engines-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ v: 1, ...settings }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await publish(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function updateEngineSettings(
  change: (current: EngineSettings) => EngineSettings,
  root = reaRoot(),
  signal?: AbortSignal,
): Promise<EngineSettings> {
  return withMcpStorageLock(`rea-engines:${resolve(root)}`, async () => {
    const next = change(await readEngineSettings(root));
    await writeEngineSettings(next, resolve(root));
    return next;
  }, signal);
}

function environmentKey(env: NodeJS.ProcessEnv, key: string): string {
  if (process.platform !== "win32") return key;
  const wanted = key.toLowerCase();
  return Object.keys(env).find((name) => name.toLowerCase() === wanted) ?? key;
}

export function engineEnvironment(settings: EngineSettings, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const wanted: ReadonlyArray<readonly [string, string | undefined]> = [
    ["GHIDRA_INSTALL_DIR", settings.ghidra?.dir],
    ["JAVA_HOME", settings.java?.home],
    ["HOPPER_LAUNCHER_PATH", settings.hopper?.launcher],
    ["REA_IDA_MCP_CONFIG", settings.ida?.config],
    ["REA_KUNA_COMMAND", settings.kuna?.command],
  ];
  const env: Record<string, string> = {};
  for (const [key, value] of wanted) {
    if (value) env[environmentKey(base, key)] = value;
  }
  return env;
}
