import type { ChatMessage } from "../../../types.js";
import {
  appendInterruptedReasoning,
  interruptedReasoningBrief,
} from "../../interrupted-reasoning.js";
import { toolNudge } from "../../../prompts/index.js";

export interface EmptyResponseState {
  emptyVisibleRetries: number;
  retryWithoutThinking: boolean;
  interruptedReasoning: string;
}

export interface EmptyResponsePorts {
  readonly messages: ChatMessage[];
  readonly toolsAttached: boolean;
  readonly planModeWithoutPlan: boolean;
  readonly notify: (level: "info" | "warn", message: string) => void;
  readonly commitAssistantRetry: (text: string) => void;
  readonly recoveryUserMessage: (content: string) => ChatMessage;
}

export interface EmptyResponseInput {
  readonly assistantVisible: string;
  readonly assistantThinkContent: string;
  readonly hasThinking: boolean;
  readonly incompleteNativeStream: boolean;
}

export type EmptyResponseDecision = "continue-round" | "stop";

const MAX_EMPTY_RETRIES = 3;

const baseNudgeFor = (
  ports: EmptyResponsePorts,
  input: EmptyResponseInput,
): string => {
  if (input.incompleteNativeStream) {
    return "Your native tool call was incomplete, so nothing ran. Use exactly one complete fenced ```tool block now; do not repeat the incomplete native call.";
  }
  if (ports.planModeWithoutPlan) {
    return ports.toolsAttached
      ? "No visible output. In plan mode: gather context or call plan.create when ready (do not only describe the plan)."
      : "No visible output. In plan mode: emit a ```tool block for research/recon or plan.create. " +
          "Do NOT hide tool calls in <think> tags — put them in the visible response.";
  }
  return ports.toolsAttached
    ? "No visible output. " + toolNudge(true)
    : "No visible output. Emit a ```tool block or give your final answer. " +
        "Do NOT hide tool calls in <think> tags — put them in the visible response.";
};

export const handleEmptyResponse = (
  ports: EmptyResponsePorts,
  state: EmptyResponseState,
  input: EmptyResponseInput,
): EmptyResponseDecision => {
  state.emptyVisibleRetries += 1;
  if (state.emptyVisibleRetries > MAX_EMPTY_RETRIES) {
    ports.notify(
      "warn",
      "model returned an empty response after retries — no answer produced",
    );
    return "stop";
  }

  ports.notify(
    "warn",
    input.hasThinking
      ? "model produced only thinking — preserving the reasoning and nudging it to act"
      : "model returned an empty response — nudging it to answer",
  );
  if (input.hasThinking) {
    state.interruptedReasoning = appendInterruptedReasoning(
      state.interruptedReasoning,
      input.assistantThinkContent,
    );
  }
  const preservedReasoning = state.interruptedReasoning;
  if (input.hasThinking && state.emptyVisibleRetries >= 2) {
    state.retryWithoutThinking = true;
  }
  ports.commitAssistantRetry(input.assistantVisible);
  state.interruptedReasoning = preservedReasoning;

  const baseNudge = baseNudgeFor(ports, input);
  const reasoningBrief = input.hasThinking
    ? interruptedReasoningBrief(state.interruptedReasoning)
    : undefined;
  ports.messages.push(
    ports.recoveryUserMessage(
      reasoningBrief
        ? "Your previous response contained only reasoning and no visible answer or tool call. " +
            "Do not restart the analysis — your reasoning so far is preserved below. " +
            "Build on it and act now: emit the next tool call or the final answer.\n\n" +
            reasoningBrief +
            "\n\n" +
            baseNudge
        : baseNudge,
    ),
  );
  return "continue-round";
};
