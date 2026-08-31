import type { CustomProviderProfileSpec } from "../custom-provider-profile.js";
import { CHAT_COMPLETIONS_TERMINAL_PROOFS } from "../provider-profile.js";
import type {
  ProfileEvidence,
  ProviderProfileLayer,
} from "../provider-profile.js";

const USER_EVIDENCE: ProfileEvidence = {
  source: "user-config",
  confidence: "exact",
};

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
                  status:
                    r.controlDialect === "none" ? "unsupported" : "supported",
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
