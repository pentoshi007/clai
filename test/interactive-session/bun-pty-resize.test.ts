import { afterEach, describe, expect, it, vi } from "vitest";
import { startPtyProcess } from "../../src/interactive-session/transport-node-pty.js";

const bunDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Bun");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (bunDescriptor) {
    Object.defineProperty(globalThis, "Bun", bunDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "Bun");
  }
});

const posixIt = process.platform === "win32" ? it.skip : it;

describe("Bun PTY resize", () => {
  posixIt("coalesces process-group signals after applying the latest size", async () => {
    vi.useFakeTimers();
    const resizes: Array<[number, number]> = [];
    let terminalClosed = false;
    const subprocess = {
      pid: 2_147_000_001,
      exited: new Promise<number>(() => {}),
      kill: vi.fn(),
      unref: vi.fn(),
    };

    class FakeTerminal {
      get closed(): boolean {
        return terminalClosed;
      }

      write(data: string | Uint8Array): number {
        return typeof data === "string" ? Buffer.byteLength(data) : data.length;
      }

      resize(columns: number, rows: number): void {
        resizes.push([columns, rows]);
      }

      close(): void {
        terminalClosed = true;
      }
    }

    Object.defineProperty(globalThis, "Bun", {
      configurable: true,
      value: {
        Terminal: FakeTerminal,
        spawn: vi.fn(() => subprocess),
      },
    });

    const result = await startPtyProcess({
      file: "/bin/sh",
      args: [],
      cwd: process.cwd(),
      dimensions: { columns: 80, rows: 24 },
    });
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation((() => true) as typeof process.kill);

    await result.transport.resize?.({ columns: 101, rows: 35 });
    await result.transport.resize?.({ columns: 132, rows: 47 });

    expect(resizes).toEqual([
      [101, 35],
      [132, 47],
    ]);
    expect(kill).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();

    expect(kill.mock.calls).toEqual([
      [-subprocess.pid, "SIGWINCH"],
      [-subprocess.pid, "SIGWINCH"],
    ]);

    kill.mockClear();
    await result.transport.resize?.({ columns: 144, rows: 52 });
    await result.transport.dispose();
    await vi.runAllTimersAsync();

    expect(kill).not.toHaveBeenCalled();
    expect(terminalClosed).toBe(true);
  });
});
