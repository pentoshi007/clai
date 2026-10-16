import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { minimiseWindowsConsoleWindow } from "../../src/os/windows-console.js";

const state = vi.hoisted(() => ({
  spawnCalls: [] as Array<{ file: string; args: readonly string[] }>,
  children: [] as Array<EventEmitter & { kill: () => void; unref: () => void }>,
}));

vi.mock("node:child_process", () => ({
  spawn: (file: string, args: readonly string[]) => {
    state.spawnCalls.push({ file, args });
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() });
    state.children.push(child);
    return child;
  },
}));

afterEach(() => {
  state.spawnCalls.length = 0;
  state.children.length = 0;
  vi.useRealTimers();
  vi.clearAllMocks();
});

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
}

describe("Windows console minimise", () => {
  it.skipIf(process.platform === "win32")("does nothing outside Windows", async () => {
    expect(await minimiseWindowsConsoleWindow()).toBe(false);
    expect(state.spawnCalls).toHaveLength(0);
  });

  it("minimises the console window through PowerShell on Windows", async () => {
    const pending = withPlatform("win32", () => minimiseWindowsConsoleWindow());
    const child = state.children.at(-1)!;
    expect(state.spawnCalls.at(-1)?.file).toBe("powershell.exe");
    expect(state.spawnCalls.at(-1)?.args).toContain("-NoProfile");
    expect(state.spawnCalls.at(-1)?.args.at(-1)).toContain("ShowWindow");
    child.emit("exit", 0);
    expect(await pending).toBe(true);
  });

  it("reports failure when the helper exits non-zero", async () => {
    const pending = withPlatform("win32", () => minimiseWindowsConsoleWindow());
    state.children.at(-1)!.emit("exit", 1);
    expect(await pending).toBe(false);
  });

  it("reports failure when PowerShell cannot be started", async () => {
    const pending = withPlatform("win32", () => minimiseWindowsConsoleWindow());
    state.children.at(-1)!.emit("error", new Error("spawn failed"));
    expect(await pending).toBe(false);
  });

  it("gives up and kills a helper that does not finish", async () => {
    vi.useFakeTimers();
    const pending = withPlatform("win32", () => minimiseWindowsConsoleWindow());
    const child = state.children.at(-1)!;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toBe(false);
    expect(child.kill).toHaveBeenCalled();
  });
});
