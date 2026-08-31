/**
 * Picker-backed slash commands: model/provider/search/reasoning/history/
 * permissions/output/plan (V2-072, V2-080).
 */

import { getProvider } from "../../llm/router.js";
import {
  effectiveThinkingEffort,
  clearReasoningRejection,
  displayReasoningEfforts,
  modelReasoningEvidence,
  routeReasoningIsMandatory,
  modelReasoningIsMandatory,
  modelSupportsThinking,
} from "../../llm/capabilities.js";
import { assertSearchProvider } from "../../tools/web/providers/provider.js";
import { searchProviders } from "../../tools/web/providers/provider.js";
import {
  asExaSearchType,
  exaSearchTypeDescriptions,
  exaSearchTypes,
  searchProviderIds,
  type ExaSearchType,
  type SearchProviderId,
} from "../../tools/web/types.js";
import { type ProviderId, type ReasoningEffort } from "../../types.js";
import { getKnownModels } from "../../app/commands/catalog.js";
import { getConfig, getExaSearchType, getProviderModel, setActiveSearchProvider, setExaSearchType, setThinking, updateConfig } from "../../store/config.js";
import { getSearchProviderKey, setSecret } from "../../store/keys.js";
import type { CommandInvocation } from "../../app/commands/command.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import type { PickerOption } from "../rendering/picker-filter.js";
import { openToolOutputPager } from "../rendering/open-tool-output.js";
import { applyModel, resolveModelsForProvider } from "./pickers/provider.js";
export { handleModels } from "./pickers/models.js";
export { handleProvider } from "./pickers/provider.js";
export { resolveModelsForProvider };
export { handleHistory } from "./pickers/history.js";

const REASONING_DESCRIPTIONS: Record<string, string> = {
  off: "disable reasoning",
  minimal: "lowest latency",
  low: "light reasoning",
  medium: "balanced",
  high: "deep reasoning",
  xhigh: "maximum depth",
  max: "highest supported depth (falls back if rejected)",
};

export async function handleModel(
  services: AppServices,
  invocation: CommandInvocation,
): Promise<void> {
  const state = services.session.getState();
  const provider = state.provider ?? getConfig().defaultProvider;
  const arg = invocation.args.trim();
  if (arg && arg !== "list" && arg !== "ls") {
    applyModel(services, provider, arg, getKnownModels(provider));
    return;
  }

  const currentModel = state.model ?? getProviderModel(provider);
  const fetchingToastId = services.toast.info(`fetching ${provider} models…`, {
    key: "model-fetch",
    sticky: true,
  });
  const { models, source, error } = await resolveModelsForProvider(provider, currentModel);
  services.toast.dismiss(fetchingToastId);
  if (error) {
    services.session.notice(
      "warn",
      `could not refresh ${provider} models: ${error} · showing known models`,
    );
  } else if (source === "known" && getProvider(provider).listModels) {
    services.session.notice(
      "warn",
      `${provider} model list empty from API · showing known models`,
    );
  } else if (source === "live") {
    services.session.notice("info", `${provider} · ${models.length} models (live)`);
  }

  if (models.length === 0) {
    services.session.notice(
      "info",
      `no models for ${provider} — type /model <name> to set one manually`,
    );
    return;
  }

  services.overlay.openPicker(
    {
      title: `Models · ${provider}${source === "live" ? " · live" : ""}`,
      options: models.map((value) => ({
        value,
        label: value,
        active: value === currentModel,
      })),
    },
    (value) => {
      applyModel(services, provider, value, models);
      services.overlay.close();
    },
  );
}

export function handleSearch(services: AppServices, invocation: CommandInvocation): void {
  const args = invocation.args.trim();
  if (args) {
    const parts = args.split(/\s+/);
    const providerArg = parts[0]!;
    // `/search exa <type>` sets Exa's retrieval strategy directly.
    if (providerArg.toLowerCase() === "exa" && parts.length > 1) {
      const type = asExaSearchType(parts.slice(1).join(" "));
      if (!type) {
        services.session.notice(
          "warn",
          `unknown exa search type: ${parts.slice(1).join(" ")} · options: ${exaSearchTypes.join(", ")}`,
        );
        return;
      }
      void activateExaWithType(services, type);
      return;
    }
    try {
      void activateSearchProvider(services, assertSearchProvider(providerArg));
    } catch {
      services.session.notice("warn", `unknown search provider: ${providerArg}`);
    }
    return;
  }
  const active = getConfig().activeSearchProvider;
  const exaType = getExaSearchType();
  const options: PickerOption[] = searchProviderIds.map((id) => {
    const adapter = searchProviders[id];
    const keyNote = adapter?.needsApiKey
      ? `${adapter.displayName} · API key required`
      : `${adapter?.displayName ?? id} · keyless`;
    return {
      value: id,
      label: id === active ? `${id} · active` : id,
      description: id === "exa" ? `${keyNote} · type: ${exaType}` : keyNote,
    };
  });
  services.overlay.openPicker({ title: "Search providers", options }, (value) => {
    void activateSearchProvider(services, assertSearchProvider(value));
  });
}

