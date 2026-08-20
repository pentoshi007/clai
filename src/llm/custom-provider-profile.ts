import { createHash } from "node:crypto";

import {
  CHAT_COMPLETIONS_TERMINAL_PROOFS,
  resolveProviderProfile,
  type FinalTurnPreservation,
  type ProfileEvidence,
  type ProfileReplayScope,
  type ProfileTriState,
  type ProviderProfile,
  type ProviderProfileLayer,
  type ProviderProfileSourceLayers,
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
import type {
  CachePolicyKind,
  LimitSource,
} from "./provider-profile.js";

export type CustomAuthType =
  | "bearer"
  | "custom-headers"
  | "none-keyless";

/** Serializable wire subset a custom route may declare. */
export interface CustomProviderProfileSpec {
  readonly authType?: CustomAuthType | undefined;
  readonly keyEnv?: string | undefined;
  readonly baseUrlEnv?: string | undefined;
  /** Values may be literals or `${ENV_NAME}` references. */
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

const USER_EVIDENCE: ProfileEvidence = {
  source: "user-config",
  confidence: "exact",
};

const ALLOWED_KEYS = [
  "authType",
  "keyEnv",
  "baseUrlEnv",
  "headers",
  "tools",
  "images",
  "structuredOutput",
  "streamOptions",
  "reasoning",
  "limits",
  "cache",
  "usage",
  "terminal",
] as const;

const ALLOWED_REASONING_KEYS = [
  "generation",
  "controlDialect",
  "acceptedEfforts",
  "disable",
  "disableForm",
  "outputShapes",
  "replayScope",
  "finalTurnPreservation",
] as const;

const ALLOWED_LIMIT_KEYS = ["contextTokens", "outputTokens", "source"] as const;
const ALLOWED_CACHE_KEYS = [
  "kind",
  "affinityField",
  "isolationField",
  "cacheAffectingFields",
] as const;
const ALLOWED_USAGE_KEYS = [
  "cachedInput",
  "uncachedInput",
  "cacheWrite",
  "reasoningOutput",
] as const;
const ALLOWED_TERMINAL_KEYS = ["naturalEofAccepted"] as const;

const AUTH_TYPES: readonly CustomAuthType[] = [
  "bearer",
  "custom-headers",
  "none-keyless",
];
const TRI_STATES: readonly ProfileTriState[] = [
  "supported",
  "unsupported",
  "unknown",
];
const GENERATIONS: readonly ReasoningGeneration[] = [
  "none",
  "optional",
  "default-on",
  "mandatory",
  "unknown",
];
const CONTROL_DIALECTS: readonly ReasoningControlDialect[] = [
  "openai-effort",
  "openai-nested-reasoning",
  "anthropic-thinking",
  "deepseek-thinking",
  "qwen-enable-thinking",
  "kimi-template-thinking",
  "glm-enable-thinking",
  "chat-template-thinking",
  "nemotron-reasoning-budget",
  "gemini-thinking-config",
  "meta-reasoning-effort",
  "ollama-think",
  "groq-model-specific",
  "modal-advertised-effort",
  "openrouter-reasoning-max-tokens",
  "none",
];
const OUTPUT_SHAPES: readonly ReasoningOutputShape[] = [
  "reasoning-content",
  "reasoning-field",
  "signed-thinking-block",
  "thought-signature",
  "encrypted-reasoning-items",
  "structured-details",
  "ollama-thinking",
];
const REPLAY_SCOPES: readonly ProfileReplayScope[] = [
  "none",
  "tool-turn",
  "next-turn",
  "all-history",
  "server-state",
  "configurable",
];
const PRESERVATIONS: readonly FinalTurnPreservation[] = [
  "required",
  "supported",
  "unsupported",
  "unknown",
];
const CACHE_KINDS: readonly CachePolicyKind[] = [
  "automatic-prefix",
  "affinity-key",
  "explicit-breakpoint",
  "none-documented",
  "unknown",
];
const LIMIT_SOURCES: readonly LimitSource[] = [
  "provider-doc",
  "catalog",
  "user-config",
  "family-default",
  "unknown",
];
const EFFORT_DIALECT_DISABLE_FORMS: readonly ReasoningDisableForm[] = [
  "effort-none",
  "effort-minimal-floor",
  "omit-control",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : undefined;
}

function stringList(
  value: unknown,
  errors: string[],
  field: string,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      errors.push(`${field} entries must be non-empty strings`);
      return undefined;
    }
    list.push(entry.trim());
  }
  return list;
}

