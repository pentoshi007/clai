import type { CatalogModel } from "../capabilities.js";
import {
  catalogEffortList,
  catalogEntriesFromPayload,
  parseCatalogFacts,
} from "../catalog-facts.js";
import { documentedMistralReasoning } from "../mistral-models.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function mistralModelCatalog(payload: unknown): CatalogModel[] {
  const models = new Map<string, CatalogModel>();
  for (const entry of catalogEntriesFromPayload(payload)) {
    const raw = record(entry);
    const caps = record(raw?.capabilities);
    const parsed = parseCatalogFacts(entry);
    if (
      !raw ||
      !parsed ||
      caps?.completion_chat !== true ||
      raw.archived === true ||
      raw.internal === true
    )
      continue;
    const documented =
      documentedMistralReasoning(parsed.id) ??
      (typeof raw.root === "string"
        ? documentedMistralReasoning(raw.root)
        : undefined);
    const supportedEfforts = catalogEffortList(
      parsed.reasoning?.supportedEfforts ?? documented?.supportedEfforts,
    );
    const reasoning =
      caps.reasoning === false
        ? { supported: false }
        : {
            ...documented,
            ...parsed.reasoning,
            ...(supportedEfforts?.length &&
            parsed.reasoning?.mandatory === undefined
              ? { mandatory: !supportedEfforts.includes("none") }
              : {}),
            ...(caps.reasoning === true ? { supported: true } : {}),
          };
    const temperature = raw.default_model_temperature;
    const facts = {
      ...parsed,
      canonicalModel: parsed.id,
      reasoning,
      ...(typeof caps.function_calling === "boolean"
        ? { tools: caps.function_calling }
        : {}),
      ...(typeof temperature === "number" && Number.isFinite(temperature)
        ? { defaultSampling: { ...parsed.defaultSampling, temperature } }
        : {}),
    };
    const efforts = catalogEffortList(reasoning.supportedEfforts);
    const ids = [
      parsed.id,
      ...(Array.isArray(raw.aliases)
        ? raw.aliases
            .filter(
              (alias): alias is string =>
                typeof alias === "string" && Boolean(alias.trim()),
            )
            .map((alias) => alias.trim())
        : []),
    ];
    for (const id of ids) {
      if (models.has(id) && id !== parsed.id) continue;
      models.set(id, {
        id,
        facts: { ...facts, id },
        ...(facts.vision !== undefined ? { vision: facts.vision } : {}),
        ...(reasoning.supported !== undefined
          ? { reasoning: reasoning.supported }
          : {}),
        ...(efforts ? { reasoningEfforts: efforts } : {}),
      });
    }
  }
  return [...models.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}
