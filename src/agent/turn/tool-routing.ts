import type { Mode, ProviderId, ToolDefinition } from "../../types.js";
import type { ToolCallingMode } from "../../llm/tool-protocol.js";
import { modelSupportsVision, resolveToolDialect } from "../../llm/capabilities.js";
import { availableToolNames } from "../../tools/registry.js";
import {
  getCompactToolDefinitions,
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
  readonly mcpToolNames: readonly string[];
  readonly mcpToolDefinitions: readonly ToolDefinition[];
  readonly imageOcrEnabled: boolean;
  readonly skillsAvailable: boolean;
  readonly toolCalling: ToolCallingMode | undefined;
  readonly useCompactSystemPrompt: () => boolean;
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
  input: ToolRoutingInput,
  name: string,
  provider: ProviderId,
  model: string,
): boolean => {
  if (name === "image.ocr") return input.imageOcrEnabled;
  if (name === "image.view") return modelSupportsVision(provider, model);
  if (name === "skill.load" || name === "skill.list") {
    return input.skillsAvailable;
  }
  return true;
};

export const createToolRouting = (input: ToolRoutingInput): ToolRouting => {
  const routeToolNames = (provider: ProviderId, model: string): string[] =>
    [
      ...availableToolNames(),
      ...input.mcpToolNames,
      ...(input.mcpPresent ? mcpAgentToolNames(input.mode === "ask") : []),
    ].filter((name) => nameAllowed(input, name, provider, model));

  const resolveNativeTools = (
    provider: ProviderId,
    model: string,
  ): { dialect: ReturnType<typeof resolveToolDialect>; native: boolean } => {
    const dialect = resolveToolDialect(provider, model, input.toolCalling);
    return { dialect, native: dialect !== "none" };
  };

  const selectToolDefs = (
    native: boolean,
    compact: boolean,
    provider: ProviderId,
    model: string,
  ): ToolDefinition[] | undefined => {
    if (!native) return undefined;
    const base = [
      ...(compact ? getCompactToolDefinitions() : getToolDefinitions()),
      ...input.mcpToolDefinitions,
    ];
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
    const render = input.useCompactSystemPrompt()
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
