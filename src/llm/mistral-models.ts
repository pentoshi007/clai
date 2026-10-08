import type { CatalogReasoningFacts } from "./catalog-facts.js";

export function documentedMistralReasoning(
  model: string,
): CatalogReasoningFacts | undefined {
  if (/^zai-glm-5-3(?:-|$)/i.test(model)) {
    return {
      supported: true,
      mandatory: true,
      supportedEfforts: ["low", "high", "max"],
      defaultEffort: "high",
    };
  }
  if (/^magistral-(?:small|medium)(?:-|$)/i.test(model)) {
    return { supported: true, mandatory: true };
  }
  if (
    /^mistral-(?:small-(?:latest|2603|4(?:-0)?)|medium-(?:latest|3-5|2604)|large-(?:latest|4-0|2610))(?:-|$)/i.test(
      model,
    )
  ) {
    return {
      supported: true,
      mandatory: false,
      supportedEfforts: ["none", "high"],
      defaultEffort: "high",
    };
  }
  return undefined;
}
