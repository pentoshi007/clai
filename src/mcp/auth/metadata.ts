import { McpTransportError } from "../transport.js";
import { assertSafeDiscoveryUrl } from "./security.js";
import type {
  AuthorizationServerMetadata,
  ProtectedResourceMetadata,
} from "./types.js";

export interface MetadataFetchDeps {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly validateUrl?: ((url: string) => URL) | undefined;
}

const MAX_METADATA_BYTES = 256 * 1024;

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

async function fetchJson(
  url: string,
  deps: MetadataFetchDeps,
): Promise<Record<string, unknown> | undefined> {
  const validate = deps.validateUrl ?? assertSafeDiscoveryUrl;
  const target = validate(url);
  const impl = deps.fetchImpl ?? fetch;
  const response = await impl(target.toString(), {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    throw new McpTransportError("protocol", `MCP OAuth discovery refused a redirect from ${url}.`);
  }
  if (!response.ok) return undefined;
  const text = await response.text();
  if (text.length > MAX_METADATA_BYTES) {
    throw new McpTransportError("too-large", "MCP OAuth metadata document exceeded the size limit.");
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function buildProtectedResourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  const path = url.pathname === "/" ? "" : url.pathname;
  const wellKnown = "/.well-known/oauth-protected-resource";
  url.pathname = `${wellKnown}${path}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function discoverProtectedResourceMetadata(
  metadataUrl: string,
  deps: MetadataFetchDeps = {},
): Promise<ProtectedResourceMetadata> {
  const record = await fetchJson(metadataUrl, deps);
  if (!record) {
    throw new McpTransportError(
      "protocol",
      `MCP protected-resource metadata was unavailable at ${metadataUrl}.`,
    );
  }
  const authorizationServers = stringArray(record.authorization_servers);
  if (authorizationServers.length === 0) {
    throw new McpTransportError(
      "protocol",
      "MCP protected-resource metadata listed no authorization servers.",
    );
  }
  return {
    ...(typeof record.resource === "string" ? { resource: record.resource } : {}),
    authorizationServers,
    scopesSupported: stringArray(record.scopes_supported),
  };
}

export function authorizationServerMetadataCandidates(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  const base = `${url.protocol}//${url.host}`;
  const hasPath = path.length > 0 && path !== "/";
  const suffix = hasPath ? path : "";
  const candidates = [
    `${base}/.well-known/oauth-authorization-server${suffix}`,
    `${base}/.well-known/openid-configuration${suffix}`,
    `${base}${suffix}/.well-known/openid-configuration`,
  ];
  return [...new Set(candidates)];
}

function parseAuthorizationServerMetadata(
  record: Record<string, unknown>,
): AuthorizationServerMetadata | undefined {
  const authorizationEndpoint = record.authorization_endpoint;
  const tokenEndpoint = record.token_endpoint;
  if (typeof authorizationEndpoint !== "string" || typeof tokenEndpoint !== "string") {
    return undefined;
  }
  return {
    ...(typeof record.issuer === "string" ? { issuer: record.issuer } : {}),
    authorizationEndpoint,
    tokenEndpoint,
    ...(typeof record.registration_endpoint === "string"
      ? { registrationEndpoint: record.registration_endpoint }
      : {}),
    scopesSupported: stringArray(record.scopes_supported),
    codeChallengeMethodsSupported: stringArray(record.code_challenge_methods_supported),
  };
}

export async function discoverAuthorizationServerMetadata(
  issuer: string,
  deps: MetadataFetchDeps = {},
): Promise<AuthorizationServerMetadata> {
  for (const candidate of authorizationServerMetadataCandidates(issuer)) {
    const record = await fetchJson(candidate, deps).catch(() => undefined);
    if (!record) continue;
    const parsed = parseAuthorizationServerMetadata(record);
    if (parsed) return parsed;
  }
  throw new McpTransportError(
    "protocol",
    `MCP authorization-server metadata was unavailable for issuer ${issuer}.`,
  );
}
