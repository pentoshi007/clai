import type { SessionPlan } from "../store/plan.js";
import type { TokenUsage } from "../types.js";
import type { TurnOutcome } from "./turn-outcome.js";

export type AgentEvent =
  | {
      type: "turn-start";
      prompt: string;
      /** Chat YOU bubble text; null/empty = hide system choreography from transcript. */
      displayPrompt?: string | null;
    }
  | { type: "status"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "thinking-block"; content: string }
  | { type: "assistant-delta"; text: string }
  | { type: "assistant-message"; text: string }
  | { type: "notice"; level: "info" | "warn"; text: string }
  | { type: "tool-call"; id: string; name: string; argsDisplay: string }
  /** Tool moved from queued → actually executing (cards stay in document order). */
  | { type: "tool-start"; id: string }
  /** `replace: true` sets the full body (never append) so the UI never keeps a truncated live preview. */
  | { type: "tool-output"; id: string; chunk: string; replace?: boolean }
  | {
      type: "tool-result";
      id: string;
      ok: boolean;
      exitCode?: number;
      summary: string;
      artifactPath?: string;
      /** Cursor-style file diffs for fs.* mutation tools. */
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
    }
  | {
      type: "compaction-failed";
      id: string;
      message: string;
      retainedTokens: number;
    }
  /** Legacy one-shot compaction event retained for non-streaming integrations. */
  | { type: "compacted"; summary: string; beforeTokens: number; afterTokens: number }
  /** Provider-reported token usage after a model completion. */
  | { type: "token-usage"; usage: TokenUsage; model?: string | undefined }
  /** Authoritative assembled-request estimate (same measure as compaction). */
  | { type: "context-estimate"; estimatedTokens: number; model?: string | undefined };
