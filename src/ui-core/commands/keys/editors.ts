import { MAX_PROVIDER_KEYS } from "../../../llm/key-rotation.js";
import { maskSecret, normalizeEndpointUrl } from "../../../llm/provider.js";
import { getProviderEndpoints, MAX_PROVIDER_ENDPOINTS, setProviderEndpoints } from "../../../store/config.js";
import { getSearchProviderKeys, setSearchProviderKeys, unsetSearchProviderSecret } from "../../../store/keys.js";
import type { SearchProviderId } from "../../../tools/web/types.js";
import type { ProviderId } from "../../../types.js";
import type { AppServices } from "../../bootstrap/composition-root.js";
export { openLlmKeysEditor } from "../key-commands.js";

export function notice(services: AppServices, level: "info" | "warn", text: string): void {
  services.session.notice(level, text);
}

export async function openEndpointsEditor(
  services: AppServices,
  id: ProviderId,
): Promise<void> {
  const { urls, activeIndex, disabledUrls } = getProviderEndpoints(id);
  const answer = await services.overlay.openKeysEditor({
    provider: id,
    heading: "ENDPOINTS",
    itemLabel: "endpoint URL",
    initialKeys: urls.map((url, index) => ({
      id: String(index),
      masked: url,
      disabled: (disabledUrls ?? []).includes(url),
    })),
    activeIndex,
  });
  if (!answer) {
    notice(services, "info", "cancelled");
    return;
  }
  if (answer.action === "reset") {
    setProviderEndpoints(id, []);
    notice(services, "info", `unset all endpoint URLs for ${id}`);
    return;
  }

  const byId = new Map(urls.map((url, index) => [String(index), url]));
  const detailed = resolveEditorRowsDetailed(answer.rows, byId).map((row) => ({
    value: normalizeEndpointUrl(row.value),
    disabled: row.disabled,
  }));
  const resolved = detailed.map((row) => row.value);
  if (resolved.length === 0) {
    setProviderEndpoints(id, []);
    notice(services, "info", `unset all endpoint URLs for ${id}`);
    return;
  }
  if (resolved.length > MAX_PROVIDER_ENDPOINTS) {
    notice(services, "warn", `at most ${MAX_PROVIDER_ENDPOINTS} endpoint URLs per provider`);
    return;
  }

  let nextActive = answer.activeIndex ?? 0;
  if (answer.activeIndex === undefined) {
    const previous = urls[activeIndex];
    const found = previous ? resolved.indexOf(previous) : -1;
    if (found >= 0) nextActive = found;
  }
  const saved = setProviderEndpoints(
    id,
    resolved,
    nextActive,
    detailed.filter((row) => row.disabled).map((row) => row.value),
  );
  notice(
    services,
    "info",
    saved.urls.length === 1
      ? `saved ${id} endpoint → ${saved.urls[0]}`
      : `saved ${saved.urls.length} ${id} endpoints · active #${saved.activeIndex + 1} ${saved.urls[saved.activeIndex]}`,
  );
}

export async function openSearchKeysEditor(
  services: AppServices,
  id: SearchProviderId,
): Promise<void> {
  if (id === "duckduckgo") {
    notice(services, "info", "duckduckgo is keyless and requires no setup");
    return;
  }

  const multi = await getSearchProviderKeys(id);
  const stored =
    multi.source === "env"
      ? []
      : multi.keys.map((key) => ({
          id: key.id,
          masked: maskSecret(key.value),
          value: key.value,
          disabled: key.disabled === true,
        }));
  const answer = await services.overlay.openKeysEditor({
    provider: id,
    initialKeys: stored.map((key) => ({ id: key.id, masked: key.masked, disabled: key.disabled })),
    activeIndex: multi.source !== "env" ? multi.activeIndex : undefined,
  });
  if (!answer) {
    notice(services, "info", "cancelled");
    return;
  }
  if (answer.action === "reset") {
    await unsetSearchProviderSecret(id);
    notice(services, "info", `unset all keys for ${id}`);
    return;
  }

  const detailed = resolveEditorRowsDetailed(
    answer.rows,
    new Map(stored.map((key) => [key.id, key.value])),
  );
  const resolved = detailed.map((row) => row.value);
  if (resolved.length === 0) {
    await unsetSearchProviderSecret(id);
    notice(services, "info", `unset all keys for ${id}`);
    return;
  }
  if (resolved.length > MAX_PROVIDER_KEYS) {
    notice(services, "warn", `at most ${MAX_PROVIDER_KEYS} API keys per provider`);
    return;
  }

  let activeIndex = answer.activeIndex ?? 0;
  if (answer.activeIndex === undefined && multi.source !== "env" && multi.keys.length > 0) {
    const previous = multi.keys[multi.activeIndex]?.value;
    if (previous) {
      const found = resolved.indexOf(previous);
      if (found >= 0) activeIndex = found;
    }
  }

  await setSearchProviderKeys(
    id,
    resolved,
    activeIndex,
    detailed.filter((row) => row.disabled).map((row) => row.value),
  );
  const label = resolved.length === 1
    ? maskSecret(resolved[0]!)
    : `${resolved.length} keys · active: #${activeIndex + 1}`;
  notice(services, "info", `saved ${id} · ${label}`);
}

export function resolveEditorRowsDetailed(
  rows: readonly { slotId?: string; value: string; disabled?: boolean }[],
  byId: ReadonlyMap<string, string>,
): { value: string; disabled: boolean }[] {
  const resolved: { value: string; disabled: boolean }[] = [];
  for (const row of rows) {
    if (row.slotId) {
      const value = row.value.trim();
      const keep = value || byId.get(row.slotId);
      if (keep) resolved.push({ value: keep, disabled: row.disabled === true });
    } else if (row.value.trim()) {
      resolved.push({ value: row.value.trim(), disabled: row.disabled === true });
    }
  }
  return resolved;
}
