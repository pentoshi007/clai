import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireJsonlWriteLock } from "../../src/store/history/jsonl-lock.js";
import { createSavedPromptReader, SessionPromptStore } from "../../src/store/session-prompts.js";
import { createSessionPromptsPagerSource } from "../../src/ui-core/rendering/session-prompts-pager-source.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const { withWindowsAppendHandles } = await import("../fixtures/windows-append-handles.js");
  return withWindowsAppendHandles(await importOriginal<typeof import("node:fs/promises")>());
});

afterEach(() => { vi.restoreAllMocks(); });

function store(label: string): SessionPromptStore {
  return new SessionPromptStore(`${label}-${Math.random().toString(36).slice(2)}`);
}

describe("prompt journal handoff", () => {
  it("preserves full text, offsets, metadata, permissions, and readers without removing the source", async () => {
    const source = store("source");
    const target = store("target");
    const content = `Implement Unicode support 日本語\n\n> User quotation\n${"full details ".repeat(10000)}`;
    await source.append({ content, timestamp: 1791110400000, provider: "river", model: "deepseek", effort: "max" });
    const pager = createSessionPromptsPagerSource(target);
    const updated = vi.fn();
    pager.watch!(updated);
    try {
      await target.inheritFrom(source);
      for (const file of ["prompts.md", "metadata.jsonl", "offsets.bin"]) {
        expect(await fs.readFile(join(dirname(target.path), file))).toEqual(await fs.readFile(join(dirname(source.path), file)));
      }
      expect(await source.count()).toBe(1);
      expect(updated).toHaveBeenCalledTimes(1);
      expect((await pager.readPage(0)).body).toContain("Implement Unicode support 日本語");
      const restored = new SessionPromptStore(target.sessionId);
      expect(await createSavedPromptReader(restored).readOlder()).toBe(content);
      expect(await restored.namingWindow()).toEqual(await source.namingWindow());
      if (process.platform !== "win32") {
        expect((await fs.stat(dirname(target.path))).mode & 0o777).toBe(0o700);
        expect((await fs.stat(target.path)).mode & 0o777).toBe(0o600);
      }
    } finally { pager.dispose(); }
  });

  it("waits for pending source writes and queues new appends after the handoff", async () => {
    const source = store("pending-source");
    const target = store("pending-target");
    const first = source.append({ content: "First pending prompt" });
    const second = source.append({ content: "Second pending prompt" });
    const inherited = target.inheritFrom(source);
    const appended = target.append({ content: "New session prompt" });
    await Promise.all([first, second, inherited, appended]);
    expect((await target.namingWindow()).prompts).toEqual([
      { number: 1, preview: "First pending prompt" },
      { number: 2, preview: "Second pending prompt" },
      { number: 3, preview: "New session prompt" },
    ]);
    expect(await source.count()).toBe(2);
  });

  it("uses the shared history lock before publishing a journal", async () => {
    const source = store("locked-source");
    const target = store("locked-target");
    await source.append({ content: "Committed prompt" });
    const release = await acquireJsonlWriteLock();
    let finished = false;
    const inherited = target.inheritFrom(source).then(() => { finished = true; });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      await expect(fs.stat(target.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await release(); }
    await inherited;
    expect(await target.count()).toBe(1);
  });

  it("keeps both journals intact and removes staging files when a copy fails", async () => {
    const source = store("failed-source");
    const target = store("failed-target");
    await source.append({ content: "Do not lose this prompt" });
    const directories = await fs.readdir(dirname(dirname(source.path)));
    const copyFile = fs.copyFile;
    const copy = vi.spyOn(fs, "copyFile")
      .mockImplementationOnce(copyFile)
      .mockRejectedValueOnce(new Error("copy failed"));
    await expect(target.inheritFrom(source)).rejects.toThrow("copy failed");
    copy.mockRestore();
    expect(await source.count()).toBe(1);
    expect(await fs.readFile(source.path, "utf8")).toContain("Do not lose this prompt");
    await expect(fs.stat(dirname(target.path))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(dirname(dirname(source.path)))).toEqual(directories);
    await target.inheritFrom(source);
    expect(await target.count()).toBe(1);
  });

  it("does not replace an existing destination journal", async () => {
    const source = store("existing-source");
    const target = store("existing-target");
    await source.append({ content: "Original source" });
    await target.append({ content: "Existing destination" });
    await expect(target.inheritFrom(source)).rejects.toThrow("not empty");
    expect((await source.namingWindow()).prompts[0]!.preview).toBe("Original source");
    expect((await new SessionPromptStore(target.sessionId).namingWindow()).prompts[0]!.preview).toBe("Existing destination");
  });

  it("does not create a destination journal when the source is empty", async () => {
    const source = store("empty-source");
    const target = store("empty-target");
    await target.inheritFrom(source);
    expect(await target.count()).toBe(0);
    await expect(fs.stat(dirname(source.path))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(dirname(target.path))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
