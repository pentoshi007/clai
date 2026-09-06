import type { McpAuthConfig } from "../types.js";
import { McpTransportError } from "../transport.js";
import {
  buildProtectedResourceMetadataUrl,
  discoverAuthorizationServerMetadata,
  discoverProtectedResourceMetadata,
  type MetadataFetchDeps,
} from "./metadata.js";
import { createPkcePair } from "./pkce.js";
import { registerOAuthClient } from "./registration.js";
import {
  runLoopbackAuthorization,
  type LoopbackAuthorizationParams,
} from "./loopback.js";
import {
  pollDeviceTokens,
  requestDeviceAuthorization,
} from "./device.js";
import { canonicalResourceUri } from "./security.js";
import {
  findGithubCredential,
  githubCredentialHint,
  isGithubHost,
  type HostCredentialDeps,
} from "./host-credentials.js";
import {
  exchangeAuthorizationCode,
  refreshAccessToken,
  type TokenEndpointDeps,
} from "./token-exchange.js";
import { defaultOAuthTokenStore, oauthTokenKey } from "./token-store.js";
import type {
  AuthorizationServerMetadata,
  DeviceAuthorizationInfo,
  LoopbackAuthorizationResult,
  McpAuthChallenge,
  McpAuthProvider,
  OAuthClientRegistration,
  OAuthTokenSet,
  OAuthTokenStore,
  PkcePair,
  TokenResponse,
} from "./types.js";

const REFRESH_SKEW_MS = 60_000;
const DEFAULT_CLIENT_NAME = "clai";

export interface OAuthConsentInfo {
  readonly serverUrl: string;
  readonly issuer: string | undefined;
  readonly authorizationEndpoint: string;
  readonly scope: string | undefined;
  readonly message?: string | undefined;
}

export interface AuthProviderDeps {
  readonly serverUrl: string;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
  readonly tokenStore?: OAuthTokenStore | undefined;
  readonly openBrowser?: ((url: string) => Promise<void>) | undefined;
  readonly requestConsent?: ((info: OAuthConsentInfo) => Promise<boolean>) | undefined;
  readonly interactive?: boolean | undefined;
  readonly clientName?: string | undefined;
  readonly validateUrl?: ((url: string) => URL) | undefined;
  readonly runLoopback?:
    | ((params: LoopbackAuthorizationParams) => Promise<LoopbackAuthorizationResult>)
    | undefined;
  readonly onDeviceAuthorization?:
    | ((info: DeviceAuthorizationInfo) => void | Promise<void>)
    | undefined;
  readonly onAuthorizationUrl?:
    | ((info: { serverUrl: string; url: string }) => void)
    | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  readonly readHostToken?: (() => Promise<string | undefined>) | undefined;
}

function bearerHeader(tokenType: string, accessToken: string): Record<string, string> {
  const raw = tokenType.trim();
  const scheme = raw.length === 0 || raw.toLowerCase() === "bearer" ? "Bearer" : raw;
  return { authorization: `${scheme} ${accessToken}` };
}

class NoAuthProvider implements McpAuthProvider {
  readonly kind = "none" as const;
  async headers(): Promise<Record<string, string>> {
    return {};
  }
  async onUnauthorized(): Promise<boolean> {
    return false;
  }
  liveSecrets(): readonly string[] {
    return [];
  }
}

class BearerAuthProvider implements McpAuthProvider {
  readonly kind = "bearer" as const;
  constructor(private readonly token: string) {}
  async headers(): Promise<Record<string, string>> {
    return bearerHeader("Bearer", this.token);
  }
  async onUnauthorized(): Promise<boolean> {
    return false;
  }
  liveSecrets(): readonly string[] {
    return this.token.length > 0 ? [this.token] : [];
  }
}

class HeaderAuthProvider implements McpAuthProvider {
  readonly kind = "header" as const;
  constructor(private readonly staticHeaders: Readonly<Record<string, string>>) {}
  async headers(): Promise<Record<string, string>> {
    return { ...this.staticHeaders };
  }
  async onUnauthorized(): Promise<boolean> {
    return false;
  }
  liveSecrets(): readonly string[] {
    return Object.values(this.staticHeaders).filter((value) => value.length > 0);
  }
}

