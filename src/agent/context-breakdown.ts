/**
 * Estimate how a model request's context is composed (system / history / tools).
 * Metadata-only: no prompt text is stored — only role counts and token estimates.
 *
 * Used for reliability ops and regression harnesses. Does not truncate context.
 */

import { createHash } from "node:crypto";
import type { ChatMessage, ToolDefinition } from "../types.js";
import { reasoningArtifactTokensForMessage } from "../llm/reasoning-artifacts.js";
import {
  estimateMessagesTokens,
  estimateTokens,
  isCompactionMemoryMessage,
  COMPACTION_MEMORY_PREFIX,
  PLAN_IMPLEMENT_MEMORY_PREFIX,
  MECHANICAL_MEMORY_PREFIX,
} from "./context-manager.js";
import { SESSION_STATE_PREFIX } from "./session-state.js";

export interface ContextBreakdown {
  /** Rough total estimated tokens for messages (+ tools if provided). */
  readonly estimatedTotalTokens: number;
  readonly systemTokens: number;
  readonly userTokens: number;
  readonly assistantTokens: number;
  readonly toolResultTokens: number;
  readonly toolSchemaTokens: number;
  readonly messageCount: number;
  readonly systemMessageCount: number;
  readonly userMessageCount: number;
  readonly assistantMessageCount: number;
  readonly toolMessageCount: number;
  /** High-level system subsections when detected by prefix. */
  readonly systemParts: {
    readonly constitutionTokens: number;
    readonly planTokens: number;
    readonly scopeTokens: number;
    readonly sessionStateTokens: number;
    readonly compactionMemoryTokens: number;
    readonly otherSystemTokens: number;
  };
  readonly toolDefinitionCount: number;
}

function isPlanSystem(content: string): boolean {
  return content.startsWith("ACTIVE PLAN") || content.includes("\nACTIVE PLAN");
}

function isScopeSystem(content: string): boolean {
  return (
    content.startsWith("ENGAGEMENT SCOPE") ||
    content.includes("\nENGAGEMENT SCOPE")
  );
}

function isSessionStateSystem(content: string): boolean {
  return (
    content.startsWith(SESSION_STATE_PREFIX) ||
    content.includes(SESSION_STATE_PREFIX)
  );
}

function isCompactionSystem(content: string): boolean {
  return (
    content.startsWith(COMPACTION_MEMORY_PREFIX) ||
    content.startsWith(PLAN_IMPLEMENT_MEMORY_PREFIX) ||
    content.startsWith(MECHANICAL_MEMORY_PREFIX) ||
    // Message-shaped helper when role is system.
    isCompactionMemoryMessage({ role: "system", content })
  );
}

/**
 * Build a metadata-only breakdown of an assembled completion request.
 */
export function buildContextBreakdown(
  messages: readonly ChatMessage[],
  tools?: readonly ToolDefinition[] | undefined,
): ContextBreakdown {
  let systemTokens = 0;
  let userTokens = 0;
  let assistantTokens = 0;
  let toolResultTokens = 0;
  let systemMessageCount = 0;
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let toolMessageCount = 0;

  let constitutionTokens = 0;
  let planTokens = 0;
  let scopeTokens = 0;
  let sessionStateTokens = 0;
  let compactionMemoryTokens = 0;
  let otherSystemTokens = 0;

  for (const message of messages) {
    const tokens = estimateTokens(message.content) + 4;
    switch (message.role) {
      case "system": {
        systemMessageCount += 1;
        systemTokens += tokens;
        if (isCompactionSystem(message.content)) {
          compactionMemoryTokens += tokens;
        } else if (isPlanSystem(message.content)) {
          planTokens += tokens;
        } else if (isScopeSystem(message.content)) {
          scopeTokens += tokens;
        } else if (isSessionStateSystem(message.content)) {
          sessionStateTokens += tokens;
        } else if (
          systemMessageCount === 1 ||
          /CURRENT MODE:|OUTCOME CONTRACT|# ROLE|# HONESTY/i.test(
            message.content,
          )
        ) {
          // Primary system / composed constitution (often message[0]).
          constitutionTokens += tokens;
        } else {
          otherSystemTokens += tokens;
        }
        break;
      }
      case "user":
        userMessageCount += 1;
        userTokens += tokens;
        break;
      case "assistant":
        assistantMessageCount += 1;
        assistantTokens += tokens;
        if (message.toolCalls?.length) {
          assistantTokens += estimateTokens(
            JSON.stringify(message.toolCalls),
          );
        }
        assistantTokens += reasoningArtifactTokensForMessage(message);
        break;
      case "tool":
        toolMessageCount += 1;
        toolResultTokens += tokens;
        break;
      default:
        otherSystemTokens += tokens;
        break;
    }
  }

  let toolSchemaTokens = 0;
  const toolDefinitionCount = tools?.length ?? 0;
  if (tools?.length) {
    toolSchemaTokens = estimateTokens(JSON.stringify(tools));
  }

  const estimatedTotalTokens =
    estimateMessagesTokens([...messages]) + toolSchemaTokens;

  return {
    estimatedTotalTokens,
    systemTokens,
    userTokens,
    assistantTokens,
    toolResultTokens,
    toolSchemaTokens,
    messageCount: messages.length,
    systemMessageCount,
    userMessageCount,
    assistantMessageCount,
    toolMessageCount,
    systemParts: {
      constitutionTokens,
      planTokens,
      scopeTokens,
      sessionStateTokens,
      compactionMemoryTokens,
      otherSystemTokens,
    },
    toolDefinitionCount,
  };
}

