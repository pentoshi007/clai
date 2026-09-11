import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  InteractiveSessionManager,
  type ConfirmPreview,
} from "../../src/interactive-session/manager.js";
import { RecoveryJournal } from "../../src/interactive-session/recovery-journal.js";
import { SessionTelemetry } from "../../src/interactive-session/telemetry.js";
import { createSessionTransportFactory } from "../../src/interactive-session/transport-factory.js";
import { processAlive } from "../../src/os/process-tree.js";
import { SessionErrorException } from "../../src/interactive-session/types.js";
import { tempArtifactDir } from "./helpers.js";

const OWNER = "conv-integration";
const approve: ConfirmPreview = async () => true;
const FIXTURE = join(process.cwd(), "test/fixtures/interactive-child.mjs");
const CHILD = `${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)}`;

let dirs: string[] = [];
let managers: InteractiveSessionManager[] = [];

function build(config: Record<string, unknown> = {}): InteractiveSessionManager {
  const dir = tempArtifactDir();
  dirs.push(dir);
  const manager = new InteractiveSessionManager({
    transports: createSessionTransportFactory(),
    artifactBaseDir: dir,
    journal: new RecoveryJournal(join(dir, "journal")),
    telemetry: new SessionTelemetry(async () => undefined),
    config,
  });
  managers.push(manager);
  return manager;
}

async function startChild(manager: InteractiveSessionManager) {
  const started = await manager.start({
    ownerId: OWNER,
    command: CHILD,
    terminalMode: "pipe",
    confirm: approve,
  });
  await expect.poll(async () => textOf((await manager.read({
    ownerId: OWNER, id: started.sessionId, cursor: 0, waitMs: 100,
  })).page), { timeout: 3000 }).toContain("ready>");
  return started;
}

function textOf(page: { events: readonly { content: string }[] } | undefined): string {
  return (page?.events ?? []).map((event) => event.content).join("");
}

async function send(
  manager: InteractiveSessionManager,
  id: string,
  text: string,
  options: { cursor?: number; quietMs?: number; deadlineMs?: number } = {},
) {
  return await manager.send({
    ownerId: OWNER,
    id,
    input: { kind: "text", text, submit: "enter" },
    quietMs: options.quietMs ?? 150,
    deadlineMs: options.deadlineMs ?? 10_000,
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    confirm: approve,
  });
}

beforeEach(() => {
  dirs = [];
  managers = [];
});

