import type { McpAuthChallenge } from "./types.js";

const PARAM_PATTERN = /([a-zA-Z0-9_-]+)\s*=\s*("([^"]*)"|[^,\s]+)/g;

function firstToken(header: string): { scheme: string; rest: string } {
  const trimmed = header.trim();
  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex < 0) return { scheme: trimmed, rest: "" };
  return {
    scheme: trimmed.slice(0, spaceIndex),
    rest: trimmed.slice(spaceIndex + 1),
  };
}

function collectParams(rest: string): Map<string, string> {
  const params = new Map<string, string>();
  let match: RegExpExecArray | null;
  const pattern = new RegExp(PARAM_PATTERN.source, PARAM_PATTERN.flags);
  while ((match = pattern.exec(rest)) !== null) {
    const key = (match[1] ?? "").toLowerCase();
    const quoted = match[3];
    const value = quoted !== undefined ? quoted : (match[2] ?? "");
    if (key.length > 0) params.set(key, value);
  }
  return params;
}

export function parseWwwAuthenticate(
  header: string | null | undefined,
): McpAuthChallenge | undefined {
  if (typeof header !== "string" || header.trim().length === 0) return undefined;
  const { scheme, rest } = firstToken(header);
  if (scheme.length === 0) return undefined;
  const params = collectParams(rest);
  const resourceMetadataUrl = params.get("resource_metadata");
  const scope = params.get("scope");
  const error = params.get("error");
  return {
    scheme,
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    ...(scope ? { scope } : {}),
    ...(error ? { error } : {}),
  };
}
