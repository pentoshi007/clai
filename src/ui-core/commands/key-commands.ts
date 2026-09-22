
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
import {
  pollClineDeviceAuth,
  startClineDeviceAuth,
  type ClineOAuthTokens,
} from "../../llm/cline-auth.js";
import {
  codexKeyFromAccessToken,
  encodeCodexKey,
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
import { appendProviderKey, replaceProviderKey, type ProviderKeySlot } from "../../store/keys.js";
import { MAX_PROVIDER_KEYS } from "../../llm/key-rotation.js";

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

  const waiting = services.toast.info("waiting for Cline approval…", {
    sticky: true,
  });
  try {
    const tokens = await pollClineDeviceAuth(start);
    services.toast.dismiss(waiting);
    notice(services, "info", "Cline authenticated");
    return tokens;
  } catch (error) {
    services.toast.dismiss(waiting);
    notice(
      services,
      "warn",
      `Cline sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
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

function pickCodexAuthMethod(
  services: AppServices,
): Promise<"browser" | "headless" | "apikey" | undefined> {
  return new Promise((resolve) => {
    const opened = services.overlay.openPicker(
      {
        title: "ChatGPT Subscription sign-in method",
        options: [
          {
            value: "browser",
            label: "Sign in with ChatGPT (browser)",
            description: "opens auth.openai.com in your browser",
          },
          {
            value: "headless",
            label: "Sign in with ChatGPT (headless)",
            description: "device code — works on remote/SSH machines",
          },
          {
            value: "apikey",
            label: "Manually enter access token / API key",
            description: "paste an existing Chatgpt Subscription token",
          },
        ],
      },
      (value) => {
        services.overlay.close();
        resolve(value as "browser" | "headless" | "apikey");
      },
    );
    if (!opened) resolve(undefined);
  });
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

  const waiting = services.toast.info("waiting for ChatGPT approval…", {
    sticky: true,
  });
  try {
    await openSystemBrowser(handle.url).catch(() => {});
    const credential = await handle.waitForCredential();
    services.toast.dismiss(waiting);
    notice(services, "info", "ChatGPT Subscription authenticated");
    return credential;
  } catch (error) {
    services.toast.dismiss(waiting);
    notice(
      services,
      "warn",
      `ChatGPT Subscription sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
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

  const waiting = services.toast.info("waiting for ChatGPT approval…", {
    sticky: true,
  });
  try {
    const credential = await pollCodexDeviceAuth(start);
    services.toast.dismiss(waiting);
    notice(services, "info", "ChatGPT Subscription authenticated");
    return credential;
  } catch (error) {
    services.toast.dismiss(waiting);
    notice(
      services,
      "warn",
      `ChatGPT Subscription sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
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

  const waiting = services.toast.info("waiting for Github Copilot approval…", {
    sticky: true,
  });
  try {
    const token = await pollCopilotDeviceAuth(start);
    services.toast.dismiss(waiting);
    notice(services, "info", "Github Copilot authenticated");
    return token;
  } catch (error) {
    services.toast.dismiss(waiting);
    notice(
      services,
      "warn",
      `Github Copilot sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
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
  oldValue: string,
): Promise<void> {
  const tokens = await runClineAuthForUI(services);
  if (!tokens) {
    notice(services, "info", "cancelled");
    return;
  }
  const replaced = await replaceProviderKey(
    "cline",
    oldValue,
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
        await refreshClineAccount(services, selected.value);
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
  provider: "codex" | "copilot",
): Promise<{ keys: ProviderKeySlot[]; activeIndex: number }> {
  const multi = await getProviderKeys(provider);
  return {
    keys: multi.source === "env" ? [] : multi.keys,
    activeIndex: multi.source === "env" ? 0 : multi.activeIndex,
  };
}

async function savePickerDraft(
  provider: "cline" | "codex" | "copilot",
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
  provider: "codex" | "copilot",
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
