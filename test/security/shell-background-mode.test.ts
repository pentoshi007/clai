import { afterEach, describe, expect, it, vi } from "vitest";
import { jobManager } from "../../src/tools/jobs.js";
import { toolRegistry } from "../../src/tools/registry.js";

const shellExec = toolRegistry["shell.exec"]!;

afterEach(() => vi.restoreAllMocks());

describe("TOOL-002 shell.exec background mode", () => {
  it('background:"never" keeps an expensive-looking command in the foreground', async () => {
    const result = await shellExec(
      {
        command: "find / -maxdepth 0 -name '*'",
        background: "never",
        timeoutMs: 20000,
      },
      {},
    );
    expect(result.backgroundJob).toBeUndefined();
    expect(result.output).not.toMatch(/durable background job/i);
  });

  it("a cheap scanner-shaped command stays in the foreground by default", async () => {
    const result = await shellExec({ command: "find . -maxdepth 0" }, {});
    expect(result.backgroundJob).toBeUndefined();
  });

  it("keeps costly finite commands foreground unless responder is explicit", async () => {
    const start = vi.spyOn(jobManager, "startJob").mockResolvedValue({
      ok: true,
      output: "launch policy",
      backgroundJob: {
        id: "cost-job",
        status: "running",
        artifactPath: "/tmp/cost-job.log",
      },
    });

    const foreground = await shellExec(
      { command: "find . -maxdepth 0 -name '*'" },
      {},
    );
    expect(foreground.backgroundJob).toBeUndefined();
    expect(start).not.toHaveBeenCalled();

    await shellExec(
      {
        command: "find / -name definitely-not-here-xyz",
        responder: true,
      },
      {},
    );
    expect(start.mock.calls[0]?.[1]).toMatchObject({
      responder: true,
      wakeOnCompletion: true,
    });
  });

  it('background:"always" is pollable unless responder:true is explicit', async () => {
    const start = vi.spyOn(jobManager, "startJob").mockResolvedValue({
      ok: true,
      output: "launch policy",
      backgroundJob: {
        id: "forced-job",
        status: "running",
        artifactPath: "/tmp/forced-job.log",
      },
    });

    await shellExec({ command: "echo finite", background: "always" }, {});
    expect(start.mock.calls[0]?.[1]).toMatchObject({
      responder: false,
      wakeOnCompletion: false,
    });

    start.mockClear();
    await shellExec(
      { command: "echo finite", background: "always", responder: true },
      {},
    );
    expect(start.mock.calls[0]?.[1]).toMatchObject({
      responder: true,
      wakeOnCompletion: true,
    });
  });

  it("background never overrides responder and command heuristics do not change ownership", async () => {
    const start = vi.spyOn(jobManager, "startJob").mockResolvedValue({
      ok: true,
      output: "launch policy",
      backgroundJob: {
        id: "ownership-job",
        status: "running",
        artifactPath: "/tmp/ownership-job.log",
      },
    });

    const foreground = await shellExec(
      {
        command: "printf foreground",
        background: "never",
        responder: true,
      },
      {},
    );
    expect(foreground.backgroundJob).toBeUndefined();
    expect(start).not.toHaveBeenCalled();

    await shellExec({ command: "tcpdump -c 1", responder: true }, {});
    expect(start.mock.calls[0]?.[1]).toMatchObject({
      responder: true,
      wakeOnCompletion: true,
    });

    start.mockClear();
    await shellExec(
      { command: "npm run dev", background: "always", name: "web" },
      {},
    );
    expect(start.mock.calls[0]?.[1]).toMatchObject({
      name: "web",
      responder: false,
      wakeOnCompletion: false,
    });
  });

  it("enforces timeoutMs for a foreground command", async () => {
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => console.log('finished'), 1500)")}`;
    const result = await shellExec({ command, timeoutMs: 1000 }, {});
    expect(result.ok).toBe(false);
    expect(result.backgroundJob).toBeUndefined();
    expect(result.output).toMatch(/timed out/i);
  });

  it.each([false, true])("ignores foreground timeoutMs on explicit background, responder=%s", async (responder) => {
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => console.log('finished'), 1500)")}`;
    const started = await shellExec(
      { command, timeoutMs: 1000, background: "always", responder },
      { sessionId: "background-timeout-regression" },
    );
    const id = started.backgroundJob?.id;
    expect(id).toBeTruthy();
    try {
      expect(started.output).toMatch(/timeoutMs.*foreground|ignored.*background/i);
      const result = await jobManager.waitForJob(id!, { timeoutMs: 5000 });
      expect(result.output).not.toMatch(/still running/i);
      expect(jobManager.getJob(id!)).toMatchObject({ status: "exited", exitCode: 0 });
    } finally {
      if (jobManager.getJob(id!)?.status === "running") await jobManager.stopJob(id!);
    }
  });

  it("ignores foreground timeoutMs when explicitly delegated", async () => {
    const start = vi.spyOn(jobManager, "startJob").mockResolvedValue({
      ok: true,
      output: "launch policy",
      backgroundJob: {
        id: "cost-job",
        status: "running",
        artifactPath: "/tmp/cost-job.log",
      },
    });
    const result = await shellExec(
      { command: "find / -name definitely-not-here-xyz", timeoutMs: 1234, responder: true },
      {},
    );
    expect(start.mock.calls[0]?.[1]).not.toHaveProperty("timeoutMs");
    expect(result.output).toMatch(/timeoutMs.*foreground|ignored.*background/i);
  });
});
