/**
 * Cursor-addressed output retention.
 *
 * Cursors address the session's canonical safe byte stream — redacted bytes, not
 * raw child bytes and not a rendered view — so plain and encoded views share one
 * stable source and `nextCursor` stays independent of rendered length.
 *
 * Appends are serialized in callback observation order and never ordered by wall
 * clock. Ingestion deliberately takes no session mutation lock so a chatty child
 * cannot block Close.
 */

import { presentEvents } from "./output-view.js";
import { Notifier, type Unsubscribe } from "./runtime.js";
import { StreamingSecretRedactor, trailingIncompleteUtf8Bytes } from "./streaming-redactor.js";
import {
  sessionError,
  type ArtifactReference,
  type OutputEvent,
  type OutputPage,
  type OutputStream,
  type OutputView,
  type SessionOperation,
  type StableError,
} from "./types.js";

/** Durable sink for canonical redacted bytes. */
export interface OutputSink {
  append(bytes: Uint8Array): boolean;
  waitForDrain(): Promise<void>;
  reference(): ArtifactReference;
  readonly limitReached: boolean;
  readonly failed: boolean;
}

export interface OutputStoreOptions {
  readonly memoryWindowBytes: number;
  readonly pageBytes: number;
  readonly redactionOverlapBytes: number;
  readonly sink: OutputSink;
  readonly onPause?: (() => void) | undefined;
  readonly onResume?: (() => void) | undefined;
  readonly onPersistenceStop?: ((reason: "output-limit" | "persist-failed") => void) | undefined;
}

export interface PageOptions {
  readonly cursor: number;
  readonly view: OutputView;
  readonly maxBytes?: number | undefined;
  readonly operation: SessionOperation;
  readonly sessionId: string;
}

export type PageOutcome =
  | { readonly ok: true; readonly page: OutputPage }
  | { readonly ok: false; readonly error: StableError; readonly page: OutputPage };

export class OutputStore {
  private readonly events: OutputEvent[] = [];
  private readonly redactors = new Map<OutputStream, StreamingSecretRedactor>();
  private readonly notifier = new Notifier();
  private retainedBytes = 0;
  private earliest = 0;
  private latest = 0;
  private omittedBytes = 0;
  private paused = false;
  private closed = false;

  constructor(private readonly options: OutputStoreOptions) {}

  get earliestCursor(): number {
    return this.earliest;
  }

  get latestCursor(): number {
    return this.latest;
  }

  get generation(): number {
    return this.notifier.current;
  }

  get artifact(): ArtifactReference {
    return this.options.sink.reference();
  }

  registerExactSecret(value: string): void {
    for (const stream of ["terminal", "stdout", "stderr"] as OutputStream[]) {
      this.redactorFor(stream).registerExactSecret(value);
    }
  }

  subscribe(listener: (generation: number) => void): Unsubscribe {
    return this.notifier.subscribe(listener);
  }

  private redactorFor(stream: OutputStream): StreamingSecretRedactor {
    let redactor = this.redactors.get(stream);
    if (!redactor) {
      redactor = new StreamingSecretRedactor(this.options.redactionOverlapBytes);
      this.redactors.set(stream, redactor);
    }
    return redactor;
  }

  /** Ingest raw transport bytes. Redaction happens before cursor assignment. */
  ingest(stream: OutputStream, raw: Uint8Array, observedAt: number): void {
    if (this.closed) return;
    const safe = this.redactorFor(stream).push(raw);
    this.commit(stream, safe, observedAt);
  }

