export interface McpArgCoercionResult {
  readonly args: Record<string, unknown>;
  readonly coerced: readonly string[];
}

type SchemaLike = Record<string, unknown>;

function declaredTypes(schema: unknown): ReadonlySet<string> {
  if (typeof schema !== "object" || schema === null) return new Set();
  const record = schema as SchemaLike;
  const raw = record.type;
  const types = new Set<string>();
  if (typeof raw === "string") types.add(raw);
  else if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === "string") types.add(entry);
    }
  }
  if (types.size === 0 && typeof record.properties === "object") types.add("object");
  if (types.size === 0 && typeof record.items === "object") types.add("array");
  for (const unionKey of ["anyOf", "oneOf"] as const) {
    const variants = record[unionKey];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      for (const type of declaredTypes(variant)) types.add(type);
    }
  }
  return types;
}

function parseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const first = trimmed[0]!;
  if (first !== "{" && first !== "[") return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function coerceValue(
  value: unknown,
  schema: unknown,
  path: string,
  coerced: string[],
): unknown {
  if (typeof value === "string") {
    const types = declaredTypes(schema);
    if (types.has("object") || types.has("array")) {
      const parsed = parseJsonString(value);
      if (parsed !== undefined) {
        const isObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
        if ((types.has("object") && isObject) || (types.has("array") && Array.isArray(parsed))) {
          coerced.push(path);
          return parsed;
        }
      }
    }
    if (types.has("number") || types.has("integer")) {
      const trimmed = value.trim();
      if (trimmed.length > 0 && trimmed.length <= 64) {
        const numeric = Number(trimmed);
        if (
          Number.isFinite(numeric) &&
          (!types.has("integer") || types.has("number") || Number.isInteger(numeric))
        ) {
          coerced.push(path);
          return numeric;
        }
      }
    }
    if (types.has("boolean")) {
      const lowered = value.trim().toLowerCase();
      if (lowered === "true" || lowered === "false") {
        coerced.push(path);
        return lowered === "true";
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    const itemSchema =
      typeof schema === "object" && schema !== null
        ? (schema as SchemaLike).items
        : undefined;
    return value.map((entry, index) =>
      coerceValue(entry, itemSchema, `${path}[${index}]`, coerced),
    );
  }
  if (typeof value === "object" && value !== null) {
    return coerceObject(value as Record<string, unknown>, schema, path, coerced);
  }
  return value;
}

function coerceObject(
  value: Record<string, unknown>,
  schema: unknown,
  path: string,
  coerced: string[],
): Record<string, unknown> {
  const properties =
    typeof schema === "object" && schema !== null
      ? ((schema as SchemaLike).properties as Record<string, unknown> | undefined)
      : undefined;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    out[key] = coerceValue(entry, properties?.[key], childPath, coerced);
  }
  return out;
}

export function coerceArgumentsForSchema(
  args: Record<string, unknown>,
  schema: unknown,
): McpArgCoercionResult {
  const coerced: string[] = [];
  const next = coerceObject(args, schema, "", coerced);
  return { args: coerced.length > 0 ? next : args, coerced };
}
