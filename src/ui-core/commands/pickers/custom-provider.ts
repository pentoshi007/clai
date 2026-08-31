import { invalidateCustomProviderCache, materializeCustomProvider, normalizeCustomBaseUrl, normalizeCustomProviderId } from "../../../llm/custom-providers.js";
import type { CustomProviderDef } from "../../../llm/custom-providers.js";
import { addCustomProvider, getConfig, getCustomProviders, getProviderModel, removeCustomProvider, setDefaultProvider, setProviderModel, updateConfig } from "../../../store/config.js";
import { setProviderSecret, unsetProviderSecret } from "../../../store/keys.js";
import { providerIds } from "../../../types.js";
import type { ProviderId } from "../../../types.js";
import type { AppServices } from "../../bootstrap/composition-root.js";

/**
 * Add a user-defined (custom) provider. Walks the operator through every
 * required field, then fetches the live model catalogue from the endpoint and
 * lets them pick a default model before activating the new provider.
 *
 * Every prompt is a single `openSecret` modal (re-used for non-secret values
 * with `reveal: true`), so the flow works in both the OpenTUI and classic TUI.
 * Cancelling any step leaves the active provider untouched.
 */
export async function addCustomProviderFlow(services: AppServices): Promise<void> {
  services.overlay.close();

  // Existing ids (built-in + custom) so we can reject collisions up front.
  const existingBuiltins = providerIds as readonly string[];
  const existingCustom = getCustomProviders().map((d) => d.id);
  const existing = [...existingBuiltins, ...existingCustom];

  // 1. Provider id — a URL-safe slug used as the key namespace and config key.
  const idAnswer = await services.overlay.openSecret({
    title: "New custom provider · 1 of 5 · id",
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

  // 2. Display name — shown in pickers and toasts.
  const nameAnswer = await services.overlay.openSecret({
    title: `New custom provider · 2 of 5 · name`,
    prompt: `Enter a display name for "${id}" (shown in pickers), e.g. My LLM Gateway:`,
    reveal: true,
  });
  const displayName = nameAnswer?.trim() || id;

  // 3. Base URL — the OpenAI-compatible endpoint root (clai appends /v1).
  const urlAnswer = await services.overlay.openSecret({
    title: `New custom provider · 3 of 5 · base URL`,
    prompt: `Paste the base URL for ${displayName} (OpenAI-compatible). e.g. https://api.example.com/v1`,
    reveal: true,
  });
  const baseUrl = normalizeCustomBaseUrl(urlAnswer?.trim() ?? "");
  if (!baseUrl) {
    services.session.notice("info", "cancelled · provider unchanged");
    return;
  }

  // 4. API key — masked; stored under the multi-key envelope so /set can add
  //    more later and the rotation logic treats it like any other provider.
  const keyAnswer = await services.overlay.openSecret({
    title: `New custom provider · 4 of 5 · API key`,
    prompt: `Enter the API key / bearer token for ${displayName} (input hidden). Leave blank to skip and set it later with /set ${id}.`,
  });
  const apiKey = keyAnswer?.trim() ?? "";

  // 5. Default model — fetch the live /models list and let the user pick.
  //    We materialise the provider in memory (before persisting) so the
  //    listModels call works without a config round-trip.
  const tempDef: CustomProviderDef = {
    id,
    displayName,
    baseUrl,
    defaultModel: "", // filled after the model pick
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
    // No live list (key skipped or fetch failed): ask for a model name to use
    // as the default so the provider is usable immediately.
    const modelAnswer = await services.overlay.openSecret({
      title: `New custom provider · 5 of 5 · default model`,
      prompt: `Enter the default model id for ${displayName} (you can change it later with /model <name>):`,
      reveal: true,
    });
    defaultModel = modelAnswer?.trim() ?? "";
    if (!defaultModel) {
      services.session.notice("info", "cancelled · provider unchanged");
      return;
    }
  }

  // Persist the definition + the key + the chosen model, then activate.
  const def: CustomProviderDef = { id, displayName, baseUrl, defaultModel };
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

/**
 * Remove a user-defined (custom) provider. Lists only custom providers in a
 * picker, asks for confirmation, then tears down everything clai stored for
 * it: the definition, the multi-key envelope, the per-provider model and
 * endpoint overrides, and the in-memory provider cache. If the removed
 * provider was the active/default one, switches back to the nvidia default so
 * the session never points at a now-unknown id.
 */
export async function removeCustomProviderFlow(services: AppServices): Promise<void> {
  services.overlay.close();
  const custom = getCustomProviders();
  if (custom.length === 0) {
    services.session.notice("info", "no custom providers to remove");
    return;
  }
  const config = getConfig();
  const activeProvider = services.session.getState().provider ?? config.defaultProvider;

  // 1. Pick which custom provider to delete.
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

  // 2. Confirm — deletion is irreversible (clears keys + model + endpoints).
  const confirmed = await services.overlay.openConfirm({
    kind: "reset",
    prompt: `Remove custom provider "${displayName}" (${picked})?\n\nThis deletes its definition, all stored API keys, and the per-provider model + endpoint overrides. This cannot be undone.`,
  });
  services.overlay.close();
  if (!confirmed) {
    services.session.notice("info", "cancelled · nothing removed");
    return;
  }

  // 3. Tear down: definition, keys, model override, endpoint list, cache.
  removeCustomProvider(picked);
  try {
    await unsetProviderSecret(picked as ProviderId);
  } catch {
    // No key stored (or env-only) — nothing to delete; not an error.
  }
  // Clear the per-provider model + endpoint overrides so they don't linger.
  const providerModels = { ...getConfig().providerModels };
  delete providerModels[picked as ProviderId];
  const providerEndpoints = { ...getConfig().providerEndpoints };
  delete providerEndpoints[picked as ProviderId];
  updateConfig({ providerModels, providerEndpoints });
  invalidateCustomProviderCache(picked);

  // 4. If we just deleted the active/default provider, switch to a safe
  //    built-in so the next request doesn't target a now-unknown id.
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
