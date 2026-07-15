/**
 * Credential management: /set, /unset, /keys, /info (V2-080, F-012).
 */

import { getProvider } from "../../../llm/router.js";
import { assertProvider, getProviderInfoText, maskSecret } from "../../../llm/provider.js";
import { getConfig, updateConfig } from "../../../store/config.js";
import {
  getProviderSecret,
  getSearchProviderKey,
  listProviderStatuses,
  setProviderSecret,
  setSecret,
  unsetProviderSecret,
} from "../../../store/keys.js";
import { searchProviderIds, type SearchProviderId } from "../../../tools/web/types.js";
import type { ProviderId } from "../../../types.js";
import { formatKeyStatus } from "../../../tui/format-keys.js";
import type { CommandInvocation } from "../../../app/commands/command.js";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { PickerOption } from "../../rendering/picker-filter.js";

const SEARCH_IDS = new Set(["brave", "tavily", "duckduckgo"]);

function notice(services: AppServices, level: "info" | "warn", text: string): void {
  services.session.notice(level, text);
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
    const activeSearch = getConfig().activeSearchProvider;
    const search = await Promise.all(
      searchProviderIds.map(async (id) => {
        const secret = await getSearchProviderKey(id);
        const keyless = id === "duckduckgo";
        return {
          provider: id,
          active: id === activeSearch,
          configured: keyless || Boolean(secret.value),
          source: keyless ? "keyless" : secret.source,
          maskedKey: secret.value ? maskSecret(secret.value) : undefined,
        };
      }),
    );
    services.overlay.openPager("Credential status", formatKeyStatus(llm, search));
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
    await setLlmKey(services, assertProvider(providerVal), keyVal);
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
  const activeSearch = getConfig().activeSearchProvider;
  const search = await Promise.all(
    searchProviderIds.map(async (id) => {
      const secret = await getSearchProviderKey(id);
      const keyless = id === "duckduckgo";
      return {
        provider: id,
        configured: keyless || Boolean(secret.value),
        maskedKey: secret.value ? maskSecret(secret.value) : undefined,
      };
    }),
  );
  const options: PickerOption[] = [
    ...llm.map((status) => ({
      value: `llm:${status.provider}`,
      label: `${status.provider} ${status.configured ? "✓ key set" : "✗ no key"}${status.active ? " (active)" : ""}`,
      description: status.model,
    })),
    ...search.map((status) => ({
      value: `search:${status.provider}`,
      label: `${status.provider} ${status.configured ? "✓ key set" : "✗ no key"}`,
      description: `Search provider${status.provider === activeSearch ? " (active)" : ""}`,
    })),
  ];
  services.overlay.openPicker({ title: "Set API key for provider", options }, (value) => {
    services.overlay.close();
    void (async () => {
      const isSearch = value.startsWith("search:");
      const id = value.split(":")[1]!;
      if (isSearch) await setSearchKey(services, id as SearchProviderId);
      else await setLlmKey(services, id as ProviderId);
    })();
  });
}

async function openUnsetPicker(services: AppServices): Promise<void> {
  const active = services.session.getState().provider ?? getConfig().defaultProvider;
  const llm = await listProviderStatuses(active);
  const activeSearch = getConfig().activeSearchProvider;
  const search = await Promise.all(
    searchProviderIds.map(async (id) => {
      const secret = await getSearchProviderKey(id);
      const keyless = id === "duckduckgo";
      return {
        provider: id,
        configured: keyless || Boolean(secret.value),
        maskedKey: secret.value ? maskSecret(secret.value) : undefined,
      };
    }),
  );
  const options: PickerOption[] = [
    ...llm.map((status) => ({
      value: `llm:${status.provider}`,
      label: `${status.provider} ${status.configured ? `✓ ${status.maskedKey ?? "key set"}` : "✗ no key"}${status.active ? " (active)" : ""}`,
      description: status.model,
    })),
    ...search.map((status) => ({
      value: `search:${status.provider}`,
      label: `${status.provider} ${status.configured ? `✓ ${status.maskedKey ?? "keyless"}` : "✗ no key"}`,
      description: `Search provider${status.provider === activeSearch ? " (active)" : ""}`,
    })),
  ];
  services.overlay.openPicker({ title: "Unset API key for provider", options }, (value) => {
    services.overlay.close();
    void (async () => {
      const isSearch = value.startsWith("search:");
      const id = value.split(":")[1]!;
      if (isSearch) await unsetSearchKey(services, id as SearchProviderId);
      else await unsetLlmKey(services, id as ProviderId);
    })();
  });
}

