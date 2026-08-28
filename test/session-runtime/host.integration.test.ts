import { spawn } from "node:child_process";
import { chmod, rm, writeFile } from "node:fs/promises";
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
import { runtimeLockPath } from "../../src/session-runtime/paths.js";
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
  socket.write(JSON.stringify({version:1,type:"auth",role:"child",token:process.env.CLAI_RUNTIME_TOKEN}) + "\n");
});
let buffer = "";
socket.on("data", chunk => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const frame = JSON.parse(line);
    if (frame.type === "ack") {
      socket.write(JSON.stringify({type:"status",sessionId:process.env.CLAI_RUNTIME_SESSION_ID,cwd:process.cwd(),busy:true,title:"Integration"}) + "\n");
    }
    if (frame.type === "shutdown") process.exit(0);
  }
});
process.stdin.on("data", chunk => {
  if (chunk.toString("utf8").includes("m")) {
    socket.write(JSON.stringify({type:"minimise"}) + "\n");
  }
});
process.stdout.write("runtime-ready\r\n");
setTimeout(() => process.exit(0), 1200);
`;

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

async function channel(
  socketPath: string,
  token: string,
  role: "client-control" | "client-terminal",
  clientId: string,
): Promise<{ socket: Socket; rest: Buffer<ArrayBufferLike> }> {
  const socket = await connectRuntimeSocket(socketPath);
  sendFrame(socket, {
    version: RUNTIME_PROTOCOL_VERSION,
    type: "auth",
    role,
    token,
    clientId,
  });
  const first = await readFirstFrame(socket);
  expect(first.value).toMatchObject({ type: "ack" });
  return { socket, rest: first.rest };
}

describe("session runtime host integration", () => {
  it("replays output, transfers control, and minimises without killing the child", async () => {
    const capability = await probePtyCapability();
    const bun = findBunExecutable();
    if (!capability.available && !bun) return;
    const sessionId = `runtime-integration-${Date.now()}`;
    const payload = {
      version: RUNTIME_PROTOCOL_VERSION,
      sessionId,
      cwd: process.cwd(),
      launch: { file: process.execPath, args: ["-e", CHILD_SCRIPT] },
      columns: 100,
      rows: 30,
      idleTimeoutMs: 60_000,
    } as const;
    let running: Promise<void>;
    if (bun) {
      const entry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
      const child = spawn(bun, [entry], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          [RUNTIME_HOST_ENV]: encodeRuntimeHostPayload(payload),
        },
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
      return value && (await probeRuntime(value)) ? value : undefined;
    });

    const firstControl = await channel(metadata.socketPath, metadata.token, "client-control", "first");
    const firstFrames: RuntimeHostFrame[] = [];
    const firstReader = new JsonFrameChannel(
      firstControl.socket,
      (value) => firstFrames.push(value as RuntimeHostFrame),
      () => undefined,
      firstControl.rest,
    );
    const firstTerminal = await channel(metadata.socketPath, metadata.token, "client-terminal", "first");
    let firstOutput = firstTerminal.rest.toString("utf8");
    firstTerminal.socket.on("data", (chunk) => {
      firstOutput += chunk.toString("utf8");
    });
    firstTerminal.socket.resume();
    await waitFor(async () => (firstOutput.includes("runtime-ready") ? true : undefined));

    const secondControl = await channel(metadata.socketPath, metadata.token, "client-control", "second");
    const secondFrames: RuntimeHostFrame[] = [];
    const secondReader = new JsonFrameChannel(
      secondControl.socket,
      (value) => secondFrames.push(value as RuntimeHostFrame),
      () => undefined,
      secondControl.rest,
    );
    const secondTerminal = await channel(metadata.socketPath, metadata.token, "client-terminal", "second");
    let secondOutput = secondTerminal.rest.toString("utf8");
    secondTerminal.socket.on("data", (chunk) => {
      secondOutput += chunk.toString("utf8");
    });
    secondTerminal.socket.resume();

    await waitFor(async () =>
      firstFrames.some((frame) => frame.type === "detached" && frame.reason === "taken-over")
        ? true
        : undefined,
    );
    await waitFor(async () =>
      secondOutput.includes("runtime-ready") ? true : undefined,
    );
    expect(secondOutput).toContain("runtime-ready");
    secondTerminal.socket.write("m\r");
    await waitFor(async () =>
      secondFrames.some((frame) => frame.type === "detached" && frame.reason === "minimise")
        ? true
        : undefined,
    );
    expect(await probeRuntime(metadata)).toBe(true);

    firstReader.dispose();
    secondReader.dispose();
    firstControl.socket.destroy();
    firstTerminal.socket.destroy();
    secondControl.socket.destroy();
    secondTerminal.socket.destroy();
    await Promise.race([
      running,
      new Promise<void>((_resolve, reject) => {
        setTimeout(() => {
          void readRuntimeMetadata(sessionId).then((value) =>
            reject(new Error(`runtime host did not exit: ${JSON.stringify(value)}`)),
          );
        }, 3_000).unref?.();
      }),
    ]);
    expect(await readRuntimeMetadata(sessionId)).toBeUndefined();
  }, 10_000);
});

const COMMAND_CHILD_SCRIPT = (rebindId: string): string => String.raw`
const net = require("node:net");
const socket = net.connect(process.env.CLAI_RUNTIME_SOCKET, () => {
  socket.write(JSON.stringify({version:1,type:"auth",role:"child",token:process.env.CLAI_RUNTIME_TOKEN}) + "\n");
});
const send = frame => socket.write(JSON.stringify(frame) + "\n");
const status = (busy, sessionId = process.env.CLAI_RUNTIME_SESSION_ID) => {
  send({type:"status",sessionId,cwd:process.cwd(),busy,title:"Command fixture"});
};
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
    if (frame.type === "shutdown") process.exit(0);
  }
});
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", chunk => {
  for (const command of chunk.toString("utf8").replace(/[\r\n]/g, "")) {
    if (command === "a" || command === "b") {
      process.stdout.write("input:" + command + "\r\n");
    } else if (command === "m") {
      send({type:"minimise"});
    } else if (command === "s") {
      send({type:"switch",sessionId:"switch-keep-target",closeCurrent:false});
    } else if (command === "x") {
      send({type:"switch",sessionId:"switch-close-target",closeCurrent:true});
    } else if (command === "i") {
      status(false);
    } else if (command === "r") {
      status(false, ${JSON.stringify(rebindId)});
    } else if (command === "q") {
      send({type:"exiting",exitCode:0});
      setTimeout(() => process.exit(0), 10);
    } else if (command === "f") {
      process.stdout.write("Z".repeat(1200000) + "FINAL-OUTPUT-MARKER\r\n", () => {
        send({type:"exiting",exitCode:0});
        setTimeout(() => process.exit(0), 10);
      });
    }
  }
});
process.stdout.write("command-runtime-ready\r\n");
`;

interface CommandRuntime {
  readonly sessionId: string;
  readonly rebindId: string;
  readonly metadata: RuntimeMetadata;
  readonly running: Promise<void>;
  readonly fixturePath: string;
  readonly inProcess: boolean;
}

interface TestClient {
  readonly id: string;
  readonly control: Socket;
  readonly terminal: Socket;
  readonly frames: RuntimeHostFrame[];
  readonly output: () => string;
  dispose(): void;
}

async function startCommandRuntime(options: {
  idleTimeoutMs?: number;
} = {}): Promise<CommandRuntime | undefined> {
  const capability = await probePtyCapability();
  const bun = findBunExecutable();
  if (!capability.available && !bun) return undefined;
  const sessionId = `command-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const rebindId = `${sessionId}-rebound`;
  const fixturePath = join(
    tmpdir(),
    `clai-runtime-child-${process.pid}-${Math.random().toString(16).slice(2)}.cjs`,
  );
  await writeFile(fixturePath, COMMAND_CHILD_SCRIPT(rebindId), { mode: 0o600 });
  const payload = {
    version: RUNTIME_PROTOCOL_VERSION,
    sessionId,
    cwd: process.cwd(),
    launch: {
      file: process.execPath,
      args: [fixturePath],
    },
    columns: 100,
    rows: 30,
    idleTimeoutMs: options.idleTimeoutMs ?? 60_000,
  } as const;
  let running: Promise<void>;
  let inProcess = false;
  if (bun) {
    const entry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
    const child = spawn(bun, [entry], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        [RUNTIME_HOST_ENV]: encodeRuntimeHostPayload(payload),
      },
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
    inProcess = true;
    running = new SessionRuntimeHost(payload).run();
  }
  const metadata = await waitFor(async () => {
    const value = await readRuntimeMetadata(sessionId);
    if (value?.phase === "failed") {
      throw new Error(value.error ?? "command runtime failed to start");
    }
    return value?.phase === "running" &&
      value.title === "Command fixture" &&
      (await probeRuntime(value))
      ? value
      : undefined;
  });
  return { sessionId, rebindId, metadata, running, fixturePath, inProcess };
}

