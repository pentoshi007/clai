function splitJsonObjectSegments(raw: string): string[] | undefined {
  const segments: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth < 0) return undefined;
      if (depth === 0 && start >= 0) {
        segments.push(raw.slice(start, index + 1));
        start = -1;
      }
      continue;
    }
    if (depth === 0 && !/\s/.test(char)) return undefined;
  }
  if (depth !== 0 || inString) return undefined;
  return segments.length >= 2 ? segments : undefined;
}

export function repairConcatenatedToolArguments(
  raw: string,
): Record<string, unknown> | undefined {
  const segments = splitJsonObjectSegments(raw.trim());
  if (!segments) return undefined;
  const merged: Record<string, unknown> = {};
  for (const segment of segments) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(segment);
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    for (const [key, value] of Object.entries(parsed)) {
      const empty = value === undefined || value === null || value === "";
      if (!empty || !(key in merged)) merged[key] = value;
    }
  }
  return merged;
}

export function wireToolArguments(
  rawArguments: string | undefined,
  args: Record<string, unknown> | undefined,
): string {
  if (typeof rawArguments === "string") {
    const trimmed = rawArguments.trim();
    if (trimmed) {
      try {
        JSON.parse(trimmed);
        return trimmed;
      } catch {
      }
    }
  }
  const durable =
    args && args._parseError === true
      ? (({ _parseError: _pe, _raw: _r, ...rest }) => rest)(args)
      : args;
  try {
    return JSON.stringify(durable ?? {});
  } catch {
    return "{}";
  }
}

export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return {};
    try {
      const parsed = JSON.parse(t) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
    }
    const repaired = repairConcatenatedToolArguments(t);
    if (repaired) return repaired;
    return { _parseError: true, _raw: t };
  }
  return {};
}
