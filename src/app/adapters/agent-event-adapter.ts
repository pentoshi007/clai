import type { AgentEvent } from "../../agent/events.js";
import {
  asPlanId,
  asToolCallId,
  type AnyAppEvent,
  type AppEventPayloads,
  type AppEventType,
  type TurnId,
} from "../events/app-event.js";
import type { OutputSpool } from "../events/event-buffer.js";
import type { EventSequencer } from "../events/sequencer.js";

const STEP_STATUS = /^step (\d+)$/;

/**
 * Translates the legacy `AgentEvent` stream (the agent's unchanged emitter
 * contract) into versioned `AppEvent` envelopes (V2-021). Pure translation: it
 * mints no side effects beyond appending tool output to the injected spool and
 * emitting envelopes. Given the same input events, id factory, and clock it
 * produces byte-identical output, which the replay contract test relies on.
 */
export class AgentEventAdapter {
  private turnId: TurnId | undefined;

  constructor(
    private readonly sequencer: EventSequencer,
    private readonly spool: OutputSpool,
    private readonly emit: (event: AnyAppEvent) => void,
  ) {}

  /** Bind subsequent events to a turn; pass undefined for session-level events. */
  setTurn(turnId: TurnId | undefined): void {
    this.turnId = turnId;
  }

  ingest(event: AgentEvent): void {
    switch (event.type) {
      case "turn-start":
        this.push("turn-started", { prompt: event.prompt });
        return;
      case "status": {
        const match = STEP_STATUS.exec(event.text);
        this.push("status", {
          text: event.text,
          step: match ? Number(match[1]) : undefined,
        });
        return;
      }
      case "thinking-delta":
        this.push("thinking-delta", { text: event.text });
        return;
      case "thinking-block":
        this.push("thinking-block", {
          messageId: this.sequencer.ids.message(),
          content: event.content,
        });
        return;
      case "assistant-delta":
        this.push("assistant-delta", { text: event.text });
        return;
      case "assistant-message":
        this.push("assistant-message", {
          messageId: this.sequencer.ids.message(),
          text: event.text,
        });
        return;
      case "notice":
        this.push("notice", { level: event.level, text: event.text });
        return;
      case "tool-call":
        this.push("tool-call", {
          toolCallId: this.toolCallId(event.id),
          name: event.name,
          argsDisplay: event.argsDisplay,
        });
        return;
      case "tool-output": {
        const id = this.toolCallId(event.id);
        const ref = event.replace
          ? this.spool.replace(id, event.chunk)
          : this.spool.append(id, event.chunk);
        this.push("tool-output", { ref });
        return;
      }
      case "tool-result":
        this.push("tool-result", {
          toolCallId: this.toolCallId(event.id),
          ok: event.ok,
          exitCode: event.exitCode,
          summary: event.summary,
          artifactPath: event.artifactPath,
        });
        return;
      case "tool-blocked":
        this.push("tool-blocked", {
          toolCallId: this.toolCallId(event.id),
          name: event.name,
          reason: event.reason,
        });
        return;
      case "plan-update":
        this.push("plan-updated", {
          planId: asPlanId(event.plan.sessionId),
          plan: event.plan,
        });
        return;
      case "confirm-request":
        this.push("confirm-requested", {
          requestId: event.id,
          kind: event.kind,
          prompt: event.prompt,
        });
        return;
      case "compacted":
        this.push("compacted", {
          summary: event.summary,
          beforeTokens: event.beforeTokens,
          afterTokens: event.afterTokens,
        });
        return;
      case "turn-end":
        this.push("turn-ended", {
          finalAnswer: event.finalAnswer,
          steps: event.steps,
        });
        return;
      case "turn-aborted":
        this.push("turn-aborted", {});
        return;
      case "turn-error":
        this.push("turn-error", { message: event.message });
        return;
      default: {
        const unreachable: never = event;
        throw new Error(
          `unhandled AgentEvent: ${JSON.stringify(unreachable)}`,
        );
      }
    }
  }

  private push<K extends AppEventType>(
    type: K,
    payload: AppEventPayloads[K],
  ): void {
    // `build` returns a correctly typed AppEvent<K, ...>, but TypeScript cannot
    // prove a generic member is assignable to the distributive `AnyAppEvent`
    // union; the narrowing is sound because K ranges over the same keys.
    this.emit(this.sequencer.build(type, payload, this.turnId) as AnyAppEvent);
  }

  /**
   * Legacy agents restart their display counter at `tool-1` for every turn.
   * It is only locally unique, while the transcript and output spool retain a
   * whole session. Namespace it at the application boundary so tool rows and
   * output stay correlated without ever reusing a semantic document id.
   */
  private toolCallId(sourceId: string) {
    return asToolCallId(this.turnId ? `${this.turnId}:${sourceId}` : sourceId);
  }
}
