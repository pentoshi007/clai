import type {
  ChatMessage,
  CompletionRequestPurpose,
  ProviderId,
  ReasoningArtifactDialect,
  ReasoningPreference,
} from "../types.js";
import type { ProviderAuth } from "./provider.js";
import type { StreamTerminalPolicy } from "./stream-terminal.js";

export type ResponsesAccept = "application/json" | "text/event-stream";

export interface ResponsesBodyExtrasContext {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly purpose: CompletionRequestPurpose | undefined;
  readonly reasoningEnabled: boolean;
}

export interface ResponsesDialectConfig {
  readonly baseUrl: string;
  readonly providerId: ProviderId;
  readonly displayName: string;
  readonly artifactDialect: ReasoningArtifactDialect;
  readonly terminalPolicy: StreamTerminalPolicy;
  buildHeaders(
    auth: ProviderAuth,
    accept: ResponsesAccept,
  ): Record<string, string>;
  reasoningPayload(
    reasoning: ReasoningPreference | undefined,
  ): Record<string, unknown> | undefined;
  bodyExtras(context: ResponsesBodyExtrasContext): Record<string, unknown>;
}

export function mapResponsesEffort(effort: string): string {
  if (effort === "none" || effort === "minimal") return "minimal";
  if (effort === "max" || effort === "xhigh") return "xhigh";
  if (effort === "low") return "low";
  if (effort === "high") return "high";
  return "medium";
}

export function responsesReasoningSummary(effort: string): string {
  if (effort === "xhigh" || effort === "high") return "detailed";
  if (effort === "medium") return "concise";
  return "auto";
}
