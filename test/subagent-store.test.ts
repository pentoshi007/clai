import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSubagentStore, restoreSubagentRun, sanitizeSubagentRun, sanitizeSubagentText, SUBAGENT_LIMITS } from "../src/store/subagents.js";
import { SubagentManager } from "../src/agent/subagents/manager.js";
import type { SubagentRun } from "../src/agent/subagents/types.js";

const roots: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clai-subagents-"));
  roots.push(root);
  return { root, store: new FileSubagentStore(root), directory: (parent = "parent") => join(root, "subagents", hash(parent)) };
}
function run(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return { id: "child", parentSessionId: "parent", title: "Research", prompt: "Read code", cwd: "/tmp", provider: "openai", model: "test", attempt: 1, status: "completed", createdAt: 1, updatedAt: 2, events: [], report: "Findings", ...overrides };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("FileSubagentStore", () => {
  it("round-trips generated session IDs without changing content redaction", () => {
    const { store } = fixture();
    const parentSessionId = "sess-mtwvqvsk-abcdef";
    store.save(run({ parentSessionId, prompt: "Inspect sk-secretvalue" }));
    expect(store.load(parentSessionId)[0]).toMatchObject({ parentSessionId, prompt: "Inspect sk-••••••" });
    expect(sanitizeSubagentText(parentSessionId)).toBe("sess-mtwvqvsk-••••••");
    expect(() => store.save(run({ parentSessionId: "sk-secretvalue" }))).toThrow("Invalid subagent record");
  });

  it("atomically stores private redacted records in parent-separated hashed directories", () => {
    const { store, directory } = fixture();
    store.save(run({ title: "\x1b[31mResearch\x1b[0m", prompt: "sk-secretprompt", context: "password=private", report: "sk-secretreport\x1b]52;c;attack\x07", events: [{ kind: "tool", text: "Authorization: Bearer secretvalue", sequence: 1, timestamp: 1 }] }));
    store.save(run({ parentSessionId: "another", report: "Other parent findings" }));
    const files = readdirSync(directory());
    expect(files).toEqual([`${hash("child")}.json`]);
    const content = readFileSync(join(directory(), files[0]!), "utf8");
    expect(content).not.toMatch(/secretprompt|secretreport|private|secretvalue|attack/);
    expect(content).not.toContain("\\u001b");
    expect(store.load("parent")[0]).toMatchObject({ title: "Research", report: "sk-••••••" });
    expect(store.load("another")[0]?.report).toBe("Other parent findings");
    if (process.platform !== "win32") {
      expect(statSync(directory()).mode & 0o777).toBe(0o700);
      expect(statSync(join(directory(), files[0]!)).mode & 0o777).toBe(0o600);
    }
    store.remove("parent");
    expect(store.load("parent")).toEqual([]);
    expect(store.load("another")).toHaveLength(1);
  });

  it("restores running and stopping records as interrupted, never completed", () => {
    const { store } = fixture();
    store.save(run({ status: "running", report: undefined }));
    store.save(run({ id: "stopping", status: "stopping", report: undefined }));
    for (const restored of store.load("parent")) {
      expect(restored.status).toBe("stopped");
      expect(restored.error).toMatch(/Interrupted/);
      expect(restored.report).toBeUndefined();
      expect(restored.events.at(-1)?.text).toMatch(/restart explicitly/);
    }
  });

  it("retains partial status and exposes history recovery rather than a nonexistent exact checkpoint", () => {
    const { store, directory } = fixture();
    const report = "Status: partial\nBounded prior-attempt findings";
    store.save({ ...run({ status: "partial", report, recovery: "exact" }), checkpoint: { messages: [{ content: "private provider artifact" }] } } as SubagentRun);
    expect(store.load("parent")[0]).toMatchObject({ status: "partial", report, recovery: "history" });
    expect(readFileSync(join(directory(), `${hash("child")}.json`), "utf8")).not.toMatch(/checkpoint|messages|private provider artifact/);
    store.save(run({ id: "fresh", events: [], report: undefined, recovery: "exact" }));
    expect(store.load("parent").find((child) => child.id === "fresh")?.recovery).toBe("fresh");
  });

  it("ignores corrupt, oversized, cross-parent, symlinked, and mismatched records", () => {
    const { root, store, directory } = fixture();
    store.save(run());
    const file = (id: string) => join(directory(), `${hash(id)}.json`);
    writeFileSync(file("corrupt"), "{");
    writeFileSync(file("oversized"), "");
    truncateSync(file("oversized"), 6 * (SUBAGENT_LIMITS.report + SUBAGENT_LIMITS.chars) + 65_537);
    writeFileSync(file("foreign"), JSON.stringify(run({ id: "foreign", parentSessionId: "elsewhere" })));
    writeFileSync(file("mismatch"), JSON.stringify(run({ id: "different" })));
    writeFileSync(file("invalid"), JSON.stringify(run({ id: "invalid", events: [{ kind: "tool", text: "x", timestamp: 1, sequence: -1 }] })));
    const outside = join(root, "outside.json");
    writeFileSync(outside, JSON.stringify(run({ id: "link" })));
    symlinkSync(outside, file("link"));
    expect(store.load("parent").map((child) => child.id)).toEqual(["child"]);
  });

  it("rejects symlinked parent directories without touching their target", () => {
    const { root, store, directory } = fixture();
    store.save(run());
    const original = readFileSync(join(directory(), `${hash("child")}.json`), "utf8");
    const link = join(root, "subagents", hash("linked"));
    symlinkSync(directory(), link, "dir");
    expect(() => store.save(run({ parentSessionId: "linked" }))).toThrow(/Unsafe/);
    expect(() => store.remove("linked")).toThrow(/Unsafe/);
    expect(readFileSync(join(directory(), `${hash("child")}.json`), "utf8")).toBe(original);
  });

  it("retains at most 24 children and bounds restored event text", () => {
    const { store, directory } = fixture();
    for (let index = 0; index < 40; index++) store.save(run({ id: `child-${index}`, updatedAt: index }));
    expect(readdirSync(directory())).toHaveLength(24);
    expect(store.load("parent")).toHaveLength(24);
    const events = Array.from({ length: 96 }, (_, sequence) => ({ kind: "assistant" as const, sequence, timestamp: 1, text: "x".repeat(6000) }));
    store.save(run({ id: "large", events, report: "r".repeat(24000) }));
    const restored = store.load("parent").find((child) => child.id === "large")!;
    expect(restored).toBeDefined();
    expect(restored.events.reduce((sum, event) => sum + event.text.length, 0)).toBeLessThan(128000);
    expect(restored.report).toBe("r".repeat(24000));
  });

  it("retains large reports independently of bounded activity history", () => {
    const { store, directory } = fixture();
    const report = `Verified evidence\n${'"\\é\n'.repeat(300_000)}\nFinal citation: src/worker.ts:42\npassword=private`;
    const expected = sanitizeSubagentText(report);
    const events = [{ kind: "tool" as const, text: "Read src/worker.ts:42", sequence: 1, timestamp: 1 }];
    store.save(run({ report, events }));
    expect(statSync(join(directory(), `${hash("child")}.json`)).size).toBeGreaterThan(1_048_576);
    const restored = store.load("parent")[0]!;
    expect(restored.report).toBe(expected);
    expect(restored.report).toContain("Final citation: src/worker.ts:42");
    expect(restored.report).not.toContain("private");
    expect(restored.events).toEqual(events);
    expect(sanitizeSubagentRun(restored).report).toBe(expected);
  });

  it("rejects oversized reports rather than silently truncating evidence", () => {
    const { store } = fixture();
    store.save(run({ report: "Retained report" }));
    const report = "😀".repeat(SUBAGENT_LIMITS.report / 4 + 1);
    expect(report.length).toBeLessThan(SUBAGENT_LIMITS.report);
    expect(() => sanitizeSubagentRun(run({ report }))).toThrow("storage safety limit");
    expect(() => store.save(run({ report }))).toThrow("Invalid subagent record");
    expect(restoreSubagentRun(run({ report }), "parent")).toBeUndefined();
    expect(store.load("parent")[0]!.report).toBe("Retained report");
  });

  it("persists immutable sanitized follow-ups without unexpected fields", () => {
    const { store, directory } = fixture();
    const followup = { prompt: "Inspect the caller\x1b[31m", context: "api_key=private-token", extra: "hidden secret" };
    store.save(run({ followup }));
    followup.prompt = "Changed after saving";
    const persisted = readFileSync(join(directory(), `${hash("child")}.json`), "utf8");
    expect(persisted).not.toMatch(/private-token|hidden secret|Changed after saving/);
    const restored = store.load("parent")[0]!;
    expect(restored.followup).toEqual({ prompt: "Inspect the caller", context: "api_key=[redacted]" });
    expect(Object.isFrozen(restored.followup)).toBe(true);
    expect(sanitizeSubagentRun(restored).followup).toEqual(restored.followup);
  });

  it.each([
    null, [], "prompt", 1, {}, { prompt: 1 }, { context: false },
    { prompt: "" }, { context: " " }, { prompt: "\x1b[31m" },
    { prompt: "x".repeat(SUBAGENT_LIMITS.prompt + 1) },
    { context: "x".repeat(SUBAGENT_LIMITS.context + 1) },
  ])("rejects invalid persisted follow-ups ($#)", (followup) => {
    const { store } = fixture();
    const value = { ...run(), followup };
    expect(restoreSubagentRun(value, "parent")).toBeUndefined();
    expect(() => store.save(value as SubagentRun)).toThrow("Invalid subagent record");
  });

  it.each([{ prompt: "Inspect the caller" }, { context: "The caller changed" }])("restores optional follow-up fields (%j)", (followup) => {
    const { store } = fixture();
    store.save(run({ followup, status: "running" }));
    expect(store.load("parent")[0]).toMatchObject({ status: "stopped", followup });
  });

  it("budgets durable follow-up instructions before retaining event text", () => {
    const source = run({
      followup: { prompt: "p".repeat(SUBAGENT_LIMITS.prompt), context: "c".repeat(SUBAGENT_LIMITS.context) },
      events: [{ kind: "tool", sequence: 1, timestamp: 1, text: "e".repeat(SUBAGENT_LIMITS.chars) }],
    });
    const withFollowup = sanitizeSubagentRun(source);
    const withoutFollowup = sanitizeSubagentRun({ ...source, followup: undefined });
    expect(withFollowup.followup).toEqual(source.followup);
    expect(withoutFollowup.events[0]!.text.length - withFollowup.events[0]!.text.length).toBe(SUBAGENT_LIMITS.prompt + SUBAGENT_LIMITS.context);
    const { store } = fixture();
    store.save(source);
    expect(store.load("parent")[0]!.followup).toEqual(source.followup);
  });

  it("drops unexpected fields rather than persisting extra secret data", () => {
    const { store, directory } = fixture();
    store.save({ ...run(), unexpected: "hidden secret" } as SubagentRun);
    expect(readFileSync(join(directory(), `${hash("child")}.json`), "utf8")).not.toContain("hidden secret");
  });

  it("redacts quoted credentials, partial streamed values, private keys, and basic authentication", () => {
    const text = '{"api_key":"privatekey", "password": "privatepassword"}\naccess_token=privatetoken\nAuthorization: Basic privatebasic\nws-shortsecret\n-----BEGIN RSA PRIVATE KEY-----\nprivatepem';
    expect(sanitizeSubagentText(text)).not.toMatch(/privatekey|privatepassword|privatetoken|privatebasic|shortsecret|privatepem/);
    expect(sanitizeSubagentText('{"client_secret":"partialvalue')).not.toContain("partialvalue");
    expect(sanitizeSubagentText(sanitizeSubagentText(text))).toBe(sanitizeSubagentText(text));
  });

  it("rejects credential-like identifiers rather than exposing them as metadata", () => {
    const { store } = fixture();
    expect(() => store.save(run({ parentSessionId: "sk-privateparent" }))).toThrow(/Invalid/);
    expect(() => store.save(run({ id: "sk-privatechild" }))).toThrow(/Invalid/);
  });

  it("retains active records separately from settled history", () => {
    const { store, directory } = fixture();
    store.save(run({ id: "active", status: "running", updatedAt: 0, report: undefined }));
    store.save(run({ id: "stopping", status: "stopping", updatedAt: 0, report: undefined }));
    for (let index = 0; index < 35; index++) store.save(run({ id: `done-${index}`, updatedAt: index + 1 }));
    expect(readdirSync(directory())).toHaveLength(26);
    const restored = store.load("parent");
    expect(restored.find((child) => child.id === "active")?.status).toBe("stopped");
    expect(restored.find((child) => child.id === "stopping")?.status).toBe("stopped");
    expect(restored.some((child) => child.id === "done-0")).toBe(false);
  });

  it("restores all retained history when a live manager reaches capacity", async () => {
    const { store } = fixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(123);
    const manager = new SubagentManager("parent", {
      store,
      worker: async ({ run, signal }) => {
        if (run.title !== "Active") return "Complete";
        return new Promise<string>((resolve) => signal.addEventListener("abort", () => resolve("Late"), { once: true }));
      },
    });
    try {
      manager.setEnabled(true);
      const active = manager.start({ ...run(), title: "Active" });
      for (let index = 0; index < 23; index++) {
        await manager.wait(manager.start({ ...run(), title: `Completed ${index}`, prompt: `Task ${index}` }).id);
      }
      await manager.wait(manager.start({ ...run(), prompt: "Another task" }).id);
      const restored = store.load("parent");
      expect(restored.map((child) => child.id).sort()).toEqual(manager.list().map((child) => child.id).sort());
      expect(restored.find((child) => child.id === active.id)?.status).toBe("stopped");
    } finally {
      manager.dispose();
      clock.mockRestore();
    }
  });

  it("restores every interrupted assignment even above the history retention count", () => {
    const { store, directory } = fixture();
    for (let index = 0; index < 30; index++) store.save(run({ id: `active-${index}`, status: "running", report: undefined }));
    expect(readdirSync(directory())).toHaveLength(30);
    const manager = new SubagentManager("parent", { store });
    try {
      expect(manager.list()).toHaveLength(30);
      expect(manager.list().every((child) => child.status === "stopped")).toBe(true);
      expect(manager.pendingResults()).toEqual([]);
    } finally {
      manager.dispose();
    }
  });
});