async function activateSearchProvider(services: AppServices, next: SearchProviderId): Promise<void> {
  const adapter = searchProviders[next];
  if (adapter?.needsApiKey) {
    const current = await getSearchProviderKey(next);
    if (!current.value) {
      services.overlay.close();
      const key = await services.overlay.openSecret({
        title: `${next} search API key`,
        prompt: `No API key is configured for ${adapter.displayName}. Enter it now to use this search provider.`,
      });
      if (!key) return;
      await setSecret("search", next, key);
    }
  }
  setActiveSearchProvider(next);
  services.overlay.close();
  services.session.notice("info", `search provider → ${next}`);
  // Exa is the only provider with a tunable retrieval strategy — offer the
  // type picker right after activation so users land on the right latency
  // and depth without a second command.
  if (next === "exa") openExaSearchTypePicker(services);
}

/** Open the picker that customises Exa's retrieval strategy (`type`). */
function openExaSearchTypePicker(services: AppServices): void {
  const current = getExaSearchType();
  const options: PickerOption[] = exaSearchTypes.map((type) => ({
    value: type,
    label: type === current ? `${type} · active` : type,
    description: exaSearchTypeDescriptions[type],
    active: type === current,
  }));
  services.overlay.openPicker({ title: "Exa search type", options }, (value) => {
    const type = asExaSearchType(value);
    if (type) applyExaSearchType(services, type);
    services.overlay.close();
  });
}

/**
 * Persist the chosen Exa search type. When Exa is not already the active
 * search provider, selecting a type also activates Exa so the setting takes
 * effect on the next search.
 */
async function activateExaWithType(
  services: AppServices,
  type: ExaSearchType,
): Promise<void> {
  if (getConfig().activeSearchProvider !== "exa") {
    await activateSearchProvider(services, "exa");
  }
  applyExaSearchType(services, type);
}

function applyExaSearchType(services: AppServices, type: ExaSearchType): void {
  setExaSearchType(type);
  services.session.notice("info", `exa search type → ${type}`);
}

export function handleReasoning(services: AppServices, invocation: CommandInvocation): void {
  if (invocation.args) {
    applyReasoning(services, invocation.args.trim());
    return;
  }
  const current = getConfig().thinking;
  const provider = services.session.getState().provider ?? getConfig().defaultProvider;
  const model = services.session.getState().model ?? "";
  const options: PickerOption[] = reasoningOptionValues(provider, model).map((value) => ({
    value,
    label: value,
    description: REASONING_DESCRIPTIONS[value] ?? "",
    active: value === (effectiveThinkingEffort(provider, model, current) ?? "off"),
  }));
  services.overlay.openPicker(
    { title: reasoningPickerTitle(provider, model), options },
    (value) => {
      applyReasoning(services, value);
      services.overlay.close();
    },
  );
}

function reasoningOptionValues(
  provider: ProviderId,
  model: string,
): readonly string[] {
  const scale = Object.keys(REASONING_DESCRIPTIONS).filter((value) => value !== "off");
  const evidence = modelReasoningEvidence(provider, model);
  if (
    !modelSupportsThinking(provider, model) &&
    evidence !== "unknown" &&
    evidence !== "rejected"
  ) {
    return ["off"];
  }
  const accepted = displayReasoningEfforts(provider, model) ?? [];
  const efforts =
    accepted.length > 0 ? scale.filter((value) => accepted.includes(value)) : scale;
  return modelReasoningIsMandatory(model) ||
    routeReasoningIsMandatory(provider, model)
    ? efforts
    : ["off", ...efforts];
}

function reasoningPickerTitle(provider: ProviderId, model: string): string {
  const evidence = modelReasoningEvidence(provider, model);
  const status =
    modelReasoningIsMandatory(model) || routeReasoningIsMandatory(provider, model)
      ? "always on"
      : evidence === "rejected"
        ? "previously rejected — picking a level retries it"
        : modelSupportsThinking(provider, model)
          ? "supported"
          : "model may ignore it";
  return `Reasoning · ${status} · via ${evidence}`;
}

