import type { AgentEvent } from "../agent/events.js";
import type { SessionPlan } from "../store/plan.js";

// ── Transcript items ─────────────────────────────────────────────────────────

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
  done: boolean;
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

export type TranscriptItem =
  | UserItem
  | AssistantItem
  | ThinkingItem
  | ToolItem
  | NoticeItem
  | PlanItem;

// ── Confirm requests ─────────────────────────────────────────────────────────

export interface PendingConfirm {
  id: string;
  kind: "tool" | "pentest";
  prompt: string;
}

// ── App state ────────────────────────────────────────────────────────────────

export interface TurnStatus {
  running: boolean;
  activity: string;
  step: number;
  startedAt: number | undefined;
}

export interface TuiState {
  items: TranscriptItem[];
  status: TurnStatus;
  thinkingPreview: string;
  thinkingExpanded: boolean;
  pendingConfirm: PendingConfirm | undefined;
  queued: string[];
}

export function initialState(): TuiState {
  return {
    items: [],
    status: { running: false, activity: "", step: 0, startedAt: undefined },
    thinkingPreview: "",
    thinkingExpanded: false,
    pendingConfirm: undefined,
    queued: [],
  };
}

// ── Actions ──────────────────────────────────────────────────────────────────

export type TuiAction =
  | { type: "event"; event: AgentEvent }
  | { type: "submit"; text: string }
  | { type: "queue"; text: string }
  | { type: "dequeue" }
  | { type: "notice"; level: "info" | "warn"; text: string }
  | { type: "toggle-thinking" }
  | { type: "confirm-resolved" }
  | { type: "reset" };

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

// ── Reducer ──────────────────────────────────────────────────────────────────

export function reducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "reset":
      return initialState();
    case "toggle-thinking":
      return { ...state, thinkingExpanded: !state.thinkingExpanded };
    case "queue":
      return { ...state, queued: [...state.queued, action.text] };
    case "dequeue": {
      const [, ...rest] = state.queued;
      return { ...state, queued: rest };
    }
    case "confirm-resolved":
      return { ...state, pendingConfirm: undefined };
    case "notice":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "notice",
            id: nextId("notice"),
            level: action.level,
            text: action.text,
            done: true,
          },
        ],
      };
    case "submit":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "user",
            id: nextId("user"),
            text: action.text,
            done: true,
          },
        ],
        status: {
          running: true,
          activity: "thinking",
          step: 0,
          startedAt: Date.now(),
        },
        thinkingPreview: "",
      };
    case "event":
      return applyEvent(state, action.event);
  }
}