async function openTestClient(
  metadata: RuntimeMetadata,
  id: string,
): Promise<TestClient> {
  const controlConnection = await channel(
    metadata.socketPath,
    metadata.token,
    "client-control",
    id,
  );
  const frames: RuntimeHostFrame[] = [];
  const reader = new JsonFrameChannel(
    controlConnection.socket,
    (value) => frames.push(value as RuntimeHostFrame),
    () => undefined,
    controlConnection.rest,
  );
  const terminalConnection = await channel(
    metadata.socketPath,
    metadata.token,
    "client-terminal",
    id,
  );
  let output = terminalConnection.rest.toString("utf8");
  controlConnection.socket.on("error", () => undefined);
  terminalConnection.socket.on("error", () => undefined);
  terminalConnection.socket.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  terminalConnection.socket.resume();
  return {
    id,
    control: controlConnection.socket,
    terminal: terminalConnection.socket,
    frames,
    output: () => output,
    dispose() {
      reader.dispose();
      controlConnection.socket.destroy();
      terminalConnection.socket.destroy();
    },
  };
}

async function waitForRuntimeExit(runtime: CommandRuntime, timeoutMs = 5_000): Promise<void> {
  await Promise.race([
    runtime.running,
    new Promise<void>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`runtime ${runtime.sessionId} did not exit`)),
        timeoutMs,
      );
      timer.unref?.();
    }),
  ]);
  await rm(runtime.fixturePath, { force: true });
}

