import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../../agent/events.js";
import type { ChatMessage } from "../../types.js";
import { isAbortError, type SessionPolicy } from "../../agent/session-policy.js";
import { asTurnId, type AnyAppEvent, type TurnId } from "../events/app-event.js";
import type { EventSequencer } from "../events/sequencer.js";
import type { OutputSpool } from "../events/event-buffer.js";
import { AgentEventAdapter } from "../adapters/agent-event-adapter.js";
import type { AgentPort, RunTurnRequest } from "../ports/agent-port.js";
import type { ConfirmationPort } from "../ports/confirm-port.js";
import type { SecretPort } from "../ports/secret-port.js";
import type { Disposable } from "./disposable.js";

export type TurnResult =
  | { readonly status: "completed"; readonly turnId: TurnId; readonly finalAnswer: string }
  | { readonly status: "aborted"; readonly turnId: TurnId }
  | { readonly status: "error"; readonly turnId: TurnId; readonly error: Error };

export interface TurnRunOptions {
  readonly confirm?: ConfirmationPort | undefined;
  readonly requestSecret?: SecretPort["request"] | undefined;
  readonly session?: SessionPolicy | undefined;
  readonly onMessages?: ((messages: ChatMessage[]) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface TurnControllerDeps {
  readonly agent: AgentPort;
  readonly sequencer: EventSequencer;
  readonly spool: OutputSpool;
  readonly emit: (event: AnyAppEvent) => void;
  readonly mintTurnId?: (() => TurnId) | undefined;
}

/**
 * Coalesces consecutive assistant/thinking deltas and flushes them before any
 * structural event, so the sequencer preserves visible order while emitting far
 * fewer delta events (ARCHITECTURE.md, PERF-002). A kind switch also flushes.
 */
class DeltaCoalescer {
  private assistant = "";
  private thinking = "";

  constructor(private readonly sink: (event: AgentEvent) => void) {}

  push(event: AgentEvent): void {
    if (event.type === "assistant-delta") {
      if (this.thinking) this.flushThinking();
      this.assistant += event.text;
      return;
    }
    if (event.type === "thinking-delta") {
      if (this.assistant) this.flushAssistant();
      this.thinking += event.text;
      return;
    }
    this.flush();
    this.sink(event);
  }

  flush(): void {
    this.flushThinking();
    this.flushAssistant();
  }

  private flushThinking(): void {
    if (!this.thinking) return;
    const text = this.thinking;
    this.thinking = "";
    this.sink({ type: "thinking-delta", text });
  }

  private flushAssistant(): void {
    if (!this.assistant) return;
    const text = this.assistant;
    this.assistant = "";
    this.sink({ type: "assistant-delta", text });
  }
}

const defaultMintTurnId = (): TurnId => asTurnId(`turn-${randomUUID()}`);

/**
 * Owns one turn's execution: mints the turn id, owns the AbortController, wires
 * the agent's events through delta coalescing and the AppEvent adapter, and
 * resolves a discriminated result. Abort is a distinct result, never an error
 * (REL, ARCHITECTURE.md).
 */
export class TurnController implements Disposable {
  private ac: AbortController | undefined;
  private active = false;
  private disposed = false;

  constructor(private readonly deps: TurnControllerDeps) {}

  get running(): boolean {
    return this.active;
  }

  abort(): void {
    this.ac?.abort();
  }

  async run(
    request: RunTurnRequest,
    options: TurnRunOptions = {},
  ): Promise<TurnResult> {
    if (this.disposed) throw new Error("TurnController is disposed");
    if (this.active) throw new Error("a turn is already running");

    const turnId = (this.deps.mintTurnId ?? defaultMintTurnId)();
    const ac = new AbortController();
    this.ac = ac;
    this.active = true;

    const adapter = new AgentEventAdapter(
      this.deps.sequencer,
      this.deps.spool,
      this.deps.emit,
    );
    adapter.setTurn(turnId);
    const coalescer = new DeltaCoalescer((event) => adapter.ingest(event));

    const onExternalAbort = () => ac.abort();
    const external = options.signal;
    if (external) {
      if (external.aborted) ac.abort();
      else external.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const finalAnswer = await this.deps.agent.runTurn(request, {
        onEvent: (event) => coalescer.push(event),
        onMessages: options.onMessages,
        signal: ac.signal,
        confirm: options.confirm,
        requestSecret: options.requestSecret,
        session: options.session,
      });
      coalescer.flush();
      return { status: "completed", turnId, finalAnswer };
    } catch (error) {
      coalescer.flush();
      if (isAbortError(error, ac.signal)) return { status: "aborted", turnId };
      return {
        status: "error",
        turnId,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    } finally {
      if (external) external.removeEventListener("abort", onExternalAbort);
      this.active = false;
      this.ac = undefined;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ac?.abort();
    this.ac = undefined;
    this.active = false;
  }
}