/** Flatten for audit/diagnostic logs (numeric keys only — no content). */
export function contextBreakdownAuditPayload(
  breakdown: ContextBreakdown,
): Record<string, number> {
  return {
    estimatedTotalTokens: breakdown.estimatedTotalTokens,
    systemTokens: breakdown.systemTokens,
    userTokens: breakdown.userTokens,
    assistantTokens: breakdown.assistantTokens,
    toolResultTokens: breakdown.toolResultTokens,
    toolSchemaTokens: breakdown.toolSchemaTokens,
    messageCount: breakdown.messageCount,
    systemMessageCount: breakdown.systemMessageCount,
    userMessageCount: breakdown.userMessageCount,
    assistantMessageCount: breakdown.assistantMessageCount,
    toolMessageCount: breakdown.toolMessageCount,
    constitutionTokens: breakdown.systemParts.constitutionTokens,
    planTokens: breakdown.systemParts.planTokens,
    scopeTokens: breakdown.systemParts.scopeTokens,
    sessionStateTokens: breakdown.systemParts.sessionStateTokens,
    compactionMemoryTokens: breakdown.systemParts.compactionMemoryTokens,
    otherSystemTokens: breakdown.systemParts.otherSystemTokens,
    toolDefinitionCount: breakdown.toolDefinitionCount,
  };
}


// Name the block that dominates an irreducible request: when compaction cannot
// get under the trigger, the user needs to know what is actually large instead
// of watching the same attempt repeat.
export function describeDominantContextBlock(
  messages: readonly ChatMessage[],
  tools?: readonly ToolDefinition[] | undefined,
): string {
  const breakdown = buildContextBreakdown(messages, tools);
  const candidates: Array<{ label: string; tokens: number }> = [
    { label: "tool schemas", tokens: breakdown.toolSchemaTokens },
    { label: "tool results", tokens: breakdown.toolResultTokens },
    { label: "assistant history", tokens: breakdown.assistantTokens },
    { label: "user messages", tokens: breakdown.userTokens },
    {
      label: "system constitution",
      tokens: breakdown.systemParts.constitutionTokens,
    },
    {
      label: "compaction memory",
      tokens: breakdown.systemParts.compactionMemoryTokens,
    },
    { label: "plan state", tokens: breakdown.systemParts.planTokens },
    {
      label: "session state",
      tokens: breakdown.systemParts.sessionStateTokens,
    },
  ];
  const dominant = candidates.reduce((largest, candidate) =>
    candidate.tokens > largest.tokens ? candidate : largest,
  );
  return `${dominant.label} (~${dominant.tokens.toLocaleString()} tokens)`;
}

// Stable hash of the attached tool schemas, for attempt identity.
export function toolSchemaHash(
  tools: readonly ToolDefinition[] | undefined,
): string {
  if (!tools || tools.length === 0) return "none";
  return createHash("sha256")
    .update(tools.map((tool) => `${tool.name}:${estimateTokens(JSON.stringify(tool.parameters))}`).join("|"))
    .digest("hex")
    .slice(0, 16);
}
