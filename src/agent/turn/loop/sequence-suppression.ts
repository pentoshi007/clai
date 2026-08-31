import type { ChatMessage, CompletionResult, ToolCall, ToolResult } from "../../../types.js";
import type { LoopGuardStopInfo } from "../../turn-outcome.js";
import { formatToolArgs } from "../../../agent/tool-call-parser.js";
import {
  appendAssistantWithTools,
  appendToolResult,
} from "../../tool-history.js";

export interface SequenceBoundCall {
  readonly id: string;
  readonly index: number;
  readonly call: ToolCall;
}

export interface SequenceVerdict {
  readonly suppress: boolean;
  readonly terminal?: boolean | undefined;
  readonly oscillation?: boolean | undefined;
}

export interface SequenceSuppressionPorts {
  readonly messages: ChatMessage[];
  readonly notify: (level: "info" | "warn", message: string) => void;
  readonly queuedEventId: (index: number) => string | undefined;
  readonly allocateEventId: () => string;
  readonly writeToolCall: (eventId: string, call: ToolCall) => void;
  readonly markPrinted: (eventId: string) => void;
  readonly emitToolStart: (eventId: string) => void;
  readonly writeToolOutput: (eventId: string, chunk: string) => void;
  readonly emitToolResult: (
    eventId: string,
    result: ToolResult,
    contextOutput: string,
  ) => void;
  readonly priorObservation: (call: ToolCall) => string | undefined;
  readonly pushAssistantHistory: (text: string) => void;
  readonly upsertActionCycleRecovery: (content: string) => void;
  readonly unreadResponderResults: () => boolean;
  readonly currentSignature: () => string | undefined;
}

export interface SequenceSuppressionInput {
  readonly verdict: SequenceVerdict;
  readonly bound: readonly SequenceBoundCall[];
  readonly runIds: ReadonlySet<string>;
  readonly deferReason: string;
  readonly beforeTool: string | undefined;
  readonly historyNativeCalls: readonly {
    id: string;
    name: string;
    args: Record<string, unknown>;
  }[];
  readonly completion: Pick<
    CompletionResult,
    "reasoningBlock" | "reasoningArtifacts"
  >;
  readonly assistantThinkContent: string;
  readonly hasThinking: boolean;
}

export interface SequenceStop {
  readonly kind: "stop";
  readonly answer: string;
  readonly remainingCriteria: readonly string[];
  readonly reason: string;
  readonly loopGuardStop: LoopGuardStopInfo;
}

export type SequenceSuppressionDecision =
  | { readonly kind: "continue-round" }
  | SequenceStop;

const TERMINAL_REASON =
  "The model repeated the same action sequence after it was already suppressed. No commands were run again.";

const OSCILLATION_REASON =
  "This exact action sequence already completed earlier this turn (the agent is oscillating back to finished work). No commands were run again; every one of these results is already in context — synthesize them and either advance to a genuinely new action or finish.";

const REPEAT_REASON =
  "The same action sequence already ran in the previous model round. No commands were run again; reuse the existing results and choose a materially different next action or finish.";

const suppressionReason = (verdict: SequenceVerdict): string => {
  if (verdict.terminal) return TERMINAL_REASON;
  return verdict.oscillation ? OSCILLATION_REASON : REPEAT_REASON;
};

interface SuppressedEntry {
  readonly bound: SequenceBoundCall;
  readonly reason: string;
  readonly result: ToolResult;
}

const buildSuppressedResults = (
  ports: SequenceSuppressionPorts,
  input: SequenceSuppressionInput,
  reason: string,
): SuppressedEntry[] =>
  input.bound.map((bound) => {
    const duplicate = input.runIds.has(bound.id);
    const priorObservation = duplicate
      ? ports.priorObservation(bound.call)
      : undefined;
    const entryReason = duplicate
      ? reason +
        (priorObservation
          ? `\n\nPrior successful result for ${bound.call.name}:\n${priorObservation}`
          : "")
      : input.deferReason;
    return {
      bound,
      reason: entryReason,
      result: {
        ok: duplicate,
        output: entryReason,
        exitCode: duplicate ? 0 : 130,
        ...(duplicate ? { suppressedRepeat: true } : {}),
      },
    };
  });

