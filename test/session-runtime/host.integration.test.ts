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
  dimensions?: { readonly columns: number; readonly rows: number } | undefined,
): Promise<{ socket: Socket; rest: Buffer<ArrayBufferLike> }> {
  const socket = await connectRuntimeSocket(socketPath);
  sendFrame(socket, {
    version: RUNTIME_PROTOCOL_VERSION,
    type: "auth",
    role,
    token,
    clientId,
    ...(role === "client-terminal" && dimensions ? dimensions : {}),
  });
  const first = await readFirstFrame(socket);
  expect(first.value).toMatchObject({ type: "ack" });
  return { socket, rest: first.rest };
}

describe("session runtime host integration", () => {
  it("replays output to multiple viewers and minimises one without killing the child", async () => {
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
      firstFrames.some((frame) => frame.type === "input-owner" && frame.active === false)
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
const status = (busy, sessionId = process.env.CLAI_RUNTIME_SESSION_ID, active = busy) => {
  send({type:"status",sessionId,cwd:process.cwd(),busy,active,title:"Command fixture"});
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
    } else if (command === "p") {
      status(true, process.env.CLAI_RUNTIME_SESSION_ID, false);
    } else if (command === "i") {
      status(false);
    } else if (command === "d") {
      process.stdout.write("query-size:" + process.stdout.columns + "x" + process.stdout.rows + "\r\n");
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
if (process.platform !== "win32") {
  process.on("SIGWINCH", () => {
    process.stdout.write("resize:" + process.stdout.columns + "x" + process.stdout.rows + "\r\n");
  });
}
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

const INDEPENDENT_CHILD_SCRIPT = String.raw`
const net = require("node:net");
const socket = net.connect(process.env.CLAI_RUNTIME_SOCKET, () => {
  send({version:1,type:"auth",role:"child",token:process.env.CLAI_RUNTIME_TOKEN,independentViews:true});
});
const send = frame => socket.write(JSON.stringify(frame) + "\n");
const output = (clientId, text) => send({type:"view-output",clientId,data:Buffer.from(text).toString("base64")});
const dimensions = new Map();
let buffer = "";
socket.on("data", chunk => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const frame = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (frame.type === "ack") {
      send({type:"status",sessionId:process.env.CLAI_RUNTIME_SESSION_ID,cwd:process.cwd(),busy:true,title:"Command fixture"});
      process.stdout.write("GLOBAL_OUTPUT_MUST_NOT_APPEAR\r\n");
    } else if (frame.type === "view-attach" || frame.type === "view-resize") {
      dimensions.set(frame.clientId, frame.columns + "x" + frame.rows);
      output(frame.clientId, frame.clientId + ":" + dimensions.get(frame.clientId) + ":backend:" + process.stdout.columns + "x" + process.stdout.rows + "\n");
    } else if (frame.type === "view-input") {
      const input = Buffer.from(frame.data, "base64").toString("utf8");
      if (input === "m") setTimeout(() => send({type:"minimise",clientId:frame.clientId}), 40);
      else if (input === "q") { send({type:"exiting",exitCode:0}); setTimeout(() => process.exit(0), 10); }
      else output(frame.clientId, "input:" + input + "\n");
    } else if (frame.type === "view-detach") {
      dimensions.delete(frame.clientId);
    } else if (frame.type === "shutdown") process.exit(0);
  }
});
`;

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
  independentViews?: boolean;
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
  await writeFile(fixturePath, options.independentViews ? INDEPENDENT_CHILD_SCRIPT : COMMAND_CHILD_SCRIPT(rebindId), { mode: 0o600 });
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
    ...(options.independentViews ? { independentViews: true } : {}),
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
  dimensions?: { readonly columns: number; readonly rows: number },
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
    dimensions,
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
  it("isolates each terminal's dimensions, input, output, and minimise request", async () => {
    if (process.platform === "win32") return;
    const runtime = await startCommandRuntime({ independentViews: true });
    if (!runtime) return;
    const desktop = await openTestClient(runtime.metadata, "desktop", { columns: 140, rows: 44 });
    const phone = await openTestClient(runtime.metadata, "phone", { columns: 38, rows: 20 });
    try {
      await waitFor(async () => desktop.output().includes("desktop:140x44:backend:100x30") && phone.output().includes("phone:38x20:backend:100x30") ? true : undefined);
      expect(desktop.output()).not.toContain("phone:");
      expect(phone.output()).not.toContain("desktop:");
      expect(desktop.output() + phone.output()).not.toContain("GLOBAL_OUTPUT_MUST_NOT_APPEAR");
      sendFrame(desktop.control, { type: "input", data: Buffer.from("desktop-private").toString("base64") });
      sendFrame(phone.control, { type: "input", data: Buffer.from("phone-private").toString("base64") });
      await waitFor(async () => desktop.output().includes("input:desktop-private") && phone.output().includes("input:phone-private") ? true : undefined);
      expect(desktop.output()).not.toContain("phone-private");
      expect(phone.output()).not.toContain("desktop-private");
      const desktopBefore = desktop.output();
      sendFrame(phone.control, { type: "resize", columns: 28, rows: 12 });
      await waitFor(async () => phone.output().includes("phone:28x12:backend:100x30") ? true : undefined);
      expect(desktop.output()).toBe(desktopBefore);
      sendFrame(desktop.control, { type: "input", data: Buffer.from("m").toString("base64") });
      sendFrame(phone.control, { type: "input", data: Buffer.from("phone-still-live").toString("base64") });
      await waitFor(async () => desktop.frames.some((frame) => frame.type === "detached" && frame.reason === "minimise") ? true : undefined);
      expect(phone.frames.some((frame) => frame.type === "detached")).toBe(false);
      await waitFor(async () => phone.output().includes("input:phone-still-live") ? true : undefined);
      expect(await probeRuntime(runtime.metadata)).toBe(true);
    } finally {
      desktop.dispose();
      phone.dispose();
      await stopCommandRuntime(runtime);
    }
  }, 15_000);

  it("applies attach dimensions before acknowledging a replacement terminal", async () => {
    if (process.platform === "win32") return;
    const runtime = await startCommandRuntime();
    if (!runtime) return;
    const client = await openTestClient(runtime.metadata, "resize-client");
    let replacement: Socket | undefined;
    try {
      sendFrame(client.control, {
        type: "resize",
        columns: 132,
        rows: 47,
      });
      await waitFor(
        async () => client.output().includes("resize:132x47") ? true : undefined,
        8_000,
      );

      client.terminal.destroy();
      const attached = await channel(
        runtime.metadata.socketPath,
        runtime.metadata.token,
        "client-terminal",
        client.id,
        { columns: 144, rows: 52 },
      );
      replacement = attached.socket;
      let replacementOutput = attached.rest.toString("utf8");
      replacement.on("error", () => undefined);
      replacement.on("data", (chunk) => {
        replacementOutput += chunk.toString("utf8");
      });
      replacement.resume();
      // SIGWINCH reaches the child asynchronously, so keep asking until it
      // reports the new geometry. host-resize.test.ts covers the ordering
      // guarantee that the resize precedes the acknowledgement.
      await waitFor(async () => {
        replacement.write("d");
        return /query-size:144x52/.test(replacementOutput) ? true : undefined;
      }, 8_000);
      expect(replacementOutput).toContain("query-size:144x52");

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

  it("rejects invalid attach dimensions without replacing the active terminal", async () => {
    const runtime = await startCommandRuntime();
    if (!runtime) return;
    const client = await openTestClient(runtime.metadata, "invalid-resize");
    let invalid: Socket | undefined;
    try {
      invalid = await connectRuntimeSocket(runtime.metadata.socketPath);
      sendFrame(invalid, {
        version: RUNTIME_PROTOCOL_VERSION,
        type: "auth",
        role: "client-terminal",
        token: runtime.metadata.token,
        clientId: client.id,
        columns: 19,
        rows: 30,
      });
      await expect(readFirstFrame(invalid)).rejects.toThrow();
      expect(await probeRuntime(runtime.metadata)).toBe(true);
      client.terminal.write("d");
      await waitFor(async () =>
        client.output().includes("query-size:100x30") ? true : undefined,
      );
      client.terminal.write("q");
      await waitForRuntimeExit(runtime);
    } finally {
      invalid?.destroy();
      client.dispose();
      if (await readRuntimeMetadata(runtime.sessionId)) {
        await stopCommandRuntime(runtime);
      }
    }
  }, 12_000);

  it("preserves the current terminal until a replacement finishes terminal authentication", async () => {
    const runtime = await startCommandRuntime();
    if (!runtime) return;
    const current = await openTestClient(runtime.metadata, "current-client");
    const candidate = await channel(runtime.metadata.socketPath, runtime.metadata.token, "client-control", "candidate-client");
    let invalid: Socket | undefined;
    let replacement: Socket | undefined;
    try {
      expect(current.frames.some((frame) => frame.type === "detached")).toBe(false);
      invalid = await connectRuntimeSocket(runtime.metadata.socketPath);
      sendFrame(invalid, { version: RUNTIME_PROTOCOL_VERSION, type: "auth", role: "client-terminal", token: runtime.metadata.token,
        clientId: "candidate-client", columns: 19, rows: 30 });
      await expect(readFirstFrame(invalid)).rejects.toThrow();
      current.terminal.write("d");
      await waitFor(async () => current.output().includes("query-size:100x30") ? true : undefined);
      expect(current.frames.some((frame) => frame.type === "detached")).toBe(false);
      const attached = await channel(runtime.metadata.socketPath, runtime.metadata.token, "client-terminal", "candidate-client");
      replacement = attached.socket;
      replacement.resume();
      await waitFor(async () => current.frames.some((frame) => frame.type === "input-owner" && frame.active === false) ? true : undefined);
      expect(await probeRuntime(runtime.metadata)).toBe(true);
      replacement.write("q");
      await waitForRuntimeExit(runtime);
    } finally {
      invalid?.destroy();
      replacement?.destroy();
      candidate.socket.destroy();
      current.dispose();
      if (await readRuntimeMetadata(runtime.sessionId)) await stopCommandRuntime(runtime);
    }
  }, 12_000);

  it("rejects a wrong token, broadcasts live output, and transfers input ownership", async () => {
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
          (frame) => frame.type === "input-owner" && frame.active === false,
        )
          ? true
          : undefined,
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(second.output()).not.toContain("input:a");
      expect(second.output()).toContain("input:b");
      await waitFor(async () => first?.output().includes("input:b") ? true : undefined);
      expect(first.frames.some((frame) => frame.type === "detached")).toBe(false);
      sendFrame(first.control, { type: "claim-input" });
      await waitFor(async () => first?.frames.at(-1)?.type === "input-owner" &&
        (first.frames.at(-1) as { active: boolean }).active ? true : undefined);
      first.terminal.write("a");
      await waitFor(async () => second?.output().includes("input:a") ? true : undefined);
      first.terminal.write("q");
      await waitForRuntimeExit(runtime);
    } finally {
      first?.dispose();
      second?.dispose();
      if (await readRuntimeMetadata(runtime.sessionId)) {
        await stopCommandRuntime(runtime);
      }
    }
  }, 12_000);

  it("accepts every input batch from both terminals without an ownership handshake", async () => {
    const runtime = await startCommandRuntime();
    if (!runtime) return;
    const first = await openTestClient(runtime.metadata, "input-first");
    let second: TestClient | undefined;
    try {
      await waitFor(async () => first.output().includes("command-runtime-ready") ? true : undefined);
      second = await openTestClient(runtime.metadata, "input-second");
      sendFrame(first.control, { type: "input", data: "invalid!" });
      for (let index = 0; index < 32; index += 1) {
        sendFrame(first.control, { type: "input", data: Buffer.from("a").toString("base64") });
        sendFrame(second.control, { type: "input", data: Buffer.from("b").toString("base64") });
      }
      await waitFor(async () => [first, second!].every((client) =>
        (client.output().match(/input:a/g)?.length ?? 0) === 32 &&
        (client.output().match(/input:b/g)?.length ?? 0) === 32) ? true : undefined);
      expect(first.frames.some((frame) => frame.type === "detached")).toBe(false);
      expect(second.frames.some((frame) => frame.type === "detached")).toBe(false);
      sendFrame(first.control, { type: "input", data: Buffer.from("q").toString("base64") });
      await waitForRuntimeExit(runtime);
    } finally {
      first.dispose();
      second?.dispose();
      if (await readRuntimeMetadata(runtime.sessionId)) await stopCommandRuntime(runtime);
    }
  }, 12_000);

  it("fits both viewers and restores the remaining terminal after the owner disconnects", async () => {
    const runtime = await startCommandRuntime();
    if (!runtime) return;
    const first = await openTestClient(runtime.metadata, "shared-large", { columns: 140, rows: 45 });
    let second: TestClient | undefined;
    try {
      await waitFor(async () => first.output().includes("command-runtime-ready") ? true : undefined);
      second = await openTestClient(runtime.metadata, "shared-small", { columns: 80, rows: 20 });
      if (process.platform !== "win32") {
        await waitFor(async () => first.output().includes("resize:80x20") ? true : undefined);
      }
      second.terminal.write("d");
      await waitFor(async () => first.output().includes("query-size:80x20") && second?.output().includes("query-size:80x20") ? true : undefined);
      expect(first.frames.some((frame) => frame.type === "detached")).toBe(false);
      second.dispose();
      await waitFor(async () => first.frames.at(-1)?.type === "input-owner" &&
        (first.frames.at(-1) as { active: boolean }).active ? true : undefined);
      if (process.platform !== "win32") {
        await waitFor(async () => first.output().includes("resize:140x45") ? true : undefined);
      }
      first.terminal.write("d");
      await waitFor(async () => first.output().includes("query-size:140x45") ? true : undefined);
      await waitFor(async () => (await readRuntimeMetadata(runtime.sessionId))?.attached ? true : undefined);
      expect(await probeRuntime(runtime.metadata)).toBe(true);
      first.terminal.write("q");
      await waitForRuntimeExit(runtime);
    } finally {
      first.dispose();
      second?.dispose();
      if (await readRuntimeMetadata(runtime.sessionId)) await stopCommandRuntime(runtime);
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

  it("keeps the shared runtime alive when another viewer switches sessions", async () => {
    const runtime = await startCommandRuntime();
    if (!runtime) return;
    const first = await openTestClient(runtime.metadata, "switch-staying");
    const second = await openTestClient(runtime.metadata, "switch-leaving");
    try {
      second.terminal.write("x");
      await waitFor(async () => second.frames.some((frame) => frame.type === "switch") ? true : undefined);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await probeRuntime(runtime.metadata)).toBe(true);
      expect(first.frames.some((frame) => frame.type === "exit" || frame.type === "detached")).toBe(false);
      first.terminal.write("a");
      await waitFor(async () => first.output().includes("input:a") ? true : undefined);
      first.terminal.write("q");
      await waitForRuntimeExit(runtime);
    } finally {
      first.dispose();
      second.dispose();
      if (await readRuntimeMetadata(runtime.sessionId)) await stopCommandRuntime(runtime);
    }
  }, 12_000);

  it("starts idle cleanup when only the terminal half closes", async () => {
    const runtime = await startCommandRuntime({
      idleTimeoutMs: 150,
    });
    if (!runtime) return;
    const client = await openTestClient(runtime.metadata, "idle-half-close");
    try {
      client.terminal.write("p");
      await waitFor(
        async () => {
          const metadata = await readRuntimeMetadata(runtime.sessionId);
          return metadata?.busy === true && metadata.active === false
            ? true
            : undefined;
        },
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
      expect((await readRuntimeMetadata(runtime.sessionId))?.attached).toBe(true);
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
