export type CatalogSupportedEfforts = readonly string[] | "any";

export interface CatalogReasoningFacts {
  readonly mandatory?: boolean | undefined;
  readonly defaultEnabled?: boolean | undefined;
  readonly supportedEfforts?: CatalogSupportedEfforts | undefined;
  readonly defaultEffort?: string | undefined;
  readonly supportsMaxTokens?: boolean | undefined;
  readonly supported?: boolean | undefined;
}

export interface CatalogFacts {
  readonly id: string;
  readonly reasoning?: CatalogReasoningFacts | undefined;
  readonly acceptedParameters?: readonly string[] | undefined;
  readonly contextTokens?: number | undefined;
  readonly nominalContextTokens?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly defaultSampling?: Readonly<Record<string, number | null>> | undefined;
  readonly modalities?: readonly string[] | undefined;
  readonly vision?: boolean | undefined;
}

const REASONING_FEATURE_RE =
  /^(?:reasoning|reasoning_effort|include_reasoning|thinking|reasoning_content)$/i;

const SAMPLING_FIELDS = [
  "temperature",
  "top_p",
  "top_k",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : undefined;
}

function modalitiesDeclareImage(value: unknown): boolean | undefined {
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === "string");
    if (items.length === 0) return undefined;
    return items.some((item) => /image|vision/i.test(item));
  }
  if (typeof value === "string") {
    if (!/text|image|audio|video/i.test(value)) return undefined;
    return /image|vision/i.test(value);
  }
  const nested = asRecord(value);
  if (nested) {
    if (typeof nested.vision === "boolean") return nested.vision;
    if (typeof nested.image === "boolean") return nested.image;
    if (nested.input !== undefined) return modalitiesDeclareImage(nested.input);
  }
  return undefined;
}

function parseVision(entry: Record<string, unknown>): boolean | undefined {
  for (const flag of [
    entry.vision,
    entry.supports_vision,
    entry.supports_image_input,
    entry.multimodal,
  ]) {
    if (typeof flag === "boolean") return flag;
  }
  const architecture = asRecord(entry.architecture);
  for (const candidate of [
    architecture?.input_modalities,
    architecture?.modality,
    entry.input_modalities,
    entry.modalities,
    entry.capabilities,
    entry.features,
  ]) {
    const declared = modalitiesDeclareImage(candidate);
    if (declared !== undefined) return declared;
  }
  return undefined;
}

function parseModalities(entry: Record<string, unknown>): readonly string[] | undefined {
  const architecture = asRecord(entry.architecture);
  return (
    stringList(architecture?.input_modalities) ?? stringList(entry.input_modalities)
  );
}

function parseEffortsFromOptions(entry: Record<string, unknown>): string[] | undefined {
  const collected: string[] = [];
  if (Array.isArray(entry.reasoning_options)) {
    for (const option of entry.reasoning_options) {
      const shaped = asRecord(option);
      if (shaped?.type !== undefined && shaped.type !== "effort") continue;
      for (const value of stringList(shaped?.values) ?? []) collected.push(value);
    }
  }
  for (const value of stringList(entry.supported_reasoning_efforts) ?? []) {
    collected.push(value);
  }
  const effortObject = asRecord(entry.reasoning_effort);
  for (const value of stringList(effortObject?.values) ?? []) collected.push(value);
  const deduped = [...new Set(collected)];
  return deduped.length > 0 ? deduped : undefined;
}

function featureContainersDeclareReasoning(
  entry: Record<string, unknown>,
): boolean | undefined {
  let declared: boolean | undefined;
  for (const container of [
    entry.supported_features,
    entry.supported_parameters,
    entry.features,
    entry.capabilities,
  ]) {
    const names = stringList(container);
    if (!names) continue;
    if (names.some((name) => REASONING_FEATURE_RE.test(name))) return true;
    declared = false;
  }
  return declared;
}

function parseSupportedEfforts(
  reasoning: Record<string, unknown>,
): CatalogSupportedEfforts | undefined {
  if (!("supported_efforts" in reasoning)) return undefined;
  const raw = reasoning.supported_efforts;
  if (raw === null) return "any";
  return stringList(raw);
}

