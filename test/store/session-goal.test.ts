import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSessionGoal, saveSessionGoal, sessionGoalPath } from "../../src/store/session-goal.js";
import { registerKnownSecret, resetKnownSecrets } from "../../src/security/known-secrets.js";

afterEach(() => resetKnownSecrets());

describe("session goal storage", () => {
  it("round-trips active and paused goals and removes cleared ones", () => {
    const id = "goal-storage";
    expect(loadSessionGoal(id)).toBeUndefined();
    const active = { id: "g1", objective: "all tests pass 🙂", status: "active" as const, createdAt: 1 };
    saveSessionGoal(id, active);
    expect(loadSessionGoal(id)).toEqual(active);
    if (process.platform !== "win32") expect(statSync(sessionGoalPath(id)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(sessionGoalPath(id))).some((name) => name.endsWith(".tmp"))).toBe(false);
    const paused = { ...active, status: "paused" as const, pause: { reason: "you ran /goal pause", resumeOnPrompt: false } };
    saveSessionGoal(id, paused);
    expect(loadSessionGoal(id)).toEqual(paused);
    saveSessionGoal(id, undefined);
    expect(existsSync(sessionGoalPath(id))).toBe(false);
  });

  it("redacts registered secrets", () => {
    const secret = "goal-fixture-secret-value";
    registerKnownSecret(secret);
    saveSessionGoal("goal-redacted", { id: "g", objective: `deploy with ${secret}`, status: "active", createdAt: 1 });
    expect(readFileSync(sessionGoalPath("goal-redacted"), "utf8")).not.toContain(secret);
  });

  it.each([
    { version: 1, sessionId: "other", goal: { id: "g", objective: "x", status: "active", createdAt: 1 } },
    { version: 2, sessionId: "goal-invalid", goal: { id: "g", objective: "x", status: "active", createdAt: 1 } },
    { version: 1, sessionId: "goal-invalid", goal: { id: "g", objective: " ", status: "active", createdAt: 1 } },
    { version: 1, sessionId: "goal-invalid", goal: { id: "g", objective: "x", status: "achieved", createdAt: 1 } },
    { version: 1, sessionId: "goal-invalid", goal: { id: "g", objective: "x".repeat(4001), status: "active", createdAt: 1 } },
  ])("rejects malformed or wrongly owned goals", (body) => {
    const path = sessionGoalPath("goal-invalid");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(body));
    expect(() => loadSessionGoal("goal-invalid")).toThrow();
  });
});