  /** Flush retained redaction overlap; called once during finalization. */
  finish(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const [stream, redactor] of this.redactors) {
      this.commit(stream, redactor.close(), now);
    }
    this.closed = true;
  }

  private commit(stream: OutputStream, bytes: Uint8Array, observedAt: number): void {
    if (bytes.length === 0) return;
    const startCursor = this.latest;
    this.latest += bytes.length;
    this.events.push({
      startCursor,
      endCursor: this.latest,
      stream,
      observedAt,
      bytes,
    });
    this.retainedBytes += bytes.length;
    if (this.events.length === 1 && startCursor === 0) this.earliest = 0;
    this.evict();
    this.persist(bytes);
    this.notifier.bump();
  }

  private evict(): void {
    while (
      this.retainedBytes > this.options.memoryWindowBytes &&
      this.events.length > 0
    ) {
      const oldest = this.events[0]!;
      const overflow = this.retainedBytes - this.options.memoryWindowBytes;
      const size = oldest.bytes.length;
      if (size <= overflow) {
        this.events.shift();
        this.retainedBytes -= size;
        this.earliest = oldest.endCursor;
        this.omittedBytes += size;
        continue;
      }
      const drop = overflow;
      this.events[0] = {
        ...oldest,
        startCursor: oldest.startCursor + drop,
        bytes: oldest.bytes.subarray(drop),
      };
      this.retainedBytes -= drop;
      this.earliest = oldest.startCursor + drop;
      this.omittedBytes += drop;
    }
  }

  private persist(bytes: Uint8Array): void {
    const sink = this.options.sink;
    const writable = sink.append(bytes);
    if (sink.failed) {
      this.options.onPersistenceStop?.("persist-failed");
      return;
    }
    if (sink.limitReached) {
      this.options.onPersistenceStop?.("output-limit");
      return;
    }
    if (writable || this.paused) return;
    this.paused = true;
    this.options.onPause?.();
    void sink.waitForDrain().then(() => {
      this.paused = false;
      this.options.onResume?.();
    });
  }

  page(options: PageOptions): PageOutcome {
    const limit = Math.max(1, options.maxBytes ?? this.options.pageBytes);
    const requested = options.cursor;
    if (requested < this.earliest) {
      const omitted = this.earliest - requested;
      const gapPage = this.buildPage([], requested, requested, options.view, false, omitted);
      return {
        ok: false,
        page: gapPage,
        error: sessionError({
          code: "OUTPUT_GAP",
          operation: options.operation,
          sessionId: options.sessionId,
          message:
            "Requested output has been evicted from the retention window; read from earliestAvailableCursor or the artifact.",
          details: {
            requestedCursor: requested,
            earliestAvailableCursor: this.earliest,
            omittedBytes: omitted,
            artifactPath: this.artifact.path,
          },
        }),
      };
    }
    if (requested > this.latest) {
      return {
        ok: false,
        page: this.buildPage([], requested, requested, options.view, false),
        error: sessionError({
          code: "INVALID_REQUEST",
          operation: options.operation,
          sessionId: options.sessionId,
          message: "Requested cursor is beyond the latest observed output byte.",
          details: { requestedCursor: requested, latestCursor: this.latest },
        }),
      };
    }

    const selected: OutputEvent[] = [];
    let cursor = requested;
    let budget = limit;
    for (const event of this.events) {
      if (event.endCursor <= cursor) continue;
      if (budget <= 0) break;
      const offset = Math.max(0, cursor - event.startCursor);
      let slice = event.bytes.subarray(offset, offset + budget);
      if (slice.length === 0) continue;
      const truncated = offset + slice.length < event.bytes.length;
      if (truncated && options.view === "plain") {
        const incomplete = trailingIncompleteUtf8Bytes(slice);
        if (incomplete > 0 && slice.length > incomplete) {
          slice = slice.subarray(0, slice.length - incomplete);
        }
      }
      if (slice.length === 0) break;
      selected.push({
        startCursor: cursor,
        endCursor: cursor + slice.length,
        stream: event.stream,
        observedAt: event.observedAt,
        bytes: slice,
      });
      cursor += slice.length;
      budget -= slice.length;
    }
    const hasMore = cursor < this.latest;
    return { ok: true, page: this.buildPage(selected, requested, cursor, options.view, hasMore) };
  }

  private buildPage(
    events: readonly OutputEvent[],
    requestedCursor: number,
    nextCursor: number,
    view: OutputView,
    hasMore: boolean,
    omittedBytes?: number,
  ): OutputPage {
    const presented = presentEvents(events, view);
    return {
      events: presented.events,
      requestedCursor,
      nextCursor,
      hasMore,
      earliestAvailableCursor: this.earliest,
      latestCursor: this.latest,
      view,
      decodingLoss: presented.decodingLoss,
      ...(omittedBytes !== undefined && omittedBytes > 0
        ? { omittedBytes }
        : this.omittedBytes > 0
          ? { omittedBytes: this.omittedBytes }
          : {}),
      artifact: this.artifact,
    };
  }

  dispose(): void {
    this.finish();
    this.notifier.clear();
    this.events.length = 0;
    this.retainedBytes = 0;
  }
}
