import { createHash } from "node:crypto";

import {
  resolveProviderProfile,
  type FinalTurnPreservation,
  type ProfileReplayScope,
  type ProfileTriState,
  type ProviderProfile,
  type ProviderProfileLayer,
  type ReasoningDisableForm,
  type ReasoningControlDialect,
  type ReasoningGeneration,
  type ReasoningOutputShape,
} from "./provider-profile.js";
import { customProfileSpecFor } from "./custom-profile-resolver.js";
import {
  catalogLayerFor,
  directDeepSeekV4Layer,
  modelFamilyLayerFor,
} from "./provider-profiles.js";
import type { ReasoningStyle } from "./http.js";
import type { CachePolicyKind, LimitSource } from "./provider-profile.js";
import { customProfileLayer } from "./profile/custom-layer.js";
export { customProfileLayer };
export { validateCustomProviderProfile } from "./profile/spec-validation.js";

export type CustomAuthType = "bearer" | "custom-headers" | "none-keyless";

export interface CustomProviderProfileSpec {
  readonly authType?: CustomAuthType | undefined;
  readonly keyEnv?: string | undefined;
  readonly baseUrlEnv?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly tools?: ProfileTriState | undefined;
  readonly images?: ProfileTriState | undefined;
  readonly structuredOutput?: ProfileTriState | undefined;
  readonly streamOptions?: ProfileTriState | undefined;
  readonly reasoning?:
    | {
        readonly generation?: ReasoningGeneration | undefined;
        readonly controlDialect?: ReasoningControlDialect | undefined;
        readonly acceptedEfforts?: readonly string[] | undefined;
        readonly disable?: ProfileTriState | undefined;
        readonly disableForm?: ReasoningDisableForm | undefined;
        readonly outputShapes?: readonly ReasoningOutputShape[] | undefined;
        readonly replayScope?: ProfileReplayScope | undefined;
        readonly finalTurnPreservation?: FinalTurnPreservation | undefined;
      }
    | undefined;
  readonly limits?:
    | {
        readonly contextTokens?: number | undefined;
        readonly outputTokens?: number | undefined;
        readonly source?: LimitSource | undefined;
      }
    | undefined;
  readonly cache?:
    | {
        readonly kind?: CachePolicyKind | undefined;
        readonly affinityField?: string | undefined;
        readonly isolationField?: string | undefined;
        readonly cacheAffectingFields?: readonly string[] | undefined;
      }
    | undefined;
  readonly usage?:
    | {
        readonly cachedInput?: readonly string[] | undefined;
        readonly uncachedInput?: readonly string[] | undefined;
        readonly cacheWrite?: readonly string[] | undefined;
        readonly reasoningOutput?: readonly string[] | undefined;
      }
    | undefined;
  readonly terminal?:
    | {
        readonly naturalEofAccepted?: boolean | undefined;
      }
    | undefined;
}

export function endpointPrivacyHash(baseUrl: string): string {
  return `sha256:${createHash("sha256")
    .update(baseUrl.replace(/\/$/, ""))
    .digest("hex")}`;
}

function isDirectDeepSeekRoute(baseUrl: string, model: string): boolean {
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    (host === "api.deepseek.com" || host.endsWith(".deepseek.com")) &&
    /deepseek-v\d/i.test(model)
  );
}

export function resolveCustomProviderProfile(input: {
  id: string;
  model: string;
  baseUrl: string;
  profile?: CustomProviderProfileSpec | undefined;
}): ProviderProfile {
  const layers: {
    userConfig?: ProviderProfileLayer;
    builtin?: ProviderProfileLayer;
    catalog?: ProviderProfileLayer;
    modelFamily?: ProviderProfileLayer;
  } = {};
  const userLayer = customProfileLayer(input.profile);
  if (userLayer) layers.userConfig = userLayer;
  if (isDirectDeepSeekRoute(input.baseUrl, input.model)) {
    layers.builtin = directDeepSeekV4Layer();
  }
  const catalog = catalogLayerFor(input.id, input.model);
  if (catalog) layers.catalog = catalog;
  const modelFamily = modelFamilyLayerFor(input.id, input.model);
  if (modelFamily) layers.modelFamily = modelFamily;
  return resolveProviderProfile({
    provider: input.id,
    model: input.model,
    wireApi: "chat-completions",
    endpointHash: endpointPrivacyHash(input.baseUrl),
    layers,
  });
}

export function customProviderProfileFor(input: {
  provider: string;
  model: string;
  baseUrl: string;
}): ProviderProfile | undefined {
  const spec = customProfileSpecFor(input.provider);
  return resolveCustomProviderProfile({
    id: input.provider,
    model: input.model,
    baseUrl: input.baseUrl,
    ...(spec ? { profile: spec } : {}),
  });
}

export function customReasoningStyle(
  profile: CustomProviderProfileSpec | undefined,
): ReasoningStyle {
  const dialect = profile?.reasoning?.controlDialect;
  return dialect === "openai-effort" ? "openai" : "none";
}

export function resolveCustomHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value.trim());
    if (!match) {
      resolved[name] = value;
      continue;
    }
    const envValue = process.env[match[1]!]?.trim();
    if (!envValue) {
      throw new Error(
        `custom provider header ${name} references unset environment variable ${match[1]}`,
      );
    }
    resolved[name] = envValue;
  }
  return resolved;
}
