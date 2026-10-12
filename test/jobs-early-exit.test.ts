import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  return {
    ...actual,
    spawn: () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        pid: process.pid, stdout, stderr, unref: vi.fn(), exitCode: null as number | null,
      });
      let closing = false;
      child.on("newListener", (event: string | symbol) => {
        if (event !== "close" || closing) return;
        closing = true;
        queueMicrotask(() => {
          stderr.write("fixture: missing command\n");
          stdout.end();
          stderr.end();
          child.exitCode = 127;
          child.emit("close", 127, null);
        });
      });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  };
});

const { JobManager } = await import("../src/tools/jobs.js");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("early shell-close receipts", () => {
  it.each([false, true])("reports an observed exit 127 without a launch-success receipt (Responder: %s)", async (responder) => {
    const root = await mkdtemp(join(tmpdir(), "clai-job-early-close-"));
    roots.push(root);
    const manager = new JobManager(root);
    const result = await manager.startJob("missing-command-fixture", { responder, ownerSessionId: "early-close" });
    expect(result).toMatchObject({ ok: false, exitCode: 127 });
    expect(result.backgroundJob).toMatchObject({ status: "failed", exitCode: 127 });
    expect(result.output).toContain("failed immediately");
    expect(result.output).not.toContain("OS process launch confirmed");
    if (responder) {
      expect(result.backgroundJob).toMatchObject({ responder: true });
      expect(result.output).toContain("Responder owns this terminal failure");
      expect(result.output).toContain("do not poll or retry");
    } else {
      expect(result.output).toContain("do not retry unchanged");
    }
    expect(manager.getJob(result.backgroundJob!.id)).toMatchObject({ status: "failed", exitCode: 127 });
    expect(manager.getRunningJobs()).toHaveLength(0);
  });
});
