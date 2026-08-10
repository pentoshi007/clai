import type { ProviderStatus } from "../types.js";

export interface SearchKeyStatus {
  provider: string;
  active: boolean;
  configured: boolean;
  source: string;
  maskedKey?: string | undefined;
  keyCount?: number | undefined;
  maskedKeys?: readonly string[] | undefined;
  activeMaskedKey?: string | undefined;
}

/** Render credential metadata without ever including an unmasked secret. */
export function formatKeyStatus(llm: ProviderStatus[], search: SearchKeyStatus[]): string {
  const header = "  PROVIDER      SOURCE    KEYS          MODEL";

  const llmRows: string[] = [];
  for (const s of llm) {
    const mark = s.configured ? "✓" : "✗";
    const tag = s.active ? " ◀" : "";
    const count = s.keyCount ?? (s.maskedKey ? 1 : 0);
    const keySummary =
      s.provider === "ollama"
        ? s.note
          ? s.note
          : "local"
        : s.provider === "free"
          ? s.note
            ? s.note
            : "keyless"
          : count === 0
            ? "—"
            : count === 1
              ? s.maskedKey || "••••••••"
              : `${count} keys`;
    const source = (s.source === "missing" ? "no key" : s.source).padEnd(9);
    llmRows.push(
      `  ${mark} ${s.provider.padEnd(13)} ${source} ${String(keySummary).padEnd(13)} ${s.model}${tag}`,
    );
    // Endpoint providers need a base URL alongside the key, so a key on its own
    // is not enough to make a request — show where it points.
    if (s.provider !== "ollama" && s.provider !== "free" && s.note) {
      llmRows.push(`      endpoint: ${s.note}`);
    }
    if (s.endpoints && s.endpoints.length > 1) {
      s.endpoints.forEach((url, i) => {
        llmRows.push(
          `      (${i + 1}) ${url}${i === (s.activeEndpointIndex ?? 0) ? " ★ active" : ""}`,
        );
      });
    }
    if (s.maskedKeys && s.maskedKeys.length > 1) {
      let activeIdx = 0;
      if (s.activeMaskedKey) {
        const found = s.maskedKeys.indexOf(s.activeMaskedKey);
        if (found >= 0) activeIdx = found;
      }
      s.maskedKeys.forEach((masked, i) => {
        llmRows.push(
          `      [${i + 1}] ${masked}${i === activeIdx ? " ★ active" : ""}`,
        );
      });
    }
  }

  const searchRows: string[] = [];
  for (const s of search) {
    const mark = s.configured ? "✓" : "✗";
    const tag = s.active ? " ◀" : "";
    const count = s.keyCount ?? (s.maskedKey ? 1 : 0);
    const keySummary =
      count === 0 ? "—" : count === 1 ? s.maskedKey || "••••••••" : `${count} keys`;
    searchRows.push(
      `  ${mark} ${s.provider.padEnd(13)} ${(s.source === "missing" ? "no key" : s.source).padEnd(9)} ${keySummary}${tag}`,
    );
    if (s.maskedKeys && s.maskedKeys.length > 1) {
      let activeIdx = 0;
      if (s.activeMaskedKey) {
        const found = s.maskedKeys.indexOf(s.activeMaskedKey);
        if (found >= 0) activeIdx = found;
      }
      s.maskedKeys.forEach((masked, index) => {
        searchRows.push(
          `      [${index + 1}] ${masked}${index === activeIdx ? " ★ active" : ""}`,
        );
      });
    }
  }

  return [
    "LLM PROVIDERS",
    header,
    ...llmRows,
    "",
    "SEARCH PROVIDERS",
    "  PROVIDER      SOURCE    KEYS",
    ...searchRows,
    "",
    "◀ = active provider · ★ = sticky key used first on the next request",
    "Use /set to manage multi-keys · /unset clears all keys for a provider.",
  ].join("\n");
}
