import { invalidateCustomProviderCache, materializeCustomProvider, normalizeCustomBaseUrl, normalizeCustomProviderId } from "../../../llm/custom-providers.js";
import type { CustomProviderApi, CustomProviderDef } from "../../../llm/custom-providers.js";
import { addCustomProvider, getConfig, getCustomProviders, getProviderModel, removeCustomProvider, setDefaultProvider, setProviderModel, updateConfig } from "../../../store/config.js";
import { setProviderSecret, unsetProviderSecret } from "../../../store/keys.js";
import { providerIds } from "../../../types.js";
import type { ProviderId } from "../../../types.js";
import type { AppServices } from "../../bootstrap/composition-root.js";

export async function addCustomProviderFlow(services: AppServices): Promise<void> {
  services.overlay.close();

  const existingBuiltins = providerIds as readonly string[];
  const existingCustom = getCustomProviders().map((d) => d.id);
  const existing = [...existingBuiltins, ...existingCustom];

  const idAnswer = await services.overlay.openSecret({
    title: "New custom provider · 1 of 6 · id",
    prompt:
      "Enter a short id (lowercase, a-z 0-9 and hyphens, e.g. myllm). This is how clai names the provider internally.",
    reveal: true,
  });
  const id = normalizeCustomProviderId(idAnswer?.trim() ?? "", existing);
  if (!id) {
    services.session.notice(
      "info",
      idAnswer?.trim()
        ? `"${idAnswer!.trim()}" is not a unique provider id (use lowercase a-z 0-9 hyphens)`
        : "cancelled · provider unchanged",
    );
    return;
  }

  const nameAnswer = await services.overlay.openSecret({
    title: `New custom provider · 2 of 6 · name`,
    prompt: `Enter a display name for "${id}" (shown in pickers), e.g. My LLM Gateway:`,
    reveal: true,
  });
  const displayName = nameAnswer?.trim() || id;

  const api = await new Promise<CustomProviderApi | undefined>((resolve) => {
    const opened = services.overlay.openPicker(
      {
        title: `New custom provider · 3 of 6 · API type`,
        options: [
          { value: "chat-completions", label: "OpenAI Chat Completions", description: "/chat/completions" },
          { value: "responses", label: "OpenAI Responses", description: "/responses" },
          { value: "anthropic-messages", label: "Anthropic Messages", description: "/messages" },
        ],
      },
      (value) => resolve(value as CustomProviderApi),
    );
    if (!opened) resolve(undefined);
  });
  services.overlay.close();
  if (!api) {
    services.session.notice("info", "cancelled · provider unchanged");
    return;
  }

  const urlAnswer = await services.overlay.openSecret({
    title: `New custom provider · 4 of 6 · base URL`,
    prompt: `Paste the base URL for ${displayName}. e.g. https://api.example.com/v1`,
    reveal: true,
  });
  const baseUrl = normalizeCustomBaseUrl(urlAnswer?.trim() ?? "");
  if (!baseUrl) {
    services.session.notice("info", "cancelled · provider unchanged");
    return;
  }

  const keyAnswer = await services.overlay.openSecret({
    title: `New custom provider · 5 of 6 · API key`,
    prompt: `Enter the API key / bearer token for ${displayName} (input hidden). Leave blank to skip and set it later with /set ${id}.`,
  });
  const apiKey = keyAnswer?.trim() ?? "";

  const tempDef: CustomProviderDef = {
    id,
    displayName,
    baseUrl,
    defaultModel: "",
    api,
  };
  const tempProvider = materializeCustomProvider(tempDef);
  const fetchingToastId = services.toast.info(`fetching ${displayName} models…`, {
    key: "model-fetch",
    sticky: true,
  });
  let models: string[] = [];
  try {
    const list = tempProvider.listModels;
    if (list) models = await list({ apiKey: apiKey || undefined });
  } catch (err) {
    services.session.notice(
      "warn",
      `could not fetch models from ${displayName}: ${err instanceof Error ? err.message : String(err)} · you can set one manually with /model <name>`,
    );
  } finally {
    services.toast.dismiss(fetchingToastId);
  }

  let defaultModel = "";
  if (models.length > 0) {
    services.overlay.close();
    const picked = await new Promise<string | undefined>((resolve) => {
      const opened = services.overlay.openPicker(
        {
          title: `Models · ${displayName} · live`,
          options: models.map((value) => ({ value, label: value })),
        },
        (value) => resolve(value),
      );
      if (!opened) resolve(undefined);
    });
    services.overlay.close();
    defaultModel = picked?.trim() ?? "";
    if (!defaultModel) {
      services.session.notice("info", "cancelled · provider unchanged");
      return;
    }
  } else {
    const modelAnswer = await services.overlay.openSecret({
      title: `New custom provider · 6 of 6 · default model`,
      prompt: `Enter the default model id for ${displayName} (you can change it later with /model <name>):`,
      reveal: true,
    });
    defaultModel = modelAnswer?.trim() ?? "";
    if (!defaultModel) {
      services.session.notice("info", "cancelled · provider unchanged");
      return;
    }
  }

  const def: CustomProviderDef = { id, displayName, baseUrl, defaultModel, api };
  addCustomProvider(def);
  invalidateCustomProviderCache(id);
  if (apiKey) {
    await setProviderSecret(id as ProviderId, apiKey);
  }
  setProviderModel(id as ProviderId, defaultModel);
  setDefaultProvider(id as ProviderId);
  services.session.setProvider(id as ProviderId);
  services.session.setModel(defaultModel);
  services.overlay.close();
  services.session.notice(
    "info",
    `added custom provider ${displayName} (${id}) · model → ${defaultModel}${apiKey ? "" : " · no key set (use /set " + id + " <key>)"}`,
  );
}