function applyReasoning(services: AppServices, value: string): void {
  const lower = value.toLowerCase();
  if (/^(on|enable|true)$/.test(lower)) {
    clearRouteReasoningRejection(services);
    setThinking({ enabled: true });
    services.session.notice("info", `thinking → ${getConfig().thinking.effort}`);
    return;
  }
  if (["off", "none", "disable", "false"].includes(lower)) {
    setThinking({ enabled: false });
    services.session.notice("info", "thinking → off");
    return;
  }
  if (["minimal", "low", "medium", "high", "xhigh", "max"].includes(lower)) {
    clearRouteReasoningRejection(services);
    setThinking({ enabled: true, effort: lower as ReasoningEffort });
    services.session.notice("info", `thinking → ${lower}`);
    warnUnacceptedEffort(services, lower);
    return;
  }
  services.session.notice("warn", "usage: /effort [on|off|minimal|low|medium|high|xhigh|max]");
}

function clearRouteReasoningRejection(services: AppServices): void {
  const provider = services.session.getState().provider ?? getConfig().defaultProvider;
  const model = services.session.getState().model ?? "";
  if (!model) return;
  clearReasoningRejection(provider, model);
}

function warnUnacceptedEffort(services: AppServices, effort: string): void {
  const provider = services.session.getState().provider ?? getConfig().defaultProvider;
  const model = services.session.getState().model ?? "";
  if (!model) return;
  const accepted = displayReasoningEfforts(provider, model) ?? [];
  if (accepted.length === 0 || accepted.includes(effort)) return;
  services.session.notice(
    "warn",
    `${provider}/${model} advertises ${accepted.join(", ")} — ${effort} will be mapped to the nearest of those`,
  );
}

export function handlePermissions(services: AppServices, invocation: CommandInvocation): void {
  const apply = (value: "default" | "allow-all") => {
    updateConfig({ permissions: value });
    services.session.notice("info", `permissions → ${value}`);
  };
  if (invocation.args) {
    const value = invocation.args.trim().toLowerCase();
    if (value === "default" || value === "allow-all") apply(value);
    return;
  }
  const current = getConfig().permissions ?? "default";
  services.overlay.openPicker(
    {
      title: "Permissions",
      options: [
        {
          value: "default",
          label: "default",
          description: "confirm risky tool calls",
          active: current === "default",
        },
        {
          value: "allow-all",
          label: "allow-all",
          description: "skip confirmation prompts",
          active: current === "allow-all",
        },
      ],
    },
    (value) => {
      apply(value as "default" | "allow-all");
      services.overlay.close();
    },
  );
}

export async function handleOutput(
  services: AppServices,
  invocation: CommandInvocation,
): Promise<void> {
  const state = services.transcript.getState();
  const toolItems = [...state.byId.values()].filter((item) => item.kind === "tool");
  if (toolItems.length === 0) {
    services.session.notice("info", "no tool output yet");
    return;
  }

  const arg = invocation.args.trim().toLowerCase();
  if (!arg) {
    services.transcript.toggleOutputGlobal();
    const on = services.transcript.getState().expandOutputGlobal;
    services.toast.show(
      on ? "Tool output expanded · ^O" : "Tool output collapsed · ^O",
      { key: "output", durationMs: 1500 },
    );
    return;
  }
  if (arg === "list" || arg === "ls") {
    services.overlay.openPicker(
      {
        title: "Tool output",
        options: toolItems.map((item) => ({
          value: item.id,
          label: item.name,
          description: item.argsDisplay,
        })),
      },
      (value) => {
        services.overlay.close();
        const item = toolItems.find((t) => t.id === value);
        if (item) void openToolOutputPager(services, item);
      },
    );
    return;
  }
  const target =
    arg !== "last"
      ? toolItems.find((t) => t.toolCallId === arg || t.id === arg)
      : toolItems.at(-1);
  if (target) await openToolOutputPager(services, target);
  else services.session.notice("info", arg ? `no tool output: ${arg}` : "no tool output yet");
}

export function handlePlanPager(services: AppServices): void {
  void (async () => {
    let plan = services.plan.current();
    if (!plan) {
      plan = await services.plan
        .load(services.session.sessionId)
        .catch(() => undefined);
    }
    if (!plan) {
      services.session.notice("info", "no active plan yet");
      return;
    }
    const { formatPlanPagerDocument } = await import(
      "../rendering/plan-view.js"
    );
    services.overlay.openPager(
      `Plan · ${plan.goal}`,
      formatPlanPagerDocument(plan),
      undefined,
      undefined,
      "force",
    );
  })();
}
