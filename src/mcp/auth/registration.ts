import { McpTransportError } from "../transport.js";
import { fetchOAuthJson, oauthErrorDetail, type OAuthHttpDeps } from "./http.js";
import type { OAuthClientRegistration } from "./types.js";

export interface RegistrationParams {
  readonly registrationEndpoint: string;
  readonly redirectUris: readonly string[];
  readonly clientName: string;
  readonly scope?: string | undefined;
  readonly deviceFlow?: boolean | undefined;
}

export interface RegistrationDeps extends OAuthHttpDeps {}

export async function registerOAuthClient(
  params: RegistrationParams,
  deps: RegistrationDeps = {},
): Promise<OAuthClientRegistration> {
  const body = {
    client_name: params.clientName,
    redirect_uris: [...params.redirectUris],
    grant_types: params.deviceFlow
      ? ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"]
      : ["authorization_code", "refresh_token"],
    response_types: params.deviceFlow ? [] : ["code"],
    token_endpoint_auth_method: "none",
    ...(params.scope ? { scope: params.scope } : {}),
  };
  const response = await fetchOAuthJson(
    params.registrationEndpoint,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    },
    deps,
  );
  if (!response.ok) {
    throw new McpTransportError(
      "protocol",
      `MCP OAuth dynamic client registration failed with ${response.status}${oauthErrorDetail(response.record)}.`,
    );
  }
  const record = response.record;
  const clientId = record?.client_id;
  if (typeof clientId !== "string" || clientId.length === 0) {
    throw new McpTransportError(
      "protocol",
      "MCP OAuth dynamic client registration returned no client_id.",
    );
  }
  const clientSecret = record?.client_secret;
  return {
    clientId,
    ...(typeof clientSecret === "string" && clientSecret.length > 0 ? { clientSecret } : {}),
  };
}
