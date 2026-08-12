/**
 * Credential management: /set, /unset, /keys, /info (multi-key per provider).
 */

import { getProvider } from "../../llm/router.js";
import { MAX_PROVIDER_KEYS } from "../../llm/key-rotation.js";
import {
  assertProvider,
  getProviderInfoText,
  maskSecret,
  normalizeEndpointUrl,
} from "../../llm/provider.js";
import {
  MAX_PROVIDER_ENDPOINTS,
  appendProviderEndpoint,
  getConfig,
  getProviderEndpoints,
  providerUsesEndpoints,
  setProviderEndpoints,
  updateConfig,
} from "../../store/config.js";
import {
  appendSearchProviderKey,
  getProviderKeys,
  getSearchProviderKeys,
  listProviderStatuses,
  setProviderKeys,
  setSearchProviderKeys,
  unsetProviderSecret,
  unsetSearchProviderSecret,
} from "../../store/keys.js";
import { searchProviderIds, type SearchProviderId } from "../../tools/web/types.js";
import type { ProviderId } from "../../types.js";
import { formatKeyStatus, type SearchKeyStatus } from "../rendering/format-keys.js";
import type { CommandInvocation } from "../../app/commands/command.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import type { PickerOption } from "../rendering/picker-filter.js";

const SEARCH_IDS = new Set(["brave", "tavily", "duckduckgo", "exa"]);

function notice(services: AppServices, level: "info" | "warn", text: string): void {
  services.session.notice(level, text);
}

async function getSearchKeyStatuses(): Promise<SearchKeyStatus[]> {
  const activeSearch = getConfig().activeSearchProvider;
  return Promise.all(
    searchProviderIds.map(async (id) => {
      const keyless = id === "duckduckgo";
      const multi = await getSearchProviderKeys(id);
      const count = multi.keys.length;
      const activeIndex = count > 0 ? multi.activeIndex : 0;
      const activeValue = multi.keys[activeIndex]?.value;
      return {
        provider: id,
        active: id === activeSearch,
        configured: keyless || count > 0,
        source: keyless ? "keyless" : multi.source,
        maskedKey: activeValue ? maskSecret(activeValue) : undefined,
        keyCount: keyless ? undefined : count || undefined,
        maskedKeys: count > 0 ? multi.keys.map((key) => maskSecret(key.value)) : undefined,
        activeMaskedKey:
          count > 1 && activeValue ? maskSecret(activeValue) : undefined,
        keyDisabled: count > 0 ? multi.keys.map((key) => key.disabled === true) : undefined,
      };
    }),
  );
}

export async function handleInfo(
  services: AppServices,
  invocation: CommandInvocation,
): Promise<void> {
  const providerVal = invocation.args.trim().toLowerCase();
  let target = services.session.getState().provider ?? getConfig().defaultProvider;
  if (providerVal) {
    try {
      target = assertProvider(providerVal);
    } catch {
      notice(services, "warn", `unknown provider: ${providerVal}`);
      return;
    }
  }
  services.overlay.openPager(`${target} Info`, getProviderInfoText(target));
}

