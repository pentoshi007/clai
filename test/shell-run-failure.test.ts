import { describe, expect, it } from "vitest";
import { shellExec } from "../src/tools/shell.js";

describe("shell exec — run failure vs command failure classification", () => {
  it("marks a completed command with a non-zero exit as a command outcome, not a run failure", async () => {
    const result = await shellExec({
      command: "exit 3",
      noArtifact: true,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.runFailure).toBe(false);
  });

  it("marks a zero-exit command as ok with no run failure", async () => {
    const result = await shellExec({
      command: "printf ok",
      noArtifact: true,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.runFailure).toBe(false);
  });

  it("marks a timeout as a run failure", async () => {
    const result = await shellExec({
      command: "sleep 30",
      noArtifact: true,
      timeoutMs: 500,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(result.runFailure).toBe(true);
  }, 15_000);

  it("marks an invalid working directory as a run failure", async () => {
    const result = await shellExec({
      command: "true",
      cwd: "/nonexistent-dir-xyz-123",
      noArtifact: true,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.runFailure).toBe(true);
  });
});