const completeSuppressedCards = (
  ports: SequenceSuppressionPorts,
  entries: readonly SuppressedEntry[],
): void => {
  for (const entry of entries) {
    const eventId =
      ports.queuedEventId(entry.bound.index) ?? ports.allocateEventId();
    ports.writeToolCall(eventId, entry.bound.call);
    ports.markPrinted(eventId);
    ports.emitToolStart(eventId);
    ports.writeToolOutput(
      eventId,
      entry.reason.endsWith("\n") ? entry.reason : `${entry.reason}\n`,
    );
    ports.emitToolResult(eventId, entry.result, entry.reason);
  }
};

const deniedContent = (bound: SequenceBoundCall, reason: string): string =>
  `Tool ${bound.call.name} result (exit=130, ok=false):\n` +
  `NOT EXECUTED — suppressed repeat. ${reason}\n\n` +
  `Suppressed call: ${bound.call.name} ${formatToolArgs(bound.call)}. ` +
  "This exact call is blocked for the rest of the turn; its earlier result is already in context — use it, or choose a different action.";

const recordSuppressedHistory = (
  ports: SequenceSuppressionPorts,
  input: SequenceSuppressionInput,
  entries: readonly SuppressedEntry[],
): void => {
  if (input.historyNativeCalls.length) {
    appendAssistantWithTools(
      ports.messages,
      input.beforeTool ?? "",
      [...input.historyNativeCalls] as never,
      input.completion.reasoningBlock ??
        (input.hasThinking && input.assistantThinkContent
          ? { text: input.assistantThinkContent }
          : undefined),
      input.completion.reasoningArtifacts,
    );
    for (const entry of entries) {
      appendToolResult(
        ports.messages,
        entry.bound.id,
        deniedContent(entry.bound, entry.reason),
        entry.bound.call.name,
        false,
      );
    }
    return;
  }
  const standardized =
    (input.beforeTool ? input.beforeTool.trim() + "\n\n" : "") +
    input.bound
      .map((bound) => `\`\`\`tool\n${JSON.stringify(bound.call)}\n\`\`\``)
      .join("\n\n");
  ports.pushAssistantHistory(standardized);
  for (const entry of entries) {
    ports.messages.push({
      role: "tool",
      content: deniedContent(entry.bound, entry.reason),
    });
  }
};

const terminalStop = (
  ports: SequenceSuppressionPorts,
  input: SequenceSuppressionInput,
  callList: string,
): SequenceStop => {
  const observation = input.bound
    .map((bound) => ports.priorObservation(bound.call))
    .find((text) => typeof text === "string" && text.trim().length > 0);
  return {
    kind: "stop",
    answer: `Stopped an identical action cycle before it could execute again. Blocked this turn: ${callList}. Their earlier results are in context — continue from those, do not re-issue the same calls.`,
    remainingCriteria: ports.unreadResponderResults()
      ? [
          "Analyze and acknowledge the delivered Responder result without repeating completed foreground work.",
        ]
      : [
          "Continue with a materially different action that can produce new evidence.",
        ],
    reason:
      "The model repeated an identical action sequence without a new premise or state change.",
    loopGuardStop: {
      calls: callList,
      ...(observation?.trim()
        ? { observation: observation.trim().slice(0, 4000) }
        : {}),
      signature: ports.currentSignature() ?? callList,
    },
  };
};

export const suppressRepeatedActionSequence = (
  ports: SequenceSuppressionPorts,
  input: SequenceSuppressionInput,
): SequenceSuppressionDecision => {
  const reason = suppressionReason(input.verdict);
  ports.notify("warn", reason);
  const entries = buildSuppressedResults(ports, input, reason);
  completeSuppressedCards(ports, entries);
  const callList = entries
    .map((entry) => `${entry.bound.call.name} ${formatToolArgs(entry.bound.call)}`)
    .join("; ");
  recordSuppressedHistory(ports, input, entries);

  if (input.verdict.terminal) return terminalStop(ports, input, callList);

  ports.upsertActionCycleRecovery(
    reason +
      ` The repeated calls were: ${callList}.` +
      (ports.unreadResponderResults()
        ? " A delivered Responder result is still unread: analyze the available result, gather only genuinely necessary bounded evidence, then call job.read before returning to foreground work."
        : " The original successful tool results remain in context. Reassess that evidence and either finish or select a materially different action; do not replay completed work."),
  );
  return { kind: "continue-round" };
};
