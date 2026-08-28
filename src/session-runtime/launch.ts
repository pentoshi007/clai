import { RUNTIME_PROTOCOL_VERSION, type RuntimeHostPayload, type RuntimeLaunchSpec } from "./types.js";

export const RUNTIME_HOST_ENV = "CLAI_RUNTIME_HOST_PAYLOAD";
export const RUNTIME_CHILD_ENV = "CLAI_RUNTIME_CHILD";
export const RUNTIME_SOCKET_ENV = "CLAI_RUNTIME_SOCKET";
export const RUNTIME_TOKEN_ENV = "CLAI_RUNTIME_TOKEN";
export const RUNTIME_SESSION_ENV = "CLAI_RUNTIME_SESSION_ID";
export const RUNTIME_DISABLE_ENV = "CLAI_DISABLE_SESSION_RUNTIME";

function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

function isEmbeddedEntry(path: string): boolean {
  return path.includes("$bunfs") || path.startsWith("bun:");
}

function filteredExecArgv(): string[] {
  return process.execArgv.filter(
    (value) => !/^--inspect(?:-brk)?(?:=|$)/.test(value),
  );
}

export function selfLaunchSpec(
  entryPath: string,
  userArgs: readonly string[],
): RuntimeLaunchSpec {
  if (isBun() && isEmbeddedEntry(entryPath)) {
    return { file: process.execPath, args: [...userArgs] };
  }
  if (isBun()) {
    return { file: process.execPath, args: [entryPath, ...userArgs] };
  }
  return {
    file: process.execPath,
    args: [...filteredExecArgv(), entryPath, ...userArgs],
  };
}

export function encodeRuntimeHostPayload(payload: RuntimeHostPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeRuntimeHostPayload(
  encoded: string | undefined,
): RuntimeHostPayload | undefined {
  if (!encoded || encoded.length > 128 * 1024) return undefined;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<RuntimeHostPayload>;
    if (
      value.version !== RUNTIME_PROTOCOL_VERSION ||
      typeof value.sessionId !== "string" ||
      value.sessionId.length < 1 ||
      value.sessionId.length > 256 ||
      typeof value.cwd !== "string" ||
      !value.launch ||
      typeof value.launch.file !== "string" ||
      !Array.isArray(value.launch.args) ||
      !value.launch.args.every((entry) => typeof entry === "string") ||
      !Number.isSafeInteger(value.columns) ||
      !Number.isSafeInteger(value.rows) ||
      !Number.isSafeInteger(value.idleTimeoutMs)
    ) {
      return undefined;
    }
    return {
      ...(value as RuntimeHostPayload),
      columns: Math.max(20, Math.min(1_000, Math.floor(Number(value.columns)))),
      rows: Math.max(5, Math.min(500, Math.floor(Number(value.rows)))),
      idleTimeoutMs: Math.max(
        100,
        Math.min(24 * 60 * 60 * 1_000, Math.floor(Number(value.idleTimeoutMs))),
      ),
    };
  } catch {
    return undefined;
  }
}

export function runtimeChildSessionId(): string | undefined {
  if (process.env[RUNTIME_CHILD_ENV] !== "1") return undefined;
  const value = process.env[RUNTIME_SESSION_ENV]?.trim();
  return value && value.length <= 256 ? value : undefined;
}