function parseReasoning(
  entry: Record<string, unknown>,
): CatalogReasoningFacts | undefined {
  const facts: {
    mandatory?: boolean;
    defaultEnabled?: boolean;
    supportedEfforts?: CatalogSupportedEfforts;
    defaultEffort?: string;
    supportsMaxTokens?: boolean;
    supported?: boolean;
  } = {};

  const nested = asRecord(entry.reasoning);
  if (nested) {
    if (typeof nested.mandatory === "boolean") facts.mandatory = nested.mandatory;
    if (typeof nested.default_enabled === "boolean") {
      facts.defaultEnabled = nested.default_enabled;
    }
    if (typeof nested.supports_max_tokens === "boolean") {
      facts.supportsMaxTokens = nested.supports_max_tokens;
    }
    if (typeof nested.default_effort === "string" && nested.default_effort.trim()) {
      facts.defaultEffort = nested.default_effort.trim();
    }
    const efforts = parseSupportedEfforts(nested);
    if (efforts !== undefined) facts.supportedEfforts = efforts;
    facts.supported = true;
  } else if (typeof entry.reasoning === "boolean") {
    facts.supported = entry.reasoning;
  }

  const optionEfforts = parseEffortsFromOptions(entry);
  if (optionEfforts && facts.supportedEfforts === undefined) {
    facts.supportedEfforts = optionEfforts;
  }
  if (optionEfforts) facts.supported = true;

  if (facts.supported !== true) {
    const declared = featureContainersDeclareReasoning(entry);
    if (declared === true) facts.supported = true;
    else if (declared === false && facts.supported === undefined) {
      facts.supported = false;
    }
  }

  if (facts.mandatory === true) facts.supported = true;

  return Object.keys(facts).length > 0 ? facts : undefined;
}

function parseDefaultSampling(
  entry: Record<string, unknown>,
): Readonly<Record<string, number | null>> | undefined {
  const declared = asRecord(entry.default_parameters);
  if (!declared) return undefined;
  const sampling: Record<string, number | null> = {};
  for (const field of SAMPLING_FIELDS) {
    if (!(field in declared)) continue;
    const value = declared[field];
    if (value === null) sampling[field] = null;
    else if (typeof value === "number" && Number.isFinite(value)) {
      sampling[field] = value;
    }
  }
  return Object.keys(sampling).length > 0 ? sampling : undefined;
}

function parseLimits(entry: Record<string, unknown>): {
  contextTokens?: number;
  nominalContextTokens?: number;
  maxOutputTokens?: number;
} {
  const topProvider = asRecord(entry.top_provider);
  const nominal =
    positiveInteger(entry.context_length) ??
    positiveInteger(entry.context_window) ??
    positiveInteger(entry.max_model_len) ??
    positiveInteger(entry.inputTokenLimit);
  const served = positiveInteger(topProvider?.context_length) ?? nominal;
  const maxOutput =
    positiveInteger(topProvider?.max_completion_tokens) ??
    positiveInteger(entry.max_completion_tokens) ??
    positiveInteger(entry.max_output_length) ??
    positiveInteger(entry.outputTokenLimit) ??
    positiveInteger(entry.max_tokens);
  return {
    ...(served !== undefined ? { contextTokens: served } : {}),
    ...(nominal !== undefined ? { nominalContextTokens: nominal } : {}),
    ...(maxOutput !== undefined ? { maxOutputTokens: maxOutput } : {}),
  };
}

function entryId(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry.trim() || undefined;
  const record = asRecord(entry);
  if (!record) return undefined;
  for (const candidate of [record.id, record.name]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim().replace(/^models\//, "");
    }
  }
  return undefined;
}

export function parseCatalogFacts(entry: unknown): CatalogFacts | undefined {
  const id = entryId(entry);
  if (id === undefined) return undefined;
  const record = asRecord(entry);
  if (!record) return { id };
  const reasoning = parseReasoning(record);
  const acceptedParameters = stringList(record.supported_parameters);
  const defaultSampling = parseDefaultSampling(record);
  const modalities = parseModalities(record);
  const vision = parseVision(record);
  return {
    id,
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(acceptedParameters !== undefined ? { acceptedParameters } : {}),
    ...parseLimits(record),
    ...(defaultSampling !== undefined ? { defaultSampling } : {}),
    ...(modalities !== undefined ? { modalities } : {}),
    ...(vision !== undefined ? { vision } : {}),
  };
}

export function catalogEntriesFromPayload(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload;
  const container = asRecord(payload);
  if (!container) return [];
  for (const key of ["data", "models"] as const) {
    if (Array.isArray(container[key])) return container[key] as readonly unknown[];
  }
  return [];
}

export function catalogEffortList(
  efforts: CatalogSupportedEfforts | undefined,
): readonly string[] | undefined {
  return efforts === undefined || efforts === "any" ? undefined : efforts;
}
