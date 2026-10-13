import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavedPromptReader, SessionPromptStore } from "../../src/store/session-prompts.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "clai-prompt-recall-"));
  vi.stubEnv("CLAI_HISTORY_DIR", root);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe("saved prompt recall", () => {
  it("reads complete prompts from a closed session in a fresh launch", async () => {
    const closed = new SessionPromptStore("closed-session");
    const first = "First prompt\n    Preserve indentation\n\n> Preserve user quotes\n🙂 保留文本";
    await closed.append({ content: first });
    const last = `Complete long prompt\n${"large body line\n".repeat(10000)}LAST_LINE`;
    await closed.append({ content: last });
    const reader = createSavedPromptReader(new SessionPromptStore(closed.sessionId));
    expect(await reader.readOlder()).toBe(last);
    expect(await reader.readOlder()).toBe(first);
    expect(await reader.readOlder()).toBeUndefined();
  });

  it("freezes current-launch disk entries so submitted prompts are not recalled twice", async () => {
    const current = new SessionPromptStore("resumed-session");
    await current.append({ content: "Saved before reopening" });
    const reader = createSavedPromptReader(current);
    await current.append({ content: "New prompt already in composer memory" });
    expect(await reader.readOlder()).toBe("Saved before reopening");
    expect(await reader.readOlder()).toBeUndefined();
  });

  it("only recalls the active session even when another session has newer prompts", async () => {
    const old = new SessionPromptStore("older-session");
    const recent = new SessionPromptStore("recent-session");
    await old.seed([{ content: "Old one" }, { content: "Old two" }]);
    await recent.seed([{ content: "Recent one" }, { content: "Recent two" }]);
    const reader = createSavedPromptReader(new SessionPromptStore(old.sessionId));
    expect(await reader.readOlder()).toBe("Old two");
    expect(await reader.readOlder()).toBe("Old one");
    expect(await reader.readOlder()).toBeUndefined();
    expect(await createSavedPromptReader(new SessionPromptStore("fresh-session")).readOlder()).toBeUndefined();
  });

  it("includes a pending legacy import but excludes later submissions", async () => {
    const current = new SessionPromptStore("legacy-session");
    const importing = current.seed([{ content: "Imported one" }, { content: "Imported two" }]);
    const reader = createSavedPromptReader(current);
    await current.append({ content: "New in-memory submission" });
    await importing;
    expect(await reader.readOlder()).toBe("Imported two");
    expect(await reader.readOlder()).toBe("Imported one");
    expect(await reader.readOlder()).toBeUndefined();
  });

  it("does not fall back to another session when the active journal is corrupt", async () => {
    const good = new SessionPromptStore("good-session");
    await good.append({ content: "Usable saved prompt" });
    const corrupt = new SessionPromptStore("corrupt-session");
    await corrupt.append({ content: "Broken metadata" });
    await writeFile(join(dirname(corrupt.path), "metadata.jsonl"), "bad metadata\n");
    const reader = createSavedPromptReader(corrupt);
    expect(await reader.readOlder()).toBeUndefined();
  });
});