async function confirmOverwrite(services: AppServices, label: string, masked: string): Promise<boolean> {
  return services.overlay.openConfirm({
    kind: "reset",
    prompt: `${label} already has a key (${masked}). Reset it?`,
  });
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
  let key = keyVal;
  if (!key) {
    const secret = await getSearchProviderKey(id);
    if (secret.value) {
      const ok = await confirmOverwrite(services, id, maskSecret(secret.value));
      if (!ok) {
        notice(services, "info", "cancelled");
        return;
      }
    }
    key = await services.overlay.openSecret({
      title: `${id} API key`,
      prompt: `Enter API key for ${id}:`,
    });
    if (!key) {
      notice(services, "info", "cancelled");
      return;
    }
  }
  await setSecret("search", id, key.trim());
  notice(services, "info", `saved ${id} ${maskSecret(key.trim())}`);
}

async function setLlmKey(
  services: AppServices,
  id: ProviderId,
  keyVal?: string | undefined,
): Promise<void> {
  if (id === "ollama") {
    let host = keyVal;
    if (!host) {
      host = await services.overlay.openSecret({
        title: "Ollama host URL",
        prompt: "Enter host URL for Ollama:",
      });
      if (!host) {
        notice(services, "info", "cancelled");
        return;
      }
    }
    updateConfig({ ollamaHost: host.trim() });
    notice(services, "info", `saved ollama host → ${host.trim()}`);
    return;
  }
  let key = keyVal;
  if (!key) {
    const secret = await getProviderSecret(id);
    if (secret.value) {
      const ok = await confirmOverwrite(services, id, maskSecret(secret.value));
      if (!ok) {
        notice(services, "info", "cancelled");
        return;
      }
    }
    key = await services.overlay.openSecret({
      title: `${id} API key`,
      prompt: `Enter API key for ${id}:`,
    });
    if (!key) {
      notice(services, "info", "cancelled");
      return;
    }
  }
  if (!getProvider(id).validateKey(key.trim())) {
    notice(services, "warn", `invalid API key format for ${id}`);
    return;
  }
  await setProviderSecret(id, key.trim());
  notice(services, "info", `saved ${id} ${maskSecret(key.trim())}`);
}

async function unsetSearchKey(services: AppServices, id: SearchProviderId): Promise<void> {
  if (id === "duckduckgo") {
    notice(services, "info", "duckduckgo requires no credentials and cannot be unset");
    return;
  }
  const secret = await getSearchProviderKey(id);
  if (!secret.value) {
    notice(services, "warn", `${id} has no key to unset`);
    return;
  }
  const { unsetSearchProviderKey } = await import("../../../commands/search-providers.js");
  await unsetSearchProviderKey(id);
  notice(services, "info", `unset ${id}`);
}

async function unsetLlmKey(services: AppServices, id: ProviderId): Promise<void> {
  if (id === "ollama") {
    notice(services, "info", "ollama does not store an API key");
    return;
  }
  const secret = await getProviderSecret(id);
  if (!secret.value) {
    notice(services, "warn", `${id} has no key to unset`);
    return;
  }
  await unsetProviderSecret(id);
  notice(services, "info", `unset ${id}`);
}
