import type { SessionPlan } from "../store/plan.js";

export type AgentEvent =
  | { type: "turn-start"; prompt: string }
  | { type: "status"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "thinking-block"; content: string }
  | { type: "assistant-delta"; text: string }
  | { type: "assistant-message"; text: string }
  | { type: "notice"; level: "info" | "warn"; text: string }
  | { type: "tool-call"; id: string; name: string; argsDisplay: string }
  | { type: "tool-output"; id: string; chunk: string }
  | {
      type: "tool-result";
      id: string;
      ok: boolean;
      exitCode?: number;
      summary: string;
      artifactPath?: string;
    }
  | { type: "tool-blocked"; id: string; name: string; reason: string }
  | { type: "plan-update"; plan: SessionPlan }
  | {
      type: "confirm-request";
      id: string;
      kind: "tool" | "pentest" | "reset";
      prompt: string;
    }
  | { type: "turn-end"; finalAnswer: string; steps: number }
  | { type: "turn-aborted" }
  | { type: "turn-error"; message: string };