/**
 * Local, actionable validation. Nothing here performs a network call; the goal
 * is that an invalid declaration fails before any request is dispatched.
 */
export function validateCustomProviderProfile(
  raw: unknown,
): { spec?: CustomProviderProfileSpec; errors: string[] } {
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { errors };
  if (!isRecord(raw)) {
    return { errors: ["profile must be an object"] };
  }
  for (const key of Object.keys(raw)) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
      errors.push(
        `unknown profile field "${key}" (allowed: ${ALLOWED_KEYS.join(", ")})`,
      );
    }
  }

  const authType = oneOf(raw.authType, AUTH_TYPES);
  if (raw.authType !== undefined && authType === undefined) {
    errors.push(
      `authType must be one of ${AUTH_TYPES.join(", ")} (query auth is not supported yet)`,
    );
  }
  const keyEnv =
    typeof raw.keyEnv === "string" && raw.keyEnv.trim()
      ? raw.keyEnv.trim()
      : undefined;
  if (raw.keyEnv !== undefined && keyEnv === undefined) {
    errors.push("keyEnv must be a non-empty string");
  }
  const baseUrlEnv =
    typeof raw.baseUrlEnv === "string" && raw.baseUrlEnv.trim()
      ? raw.baseUrlEnv.trim()
      : undefined;
  if (raw.baseUrlEnv !== undefined && baseUrlEnv === undefined) {
    errors.push("baseUrlEnv must be a non-empty string");
  }
  if (authType === "none-keyless" && keyEnv !== undefined) {
    errors.push("keyEnv cannot be combined with authType none-keyless");
  }

  let headers: Record<string, string> | undefined;
  if (raw.headers !== undefined) {
    if (!isRecord(raw.headers)) {
      errors.push("headers must be an object");
    } else {
      headers = {};
      for (const [name, value] of Object.entries(raw.headers)) {
        if (typeof value !== "string" || !name.trim()) {
          errors.push("header names and values must be non-empty strings");
          break;
        }
        headers[name.trim()] = value;
      }
    }
  }
  if (authType === "custom-headers" && !headers) {
    errors.push("authType custom-headers requires a headers object");
  }

  for (const field of ["tools", "images", "structuredOutput", "streamOptions"]) {
    const value = raw[field];
    if (value === undefined) continue;
    if (oneOf(value, TRI_STATES) === undefined) {
      errors.push(
        `${field} must be supported | unsupported | unknown, not ${JSON.stringify(value)}`,
      );
    }
  }

  let reasoning: CustomProviderProfileSpec["reasoning"];
  if (raw.reasoning !== undefined) {
    if (!isRecord(raw.reasoning)) {
      errors.push("reasoning must be an object");
    } else {
      const r = raw.reasoning;
      for (const key of Object.keys(r)) {
        if (!(ALLOWED_REASONING_KEYS as readonly string[]).includes(key)) {
          errors.push(
            `unknown reasoning field "${key}" (allowed: ${ALLOWED_REASONING_KEYS.join(", ")})`,
          );
        }
      }
      const generation = oneOf(r.generation, GENERATIONS);
      if (r.generation !== undefined && generation === undefined) {
        errors.push(`reasoning.generation must be one of ${GENERATIONS.join(", ")}`);
      }
      const controlDialect = oneOf(r.controlDialect, CONTROL_DIALECTS);
      if (r.controlDialect !== undefined && controlDialect === undefined) {
        errors.push(
          `reasoning.controlDialect must be one of ${CONTROL_DIALECTS.join(", ")}`,
        );
      }
      const disable = oneOf(r.disable, TRI_STATES);
      if (r.disable !== undefined && disable === undefined) {
        errors.push("reasoning.disable must be supported | unsupported | unknown");
      }
      const disableForm = oneOf(
        r.disableForm,
        EFFORT_DIALECT_DISABLE_FORMS,
      );
      if (r.disableForm !== undefined && disableForm === undefined) {
        errors.push(
          `reasoning.disableForm must be one of ${EFFORT_DIALECT_DISABLE_FORMS.join(", ")} for effort dialects`,
        );
      }
      if (disable === "supported" && !disableForm) {
        errors.push("reasoning.disable supported requires a disableForm");
      }
      if (generation === "mandatory" && disable === "supported") {
        errors.push(
          "mandatory reasoning cannot declare disable supported; use disable unsupported",
        );
      }
      const outputShapes = stringList(r.outputShapes, errors, "reasoning.outputShapes");
      if (outputShapes) {
        for (const shape of outputShapes) {
          if (!OUTPUT_SHAPES.includes(shape as ReasoningOutputShape)) {
            errors.push(`reasoning.outputShapes contains unknown shape "${shape}"`);
          }
        }
      }
      const validatedOutputShapes = outputShapes as ReasoningOutputShape[] | undefined;
      const acceptedEfforts = stringList(
        r.acceptedEfforts,
        errors,
        "reasoning.acceptedEfforts",
      );
      if (acceptedEfforts) {
        for (const effort of acceptedEfforts) {
          if (effort !== effort.toLowerCase()) {
            errors.push("reasoning.acceptedEfforts must be lowercase");
          }
        }
      }
      const replayScope = oneOf(r.replayScope, REPLAY_SCOPES);
      if (r.replayScope !== undefined && replayScope === undefined) {
        errors.push(`reasoning.replayScope must be one of ${REPLAY_SCOPES.join(", ")}`);
      }
      const finalTurnPreservation = oneOf(
        r.finalTurnPreservation,
        PRESERVATIONS,
      );
      if (
        r.finalTurnPreservation !== undefined &&
        finalTurnPreservation === undefined
      ) {
        errors.push(
          `reasoning.finalTurnPreservation must be one of ${PRESERVATIONS.join(", ")}`,
        );
      }
      reasoning = {
        ...(generation !== undefined ? { generation } : {}),
        ...(controlDialect !== undefined ? { controlDialect } : {}),
        ...(acceptedEfforts !== undefined ? { acceptedEfforts } : {}),
        ...(disable !== undefined ? { disable } : {}),
        ...(disableForm !== undefined ? { disableForm } : {}),
        ...(validatedOutputShapes !== undefined
          ? { outputShapes: validatedOutputShapes }
          : {}),
        ...(replayScope !== undefined ? { replayScope } : {}),
        ...(finalTurnPreservation !== undefined
          ? { finalTurnPreservation }
          : {}),
      };
    }
  }

  let limits: CustomProviderProfileSpec["limits"];
  if (raw.limits !== undefined) {
    if (!isRecord(raw.limits)) {
      errors.push("limits must be an object");
    } else {
      for (const key of Object.keys(raw.limits)) {
        if (!(ALLOWED_LIMIT_KEYS as readonly string[]).includes(key)) {
          errors.push(
            `unknown limits field "${key}" (allowed: ${ALLOWED_LIMIT_KEYS.join(", ")})`,
          );
        }
      }
      const { contextTokens, outputTokens } = raw.limits as Record<string, unknown>;
      if (
        contextTokens !== undefined &&
        (typeof contextTokens !== "number" ||
          !Number.isInteger(contextTokens) ||
          contextTokens <= 0)
      ) {
        errors.push("limits.contextTokens must be a positive integer");
      }
      if (
        outputTokens !== undefined &&
        (typeof outputTokens !== "number" ||
          !Number.isInteger(outputTokens) ||
          outputTokens <= 0)
      ) {
        errors.push("limits.outputTokens must be a positive integer");
      }
      const source = oneOf(raw.limits.source, LIMIT_SOURCES);
      if (raw.limits.source !== undefined && source === undefined) {
        errors.push(`limits.source must be one of ${LIMIT_SOURCES.join(", ")}`);
      }
      limits = {
        ...(typeof contextTokens === "number" ? { contextTokens } : {}),
        ...(typeof outputTokens === "number" ? { outputTokens } : {}),
        ...(source !== undefined ? { source } : {}),
      };
    }
  }

  let cache: CustomProviderProfileSpec["cache"];
  if (raw.cache !== undefined) {
    if (!isRecord(raw.cache)) {
      errors.push("cache must be an object");
    } else {
      for (const key of Object.keys(raw.cache)) {
        if (!(ALLOWED_CACHE_KEYS as readonly string[]).includes(key)) {
          errors.push(
            `unknown cache field "${key}" (allowed: ${ALLOWED_CACHE_KEYS.join(", ")})`,
          );
        }
      }
      const kind = oneOf(raw.cache.kind, CACHE_KINDS);
      if (raw.cache.kind !== undefined && kind === undefined) {
        errors.push(`cache.kind must be one of ${CACHE_KINDS.join(", ")}`);
      }
      const cacheAffectingFields = stringList(
        raw.cache.cacheAffectingFields,
        errors,
        "cache.cacheAffectingFields",
      );
      cache = {
        ...(kind !== undefined ? { kind } : {}),
        ...(typeof raw.cache.affinityField === "string" && raw.cache.affinityField
          ? { affinityField: raw.cache.affinityField }
          : {}),
        ...(typeof raw.cache.isolationField === "string" &&
        raw.cache.isolationField
          ? { isolationField: raw.cache.isolationField }
          : {}),
        ...(cacheAffectingFields !== undefined ? { cacheAffectingFields } : {}),
      };
    }
  }

  let usage: CustomProviderProfileSpec["usage"];
  if (raw.usage !== undefined) {
    if (!isRecord(raw.usage)) {
      errors.push("usage must be an object");
    } else {
      for (const key of Object.keys(raw.usage)) {
        if (!(ALLOWED_USAGE_KEYS as readonly string[]).includes(key)) {
          errors.push(
            `unknown usage field "${key}" (allowed: ${ALLOWED_USAGE_KEYS.join(", ")})`,
          );
        }
      }
      usage = {
        ...(stringList(raw.usage.cachedInput, errors, "usage.cachedInput")
          ? {
              cachedInput: stringList(
                raw.usage.cachedInput,
                errors,
                "usage.cachedInput",
              )!,
            }
          : {}),
        ...(stringList(raw.usage.uncachedInput, errors, "usage.uncachedInput")
          ? {
              uncachedInput: stringList(
                raw.usage.uncachedInput,
                errors,
                "usage.uncachedInput",
              )!,
            }
          : {}),
        ...(stringList(raw.usage.cacheWrite, errors, "usage.cacheWrite")
          ? {
              cacheWrite: stringList(
                raw.usage.cacheWrite,
                errors,
                "usage.cacheWrite",
              )!,
            }
          : {}),
        ...(stringList(raw.usage.reasoningOutput, errors, "usage.reasoningOutput")
          ? {
              reasoningOutput: stringList(
                raw.usage.reasoningOutput,
                errors,
                "usage.reasoningOutput",
              )!,
            }
          : {}),
      };
    }
  }

  let terminal: CustomProviderProfileSpec["terminal"];
  if (raw.terminal !== undefined) {
    if (!isRecord(raw.terminal)) {
      errors.push("terminal must be an object");
    } else {
      for (const key of Object.keys(raw.terminal)) {
        if (!(ALLOWED_TERMINAL_KEYS as readonly string[]).includes(key)) {
          errors.push(
            `unknown terminal field "${key}" (allowed: ${ALLOWED_TERMINAL_KEYS.join(", ")})`,
          );
        }
      }
      if (typeof raw.terminal.naturalEofAccepted !== "boolean") {
        errors.push("terminal.naturalEofAccepted must be a boolean");
      } else {
        terminal = { naturalEofAccepted: raw.terminal.naturalEofAccepted };
      }
    }
  }

  if (errors.length > 0) return { errors };
  return {
    spec: {
      ...(authType !== undefined ? { authType } : {}),
      ...(keyEnv !== undefined ? { keyEnv } : {}),
      ...(baseUrlEnv !== undefined ? { baseUrlEnv } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(oneOf(raw.tools, TRI_STATES) !== undefined
        ? { tools: oneOf(raw.tools, TRI_STATES) }
        : {}),
      ...(oneOf(raw.images, TRI_STATES) !== undefined
        ? { images: oneOf(raw.images, TRI_STATES) }
        : {}),
      ...(oneOf(raw.structuredOutput, TRI_STATES) !== undefined
        ? { structuredOutput: oneOf(raw.structuredOutput, TRI_STATES) }
        : {}),
      ...(oneOf(raw.streamOptions, TRI_STATES) !== undefined
        ? { streamOptions: oneOf(raw.streamOptions, TRI_STATES) }
        : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(limits !== undefined ? { limits } : {}),
      ...(cache !== undefined ? { cache } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(terminal !== undefined ? { terminal } : {}),
    },
    errors,
  };
}

/** Maps a validated spec onto the user-config evidence layer. */
export function customProfileLayer(
  spec: CustomProviderProfileSpec | undefined,
): ProviderProfileLayer | undefined {
  if (!spec) return undefined;
  const r = spec.reasoning;
  return {
    evidence: USER_EVIDENCE,
    transport: {
      authType: spec.authType ?? "bearer",
      ...(spec.keyEnv ? { keyEnv: spec.keyEnv } : {}),
      ...(spec.baseUrlEnv ? { baseUrlEnv: spec.baseUrlEnv } : {}),
      ...(spec.headers ? { headers: spec.headers } : {}),
      systemPolicy: "single-leading",
    },
    capabilities: {
      ...(spec.tools ? { tools: spec.tools } : {}),
      ...(spec.images ? { images: spec.images } : {}),
      ...(spec.structuredOutput
        ? { structuredOutput: spec.structuredOutput }
        : {}),
      ...(spec.streamOptions ? { streamOptions: spec.streamOptions } : {}),
    },
    reasoning: r
      ? {
          ...(r.generation ? { generation: r.generation } : {}),
          ...(r.controlDialect
            ? {
                control: {
                  dialect: r.controlDialect,
                  status: r.controlDialect === "none" ? "unsupported" : "supported",
                  evidence: USER_EVIDENCE,
                },
              }
            : {}),
          ...(r.acceptedEfforts ? { acceptedEfforts: r.acceptedEfforts } : {}),
          ...(r.disable ? { disable: r.disable } : {}),
          ...(r.disableForm ? { disableForm: r.disableForm } : {}),
          ...(r.outputShapes ? { outputShapes: r.outputShapes } : {}),
          ...(r.replayScope ? { replayScope: r.replayScope } : {}),
          ...(r.finalTurnPreservation
            ? { finalTurnPreservation: r.finalTurnPreservation }
            : {}),
        }
      : undefined,
    limits: spec.limits
      ? {
          ...(spec.limits.contextTokens !== undefined
            ? { contextTokens: spec.limits.contextTokens }
            : {}),
          ...(spec.limits.outputTokens !== undefined
            ? { outputTokens: spec.limits.outputTokens }
            : {}),
          source: spec.limits.source ?? "user-config",
        }
      : undefined,
    cache: spec.cache
      ? {
          kind: spec.cache.kind ?? "unknown",
          ...(spec.cache.affinityField
            ? { affinityField: spec.cache.affinityField }
            : {}),
          ...(spec.cache.isolationField
            ? { isolationField: spec.cache.isolationField }
            : {}),
          ...(spec.cache.cacheAffectingFields
            ? { cacheAffectingFields: spec.cache.cacheAffectingFields }
            : []),
        }
      : undefined,
    usage: spec.usage,
    terminal: spec.terminal
      ? {
          proofs: CHAT_COMPLETIONS_TERMINAL_PROOFS,
          naturalEofAccepted: spec.terminal.naturalEofAccepted ?? false,
        }
      : undefined,
  };
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

/**
 * Conservative unknown unless declared; a custom endpoint that verifiably is
 * the direct DeepSeek API earns the documented V4 builtin layer as route
 * evidence below user declarations.
 */
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

/**
 * Serializer style for the compatible path. Undeclared routes omit optional
 * reasoning controls entirely (send narrowly, parse broadly).
 */
export function customReasoningStyle(
  profile: CustomProviderProfileSpec | undefined,
): ReasoningStyle {
  const dialect = profile?.reasoning?.controlDialect;
  return dialect === "openai-effort" ? "openai" : "none";
}

/** Resolves `${ENV_NAME}` header references before dispatch; throws locally. */
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
