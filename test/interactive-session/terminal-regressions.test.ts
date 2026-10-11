import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InteractiveSessionManager } from "../../src/interactive-session/manager.js";
import { RecoveryJournal } from "../../src/interactive-session/recovery-journal.js";
import { SessionTelemetry } from "../../src/interactive-session/telemetry.js";
import { startPtyProcess, type PtyProcessLike } from "../../src/interactive-session/transport-node-pty.js";
import { createInteractiveSessionHandlers } from "../../src/tools/interactive-session-tools.js";
import { FakeTransportFactory } from "./helpers.js";

const ownerId = "terminal-regressions";
const dirs: string[] = [];
const managers: InteractiveSessionManager[] = [];
const bunDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Bun");

function build() {
  const dir = mkdtempSync(join(tmpdir(), "clai-terminal-regression-"));
  dirs.push(dir);
  const factory = new FakeTransportFactory({ ptyAvailable: true });
  const manager = new InteractiveSessionManager({
    artifactBaseDir: dir,
    transports: factory,
    journal: new RecoveryJournal(join(dir, "journal")),
    telemetry: new SessionTelemetry(async () => undefined),
  });
  managers.push(manager);
  return { manager, factory };
}

async function start(manager: InteractiveSessionManager) {
  return manager.start({ ownerId, command: "repl", confirm: async () => true });
}

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.closeAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (bunDescriptor) Object.defineProperty(globalThis, "Bun", bunDescriptor);
  else Reflect.deleteProperty(globalThis, "Bun");
});

describe("terminal transport regressions", () => {
  it("delivers UTF-8 input to node-pty without Latin-1 conversion", async () => {
    const received: Buffer[] = [];
    const pty: PtyProcessLike = {
      pid: 2_147_000_005,
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      write(data) { received.push(Buffer.from(data)); },
      resize() {}, pause() {}, resume() {}, kill() {},
    };
    const { transport } = await startPtyProcess({
      file: "sh", args: [], cwd: process.cwd(), dimensions: { columns: 80, rows: 24 },
    }, { module: { spawn: () => pty } });
    const bytes = Buffer.from("試験-pass🙂\r");
    await expect(transport.write(bytes)).resolves.toMatchObject({ status: "delivered", deliveredBytes: bytes.length });
    expect(received).toEqual([bytes]);
    await transport.dispose();
    await expect(transport.write(bytes)).resolves.toMatchObject({ status: "not-delivered" });
  });

  it.skipIf(process.platform === "win32")("allocates Bun's terminal inline so the child acquires its controlling TTY", async () => {
    const terminal = { closed: false, write: () => 0, resize() {}, close() { this.closed = true; } };
    const spawn = vi.fn(() => ({ pid: 2_147_000_006, terminal, exited: new Promise<number>(() => {}), kill() {} }));
    const constructor = vi.fn();
    Object.defineProperty(globalThis, "Bun", { configurable: true, value: { Terminal: constructor, spawn } });
    const { transport } = await startPtyProcess({
      file: "sh", args: [], cwd: process.cwd(), dimensions: { columns: 100, rows: 30 },
    });
    expect(constructor).not.toHaveBeenCalled();
    expect(spawn.mock.calls[0]?.[1]).toMatchObject({ terminal: { cols: 100, rows: 30, data: expect.any(Function) } });
    await transport.dispose();
  });
});

describe("terminal lifecycle regressions", () => {
  it("keeps redacted output and exact cursors readable after natural exit", async () => {
    const { manager, factory } = build();
    const started = await start(manager);
    factory.last().emit("Permission denied (publickey,password).\n", "stderr");
    factory.last().emitExit({ code: 255 });
    await manager.close({ ownerId, id: started.sessionId });
    const read = await manager.read({ ownerId, id: started.sessionId, cursor: 0, waitMs: 30_000 });
    expect(read.state).toBe("exited");
    expect(read.page?.events.map(event => event.content).join("")).toContain("Permission denied");
    expect(read.page?.events[0]?.stream).toBe("stderr");
    const end = await manager.read({ ownerId, id: started.sessionId, cursor: read.page!.nextCursor, waitMs: 30_000 });
    expect(end.page?.events).toEqual([]);
    expect(end.page?.nextCursor).toBe(read.page!.nextCursor);
    await expect(manager.read({ ownerId: "another-owner", id: started.sessionId, cursor: 0 })).rejects.toMatchObject({ stable: { code: "SESSION_NOT_FOUND" } });
  });

  it("returns trailing output when a send triggers immediate exit", async () => {
    const { manager, factory } = build();
    const started = await start(manager);
    const pending = manager.send({ ownerId, id: started.sessionId, input: { kind: "text", text: "exit", submit: "enter" }, quietMs: 5_000, confirm: async () => true });
    await expect.poll(() => factory.last().writes.length).toBe(1);
    factory.last().emit("goodbye\n");
    factory.last().emitExit();
    const result = await pending;
    expect(result.delivery).toBe("delivered");
    expect(result.page?.events.map(event => event.content).join("")).toContain("goodbye");
    await manager.close({ ownerId, id: started.sessionId });
    const read = await manager.read({ ownerId, id: started.sessionId, cursor: 0 });
    expect(read.page?.events.map(event => event.content).join("")).toContain("goodbye");
  });

  it("checks session state before opening the local password prompt", async () => {
    const { manager } = build();
    const started = await start(manager);
    await manager.close({ ownerId, id: started.sessionId });
    const requestSecret = vi.fn(async () => "not-a-real-secret");
    const result = await createInteractiveSessionHandlers(manager)["terminal.send"]({ id: started.sessionId, kind: "secret" }, { sessionId: ownerId, requestSecret });
    expect(requestSecret).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.output).toContain("SESSION_NOT_RUNNING");
  });

  it("delivers locally requested secret exactly once and redacts echoed output/artifacts", async () => {
    const { manager, factory } = build();
    const started = await start(manager);
    const value = "dummy-試験-🙂";
    const requestSecret = vi.fn(async () => value);
    const pending = createInteractiveSessionHandlers(manager)["terminal.send"]({ id: started.sessionId, kind: "secret", quietMs: 100 }, { sessionId: ownerId, confirmed: true, requestSecret });
    await expect.poll(() => factory.last().writes.length).toBe(1);
    factory.last().emit(`echoed ${value}\n`);
    const result = await pending;
    expect(factory.last().writes).toEqual([`${value}\r`]);
    expect(requestSecret).toHaveBeenCalledTimes(1);
    expect(result.output).toContain("[redacted]");
    expect(JSON.stringify(result)).not.toContain(value);
    await manager.close({ ownerId, id: started.sessionId });
    expect(readFileSync(started.artifact.path, "utf8")).not.toContain(value);
  });
});

