import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { probePtyCapability } from "../../src/interactive-session/transport-node-pty.js";
import { findBunExecutable } from "../../src/os/bun-runtime.js";
import { SessionRuntimeHost } from "../../src/session-runtime/host.js";
import {
  RUNTIME_HOST_ENV,
  encodeRuntimeHostPayload,
} from "../../src/session-runtime/launch.js";
import {
  JsonFrameChannel,
  connectRuntimeSocket,
  readFirstFrame,
  sendFrame,
} from "../../src/session-runtime/protocol.js";
import { probeRuntime } from "../../src/session-runtime/discovery.js";
import { readRuntimeMetadata } from "../../src/session-runtime/store.js";
import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeHostFrame,
  type RuntimeMetadata,
} from "../../src/session-runtime/types.js";

const CHILD_SCRIPT = String.raw`
const net = require("node:net");
const socket = net.connect(process.env.CLAI_RUNTIME_SOCKET, () => {
  socket.write(JSON.stringify({version:1,type:"auth",role:"child",token:process.env.CLAI_RUNTIME_TOKEN,supportsRepaint:true}) + "\n");
});
const send = frame => socket.write(JSON.stringify(frame) + "\n");
const status = busy => send({type:"status",sessionId:process.env.CLAI_RUNTIME_SESSION_ID,cwd:process.cwd(),busy,title:"Reattach fixture"});
let repaintEnabled = true;
let clearThenDecline = false;
let delayedDecline = false;
let buffer = "";
socket.on("data", chunk => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const frame = JSON.parse(line);
    if (frame.type === "ack") status(true);
    if (frame.type === "repaint") {
      if (delayedDecline) {
        process.stdout.write("LIVE-DURING-REPAINT\r\n");
        setTimeout(() => send({type:"repaint-result",requestId:frame.requestId,accepted:false}), 80);
      } else if (clearThenDecline) {
        send({type:"repaint-result",requestId:frame.requestId,accepted:false});
      } else {
        if (repaintEnabled) {
          process.stdout.write("\u001b[Hreattach-fixture-ready FULL-FRAME:" + process.stdout.columns + "x" + process.stdout.rows + "\r\n");
        }
        send({type:"repaint-result",requestId:frame.requestId,accepted:repaintEnabled});
      }
    }
    if (frame.type === "shutdown") process.exit(0);
  }
});
if (process.stdin.setRawMode) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", chunk => {
  for (const command of chunk.toString("utf8").replace(/[\r\n]/g, "")) {
    if (command === "p") {
      process.stdout.write("Z".repeat(2300000));
      process.stdout.write("OVERFLOW-DONE\r\n");
    } else if (command === "s") {
      repaintEnabled = false;
      process.stdout.write("SUSPENDED-FALLBACK\r\n");
    } else if (command === "f") {
      clearThenDecline = true;
      process.stdout.write("SCHEDULING-FAILURE-FALLBACK\r\n");
    } else if (command === "d") {
      delayedDecline = true;
      process.stdout.write("BEFORE-REATTACH\r\n");
    } else if (command === "q") {
      send({type:"exiting",exitCode:0});
      setTimeout(() => process.exit(0), 10);
    }
  }
});
process.stdout.write("\u001b[?1049h\u001b[?1000h\u001b[?1006h\u001b[?2004h");
process.stdout.write("reattach-fixture-ready\r\n");
`;

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

interface Runtime {
  readonly sessionId: string;
  readonly metadata: RuntimeMetadata;
  readonly running: Promise<void>;
  readonly fixturePath: string;
}

