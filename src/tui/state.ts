import type { AgentEvent } from "../agent/events.js";
import type { SessionPlan } from "../store/plan.js";
import type { ChatMessage } from "../types.js";

// Transcript items

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

export interface CompactedItem {
  kind: "compacted";
  id: string;
  summary: string;
  originalItems: TranscriptItem[];
  done: boolean;
}

export type TranscriptItem =
  | UserItem
  | AssistantItem
  | ThinkingItem
  | ToolItem
  | NoticeItem
  | PlanItem
  | CompactedItem;

const MAX_COMPACTION_FIELD_CHARS = 12_000;

function compactField(value: string): string {
  if (value.length <= MAX_COMPACTION_FIELD_CHARS) return value;
  return `${value.slice(0, MAX_COMPACTION_FIELD_CHARS)}\n…[truncated; full output remains in the session transcript/artifact]`;
}

/** Plain, detailed session record used as source material for model compaction. */
export function serializeTranscriptForCompaction(items: TranscriptItem[]): string {
  const lastCompactedIndex = items.map((i) => i.kind).lastIndexOf("compacted");
  const itemsToSerialize =
    lastCompactedIndex !== -1 ? items.slice(lastCompactedIndex) : items;

  return itemsToSerialize
    .map((item): string | undefined => {
      switch (item.kind) {
      case "user":
        return `USER INTENT/PROMPT:\n${compactField(item.text)}`;
      case "assistant":
        return `ASSISTANT RESPONSE:\n${compactField(item.text)}`;
      case "thinking":
        // Skip thinking/reasoning — it inflates the summary without
        // adding useful continuation context.
        return undefined;
      case "tool":
        return [
          `TOOL/COMMAND: ${item.name}`,
          `INPUT: ${compactField(item.argsDisplay)}`,
          `STATUS: ${item.status}${typeof item.exitCode === "number" ? ` (exit ${item.exitCode})` : ""}`,
          item.summary ? `RESULT SUMMARY: ${compactField(item.summary)}` : "",
          `OUTPUT/RESULT:\n${compactField(item.output)}`,
          item.artifactPath ? `FULL ARTIFACT: ${item.artifactPath}` : "",
        ].filter(Boolean).join("\n");
      case "notice":
        return `SESSION EVENT (${item.level}): ${compactField(item.text)}`;
      case "plan":
        return `PLAN/TASK STATE:\n${compactField(JSON.stringify(item.plan, null, 2))}`;
      case "compacted":
        return `COMPACTED CONTEXT:\n${compactField(item.summary)}`;
    }
  }).filter(Boolean).join("\n\n---\n\n");
}

// Confirm requests

export interface PendingConfirm {
  id: string;
  kind: "tool" | "pentest" | "reset" | "continue" | "plan" | "switch";
  prompt: string;
}

// App state

export interface TurnStatus {
  running: boolean;
  activity: string;
  step: number;
  startedAt: number | undefined;
}

export interface TuiState {
  items: TranscriptItem[];
  /** Transient assistant text streamed for the current step (not yet committed). */
  streaming: string;
  status: TurnStatus;
  thinkingPreview: string;
  thinkingExpanded: boolean;
  outputExpanded: boolean;
  pendingConfirm: PendingConfirm | undefined;
  queued: string[];
}

export function initialState(): TuiState {
  return {
    items: [],
    streaming: "",
    status: { running: false, activity: "", step: 0, startedAt: undefined },
    thinkingPreview: "",
    thinkingExpanded: false,
    outputExpanded: false,
    pendingConfirm: undefined,
    queued: [],
  };
}

// Actions

export type TuiAction =
  | { type: "event"; event: AgentEvent }
  | { type: "submit"; text: string }
  | { type: "queue"; text: string }
  | { type: "dequeue" }
  | { type: "notice"; level: "info" | "warn"; text: string }
  | { type: "toggle-thinking" }
  | { type: "toggle-output" }
  | { type: "confirm-resolved" }
  | { type: "load-history"; messages: ChatMessage[]; transcript?: TranscriptItem[] | undefined }
  | { type: "compacted"; summary: string; keepRecent: number }
  | { type: "reset" };

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

// Reducer

export function reducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "reset":
      return initialState();
    case "toggle-thinking":
      return { ...state, thinkingExpanded: !state.thinkingExpanded };
    case "toggle-output":
      return { ...state, outputExpanded: !state.outputExpanded };
    case "compacted": {
      // Append a compacted context block to the existing visual history.
      // The model's context has already been replaced with the summary
      // (in the runner); the visual side keeps all items so the user can
      // still scroll through past messages.
      const compactedItem: CompactedItem = {
        kind: "compacted",
        id: nextId("compacted"),
        summary: action.summary,
        originalItems: [],
        done: true,
      };
      
      return {
        ...state,
        items: [...state.items, compactedItem],
      };
    }
    case "queue":
      return { ...state, queued: [...state.queued, action.text] };
    case "dequeue": {
      const [, ...rest] = state.queued;
      return { ...state, queued: rest };
    }
    case "confirm-resolved":
      return { ...state, pendingConfirm: undefined };
    case "load-history": {
      if (action.transcript?.length) {
        return {
          ...initialState(),
          items: action.transcript.map((item) => ({ ...item, done: true })),
        };
      }
      const items = action.messages.flatMap<TranscriptItem>((message) => {
        if (message.role === "user") {
          return [{ kind: "user" as const, id: nextId("history-user"), text: message.content, done: true }];
        }
        if (message.role === "assistant") {
          return [{ kind: "assistant" as const, id: nextId("history-asst"), text: message.content, streaming: false, done: true }];
        }
        return [];
      });
      return { ...initialState(), items };
    }
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
        streaming: "",
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
    case "assistant-delta":
      // Buffer transient streaming text. It is NOT committed as a transcript
      // item until `assistant-message`, and is discarded on `tool-call` (the
      // tokens were a tool-call fence, not prose) so raw JSON never lingers.
      return {
        ...state,
        status: { ...state.status, activity: "responding" },
        streaming: state.streaming + event.text,
      };
    case "assistant-message": {
      const text = event.text.trim();
      if (!text) {
        return { ...state, streaming: "" };
      }
      return {
        ...state,
        streaming: "",
        thinkingPreview: "",
        items: [
          ...state.items,
          {
            kind: "assistant",
            id: nextId("asst"),
            text,
            streaming: false,
            done: true,
          },
        ],
      };
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
      // A real tool call supersedes any streamed tool-call fence text.
      return {
        ...state,
        streaming: "",
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
        streaming: "",
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
    case "compacted": {
      // The runner emits this after replacing the model context with a
      // summary. App.tsx normally intercepts it and dispatches the richer
      // `compacted` TuiAction (with keepRecent); this branch keeps the
      // reducer exhaustive and provides sensible default behavior: append a
      // compacted-context block while preserving the scrollable history.
      const compactedItem: CompactedItem = {
        kind: "compacted",
        id: nextId("compacted"),
        summary: event.summary,
        originalItems: [],
        done: true,
      };
      return {
        ...state,
        streaming: "",
        thinkingPreview: "",
        items: [...state.items, compactedItem],
      };
    }
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
        streaming: "",
        thinkingPreview: "",
        pendingConfirm: undefined,
        status: { running: false, activity: "", step: 0, startedAt: undefined },
      };
    }
  }
}

// Helpers

const TOOL_OUTPUT_CAP = 20000;
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
