import { substituteVariables, type McpSubstitutionContext } from "./substitution.js";
import type {
  McpAuthConfig,
  McpServerConfig,
  McpToolSelection,
  McpTransportKind,
} from "./types.js";

export interface ValidatedServer {
  readonly config: McpServerConfig;
  readonly disabled: boolean;
  readonly toolSelection: McpToolSelection;
  readonly secretValues: readonly string[];
}

export type ServerValidation =
  | { readonly ok: true; readonly server: ValidatedServer }
  | { readonly ok: false; readonly errors: readonly string[] };

const KNOWN_TYPES: Readonly<Record<string, McpTransportKind>> = {
  stdio: "stdio",
  local: "stdio",
  http: "http",
  "streamable-http": "http",
  "http-stream": "http",
  sse: "sse",
};

function coercePrimitive(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

class Substitutor {
  readonly secretValues = new Set<string>();
  readonly missing = new Set<string>();
  constructor(private readonly context: McpSubstitutionContext) {}
  apply(raw: string): string {
    const result = substituteVariables(raw, this.context);
    for (const secret of result.secretValues) this.secretValues.add(secret);
    for (const token of result.missing) this.missing.add(token);
    return result.value;
  }
}

function dedupeNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function parseToolSelection(raw: unknown, errors: string[]): McpToolSelection {
  if (raw === undefined) return "all";
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed === "*") return "all";
    return dedupeNames(
      trimmed
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    );
  }
  if (Array.isArray(raw)) {
    const names: string[] = [];
    let wildcard = false;
    raw.forEach((value, index) => {
      if (typeof value !== "string") {
        errors.push(`tools[${index}] must be a string`);
        return;
      }
      const trimmed = value.trim();
      if (trimmed === "*") wildcard = true;
      else if (trimmed.length > 0) names.push(trimmed);
    });
    return wildcard ? "all" : dedupeNames(names);
  }
  errors.push("tools must be a string or an array of strings");
  return "all";
}

function validateName(name: string, errors: string[]): void {
  if (name.trim().length === 0) errors.push("server name is empty");
  if (/\s/.test(name)) errors.push(`server name "${name}" contains whitespace`);
}

function validateStringMap(
  raw: unknown,
  label: string,
  substitutor: Substitutor,
  errors: string[],
  markSecret: boolean,
): Record<string, string> {
  const map: Record<string, string> = {};
  if (raw === undefined) return map;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push(`${label} must be an object of string values`);
    return map;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const primitive = coercePrimitive(value);
    if (primitive === undefined) {
      errors.push(`${label}.${key} must be a string`);
      continue;
    }
    const resolved = substitutor.apply(primitive);
    map[key] = resolved;
    if (markSecret && resolved.length > 0) substitutor.secretValues.add(resolved);
  }
  return map;
}

function validateArgs(
  raw: unknown,
  substitutor: Substitutor,
  errors: string[],
): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push("args must be an array of strings");
    return [];
  }
  const args: string[] = [];
  raw.forEach((value, index) => {
    const primitive = coercePrimitive(value);
    if (primitive === undefined) {
      errors.push(`args[${index}] must be a string`);
      return;
    }
    args.push(substitutor.apply(primitive));
  });
  return args;
}

function resolveTransport(
  entry: Record<string, unknown>,
  errors: string[],
): McpTransportKind | undefined {
  const rawType = entry.type;
  if (typeof rawType === "string") {
    const mapped = KNOWN_TYPES[rawType.toLowerCase()];
    if (!mapped) {
      errors.push(`unknown transport type "${rawType}"`);
      return undefined;
    }
    return mapped;
  }
  const hasCommand = typeof entry.command === "string";
  const hasUrl = typeof entry.url === "string";
  if (hasCommand && hasUrl) {
    errors.push("server defines both command and url");
    return undefined;
  }
  if (hasCommand) return "stdio";
  if (hasUrl) return "http";
  errors.push("server has neither command nor url");
  return undefined;
}