describe("terminal output retention and preflight", () => {
  it("preserves eviction diagnostics after close", async () => {
    const { manager, factory } = build();
    const started = await start(manager);
    factory.last().emit("x".repeat(manager.config.memoryWindowBytes + 20));
    await manager.close({ ownerId, id: started.sessionId });
    const read = await manager.read({ ownerId, id: started.sessionId, cursor: 0 });
    expect(read.error?.code).toBe("OUTPUT_GAP");
    expect(read.page?.earliestAvailableCursor).toBe(20);
    const recovered = await manager.read({ ownerId, id: started.sessionId, cursor: 20 });
    expect(recovered.page?.nextCursor).toBe(20 + manager.config.pageBytes);
    expect(recovered.page?.hasMore).toBe(true);
  });

  it("bounds completed output with the terminal-record registry", async () => {
    const { manager, factory } = build();
    const ids: string[] = [];
    for (let index = 0; index < 52; index += 1) {
      const started = await start(manager);
      ids.push(started.sessionId);
      factory.last().emit(`session-${index}\n`);
      await manager.close({ ownerId, id: started.sessionId });
    }
    expect(manager.list({ ownerId }).sessions).toHaveLength(50);
    await expect(manager.read({ ownerId, id: ids[0]!, cursor: 0 })).rejects.toMatchObject({ stable: { code: "SESSION_NOT_FOUND" } });
    const newest = await manager.read({ ownerId, id: ids.at(-1)!, cursor: 0 });
    expect(newest.page?.events.map(event => event.content).join("")).toContain("session-51");
  });

  it.each([-1, 0.5, 100])("rejects invalid cursor %s before delivery or local secret collection", async (cursor) => {
    const { manager, factory } = build();
    const started = await start(manager);
    const requestSecret = vi.fn(async () => "not-a-real-secret");
    const result = await createInteractiveSessionHandlers(manager)["terminal.send"]({ id: started.sessionId, kind: "secret", cursor }, { sessionId: ownerId, confirmed: true, requestSecret });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("INVALID_REQUEST");
    expect(requestSecret).not.toHaveBeenCalled();
    expect(factory.last().writes).toEqual([]);
  });
});

describe("terminal startup transcript", () => {
  it("returns initial prompts and a reusable next cursor from terminal.start", async () => {
    const { manager, factory } = build();
    const pending = createInteractiveSessionHandlers(manager)["terminal.start"]({ command: "repl", terminalMode: "required" }, { sessionId: ownerId, confirmed: true });
    await expect.poll(() => factory.transports.length).toBe(1);
    factory.last().emit("Password: ");
    const result = await pending;
    expect(result.output).toContain("Password: ");
    expect(result.output).toContain("nextCursor=10");
    expect(result.interactiveSession?.operation).toBe("start");
    if (result.interactiveSession?.operation === "start") expect(result.interactiveSession.cursor).toBe(10);
  });
});

describe("terminal argument validation", () => {
  it.each([
    { cursor: "0" }, { quietMs: "500" }, { deadlineMs: Number.NaN },
    { quietMs: 0.5 }, { view: "raw" }, { submit: "newline" },
  ])("rejects malformed send options without opening the secret modal: %j", async (args) => {
    const { manager, factory } = build();
    const started = await start(manager);
    const requestSecret = vi.fn(async () => "not-a-real-secret");
    const result = await createInteractiveSessionHandlers(manager)["terminal.send"]({ id: started.sessionId, kind: "secret", ...args }, { sessionId: ownerId, requestSecret });
    expect(result.ok).toBe(false);
    expect(requestSecret).not.toHaveBeenCalled();
    expect(factory.last().writes).toEqual([]);
  });

  it("distinguishes cancelled secret input from unavailable UI support", async () => {
    const { manager, factory } = build();
    const started = await start(manager);
    const handlers = createInteractiveSessionHandlers(manager);
    const args = { id: started.sessionId, kind: "secret" };
    const unavailable = await handlers["terminal.send"](args, { sessionId: ownerId });
    expect(unavailable.output).toContain("UNSUPPORTED_OPERATION");
    const cancelled = await handlers["terminal.send"](args, { sessionId: ownerId, requestSecret: async () => undefined });
    expect(cancelled.output).toContain("CANCELLED");
    expect(factory.last().writes).toEqual([]);
  });

  it("rejects out-of-range startup deadline before launching", async () => {
    const { manager, factory } = build();
    const result = await createInteractiveSessionHandlers(manager)["terminal.start"]({ command: "repl", deadlineMs: 300_000 }, { sessionId: ownerId, confirmed: true });
    expect(result.output).toContain("120000");
    expect(result.ok).toBe(false);
    expect(factory.launches).toBe(0);
  });
});
