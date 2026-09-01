import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../../agent/events.js";
import { renderTurnOutcome, type TurnOutcome } from "../../agent/turn-outcome.js";
import type { ChatMessage, SuccessfulRequestSnapshot } from "../../types.js";
import { isAbortError, type SessionPolicy } from "../../agent/session-policy.js";
import { clearThinking } from "../../ui/thinking.js";
import { asTurnId, type AnyAppEvent, type TurnId } from "../events/app-event.js";
import type { EventSequencer } from "../events/sequencer.js";
import type { OutputSpool } from "../events/event-buffer.js";
import { AgentEventAdapter } from "../adapters/agent-event-adapter.js";
import type { AgentPort, RunTurnRequest } from "../ports/agent-port.js";
import type { ConfirmationPort } from "../ports/confirm-port.js";
import type { SecretPort } from "../ports/secret-port.js";
import type { Disposable } from "./disposable.js";

export type TurnResult =
  | {
      readonly status: "completed";
      readonly turnId: TurnId;
      readonly outcome: TurnOutcome;
      readonly finalAnswer: string;
    }
  | { readonly status: "aborted"; readonly turnId: TurnId }
  | { readonly status: "error"; readonly turnId: TurnId; readonly error: Error };

export interface TurnRunOptions {
  readonly confirm?: ConfirmationPort | undefined;
  readonly requestSecret?: SecretPort["request"] | undefined;
  readonly session?: SessionPolicy | undefined;
  readonly onMessages?: ((messages: ChatMessage[]) => void) | undefined;
  readonly onSuccessfulRequest?:
    | ((snapshot: SuccessfulRequestSnapshot) => void)
    | undefined;
  readonly onStarted?: (() => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface TurnControllerDeps {
  readonly agent: AgentPort;
  readonly sequencer: EventSequencer;
  readonly spool: OutputSpool;
  readonly emit: (event: AnyAppEvent) => void;
  readonly mintTurnId?: (() => TurnId) | undefined;
}

class DeltaCoalescer {
  private pendingToolOutput:
    | {
        id: string;
        chunks: string[];
        replace: boolean;
      }
    | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly sink: (event: AgentEvent) => void,
    private readonly intervalMs = 16,
  ) {}

  push(event: AgentEvent): void {
    if (event.type !== "tool-output") {
      this.flush();
      this.sink(event);
      return;
    }

    const pending = this.pendingToolOutput;
    if (pending && pending.id !== event.id) this.flush();

    if (!this.pendingToolOutput || event.replace) {
      this.pendingToolOutput = {
        id: event.id,
        chunks: [event.chunk],
        replace: event.replace === true,
      };
    } else {
      this.pendingToolOutput.chunks.push(event.chunk);
    }

    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
      this.timer.unref?.();
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const pending = this.pendingToolOutput;
    if (!pending) return;
    this.pendingToolOutput = undefined;
    this.sink({
      type: "tool-output",
      id: pending.id,
      chunk: pending.chunks.join(""),
      ...(pending.replace ? { replace: true } : {}),
    });
  }
}

const defaultMintTurnId = (): TurnId => asTurnId(`turn-${randomUUID()}`);


export class TurnController implements Disposable {
  private ac: AbortController | undefined;
  private active = false;
  private disposed = false;
  private abortReason: string | undefined;

  constructor(private readonly deps: TurnControllerDeps) {}

  get running(): boolean {
    return this.active;
  }

  abort(reason?: string): void {
    this.abortReason = reason;
    this.ac?.abort();
  }

  async run(
    request: RunTurnRequest,
    options: TurnRunOptions = {},
  ): Promise<TurnResult> {
    if (this.disposed) throw new Error("TurnController is disposed");
    if (this.active) throw new Error("a turn is already running");

    const turnId = (this.deps.mintTurnId ?? defaultMintTurnId)();
    clearThinking();
    const ac = new AbortController();
    this.ac = ac;
    this.active = true;
    this.abortReason = undefined;

    const adapter = new AgentEventAdapter(
      this.deps.sequencer,
      this.deps.spool,
      this.deps.emit,
      () => this.abortReason,
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
      options.onStarted?.();
      const outcome = await this.deps.agent.runTurn(request, {
        onEvent: (event) => coalescer.push(event),
        onMessages: options.onMessages,
        onSuccessfulRequest: options.onSuccessfulRequest,
        signal: ac.signal,
        confirm: options.confirm,
        requestSecret: options.requestSecret,
        session: options.session,
      });
      coalescer.flush();
      return {
        status: "completed",
        turnId,
        outcome,
        finalAnswer: renderTurnOutcome(outcome),
      };
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
