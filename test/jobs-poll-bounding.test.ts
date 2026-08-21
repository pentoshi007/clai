import { describe, expect, it } from "vitest";
import {
  IDENTICAL_POLL_BLOCK_THRESHOLD,
  LoopGuard,
} from "../src/agent/loop-guard.js";
import { completedOperationObservationDigest } from "../src/agent/outcomes.js";
import { toolRegistry } from "../src/tools/registry.js";

const jobsLine = (elapsed: string, status = "running", exit = "?"): string =>
  `Session background jobs (1 total, session sess-abc):\n` +
  `[7df9d383] ${status} health=alive exit=${exit} ${elapsed}  gh run watch 32456711212 --repo owner/repo`;

describe("shell.jobs observation digest", () => {
  it("ignores elapsed drift so identical polls compare equal", () => {
    const digests = ["<1s", "43s", "1m43s", "1m47s", "2m10s"].map((elapsed) =>
      completedOperationObservationDigest("shell.jobs", jobsLine(elapsed)),
    );
    expect(new Set(digests).size).toBe(1);
  });

  it("still distinguishes a real status change", () => {
    expect(
      completedOperationObservationDigest("shell.jobs", jobsLine("2m10s")),
    ).not.toBe(
      completedOperationObservationDigest(
        "shell.jobs",
        jobsLine("2m10s", "exited", "0"),
      ),
    );
  });

  it("still distinguishes a new job appearing", () => {
    expect(
      completedOperationObservationDigest("shell.jobs", jobsLine("1m43s")),
    ).not.toBe(
      completedOperationObservationDigest(
        "shell.jobs",
        `${jobsLine("1m43s")}\n[aaaa1111] running health=alive exit=? 5s  npm run dev`,
      ),
    );
  });
});

describe("unbounded job polling regression", () => {
  it("bounds the transcript's repeated shell.jobs polls", () => {
    const guard = new LoopGuard();
    const elapsed = ["15s", "29s", "34s", "43s", "52s", "1m1s", "1m8s", "1m13s"];
    const blockedAt: number[] = [];
    elapsed.forEach((value, index) => {
      if (guard.shouldBlock("shell.jobs", {}).block) {
        blockedAt.push(index + 1);
        return;
      }
      guard.recordAttempt(index + 1, "shell.jobs", {}, true, 0, jobsLine(value));
    });
    expect(blockedAt[0]).toBe(IDENTICAL_POLL_BLOCK_THRESHOLD + 2);
    expect(guard.shouldBlock("shell.jobs", {}).reason).toContain("shell.wait");
  });

  it("keeps a genuinely progressing tail unblocked", () => {
    const guard = new LoopGuard();
    const args = { id: "7df9d383", stream: "stdout" };
    for (let step = 0; step < 30; step++) {
      expect(guard.shouldBlock("shell.tail", args).block).toBe(false);
      guard.recordAttempt(step, "shell.tail", args, true, 0, `line ${step}`);
    }
  });

  it("tracks each poll target separately", () => {
    const guard = new LoopGuard();
    for (let step = 0; step <= IDENTICAL_POLL_BLOCK_THRESHOLD; step++) {
      guard.recordAttempt(step, "shell.tail", { id: "job-a" }, true, 0, "same");
    }
    expect(guard.shouldBlock("shell.tail", { id: "job-a" }).block).toBe(true);
    expect(guard.shouldBlock("shell.tail", { id: "job-b" }).block).toBe(false);
  });
});

describe("shell.wait", () => {
  it("blocks until a finite job is terminal and reports its exit code", async () => {
    const started = await toolRegistry["shell.exec"]!(
      {
        command: "sleep 0.4; echo finished-work; exit 3",
        background: "always",
      },
      {},
    );
    const id = started.backgroundJob?.id;
    expect(id).toBeTruthy();

    const waited = await toolRegistry["shell.wait"]!({ id, timeoutMs: 30_000 }, {});
    expect(waited.output).toContain("failed");
    expect(waited.output).toContain("exit=3");
    expect(waited.output).toContain("finished-work");
    expect(waited.ok).toBe(false);
  }, 40_000);

  it("reports success for a job that exits cleanly", async () => {
    const started = await toolRegistry["shell.exec"]!(
      { command: "sleep 0.3; echo all-good", background: "always" },
      {},
    );
    const waited = await toolRegistry["shell.wait"]!(
      { id: started.backgroundJob?.id, timeoutMs: 30_000 },
      {},
    );
    expect(waited.output).toContain("exited");
    expect(waited.output).toContain("exit=0");
    expect(waited.output).toContain("all-good");
    expect(waited.ok).toBe(true);
  }, 40_000);

  it("reports a timeout without killing the job and tells the agent not to poll", async () => {
    const started = await toolRegistry["shell.exec"]!(
      { command: "sleep 20", background: "always" },
      {},
    );
    const id = started.backgroundJob?.id;
    const waited = await toolRegistry["shell.wait"]!({ id, timeoutMs: 1_000 }, {});
    expect(waited.output).toContain("still running");
    expect(waited.output).toContain("Do not poll");
    await toolRegistry["shell.stop"]!({ id }, {});
  }, 30_000);

  it("fails clearly for an unknown job id", async () => {
    const result = await toolRegistry["shell.wait"]!({ id: "nope1234" }, {});
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not found");
  });
});
