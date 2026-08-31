import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, writeFile } from "node:fs/promises";

export interface HistorySummary {
  id: string;
  writerGeneration?: string | undefined;
  revision?: number | undefined;
  name?: string | undefined;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  messageCount: number;
  itemCount: number;
  hasImages: boolean;
  workspaceFolder?: string | undefined;
  workspaceCode?: string | undefined;
}

export interface HistoryIndexEntry {
  id: string;
  offset: number;
  length: number;
  summary: HistorySummary;
}

interface HistoryIndexFile {
  schemaVersion: 1;
  source: { size: number; mtimeMs: number };
  entries: HistoryIndexEntry[];
}

interface HistoryRecordShape {
  id: string;
  writerGeneration?: string | undefined;
  revision?: number | undefined;
  name?: string | undefined;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  messages?: Array<{ images?: unknown[] | undefined }> | undefined;
  transcript?: unknown[] | undefined;
  workspaceFolder?: string | undefined;
  workspaceCode?: string | undefined;
}

export function historySummary(record: HistoryRecordShape): HistorySummary {
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const transcript = Array.isArray(record.transcript) ? record.transcript : [];
  return {
    id: record.id,
    ...(record.writerGeneration
      ? { writerGeneration: record.writerGeneration }
      : {}),
    ...(typeof record.revision === "number"
      ? { revision: record.revision }
      : {}),
    ...(record.name ? { name: record.name } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    cwd: record.cwd,
    messageCount: messages.length,
    itemCount: transcript.length > 0 ? transcript.length : messages.length,
    hasImages: messages.some(
      (message) => Array.isArray(message.images) && message.images.length > 0,
    ),
    ...(record.workspaceFolder
      ? { workspaceFolder: record.workspaceFolder }
      : {}),
    ...(record.workspaceCode ? { workspaceCode: record.workspaceCode } : {}),
  };
}

async function writeHistoryIndexFile(
  jsonlPath: string,
  indexPath: string,
  entries: readonly HistoryIndexEntry[],
): Promise<void> {
  const source = await stat(jsonlPath);
  const index: HistoryIndexFile = {
    schemaVersion: 1,
    source: { size: source.size, mtimeMs: source.mtimeMs },
    entries: [...entries],
  };
  const temp = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(index)}\n`, { mode: 0o600 });
  await rename(temp, indexPath);
}

export interface HistoryAppendResult {
  entries: HistoryIndexEntry[];
  fileSize: number;
  liveBytes: number;
}

export function historyIndexLiveBytes(
  entries: readonly HistoryIndexEntry[],
): number {
  return entries.reduce((total, entry) => total + entry.length, 0);
}

export async function appendIndexedHistoryRecord<T extends HistoryRecordShape>(
  jsonlPath: string,
  indexPath: string,
  entries: readonly HistoryIndexEntry[],
  record: T,
): Promise<HistoryAppendResult> {
  const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  const handle = await open(jsonlPath, "a", 0o600);
  let offset = 0;
  try {
    offset = (await handle.stat()).size;
    await handle.write(line, 0, line.length, offset);
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
  const next = entries.filter((entry) => entry.id !== record.id);
  next.push({
    id: record.id,
    offset,
    length: line.length,
    summary: historySummary(record),
  });
  await writeHistoryIndexFile(jsonlPath, indexPath, next);
  return {
    entries: next,
    fileSize: offset + line.length,
    liveBytes: historyIndexLiveBytes(next),
  };
}

export async function writeIndexedJsonl(
  jsonlPath: string,
  indexPath: string,
  records: readonly HistoryRecordShape[],
): Promise<void> {
  const entries: HistoryIndexEntry[] = [];
  const lines: Buffer[] = [];
  let offset = 0;
  for (const record of records) {
    const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    entries.push({
      id: record.id,
      offset,
      length: line.length,
      summary: historySummary(record),
    });
    lines.push(line);
    offset += line.length;
  }

  const token = `${process.pid}.${randomUUID()}`;
  const jsonlTemp = `${jsonlPath}.${token}.tmp`;
  await writeFile(jsonlTemp, Buffer.concat(lines), { mode: 0o600 });
  await rename(jsonlTemp, jsonlPath);
  await writeHistoryIndexFile(jsonlPath, indexPath, entries);
}

export async function readValidatedHistoryIndex(
  jsonlPath: string,
  indexPath: string,
): Promise<HistoryIndexEntry[] | undefined> {
  try {
    const [source, raw] = await Promise.all([
      stat(jsonlPath),
      readFile(indexPath, "utf8"),
    ]);
    const parsed = JSON.parse(raw) as HistoryIndexFile;
    if (
      parsed.schemaVersion !== 1 ||
      !Array.isArray(parsed.entries) ||
      parsed.source.size !== source.size ||
      Math.abs(parsed.source.mtimeMs - source.mtimeMs) > 1
    ) {
      return undefined;
    }
    for (const entry of parsed.entries) {
      if (
        !entry ||
        typeof entry.id !== "string" ||
        !Number.isSafeInteger(entry.offset) ||
        !Number.isSafeInteger(entry.length) ||
        entry.offset < 0 ||
        entry.length <= 0 ||
        entry.offset + entry.length > source.size ||
        entry.summary?.id !== entry.id
      ) {
        return undefined;
      }
    }
    return parsed.entries;
  } catch {
    return undefined;
  }
}

export async function readIndexedHistoryRecord<T>(
  jsonlPath: string,
  entry: HistoryIndexEntry,
): Promise<T | undefined> {
  const handle = await open(jsonlPath, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const bytes = Buffer.alloc(entry.length);
    const { bytesRead } = await handle.read(bytes, 0, entry.length, entry.offset);
    if (bytesRead !== entry.length) return undefined;
    const record = JSON.parse(bytes.toString("utf8").trim()) as T & {
      id?: string;
      revision?: number;
    };
    if (record.id !== entry.id) return undefined;
    if (
      entry.summary.revision !== undefined &&
      record.revision !== entry.summary.revision
    ) {
      return undefined;
    }
    return record;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

export interface HistoryIndexScanResult {
  malformed: boolean;
}

export interface HistoryIndexRebuildResult {
  entries: HistoryIndexEntry[];
  malformed: boolean;
}

export async function scanHistoryJsonl<T extends HistoryRecordShape>(
  jsonlPath: string,
  visit: (record: T, offset: number, length: number) => void,
): Promise<HistoryIndexScanResult> {
  const handle = await open(jsonlPath, "r").catch(() => undefined);
  if (!handle) return { malformed: false };
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let carryChunks: Buffer[] = [];
  let carryLen = 0;
  let fileOffset = 0;
  let malformed = false;
  const visitLine = (line: Buffer, offset: number, length: number): void => {
    if (line.length === 0) return;
    try {
      visit(JSON.parse(line.toString("utf8")) as T, offset, length);
    } catch {
      malformed = true;
    }
  };
  try {
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      let start = 0;
      while (true) {
        const newline = chunk.indexOf(0x0a, start);
        if (newline < 0 || newline >= bytesRead) break;
        const segmentStart = fileOffset + start;
        if (carryLen > 0) {
          const segment = chunk.subarray(start, newline);
          const line =
            segment.length > 0
              ? Buffer.concat([...carryChunks, segment], carryLen + segment.length)
              : Buffer.concat(carryChunks, carryLen);
          const lineOffset = segmentStart - carryLen;
          visitLine(line, lineOffset, newline - start + 1 + carryLen);
          carryChunks = [];
          carryLen = 0;
        } else {
          visitLine(chunk.subarray(start, newline), segmentStart, newline - start + 1);
        }
        start = newline + 1;
      }
      if (start < bytesRead) {
        carryChunks.push(Buffer.from(chunk.subarray(start, bytesRead)));
        carryLen += bytesRead - start;
      }
      fileOffset += bytesRead;
    }
    if (carryLen > 0) {
      const carry = Buffer.concat(carryChunks, carryLen);
      visitLine(carry, fileOffset - carryLen, carryLen);
    }
  } finally {
    await handle.close();
  }
  return { malformed };
}

export async function rebuildHistoryIndexWithStatus<
  T extends HistoryRecordShape,
>(
  jsonlPath: string,
  indexPath: string,
): Promise<HistoryIndexRebuildResult> {
  const byId = new Map<string, HistoryIndexEntry>();
  const scan = await scanHistoryJsonl<T>(jsonlPath, (record, offset, length) => {
    if (!record?.id) return;
    byId.set(record.id, {
      id: record.id,
      offset,
      length,
      summary: historySummary(record),
    });
  });
  const entries = [...byId.values()];
  try {
    await writeHistoryIndexFile(jsonlPath, indexPath, entries);
  } catch {
  }
  return { entries, malformed: scan.malformed };
}

export async function rebuildHistoryIndex<T extends HistoryRecordShape>(
  jsonlPath: string,
  indexPath: string,
): Promise<HistoryIndexEntry[]> {
  return (await rebuildHistoryIndexWithStatus<T>(jsonlPath, indexPath)).entries;
}

export async function findHistoryRecordStreaming<T extends HistoryRecordShape>(
  jsonlPath: string,
  id: string,
): Promise<T | undefined> {
  let found: T | undefined;
  await scanHistoryJsonl<T>(jsonlPath, (record) => {
    if (record.id === id) found = record;
  });
  return found;
}
