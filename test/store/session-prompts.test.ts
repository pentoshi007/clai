import { appendFile, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearAllHistory, purgeSession, saveSession } from "../../src/store/history.js";
import {
  MAX_NAMING_PROMPTS, MAX_NAMING_PROMPT_CHARS, SessionPromptStore,
} from "../../src/store/session-prompts.js";
import { createSessionPromptsPagerSource } from "../../src/ui-core/rendering/session-prompts-pager-source.js";

function store(label: string): SessionPromptStore {
  return new SessionPromptStore(`${label}-${Math.random().toString(36).slice(2)}`);
}

describe("persistent session user prompts", () => {
  it("preserves repeated prompts, timestamps, and each submitted route across store reloads", async () => {
    const original = store("reload");
    await original.append({ content: "Fix caching", timestamp: 1791110400000, provider: "codex", model: "gpt-5.4", effort: "xhigh" });
    await original.append({ content: "Fix caching", timestamp: 1791110460000, provider: "anthropic", model: "claude-sonnet", effort: "off" });
    const restored = new SessionPromptStore(original.sessionId);
    expect(await restored.count()).toBe(2);
    expect((await restored.namingWindow()).prompts).toEqual([
      { number: 1, preview: "Fix caching" }, { number: 2, preview: "Fix caching" },
    ]);
    const body = await readFile(restored.path, "utf8");
    expect(body).toContain("## Prompt 001");
    expect(body).toContain("## Prompt 002");
    expect(body.match(/> Fix caching/g)).toHaveLength(2);
    for (const detail of ["2026", "codex", "gpt-5.4", "xhigh", "anthropic", "claude-sonnet", "off"]) expect(body).toContain(detail);
    expect((await stat(restored.path)).mode & 0o777).toBe(0o600);
  });

  it("keeps full text on disk while naming reads a fixed number of small excerpts", async () => {
    const journal = store("bounded");
    const text = "Large request details ".repeat(6000);
    await journal.seed(Array.from({ length: 100 }, (_, index) => ({ content: `Task-${index + 1} ${text} End-${index + 1}` })));
    const window = await journal.namingWindow();
    expect(window.count).toBe(100);
    expect(window.prompts.length).toBeLessThanOrEqual(MAX_NAMING_PROMPTS);
    expect(window.prompts[0]!.preview).toContain("Task-1 ");
    expect(window.prompts.at(-1)!.preview).toContain("Task-100 ");
    expect(window.prompts.at(-1)!.preview).toContain("End-100");
    for (const prompt of window.prompts) expect(prompt.preview.length).toBeLessThanOrEqual(MAX_NAMING_PROMPT_CHARS);
    const source = createSessionPromptsPagerSource(journal);
    const first = await source.readPage(0);
    expect(first.body.length).toBeLessThanOrEqual(16 * 1024 + 4);
    expect(first.totalBytes).toBeGreaterThan(10 * 1024 * 1024);
    expect(first.pageCount).toBeGreaterThan(500);
    const found = await source.search("End-100");
    expect(found?.body).toContain("End-100");
    expect((await source.readTail!()).body).toContain("End-100");
    source.dispose();
  });

  it("serializes concurrent writes and imports legacy data only once", async () => {
    const journal = store("concurrent");
    await Promise.all(Array.from({ length: 12 }, (_, index) => journal.append({ content: `Prompt ${index}` })));
    await journal.seed([{ content: "should not duplicate imported history" }]);
    expect(await journal.count()).toBe(12);
    const window = await journal.namingWindow();
    expect(window.prompts.map((entry) => entry.preview)).toEqual(Array.from({ length: 12 }, (_, index) => `Prompt ${index}`));
    const body = await readFile(journal.path, "utf8");
    expect(body).not.toContain("should not duplicate");
  });

  it("recovers an interrupted append without dropping committed prompts", async () => {
    const journal = store("recovery");
    await journal.append({ content: "Committed first prompt" });
    await appendFile(journal.path, "uncommitted body suffix");
    await appendFile(join(dirname(journal.path), "metadata.jsonl"), "{incomplete metadata");
    await appendFile(join(dirname(journal.path), "offsets.bin"), Buffer.from([1, 2, 3]));
    await new SessionPromptStore(journal.sessionId).append({ content: "Committed second prompt" });
    expect(await journal.count()).toBe(2);
    expect((await journal.namingWindow()).prompts.map((entry) => entry.preview)).toEqual([
      "Committed first prompt", "Committed second prompt",
    ]);
    expect(await readFile(journal.path, "utf8")).not.toContain("uncommitted");
  });

  it("keeps writers for the same session consistent across independent store instances", async () => {
    const first = store("shared");
    const second = new SessionPromptStore(first.sessionId);
    await Promise.all([
      first.append({ content: "First writer" }),
      second.append({ content: "Second writer" }),
    ]);
    expect(await first.count()).toBe(2);
    expect(await second.count()).toBe(2);
    expect(new Set((await first.namingWindow()).prompts.map((entry) => entry.preview))).toEqual(
      new Set(["First writer", "Second writer"]),
    );
    await first.append({ content: "   " });
    expect(await first.count()).toBe(2);
  });

  it("redacts credentials before persistence and naming, and renders terminal controls safely", async () => {
    const journal = store("redacted");
    await journal.append({ content: "Use password=abc123xyz and sk-abcdefghijklmnopqrstuv\n\u001b[31mFix colors\u001b[0m" });
    const body = await readFile(journal.path, "utf8");
    const metadata = await readFile(join(dirname(journal.path), "metadata.jsonl"), "utf8");
    for (const value of [body, metadata]) {
      expect(value).not.toContain("abc123xyz");
      expect(value).not.toContain("abcdefghijklmnopqrstuv");
    }
    expect(body).not.toContain("\u001b");
    expect(body).toContain("Fix colors");
    expect(JSON.stringify((await journal.namingWindow()).prompts)).not.toContain("abc123xyz");
  });

  it("shows empty history without creating files and unregisters pager subscriptions on close", async () => {
    const journal = store("empty");
    const source = createSessionPromptsPagerSource(journal);
    let updates = 0;
    source.watch!(() => { updates += 1; });
    expect((await source.readPage(0)).body).toContain("No user prompts");
    await expect(stat(journal.path)).rejects.toMatchObject({ code: "ENOENT" });
    await journal.append({ content: "First real prompt" });
    expect(updates).toBe(1);
    expect((await source.readPage(0)).body).toContain("First real prompt");
    source.dispose();
    await journal.append({ content: "Second real prompt" });
    expect(updates).toBe(1);
    await expect(source.readPage(0)).rejects.toThrow("disposed");
  });

  it("deletes prompt history with a session and keeps other sessions intact", async () => {
    const journal = store("purge");
    const keeper = store("keeper");
    await journal.append({ content: "Delete this prompt" });
    await keeper.append({ content: "Keep this prompt" });
    await saveSession([{ role: "user", content: "Delete this prompt" }], { sessionId: journal.sessionId });
    expect((await purgeSession(journal.sessionId)).deleted).toBe(true);
    expect(await journal.count()).toBe(0);
    expect(await keeper.count()).toBe(1);
  });

  it("clears prompt journals with all saved history, including prompt-only sessions", async () => {
    const journal = store("reset");
    await journal.append({ content: "Delete with /reset" });
    await clearAllHistory();
    expect(await journal.count()).toBe(0);
  });
});
