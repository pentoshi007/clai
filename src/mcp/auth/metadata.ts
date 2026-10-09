import { McpTransportError } from "../transport.js";
import { assertSafeDiscoveryUrl } from "./security.js";
import { fetchOAuthJson, type OAuthHttpDeps } from "./http.js";
import type { AuthorizationServerMetadata, ProtectedResourceMetadata } from "./types.js";

export interface MetadataFetchDeps extends OAuthHttpDeps {}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

async function fetchJson(
  url: string,
  deps: MetadataFetchDeps,
): Promise<Record<string, unknown> | undefined> {
  const response = await fetchOAuthJson(
    url,
    {
      method: "GET",
      headers: { accept: "application/json" },
    },
    deps,
  );
  if (!response.ok) return undefined;
  return response.record;
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
    ...(typeof record.device_authorization_endpoint === "string"
      ? { deviceAuthorizationEndpoint: record.device_authorization_endpoint }
      : {}),
    scopesSupported: stringArray(record.scopes_supported),
    codeChallengeMethodsSupported: stringArray(record.code_challenge_methods_supported),
    tokenEndpointAuthMethodsSupported: stringArray(record.token_endpoint_auth_methods_supported),
  };
}

export async function discoverAuthorizationServerMetadata(
  issuer: string,
  deps: MetadataFetchDeps = {},
): Promise<AuthorizationServerMetadata> {
  for (const candidate of authorizationServerMetadataCandidates(issuer)) {
    deps.signal?.throwIfAborted();
    const record = await fetchJson(candidate, deps).catch((error: unknown) => {
      if (
        deps.signal?.aborted ||
        (error instanceof McpTransportError &&
          ["too-large", "timeout", "cancelled"].includes(error.kind))
      )
        throw error;
      return undefined;
    });
    if (!record) continue;
    const parsed = parseAuthorizationServerMetadata(record);
    if (parsed) {
      if (parsed.issuer && parsed.issuer.replace(/\/+$/, "") !== issuer.replace(/\/+$/, "")) {
        throw new McpTransportError(
          "protocol",
          "MCP authorization-server metadata issuer did not match the requested issuer.",
        );
      }
      const validate = deps.validateUrl ?? assertSafeDiscoveryUrl;
      validate(parsed.authorizationEndpoint);
      validate(parsed.tokenEndpoint);
      if (parsed.registrationEndpoint) validate(parsed.registrationEndpoint);
      if (parsed.deviceAuthorizationEndpoint) validate(parsed.deviceAuthorizationEndpoint);
      return parsed;
    }
  }
  throw new McpTransportError(
    "protocol",
    `MCP authorization-server metadata was unavailable for issuer ${issuer}.`,
  );
}
