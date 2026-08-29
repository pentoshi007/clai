import { McpTransportError } from "../transport.js";
import { assertSafeDiscoveryUrl } from "./security.js";
import type { TokenResponse } from "./types.js";

export interface TokenEndpointDeps {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly validateUrl?: ((url: string) => URL) | undefined;
}

export interface ExchangeAuthorizationCodeParams {
  readonly tokenEndpoint: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
  readonly codeVerifier: string;
  readonly resource?: string | undefined;
}

export interface RefreshAccessTokenParams {
  readonly tokenEndpoint: string;
  readonly refreshToken: string;
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
  readonly resource?: string | undefined;
  readonly scope?: string | undefined;
}

function applySecret(
  form: URLSearchParams,
  headers: Record<string, string>,
  clientId: string,
  clientSecret: string | undefined,
): void {
  if (clientSecret === undefined) return;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  headers.authorization = `Basic ${basic}`;
}

async function postToken(
  tokenEndpoint: string,
  form: URLSearchParams,
  headers: Record<string, string>,
  deps: TokenEndpointDeps,
): Promise<TokenResponse> {
  const validate = deps.validateUrl ?? assertSafeDiscoveryUrl;
  const target = validate(tokenEndpoint);
  const impl = deps.fetchImpl ?? fetch;
  const response = await impl(target.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      ...headers,
    },
    body: form.toString(),
    redirect: "manual",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new McpTransportError(
      "protocol",
      `MCP OAuth token request failed with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}.`,
    );
  }
  const record = (await response.json().catch(() => undefined)) as
    | Record<string, unknown>
    | undefined;
  const accessToken = record?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new McpTransportError("protocol", "MCP OAuth token response had no access_token.");
  }
  return {
    accessToken,
    tokenType: typeof record?.token_type === "string" ? record.token_type : "Bearer",
    ...(typeof record?.expires_in === "number" ? { expiresIn: record.expires_in } : {}),
    ...(typeof record?.refresh_token === "string" ? { refreshToken: record.refresh_token } : {}),
    ...(typeof record?.scope === "string" ? { scope: record.scope } : {}),
  };
}

export async function exchangeAuthorizationCode(
  params: ExchangeAuthorizationCodeParams,
  deps: TokenEndpointDeps = {},
): Promise<TokenResponse> {
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("code", params.code);
  form.set("redirect_uri", params.redirectUri);
  form.set("client_id", params.clientId);
  form.set("code_verifier", params.codeVerifier);
  if (params.resource) form.set("resource", params.resource);
  const headers: Record<string, string> = {};
  applySecret(form, headers, params.clientId, params.clientSecret);
  return postToken(params.tokenEndpoint, form, headers, deps);
}

export async function refreshAccessToken(
  params: RefreshAccessTokenParams,
  deps: TokenEndpointDeps = {},
): Promise<TokenResponse> {
  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", params.refreshToken);
  form.set("client_id", params.clientId);
  if (params.resource) form.set("resource", params.resource);
  if (params.scope) form.set("scope", params.scope);
  const headers: Record<string, string> = {};
  applySecret(form, headers, params.clientId, params.clientSecret);
  return postToken(params.tokenEndpoint, form, headers, deps);
}
