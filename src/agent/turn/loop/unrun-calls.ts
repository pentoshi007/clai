import type { ChatMessage, ToolResult } from "../../../types.js";
import type { BoundCall } from "../contracts.js";
import type { RoundState } from "./round-state.js";
import { appendToolResult } from "../../tool-history.js";

export interface UnrunCallPorts {
  readonly round: RoundState;
  readonly messages: ChatMessage[];
  readonly useNativeHistory: boolean;
  readonly eventIdFor: (index: number) => string;
  readonly wasPrinted: (uiId: string) => boolean;
  readonly emitToolResult: (
    uiId: string,
    result: ToolResult,
    contextOutput: string,
  ) => void;
}

const settlementReason = (round: RoundState): string =>
  round.aborted
    ? "Cancelled — turn aborted before this call ran."
    : round.awaitingPlanApproval
      ? "Deferred — waiting for plan approval."
      : "Cancelled — not executed.";

export const settleUnrunCalls = (
  ports: UnrunCallPorts,
  toRun: readonly BoundCall[],
): void => {
  for (let index = 0; index < toRun.length; index += 1) {
    const bound = toRun[index]!;
    if (ports.round.recordedNativeIds.has(bound.id)) continue;
    const uiId = ports.eventIdFor(index);
    const reason = settlementReason(ports.round);
    const result: ToolResult = { ok: false, output: reason, exitCode: 130 };
    if (ports.wasPrinted(uiId)) ports.emitToolResult(uiId, result, reason);
    const content = `Tool ${bound.call.name} result (exit=130, ok=false):\n${reason}`;
    if (ports.useNativeHistory) {
      appendToolResult(
        ports.messages,
        bound.id,
        content,
        bound.call.name,
        false,
      );
      ports.round.recordedNativeIds.add(bound.id);
    } else {
      ports.messages.push({ role: "tool", content });
    }
  }
};