class OAuthProvider implements McpAuthProvider {
  readonly kind = "oauth" as const;
  private cached: OAuthTokenSet | undefined;
  private metadata: AuthorizationServerMetadata | undefined;
  private issuer: string | undefined;
  private clientId: string | undefined;
  private clientSecret: string | undefined;
  private scope: string | undefined;
  private resource: string;
  private warmed = false;
  private inFlight: Promise<boolean> | undefined;
  private readonly store: OAuthTokenStore;

  constructor(
    private readonly config: Extract<McpAuthConfig, { kind: "oauth" }>,
    private readonly deps: AuthProviderDeps,
  ) {
    this.resource = canonicalResourceUri(config.resource ?? deps.serverUrl);
    this.store = deps.tokenStore ?? defaultOAuthTokenStore;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private metadataDeps(): MetadataFetchDeps {
    return {
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.validateUrl ? { validateUrl: this.deps.validateUrl } : {}),
    };
  }

  private tokenDeps(): TokenEndpointDeps {
    return this.metadataDeps();
  }

  private isValid(tokens: OAuthTokenSet): boolean {
    if (tokens.expiresAt === undefined) return true;
    return tokens.expiresAt - this.now() > REFRESH_SKEW_MS;
  }

  async headers(): Promise<Record<string, string>> {
    const tokens = (await this.warmCached()) ?? this.cached;
    if (!tokens) return {};
    if (this.isValid(tokens)) return bearerHeader(tokens.tokenType, tokens.accessToken);
    if (tokens.refreshToken && this.metadata) {
      const refreshed = await this.tryRefresh(tokens).catch(() => undefined);
      if (refreshed) return bearerHeader(refreshed.tokenType, refreshed.accessToken);
    }
    return {};
  }

  private async warmCached(): Promise<OAuthTokenSet | undefined> {
    if (this.cached) return this.cached;
    if (this.warmed) return undefined;
    this.warmed = true;
    const stored = await this.store
      .loadForResource?.(this.resource)
      .catch(() => undefined);
    if (stored) {
      this.applyStoredClient(stored);
      this.cached = stored;
      return stored;
    }
    return this.adoptHostCredential();
  }

  private async adoptHostCredential(): Promise<OAuthTokenSet | undefined> {
    const credential = await findGithubCredential(
      this.deps.serverUrl,
      this.hostCredentialDeps(),
    ).catch(() => undefined);
    if (!credential) return undefined;
    this.cached = { accessToken: credential.token, tokenType: "Bearer" };
    return this.cached;
  }

  private hostCredentialDeps(): HostCredentialDeps {
    return {
      ...(this.deps.env ? { env: this.deps.env } : {}),
      ...(this.deps.readHostToken ? { readCliToken: this.deps.readHostToken } : {}),
    };
  }

  private canInteract(): boolean {
    return this.deps.interactive !== false && typeof this.deps.openBrowser === "function";
  }

  private reauthMessage(): string {
    return (
      `MCP server ${this.deps.serverUrl} requires OAuth sign-in and no browser is available here. ` +
      "Re-authenticate in an interactive session with /mcp login or the mcp.login tool."
    );
  }

  private missingClientMessage(): string {
    const issuer = this.issuer ?? "its authorization server";
    const deviceNote = this.metadata?.deviceAuthorizationEndpoint
      ? " The server supports device-code sign-in, but it still needs an OAuth client id."
      : "";
    const remedy = isGithubHost(this.deps.serverUrl)
      ? `${githubCredentialHint()}, run \`gh auth login\` so clai can reuse that credential, or add a token explicitly — `
      : "Add a token instead — ";
    return (
      `MCP server ${this.deps.serverUrl} cannot complete OAuth: ${issuer} does not support ` +
      `dynamic client registration, so clai has no client to sign in with.${deviceNote} ${remedy}` +
      '"auth": {"kind": "bearer", "token": "${env:YOUR_TOKEN}"} — ' +
      'or register an OAuth app and set "auth": {"kind": "oauth", "clientId": "…"} ' +
      "in the server entry of .clai/mcp.json."
    );
  }

