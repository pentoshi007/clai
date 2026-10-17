import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateConfig } from "../../src/store/config.js";
import {
  RUNTIME_CHILD_ENV,
  RUNTIME_DISABLE_ENV,
  RUNTIME_HOST_ENV,
} from "../../src/session-runtime/launch.js";

const probePtyCapability = vi.hoisted(() => vi.fn());
const findLiveRuntime = vi.hoisted(() => vi.fn());

vi.mock("../../src/session-runtime/discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/session-runtime/discovery.js")>()),
  findLiveRuntime,
}));

vi.mock("../../src/interactive-session/transport-node-pty.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/interactive-session/transport-node-pty.js")>()),
  probePtyCapability,
}));

import {
  runtimeClientAuthFrame,
  tryRunDurableInteractive,
} from "../../src/session-runtime/client.js";
import {
  runtimeDetachUnavailableMessage,
  setRuntimeDetachUnavailableReason,
} from "../../src/session-runtime/availability.js";

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
    findLiveRuntime.mockReset();
    setRuntimeDetachUnavailableReason(undefined);
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
    expect(runtimeDetachUnavailableMessage()).toContain("restart without --no-history");
    updateConfig({ privateMode: true });
    expect(await tryRunDurableInteractive(options)).toBe(false);
    expect(runtimeDetachUnavailableMessage()).toContain("disable private mode and restart");
    updateConfig({ privateMode: false });
    process.env[RUNTIME_DISABLE_ENV] = "1";
    expect(await tryRunDurableInteractive(options)).toBe(false);
    expect(runtimeDetachUnavailableMessage()).toContain(RUNTIME_DISABLE_ENV);
    delete process.env[RUNTIME_DISABLE_ENV];
    setTty(process.stdout, false);
    expect(await tryRunDurableInteractive(options)).toBe(false);
    expect(runtimeDetachUnavailableMessage()).toContain("input/output redirection");
    expect(probePtyCapability).not.toHaveBeenCalled();
    expect(findLiveRuntime).not.toHaveBeenCalled();
  });

  it("retains the startup failure for the minimise command", async () => {
    findLiveRuntime.mockRejectedValueOnce(new Error("runtime setup exploded\nwith detail"));
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as typeof process.stderr.write);
    const handled = await tryRunDurableInteractive({
      entryPath: "/tmp/clai-entry.js",
      childArgs: [],
    });
    expect(handled).toBe(false);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringMatching(/Durable session runtime unavailable \(runtime setup exploded with detail\); using foreground mode\./),
    );
    expect(runtimeDetachUnavailableMessage()).toContain("runtime startup failed (runtime setup exploded with detail)");
  });

  it.each([RUNTIME_CHILD_ENV, RUNTIME_HOST_ENV])("does not recursively launch from %s", async (key) => {
    process.env[key] = "1";
    expect(await tryRunDurableInteractive({
      entryPath: "/tmp/clai-entry.js",
      childArgs: [],
    })).toBe(false);
    expect(findLiveRuntime).not.toHaveBeenCalled();
    expect(probePtyCapability).not.toHaveBeenCalled();
  });
});
