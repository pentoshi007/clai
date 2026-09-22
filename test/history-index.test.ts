import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readIndexedHistoryRecord,
  readValidatedHistoryIndex,
  rebuildHistoryIndex,
  writeIndexedJsonl,
} from "../src/store/history-index.js";

const dirs: string[] = [];
const originalHistoryDir = process.env.CLAI_HISTORY_DIR;

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clai-history-index-"));
  dirs.push(dir);
  return dir;
}

function record(id: string, content: string, revision = 1) {
  const at = new Date(Date.UTC(2026, 0, 1, 0, revision)).toISOString();
  return {
    id,
    revision,
    name: `Session ${id}`,
    createdAt: at,
    updatedAt: at,
    cwd: "/tmp/project",
    messages: [
      { role: "user", content },
      { role: "assistant", content: `answer ${id}` },
    ],
    transcript: [{ kind: "user", text: content }],
  };
}

afterEach(async () => {
  if (originalHistoryDir === undefined) delete process.env.CLAI_HISTORY_DIR;
  else process.env.CLAI_HISTORY_DIR = originalHistoryDir;
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  vi.resetModules();
});

describe("history JSONL sidecar index", () => {
  it("uses exact UTF-8 byte offsets for direct selected-record reads", async () => {
    const dir = await tempDir();
    const jsonl = join(dir, "history.jsonl");
    const index = join(dir, "history.index.json");
    const records = [
      record("unicode-a", "λ🙂漢字".repeat(200), 1),
      record("unicode-b", "résumé café", 2),
    ];

    await writeIndexedJsonl(jsonl, index, records);
    const entries = await readValidatedHistoryIndex(jsonl, index);
    expect(entries).toHaveLength(2);
    const selected = await readIndexedHistoryRecord<(typeof records)[number]>(
      jsonl,
      entries!.find((entry) => entry.id === "unicode-b")!,
    );

    expect(selected?.id).toBe("unicode-b");
    expect(selected?.messages[0]?.content).toBe("résumé café");
    expect(entries?.[0]?.summary).not.toHaveProperty("messages");
  });

  it("rejects a stale index and rebuilds valid entries from malformed JSONL", async () => {
    const dir = await tempDir();
    const jsonl = join(dir, "history.jsonl");
    const index = join(dir, "history.index.json");
    await writeIndexedJsonl(jsonl, index, [record("first", "one")]);
    await writeFile(
      jsonl,
      `${await readFile(jsonl, "utf8")}not-json\n${JSON.stringify(record("second", "two", 2))}\n`,
    );

    expect(await readValidatedHistoryIndex(jsonl, index)).toBeUndefined();
    const rebuilt = await rebuildHistoryIndex(jsonl, index);
    expect(rebuilt.map((entry) => entry.id)).toEqual(["first", "second"]);
    expect(await readValidatedHistoryIndex(jsonl, index)).toHaveLength(2);
  });

  it("lists 50 large sessions from summaries without materializing transcripts", async () => {
    const dir = await tempDir();
    const jsonl = join(dir, "history.jsonl");
    const index = join(dir, "history.index.json");
    const records = Array.from({ length: 50 }, (_, i) =>
      record(`large-${i}`, `${i}:${"x".repeat(100_000)}`, i + 1),
    );
    await writeIndexedJsonl(jsonl, index, records);
    process.env.CLAI_HISTORY_DIR = dir;
    vi.resetModules();
    const { listSessionSummaries } = await import("../src/store/history.js");

    const started = performance.now();
    const summaries = await listSessionSummaries(50, {
      recovery: "background",
    });
    const elapsed = performance.now() - started;

    expect(summaries).toHaveLength(50);
    expect(summaries[0]?.messageCount).toBe(2);
    expect(summaries.every((summary) => !("messages" in summary))).toBe(true);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("does not reuse a limited SQLite summary cache for a larger request", async () => {
    const dir = await tempDir();
    process.env.CLAI_HISTORY_DIR = dir;
    vi.resetModules();
    const { listSessionSummaries, upsertSession } = await import(
      "../src/store/history.js"
    );
    for (let index = 0; index < 5; index += 1) {
      await upsertSession(
        `cached-${index}`,
        [{ role: "user", content: `message ${index}` }],
        `Cached ${index}`,
      );
    }
    await rm(join(dir, "history.index.json"), { force: true });

    expect(await listSessionSummaries(2)).toHaveLength(2);
    expect(await listSessionSummaries(5)).toHaveLength(5);
  });

  it("keeps selected images path-backed until provider use", async () => {
    const dir = await tempDir();
    const jsonl = join(dir, "history.jsonl");
    const index = join(dir, "history.index.json");
    const imagePath = join(dir, "tiny.png");
    await writeFile(
      imagePath,
      Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
        "hex",
      ),
    );
    const imageRecord = {
      ...record("image-session", "inspect image"),
      messages: [
        {
          role: "user",
          content: "inspect image",
          images: [
            { mediaType: "image/png", dataBase64: "", path: imagePath },
          ],
        },
      ],
    };
    await writeIndexedJsonl(jsonl, index, [imageRecord]);
    process.env.CLAI_HISTORY_DIR = dir;
    vi.resetModules();
    const { getSession, materializeHistoryImages } = await import(
      "../src/store/history.js"
    );

    const selected = await getSession("image-session");
    expect(selected?.messages[0]?.images?.[0]?.dataBase64).toBe("");
    const materialized = materializeHistoryImages(selected!.messages);
    expect(materialized[0]?.images?.[0]?.dataBase64).toBeTruthy();
    expect(selected?.messages[0]?.images?.[0]?.dataBase64).toBe("");
  });

  it("serializes concurrent sessions without losing or corrupting records", async () => {
    const dir = await tempDir();
    process.env.CLAI_HISTORY_DIR = dir;
    vi.resetModules();
    const { upsertSession, listSessionSummaries, getSession } = await import(
      "../src/store/history.js"
    );

    const sessionIds = Array.from({ length: 12 }, (_, i) => `concurrent-${i}`);
    await Promise.all(
      sessionIds.map((id, i) =>
        upsertSession(
          id,
          [
            { role: "user", content: `prompt ${i}` },
            { role: "assistant", content: `answer ${i}` },
          ],
          `Concurrent ${i}`,
          [
            { kind: "user", id: `u-${i}`, text: `prompt ${i}`, done: true },
            {
              kind: "compacted",
              id: `c-${i}`,
              summary: `memory ${i}`,
              originalItems: [
                { kind: "user", id: `orig-${i}`, text: `earlier ${i}`, done: true },
              ],
              done: true,
              beforeTokens: 1000 + i,
              afterTokens: 100 + i,
            },
          ],
        ),
      ),
    );

    const summaries = await listSessionSummaries(50, { recovery: "blocking" });
    const found = new Set(summaries.map((s) => s.id));
    for (const id of sessionIds) expect(found.has(id)).toBe(true);

    for (const [i, id] of sessionIds.entries()) {
      const rec = await getSession(id);
      expect(rec?.messages[1]?.content).toBe(`answer ${i}`);
      const compacted = rec?.transcript?.find((t) => t.kind === "compacted");
      expect(compacted && compacted.kind === "compacted"
        ? compacted.originalItems[0]
        : undefined,
      ).toMatchObject({ id: `orig-${i}` });
    }
  }, 30_000);
});
