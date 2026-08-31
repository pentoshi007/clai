
import type {
  FinalTurnPreservation,
  ReasoningControlDialect,
  ReasoningDisableForm,
  ReasoningGeneration,
  ReplayOptIn,
  StreamTerminalProof,
} from "./provider-profile.js";

export type SamplingParameter = "temperature" | "top_p";

export interface ModelFamilyContract {
  readonly id: string;
  readonly pattern: RegExp;
  readonly generation: ReasoningGeneration;
  readonly dialect: ReasoningControlDialect;
  readonly acceptedEfforts: readonly string[];
  readonly defaultEffort?: string;
  readonly disableForm: ReasoningDisableForm;
  readonly replayOptIn?: ReplayOptIn;
  readonly finalTurnPreservation: FinalTurnPreservation;
  readonly omitSampling?: readonly SamplingParameter[];
  readonly minOutputTokensWithReasoning?: number;
  readonly terminalProofs?: readonly StreamTerminalProof[];
}

const KIMI_MIN_OUTPUT_TOKENS = 16_000;

const KIMI_TERMINAL_PROOFS: readonly StreamTerminalProof[] = ["done-sentinel"];

export const MODEL_FAMILIES: readonly ModelFamilyContract[] = [
  {
    id: "kimi-k3",
    pattern: /kimi[-./]?k3/,
    generation: "mandatory",
    dialect: "openai-effort",
    acceptedEfforts: ["low", "high", "max"],
    defaultEffort: "max",
    disableForm: "none-documented",
    finalTurnPreservation: "required",
    omitSampling: ["temperature"],
    minOutputTokensWithReasoning: KIMI_MIN_OUTPUT_TOKENS,
    terminalProofs: KIMI_TERMINAL_PROOFS,
  },
  {
    id: "kimi-k2.7-code",
    pattern: /kimi[-./]?k2\.7[-.]?code/,
    generation: "mandatory",
    dialect: "none",
    acceptedEfforts: [],
    disableForm: "none-documented",
    finalTurnPreservation: "required",
    omitSampling: ["temperature"],
    minOutputTokensWithReasoning: KIMI_MIN_OUTPUT_TOKENS,
    terminalProofs: KIMI_TERMINAL_PROOFS,
  },
  {
    id: "kimi-k2.7",
    pattern: /kimi[-./]?k2\.7/,
    generation: "default-on",
    dialect: "deepseek-thinking",
    acceptedEfforts: [],
    disableForm: "thinking-disabled",
    replayOptIn: "kimi-thinking-keep",
    finalTurnPreservation: "supported",
    omitSampling: ["temperature"],
    minOutputTokensWithReasoning: KIMI_MIN_OUTPUT_TOKENS,
    terminalProofs: KIMI_TERMINAL_PROOFS,
  },
  {
    id: "kimi-k2.6",
    pattern: /kimi[-./]?k2(?:\.6|-thinking|-instruct)?(?![\d.])/,
    generation: "default-on",
    dialect: "deepseek-thinking",
    acceptedEfforts: [],
    disableForm: "thinking-disabled",
    replayOptIn: "kimi-thinking-keep",
    finalTurnPreservation: "supported",
    omitSampling: ["temperature"],
    minOutputTokensWithReasoning: KIMI_MIN_OUTPUT_TOKENS,
    terminalProofs: KIMI_TERMINAL_PROOFS,
  },
  {
    id: "kimi-k2.5",
    pattern: /kimi[-./]?k2\.5/,
    generation: "default-on",
    dialect: "deepseek-thinking",
    acceptedEfforts: [],
    disableForm: "thinking-disabled",
    finalTurnPreservation: "unknown",
    omitSampling: ["temperature"],
    minOutputTokensWithReasoning: KIMI_MIN_OUTPUT_TOKENS,
    terminalProofs: KIMI_TERMINAL_PROOFS,
  },
  {
    id: "deepseek-v4",
    pattern: /deepseek[-./]?v4/,
    generation: "default-on",
    dialect: "deepseek-thinking",
    acceptedEfforts: ["low", "high", "max"],
    disableForm: "thinking-disabled",
    finalTurnPreservation: "unknown",
    omitSampling: ["temperature", "top_p"],
  },
  {
    id: "deepseek-reasoner",
    pattern: /deepseek[-./]?(?:reasoner|r1)|deepseek[-./]?v3/,
    generation: "default-on",
    dialect: "chat-template-thinking",
    acceptedEfforts: [],
    disableForm: "template-thinking-false",
    finalTurnPreservation: "unknown",
    omitSampling: ["temperature", "top_p"],
  },
  {
    id: "qwen3-max-effort",
    pattern: /qwen[-./]?3\.[6-9][-.]?max/,
    generation: "optional",
    dialect: "qwen-enable-thinking",
    acceptedEfforts: ["low", "medium", "xhigh"],
    defaultEffort: "xhigh",
    disableForm: "enable-thinking-false",
    replayOptIn: "qwen-preserve-thinking",
    finalTurnPreservation: "supported",
  },
  {
    id: "qwen-thinking-only",
    pattern: /qwen[-./]?3.*thinking/,
    generation: "mandatory",
    dialect: "none",
    acceptedEfforts: [],
    disableForm: "none-documented",
    replayOptIn: "qwen-preserve-thinking",
    finalTurnPreservation: "supported",
  },
  {
    id: "qwen3-hybrid",
    pattern: /qwen[-./]?3/,
    generation: "optional",
    dialect: "qwen-enable-thinking",
    acceptedEfforts: [],
    disableForm: "enable-thinking-false",
    replayOptIn: "qwen-preserve-thinking",
    finalTurnPreservation: "supported",
  },
  {
    id: "nemotron-3",
    pattern: /nemotron[-./]?(?:lightning[-.])?3/,
    generation: "optional",
    dialect: "nemotron-reasoning-budget",
    acceptedEfforts: [],
    disableForm: "template-enable-thinking-false",
    finalTurnPreservation: "unknown",
  },
  {
    id: "nemotron-legacy",
    pattern: /nemotron/,
    generation: "optional",
    dialect: "chat-template-thinking",
    acceptedEfforts: [],
    disableForm: "template-thinking-false",
    finalTurnPreservation: "unknown",
  },
  {
    id: "glm",
    pattern: /glm[-./]?[345]/,
    generation: "optional",
    dialect: "glm-enable-thinking",
    acceptedEfforts: [],
    disableForm: "enable-thinking-false",
    finalTurnPreservation: "unknown",
  },
  {
    id: "gemma",
    pattern: /gemma[-./]?[34]/,
    generation: "optional",
    dialect: "chat-template-thinking",
    acceptedEfforts: [],
    disableForm: "template-enable-thinking-false",
    finalTurnPreservation: "unknown",
  },
  {
    id: "gpt-oss",
    pattern: /gpt[-./]?oss/,
    generation: "optional",
    dialect: "openai-effort",
    acceptedEfforts: ["low", "medium", "high"],
    disableForm: "omit-control",
    finalTurnPreservation: "unknown",
  },
  {
    id: "openai-reasoning",
    pattern: /(?:^|[-./])(?:gpt-5|o[1-4])(?![a-z])/,
    generation: "optional",
    dialect: "openai-effort",
    acceptedEfforts: ["minimal", "low", "medium", "high"],
    disableForm: "effort-minimal-floor",
    finalTurnPreservation: "unknown",
    omitSampling: ["temperature", "top_p"],
  },
  {
    id: "gemini-mandatory-thinking",
    pattern: /gemini[-./]?2\.5[-.]?pro/,
    generation: "mandatory",
    dialect: "gemini-thinking-config",
    acceptedEfforts: ["low", "medium", "high"],
    disableForm: "omit-control",
    finalTurnPreservation: "unknown",
  },
  {
    id: "mistral-reasoning",
    pattern: /mistral-(?:medium|small|large)-(?:[3-9]|\d{2,})/,
    generation: "optional",
    dialect: "openai-effort",
    acceptedEfforts: ["low", "medium", "high"],
    disableForm: "omit-control",
    finalTurnPreservation: "unknown",
  },
];

