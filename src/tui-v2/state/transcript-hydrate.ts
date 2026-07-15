/**
 * Resume helpers: classic/history TranscriptItem + ChatMessage → v2 store shape.
 *
 * History records may carry a full TUI transcript (classic clai) or only the
 * model messages array (older / partial saves). We hydrate both so /history
 * restores prompts, tools, and assistant text — not just a notice.
 */

import type { ChatMessage } from "../../types.js";
import type { TranscriptItem as ClassicTranscriptItem } from "../../tui/state.js";
import { asToolCallId, type ToolCallId } from "../../app/events/app-event.js";
import {
  EMPTY_TRANSCRIPT_STATE,
  type AssistantItem,
  type CompactedItem,
  type NoticeItem,
  type ThinkingItem,
  type ToolItem,
  type ToolStatus,
  type TranscriptItem,
  type TranscriptState,
  type UserItem,
} from "./transcript-types.js";

export interface HydrateResult {
  readonly state: TranscriptState;
  /** Tool outputs to seed into OutputSpool (classic embeds output on the item). */
  readonly toolOutputs: ReadonlyMap<ToolCallId, string>;
}

function mapToolStatus(status: string | undefined): ToolStatus {
  if (status === "ok" || status === "running" || status === "blocked") return status;
  if (status === "fail" || status === "failed") return "failed";
  return "ok";
}

/** Convert a classic (or mixed) saved transcript into the v2 normalized state. */
export function hydrateFromClassicTranscript(
  items: readonly ClassicTranscriptItem[],
): HydrateResult {
  const order: string[] = [];
  const byId = new Map<string, TranscriptItem>();
  const toolOutputs = new Map<ToolCallId, string>();
  let sequence = 0;

  for (const raw of items) {
    sequence += 1;
    const id = raw.id || `hist-${sequence}`;
    const base = {
      id,
      sequence,
      turnId: undefined as undefined,
      timestamp: sequence,
    };

    switch (raw.kind) {
      case "user": {
        const item: UserItem = { ...base, kind: "user", text: raw.text ?? "" };
        byId.set(id, item);
        order.push(id);
        break;
      }
      case "assistant": {
        const item: AssistantItem = {
          ...base,
          kind: "assistant",
          text: raw.text ?? "",
          streaming: false,
        };
        byId.set(id, item);
        order.push(id);
        break;
      }
      case "thinking": {
        const item: ThinkingItem = {
          ...base,
          kind: "thinking",
          content: raw.content ?? "",
          streaming: false,
        };
        byId.set(id, item);
        order.push(id);
        break;
      }
      case "tool": {
        const toolCallId = asToolCallId(id);
        const status = mapToolStatus(raw.status);
        const output = typeof raw.output === "string" ? raw.output : "";
        if (output) toolOutputs.set(toolCallId, output);
        const item: ToolItem = {
          ...base,
          kind: "tool",
          toolCallId,
          name: raw.name ?? "tool",
          argsDisplay: raw.argsDisplay ?? "",
          status: status === "running" ? "ok" : status,
          exitCode: raw.exitCode,
          summary: raw.summary,
          artifactPath: raw.artifactPath,
          reason: undefined,
          outputBytes: Buffer.byteLength(output, "utf8"),
        };
        byId.set(id, item);
        order.push(id);
        break;
      }
      case "notice": {
        const item: NoticeItem = {
          ...base,
          kind: "notice",
          level: raw.level === "warn" ? "warn" : "info",
          text: raw.text ?? "",
        };
        byId.set(id, item);
        order.push(id);
        break;
      }
      case "compacted": {
        const item: CompactedItem = {
          ...base,
          kind: "compacted",
          summary: raw.summary ?? "Compacted context",
          beforeTokens: 0,
          afterTokens: 0,
        };
        byId.set(id, item);
        order.push(id);
        break;
      }
      case "plan":
        // Plans restore via plan store / Ctrl+H — skip visual plan rows.
        break;
      default:
        break;
    }
  }

  if (order.length === 0) {
    return { state: EMPTY_TRANSCRIPT_STATE, toolOutputs };
  }

  return {
    state: {
      ...EMPTY_TRANSCRIPT_STATE,
      order,
      byId,
      // Historical item.sequence is display metadata only. lastSequence must
      // stay 0 so the live EventSequencer (rebound to 0 on loadHistory) can
      // apply turn-started and the rest of the next turn — otherwise every
      // event with seq <= N is dropped and the new user prompt never appears.
      lastSequence: 0,
    },
    toolOutputs,
  };
}

