import type {
  ChatImage,
  ChatMessage,
  ProviderId,
} from "../../types.js";
import type { AgentEvent } from "../../agent/events.js";
import type { SessionPolicy } from "../../agent/session-policy.js";
import type { ConfirmationPort } from "./confirm-port.js";
import type { SecretPort } from "./secret-port.js";

export interface RunTurnRequest {
  readonly prompt: string;
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly history?: readonly ChatMessage[] | undefined;
  readonly images?: readonly ChatImage[] | undefined;
  readonly autoConfirm?: boolean | undefined;
  readonly maxSteps?: number | undefined;
}

export interface RunTurnHandlers {
  readonly onEvent: (event: AgentEvent) => void;
  readonly onMessages?: ((messages: ChatMessage[]) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly confirm?: ConfirmationPort | undefined;
  readonly requestSecret?: SecretPort["request"] | undefined;
  readonly session?: SessionPolicy | undefined;
}

/**
 * The one agent implementation, consumed through structured events (CORE-001).
 * `runTurn` resolves with the final answer; events flow through `onEvent`.
 */
export interface AgentPort {
  runTurn(request: RunTurnRequest, handlers: RunTurnHandlers): Promise<string>;
}
