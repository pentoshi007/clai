import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";
import { loadQueuedPrompts, queuedPromptsPath, saveQueuedPrompts } from "../../src/store/session-queue.js";
import { registerKnownSecret, resetKnownSecrets } from "../../src/security/known-secrets.js";

const bun = findBunExecutable();
afterEach(() => resetKnownSecrets());
describe("session queue storage", () => {
  it("round-trips Unicode, removes consumed queues, and leaves no temporary files", () => {
    const id = "queue-storage";
    const entries = [{ id: 1, text: "日本語 🙂\nsecond line", displayPrompt: "visible" }, { id: 2, text: "hidden", displayPrompt: null }];
    expect(loadQueuedPrompts(id)).toEqual([]);
    saveQueuedPrompts(id, entries);
    expect(loadQueuedPrompts(id)).toEqual(entries);
    if (process.platform !== "win32") expect(statSync(queuedPromptsPath(id)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(queuedPromptsPath(id))).some((name) => name.endsWith(".tmp"))).toBe(false);
    saveQueuedPrompts(id, []);
    expect(existsSync(queuedPromptsPath(id))).toBe(false);
  });

  it("redacts registered secrets before storing prompts", () => {
    const secret = "fixture-secret-value-unique";
    registerKnownSecret(secret);
    saveQueuedPrompts("queue-redacted", [{ id: 1, text: `use ${secret}`, displayPrompt: `shown ${secret}` }]);
    expect(readFileSync(queuedPromptsPath("queue-redacted"), "utf8")).not.toContain(secret);
  });

  it.each([
    { version: 1, sessionId: "another-session", prompts: [] },
    { version: 2, sessionId: "queue-invalid", prompts: [] },
    { version: 1, sessionId: "queue-invalid", prompts: [{ id: 1, text: "" }] },
    { version: 1, sessionId: "queue-invalid", prompts: [{ id: 1, text: "a" }, { id: 1, text: "b" }] },
  ])("rejects malformed or wrongly owned queues", (body) => {
    const path = queuedPromptsPath("queue-invalid");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(body));
    expect(() => loadQueuedPrompts("queue-invalid")).toThrow();
  });

  it.skipIf(!bun || process.platform === "win32")("survives SIGKILL after dequeue without an exit handler or flush", () => {
    const result = spawnSync(bun!, ["run", fileURLToPath(new URL("../fixtures/queued-prompt-crash.ts", import.meta.url))], {
      env: process.env, encoding: "utf8", timeout: 15_000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBe("SIGKILL");
    expect(loadQueuedPrompts("queue-crash-fixture").map((entry) => entry.text)).toEqual(["survives abrupt termination"]);
  }, 20_000);
});