export function bareModelId(model: string): string {
  const lowered = model.trim().toLowerCase();
  const lastSlash = lowered.lastIndexOf("/");
  const bare = lastSlash >= 0 ? lowered.slice(lastSlash + 1) : lowered;
  return bare.replace(/(\d)p(\d)/g, "$1.$2");
}

export function modelFamilyFor(model: string): ModelFamilyContract | undefined {
  const bare = bareModelId(model);
  if (!bare) return undefined;
  return MODEL_FAMILIES.find((family) => family.pattern.test(bare));
}

export function modelFamilyId(model: string): string | undefined {
  return modelFamilyFor(model)?.id;
}

export type NvidiaReasoningKind =
  | "kimi-thinking"
  | "deepseek-v4"
  | "thinking"
  | "nemotron-3"
  | "glm-thinking"
  | "enable-thinking"
  | "effort-only"
  | "none";

const NVIDIA_KIND_BY_FAMILY: Readonly<Record<string, NvidiaReasoningKind>> = {
  "kimi-k2.7-code": "kimi-thinking",
  "kimi-k2.7": "kimi-thinking",
  "kimi-k2.6": "kimi-thinking",
  "kimi-k2.5": "kimi-thinking",
  "deepseek-v4": "deepseek-v4",
  "deepseek-reasoner": "thinking",
  "nemotron-3": "nemotron-3",
  "nemotron-legacy": "thinking",
  glm: "glm-thinking",
  gemma: "enable-thinking",
  "gpt-oss": "effort-only",
  "qwen3-max-effort": "effort-only",
  "qwen-thinking-only": "effort-only",
  "qwen3-hybrid": "effort-only",
  "mistral-reasoning": "effort-only",
};

export function classifyNvidiaModel(model: string): NvidiaReasoningKind {
  const family = modelFamilyFor(model);
  if (!family) return "none";
  return NVIDIA_KIND_BY_FAMILY[family.id] ?? "none";
}

export type BynaraReasoningKind =
  | "kimi"
  | "deepseek"
  | "agnes"
  | "stepfun"
  | "none";

export function classifyBynaraModel(model: string): BynaraReasoningKind {
  const m = model.toLowerCase();
  if (/kimi/.test(m)) return "kimi";
  if (/deepseek/.test(m)) return "deepseek";
  if (/agnes/.test(m)) return "agnes";
  if (/stepfun|step-3/.test(m)) return "stepfun";
  return "none";
}
