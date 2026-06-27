import type { ProviderStatus } from "../types.js";

export interface SearchKeyStatus {
  provider: string;
  active: boolean;
  configured: boolean;
  source: string;
  maskedKey?: string | undefined;
}

function row(active: boolean, configured: boolean, name: string, source: string, masked = "", detail = ""): string {
  return [
    active ? "ACTIVE" : "      ",
    configured ? "✓" : "✗",
    name.padEnd(12),
    source.padEnd(9),
    masked.padEnd(18),
    detail,
  ].join("  ").trimEnd();
}

/** Render credential metadata without ever including an unmasked secret. */
export function formatKeyStatus(llm: ProviderStatus[], search: SearchKeyStatus[]): string {
  const llmRows = llm.map((status) => row(
    status.active,
    status.configured,
    status.provider,
    status.source === "missing" ? "no key" : status.source,
    status.maskedKey ?? "",
    `model=${status.model}`,
  ));
  const searchRows = search.map((status) => row(
    status.active,
    status.configured,
    status.provider,
    status.source === "missing" ? "no key" : status.source,
    status.maskedKey ?? "",
  ));
  return [
    "LLM PROVIDERS",
    "STATE   KEY  PROVIDER      SOURCE     MASKED KEY          DETAILS",
    ...llmRows,
    "",
    "SEARCH PROVIDERS",
    "STATE   KEY  PROVIDER      SOURCE     MASKED KEY",
    ...searchRows,
    "",
    "Keys are masked. Use /provider to configure an unconfigured LLM provider.",
  ].join("\n");
}