afterEach(async () => {
  for (const manager of managers) await manager.closeAll("app-shutdown").catch(() => undefined);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("interactive session integration over a real pipe transport", () => {
  it("runs start, send, read, status, list, resize, and close", async () => {
    const manager = build();
    const started = await startChild(manager);
    expect(started.transport).toBe("pipe");
    // Explicit pipe mode is not a degradation: nothing was attempted and failed.
    expect(started.degradedReason).toBeUndefined();

    const first = await send(manager, started.sessionId, "echo hello", { cursor: 0 });
    expect(first.delivery).toBe("delivered");
    expect(first.inputSequence).toBe(1);
    expect(textOf(first.page)).toContain("hello");

    const read = await manager.read({
      ownerId: OWNER,
      id: started.sessionId,
      cursor: first.page!.nextCursor,
    });
    expect(read.page?.requestedCursor).toBe(first.page!.nextCursor);

    const status = manager.status({ ownerId: OWNER, id: started.sessionId });
    expect(status.session.state).toBe("running");
    expect(status.session.latestCursor).toBeGreaterThan(0);
    expect(manager.list({ ownerId: OWNER }).sessions).toHaveLength(1);

    await expect(
      manager.resize({ ownerId: OWNER, id: started.sessionId, columns: 100, rows: 30 }),
    ).rejects.toBeInstanceOf(SessionErrorException);

    const closed = await manager.close({ ownerId: OWNER, id: started.sessionId });
    // The cleanup owner may record `exited` when it observes the child's exit
    // during teardown; both are valid terminal outcomes for a requested close.
    expect(["closed", "exited"]).toContain(closed.state);
    expect(closed.cleanupVerified).toBe(true);
    expect(closed.error).toBeUndefined();
  });

  it("keeps cursors gap-free across delayed and unsolicited output", async () => {
    const manager = build();
    const started = await startChild(manager);
    const first = await send(manager, started.sessionId, "unsolicited 3", { cursor: 0 });
    let cursor = first.page!.nextCursor;
    const collected = [textOf(first.page)];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const read = await manager.read({
        ownerId: OWNER,
        id: started.sessionId,
        cursor,
        waitMs: 200,
      });
      expect(read.page?.requestedCursor).toBe(cursor);
      collected.push(textOf(read.page));
      cursor = read.page!.nextCursor;
    }
    const combined = collected.join("");
    expect(combined).toContain("tick 0");
    expect(combined).toContain("tick 2");
    // Every tick appears exactly once: no duplication across pages.
    expect(combined.split("tick 1")).toHaveLength(2);
  });

  it("gathers delayed output within the quiet interval", async () => {
    const manager = build();
    const started = await startChild(manager);
    const result = await send(manager, started.sessionId, "delay 80 later", { cursor: 0 });
    expect(textOf(result.page)).toContain("later");
  });

  it("keeps stderr distinct from stdout on a pipe transport", async () => {
    const manager = build();
    const started = await startChild(manager);
    const result = await send(manager, started.sessionId, "err oops", { cursor: 0 });
    const streams = new Set(result.page!.events.map((event) => event.stream));
    expect(streams.has("stderr")).toBe(true);
    expect(textOf(result.page)).toContain("oops");
  });

  it("neutralizes terminal control sequences and preserves binary bytes", async () => {
    const manager = build();
    const started = await startChild(manager);
    const ansi = await send(manager, started.sessionId, "ansi", { cursor: 0 });
    const plain = textOf(ansi.page);
    expect(plain).not.toContain("\u001b");
    expect(plain).toContain("red");

    const binary = await send(manager, started.sessionId, "binary", {
      cursor: ansi.page!.nextCursor,
    });
    const encoded = await manager.read({
      ownerId: OWNER,
      id: started.sessionId,
      cursor: ansi.page!.nextCursor,
      view: "encoded",
    });
    const bytes = Buffer.concat(
      encoded.page!.events.map((event) => Buffer.from(event.content, "base64")),
    );
    expect(bytes.includes(0xff)).toBe(true);
    expect(binary.page?.decodingLoss).toBe(true);
  });

  it("redacts a secret that a child emits across two writes", async () => {
    const manager = build();
    const started = await startChild(manager);
    const result = await send(manager, started.sessionId, "secret sk-abcdef1234567890", {
      cursor: 0,
    });
    const plain = textOf(result.page);
    expect(plain).not.toContain("sk-abcdef1234567890");
    expect(plain).toContain("sk-••••••");
  });

  it("closes child input on EOF and records the natural exit", async () => {
    const manager = build();
    const started = await startChild(manager);
    await manager.send({
      ownerId: OWNER,
      id: started.sessionId,
      input: { kind: "eof" },
      quietMs: 150,
      confirm: approve,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const session = manager.status({ ownerId: OWNER, id: started.sessionId }).session;
    expect(session.state).toBe("exited");
    expect(session.inputClosed).toBe(true);
  });

  it("terminates a TERM-resistant child and its descendants", async () => {
    const manager = build({ gracefulCloseMs: 200 });
    const started = await startChild(manager);
    const spawned = await send(manager, started.sessionId, "spawn", { cursor: 0 });
    const pid = Number(/spawned (\d+)/.exec(textOf(spawned.page))?.[1]);
    expect(Number.isFinite(pid)).toBe(true);
    await send(manager, started.sessionId, "ignore-term", {
      cursor: spawned.page!.nextCursor,
    });
    const closed = await manager.close({ ownerId: OWNER, id: started.sessionId });
    expect(["closed", "exited"]).toContain(closed.state);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(processAlive(pid)).toBe(false);
  });

  it("captures a redacted artifact on disk for the session", async () => {
    const manager = build();
    const started = await startChild(manager);
    await send(manager, started.sessionId, "echo persisted", { cursor: 0 });
    const closed = await manager.close({ ownerId: OWNER, id: started.sessionId });
    expect(closed.artifact.bytes).toBeGreaterThan(0);
    expect(closed.artifact.redacted).toBe(true);
  });

  it("reports PTY_UNAVAILABLE for a required-PTY start without spawning", async () => {
    const manager = build();
    const capability = await manager.ptyCapability();
    if (capability.available) return; // A packaged PTY target is covered separately.
    await expect(
      manager.start({
        ownerId: OWNER,
        command: CHILD,
        terminalMode: "required",
        confirm: approve,
      }),
    ).rejects.toBeInstanceOf(SessionErrorException);
    expect(manager.list({ ownerId: OWNER }).sessions).toHaveLength(0);
  });
});
