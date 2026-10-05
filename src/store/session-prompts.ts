import { createHash } from "node:crypto";
import { mkdir, open, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { getHistoryDir } from "./paths.js";
import { acquireJsonlWriteLock } from "./history/jsonl-lock.js";
import { redactSecrets } from "../llm/provider.js";
import { redactUserCredentialsFromMemory } from "../agent/context/user-credentials.js";
import { formatPromptSection } from "./session-prompts-format.js";

const INDEX_BYTES = 16;
const MAX_METADATA_BYTES = 8192;
export const MAX_NAMING_PROMPTS = 16;
export const MAX_NAMING_PROMPT_CHARS = 400;

export interface SessionPromptInput {
  readonly content: string;
  readonly timestamp?: number | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly imported?: boolean | undefined;
}

export interface SessionPromptEntry extends Omit<SessionPromptInput, "content"> {
  readonly number: number;
  readonly preview: string;
  readonly sectionOffset: number;
  readonly nextOffset: number;
}

export interface NamingPromptWindow {
  readonly count: number;
  readonly prompts: readonly Pick<SessionPromptEntry, "number" | "preview">[];
}

function directory(sessionId: string, historyDir = getHistoryDir()): string {
  return join(historyDir, "prompts", createHash("sha256").update(sessionId).digest("hex"));
}

function excerpt(content: string): string {
  const text = content.replace(/\s+/g, " ").trim();
  if (text.length <= MAX_NAMING_PROMPT_CHARS) return text;
  return `${text.slice(0, 279)}…${text.slice(-120)}`;
}

async function readEntry(index: FileHandle, metadata: FileHandle, number: number): Promise<{
  entry: SessionPromptEntry; metadataEnd: number;
}> {
  const record = Buffer.alloc(INDEX_BYTES);
  const { bytesRead } = await index.read(record, 0, record.length, (number - 1) * INDEX_BYTES);
  if (bytesRead !== INDEX_BYTES) throw new Error("incomplete session prompt index");
  const offset = Number(record.readBigUInt64LE(0));
  const length = Number(record.readBigUInt64LE(8));
  if (!Number.isSafeInteger(offset) || offset < 0 || length < 1 || length > MAX_METADATA_BYTES) {
    throw new Error("invalid session prompt index");
  }
  const data = Buffer.alloc(length);
  const read = await metadata.read(data, 0, length, offset);
  if (read.bytesRead !== length) throw new Error("incomplete session prompt metadata");
  const entry = JSON.parse(data.toString("utf8")) as SessionPromptEntry;
  if (entry.number !== number || typeof entry.preview !== "string" ||
      !Number.isSafeInteger(entry.nextOffset) || entry.nextOffset < 0) {
    throw new Error("invalid session prompt metadata");
  }
  return { entry, metadataEnd: offset + length };
}

interface Writer {
  readonly body: FileHandle;
  readonly metadata: FileHandle;
  readonly index: FileHandle;
  count: number;
  bodyEnd: number;
  metadataEnd: number;
}

export class SessionPromptStore {
  readonly path: string;
  private readonly root: string;
  private readonly metadataPath: string;
  private readonly indexPath: string;
  private pending: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(readonly sessionId: string) {
    this.root = directory(sessionId);
    this.path = join(this.root, "prompts.md");
    this.metadataPath = join(this.root, "metadata.jsonl");
    this.indexPath = join(this.root, "offsets.bin");
  }

  append(input: SessionPromptInput): Promise<void> {
    if (!input.content.trim()) return Promise.resolve();
    return this.enqueue(() => this.write(async (writer) => {
      await this.appendEntry(writer, input);
    }));
  }

  seed(inputs: Iterable<SessionPromptInput>): Promise<void> {
    return this.enqueue(async () => {
      if (await this.count() > 0) return;
      const iterator = inputs[Symbol.iterator]();
      const first = iterator.next();
      if (first.done) return;
      await this.write(async (writer) => {
        if (writer.count > 0) return;
        await this.appendEntry(writer, first.value);
        for (let next = iterator.next(); !next.done; next = iterator.next()) {
          await this.appendEntry(writer, next.value);
        }
      });
    });
  }

  flush(): Promise<void> {
    return this.pending;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async count(): Promise<number> {
    try {
      return Math.floor((await stat(this.indexPath)).size / INDEX_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  async namingWindow(): Promise<NamingPromptWindow> {
    await this.flush();
    const count = await this.count();
    if (!count) return { count: 0, prompts: [] };
    const recentStart = Math.max(1, count - 7);
    const positions = new Set<number>();
    for (let sample = 0; sample < 8 && recentStart > 1; sample++) {
      positions.add(1 + Math.round(sample * (recentStart - 2) / 7));
    }
    for (let number = recentStart; number <= count; number++) positions.add(number);
    const index = await open(this.indexPath, "r");
    try {
      const metadata = await open(this.metadataPath, "r");
      try {
        const prompts = await Promise.all([...positions].sort((a, b) => a - b).map(async (number) => {
          const { entry } = await readEntry(index, metadata, number);
          return { number, preview: entry.preview };
        }));
        return { count, prompts };
      } finally { await metadata.close(); }
    } finally { await index.close(); }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.then(operation, operation);
    this.pending = result;
    void result.catch(() => undefined);
    return result;
  }

  private async write(operation: (writer: Writer) => Promise<void>): Promise<void> {
    const release = await acquireJsonlWriteLock();
    const handles: FileHandle[] = [];
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      for (const path of [this.path, this.metadataPath, this.indexPath]) {
        handles.push(await open(path, "a+", 0o600));
      }
      const [body, metadata, index] = handles as [FileHandle, FileHandle, FileHandle];
      const count = Math.floor((await index.stat()).size / INDEX_BYTES);
      const last = count ? await readEntry(index, metadata, count) : undefined;
      const bodyEnd = last?.entry.nextOffset ?? 0;
      const metadataEnd = last?.metadataEnd ?? 0;
      if ((await body.stat()).size < bodyEnd) throw new Error("incomplete session prompt journal");
      await index.truncate(count * INDEX_BYTES);
      await metadata.truncate(metadataEnd);
      await body.truncate(bodyEnd);
      await operation({ body, metadata, index, count, bodyEnd, metadataEnd });
    } finally {
      await Promise.allSettled(handles.map((handle) => handle.close()));
      await release();
    }
    for (const listener of this.listeners) {
      try { listener(); } catch {}
    }
  }

  private async appendEntry(writer: Writer, input: SessionPromptInput): Promise<void> {
    const content = redactUserCredentialsFromMemory(input.content).replace(
      /\b(?:gsk_|AIza|AQ\.|sk-|nvapi-|wk-|ws-)[A-Za-z0-9._-]+/g,
      (credential) => redactSecrets(credential),
    );
    const number = writer.count + 1;
    const body = formatPromptSection(this.sessionId, number, { ...input, content });
    const entry: SessionPromptEntry = {
      number,
      preview: excerpt(content),
      ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
      ...(input.provider ? { provider: input.provider.slice(0, 128) } : {}),
      ...(input.model ? { model: input.model.slice(0, 256) } : {}),
      ...(input.effort ? { effort: input.effort.slice(0, 32) } : {}),
      ...(input.imported ? { imported: true } : {}),
      sectionOffset: writer.bodyEnd,
      nextOffset: writer.bodyEnd + Buffer.byteLength(body),
    };
    const data = `${JSON.stringify(entry)}\n`;
    const length = Buffer.byteLength(data);
    if (length > MAX_METADATA_BYTES) throw new Error("session prompt metadata exceeds its limit");
    const index = Buffer.alloc(INDEX_BYTES);
    index.writeBigUInt64LE(BigInt(writer.metadataEnd), 0);
    index.writeBigUInt64LE(BigInt(length), 8);
    await writer.body.writeFile(body);
    await writer.metadata.writeFile(data);
    await writer.index.writeFile(index);
    writer.count = number;
    writer.bodyEnd = entry.nextOffset;
    writer.metadataEnd += length;
  }
}

export async function removeSessionPrompts(sessionId: string): Promise<boolean> {
  const release = await acquireJsonlWriteLock();
  try {
    const root = directory(sessionId);
    const exists = await stat(root).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    await rm(root, { recursive: true, force: true });
    return exists;
  } finally { await release(); }
}
