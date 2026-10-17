import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { safeCwd } from "../os/cwd.js";
import { updateOriginEnvironment } from "../os/update-origin.js";
import { findBunExecutable, isBunRuntime } from "../os/bun-runtime.js";
import { probeRuntime } from "./discovery.js";
import {
  RUNTIME_CHILD_ENV,
  RUNTIME_HOST_ENV,
  RUNTIME_SESSION_ENV,
  RUNTIME_SOCKET_ENV,
  RUNTIME_TOKEN_ENV,
  RUNTIME_VIEWS_ENV,
  encodeRuntimeHostPayload,
  selfLaunchSpec,
} from "./launch.js";
import { readRuntimeMetadata } from "./store.js";
import { runtimeLockPath } from "./paths.js";
import { RUNTIME_PROTOCOL_VERSION, type RuntimeHostPayload, type RuntimeLaunchSpec, type RuntimeMetadata, type RuntimeTerminalOptions } from "./types.js";

const START_TIMEOUT_MS = 30_000;

export interface RuntimeTarget {
  readonly sessionId: string;
  readonly cwd?: string | undefined;
  readonly resumeId?: string | undefined;
  readonly resumeLatest?: "directory" | "global" | undefined;
}

interface RuntimeStartupOptions {
  readonly entryPath: string;
  readonly childArgs: readonly string[];
  readonly ui?: RuntimeTerminalOptions["ui"] | undefined;
}

function childEnvironment(payload: string): NodeJS.ProcessEnv {
  const env = updateOriginEnvironment();
  delete env[RUNTIME_CHILD_ENV];
  delete env[RUNTIME_SOCKET_ENV];
  delete env[RUNTIME_TOKEN_ENV];
  delete env[RUNTIME_SESSION_ENV];
  delete env[RUNTIME_VIEWS_ENV];
  env[RUNTIME_HOST_ENV] = payload;
  return env;
}

function brokerLaunch(options: RuntimeStartupOptions): RuntimeLaunchSpec {
  const classic = options.ui === "classic" || options.childArgs.includes("--classic");
  const keepNode = process.env.CLAI_FORCE_NODE === "1" || process.env.CLAI_NO_BUN_REEXEC === "1";
  if (!isBunRuntime() && process.platform !== "win32" && !classic && !keepNode) {
    const bun = findBunExecutable();
    if (bun) return { file: bun, args: [options.entryPath] };
  }
  return selfLaunchSpec(options.entryPath, []);
}

export async function startRuntimeHost(
  options: RuntimeStartupOptions,
  target: RuntimeTarget,
): Promise<RuntimeMetadata> {
  const childArgs = [
    ...options.childArgs,
    ...(target.resumeId ? ["--resume", target.resumeId] : []),
    ...(target.resumeLatest ? [target.resumeLatest === "global" ? "--resume" : "--continue"] : []),
  ];
  const runtimeLaunch = brokerLaunch(options);
  const childLaunch = { file: runtimeLaunch.file, args: [...runtimeLaunch.args, ...childArgs] };
  const cwd = target.cwd && (await stat(target.cwd).catch(() => undefined))?.isDirectory()
    ? target.cwd
    : safeCwd();
  const payload: RuntimeHostPayload = {
    version: RUNTIME_PROTOCOL_VERSION,
    sessionId: target.sessionId,
    cwd,
    launch: childLaunch,
    columns: Math.max(20, Math.min(1_000, process.stdout.columns ?? 100)),
    rows: Math.max(5, Math.min(500, process.stdout.rows ?? 30)),
    idleTimeoutMs: idleTimeoutMs(),
    independentViews: true,
  };
  const child = spawn(runtimeLaunch.file, [...runtimeLaunch.args], {
    cwd: payload.cwd,
    env: childEnvironment(encodeRuntimeHostPayload(payload)),
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  let launchError: Error | undefined;
  let exited: string | undefined;
  child.once("error", (error) => {
    launchError = error;
  });
  child.once("exit", (code, signal) => {
    exited = signal ? `was terminated by ${signal}` : `exited with code ${code ?? "unknown"}`;
  });
  const onMessage = (value: unknown): void => {
    if (!value || typeof value !== "object" || !("type" in value) || !("message" in value)) return;
    if (value.type === "runtime-startup-error" && typeof value.message === "string") {
      launchError = new Error(value.message.slice(0, 1_000));
    }
  };
  child.on("message", onMessage);
  child.unref();

  let ready = false;
  try {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      const metadata = await readRuntimeMetadata(target.sessionId);
      if (metadata?.phase === "failed") {
        throw new Error(metadata.error ?? "session runtime failed to start");
      }
      if (metadata?.phase === "running" && (await probeRuntime(metadata))) {
        ready = true;
        return metadata;
      }
      if (exited && (!metadata || metadata.hostPid === child.pid)) {
        const leaseWinnerStarting = exited === "exited with code 0" && !metadata &&
          await stat(runtimeLockPath(target.sessionId)).then(() => true, () => false);
        if (!leaseWinnerStarting) throw new Error(`session runtime host ${exited} before becoming ready`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`session runtime did not become ready within ${START_TIMEOUT_MS / 1_000} seconds`);
  } finally {
    child.off("message", onMessage);
    if (child.connected) child.disconnect();
    if (!ready && child.pid && child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
    }
  }
}

function idleTimeoutMs(): number {
  const configured = Number(process.env.CLAI_SESSION_RUNTIME_IDLE_MS);
  if (!Number.isFinite(configured)) return 30 * 60 * 1_000;
  return Math.max(60_000, Math.min(24 * 60 * 60 * 1_000, Math.floor(configured)));
}