export async function removeCustomProviderFlow(services: AppServices): Promise<void> {
  services.overlay.close();
  const custom = getCustomProviders();
  if (custom.length === 0) {
    services.session.notice("info", "no custom providers to remove");
    return;
  }
  const config = getConfig();
  const activeProvider = services.session.getState().provider ?? config.defaultProvider;

  const picked = await new Promise<string | undefined>((resolve) => {
    const opened = services.overlay.openPicker(
      {
        title: "Remove custom provider",
        options: custom.map((def) => ({
          value: def.id,
          label: def.id,
          description: `${def.displayName} · ${def.baseUrl}`,
          active: def.id === activeProvider,
        })),
      },
      (value) => resolve(value),
    );
    if (!opened) resolve(undefined);
  });
  services.overlay.close();
  if (!picked) {
    services.session.notice("info", "cancelled · nothing removed");
    return;
  }

  const def = custom.find((d) => d.id === picked);
  const displayName = def?.displayName ?? picked;

  const confirmed = await services.overlay.openConfirm({
    kind: "reset",
    prompt: `Remove custom provider "${displayName}" (${picked})?\n\nThis deletes its definition, all stored API keys, and the per-provider model + endpoint overrides. This cannot be undone.`,
  });
  services.overlay.close();
  if (!confirmed) {
    services.session.notice("info", "cancelled · nothing removed");
    return;
  }

  removeCustomProvider(picked);
  try {
    await unsetProviderSecret(picked as ProviderId);
  } catch {
  }
  const providerModels = { ...getConfig().providerModels };
  delete providerModels[picked as ProviderId];
  const providerEndpoints = { ...getConfig().providerEndpoints };
  delete providerEndpoints[picked as ProviderId];
  updateConfig({ providerModels, providerEndpoints });
  invalidateCustomProviderCache(picked);

  if (picked === activeProvider || picked === config.defaultProvider) {
    const fallback = "nvidia" as ProviderId;
    setDefaultProvider(fallback);
    services.session.setProvider(fallback);
    services.session.setModel(getProviderModel(fallback));
    services.session.notice(
      "info",
      `removed custom provider ${displayName} (${picked}) · switched to ${fallback}`,
    );
  } else {
    services.session.notice(
      "info",
      `removed custom provider ${displayName} (${picked})`,
    );
  }
}
