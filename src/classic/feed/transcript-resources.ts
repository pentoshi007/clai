import { open } from "node:fs/promises";
import type { ToolCallId } from "../../app/events/app-event.js";
import type { BoundedTextState } from "../../app/events/event-buffer.js";
import type { FileChange } from "../../tools/file-diff.js";
import { isItemExpanded, type TranscriptState } from "../../ui-core/state/transcript-types.js";
import type { SpoolReader } from "../blocks/block-context.js";

const INLINE_BYTES = 32 * 1024 * 1024;
const PREVIEW_BYTES = 64 * 1024;

interface SavedText {
  readonly text: string;
  readonly complete: boolean;
}

interface Resource {
  readonly signature: string;
  readonly full: boolean;
  readonly result: Promise<void>;
  readonly controller: AbortController;
  value?: SavedText;
  error?: string;
  revision?: number;
}

async function savedText(path: string, full: boolean, signal: AbortSignal): Promise<SavedText> {
  signal.throwIfAborted();
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("not a file");
    const limit = full && info.size <= INLINE_BYTES ? info.size : Math.min(info.size, PREVIEW_BYTES);
    const bytes = Buffer.alloc(limit);
    let offset = 0;
    while (offset < limit) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(bytes, offset, Math.min(limit - offset, PREVIEW_BYTES), offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { text: bytes.subarray(0, offset).toString("utf8"), complete: offset >= info.size };
  } finally { await file.close(); }
}

export class TranscriptResources implements SpoolReader {
  private readonly outputs = new Map<ToolCallId, Resource>();
  private readonly changes = new Map<string, Resource>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private readonly diffPaths = new Map<ToolCallId, readonly string[]>();
  private activeReads = 0;
  private readonly waitingReads = new Set<() => void>();

  constructor(private readonly spool: SpoolReader) {}

  private acquire(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cancel = (): void => {
        this.waitingReads.delete(start);
        reject(signal.reason);
      };
      const start = (): void => {
        this.waitingReads.delete(start);
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) { reject(signal.reason); return; }
        this.activeReads += 1;
        resolve();
      };
      if (signal.aborted || this.activeReads < 4) { start(); return; }
      this.waitingReads.add(start);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }

  private async read(path: string, full: boolean, signal: AbortSignal): Promise<SavedText> {
    await this.acquire(signal);
    try { return await savedText(path, full, signal); }
    finally {
      this.activeReads -= 1;
      this.waitingReads.values().next().value?.();
    }
  }

  private release<K>(map: Map<K, Resource>, key: K): boolean {
    const resource = map.get(key);
    if (!resource) return false;
    map.delete(key);
    resource.controller.abort();
    return true;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): number => this.revision;

  tail(id: ToolCallId): string {
    return this.outputs.get(id)?.value?.text ?? this.spool.tail(id);
  }

  state(id: ToolCallId): BoundedTextState | undefined {
    const value = this.outputs.get(id)?.value;
    if (value?.complete) return { tail: value.text, totalBytes: Buffer.byteLength(value.text), droppedBytes: 0, truncated: false };
    return this.spool.state(id);
  }

  version(id: ToolCallId): string {
    const resource = this.outputs.get(id);
    const diffs = this.diffPaths.get(id)?.map((path) => `${path}:${this.changes.get(path)?.revision ?? 0}`).join("|") ?? "";
    return `${this.spool.version?.(id) ?? this.spool.tail(id)}:${resource?.signature ?? ""}:${resource?.full ?? false}:${resource?.revision ?? 0}:${diffs}`;
  }

  dispose(): void {
    this.listeners.clear();
    this.diffPaths.clear();
    for (const id of this.outputs.keys()) this.release(this.outputs, id);
    for (const path of this.changes.keys()) this.release(this.changes, path);
  }

  notice(id: ToolCallId): string | undefined {
    const resource = this.outputs.get(id);
    if (resource?.error) return "Saved output unavailable · retained output shown";
    if (resource?.full && resource.value && !resource.value.complete) return "Large output · open the full output viewer";
    if (resource?.full && !resource.value) return "Loading saved output";
    return undefined;
  }

  fileChange(change: FileChange): FileChange {
    if (!change.snapshotPath || change.afterText !== undefined) return change;
    const value = this.changes.get(change.snapshotPath)?.value;
    return value?.complete ? { ...change, afterText: value.text } : change;
  }

  fileChangeNotice(change: FileChange): string | undefined {
    if (!change.truncated || change.afterText !== undefined || change.binary) return undefined;
    if (!change.snapshotPath) return "Full diff unavailable · retained preview shown";
    const resource = this.changes.get(change.snapshotPath);
    if (resource?.error) return "Saved diff snapshot unavailable · retained preview shown";
    if (resource?.value && !resource.value.complete) return "Large diff snapshot · retained preview shown";
    if (!resource?.value) return "Loading saved diff snapshot";
    return undefined;
  }

  private ensure<K>(map: Map<K, Resource>, key: K, path: string, signature: string, full: boolean): Promise<void> {
    const current = map.get(key);
    if (current?.signature === signature && (current.full || !full)) return current.result;
    this.release(map, key);
    const controller = new AbortController();
    const resource: Resource = {
      signature, full, controller,
      result: this.read(path, full, controller.signal).then((value) => { resource.value = value; }).catch(() => { resource.error = "unavailable"; }).then(() => {
        if (map.get(key) !== resource) return;
        this.revision += 1;
        resource.revision = this.revision;
        for (const listener of this.listeners) listener();
      }),
    };
    map.set(key, resource);
    return resource.result;
  }

  async prepare(state: TranscriptState, visibleIds: Iterable<string> = state.order): Promise<void> {
    const tools = new Set<ToolCallId>();
    const snapshots = new Set<string>();
    const pending: Promise<void>[] = [];
    this.diffPaths.clear();
    let released = false;
    for (const id of visibleIds) {
      const item = state.byId.get(id);
      if (item?.kind !== "tool" || item.status === "running" || item.status === "queued") continue;
      const expanded = isItemExpanded(state, item);
      const needsHead = this.spool.state(item.toolCallId)?.truncated || item.outputBytes > 256 * 1024;
      if (item.artifactPath && (expanded || needsHead)) {
        tools.add(item.toolCallId);
        if (!expanded && this.outputs.get(item.toolCallId)?.full) released = this.release(this.outputs, item.toolCallId) || released;
        const signature = `${item.artifactPath}:${this.spool.version?.(item.toolCallId) ?? item.outputBytes}`;
        pending.push(this.ensure(this.outputs, item.toolCallId, item.artifactPath, signature, expanded));
      }
      if (!expanded) continue;
      this.diffPaths.set(item.toolCallId, (item.fileChanges ?? []).flatMap((change) => change.snapshotPath && change.afterText === undefined ? [change.snapshotPath] : []));
      for (const change of item.fileChanges ?? []) {
        if (!change.snapshotPath || change.afterText !== undefined) continue;
        snapshots.add(change.snapshotPath);
        pending.push(this.ensure(this.changes, change.snapshotPath, change.snapshotPath, change.snapshotPath, true));
      }
    }
    for (const id of this.outputs.keys()) if (!tools.has(id)) released = this.release(this.outputs, id) || released;
    for (const path of this.changes.keys()) if (!snapshots.has(path)) released = this.release(this.changes, path) || released;
    if (released) {
      this.revision += 1;
      for (const listener of this.listeners) listener();
    }
    await Promise.all(pending);
  }
}
