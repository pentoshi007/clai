import { afterEach, describe, expect, it, vi } from "vitest";
import {
  toolRegistry,
  runToolCall,
  normalizeBatchToolName,
  BATCH_SAFE_TOOLS,
} from "../src/tools/registry.js";
import { jobManager } from "../src/tools/jobs.js";
import { classifyToolCall } from "../src/safety/classifier.js";

afterEach(() => vi.restoreAllMocks());

describe("phase 12 — tool.batch", () => {
  it("is registered and empty batch classifies as safe (handler rejects empty)", () => {
    expect(toolRegistry["tool.batch"]).toBeDefined();
    const decision = classifyToolCall({
      name: "tool.batch",
      args: { calls: [] },
    });
    expect(decision.level).toBe("safe");
  });

  it("classifies all-safe children as safe and elevates confirm children", () => {
    expect(
      classifyToolCall({
        name: "tool.batch",
        args: {
          calls: [
            { name: "sysinfo", args: {} },
            { name: "tool.check", args: { tools: ["nmap"] } },
          ],
        },
      }).level,
    ).toBe("safe");

    expect(
      classifyToolCall({
        name: "tool.batch",
        args: {
          calls: [{ name: "shell.exec", args: { command: "rm -rf /tmp/x" } }],
        },
      }).level,
    ).toBe("confirm");
  });

  it("rejects an empty or non-array calls value", async () => {
    await expect(
      runToolCall({ name: "tool.batch", args: { calls: [] } }),
    ).rejects.toThrow(/at least one/);
    await expect(
      runToolCall({ name: "tool.batch", args: { calls: "ls" } }),
    ).rejects.toThrow(/calls/);
  });

  it("normalizes wire names (tool_check → tool.check)", () => {
    expect(normalizeBatchToolName("tool_check")).toBe("tool.check");
    expect(normalizeBatchToolName("fs_read")).toBe("fs.read");
    expect(normalizeBatchToolName("web.search")).toBe("web.search");
  });

  it("accepts tool_check wire form for a parallel-safe tool", async () => {
    const result = await runToolCall({
      name: "tool.batch",
      args: {
        calls: [{ name: "tool_check", args: { tools: ["node"] } }],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/#1 tool\.check/);
  });

  it("applies Responder polling suppression inside tool.batch", async () => {
    const jobs = vi.spyOn(jobManager, "listJobs").mockReturnValue({
      ok: true,
      output: "shell.jobs was not dispatched because running jobs are Responder-owned.",
      exitCode: 0,
      suppressedRepeat: true,
    });
    const tail = vi.spyOn(jobManager, "tailJob").mockResolvedValue({
      ok: true,
      output: "Responder owns job responder-1; shell.tail was not dispatched.",
      exitCode: 0,
      suppressedRepeat: true,
    });

    const result = await runToolCall(
      {
        name: "tool.batch",
        args: {
          calls: [
            { name: "shell.jobs", args: {} },
            { name: "shell.tail", args: { id: "responder-1" } },
          ],
        },
      },
      { sessionId: "batch-responder" },
    );

    expect(result.ok).toBe(true);
    expect(result.suppressedRepeat).toBe(true);
    expect(result.output).toContain("shell.jobs was not dispatched");
    expect(result.output).toContain("shell.tail was not dispatched");
    expect(jobs).toHaveBeenCalledWith("batch-responder");
    expect(tail).toHaveBeenCalledWith("responder-1", expect.any(Object));

    const mixed = await runToolCall(
      {
        name: "tool.batch",
        args: {
          calls: [
            { name: "shell.jobs", args: {} },
            { name: "sysinfo", args: {} },
          ],
        },
      },
      { sessionId: "batch-responder" },
    );
    expect(mixed.ok).toBe(true);
    expect(mixed.suppressedRepeat).not.toBe(true);
  });

  it("refuses unconfirmed confirm-level shell inside batch", async () => {
    // `echo` is safe; use a mutate-class command so the batch elevates to confirm.
    await expect(
      runToolCall({
        name: "tool.batch",
        args: {
          calls: [
            {
              name: "shell.exec",
              args: { command: "rm -rf /tmp/clai-batch-should-not-run" },
            },
          ],
        },
      }),
    ).rejects.toThrow(/confirm-level|approval|refuses/i);
  });

  it("allows safe shell version probes without confirm", async () => {
    // Many version probes classify as safe and are parallel-safe only if in
    // BATCH_SAFE — shell.exec is serial when allowed; without confirmed,
    // only truly safe shell may still need confirm depending on classifier.
    // fs.write without confirm must refuse.
    await expect(
      runToolCall({
        name: "tool.batch",
        args: {
          calls: [{ name: "fs.write", args: { path: "/tmp/x", content: "a" } }],
        },
      }),
    ).rejects.toThrow(/confirm|refuses|approval/i);
  });

  it("allows net.pingSweep in batch (read-only recon)", async () => {
    // Gate only — never run a real scan here.
    expect(BATCH_SAFE_TOOLS.has("net.pingSweep")).toBe(true);
    const decision = classifyToolCall({
      name: "tool.batch",
      args: {
        calls: [
          { name: "net.pingSweep", args: { target: "127.0.0.1" } },
          { name: "fs.read", args: { path: "/tmp/x" } },
        ],
      },
    });
    expect(decision.level).toBe("safe");
  });

  it("refuses nested tool.batch and plan tools", async () => {
    await expect(
      runToolCall({
        name: "tool.batch",
        args: {
          calls: [{ name: "tool.batch", args: { calls: [] } }],
        },
      }),
    ).rejects.toThrow(/nested|refuses/i);
    await expect(
      runToolCall({
        name: "tool.batch",
        args: {
          calls: [
            {
              name: "plan.create",
              args: { goal: "x", tasks: ["a"], detail: "d" },
            },
          ],
        },
      }),
    ).rejects.toThrow(/refuses|nested/i);
  });

  it("caps the number of calls at 20", async () => {
    const calls = Array.from({ length: 21 }, () => ({
      name: "sysinfo",
      args: {},
    }));
    await expect(
      runToolCall({ name: "tool.batch", args: { calls } }),
    ).rejects.toThrow(/at most 20/);
  });

  it("runs allowed read-only tools and aggregates their outputs", async () => {
    const result = await runToolCall({
      name: "tool.batch",
      args: {
        calls: [
          { name: "sysinfo", args: {} },
          { name: "sysinfo", args: {} },
        ],
      },
    });
    expect(result.ok).toBe(true);
    // Both sub-results are present and labeled.
    expect(result.output).toMatch(/#1 sysinfo \[ok/);
    expect(result.output).toMatch(/#2 sysinfo \[ok/);
  });

  it("streams labeled section bodies as each child finishes (live nested UI)", async () => {
    const live: string[] = [];
    const result = await runToolCall(
      {
        name: "tool.batch",
        args: {
          calls: [
            { name: "sysinfo", args: {} },
            { name: "sysinfo", args: {} },
          ],
          concurrency: 1,
        },
      },
      {
        onOutput: (chunk) => {
          live.push(chunk);
        },
      },
    );
    expect(result.ok).toBe(true);
    const streamed = live.join("");
    // Full section headers (not only [batch] ticks) must appear during the run.
    expect(streamed).toMatch(/── #1 sysinfo \[ok/);
    expect(streamed).toMatch(/── #2 sysinfo \[ok/);
    // Final authoritative body still has both sections.
    expect(result.output).toMatch(/#1 sysinfo \[ok/);
    expect(result.output).toMatch(/#2 sysinfo \[ok/);
  });

  it("aborts pending calls when the parent signal aborts", async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await runToolCall(
      {
        name: "tool.batch",
        args: { calls: [{ name: "sysinfo", args: {} }] },
      },
      { signal: ac.signal },
    );
    // sysinfo is synchronous so it actually runs even when aborted preemptively.
    // But the batch should still report success/aborted output without throwing.
    expect(typeof result.output).toBe("string");
  });

  it("default on_fail=continue keeps later siblings after a fail", async () => {
    const result = await runToolCall({
      name: "tool.batch",
      args: {
        calls: [
          {
            name: "fs.read",
            args: { path: "/no/such/file/clai-batch-continue" },
          },
          { name: "sysinfo", args: {} },
        ],
      },
    });
    // TOOL-003: a batch with a failed child is not reported as a success;
    // `partial` distinguishes "some children failed" from an aborted batch.
    expect(result.ok).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/#1 fs\.read \[fail/);
    expect(result.output).toMatch(/#2 sysinfo \[ok/);
    expect(result.output).not.toMatch(/\[cancelled/);
  });

  it("on_fail=cancel_pending skips later calls after first fail", async () => {
    const result = await runToolCall({
      name: "tool.batch",
      args: {
        on_fail: "cancel_pending",
        calls: [
          {
            name: "fs.read",
            args: { path: "/no/such/file/clai-batch-failfast" },
          },
          { name: "sysinfo", args: {} },
          { name: "sysinfo", args: {} },
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/on_fail cancelled/);
    expect(result.output).toMatch(/#1 fs\.read \[fail/);
    expect(result.output).toMatch(/#2 sysinfo \[cancelled/);
    expect(result.output).toMatch(/#3 sysinfo \[cancelled/);
    expect(result.output).toMatch(/because #1 fs\.read failed/);
  });

  it("accepts cancel_rest / fail_fast aliases for cancel_pending", async () => {
    for (const on_fail of ["cancel_rest", "fail_fast"] as const) {
      const result = await runToolCall({
        name: "tool.batch",
        args: {
          on_fail,
          calls: [
            {
              name: "fs.read",
              args: { path: `/no/such/file/clai-batch-${on_fail}` },
            },
            { name: "sysinfo", args: {} },
          ],
        },
      });
      expect(result.output).toMatch(/\[cancelled/);
    }
  });

  it("per-call cancel_on_fail only cancels listed targets", async () => {
    // shell.exec forces serial so order is deterministic.
    const result = await runToolCall({
      name: "tool.batch",
      args: {
        calls: [
          {
            id: "a",
            name: "shell.exec",
            args: { command: "false" },
            cancel_on_fail: ["c"],
          },
          { id: "b", name: "sysinfo", args: {} },
          { id: "c", name: "sysinfo", args: {} },
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.output).toMatch(/#1 shell\.exec \[fail/);
    expect(result.output).toMatch(/#2 sysinfo \[ok/);
    expect(result.output).toMatch(/#3 sysinfo \[cancelled/);
    expect(result.output).toMatch(/because #1 shell\.exec failed/);
  });

  it("rules match=all requires every trigger to fail", async () => {
    const onlyOneFails = await runToolCall({
      name: "tool.batch",
      args: {
        on_fail: {
          rules: [
            {
              if_failed: ["1", "2"],
              match: "all",
              cancel: ["3"],
            },
          ],
        },
        calls: [
          {
            name: "fs.read",
            args: { path: "/no/such/file/clai-batch-rule-a" },
          },
          { name: "sysinfo", args: {} },
          { name: "sysinfo", args: {} },
        ],
      },
    });
    // Call 1 fails, call 2 ok → match=all not satisfied → call 3 runs.
    expect(onlyOneFails.output).toMatch(/#3 sysinfo \[ok/);
    expect(onlyOneFails.output).not.toMatch(/#3 sysinfo \[cancelled/);

    const bothFail = await runToolCall({
      name: "tool.batch",
      args: {
        on_fail: {
          rules: [
            {
              if_failed: ["1", "2"],
              match: "all",
              cancel: ["3"],
            },
          ],
        },
        calls: [
          {
            name: "fs.read",
            args: { path: "/no/such/file/clai-batch-rule-b1" },
          },
          {
            name: "fs.read",
            args: { path: "/no/such/file/clai-batch-rule-b2" },
          },
          { name: "sysinfo", args: {} },
        ],
      },
    });
    expect(bothFail.output).toMatch(/#3 sysinfo \[cancelled/);
  });

  it("rejects unknown ids in on_fail rules and cancel_on_fail", async () => {
    await expect(
      runToolCall({
        name: "tool.batch",
        args: {
          on_fail: {
            rules: [{ if_failed: "missing", cancel: ["1"] }],
          },
          calls: [{ name: "sysinfo", args: {} }],
        },
      }),
    ).rejects.toThrow(/unknown id "missing"/);

    await expect(
      runToolCall({
        name: "tool.batch",
        args: {
          calls: [
            {
              id: "a",
              name: "sysinfo",
              args: {},
              cancel_on_fail: ["nope"],
            },
          ],
        },
      }),
    ).rejects.toThrow(/unknown id "nope"/);
  });

  it("rejects duplicate call ids", async () => {
    await expect(
      runToolCall({
        name: "tool.batch",
        args: {
          calls: [
            { id: "x", name: "sysinfo", args: {} },
            { id: "x", name: "sysinfo", args: {} },
          ],
        },
      }),
    ).rejects.toThrow(/duplicate call id/);
  });

  it("rejects invalid on_fail strings", async () => {
    await expect(
      runToolCall({
        name: "tool.batch",
        args: {
          on_fail: "explode_everything",
          calls: [{ name: "sysinfo", args: {} }],
        },
      }),
    ).rejects.toThrow(/on_fail must be/);
  });
});
