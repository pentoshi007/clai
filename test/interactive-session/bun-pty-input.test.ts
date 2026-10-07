import { afterEach, describe, expect, it, vi } from "vitest";
import { startPtyProcess } from "../../src/interactive-session/transport-node-pty.js";

const bunDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Bun");
const transports: Array<{ dispose(): Promise<void> }> = [];
const posixIt = process.platform === "win32" ? it.skip : it;

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.dispose();
  if (bunDescriptor) Object.defineProperty(globalThis, "Bun", bunDescriptor);
  else Reflect.deleteProperty(globalThis, "Bun");
});

async function fixture(reportedBytes: number, error?: Error) {
  let callbacks: { exit?: (terminal: unknown, code: number, signal: number | null) => void };
  let terminal: FakeTerminal;
  const writes: Buffer[] = [];
  class FakeTerminal {
    closed = false;
    constructor(options: typeof callbacks) { callbacks = options; terminal = this; }
    write(data: Uint8Array): number {
      if (error) throw error;
      writes.push(Buffer.from(data));
      return reportedBytes;
    }
    resize(): void {}
    close(): void { this.closed = true; }
  }
  Object.defineProperty(globalThis, "Bun", {
    configurable: true,
    value: {
      Terminal: FakeTerminal,
      spawn: vi.fn(() => ({ pid: 2_147_000_002, exited: new Promise<number>(() => {}), unref() {} })),
    },
  });
  const { transport } = await startPtyProcess({ file: "/bin/sh", args: [], cwd: process.cwd(), dimensions: { columns: 80, rows: 24 } });
  transports.push(transport);
  return {
    transport, writes,
    exit: () => { terminal.closed = true; callbacks.exit?.(terminal, 0, null); },
  };
}

describe("Bun PTY buffered input", () => {
  posixIt.each([0, 7])("accepts buffered input after reporting %i immediate bytes without resending it", async (reported) => {
    const f = await fixture(reported);
    const bytes = Buffer.from("retained_界_🙂".repeat(2_000));
    await expect(f.transport.write(bytes)).resolves.toEqual({ status: "delivered", deliveredBytes: bytes.length });
    expect(f.writes).toEqual([bytes]);
  });

  posixIt("accepts concurrent writes into Bun's ordered buffer", async () => {
    const f = await fixture(0);
    const bytes = [Buffer.from("first_界"), Buffer.from("second_🙂")];
    const results = bytes.map((part) => f.transport.write(part));
    expect(f.writes).toEqual(bytes);
    await expect(Promise.all(results)).resolves.toEqual(bytes.map((part) => ({ status: "delivered", deliveredBytes: part.length })));
    expect(f.writes).toEqual(bytes);
  });

  posixIt("retains an actual write failure as unknown", async () => {
    const error = new Error("PTY write failed");
    const f = await fixture(0, error);
    await expect(f.transport.write(Buffer.from("failed"))).resolves.toEqual({ status: "unknown", deliveredBytes: 0, cause: error });
    expect(f.writes).toEqual([]);
  });

  posixIt.each(["exit", "dispose"])("does not enqueue input after %s", async (action) => {
    const f = await fixture(3);
    if (action === "exit") f.exit();
    else await f.transport.dispose();
    await expect(f.transport.write(Buffer.from("later"))).resolves.toEqual({ status: "not-delivered", deliveredBytes: 0 });
    expect(f.writes).toEqual([]);
  });
});
