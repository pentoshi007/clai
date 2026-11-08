import { catalogEntriesFromPayload } from "./catalog-facts.js";
import { catalogRecord } from "./catalog-provider.js";

const DISABLED_LEVEL_ALIASES: ReadonlySet<string> = new Set(["off", "none"]);
const WIRE_DISABLED_LEVEL = "none";

function wireLevel(level: string): string {
  const normalized = level.trim().toLowerCase();
  return DISABLED_LEVEL_ALIASES.has(normalized) ? WIRE_DISABLED_LEVEL : normalized;
}

function wireLevels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels = value
    .filter((level): level is string => typeof level === "string")
    .map(wireLevel)
    .filter(Boolean);
  return levels.length > 0 ? [...new Set(levels)] : undefined;
}

export function withReasoningLevelFacts(entry: unknown): unknown {
  const record = catalogRecord(entry);
  const levels = wireLevels(record?.reasoning_efforts);
  if (!record || !levels) return entry;
  const defaultLevel =
    typeof record.reasoning_default === "string"
      ? wireLevel(record.reasoning_default)
      : "";
  return {
    ...record,
    reasoning: {
      supported: true,
      supported_efforts: levels,
      mandatory: !levels.includes(WIRE_DISABLED_LEVEL),
      ...(defaultLevel ? { default_effort: defaultLevel } : {}),
    },
  };
}

export function reasoningLevelCatalogEntries(payload: unknown): unknown[] {
  return catalogEntriesFromPayload(payload).map(withReasoningLevelFacts);
}
