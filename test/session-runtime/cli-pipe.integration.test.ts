import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { isBunRuntime } from "../../src/os/bun-runtime.js";
import { processAlive, terminateProcessTree } from "../../src/os/process-tree.js";
import {
  RUNTIME_CHILD_ENV,
  RUNTIME_HOST_ENV,
  RUNTIME_SESSION_ENV,
  RUNTIME_SOCKET_ENV,
  RUNTIME_TOKEN_ENV,
  RUNTIME_VIEWS_ENV,
} from "../../src/session-runtime/launch.js";
import { ensureRuntimeDirectories, runtimeSocketPath } from "../../src/session-runtime/paths.js";
import { JsonFrameChannel, readFirstFrame, sendFrame } from "../../src/session-runtime/protocol.js";
import type { RuntimeChildFrame } from "../../src/session-runtime/types.js";

it("starts the auto-UI child over open pipes and detaches its classic view without consuming stdin", async () => {
  const sessionId = `pipe-cli-${Date.now()}-${process.pid}`;
  const socketPath = runtimeSocketPath(sessionId);
  const token = "a".repeat(64);
  const frames: RuntimeChildFrame[] = [];
  let connection: Socket | undefined;
  let channel: JsonFrameChannel | undefined;
  let output = "";
  let stderr = "";
  const server = createServer((socket) => {
    connection = socket;
    socket.on("error", () => undefined);
    void readFirstFrame(socket).then((first) => {
      expect(first.value).toMatchObject({ type: "auth", role: "child", token, independentViews: true });
      sendFrame(socket, { version: 1, type: "ack", sessionId, independentViews: true });
      channel = new JsonFrameChannel(socket, (value) => {
        const frame = value as RuntimeChildFrame;
        frames.push(frame);
        if (frame.type === "view-output") output += Buffer.from(frame.data, "base64").toString("utf8");
      }, () => undefined, first.rest);
      sendFrame(socket, {
        type: "view-attach", clientId: "classic", columns: 100, rows: 30,
        terminal: { ui: "classic", env: { TERM: "xterm-256color" } },
      });
    }).catch((error: Error) => { stderr += error.message; });
  });
  await ensureRuntimeDirectories();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  const entry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
  const env = {
    ...process.env,
    [RUNTIME_CHILD_ENV]: "1",
    [RUNTIME_SESSION_ENV]: sessionId,
    [RUNTIME_SOCKET_ENV]: socketPath,
    [RUNTIME_TOKEN_ENV]: token,
    [RUNTIME_VIEWS_ENV]: "1",
    CLAI_NO_UPDATE_CHECK: "1", CLAI_NO_BROWSER: "1", CLAI_DISABLE_KEYCHAIN: "1",
  };
  delete env[RUNTIME_HOST_ENV];
  const child = spawn(process.execPath, [
    ...(isBunRuntime() ? [] : ["--import", "tsx"]), entry, "--provider", "ollama", "--model", "fixture",
  ], { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stdout.resume();
  child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString("utf8"); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  try {
    await expect.poll(() => output, { timeout: 15_000, message: "pipe child did not paint its view" }).toContain("fixture");
    expect(child.stdin.writable).toBe(true);
    expect(child.exitCode, stderr).toBeNull();
    sendFrame(connection!, {
      type: "view-input", clientId: "classic", data: Buffer.from("/minimise\r").toString("base64"),
    });
    await expect.poll(() => frames, { timeout: 5_000 }).toContainEqual({ type: "minimise", clientId: "classic" });
    expect(processAlive(child.pid!)).toBe(true);
    sendFrame(connection!, { type: "shutdown" });
    expect(await exited, stderr).toBe(0);
  } finally {
    if (child.pid && child.exitCode === null) terminateProcessTree(child.pid, { signal: "SIGKILL" });
    await exited.catch(() => undefined);
    channel?.dispose();
    connection?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== "win32") await rm(socketPath, { force: true });
  }
}, 25_000);
