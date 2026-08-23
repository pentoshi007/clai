import { describe, expect, it } from "vitest";
import {
  installTerminalRescue,
  TERMINAL_RESET_SEQUENCE,
} from "../src/os/terminal-rescue.js";

function createFakeProc() {
  const listeners = new Set<(code?: number) => void>();
  return {
    listeners,
    on(event: "exit", listener: (code?: number) => void) {
      listeners.add(listener);
    },
    off(event: "exit", listener: (code?: number) => void) {
      listeners.delete(listener);
    },
    emitExit() {
      for (const listener of [...listeners]) listener(0);
    },
  };
}

describe("installTerminalRescue", () => {
  it("restores raw mode and emits the reset sequence on exit", () => {
    const proc = createFakeProc();
    const rawModes: boolean[] = [];
    let pauses = 0;
    const writes: string[] = [];
    installTerminalRescue({
      proc,
      stdin: { setRawMode: (m) => rawModes.push(m), pause: () => (pauses += 1) },
      stdout: { write: (c) => writes.push(c) },
    });
    proc.emitExit();
    expect(rawModes).toEqual([false]);
    expect(pauses).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe(TERMINAL_RESET_SEQUENCE);
    expect(writes[0]).toContain("\x1b[?1006l");
    expect(writes[0]).toContain("\x1b[?1002l");
    expect(writes[0]).toContain("\x1b[?1000l");
    expect(writes[0]).toContain("\x1b[?1003l");
    expect(writes[0]).toContain("\x1b[?2004l");
    expect(writes[0]).toContain("\x1b[?1049l");
    expect(writes[0]).toContain("\x1b[?25h");
  });

  it("restores only once even if exit fires twice", () => {
    const proc = createFakeProc();
    const writes: string[] = [];
    installTerminalRescue({
      proc,
      stdin: {},
      stdout: { write: (c) => writes.push(c) },
    });
    proc.emitExit();
    proc.emitExit();
    expect(writes).toHaveLength(1);
  });

  it("does not restore after disarm", () => {
    const proc = createFakeProc();
    const writes: string[] = [];
    const disarm = installTerminalRescue({
      proc,
      stdin: {},
      stdout: { write: (c) => writes.push(c) },
    });
    disarm();
    proc.emitExit();
    expect(writes).toHaveLength(0);
    expect(proc.listeners.size).toBe(0);
  });

  it("installs on an injected proc are independent", () => {
    const proc = createFakeProc();
    const first: string[] = [];
    const second: string[] = [];
    const disarmFirst = installTerminalRescue({
      stdout: { write: (c) => first.push(c) },
      stdin: {},
      proc,
    });
    installTerminalRescue({
      stdout: { write: (c) => second.push(c) },
      stdin: {},
      proc,
    });
    disarmFirst();
    proc.emitExit();
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
    expect(proc.listeners.size).toBe(1);
  });

  it("swallows errors thrown by raw-mode and stdout writes", () => {
    const proc = createFakeProc();
    installTerminalRescue({
      proc,
      stdin: {
        setRawMode: () => {
          throw new Error("no tty");
        },
        pause: () => {
          throw new Error("gone");
        },
      },
      stdout: {
        write: () => {
          throw new Error("closed");
        },
      },
    });
    expect(() => proc.emitExit()).not.toThrow();
  });
});
