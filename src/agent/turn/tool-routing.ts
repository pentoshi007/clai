import type { Mode, ProviderId, ToolDefinition } from "../../types.js";
import type { ToolCallingMode } from "../../llm/tool-protocol.js";
import { modelSupportsVision, resolveToolDialect } from "../../llm/capabilities.js";
import { availableToolNames } from "../../tools/registry.js";
import {
  getToolDefinitions,
  mcpAgentToolNames,
  RUNNER_META_TOOL_NAMES,
} from "../../tools/definitions.js";
import {
  renderAgentSystemPrompt,
  renderCompactAgentSystemPrompt,
} from "../../prompts/index.js";
import { getReliabilityPolicy } from "../reliability-policy.js";

export interface ToolRoutingInput {
  readonly mode: Mode;
  readonly mcpPresent: boolean;
  readonly toolCalling: ToolCallingMode | undefined;
  readonly useCompactSystemPrompt: () => boolean;
  readonly compactPromptModes?: Map<string, boolean>;
}

export interface ToolRouting {
  readonly routeToolNames: (provider: ProviderId, model: string) => string[];
  readonly resolveNativeTools: (
    provider: ProviderId,
    model: string,
  ) => { dialect: ReturnType<typeof resolveToolDialect>; native: boolean };
  readonly selectToolDefs: (
    native: boolean,
    compact: boolean,
    provider: ProviderId,
    model: string,
  ) => ToolDefinition[] | undefined;
  readonly buildStableSystemContent: (
    native: boolean,
    provider: ProviderId,
    model: string,
  ) => string;
}

const nameAllowed = (
  name: string,
  provider: ProviderId,
  model: string,
): boolean => {
  if (name === "image.view") return modelSupportsVision(provider, model);
  return true;
};

export const createToolRouting = (input: ToolRoutingInput): ToolRouting => {
  const compactPromptModes = input.compactPromptModes ?? new Map<string, boolean>();
  const routeToolNames = (provider: ProviderId, model: string): string[] =>
    [
      ...availableToolNames(),
      ...RUNNER_META_TOOL_NAMES,
      ...(input.mcpPresent ? mcpAgentToolNames(input.mode === "ask") : []),
    ].filter((name) => nameAllowed(name, provider, model));

  const resolveNativeTools = (
    provider: ProviderId,
    model: string,
  ): { dialect: ReturnType<typeof resolveToolDialect>; native: boolean } => {
    const dialect = resolveToolDialect(provider, model, input.toolCalling);
    return { dialect, native: dialect !== "none" };
  };

  const selectToolDefs = (
    native: boolean,
    _compact: boolean,
    provider: ProviderId,
    model: string,
  ): ToolDefinition[] | undefined => {
    if (!native) return undefined;
    const base = getToolDefinitions();
    const allow = new Set([
      ...routeToolNames(provider, model),
      ...RUNNER_META_TOOL_NAMES,
    ]);
    return base.filter((definition) => allow.has(definition.name));
  };

  const buildStableSystemContent = (
    native: boolean,
    provider: ProviderId,
    model: string,
  ): string => {
    const reliability = getReliabilityPolicy();
    const route = JSON.stringify([provider, model]);
    const compact = compactPromptModes.get(route) ?? input.useCompactSystemPrompt();
    compactPromptModes.set(route, compact);
    const render = compact
      ? renderCompactAgentSystemPrompt
      : renderAgentSystemPrompt;
    return render(routeToolNames(provider, model).join(", "), {
      nativeTools: native,
      stableEnvironment: true,
      imageView: modelSupportsVision(provider, model),
      ...(native ? { slimNative: reliability.slimNativePrompt } : {}),
    });
  };

  return {
    routeToolNames,
    resolveNativeTools,
    selectToolDefs,
    buildStableSystemContent,
  };
};
