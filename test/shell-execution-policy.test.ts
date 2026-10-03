import { beforeEach, describe, expect, it, vi } from "vitest";
import { toolHardBudgetMs, toolStallBudgetMs } from "../src/agent/evidence/tool-budgets.js";
import { toolRegistry_SHELL_1 } from "../src/tools/handlers/shell-1.js";
import { resolveShellExecBackgroundPolicy, startsBackgroundJob } from "../src/tools/command-intent.js";

const mocks = vi.hoisted(() => ({
  shellExec: vi.fn(),
  startJob: vi.fn(),
}));

vi.mock("../src/tools/shell.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/tools/shell.js")>(),
  shellExec: mocks.shellExec,
}));
vi.mock("../src/tools/jobs.js", () => ({
  jobManager: { startJob: mocks.startJob, getResponderLeaseId: () => undefined },
}));
vi.mock("../src/tools/rtk/rewrite.js", () => ({
  prepareRtkExecution: async (command: string) => ({ command }),
}));

const execute = toolRegistry_SHELL_1["shell.exec"]!;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.shellExec.mockResolvedValue({ ok: true, output: "foreground result", exitCode: 0 });
  mocks.startJob.mockResolvedValue({ ok: true, output: "explicit background result" });
});

describe("model-owned shell execution", () => {
  it.each([
    "npm run dev",
    "python3 -m http.server 8000",
    "tcpdump -c 1",
    "java -jar finite-task.jar",
    "printf 'tcpdump -c 1'",
    "nmap -sV example.com",
    "find / -name missing",
  ])("does not schedule %s in the background without an explicit choice", async (command) => {
    for (const background of [undefined, "auto", "never"]) {
      const result = await execute({ command, timeoutMs: 60_000, background }, {});
      expect(result.output).toBe("foreground result");
      expect(mocks.startJob).not.toHaveBeenCalled();
      expect(mocks.shellExec).toHaveBeenLastCalledWith(expect.objectContaining({ timeoutMs: 60_000 }));
      expect(startsBackgroundJob({ name: "shell.exec", args: { command, background } })).toBe(false);
    }
  });

  it.each(["echo finite", "npm run dev", "tcpdump -c 1"])("respects explicit Responder ownership without imposing a deadline for %s", async (command) => {
    await execute({ command, responder: true, timeoutMs: 60_000 }, {});
    expect(mocks.startJob).toHaveBeenCalledWith(command, expect.objectContaining({
      responder: true,
      wakeOnCompletion: true,
    }));
    expect(mocks.startJob.mock.calls[0]?.[1]).not.toHaveProperty("timeoutMs");
    expect(mocks.shellExec).not.toHaveBeenCalled();
  });

  it("keeps explicit background jobs pollable without a deadline", async () => {
    const result = await execute({ command: "echo finite", background: "always", timeoutMs: 60_000 }, {});
    expect(mocks.startJob).toHaveBeenCalledWith("echo finite", expect.objectContaining({
      responder: false,
      wakeOnCompletion: false,
    }));
    expect(mocks.startJob.mock.calls[0]?.[1]).not.toHaveProperty("timeoutMs");
    expect(result.output).toMatch(/timeoutMs.*foreground|ignored.*background/i);
  });

  it("explicit foreground takes precedence over responder", async () => {
    const policy = resolveShellExecBackgroundPolicy({ command: "npm run dev", background: "never", responder: true });
    expect(policy).toMatchObject({ wantsBackground: false, responder: false });
  });

  it.each(["npm install", "npm run build", "vitest run", "echo finite"])("uses one documented default budget for %s", async (command) => {
    await execute({ command }, {});
    expect(mocks.shellExec).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60_000 }));
    const call = { name: "shell.exec", args: { command } };
    expect(toolStallBudgetMs(call)).toBe(62_500);
    expect(toolHardBudgetMs(call)).toBe(62_500);
  });

  it.each([60, 0, -1, 1000.5, 1_800_001])("rejects invalid millisecond budget %s instead of guessing units", async (timeoutMs) => {
    const result = await execute({ command: "npm install", timeoutMs }, {});
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/timeoutMs/);
    expect(mocks.shellExec).not.toHaveBeenCalled();
    expect(mocks.startJob).not.toHaveBeenCalled();
  });
});