function httpConfig(
  transport: "http" | "sse",
  url: string,
  headers: Record<string, string>,
  auth: McpAuthConfig | undefined,
): McpServerConfig {
  return { transport, url, headers, ...(auth ? { auth } : {}) };
}
export function validateServerEntry(
  name: string,
  rawEntry: unknown,
  context: McpSubstitutionContext,
): ServerValidation {
  const errors: string[] = [];
  validateName(name, errors);
  if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
    return { ok: false, errors: ["server definition must be an object"] };
  }
  const entry = rawEntry as Record<string, unknown>;
  const disabled = entry.disabled === true;
  const toolSelection = parseToolSelection(entry.tools, errors);
  const substitutor = new Substitutor(context);
  const transport = resolveTransport(entry, errors);

  let config: McpServerConfig | undefined;
  if (transport === "stdio") {
    const rawCommand = entry.command;
    if (typeof rawCommand !== "string" || rawCommand.trim().length === 0) {
      errors.push("stdio server requires a non-empty command");
    }
    if (typeof entry.url === "string") errors.push("stdio server must not define url");
    const command = typeof rawCommand === "string" ? substitutor.apply(rawCommand) : "";
    const args = validateArgs(entry.args, substitutor, errors);
    const env = validateStringMap(entry.env, "env", substitutor, errors, true);
    const cwd =
      typeof entry.cwd === "string" ? substitutor.apply(entry.cwd) : undefined;
    if (command.trim().length === 0) errors.push("stdio command resolved to empty");
    if (errors.length === 0) {
      config = {
        transport: "stdio",
        command,
        args,
        env,
        ...(cwd !== undefined ? { cwd } : {}),
      };
    }
  } else if (transport === "http" || transport === "sse") {
    const rawUrl = entry.url;
    if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
      errors.push(`${transport} server requires a url`);
    }
    if (typeof entry.command === "string") {
      errors.push(`${transport} server must not define command`);
    }
    const url = typeof rawUrl === "string" ? substitutor.apply(rawUrl) : "";
    if (url.length > 0 && !isHttpUrl(url)) {
      errors.push(`url must be an http(s) URL, got "${url}"`);
    }
    const headers = validateStringMap(entry.headers, "headers", substitutor, errors, true);
    const auth = parseAuthBlock(entry.auth, substitutor, errors);
    if (errors.length === 0) {
      config = httpConfig(transport, url, headers, auth);
    }
  }

  if (substitutor.missing.size > 0) {
    const missing = [...substitutor.missing].sort();
    const shown = missing.slice(0, 3);
    const rest = missing.length - shown.length;
    errors.push(
      `unresolved configuration variable(s): ${shown.join(", ")}${rest > 0 ? ` +${rest} more` : ""} — export matching environment variables or add input defaults in the source config`,
    );
  }

  if (errors.length > 0 || !config) {
    return { ok: false, errors: errors.length > 0 ? errors : ["invalid server definition"] };
  }
  return {
    ok: true,
    server: {
      config,
      disabled,
      toolSelection,
      secretValues: [...substitutor.secretValues],
    },
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const AUTH_KINDS = new Set(["none", "bearer", "header", "oauth"]);

const AUTH_ALLOWED_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  none: new Set<string>(),
  bearer: new Set(["token"]),
  header: new Set(["headers"]),
  oauth: new Set(["scopes", "clientId", "clientSecret", "resource", "authorizationServer"]),
};

function markedString(
  value: unknown,
  label: string,
  substitutor: Substitutor,
  errors: string[],
): string | undefined {
  const primitive = coercePrimitive(value);
  if (primitive === undefined) {
    errors.push(`${label} must be a string`);
    return undefined;
  }
  const resolved = substitutor.apply(primitive);
  if (resolved.length > 0) substitutor.secretValues.add(resolved);
  return resolved;
}

function parseScopes(
  value: unknown,
  substitutor: Substitutor,
  errors: string[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((part) => substitutor.apply(part.trim()))
      .filter((part) => part.length > 0);
  }
  if (!Array.isArray(value)) {
    errors.push("auth.scopes must be a string or array of strings");
    return undefined;
  }
  const scopes: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      errors.push(`auth.scopes[${index}] must be a string`);
      return;
    }
    const resolved = substitutor.apply(entry.trim());
    if (resolved.length > 0) scopes.push(resolved);
  });
  return scopes;
}

function rejectForeignAuthFields(
  kind: string,
  entry: Record<string, unknown>,
  errors: string[],
): void {
  const allowed = AUTH_ALLOWED_FIELDS[kind] ?? new Set<string>();
  for (const key of Object.keys(entry)) {
    if (key === "kind") continue;
    if (!allowed.has(key)) {
      errors.push(`auth kind "${kind}" does not accept field "${key}"`);
    }
  }
}

function buildOauthAuth(
  entry: Record<string, unknown>,
  substitutor: Substitutor,
  errors: string[],
): McpAuthConfig {
  const scopes = parseScopes(entry.scopes, substitutor, errors);
  const clientId =
    entry.clientId !== undefined ? markedString(entry.clientId, "auth.clientId", substitutor, errors) : undefined;
  const clientSecret =
    entry.clientSecret !== undefined
      ? markedString(entry.clientSecret, "auth.clientSecret", substitutor, errors)
      : undefined;
  const resource =
    entry.resource !== undefined ? markedString(entry.resource, "auth.resource", substitutor, errors) : undefined;
  const authorizationServer =
    entry.authorizationServer !== undefined
      ? markedString(entry.authorizationServer, "auth.authorizationServer", substitutor, errors)
      : undefined;
  return {
    kind: "oauth",
    ...(scopes !== undefined ? { scopes } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    ...(resource !== undefined ? { resource } : {}),
    ...(authorizationServer !== undefined ? { authorizationServer } : {}),
  };
}

export function parseAuthBlock(
  raw: unknown,
  substitutor: Substitutor,
  errors: string[],
): McpAuthConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push("auth must be an object");
    return undefined;
  }
  const entry = raw as Record<string, unknown>;
  const kind = typeof entry.kind === "string" ? entry.kind.trim().toLowerCase() : "";
  if (!AUTH_KINDS.has(kind)) {
    errors.push('auth.kind must be one of "none", "bearer", "header", "oauth"');
    return undefined;
  }
  rejectForeignAuthFields(kind, entry, errors);
  if (kind === "none") return { kind: "none" };
  if (kind === "bearer") {
    const token = markedString(entry.token, "auth.token", substitutor, errors);
    if (token === undefined || token.length === 0) {
      errors.push("auth.token is required for bearer auth");
      return undefined;
    }
    return { kind: "bearer", token };
  }
  if (kind === "header") {
    const headers = validateStringMap(entry.headers, "auth.headers", substitutor, errors, true);
    if (Object.keys(headers).length === 0) {
      errors.push("auth.headers must define at least one header for header auth");
      return undefined;
    }
    return { kind: "header", headers };
  }
  return buildOauthAuth(entry, substitutor, errors);
}
