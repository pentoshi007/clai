import { getKnownModels } from "../../../app/commands/catalog.js";
import type { CommandInvocation } from "../../../app/commands/command.js";
import { assertProvider, defaultModels, normalizeEndpointUrl } from "../../../llm/provider.js";
import { getProvider, providerAuth } from "../../../llm/router.js";
import { appendProviderEndpoint, getActiveProviderEndpoint, getConfig, getCustomProviders, getProviderModel } from "../../../store/config.js";
import { envValue, getProviderSecret, setProviderSecret } from "../../../store/keys.js";
import { saveSessionModel } from "../../../store/session-model.js";
import { providerIds } from "../../../types.js";
import type { ProviderId } from "../../../types.js";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { PickerOption } from "../../rendering/picker-filter.js";
import { addCustomProviderFlow, removeCustomProviderFlow } from "./custom-provider.js";

/**
 * Live provider model catalogue (matches classic TUI `/model`).
 * Prefers `provider.listModels`; falls back to the static known list.
 */
export async function resolveModelsForProvider(
  provider: ProviderId,
  currentModel?: string | undefined,
): Promise<{ models: string[]; source: "live" | "known"; error?: string }> {
  const providerImpl = getProvider(provider);
  let models: string[] = [];
  let error: string | undefined;

  if (providerImpl.listModels) {
    try {
      const auth = await providerAuth(provider);
      models = await providerImpl.listModels(auth);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  let source: "live" | "known" = "live";
  if (models.length === 0) {
    models = getKnownModels(provider);
    source = "known";
  }

  if (currentModel && !models.includes(currentModel) && currentModel === getProviderModel(provider)) {
    const isFreeModel = currentModel.startsWith("free-1/") || currentModel.startsWith("free-2/");
    if (!(isFreeModel && provider !== "free")) {
      models = [currentModel, ...models];
    }
  }
  return error ? { models, source, error } : { models, source };
}

export function persistSessionModel(
  services: AppServices,
  provider: ProviderId,
  model: string,
): Promise<void> {
  return saveSessionModel(services.session.sessionId, { provider, model });
}

export function applyModel(
  services: AppServices,
  provider: ProviderId,
  model: string,
  options: readonly string[] = getKnownModels(provider),
): void {
  const index = Number.parseInt(model, 10);
  const next =
    Number.isInteger(index) && index >= 1 && index <= options.length
      ? options[index - 1]!
      : model;
  services.session.setModel(next);
  void persistSessionModel(services, provider, next).catch(() => undefined);
  services.session.notice("info", `model → ${next}`);
}

/** Sentinel value returned by the /provider picker for "add a custom provider". */
const ADD_CUSTOM_PROVIDER = "__add_custom_provider__";

/** Sentinel for the "remove a custom provider" picker row. */
const REMOVE_CUSTOM_PROVIDER = "__remove_custom_provider__";

export function handleProvider(services: AppServices, invocation: CommandInvocation): void {
  if (invocation.args) {
    try {
      void activateProvider(services, assertProvider(invocation.args.trim()));
    } catch {
      services.session.notice("warn", `unknown provider: ${invocation.args.trim()}`);
    }
    return;
  }
  void (async () => {
    const current = services.session.getState().provider ?? getConfig().defaultProvider;
    // Custom (user-defined) providers appear after the built-ins, plus
    // dedicated rows at the top to launch the add / remove flows.
    const { getCustomProviders } = await import("../../../store/config.js");
    const custom = getCustomProviders();
    const options: PickerOption[] = [
      {
        value: ADD_CUSTOM_PROVIDER,
        label: "+ Add custom provider",
        description: "connect an OpenAI-compatible endpoint not listed above",
      },
      // Only offer removal when at least one custom provider exists.
      ...(custom.length > 0
        ? [
            {
              value: REMOVE_CUSTOM_PROVIDER,
              label: "− Remove custom provider",
              description: `${custom.length} custom provider${custom.length === 1 ? "" : "s"} · delete a definition + its keys`,
            },
          ]
        : []),
      ...providerIds.map((value) => ({
        value,
        label: value,
        description: getProviderModel(value),
        active: value === current,
      })),
      ...custom.map((def) => ({
        value: def.id,
        label: def.id,
        description: getProviderModel(def.id as ProviderId),
        active: def.id === current,
      })),
    ];
    services.overlay.openPicker(
      {
        title: "Providers",
        searchDescription: false,
        options,
      },
      (value) => {
        if (value === ADD_CUSTOM_PROVIDER) {
          void addCustomProviderFlow(services);
          return;
        }
        if (value === REMOVE_CUSTOM_PROVIDER) {
          void removeCustomProviderFlow(services);
          return;
        }
        void activateProvider(services, assertProvider(value));
      },
    );
  })();
}

async function activateProvider(services: AppServices, next: ProviderId): Promise<void> {
  // Modal needs two separate things, so it gets its own onboarding.
  if (next === "modal") {
    if (!(await ensureModalCredentials(services))) return;
  } else {
    const configured =
      next === "ollama" || next === "free" || Boolean(envValue(next)) || Boolean((await getProviderSecret(next)).value);
    if (!configured) {
      services.overlay.close();
      const key = await services.overlay.openSecret({
        title: `${next} API key`,
        prompt: `No API key is configured for ${next}. Enter it now to activate this provider.`,
      });
      const value = key?.trim();
      if (!value) {
        services.session.notice("info", `cancelled · provider unchanged`);
        return;
      }
      // Silence here used to look like the picker had simply ignored the input.
      if (!getProvider(next).validateKey(value)) {
        services.session.notice(
          "warn",
          `invalid API key format for ${next} · provider unchanged`,
        );
        return;
      }
      await setProviderSecret(next, value);
    }
  }
  let model = getProviderModel(next);
  const isFreeModel = model.startsWith("free-1/") || model.startsWith("free-2/");
  if (isFreeModel && next !== "free") {
    model = defaultModels[next];
  }
  services.session.setProvider(next);
  services.session.setModel(model);
  await persistSessionModel(services, next, model);
  services.overlay.close();
  services.session.notice("info", `provider → ${next} · model → ${model}`);
  const fetchingToastId = services.toast.info(`fetching ${next} models…`, {
    key: "model-fetch",
    sticky: true,
  });
  const { models, source, error } = await resolveModelsForProvider(next, model);
  services.toast.dismiss(fetchingToastId);
  if (error) {
    services.session.notice(
      "warn",
      `could not refresh ${next} models: ${error} · showing known models`,
    );
  } else if (source === "known" && getProvider(next).listModels) {
    services.session.notice(
      "warn",
      `${next} model list empty from API · showing known models`,
    );
  } else if (source === "live") {
    services.session.notice("info", `${next} · ${models.length} models (live)`);
  }
  if (models.length === 0) {
    services.session.notice(
      "info",
      `no models for ${next} — type /model <name> to set one manually`,
    );
    return;
  }
  services.overlay.openPicker(
    {
      title: `Models · ${next}${source === "live" ? " · live" : ""}`,
      options: models.map((value) => ({
        value,
        label: value,
        active: value === model,
      })),
    },
    (value) => {
      applyModel(services, next, value, models);
      services.overlay.close();
    },
  );
}

/**
 * Modal is the only provider that needs two things before it can serve a
 * request: the workspace endpoint URL (config) and a proxy token pair
 * (secret). Ask for whichever is missing, endpoint first — that is the value
 * people reach for, and a URL typed into a token prompt used to fail
 * `validateKey` and silently abandon the switch.
 *
 * Returns false when the user cancelled or entered something unusable, in
 * which case the active provider is left alone.
 */
async function ensureModalCredentials(services: AppServices): Promise<boolean> {
  const hasToken =
    Boolean(envValue("modal")) || Boolean((await getProviderSecret("modal")).value);

  if (!getActiveProviderEndpoint("modal")) {
    services.overlay.close();
    const answer = await services.overlay.openSecret({
      title: hasToken ? "Modal endpoint URL" : "Modal endpoint URL (1 of 2)",
      prompt:
        "Paste your Modal endpoint URL, e.g. https://<workspace>--ep-<endpoint>.<region>.modal.direct",
      reveal: true,
    });
    const url = answer?.trim();
    if (!url) {
      services.session.notice("info", "cancelled · provider unchanged");
      return false;
    }
    const endpoint = normalizeEndpointUrl(url);
    appendProviderEndpoint("modal", endpoint);
    services.session.notice("info", `modal endpoint → ${endpoint}`);
  }

  if (!hasToken) {
    services.overlay.close();
    const answer = await services.overlay.openSecret({
      title: "Modal proxy token (2 of 2)",
      prompt:
        "Enter the proxy token pair as <token-id>:<token-secret> — create one with: modal workspace proxy-tokens create",
    });
    const token = answer?.trim();
    if (!token) {
      services.session.notice("info", "cancelled · provider unchanged");
      return false;
    }
    // Another URL means the user is still answering the previous question.
    if (/^https?:\/\//i.test(token)) {
      const endpoint = normalizeEndpointUrl(token);
      appendProviderEndpoint("modal", endpoint);
      services.session.notice(
        "warn",
        `saved that as the endpoint (${endpoint}) · modal still needs a wk-…:ws-… token pair — run /provider modal again`,
      );
      return false;
    }
    if (!getProvider("modal").validateKey(token)) {
      services.session.notice(
        "warn",
        "expected a proxy token pair like wk-tokenId:ws-tokenSecret · provider unchanged",
      );
      return false;
    }
    await setProviderSecret("modal", token);
  }

  return true;
}