function applyEvent(state: TuiState, event: AgentEvent): TuiState {
  switch (event.type) {
    case "turn-start":
      return state;
    case "status": {
      const stepMatch = /^step (\d+)$/.exec(event.text);
      return {
        ...state,
        status: {
          ...state.status,
          running: true,
          activity: event.text,
          step: stepMatch ? Number(stepMatch[1]) : state.status.step,
        },
      };
    }
    case "thinking-delta":
      return {
        ...state,
        status: { ...state.status, activity: "thinking" },
        thinkingPreview: tailPreview(state.thinkingPreview + event.text),
      };
    case "thinking-block":
      return {
        ...state,
        thinkingPreview: "",
        items: [
          ...state.items,
          {
            kind: "thinking",
            id: nextId("think"),
            content: event.content,
            done: true,
          },
        ],
      };
    case "assistant-delta": {
      const items = [...state.items];
      const last = items[items.length - 1];
      if (last && last.kind === "assistant" && !last.done) {
        items[items.length - 1] = { ...last, text: last.text + event.text };
      } else {
        items.push({
          kind: "assistant",
          id: nextId("asst"),
          text: event.text,
          streaming: true,
          done: false,
        });
      }
      return {
        ...state,
        thinkingPreview: "",
        status: { ...state.status, activity: "responding" },
        items,
      };
    }
    case "assistant-message": {
      const items = [...state.items];
      const last = items[items.length - 1];
      if (last && last.kind === "assistant" && !last.done) {
        items[items.length - 1] = {
          ...last,
          text: event.text,
          streaming: false,
          done: true,
        };
      } else {
        items.push({
          kind: "assistant",
          id: nextId("asst"),
          text: event.text,
          streaming: false,
          done: true,
        });
      }
      return { ...state, thinkingPreview: "", items };
    }
    case "notice":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "notice",
            id: nextId("notice"),
            level: event.level,
            text: event.text,
            done: true,
          },
        ],
      };
    case "tool-call":
      return {
        ...state,
        status: { ...state.status, activity: event.name },
        items: [
          ...state.items,
          {
            kind: "tool",
            id: event.id,
            name: event.name,
            argsDisplay: event.argsDisplay,
            output: "",
            status: "running",
            done: false,
          },
        ],
      };
    case "tool-output": {
      const items = state.items.map((item) =>
        item.kind === "tool" && item.id === event.id
          ? { ...item, output: capOutput(item.output + event.chunk) }
          : item,
      );
      return { ...state, items };
    }
    case "tool-result": {
      const items = state.items.map((item) =>
        item.kind === "tool" && item.id === event.id
          ? {
              ...item,
              status: (event.ok ? "ok" : "fail") as ToolStatus,
              exitCode: event.exitCode,
              summary: event.summary,
              artifactPath: event.artifactPath,
              done: true,
            }
          : item,
      );
      return { ...state, items };
    }
    case "tool-blocked": {
      const existing = state.items.find(
        (item) => item.kind === "tool" && item.id === event.id,
      );
      if (existing) {
        const items = state.items.map((item) =>
          item.kind === "tool" && item.id === event.id
            ? {
                ...item,
                status: "blocked" as ToolStatus,
                summary: event.reason,
                done: true,
              }
            : item,
        );
        return { ...state, items };
      }
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "tool",
            id: event.id,
            name: event.name,
            argsDisplay: "",
            output: "",
            status: "blocked",
            summary: event.reason,
            done: true,
          },
        ],
      };
    }
    case "plan-update": {
      const idx = state.items.findIndex(
        (item) => item.kind === "plan" && !item.done,
      );
      if (idx >= 0) {
        const items = [...state.items];
        items[idx] = { ...(items[idx] as PlanItem), plan: event.plan };
        return { ...state, items };
      }
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "plan",
            id: nextId("plan"),
            plan: event.plan,
            done: false,
          },
        ],
      };
    }
    case "confirm-request":
      return {
        ...state,
        pendingConfirm: {
          id: event.id,
          kind: event.kind,
          prompt: event.prompt,
        },
      };
    case "turn-end":
    case "turn-aborted":
    case "turn-error": {
      const items = state.items.map((item) =>
        item.done ? item : { ...item, done: true, streaming: false },
      );
      if (event.type === "turn-aborted") {
        items.push({
          kind: "notice",
          id: nextId("notice"),
          level: "warn",
          text: "Turn aborted.",
          done: true,
        });
      } else if (event.type === "turn-error") {
        items.push({
          kind: "notice",
          id: nextId("notice"),
          level: "warn",
          text: event.message,
          done: true,
        });
      }
      return {
        ...state,
        items,
        thinkingPreview: "",
        pendingConfirm: undefined,
        status: { running: false, activity: "", step: 0, startedAt: undefined },
      };
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const TOOL_OUTPUT_CAP = 8000;
function capOutput(text: string): string {
  if (text.length <= TOOL_OUTPUT_CAP) return text;
  return `…${text.slice(text.length - TOOL_OUTPUT_CAP)}`;
}

const PREVIEW_CAP = 400;
function tailPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ");
  if (collapsed.length <= PREVIEW_CAP) return collapsed;
  return `…${collapsed.slice(collapsed.length - PREVIEW_CAP)}`;
}

/**
 * Split the transcript into a finalized prefix (safe to render once in
 * Ink's <Static>) and a live suffix that may still mutate this turn.
 * The boundary is the first not-yet-done item, which keeps chronological
 * order intact even when later items finalize before earlier ones.
 */
export function splitItems(items: TranscriptItem[]): {
  committed: TranscriptItem[];
  live: TranscriptItem[];
} {
  let boundary = items.length;
  for (let i = 0; i < items.length; i += 1) {
    if (!items[i]!.done) {
      boundary = i;
      break;
    }
  }
  return {
    committed: items.slice(0, boundary),
    live: items.slice(boundary),
  };
}
