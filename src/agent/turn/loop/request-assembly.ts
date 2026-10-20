import type {
  ChatMessage,
  ProviderId,
  ReasoningPreference,
  ToolDefinition,
} from "../../../types.js";
import type { resolveToolDialect } from "../../../llm/capabilities.js";
import { routeOutputTokenLimit } from "../../../llm/provider-profiles.js";
import {
  buildContextBreakdown,
  contextBreakdownAuditPayload,
} from "../../context-breakdown.js";
import {
  freeTierGuardNotices,
  resolveStepMaxTokens,
} from "../../reliability-policy.js";
import { autoCompactTriggerTokens } from "../../request-budget.js";
import {
  assertValidToolProtocol,
  repairToolProtocol,
} from "../../tool-history.js";
import {
  accountAssembledRequest,
  RequestOverLimitError,
  resolveEffectiveContextLimit,
} from "../../request-accounting.js";

export interface RequestAssemblyState {
  freeTierConsecutiveFailures: number;
  truncatedBudgetRounds: number;
  continuationBudgetFloor: number;
}

export interface RequestAssemblyPorts {
  readonly messages: ChatMessage[];
  readonly provider: ProviderId;
  readonly model: string;
  readonly dialect: ReturnType<typeof resolveToolDialect>;
  readonly nativeToolsActive: boolean;
  readonly thinking: ReasoningPreference | undefined;
  readonly step: number;
  readonly contextLimitTokens: number | undefined;
  readonly measureRequestTokens?: ((estimatedTokens: number) => number | undefined) | undefined;
  readonly estimateRequestTokens: (messages: readonly ChatMessage[]) => number;
  readonly selectTools: () => ToolDefinition[] | undefined;
  readonly notify: (level: "info" | "warn", message: string) => void;
  readonly audit: (
    event: string,
    payload: Readonly<Record<string, string | number | boolean | undefined>>,
  ) => Promise<void>;
}

export interface AssembledRequest {
  readonly tools: ToolDefinition[] | undefined;
  readonly toolsAttached: boolean;
  readonly estimatedInputTokens: number;
  readonly stepMaxTokens: number;
  readonly rawRequestTokens: number;
}

const showFreeTierAdvisories = (
  ports: RequestAssemblyPorts,
  state: RequestAssemblyState,
): void => {
  for (const notice of freeTierGuardNotices({
    provider: ports.provider,
    consecutiveFailures: state.freeTierConsecutiveFailures,
  })) {
    ports.notify("info", notice);
  }
};

const overLimitMessage = (
  requestTokens: number,
  safeTokens: number,
): string =>
  `request (~${requestTokens.toLocaleString()} tokens) exceeds the model's safe context window (~${safeTokens.toLocaleString()} tokens) — run /compact, trim large outputs, or raise the session context limit`;

