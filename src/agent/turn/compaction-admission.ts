import type { ChatMessage, ProviderId, ToolDefinition } from "../../types.js";
import type { resolveToolDialect } from "../../llm/capabilities.js";
import { compactionAttemptKey } from "../compaction-attempt.js";
import { toolSchemaHash } from "../context-breakdown.js";
import {
  autoCompactTriggerTokens,
  getReliabilityPolicy,
} from "../reliability-policy.js";
import { requestTokenCalibration } from "../../llm/token-estimate-calibration.js";

export type CompactionMeasurement = "provider-reported" | "estimated";

export interface CompactionAdmissionPorts {
  readonly messages: readonly ChatMessage[];
  readonly provider: ProviderId;
  readonly model: string;
  readonly dialect: ReturnType<typeof resolveToolDialect>;
  readonly keepRecent: number;
  readonly contextLimitTokens: number | undefined;
  readonly estimateRequestTokens: (messages: readonly ChatMessage[]) => number;
  readonly selectTools: () => readonly ToolDefinition[] | undefined;
  readonly buildDurableEnvelope: () => Promise<string | undefined>;
  readonly isSuppressed: (attemptKey: string) => boolean;
  readonly isExhausted?: ((attemptKey: string) => boolean) | undefined;
  readonly providerPromptTokens?: (() => number | undefined) | undefined;
  readonly audit?: CompactionAuditFn | undefined;
}

export type CompactionAuditFn = (
  event: string,
  payload: Readonly<Record<string, string | number | boolean | undefined>>,
) => void;

export type CompactionAdmission =
  | { readonly admitted: false; readonly skippedByProviderTruth?: boolean }
  | {
      readonly admitted: true;
      readonly beforeTokens: number;
      readonly measurement: CompactionMeasurement;
      readonly compactTrigger: number;
      readonly durableEnvelope: string | undefined;
      readonly attemptKey: string;
    };

const REJECTED: CompactionAdmission = { admitted: false };

export interface CompactionAdmissionOptions {
  readonly bypassThreshold?: boolean | undefined;
  readonly retrySuppressed?: boolean | undefined;
}

export const planCompactionAdmission = async (
  ports: CompactionAdmissionPorts,
  options: CompactionAdmissionOptions = {},
): Promise<CompactionAdmission> => {
  const bypassThreshold = options.bypassThreshold === true;
  const retrySuppressed = options.retrySuppressed === true;
  const providerPromptTokens = ports.providerPromptTokens?.();
  const measurement: CompactionMeasurement =
    providerPromptTokens === undefined ? "estimated" : "provider-reported";
  const estimatedTokens = ports.estimateRequestTokens(ports.messages);
  const compactTrigger = autoCompactTriggerTokens(getReliabilityPolicy(), {
    provider: ports.provider,
    model: ports.model,
    ...(ports.contextLimitTokens !== undefined
      ? { contextLimitTokens: ports.contextLimitTokens }
      : {}),
  });
  if (!bypassThreshold && estimatedTokens < compactTrigger) return REJECTED;
  if (
    !bypassThreshold &&
    providerPromptTokens !== undefined &&
    providerPromptTokens < compactTrigger
  ) {
    ports.audit?.("agent.compact.skip-provider-truth", {
      estimatedTokens,
      providerPromptTokens,
      triggerTokens: compactTrigger,
    });
    return { admitted: false, skippedByProviderTruth: true };
  }
  const beforeTokens = providerPromptTokens ?? estimatedTokens;
  const calibration = requestTokenCalibration(ports.provider, ports.model);
  ports.audit?.("agent.compact.admission", {
    reason: bypassThreshold ? "forced" : "threshold",
    estimatedTokens,
    tokenMeasurement: measurement,
    triggerTokens: compactTrigger,
    ...(providerPromptTokens !== undefined ? { providerPromptTokens } : {}),
    ...(calibration
      ? { calibrationRatio: calibration.ratio, calibrationSamples: calibration.samples }
      : {}),
  });
  if (ports.messages.length <= 2) return REJECTED;
  const durableEnvelope = await ports.buildDurableEnvelope();
  const attemptKey = compactionAttemptKey({
    messages: ports.messages,
    provider: ports.provider,
    model: ports.model,
    dialect: ports.dialect,
    triggerTokens: compactTrigger,
    schemaHash: toolSchemaHash(ports.selectTools()),
    ...(durableEnvelope ? { durableEnvelope } : {}),
  });
  if (!retrySuppressed && ports.isSuppressed(attemptKey)) return REJECTED;
  if (retrySuppressed && ports.isExhausted?.(attemptKey)) return REJECTED;
  return {
    admitted: true,
    beforeTokens,
    measurement,
    compactTrigger,
    durableEnvelope,
    attemptKey,
  };
};
