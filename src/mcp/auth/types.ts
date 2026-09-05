import type { McpAuthConfig } from "../types.js";

export interface McpAuthChallenge {
  readonly scheme: string;
  readonly resourceMetadataUrl?: string | undefined;
  readonly scope?: string | undefined;
  readonly error?: string | undefined;
}

export interface McpAuthProvider {
  readonly kind: McpAuthConfig["kind"];
  headers(): Promise<Record<string, string>>;
  onUnauthorized(challenge: McpAuthChallenge | undefined): Promise<boolean>;
  liveSecrets(): readonly string[];
}

export interface ProtectedResourceMetadata {
  readonly resource?: string | undefined;
  readonly authorizationServers: readonly string[];
  readonly scopesSupported: readonly string[];
}

export interface AuthorizationServerMetadata {
  readonly issuer?: string | undefined;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string | undefined;
  readonly deviceAuthorizationEndpoint?: string | undefined;
  readonly scopesSupported: readonly string[];
  readonly codeChallengeMethodsSupported: readonly string[];
}

export interface OAuthTokenSet {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly refreshToken?: string | undefined;
  readonly expiresAt?: number | undefined;
  readonly scope?: string | undefined;
  readonly clientId?: string | undefined;
  readonly clientSecret?: string | undefined;
}

export interface OAuthTokenStore {
  load(key: string): Promise<OAuthTokenSet | undefined>;
  save(key: string, tokens: OAuthTokenSet): Promise<void>;
  remove(key: string): Promise<void>;
  loadForResource?(resource: string): Promise<OAuthTokenSet | undefined>;
}

export interface OAuthClientRegistration {
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
}

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: "S256";
}

export interface LoopbackAuthorizationResult {
  readonly code: string;
  readonly state: string;
  readonly redirectUri: string;
}

export interface DeviceAuthorizationInfo {
  readonly serverUrl: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string | undefined;
  readonly userCode: string;
  readonly expiresInSeconds: number;
}

export interface TokenResponse {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly expiresIn?: number | undefined;
  readonly refreshToken?: string | undefined;
  readonly scope?: string | undefined;
}
