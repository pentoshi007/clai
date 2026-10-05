
import { getProvider } from "../../llm/router.js";
import {
  assertProvider,
  getProviderInfoText,
  maskSecret,
  normalizeEndpointUrl,
} from "../../llm/provider.js";
import { appendProviderEndpoint, getConfig, getProviderEndpoints, providerUsesEndpoints, setProviderEndpoints, updateConfig } from "../../store/config.js";
import { appendSearchProviderKey, getProviderKeys, getSearchProviderKeys, listProviderStatuses, unsetProviderSecret, unsetSearchProviderSecret, setProviderKeys } from "../../store/keys.js";
import { searchProviderIds, type SearchProviderId } from "../../tools/web/types.js";
import type { ProviderId } from "../../types.js";
import { formatKeyStatus, type SearchKeyStatus } from "../rendering/format-keys.js";
import type { CommandInvocation } from "../../app/commands/command.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import type { PickerOption } from "../rendering/picker-filter.js";
import type { KeysEditorAnswer } from "../controllers/overlay-controller.js";
import {notice, openEndpointsEditor, openSearchKeysEditor, resolveEditorRowsDetailed} from "./keys/editors.js";
import { pickAuthMethod } from "./keys/auth-picker.js";
import { openQoderKeysFlow } from "./keys/qoder.js";
import {
  maybeRefreshClineToken,
  pollClineDeviceAuth,
  startClineDeviceAuth,
  type ClineOAuthTokens,
} from "../../llm/cline-auth.js";
import {
  codexKeyFromAccessToken,
  decodeCodexKey,
  encodeCodexKey,
  maybeRefreshCodexCredential,
  pollCodexDeviceAuth,
  startCodexBrowserAuth,
  startCodexDeviceAuth,
  type CodexCredential,
} from "../../llm/codex-auth.js";
import { openSystemBrowser } from "../../mcp/auth/loopback.js";
import {
  pollCopilotDeviceAuth,
  startCopilotDeviceAuth,
} from "../../llm/copilot-auth.js";
import {
  importExistingFreebuffToken,
  isFreebuffHeadless,
  pollFreebuffDeviceAuth,
  startFreebuffDeviceAuth,
  validateFreebuffToken,
} from "../../llm/freebuff-auth.js";
import {
  encodeKiroKey,
  decodeKiroKey,
  isKiroOAuthToken,
  maybeRefreshKiroCredential,
  pollKiroDeviceAuth,
  startKiroDeviceAuth,
  startKiroSocialAuth,
  exchangeKiroSocialCode,
  importExistingKiroAuth,
  refreshKiroToken,
  listenForKiroSocialCallback,
  createKiroCliAuthorizationFlow,
  exchangeKiroPortalCode,
  listenForKiroCliCallback,
  parseKiroCliCallback,
  isHeadlessEnvironment,
  KIRO_KEY_PREFIX,
  type KiroCliCallbackServer,
  type KiroCredential,
} from "../../llm/kiro-auth.js";
import {
  pollKiroSocialDeviceAuth,
  startKiroSocialDeviceAuth,
  type KiroSocialProvider,
} from "../../llm/kiro-social-device.js";
import { appendProviderKey, replaceProviderKey, type ProviderKeySlot } from "../../store/keys.js";
import { MAX_PROVIDER_KEYS } from "../../llm/key-rotation.js";
import {
  importExistingOmnirushAuth,
  pollOmnirushDeviceAuth,
  startOmnirushDeviceAuth,
  validateOmnirushToken,
  type OmnirushOAuthTokens,
} from "../../llm/omnirush-auth.js";

