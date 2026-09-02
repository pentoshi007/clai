import type { ChatMessage, ProviderId, ToolDefinition } from "../../types.js";
import type { resolveToolDialect } from "../../llm/capabilities.js";
import { compactionAttemptKey } from "../compaction-attempt.js";
import { toolSchemaHash } from "../context-breakdown.js";
import {
  autoCompactTriggerTokens,
  getReliabilityPolicy,
} from "../reliability-policy.js";

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
}

export type CompactionAdmission =
  | { readonly admitted: false }
  | {
      readonly admitted: true;
      readonly beforeTokens: number;
      readonly compactTrigger: number;
      readonly durableEnvelope: string | undefined;
      readonly attemptKey: string;
    };

const REJECTED: CompactionAdmission = { admitted: false };

export const planCompactionAdmission = async (
  ports: CompactionAdmissionPorts,
  force: boolean,
): Promise<CompactionAdmission> => {
  const beforeTokens = ports.estimateRequestTokens(ports.messages);
  const compactTrigger = autoCompactTriggerTokens(getReliabilityPolicy(), {
    provider: ports.provider,
    model: ports.model,
    ...(ports.contextLimitTokens !== undefined
      ? { contextLimitTokens: ports.contextLimitTokens }
      : {}),
  });
  if (!force && beforeTokens < compactTrigger) return REJECTED;
  if (ports.messages.length <= ports.keepRecent + 2) return REJECTED;
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
  if (!force && ports.isSuppressed(attemptKey)) return REJECTED;
  if (force && ports.isExhausted?.(attemptKey)) return REJECTED;
  return {
    admitted: true,
    beforeTokens,
    compactTrigger,
    durableEnvelope,
    attemptKey,
  };
};
