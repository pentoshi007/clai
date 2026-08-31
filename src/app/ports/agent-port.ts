import type {
  ChatImage,
  ChatMessage,
  Mode,
  ProviderId,
  SuccessfulRequestSnapshot,
} from "../../types.js";
import type { Attachment } from "../../ui/mentions.js";
import type { AgentEvent } from "../../agent/events.js";
import type { SessionPolicy } from "../../agent/session-policy.js";
import type { ConfirmationPort } from "./confirm-port.js";
import type { SecretPort } from "./secret-port.js";
import type { TurnOutcome } from "../../agent/turn-outcome.js";
import type { PreviousTurnSignal } from "../../agent/continue-orient.js";

export interface RunTurnRequest {
  readonly prompt: string;
  readonly displayPrompt?: string | null | undefined;
  readonly mode: Mode;
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly history?: readonly ChatMessage[] | undefined;
  readonly attachments?: readonly Attachment[] | undefined;
  readonly images?: readonly ChatImage[] | undefined;
  readonly visionProven?: boolean | undefined;
  readonly autoConfirm?: boolean | undefined;
  readonly maxSteps?: number | undefined;
  readonly previousTurn?: PreviousTurnSignal | undefined;
  readonly previousSuccessfulRequest?: SuccessfulRequestSnapshot | undefined;
  readonly contextLimitTokens?: number | undefined;
  readonly getContextLimitTokens?: (
    provider: ProviderId | undefined,
    model: string | undefined,
  ) => number | undefined;
}

export type { PreviousTurnSignal } from "../../agent/continue-orient.js";

export interface RunTurnHandlers {
  readonly onEvent: (event: AgentEvent) => void;
  readonly onMessages?: ((messages: ChatMessage[]) => void) | undefined;
  readonly onSuccessfulRequest?:
    | ((snapshot: SuccessfulRequestSnapshot) => void)
    | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly confirm?: ConfirmationPort | undefined;
  readonly requestSecret?: SecretPort["request"] | undefined;
  readonly session?: SessionPolicy | undefined;
}

export interface AgentPort {
  runTurn(request: RunTurnRequest, handlers: RunTurnHandlers): Promise<TurnOutcome>;
}
