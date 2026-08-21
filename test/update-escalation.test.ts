import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SpawnCall {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly stdio: unknown;
}

const calls: SpawnCall[] = [];
let exitStatus = 0;

vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: readonly string[], options: { stdio?: unknown }) => {
    calls.push({ cmd, args, stdio: options?.stdio });
    const child = new EventEmitter() as EventEmitter & {
      kill: () => void;
      stdout: null;
      stderr: EventEmitter;
    };
    child.kill = () => {};
    child.stdout = null;
    child.stderr = new EventEmitter();
    setTimeout(() => child.emit("close", exitStatus), 0);
    return child;
  },
}));

const ASSET = "clai-bun-darwin-arm64";
const PAYLOAD = Buffer.from("new-clai-binary");

let root = "";
let execPath = "";
let lockedDir = "";

async function runInstall(stdio: "inherit" | "pipe") {
  const { installDirectBinary, currentPlatformTarget } = await import(
    "../src/commands/update-install.js"
  );
  return installDirectBinary({
    version: "4.6.1",
    method: { type: "binary" },
    target: currentPlatformTarget("darwin", "arm64"),
    execPath,
    stdio,
    log: () => {},
  });
}

beforeEach(async () => {
  calls.length = 0;
  exitStatus = 0;
  root = mkdtempSync(join(tmpdir(), "clai-escalation-"));
  lockedDir = join(root, "bin");
  execPath = join(lockedDir, "clai");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(lockedDir);
  writeFileSync(execPath, "old", { mode: 0o755 });
  chmodSync(lockedDir, 0o500);

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
  vi.unstubAllGlobals();
  try {
    chmodSync(lockedDir, 0o700);
  } catch {}
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
    expect(sudo?.stdio).toEqual(["ignore", "ignore", "pipe"]);
  });

  it("tells the user how to finish instead of failing silently", async () => {
    exitStatus = 1;
    await expect(runInstall("pipe")).rejects.toThrow(/sudo clai update/);
  });

  it("still prompts interactively for the plain CLI", async () => {
    exitStatus = 1;
    await expect(runInstall("inherit")).rejects.toThrow(
      /elevated permission to replace/,
    );

    const sudo = calls.find((call) => call.cmd === "sudo");
    expect(sudo?.args[0]).toBe("mv");
    expect(sudo?.stdio).toBe("inherit");
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