const SEARCH_IDS = new Set(["brave", "tavily", "duckduckgo", "exa"]);

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
        label: `${getProvider(status.provider).displayName} ${keyLabel}${status.active ? " (active)" : ""}`,
      };
      if (!status.endpoints) return [row];
      const urlCount = status.endpoints.length;
      return [
        row,
        {
          value: `endpoint:${status.provider}`,
          label: `${getProvider(status.provider).displayName} endpoints ${urlCount === 0 ? "✗ none" : `✓ ${urlCount} URL${urlCount === 1 ? "" : "s"}`}`,
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
        label: `${getProvider(status.provider).displayName} ${keyLabel}${status.active ? " (active)" : ""}`,
      };
      if (!status.endpoints || status.endpoints.length === 0) return [row];
      return [
        row,
        {
          value: `endpoint:${status.provider}`,
          label: `${getProvider(status.provider).displayName} endpoints ✓ ${status.endpoints.length} URL${status.endpoints.length === 1 ? "" : "s"} — clear all`,
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
        notice(services, "info", `unset ${count} endpoint URL(s) for ${getProvider(id as ProviderId).displayName}`);
      } else await unsetLlmKey(services, id as ProviderId);
    })();
  });
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
  if (providerUsesEndpoints(id) && /^https?:\/\//i.test(keyVal.trim())) {
    const endpoint = normalizeEndpointUrl(keyVal.trim());
    try {
      const { endpoints, added } = appendProviderEndpoint(id, endpoint);
      notice(
        services,
        "info",
        `${added ? "saved" : "activated"} ${getProvider(id).displayName} endpoint #${endpoints.activeIndex + 1}/${endpoints.urls.length} → ${endpoint}`,
      );
    } catch (error) {
      notice(services, "warn", error instanceof Error ? error.message : String(error));
    }
    return;
  }
  const key = keyVal.trim();
  const label = getProvider(id).displayName;
  if (!getProvider(id).validateKey(key)) {
    notice(
      services,
      "warn",
      providerUsesEndpoints(id)
        ? `invalid value for ${label} · expected a key/token, or an https:// URL to add an endpoint`
        : `invalid API key format for ${label}`,
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
      ? `added ${label} ${maskSecret(key)} · ${count} keys total`
      : `saved ${label} ${maskSecret(key)}`,
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
  const label = getProvider(id).displayName;
  const multi = await getProviderKeys(id);
  const storedCount = multi.source === "env" ? 0 : multi.keys.length;
  if (storedCount === 0) {
    notice(services, "warn", `${label} has no key to unset`);
    return;
  }
  await unsetProviderSecret(id);
  notice(
    services,
    "info",
    storedCount > 1 ? `unset all ${storedCount} keys for ${label}` : `unset ${label}`,
  );
}
export async function runClineAuthForUI(
  services: AppServices,
): Promise<ClineOAuthTokens | undefined> {
  let start;
  try {
    start = await startClineDeviceAuth();
  } catch (error) {
    notice(
      services,
      "warn",
      `could not start Cline sign-in: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }

  if (!isHeadlessEnvironment()) void openSystemBrowser(start.verificationUrl).catch(() => {});

  services.overlay.openPager(
    "Cline sign-in",
    [
      "Authenticate Cline on any device:",
      "",
      `  ${start.verificationUrl}`,
      "",
      `  Code: ${start.userCode}`,
      "",
      "Approve in your browser — clai will continue automatically.",
      "(close this and press Ctrl-C to cancel)",
    ].join("\n"),
    undefined,
    undefined,
    "plain",
  );

  const abortController = new AbortController();
  const unsubscribe = services.overlay.subscribe(() => {
    if (!services.overlay.isOpen()) abortController.abort();
  });

  const waiting = services.toast.info("waiting for Cline approval…", {
    sticky: true,
  });
  try {
    const tokens = await pollClineDeviceAuth(start, {
      signal: abortController.signal,
    });
    notice(services, "info", "Cline authenticated");
    return tokens;
  } catch (error) {
    if (abortController.signal.aborted) {
      notice(services, "info", "cancelled");
      return undefined;
    }
    notice(
      services,
      "warn",
      `Cline sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  } finally {
    unsubscribe();
    services.toast.dismiss(waiting);
  }
}

async function clineAddAccount(
  services: AppServices,
): Promise<ClineOAuthTokens | undefined> {
  const tokens = await runClineAuthForUI(services);
  if (!tokens) {
    notice(services, "info", "cancelled");
    return undefined;
  }
  return tokens;
}

async function promptCodexApiKey(services: AppServices): Promise<string | undefined> {
  const answer = await services.overlay.openSecret({
    title: "ChatGPT Subscription access token",
    prompt: "Paste a ChatGPT access token (JWT from auth.openai.com) or an existing `codex:` key:",
  });
  const value = answer?.trim();
  if (!value) return undefined;
  const key = codexKeyFromAccessToken(value) ?? (value.startsWith("codex:") ? value : undefined);
  if (!key) {
    notice(
      services,
      "warn",
      "invalid ChatGPT token — expected a JWT containing the chatgpt account id",
    );
    return undefined;
  }
  return key;
}

async function pickCodexAuthMethod(
  services: AppServices,
): Promise<"browser" | "headless" | "apikey" | undefined> {
  const browser = {
    value: "browser",
    label: "Sign in with ChatGPT (browser)",
    description: "opens auth.openai.com in your browser",
  };
  const headless = {
    value: "headless",
    label: "Sign in with ChatGPT (headless)",
    description: "device code — works on remote/SSH machines",
  };
  const method = await pickAuthMethod(services, {
    title: "ChatGPT Subscription sign-in method",
    options: [
      ...(isHeadlessEnvironment() ? [headless, browser] : [browser, headless]),
      {
        value: "apikey",
        label: "Manually enter access token / API key",
        description: "paste an existing ChatGPT Subscription token",
      },
    ],
  });
  return method === "browser" || method === "headless" || method === "apikey" ? method : undefined;
}

export async function runCodexAuthForUI(
  services: AppServices,
): Promise<CodexCredential | undefined> {
  const method = await pickCodexAuthMethod(services);
  if (method === "headless") return runCodexDeviceAuthForUI(services);
  if (method === "apikey") {
    const key = await promptCodexApiKey(services);
    return key
      ? ({ manualKey: key, accessToken: "", accountId: "" } as CodexCredential)
      : undefined;
  }
  if (method !== "browser") return undefined;
  let handle;
  try {
    handle = await startCodexBrowserAuth();
  } catch {
    return runCodexDeviceAuthForUI(services);
  }

  services.overlay.openPager(
    "ChatGPT Subscription sign-in",
    [
      "Opening ChatGPT sign-in in your browser…",
      "",
      `  ${handle.url}`,
      "",
      "Log in with your ChatGPT account in the browser tab that opens.",
      "clai will continue automatically once authorization completes.",
      "(close this and press Ctrl-C to cancel)",
    ].join("\n"),
    undefined,
    undefined,
    "plain",
  );

  const abortController = new AbortController();
  const unsubscribe = services.overlay.subscribe(() => {
    if (!services.overlay.isOpen()) abortController.abort();
  });

  const waiting = services.toast.info("waiting for ChatGPT approval…", {
    sticky: true,
  });
  try {
    await openSystemBrowser(handle.url).catch(() => {});
    const credential = await Promise.race([
      handle.waitForCredential(),
      new Promise<never>((_, reject) => {
        if (abortController.signal.aborted) reject(new Error("ChatGPT authentication cancelled"));
        abortController.signal.addEventListener("abort", () => reject(new Error("ChatGPT authentication cancelled")));
      }),
    ]);
    notice(services, "info", "ChatGPT Subscription authenticated");
    return credential;
  } catch (error) {
    if (abortController.signal.aborted) {
      notice(services, "info", "cancelled");
      return undefined;
    }
    notice(
      services,
      "warn",
      `ChatGPT Subscription sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  } finally {
    unsubscribe();
    services.toast.dismiss(waiting);
    handle.close();
  }
}

export async function runCodexDeviceAuthForUI(
  services: AppServices,
): Promise<CodexCredential | undefined> {
  let start;
  try {
    start = await startCodexDeviceAuth();
  } catch (error) {
    notice(
      services,
      "warn",
      `could not start ChatGPT Subscription sign-in: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }

  if (!isHeadlessEnvironment()) void openSystemBrowser(start.verificationUrl).catch(() => {});

  services.overlay.openPager(
    "ChatGPT Subscription sign-in",
    [
      "Authenticate ChatGPT Subscription on any device:",
      "",
      `  ${start.verificationUrl}`,
      "",
      `  Code: ${start.userCode}`,
      "",
      "Approve in your browser — clai will continue automatically.",
      "(close this and press Ctrl-C to cancel)",
    ].join("\n"),
    undefined,
    undefined,
    "plain",
  );

  const abortController = new AbortController();
  const unsubscribe = services.overlay.subscribe(() => {
    if (!services.overlay.isOpen()) abortController.abort();
  });

  const waiting = services.toast.info("waiting for ChatGPT approval…", {
    sticky: true,
  });
  try {
    const credential = await pollCodexDeviceAuth(start, {
      signal: abortController.signal,
    });
    notice(services, "info", "ChatGPT Subscription authenticated");
    return credential;
  } catch (error) {
    if (abortController.signal.aborted) {
      notice(services, "info", "cancelled");
      return undefined;
    }
    notice(
      services,
      "warn",
      `ChatGPT Subscription sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  } finally {
    unsubscribe();
    services.toast.dismiss(waiting);
  }
}

export async function runCopilotAuthForUI(
  services: AppServices,
): Promise<string | undefined> {
  let start;
  try {
    start = await startCopilotDeviceAuth();
  } catch (error) {
    notice(
      services,
      "warn",
      `could not start Github Copilot sign-in: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }

  services.overlay.openPager(
    "Github Copilot sign-in",
    [
      "Authenticate Github Copilot on any device:",
      "",
      `  ${start.verificationUrl}`,
      "",
      `  Code: ${start.userCode}`,
      "",
      "Approve in your browser — clai will continue automatically.",
      "(close this and press Ctrl-C to cancel)",
    ].join("\n"),
    undefined,
    undefined,
    "plain",
  );

  const abortController = new AbortController();
  const unsubscribe = services.overlay.subscribe(() => {
    if (!services.overlay.isOpen()) abortController.abort();
  });

  const waiting = services.toast.info("waiting for Github Copilot approval…", {
    sticky: true,
  });
  try {
    const token = await pollCopilotDeviceAuth(start, {
      signal: abortController.signal,
    });
    notice(services, "info", "Github Copilot authenticated");
    return token;
  } catch (error) {
    if (abortController.signal.aborted) {
      notice(services, "info", "cancelled");
      return undefined;
    }
    notice(
      services,
      "warn",
      `Github Copilot sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  } finally {
    unsubscribe();
    services.toast.dismiss(waiting);
  }
}

export async function runFreebuffAuthForUI(
  services: AppServices,
): Promise<string | undefined> {
  let start;
  try {
    start = await startFreebuffDeviceAuth();
  } catch (error) {
    notice(
      services,
      "warn",
      `could not start Freebuff sign-in: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }

  if (!isFreebuffHeadless()) {
    void openSystemBrowser(start.loginUrl).catch(() => {});
  }

  services.overlay.openPager(
    "Freebuff sign-in",
    [
      "Authenticate Freebuff on any device:",
      "",
      `  ${start.loginUrl}`,
      "",
      isFreebuffHeadless()
        ? "Open the link on any device, sign in, then return here."
        : "Approve in your browser — clai will continue automatically.",
      "(close this and press Ctrl-C to cancel)",
    ].join("\n"),
    undefined,
    undefined,
    "plain",
  );

  const abortController = new AbortController();
  const unsubscribe = services.overlay.subscribe(() => {
    if (!services.overlay.isOpen()) abortController.abort();
  });

  const waiting = services.toast.info("waiting for Freebuff approval…", {
    sticky: true,
  });
  try {
    const result = await pollFreebuffDeviceAuth(start, {
      signal: abortController.signal,
    });
    notice(services, "info", "Freebuff authenticated");
    return result.token;
  } catch (error) {
    if (abortController.signal.aborted) {
      notice(services, "info", "cancelled");
      return undefined;
    }
    notice(
      services,
      "warn",
      `Freebuff sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  } finally {
    unsubscribe();
    services.toast.dismiss(waiting);
  }
}

async function importFreebuffForUI(
  services: AppServices,
): Promise<string | undefined> {
  const imported = await importExistingFreebuffToken();
  if (!imported) {
    notice(
      services,
      "warn",
      "no existing Freebuff login found (set FREEBUFF_API_KEY or CODEBUFF_API_KEY)",
    );
    return undefined;
  }
  try {
    await validateFreebuffToken(imported.token);
  } catch (error) {
    notice(
      services,
      "warn",
      `imported Freebuff token is not valid: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  notice(services, "info", `imported Freebuff login from ${imported.source}`);
  return imported.token;
}

function pickFreebuffAuthMethod(
  services: AppServices,
): Promise<"signin" | "import" | undefined> {
  return new Promise((resolve) => {
    const opened = services.overlay.openPicker(
      {
        title: "Freebuff sign-in method",
        options: [
          {
            value: "signin",
            label: "Sign in with Freebuff",
            description: "opens a login link — works in browser or over SSH",
          },
          {
            value: "import",
            label: "Import existing Freebuff login",
            description: "reuse FREEBUFF_API_KEY / CODEBUFF_API_KEY or manicode credentials",
          },
        ],
      },
      (value) => {
        services.overlay.close();
        resolve(value as "signin" | "import");
      },
    );
    if (!opened) resolve(undefined);
  });
}

async function addFreebuffAccount(
  services: AppServices,
): Promise<string | undefined> {
  const method = await pickFreebuffAuthMethod(services);
  if (!method) return undefined;
  return method === "import"
    ? importFreebuffForUI(services)
    : runFreebuffAuthForUI(services);
}

async function openFreebuffKeysFlow(services: AppServices): Promise<void> {
  let { keys, activeIndex } = await loadOAuthKeys("freebuff");
  for (;;) {
    services.overlay.close();
    const answer = await services.overlay.openKeysEditor({
      provider: "freebuff",
      heading: "FREEBUFF ACCOUNTS",
      itemLabel: "account",
      addViaPicker: true,
      refreshable: true,
      initialKeys: keys.map((key) => ({
        id: key.id,
        masked: maskSecret(key.value),
        disabled: key.disabled === true,
      })),
      activeIndex,
    });
    if (!answer) {
      notice(services, "info", "cancelled");
      return;
    }
    if (answer.action === "reset") {
      await unsetProviderSecret("freebuff");
      notice(services, "info", "unset all keys for Freebuff");
      return;
    }
    if (answer.action === "pick") {
      await savePickerDraft("freebuff", answer, keys, activeIndex);
      const token = await addFreebuffAccount(services);
      if (token) {
        await appendProviderKey("freebuff", token);
        notice(services, "info", `added Freebuff account ${maskSecret(token)}`);
      } else {
        notice(services, "info", "cancelled");
      }
      ({ keys, activeIndex } = await loadOAuthKeys("freebuff"));
      continue;
    }
    if (answer.action === "refresh") {
      const selected = keys.find((key) => key.id === answer.slotId);
      if (selected) {
        const token = await addFreebuffAccount(services);
        if (token) {
          const replaced = await replaceProviderKey("freebuff", selected.value, token);
          if (!replaced) {
            notice(services, "warn", "Freebuff account was not found");
          } else {
            notice(services, "info", `refreshed Freebuff account ${maskSecret(token)}`);
          }
        } else {
          notice(services, "info", "cancelled");
        }
      } else {
        notice(services, "warn", "Freebuff account was not found");
      }
      ({ keys, activeIndex } = await loadOAuthKeys("freebuff"));
      continue;
    }
    await saveOAuthKeys(services, "freebuff", answer, keys, activeIndex);
    return;
  }
}

function pickOmnirushAuthMethod(
  services: AppServices,
): Promise<"signin" | "import" | undefined> {
  return new Promise((resolve) => {
    const opened = services.overlay.openPicker(
      {
        title: "Omnirush sign-in method",
        options: [
          {
            value: "signin",
            label: "Sign in with Omnirush",
            description: "opens a device-code link — works in browser or over SSH",
          },
          {
            value: "import",
            label: "Import existing omnirush CLI login",
            description: "reuse ~/.omnirush/auth.json (OMNIRUSH_DIR overrides)",
          },
        ],
      },
      (value) => {
        services.overlay.close();
        resolve(value as "signin" | "import");
      },
    );
    if (!opened) resolve(undefined);
  });
}

function storeOmnirushAccount(
  services: AppServices,
  tokens: OmnirushOAuthTokens,
): Promise<void> {
  return appendProviderKey("omnirush", tokens.accessToken, {
    refreshToken: tokens.refreshToken,
  }).then(() => {
    notice(services, "info", `added Omnirush account ${maskSecret(tokens.accessToken)}`);
  });
}

async function importOmnirushForUI(
  services: AppServices,
): Promise<OmnirushOAuthTokens | undefined> {
  const imported = await importExistingOmnirushAuth();
  if (!imported) {
    notice(
      services,
      "warn",
      "no existing omnirush login found (run `omnirush login`, or set OMNIRUSH_DIR)",
    );
    return undefined;
  }
  try {
    await validateOmnirushToken(imported.accessToken);
  } catch (error) {
    notice(
      services,
      "warn",
      `imported omnirush token is not valid: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  notice(services, "info", "imported omnirush login");
  return imported;
}

async function addOmnirushAccount(
  services: AppServices,
): Promise<OmnirushOAuthTokens | undefined> {
  const method = await pickOmnirushAuthMethod(services);
  if (!method) return undefined;
  return method === "import"
    ? importOmnirushForUI(services)
    : runOmnirushAuthForUI(services);
}

export async function runOmnirushAuthForUI(
  services: AppServices,
): Promise<OmnirushOAuthTokens | undefined> {
  let start;
  try {
    start = await startOmnirushDeviceAuth();
  } catch (error) {
    notice(
      services,
      "warn",
      `could not start Omnirush sign-in: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }

  void openSystemBrowser(start.verificationUrlComplete).catch(() => {});

  services.overlay.openPager(
    "Omnirush sign-in",
    [
      "Authenticate Omnirush on any device:",
      "",
      `  ${start.verificationUrlComplete}`,
      "",
      `  Code: ${start.userCode}`,
      "",
      "Approve in your browser — clai will continue automatically.",
      "(close this and press Ctrl-C to cancel)",
    ].join("\n"),
    undefined,
    undefined,
    "plain",
  );

  const abortController = new AbortController();
  const unsubscribe = services.overlay.subscribe(() => {
    if (!services.overlay.isOpen()) abortController.abort();
  });

  const waiting = services.toast.info("waiting for Omnirush approval…", {
    sticky: true,
  });
  try {
    const tokens = await pollOmnirushDeviceAuth(start, {
      signal: abortController.signal,
    });
    notice(services, "info", "Omnirush authenticated");
    return tokens;
  } catch (error) {
    if (abortController.signal.aborted) {
      notice(services, "info", "cancelled");
      return undefined;
    }
    notice(
      services,
      "warn",
      `Omnirush sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  } finally {
    unsubscribe();
    services.toast.dismiss(waiting);
  }
}

async function openOmnirushKeysFlow(services: AppServices): Promise<void> {
  let { keys, activeIndex } = await loadOAuthKeys("omnirush");
  for (;;) {
    services.overlay.close();
    const answer = await services.overlay.openKeysEditor({
      provider: "omnirush",
      heading: "OMNIRUSH ACCOUNTS",
      itemLabel: "account",
      addViaPicker: true,
      refreshable: true,
      initialKeys: keys.map((key) => ({
        id: key.id,
        masked: maskSecret(key.value),
        disabled: key.disabled === true,
      })),
      activeIndex,
    });
    if (!answer) {
      notice(services, "info", "cancelled");
      return;
    }
    if (answer.action === "reset") {
      await unsetProviderSecret("omnirush");
      notice(services, "info", "unset all keys for Omnirush");
      return;
    }
    if (answer.action === "pick") {
      await savePickerDraft("omnirush", answer, keys, activeIndex);
      const tokens = await addOmnirushAccount(services);
      if (tokens) {
        await storeOmnirushAccount(services, tokens);
      } else {
        notice(services, "info", "cancelled");
      }
      ({ keys, activeIndex } = await loadOAuthKeys("omnirush"));
      continue;
    }
    if (answer.action === "refresh") {
      const selected = keys.find((key) => key.id === answer.slotId);
      if (selected) {
        const tokens = await addOmnirushAccount(services);
        if (tokens) {
          const replaced = await replaceProviderKey(
            "omnirush",
            selected.value,
            tokens.accessToken,
            { refreshToken: tokens.refreshToken },
          );
          if (!replaced) {
            notice(services, "warn", "Omnirush account was not found");
          } else {
            notice(services, "info", `refreshed Omnirush account ${maskSecret(tokens.accessToken)}`);
          }
        } else {
          notice(services, "info", "cancelled");
        }
      } else {
        notice(services, "warn", "Omnirush account was not found");
      }
      ({ keys, activeIndex } = await loadOAuthKeys("omnirush"));
      continue;
    }
    await saveOAuthKeys(services, "omnirush", answer, keys, activeIndex);
    return;
  }
}

async function loadClineKeys(): Promise<{
  keys: ProviderKeySlot[];
  activeIndex: number;
}> {
  const multi = await getProviderKeys("cline");
  return {
    keys: multi.source === "env" ? [] : multi.keys,
    activeIndex: multi.source === "env" ? 0 : multi.activeIndex,
  };
}

async function storeClineAccount(
  services: AppServices,
  tokens: ClineOAuthTokens,
): Promise<void> {
  if (tokens.refreshToken || tokens.expiresAt !== undefined) {
    await appendProviderKey("cline", tokens.accessToken, {
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
    });
  } else {
    await appendProviderKey("cline", tokens.accessToken);
  }
  notice(services, "info", `added Cline account ${maskSecret(tokens.accessToken)}`);
}

async function refreshClineAccount(
  services: AppServices,
  slot: ProviderKeySlot,
): Promise<void> {
  if (slot.refreshToken) {
    notice(services, "info", "refreshing Cline account…");
    const fresh = await maybeRefreshClineToken(slot.value, slot.refreshToken);
    if (fresh?.accessToken) {
      const replaced = await replaceProviderKey(
        "cline",
        slot.value,
        fresh.accessToken,
        {
          ...(fresh.refreshToken ? { refreshToken: fresh.refreshToken } : {}),
          ...(fresh.expiresAt !== undefined ? { expiresAt: fresh.expiresAt } : {}),
        },
      );
      if (replaced) {
        notice(services, "info", `refreshed Cline account ${maskSecret(fresh.accessToken)}`);
        return;
      }
    }
  }
  const tokens = await runClineAuthForUI(services);
  if (!tokens) {
    notice(services, "info", "cancelled");
    return;
  }
  const replaced = await replaceProviderKey(
    "cline",
    slot.value,
    tokens.accessToken,
    {
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
    },
  );
  if (!replaced) {
    notice(services, "warn", "Cline account was not found");
    return;
  }
  notice(services, "info", `refreshed Cline account ${maskSecret(tokens.accessToken)}`);
}

async function saveClineKeys(
  services: AppServices,
  answer: Extract<KeysEditorAnswer, { action: "save" }>,
  keys: readonly ProviderKeySlot[],
  activeIndex: number,
): Promise<void> {
  const byId = new Map(keys.map((key) => [key.id, key.value]));
  const detailed = resolveEditorRowsDetailed(answer.rows, byId);
  const resolved = detailed.map((row) => row.value);
  if (resolved.length === 0) {
    await unsetProviderSecret("cline");
    notice(services, "info", "unset all keys for cline");
    return;
  }
  for (const key of resolved) {
    if (!getProvider("cline").validateKey(key)) {
      notice(services, "warn", "invalid Cline token");
      return;
    }
  }
  if (resolved.length > MAX_PROVIDER_KEYS) {
    notice(services, "warn", `at most ${MAX_PROVIDER_KEYS} Cline accounts`);
    return;
  }
  await setProviderKeys(
    "cline",
    resolved,
    answer.activeIndex ?? activeIndex,
    detailed.filter((row) => row.disabled).map((row) => row.value),
  );
  const index = answer.activeIndex ?? activeIndex;
  notice(
    services,
    "info",
    resolved.length === 1
      ? `saved cline · ${maskSecret(resolved[0]!)}`
      : `saved cline · ${resolved.length} accounts · active: #${index + 1}`,
  );
}

async function openClineKeysFlow(services: AppServices): Promise<void> {
  let { keys, activeIndex } = await loadClineKeys();
  for (;;) {
    services.overlay.close();
    const answer = await services.overlay.openKeysEditor({
      provider: "cline",
      heading: "CLINE ACCOUNTS",
      itemLabel: "account",
      addViaPicker: true,
      refreshable: true,
      initialKeys: keys.map((key) => ({
        id: key.id,
        masked: maskSecret(key.value),
        disabled: key.disabled === true,
      })),
      activeIndex,
    });
    if (!answer) {
      notice(services, "info", "cancelled");
      return;
    }
    if (answer.action === "reset") {
      await unsetProviderSecret("cline");
      notice(services, "info", "unset all keys for cline");
      return;
    }
    if (answer.action === "pick") {
      await savePickerDraft("cline", answer, keys, activeIndex);
      const tokens = await clineAddAccount(services);
      if (tokens) await storeClineAccount(services, tokens);
      ({ keys, activeIndex } = await loadClineKeys());
      continue;
    }
    if (answer.action === "refresh") {
      const selected = keys.find((key) => key.id === answer.slotId);
      if (selected) {
        await refreshClineAccount(services, selected);
      } else {
        notice(services, "warn", "Cline account was not found");
      }
      ({ keys, activeIndex } = await loadClineKeys());
      continue;
    }
    await saveClineKeys(services, answer, keys, activeIndex);
    return;
  }
}

async function loadOAuthKeys(
  provider: "codex" | "copilot" | "kiro" | "freebuff" | "omnirush",
): Promise<{ keys: ProviderKeySlot[]; activeIndex: number }> {
  const multi = await getProviderKeys(provider);
  return {
    keys: multi.source === "env" ? [] : multi.keys,
    activeIndex: multi.source === "env" ? 0 : multi.activeIndex,
  };
}

async function savePickerDraft(
  provider: "cline" | "codex" | "copilot" | "kiro" | "freebuff" | "omnirush",
  answer: Extract<KeysEditorAnswer, { action: "pick" }>,
  keys: readonly ProviderKeySlot[],
  activeIndex: number,
): Promise<void> {
  const byId = new Map(keys.map((key) => [key.id, key.value]));
  const detailed = answer.rows.flatMap((row) => {
    if (row.slotId) {
      const value = byId.get(row.slotId);
      return value ? [{ value, disabled: row.disabled === true }] : [];
    }
    const value = row.value.trim();
    return value ? [{ value, disabled: row.disabled === true }] : [];
  });
  await setProviderKeys(
    provider,
    detailed.map((row) => row.value),
    answer.activeIndex ?? activeIndex,
    detailed.filter((row) => row.disabled).map((row) => row.value),
  );
}

async function saveOAuthKeys(
  services: AppServices,
  provider: "codex" | "copilot" | "kiro" | "freebuff" | "omnirush",
  answer: Extract<KeysEditorAnswer, { action: "save" }>,
  keys: readonly ProviderKeySlot[],
  activeIndex: number,
): Promise<void> {
  const label = getProvider(provider).displayName;
  const byId = new Map(keys.map((key) => [key.id, key.value]));
  const detailed = resolveEditorRowsDetailed(answer.rows, byId);
  const resolved = detailed.map((row) => row.value);
  if (resolved.length === 0) {
    await unsetProviderSecret(provider);
    notice(services, "info", `unset all keys for ${label}`);
    return;
  }
  for (const key of resolved) {
    if (!getProvider(provider).validateKey(key)) {
      notice(services, "warn", `invalid ${label} token`);
      return;
    }
  }
  if (resolved.length > MAX_PROVIDER_KEYS) {
    notice(services, "warn", `at most ${MAX_PROVIDER_KEYS} ${label} accounts`);
    return;
  }
  await setProviderKeys(
    provider,
    resolved,
    answer.activeIndex ?? activeIndex,
    detailed.filter((row) => row.disabled).map((row) => row.value),
  );
  const index = answer.activeIndex ?? activeIndex;
  notice(
    services,
    "info",
    resolved.length === 1
      ? `saved ${label} · ${maskSecret(resolved[0]!)}`
      : `saved ${label} · ${resolved.length} accounts · active: #${index + 1}`,
  );
}

async function refreshStoredCodexAccount(services: AppServices, slot: ProviderKeySlot): Promise<boolean> {
  if (!decodeCodexKey(slot.value)?.refreshToken) return false;
  notice(services, "info", "refreshing ChatGPT Subscription account…");
  const fresh = await maybeRefreshCodexCredential(slot.value);
  if (!fresh) return false;
  const replaced = await replaceProviderKey("codex", slot.value, fresh);
  notice(services, replaced ? "info" : "warn", replaced
    ? "refreshed ChatGPT Subscription account"
    : "ChatGPT Subscription account was not found");
  return true;
}

async function openCodexKeysFlow(services: AppServices): Promise<void> {
  let { keys, activeIndex } = await loadOAuthKeys("codex");
  for (;;) {
    services.overlay.close();
    const answer = await services.overlay.openKeysEditor({
      provider: "codex",
      heading: "CHATGPT SUBSCRIPTION ACCOUNTS",
      itemLabel: "account",
      addViaPicker: true,
      refreshable: true,
      initialKeys: keys.map((key) => ({
        id: key.id,
        masked: maskSecret(key.value),
        disabled: key.disabled === true,
      })),
      activeIndex,
    });
    if (!answer) {
      notice(services, "info", "cancelled");
      return;
    }
    if (answer.action === "reset") {
      await unsetProviderSecret("codex");
      notice(services, "info", "unset all keys for Chatgpt Subscription");
      return;
    }
    if (answer.action === "pick") {
      await savePickerDraft("codex", answer, keys, activeIndex);
      const credential = await runCodexAuthForUI(services);
      const manualKey = (credential as { manualKey?: string } | undefined)?.manualKey;
      if (credential) {
        const key = manualKey ?? encodeCodexKey(credential);
        await appendProviderKey("codex", key);
        notice(services, "info", `added ChatGPT Subscription account ${maskSecret(key)}`);
      } else {
        notice(services, "info", "cancelled");
      }
      ({ keys, activeIndex } = await loadOAuthKeys("codex"));
      continue;
    }
    if (answer.action === "refresh") {
      const selected = keys.find((key) => key.id === answer.slotId);
      if (selected && await refreshStoredCodexAccount(services, selected)) {
        ({ keys, activeIndex } = await loadOAuthKeys("codex"));
        continue;
      }
      if (selected) {
        const credential = await runCodexAuthForUI(services);
        const manualKey = (credential as { manualKey?: string } | undefined)?.manualKey;
        if (credential) {
          const key = manualKey ?? encodeCodexKey(credential);
          const replaced = await replaceProviderKey("codex", selected.value, key);
          if (!replaced) {
            notice(services, "warn", "ChatGPT Subscription account was not found");
          } else {
            notice(services, "info", `refreshed ChatGPT Subscription account ${maskSecret(key)}`);
          }
        } else {
          notice(services, "info", "cancelled");
        }
      } else {
        notice(services, "warn", "ChatGPT Subscription account was not found");
      }
      ({ keys, activeIndex } = await loadOAuthKeys("codex"));
      continue;
    }
    await saveOAuthKeys(services, "codex", answer, keys, activeIndex);
    return;
  }
}

async function openCopilotKeysFlow(services: AppServices): Promise<void> {
  let { keys, activeIndex } = await loadOAuthKeys("copilot");
  for (;;) {
    services.overlay.close();
    const answer = await services.overlay.openKeysEditor({
      provider: "copilot",
      heading: "GITHUB COPILOT ACCOUNTS",
      itemLabel: "account",
      addViaPicker: true,
      refreshable: true,
      initialKeys: keys.map((key) => ({
        id: key.id,
        masked: maskSecret(key.value),
        disabled: key.disabled === true,
      })),
      activeIndex,
    });
    if (!answer) {
      notice(services, "info", "cancelled");
      return;
    }
    if (answer.action === "reset") {
      await unsetProviderSecret("copilot");
      notice(services, "info", "unset all keys for Github Copilot");
      return;
    }
    if (answer.action === "pick") {
      await savePickerDraft("copilot", answer, keys, activeIndex);
      const token = await runCopilotAuthForUI(services);
      if (token) {
        await appendProviderKey("copilot", token);
        notice(services, "info", `added Github Copilot account ${maskSecret(token)}`);
      } else {
        notice(services, "info", "cancelled");
      }
      ({ keys, activeIndex } = await loadOAuthKeys("copilot"));
      continue;
    }
    if (answer.action === "refresh") {
      const selected = keys.find((key) => key.id === answer.slotId);
      if (selected) {
        const token = await runCopilotAuthForUI(services);
        if (token) {
          const replaced = await replaceProviderKey("copilot", selected.value, token);
          if (!replaced) {
            notice(services, "warn", "Github Copilot account was not found");
          } else {
            notice(services, "info", `refreshed Github Copilot account ${maskSecret(token)}`);
          }
        } else {
          notice(services, "info", "cancelled");
        }
      } else {
        notice(services, "warn", "Github Copilot account was not found");
      }
      ({ keys, activeIndex } = await loadOAuthKeys("copilot"));
      continue;
    }
    await saveOAuthKeys(services, "copilot", answer, keys, activeIndex);
    return;
  }
}

function pickKiroAuthMethod(
  services: AppServices,
): Promise<"kiro-cli" | "builder-id" | "idc" | "import" | "apikey" | undefined> {
  return new Promise((resolve) => {
    const opened = services.overlay.openPicker(
      {
        title: "Kiro AI sign-in method",
        options: [
          {
            value: "kiro-cli",
            label: "Sign in with Kiro (recommended)",
            description: "Google, GitHub, or Builder ID — browser, or device code over SSH",
          },
          {
            value: "builder-id",
            label: "Sign in with AWS Builder ID",
            description: "device code — works on any device or terminal",
          },
          {
            value: "idc",
            label: "Sign in with AWS IAM Identity Center (IDC)",
            description: "enterprise SSO start URL",
          },
          {
            value: "import",
            label: "Import existing Kiro CLI / Desktop sign-in",
            description: "reads local Kiro or AWS SSO credentials",
          },
          {
            value: "apikey",
            label: "Manually enter API key / token",
            description: "paste an API key or token",
          },
        ],
      },
      (value) => {
        services.overlay.close();
        resolve(value as "kiro-cli" | "builder-id" | "idc" | "import" | "apikey");
      },
    );
    if (!opened) resolve(undefined);
  });
}

async function runDeviceCodeForUI(
  services: AppServices,
  input: {
    readonly url: string;
    readonly code: string;
    readonly successMessage: string;
    readonly poll: (signal: AbortSignal) => Promise<KiroCredential>;
  },
): Promise<KiroCredential | undefined> {
  const headless = isHeadlessEnvironment();
  if (!headless) void openSystemBrowser(input.url).catch(() => {});

  services.overlay.openPager(
    "Kiro AI sign-in",
    [
      headless
        ? "No local browser detected. Open this link on any device (phone or laptop):"
        : "Authenticate Kiro AI on any device:",
      "",
      `  ${input.url}`,
      "",
      `  Code: ${input.code}`,
      "",
      "Approve in your browser — clai will continue automatically.",
      "(close this and press Ctrl-C to cancel)",
    ].join("\n"),
    undefined,
    undefined,
    "plain",
  );

  const abortController = new AbortController();
  const unsubscribe = services.overlay.subscribe(() => {
    if (!services.overlay.isOpen()) abortController.abort();
  });

  const waiting = services.toast.info("waiting for Kiro approval…", {
    sticky: true,
  });
  try {
    const credential = await input.poll(abortController.signal);
    notice(services, "info", input.successMessage);
    return credential;
  } catch (error) {
    if (abortController.signal.aborted) {
      notice(services, "info", "cancelled");
      return undefined;
    }
    notice(
      services,
      "warn",
      `Kiro AI sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  } finally {
    unsubscribe();
    services.toast.dismiss(waiting);
  }
}

export async function runKiroDeviceAuthForUI(
  services: AppServices,
  options: {
    authMethod?: "builder-id" | "idc" | undefined;
    startUrl?: string | undefined;
    region?: string | undefined;
  } = {},
): Promise<KiroCredential | undefined> {
  let start;
  try {
    start = await startKiroDeviceAuth(options);
  } catch (error) {
    notice(
      services,
      "warn",
      `could not start Kiro sign-in: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  const deviceStart = start;
  return runDeviceCodeForUI(services, {
    url: deviceStart.verificationUriComplete || deviceStart.verificationUri,
    code: deviceStart.userCode,
    successMessage: "Kiro AI authenticated",
    poll: (signal) => pollKiroDeviceAuth(deviceStart, { signal }),
  });
}

export async function runKiroSocialDeviceAuthForUI(
  services: AppServices,
  provider: KiroSocialProvider,
): Promise<KiroCredential | undefined> {
  let start;
  try {
    start = await startKiroSocialDeviceAuth(provider);
  } catch (error) {
    notice(
      services,
      "warn",
      `could not start Kiro sign-in: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  const deviceStart = start;
  const label = provider === "google" ? "Google" : "GitHub";
  return runDeviceCodeForUI(services, {
    url: deviceStart.verificationUriComplete,
    code: deviceStart.userCode,
    successMessage: `Kiro AI (${label}) authenticated`,
    poll: (signal) => pollKiroSocialDeviceAuth(deviceStart, { signal }),
  });
}

function pickKiroHeadlessMethod(
  services: AppServices,
): Promise<"github" | "google" | "builder-id" | undefined> {
  return new Promise((resolve) => {
    const opened = services.overlay.openPicker(
      {
        title: "Kiro AI sign-in (no local browser)",
        options: [
          { value: "github", label: "GitHub", description: "approve with a code on any device" },
          { value: "google", label: "Google", description: "approve with a code on any device" },
          { value: "builder-id", label: "AWS Builder ID", description: "device code on any device" },
        ],
      },
      (value) => {
        services.overlay.close();
        resolve(value as "github" | "google" | "builder-id");
      },
    );
    if (!opened) resolve(undefined);
  });
}

export async function runKiroPortalAuthForUI(
  services: AppServices,
): Promise<KiroCredential | undefined> {
  if (isHeadlessEnvironment()) {
    const method = await pickKiroHeadlessMethod(services);
    if (!method) return undefined;
    return method === "builder-id"
      ? runKiroDeviceAuthForUI(services, { authMethod: "builder-id" })
      : runKiroSocialDeviceAuthForUI(services, method);
  }

  const { authorizeUrl, codeVerifier, state } = createKiroCliAuthorizationFlow();

  let server: KiroCliCallbackServer | undefined;
  try {
    server = listenForKiroCliCallback({ expectedState: state });
  } catch {
    server = undefined;
  }

  if (server) {
    server.promise
      .then((cb) => services.overlay.answerSecret(`${cb.path}?code=${cb.code}&login_option=${cb.loginOption}${cb.state ? `&state=${cb.state}` : ""}`))
      .catch(() => {});
  }

  await openSystemBrowser(authorizeUrl).catch(() => {});

  const waiting = services.toast.info("waiting for Kiro sign-in…", {
    sticky: true,
  });

  const prompt =
    "Sign in with Google, GitHub, or Builder ID in your browser.\nclai will continue automatically — or paste the redirect URL / code below:";

  try {
    const pasted = await services.overlay.openSecret({
      title: "Kiro AI sign-in",
      prompt,
      reveal: true,
    });

    if (!pasted?.trim()) return undefined;

    const cb = parseKiroCliCallback(pasted.trim());
    if (cb.state && cb.state !== state) {
      throw new Error("Kiro sign-in state mismatch — start again");
    }
    const cred = await exchangeKiroPortalCode(cb, codeVerifier);
    notice(services, "info", "Kiro AI authenticated");
    return cred;
  } catch (err) {
    notice(
      services,
      "warn",
      `Kiro sign-in failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  } finally {
    services.toast.dismiss(waiting);
    server?.close();
  }
}

export async function runKiroSocialAuthForUI(
  services: AppServices,
  provider: "google" | "github",
): Promise<KiroCredential | undefined> {
  if (isHeadlessEnvironment()) return runKiroSocialDeviceAuthForUI(services, provider);
  const { url, codeVerifier } = await startKiroSocialAuth(provider);
  const label = provider === "google" ? "Google" : "GitHub";

  let callbackHandle: { close: () => void } | undefined;
  try {
    callbackHandle = await listenForKiroSocialCallback({
      onCode: (urlOrCode) => {
        services.overlay.answerSecret(urlOrCode);
      },
    });
  } catch {}

  await openSystemBrowser(url).catch(() => {});

  const waiting = services.toast.info(`waiting for Kiro (${label}) sign-in…`, {
    sticky: true,
  });

  try {
    const pasted = await services.overlay.openSecret({
      title: `Kiro AI (${label}) sign-in`,
      prompt: `Sign in with ${label} in your browser.\nWhen prompted "Open Kiro", click Open (or paste the redirect URL / code below):`,
      reveal: true,
    });

    if (!pasted?.trim()) return undefined;

    const cred = await exchangeKiroSocialCode(pasted.trim(), codeVerifier, provider);
    notice(services, "info", `Kiro AI (${label}) authenticated`);
    return cred;
  } catch (err) {
    notice(
      services,
      "warn",
      `Kiro sign-in failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  } finally {
    services.toast.dismiss(waiting);
    callbackHandle?.close();
  }
}

export async function runKiroAuthForUI(
  services: AppServices,
): Promise<KiroCredential | undefined> {
  const method = await pickKiroAuthMethod(services);
  if (!method) return undefined;

  if (method === "kiro-cli") {
    return runKiroPortalAuthForUI(services);
  }

  if (method === "builder-id") {
    return runKiroDeviceAuthForUI(services, { authMethod: "builder-id" });
  }

  if (method === "idc") {
    const startUrl = await services.overlay.openSecret({
      title: "AWS IAM Identity Center Start URL",
      prompt: "Enter AWS IDC Start URL (e.g. https://my-org.awsapps.com/start):",
      reveal: true,
    });
    if (!startUrl?.trim()) return undefined;
    const region = await services.overlay.openSecret({
      title: "AWS Region",
      prompt: "Enter AWS Region (default: us-east-1):",
      reveal: true,
    });
    return runKiroDeviceAuthForUI(services, {
      authMethod: "idc",
      startUrl: startUrl.trim(),
      region: region?.trim() || "us-east-1",
    });
  }

  if (method === "import") {
    const imported = await importExistingKiroAuth();
    if (!imported) {
      notice(services, "warn", "no existing Kiro credential found to import");
      return undefined;
    }
    notice(services, "info", "imported existing Kiro credentials");
    return imported;
  }

  if (method === "apikey") {
    const answer = await services.overlay.openSecret({
      title: "Kiro API Key or Token",
      prompt: "Paste Kiro API key, access token, or refresh token:",
    });
    const raw = answer?.trim();
    if (!raw) return undefined;
    if (raw.startsWith(KIRO_KEY_PREFIX)) {
      const decoded = decodeKiroKey(raw);
      if (decoded) return decoded;
    }
    if (raw.startsWith("aorAAAAAG")) {
      try {
        return await refreshKiroToken(raw);
      } catch (err) {
        notice(
          services,
          "warn",
          `failed to validate refresh token: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
    }
    return {
      accessToken: raw,
      apiKey: raw,
      authMethod: "api_key",
      region: "us-east-1",
    };
  }

  return undefined;
}

async function openKiroKeysFlow(services: AppServices): Promise<void> {
  let { keys, activeIndex } = await loadOAuthKeys("kiro");
  for (;;) {
    services.overlay.close();
    const answer = await services.overlay.openKeysEditor({
      provider: "kiro",
      heading: "KIRO AI ACCOUNTS",
      itemLabel: "account",
      addViaPicker: true,
      refreshable: true,
      initialKeys: keys.map((key) => ({
        id: key.id,
        masked: maskSecret(key.value),
        disabled: key.disabled === true,
      })),
      activeIndex,
    });
    if (!answer) {
      notice(services, "info", "cancelled");
      return;
    }
    if (answer.action === "reset") {
      await unsetProviderSecret("kiro");
      notice(services, "info", "unset all keys for Kiro AI");
      return;
    }
    if (answer.action === "pick") {
      await savePickerDraft("kiro", answer, keys, activeIndex);
      const credential = await runKiroAuthForUI(services);
      if (credential) {
        const key = encodeKiroKey(credential);
        await appendProviderKey("kiro", key, {
          ...(credential.refreshToken ? { refreshToken: credential.refreshToken } : {}),
          ...(credential.expiresAt !== undefined ? { expiresAt: credential.expiresAt } : {}),
        });
        notice(services, "info", `added Kiro account ${maskSecret(key)}`);
      } else {
        notice(services, "info", "cancelled");
      }
      ({ keys, activeIndex } = await loadOAuthKeys("kiro"));
      continue;
    }
    if (answer.action === "refresh") {
      const selected = keys.find((key) => key.id === answer.slotId);
      if (selected) {
        if (selected.refreshToken || isKiroOAuthToken(selected.value)) {
          notice(services, "info", "refreshing Kiro account…");
          const refreshedKey = await maybeRefreshKiroCredential(
            selected.value,
            selected.refreshToken,
          );
          if (refreshedKey) {
            const decoded = decodeKiroKey(refreshedKey);
            const replaced = await replaceProviderKey("kiro", selected.value, refreshedKey, {
              ...(decoded?.refreshToken ? { refreshToken: decoded.refreshToken } : {}),
              ...(decoded?.expiresAt !== undefined ? { expiresAt: decoded.expiresAt } : {}),
            });
            if (replaced) {
              notice(services, "info", `refreshed Kiro account ${maskSecret(refreshedKey)}`);
              ({ keys, activeIndex } = await loadOAuthKeys("kiro"));
              continue;
            }
          }
        }
        const credential = await runKiroAuthForUI(services);
        if (credential) {
          const key = encodeKiroKey(credential);
          const replaced = await replaceProviderKey("kiro", selected.value, key, {
            ...(credential.refreshToken ? { refreshToken: credential.refreshToken } : {}),
            ...(credential.expiresAt !== undefined ? { expiresAt: credential.expiresAt } : {}),
          });
          if (!replaced) {
            notice(services, "warn", "Kiro account was not found");
          } else {
            notice(services, "info", `refreshed Kiro account ${maskSecret(key)}`);
          }
        } else {
          notice(services, "info", "cancelled");
        }
      } else {
        notice(services, "warn", "Kiro account was not found");
      }
      ({ keys, activeIndex } = await loadOAuthKeys("kiro"));
      continue;
    }
    await saveOAuthKeys(services, "kiro", answer, keys, activeIndex);
    return;
  }
}

export async function openLlmKeysEditor(
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

  if (id === "qoder") {
    await openQoderKeysFlow(services);
    return;
  }

  if (id === "cline") {
    await openClineKeysFlow(services);
    return;
  }

  if (id === "codex") {
    await openCodexKeysFlow(services);
    return;
  }

  if (id === "copilot") {
    await openCopilotKeysFlow(services);
    return;
  }

  if (id === "kiro") {
    await openKiroKeysFlow(services);
    return;
  }

  if (id === "freebuff") {
    await openFreebuffKeysFlow(services);
    return;
  }

  if (id === "omnirush") {
    await openOmnirushKeysFlow(services);
    return;
  }

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
  if (answer.action === "refresh") return;

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