export const assembleRequest = async (
  ports: RequestAssemblyPorts,
  state: RequestAssemblyState,
): Promise<AssembledRequest> => {
  const tools = ports.selectTools();
  const toolsAttached = Boolean(tools?.length);
  const contextBreakdown = buildContextBreakdown(
    ports.messages,
    toolsAttached ? tools : undefined,
  );
  const estimatedInputTokens = ports.estimateRequestTokens(ports.messages);
  showFreeTierAdvisories(ports, state);

  const routeOutputLimit = routeOutputTokenLimit(ports.provider, ports.model);
  const stepBudgetInput = {
    nativeToolsActive: ports.nativeToolsActive,
    toolsAttached,
    truncationDepth: state.truncatedBudgetRounds,
    thinkingEnabled: Boolean(ports.thinking?.enabled),
    minimumTokens: state.continuationBudgetFloor,
  };
  const preferredStepMaxTokens = resolveStepMaxTokens({
    ...stepBudgetInput,
    outputTokenLimit: routeOutputLimit,
  });
  const unknownLimitStepMaxTokens = resolveStepMaxTokens(stepBudgetInput);
  const contextLimit = resolveEffectiveContextLimit({
    provider: ports.provider,
    model: ports.model,
    contextLimitTokens: ports.contextLimitTokens,
  });
  const fallbackStepMaxTokens = Math.min(
    unknownLimitStepMaxTokens,
    routeOutputLimit ?? unknownLimitStepMaxTokens,
  );
  const minimumStepMaxTokens =
    contextLimit.limitTokens !== undefined &&
    fallbackStepMaxTokens +
      contextLimit.safetyMarginTokens +
      contextLimit.reservedOutputTokens >=
      contextLimit.limitTokens
      ? Math.max(
          1,
          Math.min(fallbackStepMaxTokens, contextLimit.reservedOutputTokens),
        )
      : fallbackStepMaxTokens;

  repairToolProtocol(ports.messages);
  assertValidToolProtocol(ports.messages);

  const finalAccounting = accountAssembledRequest({
    provider: ports.provider,
    model: ports.model,
    messages: ports.messages,
    stream: true,
    reservedOutputTokens: minimumStepMaxTokens,
    reasoning: ports.thinking,
    ...(toolsAttached && tools?.length
      ? { tools, toolChoice: "auto" as const, parallelToolCalls: true }
      : {}),
    ...(ports.contextLimitTokens !== undefined
      ? { contextLimitTokens: ports.contextLimitTokens }
      : {}),
  }).accounting;
  const measuredTokens = ports.measureRequestTokens?.(estimatedInputTokens);
  const requestTokens = measuredTokens ?? finalAccounting.requestTokens;
  const freeOutputTokens =
    contextLimit.limitTokens === undefined
      ? preferredStepMaxTokens
      : contextLimit.limitTokens - requestTokens - contextLimit.safetyMarginTokens;
  const stepMaxTokens =
    preferredStepMaxTokens > fallbackStepMaxTokens
      ? Math.max(
          minimumStepMaxTokens,
          Math.min(preferredStepMaxTokens, freeOutputTokens),
        )
      : minimumStepMaxTokens;

  await ports.audit("agent.turn", {
    provider: ports.provider,
    model: ports.model,
    tool_protocol: toolsAttached ? "native" : "text",
    dialect: ports.dialect,
    step: ports.step,
    ...contextBreakdownAuditPayload(contextBreakdown),
    compactTriggerTokens: autoCompactTriggerTokens({
      provider: ports.provider,
      model: ports.model,
      ...(ports.contextLimitTokens !== undefined
        ? { contextLimitTokens: ports.contextLimitTokens }
        : {}),
    }),
    maxTokensBudget: stepMaxTokens,
    ...(routeOutputLimit !== undefined
      ? { outputTokenLimit: routeOutputLimit }
      : {}),
  });

  const effectiveSafeTokens = finalAccounting.limit.effectiveSafeTokens;
  if (effectiveSafeTokens !== undefined && requestTokens > effectiveSafeTokens) {
    await ports.audit("agent.request.over-limit-blocked", {
      provider: ports.provider,
      model: ports.model,
      requestTokens,
      tokenMeasurement: measuredTokens === undefined ? "estimated" : "provider-reported",
      estimatedTokens: finalAccounting.requestTokens,
      effectiveSafeTokens,
      limitSource: finalAccounting.limit.source,
      reservedOutputTokens: finalAccounting.limit.reservedOutputTokens,
      safetyMarginTokens: finalAccounting.limit.safetyMarginTokens,
    });
    ports.notify("warn", overLimitMessage(requestTokens, effectiveSafeTokens));
    throw new RequestOverLimitError(
      `request (~${requestTokens.toLocaleString()} tokens) exceeds the effective safe context limit (~${effectiveSafeTokens.toLocaleString()} tokens); dispatch blocked`,
    );
  }

  return {
    tools,
    toolsAttached,
    estimatedInputTokens,
    stepMaxTokens,
    rawRequestTokens: finalAccounting.rawRequestTokens,
  };
};
