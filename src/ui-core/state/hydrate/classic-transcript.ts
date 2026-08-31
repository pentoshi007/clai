import { shouldHideQuietMetaToolInChat } from "../../../app/adapters/quiet-meta-tools.js";
import { asToolCallId } from "../../../app/events/app-event.js";
import type { ToolCallId } from "../../../app/events/app-event.js";
import type { TranscriptItem as ClassicTranscriptItem } from "../../../app/ports/transcript-item.js";
import { EMPTY_TRANSCRIPT_STATE } from "../transcript-types.js";
import type { AssistantItem, CompactedItem, ThinkingItem, ToolItem, ToolStatus, TranscriptItem, TranscriptState, TurnSummaryItem, UserItem } from "../transcript-types.js";

export interface HydrateResult {
  readonly state: TranscriptState;
  /** Tool outputs to seed into OutputSpool (classic embeds output on the item). */
  readonly toolOutputs: ReadonlyMap<ToolCallId, string>;
}

function mapToolStatus(status: string | undefined): ToolStatus {
  if (
    status === "ok" ||
    status === "running" ||
    status === "blocked" ||
    status === "queued"
  ) {
    return status;
  }
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
        const startedAt =
          typeof raw.startedAt === "number" && Number.isFinite(raw.startedAt)
            ? raw.startedAt
            : undefined;
        const endedAt =
          typeof raw.endedAt === "number" && Number.isFinite(raw.endedAt)
            ? raw.endedAt
            : undefined;
        const item: ThinkingItem = {
          ...base,
          ...(startedAt !== undefined ? { timestamp: startedAt, startedAt } : {}),
          kind: "thinking",
          content: raw.content ?? "",
          streaming: false,
          ...(endedAt !== undefined ? { endedAt } : {}),
        };
        byId.set(id, item);
        order.push(id);
        break;
      }
      case "tool": {
        const toolCallId = asToolCallId(id);
        const status = mapToolStatus(raw.status);
        const name = raw.name ?? "tool";
        const chatStatus = status === "running" ? "ok" : status;
        // Successful plan/task meta tools are Tasks-pane only (not chat).
        if (shouldHideQuietMetaToolInChat(name, chatStatus)) break;
        const output = typeof raw.output === "string" ? raw.output : "";
        if (output) toolOutputs.set(toolCallId, output);
        const rawChanges = (raw as { fileChanges?: unknown }).fileChanges;
        const rawStamp = (raw as { timestamp?: unknown }).timestamp;
        const rawEnded = (raw as { endedAt?: unknown }).endedAt;
        const rawDur = (raw as { durationMs?: unknown }).durationMs;
        const restoredTimestamp =
          typeof rawStamp === "number" && Number.isFinite(rawStamp) ? rawStamp : base.timestamp;
        let restoredEndedAt: number | undefined;
        if (typeof rawEnded === "number" && Number.isFinite(rawEnded)) restoredEndedAt = rawEnded;
        else if (typeof rawDur === "number" && Number.isFinite(rawDur)) restoredEndedAt = restoredTimestamp + Math.max(0, rawDur);
        const item: ToolItem = {
          ...base,
          timestamp: restoredTimestamp,
          kind: "tool",
          toolCallId,
          name,
          argsDisplay: raw.argsDisplay ?? "",
          status: chatStatus,
          exitCode: raw.exitCode,
          summary: raw.summary,
          artifactPath: raw.artifactPath,
          reason: undefined,
          outputBytes: Buffer.byteLength(output, "utf8"),
          fileChanges: Array.isArray(rawChanges)
            ? (rawChanges as ToolItem["fileChanges"])
            : undefined,
          ...(restoredEndedAt !== undefined ? { endedAt: restoredEndedAt } : {}),
        };
        byId.set(id, item);
        order.push(id);
        break;
      }
      case "notice":
        // Ephemeral UI chrome only — never rehydrate into the conversation
        // (would inflate item counts and reappear after every /history).
        break;
      case "compacted": {
        const startedAt =
          typeof raw.startedAt === "number" && Number.isFinite(raw.startedAt)
            ? raw.startedAt
            : undefined;
        const endedAt =
          typeof raw.endedAt === "number" && Number.isFinite(raw.endedAt)
            ? raw.endedAt
            : undefined;
        const item: CompactedItem = {
          ...base,
          ...(startedAt !== undefined ? { timestamp: startedAt, startedAt } : {}),
          kind: "compacted",
          summary: raw.summary ?? "Compacted context",
          beforeTokens: raw.beforeTokens ?? 0,
          afterTokens: raw.afterTokens ?? raw.beforeTokens ?? 0,
          ...(raw.error ? { error: raw.error } : {}),
          ...(endedAt !== undefined ? { endedAt } : {}),
        };
        byId.set(id, item);
        order.push(id);
        break;
      }
      case "turn-summary": {
        const rawStamp = raw.timestamp;
        const rawDur = raw.durationMs;
        const item: TurnSummaryItem = {
          ...base,
          ...(typeof rawStamp === "number" && Number.isFinite(rawStamp)
            ? { timestamp: rawStamp }
            : {}),
          kind: "turn-summary",
          durationMs:
            typeof rawDur === "number" && Number.isFinite(rawDur) ? rawDur : 0,
          status:
            raw.status === "aborted" || raw.status === "error"
              ? raw.status
              : "completed",
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