async function startRuntime(): Promise<Runtime | undefined> {
  const capability = await probePtyCapability();
  const bun = findBunExecutable();
  if (!capability.available && !bun) return undefined;
  const sessionId = `reattach-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fixturePath = join(
    tmpdir(),
    `clai-reattach-child-${process.pid}-${Math.random().toString(16).slice(2)}.cjs`,
  );
  await writeFile(fixturePath, CHILD_SCRIPT, { mode: 0o600 });
  const payload = {
    version: RUNTIME_PROTOCOL_VERSION,
    sessionId,
    cwd: process.cwd(),
    launch: { file: process.execPath, args: [fixturePath] },
    columns: 100,
    rows: 30,
    idleTimeoutMs: 60_000,
  } as const;
  let running: Promise<void>;
  if (bun) {
    const entry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
    const child = spawn(bun, [entry], {
      cwd: process.cwd(),
      env: { ...process.env, [RUNTIME_HOST_ENV]: encodeRuntimeHostPayload(payload) },
      stdio: "ignore",
    });
    running = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`runtime host exited ${code ?? "by signal"}`));
      });
    });
  } else {
    running = new SessionRuntimeHost(payload).run();
  }
  const metadata = await waitFor(async () => {
    const value = await readRuntimeMetadata(sessionId);
    if (value?.phase === "failed") throw new Error(value.error ?? "runtime failed");
    return value?.phase === "running" && (await probeRuntime(value)) ? value : undefined;
  });
  return { sessionId, metadata, running, fixturePath };
}

async function channel(
  metadata: RuntimeMetadata,
  role: "client-control" | "client-terminal",
  clientId: string,
  dimensions?: { readonly columns: number; readonly rows: number } | undefined,
): Promise<{ socket: Socket; rest: Buffer }> {
  const socket = await connectRuntimeSocket(metadata.socketPath);
  sendFrame(socket, {
    version: RUNTIME_PROTOCOL_VERSION,
    type: "auth",
    role,
    token: metadata.token,
    clientId,
    ...(role === "client-terminal" && dimensions ? dimensions : {}),
  });
  const first = await readFirstFrame(socket);
  expect(first.value).toMatchObject({ type: "ack" });
  socket.on("error", () => undefined);
  return { socket, rest: first.rest };
}

interface Client {
  readonly control: Socket;
  terminal: Socket;
  readonly frames: RuntimeHostFrame[];
  output: string;
  dispose(): void;
}

async function openClient(metadata: RuntimeMetadata, id: string): Promise<Client> {
  const controlConn = await channel(metadata, "client-control", id);
  const frames: RuntimeHostFrame[] = [];
  const reader = new JsonFrameChannel(
    controlConn.socket,
    (value) => frames.push(value as RuntimeHostFrame),
    () => undefined,
    controlConn.rest,
  );
  const terminalConn = await channel(metadata, "client-terminal", id);
  const client: Client = {
    control: controlConn.socket,
    terminal: terminalConn.socket,
    frames,
    output: terminalConn.rest.toString("utf8"),
    dispose() {
      reader.dispose();
      controlConn.socket.destroy();
      client.terminal.destroy();
    },
  };
  terminalConn.socket.on("data", (chunk) => {
    client.output += chunk.toString("utf8");
  });
  terminalConn.socket.resume();
  return client;
}

async function reattachTerminal(
  metadata: RuntimeMetadata,
  client: Client,
  id: string,
): Promise<{ output: () => string }> {
  client.terminal.destroy();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const attached = await channel(
    metadata,
    "client-terminal",
    id,
    { columns: 100, rows: 30 },
  );
  let output = attached.rest.toString("utf8");
  attached.socket.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  attached.socket.resume();
  client.terminal = attached.socket;
  return { output: () => output };
}

async function stopRuntime(runtime: Runtime, client: Client): Promise<void> {
  client.terminal.write("q");
  await Promise.race([
    runtime.running,
    new Promise<void>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("runtime did not exit")),
        5_000,
      );
      timer.unref?.();
    }),
  ]);
  client.dispose();
  await rm(runtime.fixturePath, { force: true });
}

describe("terminal reattach mode restoration", () => {
  it("never replays an older screen after live output produced while repaint is pending", async () => {
    if (process.platform === "win32") return;
    const runtime = await startRuntime();
    if (!runtime) throw new Error("PTY transport is required for the reattach regression");
    const id = "delayed-repaint";
    const client = await openClient(runtime.metadata, id);
    try {
      await waitFor(async () =>
        client.output.includes("FULL-FRAME:100x30") ? true : undefined,
      );
      client.terminal.write("d");
      await waitFor(async () =>
        client.output.includes("BEFORE-REATTACH") ? true : undefined,
      );
      const attached = await reattachTerminal(runtime.metadata, client, id);
      await waitFor(async () =>
        attached.output().includes("BEFORE-REATTACH") &&
        attached.output().includes("LIVE-DURING-REPAINT") ? true : undefined,
      );
      expect(attached.output().indexOf("BEFORE-REATTACH")).toBeLessThan(
        attached.output().indexOf("LIVE-DURING-REPAINT"),
      );
      expect(attached.output().match(/LIVE-DURING-REPAINT/g)).toHaveLength(1);
    } finally {
      await stopRuntime(runtime, client);
    }
  }, 15_000);

  it("orders an authoritative same-size frame and falls back when repaint is declined", async () => {
    if (process.platform === "win32") return;
    const runtime = await startRuntime();
    if (!runtime) return;
    const id = "mode-restore";
    const client = await openClient(runtime.metadata, id);
    try {
      await waitFor(async () =>
        client.output.includes("reattach-fixture-ready") ? true : undefined,
      );
      client.terminal.write("p");
      await waitFor(
        async () => (client.output.includes("OVERFLOW-DONE") ? true : undefined),
        15_000,
      );

      const reattached = await reattachTerminal(runtime.metadata, client, id);
      await waitFor(
        async () =>
          reattached.output().includes("FULL-FRAME:100x30") &&
          reattached.output().includes("\u001b[?1000h")
            ? true
            : undefined,
        15_000,
      );
      const authoritative = reattached.output();
      const resetAt = authoritative.indexOf("\u001b[?1049h\u001b[H\u001b[J");
      const modesAt = authoritative.indexOf("\u001b[?1000h");
      const frameAt = authoritative.indexOf("FULL-FRAME:100x30");
      expect(resetAt).toBeGreaterThanOrEqual(0);
      expect(modesAt).toBeGreaterThan(resetAt);
      expect(frameAt).toBeGreaterThan(modesAt);
      expect(authoritative).toContain("\u001b[?2004h");
      expect(authoritative).not.toContain("OVERFLOW-DONE");

      client.terminal.write("s");
      await waitFor(async () =>
        reattached.output().includes("SUSPENDED-FALLBACK") ? true : undefined,
      );
      const fallback = await reattachTerminal(runtime.metadata, client, id);
      await waitFor(async () =>
        fallback.output().includes("SUSPENDED-FALLBACK") ? true : undefined,
      );
      const fallbackModesAt = fallback.output().indexOf("\u001b[?1000h");
      const fallbackReplayAt = fallback.output().indexOf("SUSPENDED-FALLBACK");
      expect(fallbackModesAt).toBeGreaterThanOrEqual(0);
      expect(fallbackReplayAt).toBeGreaterThan(fallbackModesAt);
    } finally {
      await stopRuntime(runtime, client);
    }
  }, 30_000);

  it("replays the prior screen when the child cannot schedule a frame", async () => {
    if (process.platform === "win32") return;
    const runtime = await startRuntime();
    if (!runtime) return;
    const id = "scheduling-failure";
    const client = await openClient(runtime.metadata, id);
    try {
      await waitFor(async () =>
        client.output.includes("reattach-fixture-ready") ? true : undefined,
      );

      client.terminal.write("f");
      await waitFor(async () =>
        client.output.includes("SCHEDULING-FAILURE-FALLBACK") ? true : undefined,
      );

      const fallback = await reattachTerminal(runtime.metadata, client, id);
      await waitFor(async () =>
        fallback.output().includes("SCHEDULING-FAILURE-FALLBACK")
          ? true
          : undefined,
        15_000,
      );

      const stream = fallback.output();
      const modesAt = stream.indexOf("\u001b[?1000h");
      const replayAt = stream.indexOf("SCHEDULING-FAILURE-FALLBACK");
      expect(modesAt).toBeGreaterThanOrEqual(0);
      expect(replayAt).toBeGreaterThan(modesAt);
    } finally {
      await stopRuntime(runtime, client);
    }
  }, 30_000);
});