/** Fallback when a history row only has model messages (no visual transcript). */
export function hydrateFromMessages(messages: readonly ChatMessage[]): HydrateResult {
  const order: string[] = [];
  const byId = new Map<string, TranscriptItem>();
  let sequence = 0;

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    // Skip pure session-memory system-style content if it landed as assistant.
    if (message.role === "assistant" && !message.content.trim()) continue;
    sequence += 1;
    const id =
      message.role === "user" ? `hist-user-${sequence}` : `hist-asst-${sequence}`;
    if (message.role === "user") {
      const item: UserItem = {
        id,
        sequence,
        turnId: undefined,
        timestamp: sequence,
        kind: "user",
        text: message.content,
      };
      byId.set(id, item);
      order.push(id);
    } else {
      const item: AssistantItem = {
        id,
        sequence,
        turnId: undefined,
        timestamp: sequence,
        kind: "assistant",
        text: message.content,
        streaming: false,
      };
      byId.set(id, item);
      order.push(id);
    }
  }

  return {
    state: {
      ...EMPTY_TRANSCRIPT_STATE,
      order,
      byId,
      // See hydrateFromClassicTranscript — do not block the live sequencer.
      lastSequence: 0,
    },
    toolOutputs: new Map(),
  };
}

/**
 * Snapshot the live v2 transcript into the classic shape for history.db so
 * /history can restore tools + prompts next time (parity with classic clai).
 */
export function serializeForHistory(
  state: TranscriptState,
  toolOutput: (toolCallId: ToolCallId) => string,
): ClassicTranscriptItem[] {
  const out: ClassicTranscriptItem[] = [];
  for (const id of state.order) {
    const item = state.byId.get(id);
    if (!item) continue;
    switch (item.kind) {
      case "user":
        out.push({ kind: "user", id: item.id, text: item.text, done: true });
        break;
      case "assistant":
        out.push({
          kind: "assistant",
          id: item.id,
          text: item.text,
          streaming: false,
          done: true,
        });
        break;
      case "thinking":
        out.push({
          kind: "thinking",
          id: item.id,
          content: item.content,
          done: true,
        });
        break;
      case "tool": {
        const output = toolOutput(item.toolCallId);
        out.push({
          kind: "tool",
          id: item.id,
          name: item.name,
          argsDisplay: item.argsDisplay,
          output,
          status:
            item.status === "failed"
              ? "fail"
              : item.status === "running"
                ? "ok"
                : item.status,
          exitCode: item.exitCode,
          summary: item.summary,
          artifactPath: item.artifactPath,
          done: true,
        });
        break;
      }
      case "notice":
        out.push({
          kind: "notice",
          id: item.id,
          level: item.level === "error" ? "warn" : item.level,
          text: item.text,
          done: true,
        });
        break;
      case "compacted":
        out.push({
          kind: "compacted",
          id: item.id,
          summary: item.summary,
          originalItems: [],
          done: true,
        });
        break;
      default:
        break;
    }
  }
  return out;
}

/** Strip the model framing prefix for display in the compacted card. */
export function displayCompactSummary(summary: string): string {
  const prefixes = [
    "Session memory from compacted earlier turns:\n\n",
    "Session memory from compacted earlier turns:",
    "Session memory\n\n",
  ];
  let text = summary;
  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length);
      break;
    }
  }
  return text.trim();
}
