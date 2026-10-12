import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PerformUpdateOptions } from "../src/commands/update-install.js";

interface SpawnCall {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly stdio: unknown;
}

const calls: SpawnCall[] = [];
let exitStatus = 0;
let stdinText = "";
let replaced = false;

vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: readonly string[], options: { stdio?: unknown }) => {
    calls.push({ cmd, args, stdio: options?.stdio });
    const child = Object.assign(new EventEmitter(), {
      kill: () => {},
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), {
        write: (data: string) => { stdinText += data; },
        end: (data?: string) => { stdinText += data ?? ""; },
      }),
    });
    setTimeout(() => {
      if (cmd === "sudo") {
        if (exitStatus === 0) {
          writeFileSync(args.at(-1)!, readFileSync(args.at(-2)!));
          replaced = true;
        }
        child.emit("close", exitStatus);
        return;
      }
      child.stdout.emit("data", Buffer.from("4.6.1\n"));
      child.emit("close", 0);
    }, 0);
    return child;
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    accessSync: vi.fn(),
    renameSync: vi.fn(actual.renameSync),
  };
});

vi.mock("../src/tools/sudo-session.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/tools/sudo-session.js")>();
  return { ...actual, obtainSudoPassword: vi.fn() };
});

async function obtainMock() {
  const mod = await import("../src/tools/sudo-session.js");
  return vi.mocked(mod.obtainSudoPassword);
}

async function accessMock() {
  const mod = await import("node:fs");
  return vi.mocked(mod.accessSync);
}

async function renameMock() {
  const mod = await import("node:fs");
  return vi.mocked(mod.renameSync);
}

const ASSET = "clai-bun-darwin-arm64";
const PAYLOAD = Buffer.from("new-clai-binary");

let root = "";
let execPath = "";

async function runInstall(
  stdio: "inherit" | "pipe",
  extra?: Partial<PerformUpdateOptions>,
) {
  const { installDirectBinary, currentPlatformTarget } =
    await import("../src/commands/update-install.js");
  return installDirectBinary({
    version: "4.6.1",
    method: { type: "binary" },
    target: currentPlatformTarget("darwin", "arm64"),
    execPath,
    stdio,
    log: () => {},
    ...extra,
  });
}

beforeEach(async () => {
  calls.length = 0;
  exitStatus = 0;
  stdinText = "";
  replaced = false;
  (await obtainMock()).mockReset();
  if (process.getuid) vi.spyOn(process, "getuid").mockReturnValue(1000);
  (await accessMock()).mockImplementation(() => {
    const error = new Error("permission denied") as NodeJS.ErrnoException;
    error.code = "EACCES";
    throw error;
  });
  root = mkdtempSync(join(tmpdir(), "clai-escalation-"));
  const lockedDir = join(root, "bin");
  execPath = join(lockedDir, "clai");
  mkdirSync(lockedDir);
  writeFileSync(execPath, "old", { mode: 0o755 });
  const rename = await renameMock();
  const realRename = rename.getMockImplementation()!;
  rename.mockImplementation((from, to) => {
    if (to !== execPath) return realRename(from, to);
    const error = new Error("permission denied") as NodeJS.ErrnoException;
    error.code = "EACCES";
    throw error;
  });

  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(PAYLOAD).digest("hex");
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    if (url.endsWith(".sha256")) {
      return new Response(`${digest}  ${ASSET}\n`, { status: 200 });
    }
    return new Response(new Uint8Array(PAYLOAD), {
      status: 200,
      headers: { "content-length": String(PAYLOAD.byteLength) },
    });
  });
});

