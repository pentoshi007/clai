import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stageWindowsUpdate, windowsWorkerLaunch, type WindowsUpdateTask } from "../src/commands/update/windows-stage.js";
import { runUpdateCommand, type UpdateCommand } from "../src/commands/update/process.js";

const state = vi.hoisted(() => ({ mode: "ack", directories: [] as string[], statuses: [] as string[], spawns: 0 }));
function taskFrom(script: string): { stage: string; status: string } {
  const match = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(readFileSync(script, "utf8"));
  if (!match?.[1]) throw new Error("missing staged payload");
  const data: unknown = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
  if (!data || typeof data !== "object" || !("stage" in data) || typeof data.stage !== "string" || !("status" in data) || typeof data.status !== "string") throw new Error("invalid staged payload");
  state.directories.push(data.stage); state.statuses.push(data.status);
  return { stage: data.stage, status: data.status };
}
function bootstrapFrom(command: UpdateCommand): string {
  const match = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(command.args.at(-1)!);
  if (!match?.[1]) throw new Error("missing encoded worker bootstrap");
  return Buffer.from(match[1], "base64").toString("utf16le");
}
function acknowledge(script: string): void {
  const data = taskFrom(script);
  if (state.mode === "ack") writeFileSync(join(data.stage, "ready"), "ready");
  if (state.mode === "slow") setTimeout(() => writeFileSync(join(data.stage, "ready"), "ready"), 20_000);
  if (state.mode === "startup-error") writeFileSync(`${data.status}.startup-error.log`, "PowerShell startup parser error");
  if (state.mode === "failed") { writeFileSync(data.status, '{"state":"failed","message":"worker failed"}'); rmSync(data.stage, { recursive: true, force: true }); }
}
vi.mock("node:child_process", () => ({ spawn: (_file: string, args: readonly string[], options: { detached?: boolean }) => {
  state.spawns++;
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  queueMicrotask(() => {
    child.emit("spawn");
    if (options.detached) taskFrom(args.at(-1)!);
    else acknowledge(args.at(-1)!);
  });
  return child;
} }));
vi.mock("../src/commands/update/process.js", async (original) => ({ ...await original<typeof import("../src/commands/update/process.js")>(), runUpdateCommand: vi.fn() }));
const task: WindowsUpdateTask = { kind: "commands", commands: [], verification: { file: process.execPath, args: ["--version"] }, version: "9.9.9", allowNewer: false };
beforeEach(() => {
  vi.mocked(runUpdateCommand).mockImplementation(async (command) => {
    const match = /try \{ & '((?:[^']|'')+)' \}/.exec(bootstrapFrom(command));
    if (!match?.[1]) throw new Error("missing worker launch script");
    acknowledge(match[1].replace(/''/g, "'"));
    return "";
  });
});
afterEach(() => {
  const receipts = state.statuses.splice(0).flatMap((path) => [path, `${path}.startup-error.log`]);
  for (const path of [...state.directories.splice(0), ...receipts]) rmSync(path, { recursive: true, force: true });
  state.mode = "ack"; state.spawns = 0; vi.resetAllMocks(); vi.useRealTimers();
});

