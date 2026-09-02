import { redactSecrets } from "../../llm/provider.js";
import type { JobArtifactReceipt } from "../jobs.js";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const PER_FILE_BYTES = 1024 * 1024;

const MAX_STREAM_BYTES = 16 * 1024 * 1024;

export class RotatingRedactedWriter {
  private stream: WriteStream | undefined;
  private streamDone: Promise<void> | undefined;
  private readonly completedStreams: Promise<void>[] = [];
  private index = 0;
  private currentBytes = 0;
  private hash = createHash("sha256");
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private closePromise: Promise<void> | undefined;
  private writeError: Error | undefined;
  private closed = false;
  private acceptedBytes: number;
  private readonly backpressuredStreams = new Set<WriteStream>();
  private static readonly REDACTION_OVERLAP_CHARS = 4096;

  constructor(private readonly receipt: JobArtifactReceipt) {
    this.acceptedBytes = receipt.bytes;
  }

  append(raw: Buffer | string): boolean {
    if (this.closed) throw new Error("Cannot append to a closed job artifact");
    this.pending += Buffer.isBuffer(raw) ? this.decoder.write(raw) : raw;
    let writable = true;
    const lastNewline = this.pending.lastIndexOf("\n");
    if (lastNewline >= 0) {
      writable = this.writeRedacted(this.pending.slice(0, lastNewline + 1));
      this.pending = this.pending.slice(lastNewline + 1);
    }
    if (this.pending.length <= RotatingRedactedWriter.REDACTION_OVERLAP_CHARS) {
      return writable;
    }
    const flushLength = this.pending.length - RotatingRedactedWriter.REDACTION_OVERLAP_CHARS;
    writable = this.writeRedacted(this.pending.slice(0, flushLength)) && writable;
    this.pending = this.pending.slice(flushLength);
    return writable;
  }

  waitForDrain(): Promise<void> {
    const blocked = [...this.backpressuredStreams].filter(
      (stream) => stream.writableNeedDrain,
    );
    if (blocked.length === 0) return Promise.resolve();
    return Promise.all(
      blocked.map(
        (stream) =>
          new Promise<void>((resolve) => {
            const done = (): void => {
              stream.off("drain", done);
              stream.off("finish", done);
              stream.off("error", done);
              this.backpressuredStreams.delete(stream);
              resolve();
            };
            stream.once("drain", done);
            stream.once("finish", done);
            stream.once("error", done);
          }),
      ),
    ).then(() => undefined);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.pending += this.decoder.end();
    if (this.pending) this.writeRedacted(this.pending);
    this.pending = "";
    this.closed = true;
    this.finishCurrentStream();
    this.closePromise = Promise.all(this.completedStreams).then(() => {
      if (this.writeError) throw this.writeError;
    });
    return this.closePromise;
  }

  private writeRedacted(source: string): boolean {
    const safe = redactSecrets(source);
    if (safe !== source) this.receipt.redacted = true;
    let data = Buffer.from(safe, "utf8");
    const remaining = Math.max(0, MAX_STREAM_BYTES - this.acceptedBytes);
    if (data.length > remaining) {
      this.receipt.droppedBytes += data.length - remaining;
      data = data.subarray(0, remaining);
    }
    this.acceptedBytes += data.length;
    let writable = true;
    while (data.length > 0) {
      if (!this.stream || this.currentBytes >= PER_FILE_BYTES) this.rotate();
      const room = PER_FILE_BYTES - this.currentBytes;
      const part = data.subarray(0, room);
      const stream = this.stream!;
      const accepted = stream.write(part);
      if (!accepted) this.backpressuredStreams.add(stream);
      writable = accepted && writable;
      this.hash.update(part);
      this.receipt.bytes += part.length;
      this.receipt.sha256 = this.hash.copy().digest("hex");
      this.currentBytes += part.length;
      data = data.subarray(part.length);
    }
    return writable;
  }

  private finishCurrentStream(): void {
    if (!this.stream || !this.streamDone) return;
    const stream = this.stream;
    const done = this.streamDone;
    this.stream = undefined;
    this.streamDone = undefined;
    stream.end();
    this.completedStreams.push(done);
  }

  private rotate(): void {
    this.finishCurrentStream();
    const path = this.index === 0 ? this.receipt.path : `${this.receipt.path}.${this.index}`;
    this.index += 1;
    this.currentBytes = 0;
    this.receipt.chunks.push(path);
    const stream = createWriteStream(path, { flags: "w", mode: 0o600 });
    this.stream = stream;
    this.streamDone = new Promise<void>((resolve) => {
      stream.once("finish", resolve);
      stream.once("error", (error) => {
        this.writeError ??= error;
        resolve();
      });
    });
  }
}
