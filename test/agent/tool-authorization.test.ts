import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCall } from "../../src/types.js";

const pentestAuth = vi.fn();
const confirm = vi.fn();
const restore = vi.fn();
const isPentest = vi.fn();
const outsideCwd = vi.fn();
const config = vi.fn();

vi.mock("../../src/agent/confirm-port.js", () => ({
  ensurePentestAuthorization: (...args: unknown[]) => pentestAuth(...args),
  confirmToolExecution: (...args: unknown[]) => confirm(...args),
  restoreInteractiveStdin: () => restore(),
}));
vi.mock("../../src/safety/classifier.js", () => ({
  isPentestToolCall: (...args: unknown[]) => isPentest(...args),
}));
vi.mock("../../src/tools/fs.js", () => ({
  isOutsideWorkingDirectory: (...args: unknown[]) => outsideCwd(...args),
  resolveFsToolPath: (path: string) => path,
}));
vi.mock("../../src/store/config.js", () => ({
  getConfig: () => config(),
}));

const { authorizeToolExecution, requiresPathConfirmation } = await import(
  "../../src/agent/turn/tool-execution/authorization.js"
);

const blocked: string[] = [];
const released: string[] = [];

const ports = () => ({
  autoConfirm: false,
  session: { pentestAuthorized: { value: false } } as never,
  confirmPort: {} as never,
  acquirePrompt: async () => () => released.push("released"),
  writeToolBlocked: (_id: string, tool: string, reason: string) =>
    blocked.push(`${tool}:${reason}`),
  emitToolResult: () => undefined,
});

const input = (call: ToolCall, level: "safe" | "confirm" | "block") => ({
  call,
  toolEventId: "tool-1",
  parentSignal: new AbortController().signal,
  level,
  reason: "destructive pattern",
});

beforeEach(() => {
  blocked.length = 0;
  released.length = 0;
  pentestAuth.mockReset().mockResolvedValue(true);
  confirm.mockReset().mockResolvedValue(true);
  restore.mockReset();
  isPentest.mockReset().mockReturnValue(false);
  outsideCwd.mockReset().mockReturnValue(false);
  config.mockReset().mockReturnValue({ pentestAuthorized: false });
});

describe("tool authorization", () => {
  it("stops a blocked call before any prompt and never acquires the mutex", async () => {
    const outcome = await authorizeToolExecution(
      input({ name: "shell.exec", args: { command: "rm -rf /" } }, "block"),
      ports(),
    );
    expect(outcome.kind).toBe("stop");
    expect(released).toEqual([]);
    expect(blocked).toEqual(["shell.exec:destructive pattern"]);
    if (outcome.kind !== "stop") throw new Error("expected stop");
    expect(outcome.result.result.output).toBe(
      "Blocked: shell.exec — destructive pattern",
    );
    expect(outcome.result.contextOutput).toContain("did not run");
    expect(outcome.result.blockOrCancel).toBeUndefined();
  });

  it("proceeds without confirming a safe call", async () => {
    const outcome = await authorizeToolExecution(
      input({ name: "fs.read", args: { path: "a.ts" } }, "safe"),
      ports(),
    );
    expect(outcome).toEqual({ kind: "proceed", pentestJustConfirmed: false });
    expect(confirm).not.toHaveBeenCalled();
    expect(released).toEqual(["released"]);
  });

  it("stops when pentest authorization is refused", async () => {
    pentestAuth.mockResolvedValue(false);
    const outcome = await authorizeToolExecution(
      input({ name: "net.scan", args: { target: "lab" } }, "confirm"),
      ports(),
    );
    if (outcome.kind !== "stop") throw new Error("expected stop");
    expect(outcome.result.lastAnswer).toBe(
      "Pentest authorization not confirmed.",
    );
    expect(outcome.result.blockOrCancel).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("skips the second prompt when pentest was just authorized", async () => {
    isPentest.mockReturnValue(true);
    const outcome = await authorizeToolExecution(
      input({ name: "net.scan", args: { target: "lab" } }, "confirm"),
      ports(),
    );
    expect(outcome).toEqual({ kind: "proceed", pentestJustConfirmed: true });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("stops when the confirmation is declined", async () => {
    confirm.mockResolvedValue(false);
    const outcome = await authorizeToolExecution(
      input({ name: "fs.write", args: { path: "a.ts" } }, "confirm"),
      ports(),
    );
    if (outcome.kind !== "stop") throw new Error("expected stop");
    expect(outcome.result.lastAnswer).toBe("Cancelled.");
    expect(outcome.result.blockOrCancel).toBe(true);
    expect(released).toEqual(["released"]);
  });

  it("forces confirmation for fs.delete even under auto-confirm", async () => {
    const withAutoConfirm = { ...ports(), autoConfirm: true };
    await authorizeToolExecution(
      input({ name: "fs.delete", args: { path: "a.ts" } }, "safe"),
      withAutoConfirm,
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![1]).toBe(false);
    expect(confirm.mock.calls[0]![4]).toEqual({ forceConfirm: true });
  });

  it("forces confirmation for writes outside the working directory", () => {
    outsideCwd.mockReturnValue(true);
    expect(
      requiresPathConfirmation({ name: "fs.write", args: { path: "/etc/hosts" } }),
    ).toBe(true);
    outsideCwd.mockReturnValue(false);
    expect(
      requiresPathConfirmation({ name: "fs.write", args: { path: "src/a.ts" } }),
    ).toBe(false);
  });

  it("inspects every entry of a multi-file write", () => {
    outsideCwd.mockImplementation((path: string) => path === "/etc/hosts");
    expect(
      requiresPathConfirmation({
        name: "fs.writeMany",
        args: { files: [{ path: "src/a.ts" }, { path: "/etc/hosts" }] },
      }),
    ).toBe(true);
  });

  it("forces confirmation when a path cannot be resolved", () => {
    outsideCwd.mockImplementation(() => {
      throw new Error("bad path");
    });
    expect(
      requiresPathConfirmation({ name: "fs.edit", args: { path: "\0" } }),
    ).toBe(true);
  });

  it("ignores non-path tools", () => {
    expect(
      requiresPathConfirmation({ name: "shell.exec", args: { command: "ls" } }),
    ).toBe(false);
  });
});
