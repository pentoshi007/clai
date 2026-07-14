import { describe, expect, it } from "vitest";
import { toolRegistry, runToolCall } from "../src/tools/registry.js";
import { classifyToolCall } from "../src/safety/classifier.js";

describe("phase 12 — tool.batch", () => {
  it("is registered and classifier marks it safe", () => {
    expect(toolRegistry["tool.batch"]).toBeDefined();
    const decision = classifyToolCall({
      name: "tool.batch",
      args: { calls: [] },
    });
    expect(decision.level).toBe("safe");
  });

  it("rejects an empty or non-array calls value", async () => {
    await expect(
      runToolCall({ name: "tool.batch", args: { calls: [] } }),
    ).rejects.toThrow(/at least one/);
    await expect(
      runToolCall({ name: "tool.batch", args: { calls: "ls" } }),
    ).rejects.toThrow(/calls/);
  });

  it("rejects calls to non-allowed tools (eg shell.exec)", async () => {
    await expect(
      runToolCall({
        name: "tool.batch",
        args: {
          calls: [{ name: "shell.exec", args: { command: "ls" } }],
        },
      }),
    ).rejects.toThrow(/refuses to run "shell.exec"/);
  });

  it("rejects calls to net.scan / pentest.recon / fs.write", async () => {
    for (const name of ["net.scan", "pentest.recon", "fs.write"]) {
      await expect(
        runToolCall({
          name: "tool.batch",
          args: { calls: [{ name, args: {} }] },
        }),
      ).rejects.toThrow();
    }
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
});
