import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";
import { processAlive, terminateProcessTree } from "../../src/os/process-tree.js";
import { readRuntimeMetadata } from "../../src/session-runtime/store.js";
import { JsonFrameChannel, connectRuntimeSocket, readFirstFrame, sendFrame } from "../../src/session-runtime/protocol.js";
import type { RuntimeHostFrame, RuntimeMetadata } from "../../src/session-runtime/types.js";

const bun = findBunExecutable();
const runtimes = [
  { name: "Node", file: process.execPath, args: ["--import", "tsx"] },
  ...(bun ? [{ name: "Bun", file: bun, args: [] }] : []),
];

async function attach(metadata: RuntimeMetadata, clientId: string) {
  const sockets: Socket[] = [];
  const frames: RuntimeHostFrame[] = [];
  const control = await connectRuntimeSocket(metadata.socketPath);
  sockets.push(control);
  sendFrame(control, { version: 1, type: "auth", role: "client-control", token: metadata.token, clientId });
  const first = await readFirstFrame(control);
  expect(first.value).toMatchObject({ type: "ack" });
  const channel = new JsonFrameChannel(control, (value) => frames.push(value as RuntimeHostFrame), () => undefined, first.rest);
  const terminal = await connectRuntimeSocket(metadata.socketPath);
  sockets.push(terminal);
  sendFrame(terminal, {
    version: 1, type: "auth", role: "client-terminal", token: metadata.token, clientId,
    columns: 100, rows: 30, terminal: { ui: "classic", env: { TERM: "xterm-256color", NO_COLOR: "1" } },
  });
  const initial = await readFirstFrame(terminal);
  expect(initial.value).toMatchObject({ type: "ack" });
  let output = initial.rest.toString("utf8");
  terminal.on("data", (bytes: Buffer) => { output += bytes.toString("utf8"); });
  terminal.resume();
  return {
    output: () => output, frames,
    input: (text: string) => sendFrame(control, { type: "input", data: Buffer.from(text).toString("base64") }),
    close: () => { channel.dispose(); for (const socket of sockets) socket.destroy(); },
  };
}

describe.each(runtimes)("$name detached startup integration", ({ file, args }) => {
  it("survives its launcher exiting, minimises Classic, and reattaches the same runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "clai startup "));
    const launcher = join(root, "launcher.mjs");
    const sessionId = `startup-integration-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const entryPath = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
    const startupUrl = new URL("../../src/session-runtime/startup.ts", import.meta.url).href;
    await writeFile(launcher, `import { startRuntimeHost } from ${JSON.stringify(startupUrl)};
const metadata = await startRuntimeHost({ entryPath: ${JSON.stringify(entryPath)}, childArgs: ["--classic", "--provider", "ollama", "--model", "fixture"], ui: "classic" }, { sessionId: ${JSON.stringify(sessionId)} });
process.stdout.write(JSON.stringify(metadata) + "\\n");
`);
    const child = spawn(file, [...args, launcher], {
      cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CLAI_NO_UPDATE_CHECK: "1", CLAI_NO_BROWSER: "1", CLAI_DISABLE_KEYCHAIN: "1" },
    });
    let output = "";
    let stderr = "";
    child.stdout.on("data", (bytes: Buffer) => { output += bytes.toString("utf8"); });
    child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString("utf8"); });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
    let metadata: RuntimeMetadata | undefined;
    let first: Awaited<ReturnType<typeof attach>> | undefined;
    let second: Awaited<ReturnType<typeof attach>> | undefined;
    try {
      await expect.poll(() => child.exitCode, { timeout: 35_000, message: "launcher must disconnect its startup IPC" }).not.toBeNull();
      expect(await exited, stderr).toBe(0);
      metadata = JSON.parse(output.trim()) as RuntimeMetadata;
      expect(processAlive(metadata.hostPid)).toBe(true);
      first = await attach(metadata, "first");
      await expect.poll(first.output, { timeout: 20_000 }).toContain("fixture");
      first.input("/minimise\r");
      await expect.poll(() => first!.frames, { timeout: 5_000 }).toContainEqual({ type: "detached", reason: "minimise", sessionId });
      expect(processAlive(metadata.hostPid)).toBe(true);
      first.close();
      second = await attach(metadata, "second");
      await expect.poll(second.output, { timeout: 10_000 }).toContain("fixture");
      expect((await readRuntimeMetadata(sessionId))?.hostPid).toBe(metadata.hostPid);
    } finally {
      first?.close();
      second?.close();
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited.catch(() => undefined);
      metadata ??= await readRuntimeMetadata(sessionId);
      if (metadata) {
        terminateProcessTree(metadata.hostPid, { signal: "SIGTERM" });
        await expect.poll(() => processAlive(metadata!.hostPid), { timeout: 15_000 }).toBe(false);
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 80_000);

  it("returns a real startup filesystem error over IPC instead of the generic readiness timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "clai startup failure "));
    const occupied = join(root, "not-a-directory");
    const launcher = join(root, "launcher.mjs");
    const entryPath = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
    const startupUrl = new URL("../../src/session-runtime/startup.ts", import.meta.url).href;
    await writeFile(occupied, "occupied");
    await writeFile(launcher, `import { startRuntimeHost } from ${JSON.stringify(startupUrl)};
try {
  await startRuntimeHost({ entryPath: ${JSON.stringify(entryPath)}, childArgs: ["--classic"], ui: "classic" }, { sessionId: "startup-failure-fixture" });
  process.exitCode = 2;
} catch (error) { process.stdout.write(error.message); }
`);
    const child = spawn(file, [...args, launcher], {
      cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CLAI_DATA_DIR: occupied },
    });
    let output = "";
    child.stdout.on("data", (bytes: Buffer) => { output += bytes.toString("utf8"); });
    child.stderr.resume();
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
    try {
      await expect.poll(() => child.exitCode, { timeout: 20_000 }).not.toBeNull();
      expect(await exited, output).toBe(0);
      expect(output).toMatch(/ENOTDIR|EEXIST/);
      expect(output).not.toContain("did not become ready");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 25_000);
});
