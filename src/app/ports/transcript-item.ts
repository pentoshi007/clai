import type { SessionPlan } from "../../store/plan.js";
import type { FileChange } from "../../tools/file-diff.js";

export type ToolStatus = "running" | "ok" | "fail" | "blocked";

export interface UserItem {
  kind: "user";
  id: string;
  text: string;
  done: boolean;
}

export interface AssistantItem {
  kind: "assistant";
  id: string;
  text: string;
  streaming: boolean;
  done: boolean;
}

export interface ThinkingItem {
  kind: "thinking";
  id: string;
  content: string;
  done: boolean;
  startedAt?: number | undefined;
  endedAt?: number | undefined;
}

export interface ToolItem {
  kind: "tool";
  id: string;
  name: string;
  argsDisplay: string;
  output: string;
  status: ToolStatus;
  exitCode?: number | undefined;
  summary?: string | undefined;
  artifactPath?: string | undefined;
  fileChanges?: readonly FileChange[] | undefined;
  done: boolean;
  timestamp?: number | undefined;
  endedAt?: number | undefined;
  durationMs?: number | undefined;
}

export interface NoticeItem {
  kind: "notice";
  id: string;
  level: "info" | "warn";
  text: string;
  done: boolean;
}

export interface PlanItem {
  kind: "plan";
  id: string;
  plan: SessionPlan;
  done: boolean;
}

export interface CompactedItem {
  kind: "compacted";
  id: string;
  summary: string;
  originalItems: TranscriptItem[];
  done: boolean;
  streaming?: boolean | undefined;
  error?: string | undefined;
  beforeTokens?: number | undefined;
  afterTokens?: number | undefined;
  startedAt?: number | undefined;
  endedAt?: number | undefined;
}

export interface TurnSummaryItem {
  kind: "turn-summary";
  id: string;
  durationMs: number;
  status: "completed" | "aborted" | "error";
  timestamp?: number | undefined;
  done: boolean;
}

export type TranscriptItem =
  | UserItem
  | AssistantItem
  | ThinkingItem
  | ToolItem
  | NoticeItem
  | PlanItem
  | CompactedItem
  | TurnSummaryItem;
