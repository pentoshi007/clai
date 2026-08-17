import type { ReasoningArtifact, TokenUsage } from "../types.js";

export type ProviderStreamEvent =
  | { readonly type: "answer_delta"; readonly text: string }
  | { readonly type: "commentary_delta"; readonly text: string }
  | { readonly type: "reasoning_delta"; readonly text: string }
  | {
      readonly type: "reasoning_artifact_available";
      readonly artifacts: readonly ReasoningArtifact[];
    }
  | {
      readonly type: "tool_call_started";
      readonly index: number;
      readonly id?: string | undefined;
      readonly name: string;
    }
  | {
      readonly type: "tool_arguments_delta";
      readonly index: number;
      readonly id?: string | undefined;
      readonly argumentsBytes: number;
    }
  | {
      readonly type: "tool_call_completed";
      readonly index: number;
      readonly id?: string | undefined;
      readonly name: string;
    }
  | { readonly type: "usage_observed"; readonly usage: TokenUsage }
  | {
      readonly type: "provider_terminal";
      readonly finishReason?: string | undefined;
    };

export type ProviderStreamEventSink = (event: ProviderStreamEvent) => void;

export function emitStreamReasoningDelta(
  sink: ProviderStreamEventSink | undefined,
  text: string,
): void {
  if (!text) return;
  sink?.({ type: "reasoning_delta", text });
}

export function emitStreamReasoningArtifacts(
  sink: ProviderStreamEventSink | undefined,
  artifacts: readonly ReasoningArtifact[] | undefined,
): void {
  if (!artifacts?.length) return;
  sink?.({ type: "reasoning_artifact_available", artifacts });
}

export function isSemanticStreamOutputEvent(
  event: ProviderStreamEvent,
): boolean {
  switch (event.type) {
    case "answer_delta":
    case "commentary_delta":
    case "reasoning_delta":
    case "tool_call_started":
    case "tool_arguments_delta":
    case "tool_call_completed":
      return true;
    default:
      return false;
  }
}

export class StreamEventProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamEventProtocolError";
  }
}

export interface StreamEventGuard {
  accept(event: ProviderStreamEvent): void;
  readonly terminal: boolean;
}

export function createStreamEventGuard(): StreamEventGuard {
  let terminal = false;
  return {
    get terminal(): boolean {
      return terminal;
    },
    accept(event: ProviderStreamEvent): void {
      if (terminal) {
        if (event.type === "usage_observed") return;
        throw new StreamEventProtocolError(
          `stream event emitted after provider_terminal: ${event.type}`,
        );
      }
      if (event.type === "provider_terminal") {
        terminal = true;
        return;
      }
      if (
        (event.type === "answer_delta" ||
          event.type === "commentary_delta" ||
          event.type === "reasoning_delta") &&
        event.text.length === 0
      ) {
        throw new StreamEventProtocolError(
          `empty ${event.type} emitted`,
        );
      }
    },
  };
}
