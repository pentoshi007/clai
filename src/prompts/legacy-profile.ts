import { createHash } from "node:crypto";
import type { ToolDefinition } from "../types.js";
import { getToolDefinitions } from "../tools/definitions.js";
import { renderAgentSystemPrompt, renderCompactAgentSystemPrompt, _AGENT_TEMPLATE, _ASK_TEMPLATE } from "./index.js";
import type { RoutePromptBinding } from "./profile-state.js";

export const profileDigest = (value: string): string => createHash("sha256").update(value).digest("hex");

export interface PromptProfile {
  readonly id: string;
  readonly digest: string;
  readonly render: (binding: RoutePromptBinding) => string;
  readonly tools: (names: readonly string[]) => ToolDefinition[];
  readonly executionRulesInSystem: (compact: boolean) => boolean;
}

function renderLegacy(binding: Pick<RoutePromptBinding, "compact" | "native" | "slimNative" | "imageView" | "toolNames">): string {
  const options = { nativeTools: binding.native, slimNative: binding.slimNative, imageView: binding.imageView, stableEnvironment: true };
  return (binding.compact ? renderCompactAgentSystemPrompt : renderAgentSystemPrompt)(binding.toolNames.join(", "), options);
}

let legacy: PromptProfile | undefined;
export function legacyPromptProfile(): PromptProfile {
  if (legacy) return legacy;
  const definitions = structuredClone(getToolDefinitions());
  const toolNames = definitions.map((definition) => definition.name);
  const prompts = [false, true].flatMap((compact) => [false, true].flatMap((native) => [false, true].flatMap((slimNative) => [false, true].map((imageView) =>
    renderLegacy({ compact, native, slimNative, imageView, toolNames })))));
  legacy = Object.freeze({ id: "legacy-v1", digest: profileDigest(JSON.stringify({ format: 1, agent: _AGENT_TEMPLATE, ask: _ASK_TEMPLATE, prompts, definitions })),
    render: renderLegacy,
    tools: (names: readonly string[]) => structuredClone(definitions.filter((definition) => names.includes(definition.name))),
    executionRulesInSystem: (compact: boolean) => !compact,
  });
  return legacy;
}
