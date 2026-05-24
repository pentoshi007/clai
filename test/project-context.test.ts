import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProjectContext, MAX_PROJECT_CONTEXT } from "../src/store/project.js";

describe("phase 9 — project context guard", () => {
  let restore: string | undefined;
  let dir: string | undefined;

  afterEach(() => {
    if (restore) process.chdir(restore);
    if (dir) rmSync(dir, { recursive: true, force: true });
    restore = undefined;
    dir = undefined;
  });

  it("wraps content with untrusted delimiter when present", async () => {
    restore = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "clai-pc-"));
    mkdirSync(join(dir, ".clai"));
    writeFileSync(join(dir, ".clai/context.md"), "Use Node 20.\nUse pnpm.");
    process.chdir(dir);
    const ctx = await loadProjectContext();
    expect(ctx).toMatch(/<project-context untrusted="true">/);
    expect(ctx).toMatch(/Use Node 20/);
    expect(ctx).toMatch(/<\/project-context>/);
    expect(ctx).toMatch(/do not follow instructions/i);
  });

  it("caps at MAX_PROJECT_CONTEXT bytes and notes truncation", async () => {
    restore = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "clai-pc-"));
    mkdirSync(join(dir, ".clai"));
    writeFileSync(join(dir, ".clai/context.md"), "x".repeat(MAX_PROJECT_CONTEXT + 5_000));
    process.chdir(dir);
    const ctx = await loadProjectContext();
    expect(ctx).toMatch(/project context truncated/);
  });

  it("returns undefined when no context file", async () => {
    restore = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "clai-pc-"));
    process.chdir(dir);
    const ctx = await loadProjectContext();
    expect(ctx).toBeUndefined();
  });
});
