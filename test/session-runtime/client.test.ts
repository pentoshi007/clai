import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateConfig } from "../../src/store/config.js";
import {
  RUNTIME_CHILD_ENV,
  RUNTIME_DISABLE_ENV,
  RUNTIME_HOST_ENV,
} from "../../src/session-runtime/launch.js";

const probePtyCapability = vi.hoisted(() => vi.fn());

vi.mock("../../src/interactive-session/transport-node-pty.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/interactive-session/transport-node-pty.js")>()),
  probePtyCapability,
}));

import {
  runtimeClientAuthFrame,
  tryRunDurableInteractive,
} from "../../src/session-runtime/client.js";

const runtimeEnv = [RUNTIME_CHILD_ENV, RUNTIME_DISABLE_ENV, RUNTIME_HOST_ENV] as const;
const savedEnv = new Map<string, string | undefined>();
let stdinDescriptor: PropertyDescriptor | undefined;
let stdoutDescriptor: PropertyDescriptor | undefined;

function setTty(target: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean): void {
  Object.defineProperty(target, "isTTY", {
    configurable: true,
    value,
  });
}

describe("durable interactive client fallback", () => {
  beforeEach(() => {
    probePtyCapability.mockReset();
    updateConfig({ privateMode: false });
    stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    setTty(process.stdin, true);
    setTty(process.stdout, true);
    for (const key of runtimeEnv) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    for (const key of runtimeEnv) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
    updateConfig({ privateMode: false });
    vi.restoreAllMocks();
  });

  it("includes one terminal dimension snapshot only on terminal authentication", () => {
    const metadata = { token: "a".repeat(64) };
    expect(
      runtimeClientAuthFrame(metadata, "client-terminal", "client", {
        columns: 132,
        rows: 47,
      }),
    ).toMatchObject({
      role: "client-terminal",
      clientId: "client",
      columns: 132,
      rows: 47,
    });
    expect(
      runtimeClientAuthFrame(metadata, "client-control", "client", {
        columns: 132,
        rows: 47,
      }),
    ).not.toMatchObject({ columns: 132, rows: 47 });
  });

  it("gates no-history, private, disabled, and non-TTY launches without probing PTY", async () => {
    const options = { entryPath: "/tmp/clai-entry.js", childArgs: [] } as const;
    expect(await tryRunDurableInteractive({ ...options, noHistory: true })).toBe(false);
    updateConfig({ privateMode: true });
    expect(await tryRunDurableInteractive(options)).toBe(false);
    updateConfig({ privateMode: false });
    process.env[RUNTIME_DISABLE_ENV] = "1";
    expect(await tryRunDurableInteractive(options)).toBe(false);
    delete process.env[RUNTIME_DISABLE_ENV];
    setTty(process.stdout, false);
    expect(await tryRunDurableInteractive(options)).toBe(false);
    expect(probePtyCapability).not.toHaveBeenCalled();
  });

  it("warns and falls back to foreground when runtime capability setup throws", async () => {
    probePtyCapability.mockRejectedValueOnce(new Error("PTY probe exploded\nwith detail"));
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as typeof process.stderr.write);
    const handled = await tryRunDurableInteractive({
      entryPath: "/tmp/clai-entry.js",
      childArgs: [],
    });
    expect(handled).toBe(false);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringMatching(/Durable session runtime unavailable \(PTY probe exploded with detail\); using foreground mode\./),
    );
  });

  it("quietly falls back when no PTY implementation is available", async () => {
    probePtyCapability.mockResolvedValueOnce({
      available: false,
      platform: process.platform,
      reason: "not installed",
    });
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as typeof process.stderr.write);
    expect(await tryRunDurableInteractive({
      entryPath: "/tmp/clai-entry.js",
      childArgs: [],
    })).toBe(false);
    expect(stderr).not.toHaveBeenCalled();
  });
});
