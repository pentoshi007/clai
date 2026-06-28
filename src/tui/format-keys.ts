import type { ProviderStatus } from "../types.js";

export interface SearchKeyStatus {
  provider: string;
  active: boolean;
  configured: boolean;
  source: string;
  maskedKey?: string | undefined;
}

/** Render credential metadata without ever including an unmasked secret. */
export function formatKeyStatus(llm: ProviderStatus[], search: SearchKeyStatus[]): string {
  const header = "  PROVIDER      SOURCE    KEY           MODEL";

  const llmRows = llm.map((s) => {
    const mark = s.configured ? "✓" : "✗";
    const tag = s.active ? " ◀" : "";
    const key = s.maskedKey || (s.configured ? "••••••••" : "—");
    return `  ${mark} ${s.provider.padEnd(13)} ${(s.source === "missing" ? "no key" : s.source).padEnd(9)} ${key.padEnd(13)} ${s.model}${tag}`;
  });

  const searchRows = search.map((s) => {
    const mark = s.configured ? "✓" : "✗";
    const tag = s.active ? " ◀" : "";
    const key = s.maskedKey || (s.configured ? "••••••••" : "—");
    return `  ${mark} ${s.provider.padEnd(13)} ${(s.source === "missing" ? "no key" : s.source).padEnd(9)} ${key}${tag}`;
  });

  return [
    "LLM PROVIDERS",
    header,
    ...llmRows,
    "",
    "SEARCH PROVIDERS",
    "  PROVIDER      SOURCE    KEY",
    ...searchRows,
    "",
    "◀ = active provider. Use /set or /provider to configure keys.",
  ].join("\n");
}
