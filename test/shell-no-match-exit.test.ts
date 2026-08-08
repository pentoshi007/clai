import { describe, expect, it } from "vitest";
import { shellExec } from "../src/tools/shell.js";

describe("shell exec — grep-family no-match exit classification", () => {
  it("treats grep exit 1 (no matches) as success with an explanatory note", async () => {
    const result = await shellExec({
      command: "printf 'a\\nb\\n' | grep zzz",
      noArtifact: true,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("no matching lines");
  });

  it("treats a compound command ending in a no-match grep as success", async () => {
    const result = await shellExec({
      command: "printf 'x\\n' | grep x; printf 'y\\n' | grep zzz",
      noArtifact: true,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("x");
    expect(result.output).toContain("no matching lines");
  });

  it("still fails when grep itself errors (exit 2)", async () => {
    const result = await shellExec({
      command: "grep zzz /nonexistent-path-xyz-123",
      noArtifact: true,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  it("still fails when the last stage is not grep-family", async () => {
    const result = await shellExec({
      command: "printf 'a\\n' | grep a; exit 1",
      noArtifact: true,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("sees through env assignments and sudo wrappers on the final stage", async () => {
    const result = await shellExec({
      command: "printf 'a\\n' | LC_ALL=C grep zzz",
      noArtifact: true,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(1);
  });
});
