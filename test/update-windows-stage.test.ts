import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageWindowsUpdate, type WindowsUpdateTask } from "../src/commands/update/windows-stage.js";
import { runUpdateCommand } from "../src/commands/update/process.js";

const state = vi.hoisted(() => ({ mode: "ack", directories: [] as string[], statuses: [] as string[], spawns: 0 }));
function taskFrom(script: string): { stage: string; status: string } {
  const match = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(readFileSync(script, "utf8"));
  if (!match?.[1]) throw new Error("missing staged payload");
  const data: unknown = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
  if (!data || typeof data !== "object" || !("stage" in data) || typeof data.stage !== "string" || !("status" in data) || typeof data.status !== "string") throw new Error("invalid staged payload");
  state.directories.push(data.stage); state.statuses.push(data.status);
  return { stage: data.stage, status: data.status };
}
function acknowledge(script: string): void {
  const data = taskFrom(script);
  if (state.mode === "ack") writeFileSync(join(data.stage, "ready"), "ready");
  if (state.mode === "failed") { writeFileSync(data.status, '{"state":"failed","message":"worker failed"}'); rmSync(data.stage, { recursive: true, force: true }); }
}
vi.mock("node:child_process", () => ({ spawn: (_file: string, args: readonly string[]) => {
  state.spawns++;
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  queueMicrotask(() => {
    if (state.mode === "error") { child.emit("error", new Error("powershell unavailable")); return; }
    child.emit("spawn"); acknowledge(args.at(-1)!);
  });
  return child;
} }));
vi.mock("../src/commands/update/process.js", async (original) => ({ ...await original<typeof import("../src/commands/update/process.js")>(), runUpdateCommand: vi.fn() }));
const task: WindowsUpdateTask = { kind: "commands", commands: [], verification: { file: process.execPath, args: ["--version"] }, version: "9.9.9", allowNewer: false };
afterEach(() => {
  for (const path of [...state.directories.splice(0), ...state.statuses.splice(0)]) rmSync(path, { recursive: true, force: true });
  state.mode = "ack"; state.spawns = 0; vi.resetAllMocks(); vi.useRealTimers();
});

describe("Windows staged-worker acceptance", () => {
  it("returns a receipt only after readiness and uses a new receipt for each attempt", async () => {
    const first = await stageWindowsUpdate(task);
    const second = await stageWindowsUpdate(task);
    expect(first).not.toBe(second);
    expect(state.spawns).toBe(2);
    expect(state.directories.every((path) => existsSync(join(path, "ready")))).toBe(true);
  });
  it("does not launch after cancellation or with an incomplete lock handoff", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(stageWindowsUpdate(task, { signal: controller.signal })).rejects.toThrow(/cancelled/);
    await expect(stageWindowsUpdate(task, { lockFile: "fixture.lock" })).rejects.toThrow(/lock token/);
    expect(state.spawns).toBe(0);
  });
  it("bounds a worker that never acknowledges readiness", async () => {
    vi.useFakeTimers(); state.mode = "none";
    const result = expect(stageWindowsUpdate(task)).rejects.toThrow(/did not acknowledge/);
    await vi.advanceTimersByTimeAsync(15_100);
    await result;
    expect(state.directories.every((path) => !existsSync(path))).toBe(true);
  });
  it("reports a worker failure instead of claiming a staged or applied update", async () => {
    state.mode = "failed";
    await expect(stageWindowsUpdate(task)).rejects.toThrow(/worker failed/);
  });
  it("cleans staging when PowerShell is unavailable", async () => {
    state.mode = "error";
    await expect(stageWindowsUpdate(task)).rejects.toThrow(/powershell unavailable/);
  });
  it("requests UAC, then checks readiness before reporting staging", async () => {
    vi.mocked(runUpdateCommand).mockImplementation(async (command) => {
      const text = command.args.at(-1)!;
      const match = /-File "([^"]+)"/.exec(text);
      if (!match?.[1]) throw new Error("missing elevation script");
      acknowledge(match[1]); return "";
    });
    const receipt = await stageWindowsUpdate(task, {}, true);
    expect(receipt).toBe(state.statuses[0]);
    expect(vi.mocked(runUpdateCommand).mock.calls[0]?.[0].args.at(-1)).toContain("-Verb RunAs");
    expect(state.spawns).toBe(0);
  });
  it("reports declined UAC without staging success", async () => {
    vi.mocked(runUpdateCommand).mockRejectedValue(new Error("UAC declined"));
    await expect(stageWindowsUpdate(task, {}, true)).rejects.toThrow(/UAC declined/);
  });
});
