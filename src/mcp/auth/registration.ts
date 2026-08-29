import { McpTransportError } from "../transport.js";
import { assertSafeDiscoveryUrl } from "./security.js";
import type { OAuthClientRegistration } from "./types.js";

export interface RegistrationParams {
  readonly registrationEndpoint: string;
  readonly redirectUris: readonly string[];
  readonly clientName: string;
  readonly scope?: string | undefined;
}

export interface RegistrationDeps {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly validateUrl?: ((url: string) => URL) | undefined;
}

export async function registerOAuthClient(
  params: RegistrationParams,
  deps: RegistrationDeps = {},
): Promise<OAuthClientRegistration> {
  const validate = deps.validateUrl ?? assertSafeDiscoveryUrl;
  const target = validate(params.registrationEndpoint);
  const impl = deps.fetchImpl ?? fetch;
  const body = {
    client_name: params.clientName,
    redirect_uris: [...params.redirectUris],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(params.scope ? { scope: params.scope } : {}),
  };
  const response = await impl(target.toString(), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new McpTransportError(
      "protocol",
      `MCP OAuth dynamic client registration failed with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}.`,
    );
  }
  const record = (await response.json().catch(() => undefined)) as
    | Record<string, unknown>
    | undefined;
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
    ...(typeof clientSecret === "string" && clientSecret.length > 0
      ? { clientSecret }
      : {}),
  };
}