  private async discoverEndpoints(
    challenge: McpAuthChallenge | undefined,
  ): Promise<{ issuer: string; metadata: AuthorizationServerMetadata; scopes: readonly string[] }> {
    const metadataUrl =
      challenge?.resourceMetadataUrl ?? buildProtectedResourceMetadataUrl(this.resource);
    const prm = await discoverProtectedResourceMetadata(metadataUrl, this.metadataDeps());
    if (prm.resource) this.resource = canonicalResourceUri(prm.resource);
    const issuer = this.config.authorizationServer ?? prm.authorizationServers[0]!;
    const metadata = await discoverAuthorizationServerMetadata(issuer, this.metadataDeps());
    return { issuer, metadata, scopes: prm.scopesSupported };
  }

  private cacheMetadata(issuer: string, metadata: AuthorizationServerMetadata): void {
    this.issuer = issuer;
    this.metadata = metadata;
  }

  private resolveScope(
    prmScopes: readonly string[],
    metadata: AuthorizationServerMetadata,
    challenge: McpAuthChallenge | undefined,
  ): string | undefined {
    if (this.config.scopes && this.config.scopes.length > 0) return this.config.scopes.join(" ");
    if (challenge?.scope) return challenge.scope;
    if (prmScopes.length > 0) return prmScopes.join(" ");
    if (metadata.scopesSupported.length > 0) return metadata.scopesSupported.join(" ");
    return undefined;
  }

  private async reuseStored(issuer: string): Promise<boolean> {
    const stored = await this.store.load(oauthTokenKey(this.resource, issuer));
    if (!stored) return false;
    this.applyStoredClient(stored);
    if (this.isValid(stored)) {
      this.cached = stored;
      return true;
    }
    this.cached = stored;
    return false;
  }

  private applyStoredClient(stored: OAuthTokenSet): void {
    if (!this.clientId && stored.clientId) this.clientId = stored.clientId;
    if (!this.clientSecret && stored.clientSecret) this.clientSecret = stored.clientSecret;
    if (!this.scope && stored.scope) this.scope = stored.scope;
  }

  private async refreshStored(
    issuer: string,
    metadata: AuthorizationServerMetadata,
    scope: string | undefined,
  ): Promise<boolean> {
    const tokens = this.cached;
    if (!tokens?.refreshToken || !this.clientId) return false;
    this.scope = scope ?? this.scope;
    const refreshed = await this.tryRefresh(tokens).catch(() => undefined);
    return refreshed !== undefined;
  }

  private async tryRefresh(tokens: OAuthTokenSet): Promise<OAuthTokenSet | undefined> {
    if (!tokens.refreshToken || !this.clientId || !this.metadata || !this.issuer) return undefined;
    const response = await refreshAccessToken(
      {
        tokenEndpoint: this.metadata.tokenEndpoint,
        refreshToken: tokens.refreshToken,
        clientId: this.clientId,
        ...(this.clientSecret ? { clientSecret: this.clientSecret } : {}),
        resource: this.resource,
        ...(this.scope ? { scope: this.scope } : {}),
      },
      this.tokenDeps(),
    );
    const next = this.toTokenSet(response, tokens.refreshToken);
    await this.persist(this.issuer, next);
    return next;
  }

  private async ensureClient(
    metadata: AuthorizationServerMetadata,
    scope: string | undefined,
    redirectUris: readonly string[],
  ): Promise<OAuthClientRegistration> {
    if (this.clientId) {
      return {
        clientId: this.clientId,
        ...(this.clientSecret ? { clientSecret: this.clientSecret } : {}),
      };
    }
    if (!metadata.registrationEndpoint) {
      throw new McpTransportError("protocol", this.missingClientMessage());
    }
    const registration = await registerOAuthClient(
      {
        registrationEndpoint: metadata.registrationEndpoint,
        redirectUris,
        clientName: this.deps.clientName ?? DEFAULT_CLIENT_NAME,
        ...(scope ? { scope } : {}),
      },
      this.metadataDeps(),
    );
    this.clientId = registration.clientId;
    this.clientSecret = registration.clientSecret;
    return registration;
  }