async function stopCommandRuntime(runtime: CommandRuntime): Promise<void> {
  const metadata =
    (await readRuntimeMetadata(runtime.rebindId)) ??
    (await readRuntimeMetadata(runtime.sessionId));
  let client: TestClient | undefined;
  if (metadata && (await probeRuntime(metadata))) {
    client = await openTestClient(metadata, `cleanup-${Date.now()}`);
    client.terminal.write("q");
  }
  try {
    await waitForRuntimeExit(runtime);
  } finally {
    client?.dispose();
  }
}

describe("session runtime host hardening", () => {
  it("rejects a wrong token and isolates old-terminal input after takeover", async () => {
    const runtime = await startCommandRuntime();
    if (!runtime) return;
    let first: TestClient | undefined;
    let second: TestClient | undefined;
    try {
      const unauthenticated = await connectRuntimeSocket(runtime.metadata.socketPath);
      sendFrame(unauthenticated, {
        version: RUNTIME_PROTOCOL_VERSION,
        type: "auth",
        role: "probe",
        token: "0".repeat(64),
      });
      const rejection = await readFirstFrame(unauthenticated);
      expect(rejection.value).toMatchObject({
        type: "error",
        message: "authentication failed",
      });
      unauthenticated.destroy();
      expect(await probeRuntime(runtime.metadata)).toBe(true);

      first = await openTestClient(runtime.metadata, "takeover-first");
      await waitFor(async () =>
        first?.output().includes("command-runtime-ready") ? true : undefined,
      );
      second = await openTestClient(runtime.metadata, "takeover-second");
      first.terminal.write("a");
      second.terminal.write("b");
      await waitFor(async () =>
        second?.output().includes("input:b") ? true : undefined,
      );
      await waitFor(async () =>
        first?.frames.some(
          (frame) => frame.type === "detached" && frame.reason === "taken-over",
        )
          ? true
          : undefined,
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(second.output()).not.toContain("input:a");
      expect(second.output()).toContain("input:b");
      second.terminal.write("q");
      await waitForRuntimeExit(runtime);
    } finally {
      first?.dispose();
      second?.dispose();
      if (await readRuntimeMetadata(runtime.sessionId)) {
        await stopCommandRuntime(runtime);
      }
    }
  }, 12_000);

  it("switches clients without closing the current runtime when requested", async () => {
    const runtime = await startCommandRuntime();
    if (!runtime) return;
    let client: TestClient | undefined;
    try {
      client = await openTestClient(runtime.metadata, "switch-keep");
      client.terminal.write("s");
      await waitFor(async () =>
        client?.frames.some(
          (frame) => frame.type === "switch" && frame.sessionId === "switch-keep-target",
        )
          ? true
          : undefined,
      );
      expect(await probeRuntime(runtime.metadata)).toBe(true);
    } finally {
      client?.dispose();
      await stopCommandRuntime(runtime);
    }
  }, 10_000);

  it("switches clients and closes the current runtime when requested", async () => {
    const runtime = await startCommandRuntime();
    if (!runtime) return;
    const client = await openTestClient(runtime.metadata, "switch-close");
    try {
      client.terminal.write("x");
      await waitFor(async () =>
        client.frames.some(
          (frame) => frame.type === "switch" && frame.sessionId === "switch-close-target",
        )
          ? true
          : undefined,
      );
      await waitForRuntimeExit(runtime);
      expect(await readRuntimeMetadata(runtime.sessionId)).toBeUndefined();
    } finally {
      client.dispose();
      if (await readRuntimeMetadata(runtime.sessionId)) {
        await stopCommandRuntime(runtime);
      }
    }
  }, 10_000);

  it("starts idle cleanup when only the terminal half closes", async () => {
    const runtime = await startCommandRuntime({
      idleTimeoutMs: 150,
    });
    if (!runtime) return;
    const client = await openTestClient(runtime.metadata, "idle-half-close");
    try {
      client.terminal.write("i");
      await waitFor(
        async () =>
          (await readRuntimeMetadata(runtime.sessionId))?.busy === false
            ? true
            : undefined,
        8_000,
      );
      client.terminal.destroy();
      await waitForRuntimeExit(runtime, 3_000);
      expect(await readRuntimeMetadata(runtime.sessionId)).toBeUndefined();
    } finally {
      client.dispose();
      if (await readRuntimeMetadata(runtime.sessionId)) {
        await stopCommandRuntime(runtime);
      }
    }
  }, 15_000);

  it("cancels idle cleanup when a terminal reattaches", async () => {
    const runtime = await startCommandRuntime({
      idleTimeoutMs: 300,
    });
    if (!runtime) return;
    const client = await openTestClient(runtime.metadata, "idle-reattach");
    let replacement: Socket | undefined;
    try {
      client.terminal.write("i");
      await waitFor(
        async () =>
          (await readRuntimeMetadata(runtime.sessionId))?.busy === false
            ? true
            : undefined,
        8_000,
      );
      client.terminal.destroy();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const attached = await channel(
        runtime.metadata.socketPath,
        runtime.metadata.token,
        "client-terminal",
        client.id,
      );
      replacement = attached.socket;
      replacement.on("error", () => undefined);
      replacement.resume();
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(await probeRuntime(runtime.metadata)).toBe(true);
      replacement.write("q");
      await waitForRuntimeExit(runtime);
    } finally {
      replacement?.destroy();
      client.dispose();
      if (await readRuntimeMetadata(runtime.sessionId)) {
        await stopCommandRuntime(runtime);
      }
    }
  }, 18_000);

  it("reaps a stale destination lock and rebinds metadata to the child session id", async () => {
    const runtime = await startCommandRuntime();
    if (!runtime) return;
    const client = await openTestClient(runtime.metadata, "stale-rebind");
    try {
      const lock = runtimeLockPath(runtime.rebindId);
      await writeFile(
        lock,
        `${JSON.stringify({
          pid: 2_147_483_647,
          identity: "dead",
          createdAt: new Date().toISOString(),
        })}\n`,
        { mode: 0o600 },
      );
      await chmod(lock, 0o600).catch(() => undefined);
      client.terminal.write("r");
      const rebound = await waitFor(async () => {
        const metadata = await readRuntimeMetadata(runtime.rebindId);
        return metadata && (await probeRuntime(metadata)) ? metadata : undefined;
      });
      expect(rebound.sessionId).toBe(runtime.rebindId);
      expect(await readRuntimeMetadata(runtime.sessionId)).toBeUndefined();
      client.terminal.write("q");
      await waitForRuntimeExit(runtime);
    } finally {
      client.dispose();
      if (
        (await readRuntimeMetadata(runtime.rebindId)) ||
        (await readRuntimeMetadata(runtime.sessionId))
      ) {
        await stopCommandRuntime(runtime);
      }
    }
  }, 12_000);

  it("flushes a backpressured final output burst before reporting exit", async () => {
    const runtime = await startCommandRuntime();
    if (!runtime) return;
    const client = await openTestClient(runtime.metadata, "final-output");
    try {
      client.terminal.write("f");
      await waitFor(
        async () => client.output().includes("FINAL-OUTPUT-MARKER") ? true : undefined,
        8_000,
      );
      await waitForRuntimeExit(runtime, 8_000);
      expect(client.output()).toContain("FINAL-OUTPUT-MARKER");
      expect(client.output().length).toBeGreaterThanOrEqual(1_200_000);
    } finally {
      client.dispose();
      if (await readRuntimeMetadata(runtime.sessionId)) {
        await stopCommandRuntime(runtime);
      }
    }
  }, 15_000);
});