afterEach(() => {
  expect(readFileSync(execPath, "utf8")).toBe(replaced ? PAYLOAD.toString() : "old");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe("privilege escalation during an in-app update", () => {
  it("never hands the terminal to sudo when the UI owns it", async () => {
    exitStatus = 1;
    await expect(runInstall("pipe")).rejects.toThrow(
      /elevated permission to replace/,
    );

    const sudo = calls.find((call) => call.cmd === "sudo");
    expect(sudo).toBeDefined();
    expect(sudo?.args[0]).toBe("-n");
    expect(sudo?.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("tells the user how to finish instead of failing silently", async () => {
    exitStatus = 1;
    await expect(runInstall("pipe")).rejects.toThrow(/sudo clai update/);
  });

  it("never leaves the plain CLI hanging at an unowned password prompt", async () => {
    exitStatus = 1;
    await expect(runInstall("inherit")).rejects.toThrow(
      /elevated permission to replace/,
    );

    const sudo = calls.find((call) => call.cmd === "sudo");
    expect(sudo?.args[0]).toBe("-n");
    expect(sudo?.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("completes the install when a cached sudo timestamp lets the move succeed", async () => {
    exitStatus = 0;
    const result = await runInstall("pipe");
    expect(result.ok).toBe(true);
    expect(result.needsRestart).toBe(true);
    expect(calls.some((call) => call.cmd === "sudo")).toBe(true);
  });
});

describe("escalation timeout", () => {
  it("caps the non-interactive wait far below the interactive prompt budget", async () => {
    const mod = await import("../src/commands/update-install.js");
    expect(mod.ELEVATION_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

describe("secret-modal password elevation", () => {
  it("moves the binary with sudo -S using the prompted password", async () => {
    const obtain = await obtainMock();
    obtain.mockResolvedValue({
      status: "granted",
      password: "hunter2",
      fromCache: false,
    });
    const result = await runInstall("pipe", {
      requestSecret: async () => "hunter2",
    });
    expect(result.ok).toBe(true);
    expect(obtain).toHaveBeenCalledTimes(1);
    const promptRequest = obtain.mock.calls[0]?.[0];
    expect(promptRequest?.title).toBe("Administrator access");
    expect(promptRequest?.operation).toMatchObject({
      name: "clai.update",
      args: { destination: execPath, elevation: "sudo" },
    });
    const sudo = calls.find((call) => call.cmd === "sudo");
    expect(sudo).toBeDefined();
    expect(sudo?.args.slice(0, 6)).toEqual(["-S", "-p", "", "--", "sh", "-c"]);
    expect(sudo?.args[6]).toContain("mktemp");
    expect(sudo?.args[6]).toContain("install -m 755");
    expect(sudo?.args[sudo.args.length - 1]).toBe(execPath);
    expect(sudo?.args.some((arg) => arg.includes("hunter2"))).toBe(false);
    expect(stdinText).toBe("hunter2\n");
  });

  it("cancels before downloading when the password prompt is dismissed", async () => {
    const obtain = await obtainMock();
    obtain.mockResolvedValue({ status: "cancelled" });
    let fetchCalls = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCalls += 1;
      throw new Error("fetch must not run after cancellation");
    });
    await expect(
      runInstall("pipe", { requestSecret: async () => undefined }),
    ).rejects.toThrow(/update cancelled/);
    expect(fetchCalls).toBe(0);
    expect(calls.some((call) => call.cmd === "sudo")).toBe(false);
  });

  it("reports authentication failure instead of retrying forever", async () => {
    const obtain = await obtainMock();
    obtain.mockResolvedValue({
      status: "failed",
      detail: "3 incorrect password attempts",
    });
    await expect(
      runInstall("pipe", { requestSecret: async () => "hunter2" }),
    ).rejects.toThrow(/sudo authentication failed/);
    expect(calls.some((call) => call.cmd === "sudo")).toBe(false);
  });

  it("reports the terminal guidance when the elevated move itself fails", async () => {
    const obtain = await obtainMock();
    obtain.mockResolvedValue({
      status: "granted",
      password: "hunter2",
      fromCache: false,
    });
    exitStatus = 1;
    await expect(
      runInstall("pipe", { requestSecret: async () => "hunter2" }),
    ).rejects.toThrow(/elevated permission to replace/);
    const sudo = calls.find((call) => call.cmd === "sudo");
    expect(sudo?.args.slice(0, 6)).toEqual(["-S", "-p", "", "--", "sh", "-c"]);
    expect(sudo?.args[6]).toContain("mktemp");
    expect(sudo?.args[6]).toContain("install -m 755");
  });

  it("passes a pre-supplied cancelled auth outcome through the replace stage", async () => {
    const obtain = await obtainMock();
    await expect(
      runInstall("pipe", { elevation: { auth: { status: "cancelled" } } }),
    ).rejects.toThrow(/update cancelled/);
    expect(obtain).not.toHaveBeenCalled();
    expect(calls.some((call) => call.cmd === "sudo")).toBe(false);
  });
});
