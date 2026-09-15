import type { CustomProviderDef } from "../../llm/custom-providers.js";
import {
  getConfig,
  knownProviderId,
  updateConfig,
  type SubagentModelConfig,
  type SubagentModelEntry,
} from "./endpoints.js";

export const MAX_SUBAGENT_MODELS = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clampActiveIndex(index: number, length: number): number {
  if (length === 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), length - 1);
}

export function sanitizeSubagentModelChain(
  value: unknown,
  customProviders: readonly CustomProviderDef[] | undefined,
): SubagentModelConfig | undefined {
  if (!isRecord(value) || !Array.isArray(value.entries)) return undefined;
  const entries: SubagentModelEntry[] = [];
  const seen = new Set<string>();
  for (const rawEntry of value.entries) {
    if (!isRecord(rawEntry)) continue;
    const provider = typeof rawEntry.provider === "string" ? rawEntry.provider.trim() : "";
    const model = typeof rawEntry.model === "string" ? rawEntry.model.trim() : "";
    if (!knownProviderId(provider, customProviders) || !model) continue;
    const key = `${provider}\u001f${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      provider,
      model,
      ...(rawEntry.disabled === true ? { disabled: true } : {}),
    });
    if (entries.length >= MAX_SUBAGENT_MODELS) break;
  }
  if (entries.length === 0) return undefined;
  const activeIndex =
    typeof value.activeIndex === "number"
      ? clampActiveIndex(value.activeIndex, entries.length)
      : 0;
  return { entries, activeIndex };
}

export function getSubagentModelChain(): SubagentModelConfig | undefined {
  const config = getConfig();
  const sanitized = sanitizeSubagentModelChain(
    config.subagentModels,
    config.customProviders,
  );
  if (!sanitized && config.subagentModels !== undefined) {
    updateConfig({ subagentModels: undefined });
  }
  return sanitized
    ? {
        entries: sanitized.entries.map((entry) => ({ ...entry })),
        activeIndex: sanitized.activeIndex,
      }
    : undefined;
}

export function setSubagentModelChain(
  entries: readonly SubagentModelEntry[],
  activeIndex = 0,
): SubagentModelConfig | undefined {
  const config = getConfig();
  const sanitized = sanitizeSubagentModelChain(
    { entries, activeIndex },
    config.customProviders,
  );
  if (!sanitized) {
    clearSubagentModelChain();
    return undefined;
  }
  updateConfig({ subagentModels: sanitized });
  return {
    entries: sanitized.entries.map((entry) => ({ ...entry })),
    activeIndex: sanitized.activeIndex,
  };
}

export function clearSubagentModelChain(): void {
  updateConfig({ subagentModels: undefined });
}

