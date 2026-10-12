import { isAbsolute, win32 } from "node:path";

const ORIGIN_ENV = "CLAI_UPDATE_ORIGIN";

interface UpdateOrigin {
  readonly argv1: string;
  readonly execPath: string;
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length < 4096 &&
    !/[\0\r\n]/.test(value) && (isAbsolute(value) || win32.isAbsolute(value));
}

export function readUpdateOrigin(env: NodeJS.ProcessEnv = process.env): UpdateOrigin | undefined {
  const encoded = env[ORIGIN_ENV];
  if (!encoded || encoded.length > 8192) return undefined;
  try {
    const value: unknown = JSON.parse(encoded);
    if (!value || typeof value !== "object" ||
      !("argv1" in value) || !("execPath" in value) ||
      !validPath(value.argv1) || !validPath(value.execPath)) return undefined;
    return { argv1: value.argv1, execPath: value.execPath };
  } catch {
    return undefined;
  }
}

export function updateOriginEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const origin = readUpdateOrigin(env) ?? {
    argv1: process.argv[1] ?? process.execPath,
    execPath: process.execPath,
  };
  return { ...env, [ORIGIN_ENV]: JSON.stringify(origin) };
}
