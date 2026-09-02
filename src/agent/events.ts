import type { ContextAttemptReference, ContextSnapshotScope } from "../llm/context-snapshot.js";
import type { SessionPlan } from "../store/plan.js";
import type { ProviderId, TokenUsage } from "../types.js";
import type { TurnOutcome } from "./turn-outcome.js";

export type AgentEvent =
  | {
      type: "turn-start";
      prompt: string;
      displayPrompt?: string | null;
    }
  | { type: "status"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "thinking-block"; content: string }
  | { type: "assistant-delta"; text: string }
  | { type: "assistant-message"; text: string }
  | { type: "notice"; level: "info" | "warn"; text: string }
  | { type: "tool-call"; id: string; name: string; argsDisplay: string }
  | { type: "tool-start"; id: string }
  | { type: "tool-output"; id: string; chunk: string; replace?: boolean }
  | {
      type: "tool-result";
      id: string;
      ok: boolean;
      exitCode?: number;
      summary: string;
      artifactPath?: string;
      fileChanges?: import("../tools/file-diff.js").FileChange[] | undefined;
    }
  | { type: "tool-blocked"; id: string; name: string; reason: string }
  | { type: "plan-update"; plan: SessionPlan }
  | { type: "plan-cleared"; sessionId: string }
  | {
      type: "confirm-request";
      id: string;
      kind: "tool" | "pentest" | "reset" | "continue" | "plan" | "switch";
      prompt: string;
    }
  | { type: "turn-end"; outcome: TurnOutcome; finalAnswer: string; steps: number }
  | { type: "turn-aborted" }
  | { type: "turn-error"; message: string }
  | { type: "compaction-start"; id: string; beforeTokens: number }
  | { type: "compaction-delta"; id: string; text: string; replace?: boolean | undefined }
  | {
      type: "compaction-completed";
      id: string;
      summary: string;
      beforeTokens: number;
      afterTokens: number;
      contextScope: Extract<
        ContextSnapshotScope,
        "message-history" | "assembled-request"
      >;
    }
  | {
      type: "compaction-failed";
      id: string;
      message: string;
      retainedTokens: number;
    }
  | { type: "compacted"; summary: string; beforeTokens: number; afterTokens: number }
  | {
      type: "token-usage";
      usage: TokenUsage;
      model?: string | undefined;
      provider?: ProviderId | undefined;
      api?: string | undefined;
      attempt?: ContextAttemptReference | undefined;
    }
  | { type: "context-estimate"; estimatedTokens: number; model?: string | undefined };
