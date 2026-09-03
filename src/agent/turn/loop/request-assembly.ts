import type {
  ChatMessage,
  ProviderId,
  ReasoningPreference,
  ToolDefinition,
} from "../../../types.js";
import type { resolveToolDialect } from "../../../llm/capabilities.js";
import { resolveBuiltInProfile } from "../../../llm/provider-profiles.js";
import {
  buildContextBreakdown,
  contextBreakdownAuditPayload,
} from "../../context-breakdown.js";
import {
  autoCompactTriggerTokens,
  freeTierGuardNotices,
  getReliabilityPolicy,
  resolveStepMaxTokens,
} from "../../reliability-policy.js";
import {
  assertValidToolProtocol,
  repairToolProtocol,
} from "../../tool-history.js";
import {
  accountAssembledRequest,
  RequestOverLimitError,
} from "../../request-accounting.js";

export interface RequestAssemblyState {
  freeTierConsecutiveFailures: number;
  truncatedBudgetRounds: number;
  continuationBudgetFloor: number;
  retryWithoutThinking: boolean;
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
  readonly estimateRequestTokens: (messages: readonly ChatMessage[]) => number;
  readonly selectTools: () => ToolDefinition[] | undefined;
  readonly notify: (level: "info" | "warn", message: string) => void;
  readonly emitContextEstimate: (estimatedTokens: number) => void;
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
  safeTokens: number | undefined,
): string =>
  `estimated request (~${requestTokens.toLocaleString()} tokens) exceeds the model's safe context window (~${safeTokens?.toLocaleString()} tokens) — run /compact, trim large outputs, or raise the session context limit`;

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

  const routeOutputTokenLimit = resolveBuiltInProfile({
    provider: ports.provider,
    model: ports.model,
  }).limits.outputTokens;
  const stepMaxTokens = resolveStepMaxTokens({
    nativeToolsActive: ports.nativeToolsActive,
    toolsAttached,
    recoveryNudge: state.retryWithoutThinking,
    truncationDepth: state.truncatedBudgetRounds,
    thinkingEnabled:
      Boolean(ports.thinking?.enabled) && !state.retryWithoutThinking,
    minimumTokens: state.continuationBudgetFloor,
    ...(routeOutputTokenLimit !== undefined
      ? { outputTokenLimit: routeOutputTokenLimit }
      : {}),
  });

  await ports.audit("agent.turn", {
    provider: ports.provider,
    model: ports.model,
    tool_protocol: toolsAttached ? "native" : "text",
    dialect: ports.dialect,
    step: ports.step,
    ...contextBreakdownAuditPayload(contextBreakdown),
    compactTriggerTokens: autoCompactTriggerTokens(getReliabilityPolicy(), {
      provider: ports.provider,
      model: ports.model,
      ...(ports.contextLimitTokens !== undefined
        ? { contextLimitTokens: ports.contextLimitTokens }
        : {}),
    }),
    maxTokensBudget: stepMaxTokens,
    ...(routeOutputTokenLimit !== undefined
      ? { outputTokenLimit: routeOutputTokenLimit }
      : {}),
  });

  repairToolProtocol(ports.messages);
  assertValidToolProtocol(ports.messages);

  const finalAccounting = accountAssembledRequest({
    provider: ports.provider,
    model: ports.model,
    messages: ports.messages,
    stream: true,
    ...(toolsAttached && tools?.length
      ? { tools, toolChoice: "auto" as const, parallelToolCalls: true }
      : {}),
    ...(ports.contextLimitTokens !== undefined
      ? { contextLimitTokens: ports.contextLimitTokens }
      : {}),
  }).accounting;
  ports.emitContextEstimate(finalAccounting.requestTokens);

  if (finalAccounting.overLimit) {
    await ports.audit("agent.request.over-limit-blocked", {
      provider: ports.provider,
      model: ports.model,
      estimatedTokens: finalAccounting.requestTokens,
      effectiveSafeTokens: finalAccounting.limit.effectiveSafeTokens,
      limitSource: finalAccounting.limit.source,
      reservedOutputTokens: finalAccounting.limit.reservedOutputTokens,
      safetyMarginTokens: finalAccounting.limit.safetyMarginTokens,
    });
    ports.notify(
      "warn",
      overLimitMessage(
        finalAccounting.requestTokens,
        finalAccounting.limit.effectiveSafeTokens,
      ),
    );
    throw new RequestOverLimitError(
      `estimated request (~${finalAccounting.requestTokens.toLocaleString()} tokens) exceeds the effective safe context limit (~${finalAccounting.limit.effectiveSafeTokens?.toLocaleString()} tokens); dispatch blocked`,
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