describe("Windows staged-worker acceptance", () => {
  it("avoids a console-less detached PowerShell worker that exits before acknowledging", async () => {
    vi.useFakeTimers();
    const result = stageWindowsUpdate(task).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(15_100);
    expect(await result).toBe(state.statuses[0]);
    expect(state.spawns).toBe(0);
    const command = vi.mocked(runUpdateCommand).mock.calls[0]![0];
    expect(command.args.at(-1)).toContain("Start-Process -WindowStyle Hidden");
    expect(command.args.at(-1)).toContain("-Verb Open");
    expect(command.args.at(-1)).not.toContain("-RedirectStandardError");
    expect(command.args.at(-1)).not.toContain("-RedirectStandardOutput");
    expect(bootstrapFrom(command)).toContain(".startup-error.log");
  });
  it("encodes startup error reporting inside the independent worker without inheriting bootstrap pipes", () => {
    const script = "C:\\User's & %TEMP%\\界\\apply.ps1";
    const error = "C:\\User's & %TEMP%\\界\\startup.log";
    const launch = windowsWorkerLaunch(script, error);
    expect(bootstrapFrom(launch)).toContain("try { & 'C:\\User''s & %TEMP%\\界\\apply.ps1' }");
    expect(bootstrapFrom(launch)).toContain("Set-Content -LiteralPath 'C:\\User''s & %TEMP%\\界\\startup.log' -Encoding UTF8");
    expect(launch.args.at(-1)).toContain("-Verb Open");
    expect(launch.args.at(-1)).not.toContain("-RedirectStandard");
  });
  it("returns a receipt only after readiness and uses a new receipt for each attempt", async () => {
    const first = await stageWindowsUpdate(task);
    const second = await stageWindowsUpdate(task);
    expect(first).not.toBe(second);
    expect(vi.mocked(runUpdateCommand)).toHaveBeenCalledTimes(2);
    expect(state.directories.every((path) => existsSync(join(path, "ready")))).toBe(true);
  });
  it("copies a standalone executable into the same acknowledged worker protocol", async () => {
    await stageWindowsUpdate({ kind: "binary", source: process.execPath, destination: "fixture-clai.exe", digest: "staged-digest", previousDigest: "previous-digest", version: "9.9.9" });
    expect(statSync(join(state.directories[0]!, "clai.exe")).size).toBe(statSync(process.execPath).size);
    expect(vi.mocked(runUpdateCommand)).toHaveBeenCalledTimes(1);
    expect(state.spawns).toBe(0);
  });
  it("does not launch after cancellation or with an incomplete lock handoff", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(stageWindowsUpdate(task, { signal: controller.signal })).rejects.toThrow(/cancelled/);
    await expect(stageWindowsUpdate(task, { lockFile: "fixture.lock" })).rejects.toThrow(/lock token/);
    expect(state.spawns).toBe(0);
    expect(vi.mocked(runUpdateCommand)).not.toHaveBeenCalled();
  });
  it("allows a cold PowerShell startup longer than fifteen seconds", async () => {
    vi.useFakeTimers(); state.mode = "slow";
    const result = stageWindowsUpdate(task);
    await vi.advanceTimersByTimeAsync(20_100);
    expect(await result).toBe(state.statuses[0]);
  });
  it("bounds a worker that never acknowledges readiness", async () => {
    vi.useFakeTimers(); state.mode = "none";
    const result = expect(stageWindowsUpdate(task)).rejects.toThrow(/did not acknowledge/);
    await vi.advanceTimersByTimeAsync(60_100);
    await result;
    expect(state.directories.every((path) => !existsSync(path))).toBe(true);
  });
  it("reports a worker failure instead of claiming a staged or applied update", async () => {
    state.mode = "failed";
    await expect(stageWindowsUpdate(task)).rejects.toThrow(/worker failed/);
  });
  it("reports captured PowerShell startup errors instead of an empty acknowledgement timeout", async () => {
    vi.useFakeTimers(); state.mode = "startup-error";
    await expect(stageWindowsUpdate(task)).rejects.toThrow(/PowerShell startup parser error/);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels while waiting for acknowledgement and cleans staging", async () => {
    vi.useFakeTimers(); state.mode = "none";
    const controller = new AbortController();
    const result = expect(stageWindowsUpdate(task, { signal: controller.signal })).rejects.toThrow(/cancelled/);
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(state.directories.every((path) => !existsSync(path))).toBe(true);
  });
  it("cleans staging when PowerShell is unavailable", async () => {
    vi.mocked(runUpdateCommand).mockRejectedValue(new Error("powershell unavailable"));
    await expect(stageWindowsUpdate(task)).rejects.toThrow(/powershell unavailable/);
  });
  it("requests UAC, then checks readiness before reporting staging", async () => {
    const receipt = await stageWindowsUpdate(task, {}, true);
    expect(receipt).toBe(state.statuses[0]);
    const launch = vi.mocked(runUpdateCommand).mock.calls[0]![0].args.at(-1);
    expect(launch).toContain("-Verb RunAs");
    expect(launch).not.toContain("-RedirectStandardError");
    expect(launch).not.toContain("-RedirectStandardOutput");
    expect(state.spawns).toBe(0);
  });
  it("reports declined UAC without staging success", async () => {
    vi.mocked(runUpdateCommand).mockRejectedValue(new Error("UAC declined"));
    await expect(stageWindowsUpdate(task, {}, true)).rejects.toThrow(/UAC declined/);
  });
});
