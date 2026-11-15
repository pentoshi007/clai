import type { ReasoningEffort } from "../types.js";
import { bareModelId } from "./model-families.js";
import type { ProviderProfileLayer } from "./provider-profile.js";
import { providerDoc } from "./provider-profile-layers.js";

export type GeminiThinkingControl = "level" | "budget" | "none";

export interface GeminiThinkingSpec {
  readonly control: GeminiThinkingControl;
  readonly efforts: readonly ReasoningEffort[];
  readonly canDisable: boolean;
  readonly requiresToolCallSignatures: boolean;
}

export const GEMINI_UNSIGNED_TOOL_CALL_SIGNATURE = "skip_thought_signature_validator";

const GEMINI_THINKING_DOC = "https://ai.google.dev/gemini-api/docs/thinking";

const NO_THINKING: GeminiThinkingSpec = {
  control: "none",
  efforts: [],
  canDisable: true,
  requiresToolCallSignatures: false,
};

const STANDARD_LEVELS: readonly ReasoningEffort[] = ["low", "medium", "high"];
const MINIMAL_LEVELS: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high"];
const EXTENDED_LEVELS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

function levelSpec(efforts: readonly ReasoningEffort[]): GeminiThinkingSpec {
  return { control: "level", efforts, canDisable: false, requiresToolCallSignatures: true };
}

function geminiVersion(id: string): { major: number; minor: number } | undefined {
  const match = /gemini-(\d+)(?:\.(\d+))?(?=[-.@:_]|$)/.exec(id);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2] ?? 0) };
}

function levelEffortsFor(id: string, major: number, minor: number): readonly ReasoningEffort[] {
  const pro = /-pro(?:[-.]|$)/.test(id);
  if (major === 3) {
    if (pro) return minor === 0 ? ["low", "high"] : STANDARD_LEVELS;
    return minor >= 8 ? STANDARD_LEVELS : MINIMAL_LEVELS;
  }
  return major >= 5 || /hydrogen/.test(id) ? EXTENDED_LEVELS : STANDARD_LEVELS;
}

export function geminiThinkingSpec(
  model: string,
  catalogThinking?: boolean | undefined,
): GeminiThinkingSpec {
  if (catalogThinking === false) return NO_THINKING;
  const id = bareModelId(model);
  const version = geminiVersion(id);
  if (!version) {
    return /gemini/.test(id) || catalogThinking ? levelSpec(STANDARD_LEVELS) : NO_THINKING;
  }
  const { major, minor } = version;
  if (major >= 3) return levelSpec(levelEffortsFor(id, major, minor));
  if (major === 2 && minor >= 5) {
    return {
      control: "budget",
      efforts: STANDARD_LEVELS,
      canDisable: !/-pro(?:[-.]|$)/.test(id),
      requiresToolCallSignatures: false,
    };
  }
  return catalogThinking ? levelSpec(STANDARD_LEVELS) : NO_THINKING;
}

export function geminiModelLayer(
  model: string,
  catalogThinking?: boolean | undefined,
): ProviderProfileLayer {
  const spec = geminiThinkingSpec(model, catalogThinking);
  const evidence = catalogThinking === undefined
    ? providerDoc(GEMINI_THINKING_DOC)
    : { source: "catalog" as const, confidence: "high" as const };
  switch (spec.control) {
    case "none":
      return {
        evidence,
        reasoning: {
          generation: "none",
          control: { dialect: "none", status: "unsupported", evidence },
        },
      };
    case "budget":
      return {
        evidence,
        reasoning: spec.canDisable
          ? {
              generation: "optional",
              acceptedEfforts: spec.efforts,
              disable: "supported",
              disableForm: "thinking-budget-zero",
            }
          : {
              generation: "mandatory",
              acceptedEfforts: spec.efforts,
              disable: "unsupported",
            },
      };
    case "level":
      return {
        evidence,
        reasoning: { generation: "optional", acceptedEfforts: spec.efforts },
      };
  }
}