export async function handleKeys(services: AppServices): Promise<void> {
  try {
    const active = services.session.getState().provider ?? getConfig().defaultProvider;
    const llm = await listProviderStatuses(active);
    services.overlay.openPager("Credential status", formatKeyStatus(llm, await getSearchKeyStatuses()));
  } catch (error) {
    notice(
      services,
      "warn",
      `could not read keys: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function handleSet(
  services: AppServices,
  invocation: CommandInvocation,
): Promise<void> {
  const parts = invocation.args.split(/\s+/).filter(Boolean);
  const providerVal = parts[0];
  const keyVal = parts[1];

  if (!providerVal) {
    await openSetPicker(services);
    return;
  }

  try {
    if (SEARCH_IDS.has(providerVal)) {
      await setSearchKey(services, providerVal as SearchProviderId, keyVal);
      return;
    }
    const id = assertProvider(providerVal);
    if (keyVal) {
      await appendLlmKey(services, id, keyVal);
      return;
    }
    await openLlmKeysEditor(services, id);
  } catch (error) {
    notice(services, "warn", error instanceof Error ? error.message : String(error));
  }
}

export async function handleUnset(
  services: AppServices,
  invocation: CommandInvocation,
): Promise<void> {
  const providerVal = invocation.args.trim().split(/\s+/)[0];
  if (!providerVal) {
    await openUnsetPicker(services);
    return;
  }
  try {
    if (SEARCH_IDS.has(providerVal)) {
      await unsetSearchKey(services, providerVal as SearchProviderId);
      return;
    }
    await unsetLlmKey(services, assertProvider(providerVal));
  } catch (error) {
    notice(services, "warn", error instanceof Error ? error.message : String(error));
  }
}

async function openSetPicker(services: AppServices): Promise<void> {
  const active = services.session.getState().provider ?? getConfig().defaultProvider;
  const llm = await listProviderStatuses(active);
  const search = await getSearchKeyStatuses();
  const options: PickerOption[] = [
    ...llm.flatMap((status): PickerOption[] => {
      const count = status.keyCount ?? (status.configured ? 1 : 0);
      const keyLabel =
        status.provider === "ollama"
          ? status.configured
            ? "✓ host set"
            : "✗ no host"
          : count === 0
            ? "✗ no key"
            : count === 1
              ? `✓ ${status.maskedKey ?? "1 key"}`
              : `✓ ${count} keys`;
      const row: PickerOption = {
        value: `llm:${status.provider}`,
        label: `${status.provider} ${keyLabel}${status.active ? " (active)" : ""}`,
        description: status.model,
      };
      // Endpoint providers get a second row so the URL list is reachable
      // directly instead of only via the key editor.
      if (!status.endpoints) return [row];
      const urlCount = status.endpoints.length;
      return [
        row,
        {
          value: `endpoint:${status.provider}`,
          label: `${status.provider} endpoints ${urlCount === 0 ? "✗ none" : `✓ ${urlCount} URL${urlCount === 1 ? "" : "s"}`}`,
          description: status.note ?? "endpoint URLs",
        },
      ];
    }),
    ...search.map((status) => {
      const count = status.keyCount ?? 0;
      const keyLabel =
        status.provider === "duckduckgo"
          ? "✓ keyless"
          : count === 0
            ? "✗ no key"
            : count === 1
              ? `✓ ${status.maskedKey ?? "1 key"}`
              : `✓ ${count} keys`;
      return {
        value: `search:${status.provider}`,
        label: `${status.provider} ${keyLabel}${status.active ? " (active)" : ""}`,
        description: "Search provider",
      };
    }),
  ];
  services.overlay.openPicker({ title: "Set API key / endpoint", options }, (value) => {
    services.overlay.close();
    void (async () => {
      const separator = value.indexOf(":");
      const kind = value.slice(0, separator);
      const id = value.slice(separator + 1);
      if (kind === "search") await openSearchKeysEditor(services, id as SearchProviderId);
      else if (kind === "endpoint") await openEndpointsEditor(services, id as ProviderId);
      else await openLlmKeysEditor(services, id as ProviderId);
    })();
  });
}

async function openUnsetPicker(services: AppServices): Promise<void> {
  const active = services.session.getState().provider ?? getConfig().defaultProvider;
  const llm = await listProviderStatuses(active);
  const search = await getSearchKeyStatuses();
  const options: PickerOption[] = [
    ...llm.flatMap((status): PickerOption[] => {
      const count = status.keyCount ?? (status.configured ? 1 : 0);
      const keyLabel =
        status.provider === "ollama"
          ? "host (config)"
          : count === 0
            ? "✗ no key"
            : count === 1
              ? `✓ ${status.maskedKey ?? "1 key"}`
              : `✓ ${count} keys — reset all`;
      const row: PickerOption = {
        value: `llm:${status.provider}`,
        label: `${status.provider} ${keyLabel}${status.active ? " (active)" : ""}`,
        description: status.model,
      };
      if (!status.endpoints || status.endpoints.length === 0) return [row];
      return [
        row,
        {
          value: `endpoint:${status.provider}`,
          label: `${status.provider} endpoints ✓ ${status.endpoints.length} URL${status.endpoints.length === 1 ? "" : "s"} — clear all`,
          description: status.note ?? "endpoint URLs",
        },
      ];
    }),
    ...search.map((status) => {
      const count = status.keyCount ?? 0;
      const keyLabel =
        status.provider === "duckduckgo"
          ? "keyless"
          : count === 0
            ? "✗ no key"
            : count === 1
              ? `✓ ${status.maskedKey ?? "1 key"}`
              : `✓ ${count} keys — reset all`;
      return {
        value: `search:${status.provider}`,
        label: `${status.provider} ${keyLabel}${status.active ? " (active)" : ""}`,
        description: "Search provider",
      };
    }),
  ];
  services.overlay.openPicker({ title: "Unset API key / endpoint", options }, (value) => {
    services.overlay.close();
    void (async () => {
      const separator = value.indexOf(":");
      const kind = value.slice(0, separator);
      const id = value.slice(separator + 1);
      if (kind === "search") await unsetSearchKey(services, id as SearchProviderId);
      else if (kind === "endpoint") {
        const count = getProviderEndpoints(id as ProviderId).urls.length;
        setProviderEndpoints(id as ProviderId, []);
        notice(services, "info", `unset ${count} endpoint URL(s) for ${id}`);
      } else await unsetLlmKey(services, id as ProviderId);
    })();
  });
}

/**
 * Multi-row editor over a provider's endpoint URLs — the same overlay, sticky
 * ★ active row and Reset semantics as the key editor, so endpoints and keys
 * behave identically.
 */
async function openEndpointsEditor(
  services: AppServices,
  id: ProviderId,
): Promise<void> {
  const { urls, activeIndex, disabledUrls } = getProviderEndpoints(id);
  const answer = await services.overlay.openKeysEditor({
    provider: id,
    heading: "ENDPOINTS",
    itemLabel: "endpoint URL",
    // URLs are not secrets: show them in full so a typo is visible.
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

  // Keep whatever was active if it survived the edit, mirroring key editing.
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

async function openLlmKeysEditor(
  services: AppServices,
  id: ProviderId,
): Promise<void> {
  if (id === "ollama") {
    const host = await services.overlay.openSecret({
      title: "Ollama host URL",
      prompt: "Enter host URL for Ollama:",
      reveal: true,
    });
    if (!host) {
      notice(services, "info", "cancelled");
      return;
    }
    updateConfig({ ollamaHost: host.trim() });
    notice(services, "info", `saved ollama host → ${host.trim()}`);
    return;
  }

  // Endpoint providers need both lists; edit URLs first (Esc skips ahead to the
  // keys), or jump straight to either list from the /set picker.
  if (providerUsesEndpoints(id)) {
    await openEndpointsEditor(services, id);
  }

  const multi = await getProviderKeys(id);
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
    await unsetProviderSecret(id);
    notice(services, "info", `unset all keys for ${id}`);
    return;
  }

  const byId = new Map(stored.map((key) => [key.id, key.value]));
  const detailed = resolveEditorRowsDetailed(answer.rows, byId);
  const resolved = detailed.map((row) => row.value);
  if (resolved.length === 0) {
    await unsetProviderSecret(id);
    notice(services, "info", `unset all keys for ${id}`);
    return;
  }

  const impl = getProvider(id);
  for (const key of resolved) {
    if (!impl.validateKey(key)) {
      notice(services, "warn", `invalid API key format for ${id}`);
      return;
    }
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

  await setProviderKeys(
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

async function openSearchKeysEditor(
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

function resolveEditorRows(
  rows: readonly { slotId?: string; value: string }[],
  byId: ReadonlyMap<string, string>,
): string[] {
  const resolved: string[] = [];
  for (const row of rows) {
    if (row.slotId) {
      const value = row.value.trim();
      const keep = value || byId.get(row.slotId);
      if (keep) resolved.push(keep);
    } else if (row.value.trim()) {
      resolved.push(row.value.trim());
    }
  }
  return resolved;
}

function resolveEditorRowsDetailed(
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

async function appendLlmKey(
  services: AppServices,
  id: ProviderId,
  keyVal: string,
): Promise<void> {
  if (id === "ollama") {
    updateConfig({ ollamaHost: keyVal.trim() });
    notice(services, "info", `saved ollama host → ${keyVal.trim()}`);
    return;
  }
  // `/set modal https://…` is unambiguous: a URL can only be an endpoint,
  // never an API key or a `<token-id>:<token-secret>` pair. Appended and made
  // active, exactly like the CLI's `--url`.
  if (providerUsesEndpoints(id) && /^https?:\/\//i.test(keyVal.trim())) {
    const endpoint = normalizeEndpointUrl(keyVal.trim());
    try {
      const { endpoints, added } = appendProviderEndpoint(id, endpoint);
      notice(
        services,
        "info",
        `${added ? "saved" : "activated"} ${id} endpoint #${endpoints.activeIndex + 1}/${endpoints.urls.length} → ${endpoint}`,
      );
    } catch (error) {
      notice(services, "warn", error instanceof Error ? error.message : String(error));
    }
    return;
  }
  const key = keyVal.trim();
  if (!getProvider(id).validateKey(key)) {
    notice(
      services,
      "warn",
      providerUsesEndpoints(id)
        ? `invalid value for ${id} · expected a key/token, or an https:// URL to add an endpoint`
        : `invalid API key format for ${id}`,
    );
    return;
  }
  const { appendProviderKey } = await import("../../store/keys.js");
  await appendProviderKey(id, key);
  const multi = await getProviderKeys(id);
  const count = multi.source === "env" ? 1 : multi.keys.length;
  notice(
    services,
    "info",
    count > 1
      ? `added ${id} ${maskSecret(key)} · ${count} keys total`
      : `saved ${id} ${maskSecret(key)}`,
  );
}

async function setSearchKey(
  services: AppServices,
  id: SearchProviderId,
  keyVal?: string | undefined,
): Promise<void> {
  if (id === "duckduckgo") {
    notice(services, "info", "duckduckgo is keyless and requires no setup");
    return;
  }
  if (!keyVal) {
    await openSearchKeysEditor(services, id);
    return;
  }
  const key = keyVal.trim();
  if (!key) {
    notice(services, "warn", "API key cannot be empty");
    return;
  }
  await appendSearchProviderKey(id, key);
  const multi = await getSearchProviderKeys(id);
  const count = multi.source === "env" ? 1 : multi.keys.length;
  notice(
    services,
    "info",
    count > 1
      ? `added ${id} ${maskSecret(key)} · ${count} keys total`
      : `saved ${id} ${maskSecret(key)}`,
  );
}

async function unsetSearchKey(services: AppServices, id: SearchProviderId): Promise<void> {
  if (id === "duckduckgo") {
    notice(services, "info", "duckduckgo requires no credentials and cannot be unset");
    return;
  }
  const multi = await getSearchProviderKeys(id);
  const storedCount = multi.source === "env" ? 0 : multi.keys.length;
  if (storedCount === 0) {
    notice(services, "warn", `${id} has no key to unset`);
    return;
  }
  await unsetSearchProviderSecret(id);
  notice(
    services,
    "info",
    storedCount > 1 ? `unset all ${storedCount} keys for ${id}` : `unset ${id}`,
  );
}

async function unsetLlmKey(services: AppServices, id: ProviderId): Promise<void> {
  if (id === "ollama") {
    notice(services, "info", "ollama does not store an API key");
    return;
  }
  const multi = await getProviderKeys(id);
  const storedCount = multi.source === "env" ? 0 : multi.keys.length;
  if (storedCount === 0) {
    notice(services, "warn", `${id} has no key to unset`);
    return;
  }
  await unsetProviderSecret(id);
  notice(
    services,
    "info",
    storedCount > 1 ? `unset all ${storedCount} keys for ${id}` : `unset ${id}`,
  );
}