  private authorizationUrlBuilder(
    metadata: AuthorizationServerMetadata,
    clientId: string,
    scope: string | undefined,
    pkce: PkcePair,
  ): (redirectUri: string, state: string) => string {
    return (redirectUri, state) => {
      const url = new URL(metadata.authorizationEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", pkce.challenge);
      url.searchParams.set("code_challenge_method", pkce.method);
      url.searchParams.set("resource", this.resource);
      if (scope) url.searchParams.set("scope", scope);
      return url.toString();
    };
  }

  private async requireConsent(
    metadata: AuthorizationServerMetadata,
    scope: string | undefined,
  ): Promise<void> {
    if (!this.deps.requestConsent) return;
    const ok = await this.deps.requestConsent({
      serverUrl: this.deps.serverUrl,
      issuer: this.issuer,
      authorizationEndpoint: metadata.authorizationEndpoint,
      scope,
    });
    if (!ok) throw new McpTransportError("network", "MCP OAuth authorization was declined.");
  }

  private async runFullFlow(
    metadata: AuthorizationServerMetadata,
    scope: string | undefined,
  ): Promise<void> {
    this.scope = scope ?? this.scope;
    const approved = await this.requestLoopbackConsent(metadata);
    if (!approved) {
      if (this.canDeviceFlow(metadata)) {
        await this.runDeviceFlow(metadata, scope);
        return;
      }
      throw new McpTransportError("network", "MCP OAuth authorization was declined.");
    }
    const pkce = createPkcePair();
    const loopback = this.deps.runLoopback ?? runLoopbackAuthorization;
    const bootstrapClientId = this.clientId ?? this.deps.clientName ?? DEFAULT_CLIENT_NAME;
    let registration: OAuthClientRegistration = {
      clientId: bootstrapClientId,
      ...(this.clientSecret ? { clientSecret: this.clientSecret } : {}),
    };
    const result = await loopback({
      buildAuthorizationUrl: async (redirectUri, state) => {
        registration = await this.ensureClient(metadata, scope, [redirectUri]);
        return this.authorizationUrlBuilder(metadata, registration.clientId, scope, pkce)(
          redirectUri,
          state,
        );
      },
      openBrowser: this.deps.openBrowser!,
      ...(this.deps.onAuthorizationUrl
        ? {
            onAuthorizationUrl: (url: string) => {
              this.deps.onAuthorizationUrl?.({ serverUrl: this.deps.serverUrl, url });
            },
          }
        : {}),
    });
    const response = await exchangeAuthorizationCode(
      {
        tokenEndpoint: metadata.tokenEndpoint,
        code: result.code,
        redirectUri: result.redirectUri,
        clientId: registration.clientId,
        ...(registration.clientSecret ? { clientSecret: registration.clientSecret } : {}),
        codeVerifier: pkce.verifier,
        resource: this.resource,
      },
      this.tokenDeps(),
    );
    const next = this.toTokenSet(response, undefined);
    await this.persist(this.issuer, next);
  }

  private canDeviceFlow(metadata: AuthorizationServerMetadata): boolean {
    return (
      typeof metadata.deviceAuthorizationEndpoint === "string" &&
      this.deps.onDeviceAuthorization !== undefined
    );
  }

  private async requestLoopbackConsent(
    metadata: AuthorizationServerMetadata,
  ): Promise<boolean> {
    if (!this.deps.requestConsent) return true;
    return this.deps.requestConsent({
      serverUrl: this.deps.serverUrl,
      issuer: this.issuer,
      authorizationEndpoint: metadata.authorizationEndpoint,
      scope: this.scope,
      message: "Open the browser to sign in? (a sign-in link will be shown either way)",
    });
  }

  private async ensureDeviceClient(
    metadata: AuthorizationServerMetadata,
    scope: string | undefined,
  ): Promise<OAuthClientRegistration> {
    if (this.clientId) {
      return {
        clientId: this.clientId,
        ...(this.clientSecret ? { clientSecret: this.clientSecret } : {}),
      };
    }
    if (!metadata.registrationEndpoint) {
      throw new McpTransportError("protocol", this.missingClientMessage());
    }
    const registration = await registerOAuthClient(
      {
        registrationEndpoint: metadata.registrationEndpoint,
        redirectUris: [],
        clientName: this.deps.clientName ?? DEFAULT_CLIENT_NAME,
        ...(scope ? { scope } : {}),
        deviceFlow: true,
      },
      this.metadataDeps(),
    );
    this.clientId = registration.clientId;
    this.clientSecret = registration.clientSecret;
    return registration;
  }

  private async runDeviceFlow(
    metadata: AuthorizationServerMetadata,
    scope: string | undefined,
  ): Promise<void> {
    const endpoint = metadata.deviceAuthorizationEndpoint;
    if (!endpoint) {
      throw new McpTransportError("protocol", "MCP OAuth server has no device authorization endpoint.");
    }
    await this.requireConsent(metadata, scope);
    const registration = await this.ensureDeviceClient(metadata, scope);
    const authorization = await requestDeviceAuthorization(
      {
        deviceAuthorizationEndpoint: endpoint,
        clientId: registration.clientId,
        ...(scope ? { scope } : {}),
      },
      this.metadataDeps(),
    );
    const info: DeviceAuthorizationInfo = {
      serverUrl: this.deps.serverUrl,
      verificationUri: authorization.verificationUri,
      ...(authorization.verificationUriComplete
        ? { verificationUriComplete: authorization.verificationUriComplete }
        : {}),
      userCode: authorization.userCode,
      expiresInSeconds: authorization.expiresInSeconds,
    };
    await this.deps.onDeviceAuthorization?.(info);
    const response = await pollDeviceTokens(
      {
        tokenEndpoint: metadata.tokenEndpoint,
        deviceCode: authorization.deviceCode,
        clientId: registration.clientId,
        ...(registration.clientSecret
          ? { clientSecret: registration.clientSecret }
          : {}),
        intervalSeconds: authorization.intervalSeconds,
        expiresInSeconds: authorization.expiresInSeconds,
      },
      this.tokenDeps(),
    );
    const next = this.toTokenSet(response, undefined);
    await this.persist(this.issuer, next);
  }

  private toTokenSet(response: TokenResponse, fallbackRefresh: string | undefined): OAuthTokenSet {
    const refreshToken = response.refreshToken ?? fallbackRefresh;
    return {
      accessToken: response.accessToken,
      tokenType: response.tokenType,
      ...(refreshToken ? { refreshToken } : {}),
      ...(response.expiresIn !== undefined
        ? { expiresAt: this.now() + response.expiresIn * 1000 }
        : {}),
      ...(response.scope ?? this.scope ? { scope: response.scope ?? this.scope } : {}),
      ...(this.clientId ? { clientId: this.clientId } : {}),
      ...(this.clientSecret ? { clientSecret: this.clientSecret } : {}),
    };
  }

  private async persist(issuer: string | undefined, tokens: OAuthTokenSet): Promise<void> {
    this.cached = tokens;
    if (!issuer) return;
    await this.store.save(oauthTokenKey(this.resource, issuer), tokens);
  }

  async onUnauthorized(challenge: McpAuthChallenge | undefined): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    const attempt = this.authorize(challenge);
    this.inFlight = attempt;
    try {
      return await attempt;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async authorize(challenge: McpAuthChallenge | undefined): Promise<boolean> {
    const { issuer, metadata, scopes } = await this.discoverEndpoints(challenge);
    this.cacheMetadata(issuer, metadata);
    if (await this.reuseStored(issuer)) return true;
    const scope = this.resolveScope(scopes, metadata, challenge);
    this.scope = scope ?? this.scope;
    if (await this.refreshStored(issuer, metadata, scope)) return true;
    if (!this.clientId && !metadata.registrationEndpoint) {
      if (await this.adoptHostCredential()) return true;
    }
    if (this.canDeviceFlow(metadata)) {
      await this.runDeviceFlow(metadata, scope);
      return true;
    }
    if (this.canInteract()) {
      try {
        await this.runFullFlow(metadata, scope);
        return true;
      } catch (error) {
        const browserUnavailable =
          error instanceof McpTransportError && error.kind === "browser";
        if (!browserUnavailable || !this.canDeviceFlow(metadata)) throw error;
        await this.runDeviceFlow(metadata, scope);
        return true;
      }
    }
    throw new McpTransportError("network", this.reauthMessage());
  }

  liveSecrets(): readonly string[] {
    const secrets: string[] = [];
    if (this.cached?.accessToken) secrets.push(this.cached.accessToken);
    if (this.cached?.refreshToken) secrets.push(this.cached.refreshToken);
    if (this.clientSecret) secrets.push(this.clientSecret);
    return secrets;
  }
}

export function createAuthProvider(
  config: McpAuthConfig | undefined,
  deps: AuthProviderDeps,
): McpAuthProvider {
  if (!config || config.kind === "none") return new NoAuthProvider();
  if (config.kind === "bearer") return new BearerAuthProvider(config.token);
  if (config.kind === "header") return new HeaderAuthProvider(config.headers);
  return new OAuthProvider(config, deps);
}
