import { MIN_CUSTOM_CONTEXT_LIMIT_TOKENS } from "../llm/context-windows.js";
import type { ProviderId } from "../types.js";
import { getConfig, getProviderModel, updateConfig } from "./config.js";

function isValidLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_CUSTOM_CONTEXT_LIMIT_TOKENS
  );
}

function routeKey(provider: ProviderId | undefined, model: string | undefined): string {
  const selectedProvider = provider ?? getConfig().defaultProvider;
  const selectedModel = model ?? getProviderModel(selectedProvider);
  return `${selectedProvider}:${selectedModel}`;
}

export function customContextLimit(
  provider: ProviderId | undefined,
  model: string | undefined,
): number | undefined {
  const value = getConfig().contextLimitTokens?.[routeKey(provider, model)];
  return isValidLimit(value) ? Math.floor(value) : undefined;
}

export function setCustomContextLimit(
  provider: ProviderId | undefined,
  model: string | undefined,
  limit: number | undefined,
): void {
  const key = routeKey(provider, model);
  const contextLimitTokens = { ...(getConfig().contextLimitTokens ?? {}) };
  if (isValidLimit(limit)) contextLimitTokens[key] = Math.floor(limit);
  else delete contextLimitTokens[key];
  updateConfig({ contextLimitTokens });
}

export function clearCustomContextLimits(): void {
  updateConfig({ contextLimitTokens: {} });
}
