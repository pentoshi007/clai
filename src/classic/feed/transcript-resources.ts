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
  value?: SavedText;
  error?: string;
}

async function savedText(path: string, full: boolean): Promise<SavedText> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("not a file");
    const limit = full && info.size <= INLINE_BYTES ? info.size : Math.min(info.size, PREVIEW_BYTES);
    const bytes = Buffer.alloc(limit);
    let offset = 0;
    while (offset < limit) {
      const { bytesRead } = await file.read(bytes, offset, limit - offset, offset);
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

  constructor(private readonly spool: SpoolReader) {}

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
    return `${this.spool.version?.(id) ?? this.spool.tail(id)}:${this.revision}`;
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
    const resource: Resource = {
      signature, full,
      result: savedText(path, full).then((value) => { resource.value = value; }).catch(() => { resource.error = "unavailable"; }).then(() => {
        if (map.get(key) !== resource) return;
        this.revision += 1;
        for (const listener of this.listeners) listener();
      }),
    };
    map.set(key, resource);
    return resource.result;
  }

  async prepare(state: TranscriptState): Promise<void> {
    const tools = new Set<ToolCallId>();
    const snapshots = new Set<string>();
    const pending: Promise<void>[] = [];
    let released = false;
    for (const id of state.order) {
      const item = state.byId.get(id);
      if (item?.kind !== "tool" || item.status === "running" || item.status === "queued") continue;
      const expanded = isItemExpanded(state, item);
      const needsHead = this.spool.state(item.toolCallId)?.truncated || item.outputBytes > 256 * 1024;
      if (item.artifactPath && (expanded || needsHead)) {
        tools.add(item.toolCallId);
        if (!expanded && this.outputs.get(item.toolCallId)?.full) released = this.outputs.delete(item.toolCallId) || released;
        const signature = `${item.artifactPath}:${this.spool.version?.(item.toolCallId) ?? item.outputBytes}`;
        pending.push(this.ensure(this.outputs, item.toolCallId, item.artifactPath, signature, expanded));
      }
      if (!expanded) continue;
      for (const change of item.fileChanges ?? []) {
        if (!change.snapshotPath || change.afterText !== undefined) continue;
        snapshots.add(change.snapshotPath);
        pending.push(this.ensure(this.changes, change.snapshotPath, change.snapshotPath, change.snapshotPath, true));
      }
    }
    for (const id of this.outputs.keys()) if (!tools.has(id)) released = this.outputs.delete(id) || released;
    for (const path of this.changes.keys()) if (!snapshots.has(path)) released = this.changes.delete(path) || released;
    if (released) {
      this.revision += 1;
      for (const listener of this.listeners) listener();
    }
    await Promise.all(pending);
  }
}
