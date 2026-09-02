import type { CustomProviderProfileSpec } from "../custom-provider-profile.js";
import type { ReasoningOutputShape } from "../provider-profile.js";
import {
  ALLOWED_CACHE_KEYS,
  ALLOWED_KEYS,
  ALLOWED_LIMIT_KEYS,
  ALLOWED_REASONING_KEYS,
  ALLOWED_TERMINAL_KEYS,
  ALLOWED_USAGE_KEYS,
  AUTH_TYPES,
  CACHE_KINDS,
  CONTROL_DIALECTS,
  EFFORT_DIALECT_DISABLE_FORMS,
  GENERATIONS,
  isRecord,
  LIMIT_SOURCES,
  oneOf,
  OUTPUT_SHAPES,
  PRESERVATIONS,
  REPLAY_SCOPES,
  stringList,
  TRI_STATES,
} from "./spec-vocabulary.js";

export function validateCustomProviderProfile(raw: unknown): {
  spec?: CustomProviderProfileSpec;
  errors: string[];
} {
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

  for (const field of [
    "tools",
    "images",
    "structuredOutput",
    "streamOptions",
  ]) {
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
        errors.push(
          `reasoning.generation must be one of ${GENERATIONS.join(", ")}`,
        );
      }
      const controlDialect = oneOf(r.controlDialect, CONTROL_DIALECTS);
      if (r.controlDialect !== undefined && controlDialect === undefined) {
        errors.push(
          `reasoning.controlDialect must be one of ${CONTROL_DIALECTS.join(", ")}`,
        );
      }
      const disable = oneOf(r.disable, TRI_STATES);
      if (r.disable !== undefined && disable === undefined) {
        errors.push(
          "reasoning.disable must be supported | unsupported | unknown",
        );
      }
      const disableForm = oneOf(r.disableForm, EFFORT_DIALECT_DISABLE_FORMS);
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
      const outputShapes = stringList(
        r.outputShapes,
        errors,
        "reasoning.outputShapes",
      );
      if (outputShapes) {
        for (const shape of outputShapes) {
          if (!OUTPUT_SHAPES.includes(shape as ReasoningOutputShape)) {
            errors.push(
              `reasoning.outputShapes contains unknown shape "${shape}"`,
            );
          }
        }
      }
      const validatedOutputShapes = outputShapes as
        ReasoningOutputShape[] | undefined;
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
        errors.push(
          `reasoning.replayScope must be one of ${REPLAY_SCOPES.join(", ")}`,
        );
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
      const { contextTokens, outputTokens } = raw.limits as Record<
        string,
        unknown
      >;
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
        ...(typeof raw.cache.affinityField === "string" &&
        raw.cache.affinityField
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
        ...(stringList(
          raw.usage.reasoningOutput,
          errors,
          "usage.reasoningOutput",
        )
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
