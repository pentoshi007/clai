import type { ChatMessage } from "../../types.js";
import type { PersistedContextUsage } from "../../store/history.js";
import {
  toLegacyContextUsage,
  type ContextSnapshotV1,
} from "../../llm/context-snapshot.js";
import type {
  PersistencePort,
  SaveSessionOptions,
} from "../ports/persistence-port.js";

// High-resolution epoch time orders resume ownership; a process-local counter
// makes repeated rebinds monotonic even if the clock reading does not advance.
let lastWriterEpochMicros = 0;
function mintWriterGeneration(): string {
  const nowMicros = Math.floor((performance.timeOrigin + performance.now()) * 1_000);
  lastWriterEpochMicros = Math.max(nowMicros, lastWriterEpochMicros + 1);
  return `${String(lastWriterEpochMicros).padStart(16, "0")}-${String(process.pid).padStart(8, "0")}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Ordered whole-session snapshots shared by every persistence trigger. */
export class SessionPersistenceQueue {
  private writerGeneration = mintWriterGeneration();
  private revision = 0;
  private chain: Promise<void> = Promise.resolve();

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
    // Capture synchronously; queued I/O must never observe later mutations.
    const snapshot = messages.map((message) => ({ ...message }));
    const transcript = options.transcript ? [...options.transcript] : undefined;
    const revision = ++this.revision;
    const writerGeneration = this.writerGeneration;
    const run = this.chain.then(() =>
      this.port.saveSession(snapshot, {
        ...options,
        transcript,
        writerGeneration,
        revision,
      }),
    );
    // Report failure to this caller without poisoning newer queued snapshots.
    this.chain = run.catch(() => undefined);
    return run;
  }
}

export function persistedContextUsage(
  snapshot: ContextSnapshotV1 | undefined,
): PersistedContextUsage | undefined {
  if (!snapshot || snapshot.contextTokens <= 0) return undefined;
  return {
    ...toLegacyContextUsage(snapshot),
    contextSnapshot: snapshot,
  };
}
