import { beforeEach, describe, expect, it, vi } from "vitest";

const materialized = vi.fn();
const cancelled = vi.fn();
const extractRoot = vi.fn();

vi.mock("../../src/agent/workspace-orient.js", () => ({
  scaffoldLooksMaterialized: (...args: unknown[]) => materialized(...args),
  isScaffoldCancelledOutput: (...args: unknown[]) => cancelled(...args),
}));
vi.mock("../../src/agent/project-root.js", () => ({
  extractProjectRootFromScaffold: (...args: unknown[]) => extractRoot(...args),
}));

const { reconcileScaffoldOutcome } = await import(
  "../../src/agent/turn/scaffold-outcome.js"
);

const command = "npm create vite@latest app -- --template react";
const call = { name: "shell.exec", args: { command } };

beforeEach(() => {
  materialized.mockReset().mockReturnValue(false);
  cancelled.mockReset().mockReturnValue(false);
  extractRoot.mockReset().mockReturnValue(undefined);
});

describe("scaffold outcome", () => {
  it("leaves non-scaffold calls untouched", () => {
    const result = { ok: true, output: "ok" };
    expect(
      reconcileScaffoldOutcome({ name: "fs.read", args: { command } }, result),
    ).toEqual({ result, adoptRoot: undefined, notice: undefined });
    expect(extractRoot).not.toHaveBeenCalled();
  });

  it("treats a cancelled scaffold with a usable tree as resumable", () => {
    extractRoot.mockReturnValue("/work/app");
    materialized.mockReturnValue(true);
    cancelled.mockReturnValue(true);
    const outcome = reconcileScaffoldOutcome(call, {
      ok: false,
      output: "operation cancelled",
      exitCode: 1,
    });
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.exitCode).toBe(0);
    expect(outcome.result.output).toContain("cancellation/refusal");
    expect(outcome.result.output).toContain("do NOT re-run the scaffolder");
    expect(outcome.adoptRoot).toBe("/work/app");
    expect(outcome.notice).toBe(
      "project root → /work/app (existing materialized scaffold — continue)",
    );
  });

  it("treats a mid-run timeout with a usable tree as resumable interruption", () => {
    extractRoot.mockReturnValue("/work/app");
    materialized.mockReturnValue(true);
    const outcome = reconcileScaffoldOutcome(call, {
      ok: false,
      output: "command timed out",
      exitCode: 124,
    });
    expect(outcome.result.output).toContain("interruption");
    expect(outcome.adoptRoot).toBe("/work/app");
  });

  it("fails a reported-cancel scaffold with no tree", () => {
    cancelled.mockReturnValue(true);
    extractRoot.mockReturnValue("/work/app");
    const outcome = reconcileScaffoldOutcome(call, { ok: true, output: "meh" });
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.exitCode).toBe(1);
    expect(outcome.result.output).toContain(
      "Scaffold FAILED: tool reported cancel/refuse.",
    );
    expect(outcome.result.output).toContain("Expected project at /work/app.");
    expect(outcome.adoptRoot).toBeUndefined();
  });

  it("fails a silent success that created nothing", () => {
    const outcome = reconcileScaffoldOutcome(call, { ok: true, output: "done" });
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.output).toContain(
      "Scaffold FAILED: target project tree was not created.",
    );
  });

  it("adopts a claimed scaffold whose tree is not yet visible", () => {
    extractRoot.mockReturnValue("/work/app");
    const outcome = reconcileScaffoldOutcome(call, {
      ok: true,
      output: "Scaffolding project in /work/app...",
    });
    expect(outcome.result.ok).toBe(true);
    expect(outcome.adoptRoot).toBe("/work/app");
    expect(outcome.notice).toBe(
      "project root → /work/app (scaffold output claimed success — continue)",
    );
  });

  it("adopts a plain successful scaffold", () => {
    extractRoot.mockReturnValue("/work/app");
    materialized.mockReturnValue(true);
    const result = { ok: true, output: "created" };
    const outcome = reconcileScaffoldOutcome(call, result);
    expect(outcome.result).toBe(result);
    expect(outcome.adoptRoot).toBe("/work/app");
    expect(outcome.notice).toBe("project root → /work/app");
  });

  it("prefers the path reported by the scaffolder output", () => {
    extractRoot.mockReturnValue("/work/guess");
    materialized.mockReturnValue(true);
    const outcome = reconcileScaffoldOutcome(call, {
      ok: true,
      output: "Scaffolding project in /work/reported...",
    });
    expect(outcome.adoptRoot).toBe("/work/reported");
  });

  it("keeps a plain failure unchanged when nothing was created", () => {
    const result = { ok: false, output: "boom", exitCode: 2 };
    expect(reconcileScaffoldOutcome(call, result).result).toBe(result);
  });
});
