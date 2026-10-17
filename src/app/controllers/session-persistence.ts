import type { ChatMessage } from "../../types.js";
import type { PersistedContextUsage } from "../../store/history.js";
import type { PersistedRouteUsage } from "./session-usage-ledger.js";
import { isCompactionMemoryMessage } from "../../agent/context-manager.js";
import {
  toLegacyContextUsage,
  type ContextSnapshotV1,
} from "../../llm/context-snapshot.js";
import type {
  PersistencePort,
  SaveSessionOptions,
} from "../ports/persistence-port.js";

export function hasPersistableHistory(
  messages: readonly ChatMessage[],
): boolean {
  return messages.some(
    (message) => message.role === "user" || isCompactionMemoryMessage(message),
  );
}

let lastWriterEpochMicros = 0;
function mintWriterGeneration(): string {
  const nowMicros = Math.floor((performance.timeOrigin + performance.now()) * 1_000);
  lastWriterEpochMicros = Math.max(nowMicros, lastWriterEpochMicros + 1);
  return `${String(lastWriterEpochMicros).padStart(16, "0")}-${String(process.pid).padStart(8, "0")}-${Math.random().toString(36).slice(2, 10)}`;
}

interface PendingSave {
  messages: readonly ChatMessage[];
  options: SaveSessionOptions;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export class SessionPersistenceQueue {
  private writerGeneration = mintWriterGeneration();
  private revision = 0;
  private readonly pending: PendingSave[] = [];
  private writing = false;

  constructor(private readonly port: PersistencePort) {}

  rebind(_loadedRevision?: number | undefined): void {
    this.writerGeneration = mintWriterGeneration();
    this.revision = 0;
  }

  newSession(): void {
    this.writerGeneration = mintWriterGeneration();
    this.revision = 0;
  }

  save(
    messages: readonly ChatMessage[],
    options: Omit<SaveSessionOptions, "revision">,
  ): Promise<void> {
    const snapshot = messages.map((message) => ({ ...message }));
    const savedOptions: SaveSessionOptions = {
      ...options,
      transcript: options.transcript ? [...options.transcript] : undefined,
      writerGeneration: this.writerGeneration,
      revision: ++this.revision,
    };
    const latest = this.pending.at(-1);
    if (
      options.sessionId !== undefined &&
      latest?.options.sessionId === options.sessionId &&
      latest.options.writerGeneration === this.writerGeneration
    ) {
      latest.messages = snapshot;
      latest.options = { ...savedOptions, name: savedOptions.name ?? latest.options.name };
      return latest.promise;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    this.pending.push({ messages: snapshot, options: savedOptions, promise, resolve, reject });
    void this.drain();
    return promise;
  }

  private async drain(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.pending.length > 0) {
        const next = this.pending.shift()!;
        try {
          await this.port.saveSession(next.messages, next.options);
          next.resolve();
        } catch (error) {
          next.reject(error);
        }
      }
    } finally {
      this.writing = false;
    }
  }
}

export function mintSessionId(): string {
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function pathBackedMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!message.images?.length) return { ...message };
    const images = message.images.flatMap((image) =>
      image.path ? [{ mediaType: image.mediaType, dataBase64: "", path: image.path }] : [],
    );
    const { images: _images, ...rest } = message;
    return images.length > 0 ? { ...rest, images } : rest;
  });
}

export function persistedContextUsage(
  snapshot: ContextSnapshotV1 | undefined,
  routeUsage?: readonly PersistedRouteUsage[] | undefined,
): PersistedContextUsage | undefined {
  const usable = snapshot && snapshot.contextTokens > 0 ? snapshot : undefined;
  const routes = routeUsage && routeUsage.length > 0 ? routeUsage : undefined;
  if (!usable) {
    return routes
      ? { contextTokens: 0, exact: false, routeUsage: routes }
      : undefined;
  }
  return {
    ...toLegacyContextUsage(usable),
    contextSnapshot: usable,
    ...(routes ? { routeUsage: routes } : {}),
  };
}
