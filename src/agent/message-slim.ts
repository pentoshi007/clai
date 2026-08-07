import { createHash } from "node:crypto";

export const SLIM_ARG_STRING_CHARS = 400;
export const SLIM_ARG_ABSOLUTE_MAX_CHARS = 8_000;
const SLIM_MAX_DEPTH = 6;

const BULK_ARG_KEYS = new Set(["content", "body"]);

const ELIDED_STUB_PATTERN = /^«\d+ chars sha256=[0-9a-f]{12}(?:\s+—.*)?»$/s;

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function slimLimitForKey(key: string | undefined): number {
  return key !== undefined && BULK_ARG_KEYS.has(key)
    ? SLIM_ARG_STRING_CHARS
    : SLIM_ARG_ABSOLUTE_MAX_CHARS;
}

export function slimValue(value: unknown, depth = 0, key?: string): unknown {
  if (typeof value === "string") {
    if (value.length < slimLimitForKey(key)) return value;
    const hash = shortHash(value);
    return `«${value.length} chars sha256=${hash} — elided from history; never reuse this stub, regenerate the full value»`;
  }
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (depth >= SLIM_MAX_DEPTH) {
    if (Array.isArray(value)) return `[…${value.length} items]`;
    return "{…}";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => slimValue(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const childKey of Object.keys(value as Record<string, unknown>).sort()) {
    out[childKey] = slimValue(
      (value as Record<string, unknown>)[childKey],
      depth + 1,
      childKey,
    );
  }
  return out;
}

export function slimToolArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const slimmed = slimValue(args);
  if (slimmed && typeof slimmed === "object" && !Array.isArray(slimmed)) {
    return slimmed as Record<string, unknown>;
  }
  return {};
}

export function findElidedStubArg(
  value: unknown,
  path = "args",
  depth = 0,
): { key: string; value: string } | undefined {
  if (typeof value === "string") {
    return ELIDED_STUB_PATTERN.test(value) ? { key: path, value } : undefined;
  }
  if (value === null || value === undefined || typeof value !== "object") {
    return undefined;
  }
  if (depth >= SLIM_MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findElidedStubArg(value[i], `${path}[${i}]`, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  for (const [childKey, childValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const found = findElidedStubArg(
      childValue,
      path ? `${path}.${childKey}` : childKey,
      depth + 1,
    );
    if (found) return found;
  }
  return undefined;
}

export function elidedStubReuseMessage(key: string): string {
  return (
    `Tool call rejected: argument "${key}" is an elided history placeholder («N chars sha256=…»), not a real value. ` +
    "Compressed history replaces long arguments with those stubs and the original text cannot be recovered from them. " +
    "Re-issue the tool call with the complete literal value — never copy «…» stubs from earlier context."
  );
}

export function measureToolCallsChars(
  toolCalls:
    | readonly {
        readonly name?: string;
        readonly id?: string;
        readonly args?: Record<string, unknown>;
      }[]
    | undefined,
): number {
  if (!toolCalls?.length) return 0;
  let n = 0;
  for (const tc of toolCalls) {
    n += (tc.name?.length ?? 0) + (tc.id?.length ?? 0) + 8;
    if (tc.args) {
      try {
        n += JSON.stringify(tc.args).length;
      } catch {
        n += 64;
      }
    }
  }
  return n;
}
