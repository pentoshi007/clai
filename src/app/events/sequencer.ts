import { randomUUID } from "node:crypto";
import {
  APP_EVENT_VERSION,
  asMessageId,
  type AppEvent,
  type AppEventPayloads,
  type AppEventType,
  type MessageId,
  type SessionId,
  type TurnId,
} from "./app-event.js";

/** Injectable time source so replay tests are deterministic. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/**
 * Mints envelope ids and domain ids that lack a natural stable id (assistant
 * messages, thinking blocks). Tool-call ids come from the agent and are reused
 * verbatim. Injectable so tests can assert deterministic replay output.
 */
export interface IdFactory {
  event(): string;
  message(): MessageId;
}

export function createCountingIdFactory(prefix = ""): IdFactory {
  let events = 0;
  let messages = 0;
  return {
    event: () => `${prefix}evt-${(++events).toString(36)}`,
    message: () => asMessageId(`${prefix}msg-${(++messages).toString(36)}`),
  };
}

export function createRandomIdFactory(): IdFactory {
  return {
    event: () => randomUUID(),
    message: () => asMessageId(randomUUID()),
  };
}

/**
 * Assigns a monotonic, gap-free `sequence` per session and wraps a typed
 * payload in the `AppEvent` envelope. One sequencer instance owns one session.
 */
export class EventSequencer {
  private seq = 0;
  private sessionId: SessionId;

  constructor(
    sessionId: SessionId,
    readonly ids: IdFactory = createRandomIdFactory(),
    private readonly clock: Clock = systemClock,
  ) {
    this.sessionId = sessionId;
  }

  get current(): number {
    return this.seq;
  }

  /** Start a fresh sequence (e.g. after /new remints the session id). */
  rebind(sessionId: SessionId): void {
    this.sessionId = sessionId;
    this.seq = 0;
  }

  build<K extends AppEventType>(
    type: K,
    payload: AppEventPayloads[K],
    turnId?: TurnId | undefined,
  ): AppEvent<K, AppEventPayloads[K]> {
    this.seq += 1;
    const base = {
      id: this.ids.event(),
      version: APP_EVENT_VERSION,
      sequence: this.seq,
      sessionId: this.sessionId,
      timestamp: this.clock.now(),
      type,
      payload,
    };
    const event = turnId === undefined ? base : { ...base, turnId };
    return event as AppEvent<K, AppEventPayloads[K]>;
  }
}
