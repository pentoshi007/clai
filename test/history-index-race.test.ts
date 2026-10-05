import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const hooks = vi.hoisted(() => ({
  source: "",
  afterEof: undefined as (() => Promise<void>) | undefined,
  maxWriteBytes: undefined as number | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    async open(...args: Parameters<typeof fs.open>) {
      const handle = await fs.open(...args);
      if (String(args[0]) !== hooks.source) return handle;
      const read = handle.read.bind(handle);
      const write = handle.write.bind(handle);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "read") return async (...values: any[]) => {
            const result = await (read as any)(...values);
            if (result.bytesRead === 0 && hooks.afterEof) {
              const complete = hooks.afterEof;
              hooks.afterEof = undefined;
              await complete();
            }
            return result;
          };
          if (property === "write" && hooks.maxWriteBytes) return (buffer: Buffer, offset: number, length: number, position: number) =>
            write(buffer, offset, Math.min(length, hooks.maxWriteBytes!), position);
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

import { appendIndexedHistoryRecord, findHistoryRecordStreaming, readIndexedHistoryRecord, readValidatedHistoryIndex, rebuildHistoryIndex, writeIndexedJsonl } from "../src/store/history-index.js";

const directories: string[] = [];
const record = (revision: number, writerGeneration = "0002-current") => ({
  id: "session", writerGeneration, revision, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z", cwd: "/tmp",
  messages: [{ role: "user", content: `Revision ${revision}: ${"λ".repeat(1000)}` }],
});

afterEach(async () => {
  hooks.source = "";
  hooks.afterEof = undefined;
  hooks.maxWriteBytes = undefined;
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "clai-index-race-"));
  directories.push(directory);
  const source = join(directory, "history.jsonl");
  const index = join(directory, "history.index.json");
  hooks.source = source;
  await writeIndexedJsonl(source, index, [record(1)]);
  return { source, index };
}

describe("history index consistency", () => {
  it("does not publish an apparently current index for a snapshot that changed after scanning", async () => {
    const { source, index } = await fixture();
    hooks.afterEof = () => appendFile(source, `${JSON.stringify(record(2))}\n`);
    await rebuildHistoryIndex(source, index);
    expect(await readValidatedHistoryIndex(source, index)).toBeUndefined();
    expect((await findHistoryRecordStreaming(source, "session"))?.revision).toBe(2);
    await rebuildHistoryIndex(source, index);
    expect((await readValidatedHistoryIndex(source, index))?.[0]?.summary.revision).toBe(2);
  });

  it("preserves generation and revision ordering when rebuilding or falling back to a scan", async () => {
    const { source, index } = await fixture();
    await writeFile(source, [record(9), record(8), record(999, "0001-superseded")].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const entries = await rebuildHistoryIndex(source, index);
    expect(entries[0]?.summary.revision).toBe(9);
    expect((await readIndexedHistoryRecord<any>(source, entries[0]!))?.revision).toBe(9);
    expect((await findHistoryRecordStreaming(source, "session"))?.revision).toBe(9);
  });

  it("finishes partial filesystem writes before publishing the new session revision", async () => {
    const { source, index } = await fixture();
    const entries = (await readValidatedHistoryIndex(source, index))!;
    hooks.maxWriteBytes = 31;
    const saved = await appendIndexedHistoryRecord(source, index, entries, record(2));
    expect((await readIndexedHistoryRecord<any>(source, saved.entries[0]!))?.messages).toEqual(record(2).messages);
    expect((await readValidatedHistoryIndex(source, index))?.[0]?.summary.revision).toBe(2);
  });
});
