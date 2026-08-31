import type { CommandInvocation } from "../../../app/commands/command.js";
import { clearReasoningRejection, displayReasoningEfforts, effectiveThinkingEffort, modelReasoningEvidence, modelReasoningIsMandatory, modelSupportsThinking, routeReasoningIsMandatory } from "../../../llm/capabilities.js";
import { getConfig, getExaSearchType, setActiveSearchProvider, setExaSearchType, setThinking } from "../../../store/config.js";
import { getSearchProviderKey, setSecret } from "../../../store/keys.js";
import { assertSearchProvider, searchProviders } from "../../../tools/web/providers/provider.js";
import { asExaSearchType, exaSearchTypeDescriptions, exaSearchTypes, searchProviderIds } from "../../../tools/web/types.js";
import type { ExaSearchType, SearchProviderId } from "../../../tools/web/types.js";
import type { ProviderId, ReasoningEffort } from "../../../types.js";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { PickerOption } from "../../rendering/picker-filter.js";

const REASONING_DESCRIPTIONS: Record<string, string> = {
  off: "disable reasoning",
  minimal: "lowest latency",
  low: "light reasoning",
  medium: "balanced",
  high: "deep reasoning",
  xhigh: "maximum depth",
  max: "highest supported depth (falls back if rejected)",
};

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
