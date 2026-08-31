import { redactSecrets } from "../../llm/provider.js";
import { augmentedPathEnv } from "../../os/command.js";
import { safeCwd } from "../../os/cwd.js";
import { terminateProcessTree } from "../../os/process-tree.js";
import type { ToolResult, ToolStats } from "../../types.js";
import {
  benignNoMatchTool,
  DEFAULT_TIMEOUT_MS,
  redactArtifactInPlace,
} from "./internals.js";
import {
  chooseStdio,
  DEFAULT_MAX_CAPTURE_BYTES,
  DEFAULT_MAX_MODEL_BYTES,
  openArtifact,
  OutputDecoder,
  RingBuffer,
  takeOverCookedStdin,
} from "./capture.js";
import { spawn } from "node:child_process";
import type { WriteStream } from "node:fs";

export interface SpawnArgvArgs {
  command: string;
  argv: string[];
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  onOutput?: ((chunk: string, stream: "stdout" | "stderr") => void) | undefined;
  maxModelBytes?: number | undefined;
  maxCaptureBytes?: number | undefined;
  onLimit?: "terminate" | "continue" | undefined;
  artifactPath?: string | undefined;
  noArtifact?: boolean | undefined;
  /** Sensitive stdin payload written directly to the child and never logged. */
  stdinText?: string | undefined;
  /** See {@link ShellExecArgs.interactiveStdin}. */
  interactiveStdin?: boolean | "auto" | undefined;
}

/**
 * Run a child process with `shell: false`, passing argv directly. Use this
 * for any tool that builds command lines from model-provided strings (eg
 * `net.scan`, `pentest.recon`, `pkg.install`). Sharing argv with the OS
 * shell would let a malicious target turn into "; rm -rf /" — `shell: false`
 * + argv prevents that even if the model is adversarial.
 *
 * The capture pipeline (head + ring-tail + artifact + cap-and-kill + stats)
 * is identical to shellExec.
 */
export async function spawnArgv(args: SpawnArgvArgs): Promise<ToolResult> {
  if (args.signal?.aborted) {
    return { ok: false, output: "Command aborted.", exitCode: 130 };
  }

  const maxModelBytes = args.maxModelBytes ?? DEFAULT_MAX_MODEL_BYTES;
  const maxCaptureBytes = args.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
  const onLimit = args.onLimit ?? "continue";
  const halfModel = Math.max(512, Math.floor(maxModelBytes / 2));

  const display = `${args.command} ${args.argv.join(" ")}`.trim();
  const start = Date.now();
  const artifact = args.noArtifact
    ? undefined
    : await openArtifact(args.command, args.artifactPath);

  let head = "";
  const tail = new RingBuffer(halfModel);
  let bytesRead = 0;
  const decoder = new OutputDecoder();
  let bytesDropped = 0;
  let linesRead = 0;
  let captureLimitHit = false;

  return new Promise((resolve) => {
    const detached = process.platform !== "win32";
    // For spawnArgv we know the exact program; build an `argv0`-style
    // command preview that {@link looksInteractiveStdin} can inspect so
    // `pkg.install` (which invokes `sudo apt …` on Linux) lights up the
    // password-prompt path.
    const previewCommand = `${args.command} ${args.argv.join(" ")}`;
    const stdio =
      args.stdinText !== undefined
        ? (["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"])
        : chooseStdio(previewCommand, args.interactiveStdin);
    const usingInteractiveStdin = stdio[0] === "inherit";
    const restoreStdin = usingInteractiveStdin
      ? takeOverCookedStdin()
      : () => {};
    const child = spawn(args.command, args.argv, {
      cwd: args.cwd ?? safeCwd(),
      detached: detached && !usingInteractiveStdin,
      shell: false,
      stdio,
      env: { ...process.env, PATH: augmentedPathEnv() },
    });
    if (args.stdinText !== undefined) child.stdin?.end(args.stdinText);
    let aborted = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      args.signal?.removeEventListener("abort", abort);
      restoreStdin();
      if (artifact) artifact.stream.end();
    };

    const append = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
      const decoded = decoder.decode(chunk);
      const text = decoded.text;
      bytesRead += decoded.bytes;
      linesRead += text.split("\n").length - 1;
      if (artifact && !captureLimitHit) {
        if (bytesRead <= maxCaptureBytes) {
          artifact.stream.write(text);
        } else {
          const overflow = bytesRead - maxCaptureBytes;
          const allowed = text.length - overflow;
          if (allowed > 0) artifact.stream.write(text.slice(0, allowed));
          captureLimitHit = true;
          artifact.stream.end();
        }
      }
      if (head.length < halfModel) {
        const room = halfModel - head.length;
        head += text.slice(0, room);
        if (text.length > room) tail.push(text.slice(room));
      } else {
        tail.push(text);
      }
      const inMemory = head.length + tail.size();
      bytesDropped = Math.max(0, bytesRead - inMemory);
      args.onOutput?.(text, stream);
      if (captureLimitHit && onLimit === "terminate") terminate("cap");
    };

    const killChild = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      const useGroup = detached && !usingInteractiveStdin;
      if (!useGroup && process.platform !== "win32") {
        try {
          child.kill(signal);
        } catch {
          // already exited
        }
        return;
      }
      terminateProcessTree(child.pid, {
        signal,
        ...(useGroup ? { processGroupId: child.pid } : {}),
      });
    };

    const terminate = (reason: "abort" | "timeout" | "cap"): void => {
      if (reason === "abort") {
        if (aborted) {
          killChild("SIGKILL");
          return;
        }
        aborted = true;
      }
      if (reason === "timeout") timedOut = true;
      killChild("SIGTERM");
      forceKill = setTimeout(() => killChild("SIGKILL"), 500);
    };

    const abort = (): void => terminate("abort");

    child.stdout?.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk, "stderr"));
    child.on("error", (error) => {
      cleanup();
      if (aborted || args.signal?.aborted) {
        resolve({ ok: false, output: "Command aborted.", exitCode: 130 });
      } else {
        // Resolve a structured result instead of rejecting: every caller
        // (pkg.install, pentest.recon, pdf/image OCR) should see an actionable
        // "binary not found" ToolResult rather than a raw spawn ENOENT throw.
        const err = error as NodeJS.ErrnoException;
        const notFound = err.code === "ENOENT";
        resolve({
          ok: false,
          exitCode: 127,
          output: notFound
            ? `${args.command} was not found on PATH. Install it (pkg.install ${args.command}) or use a built-in tool instead.`
            : `Failed to launch ${args.command}: ${err.code ?? err.message}`,
        });
      }
    });
    child.on("close", (code) => {
      cleanup();
      const stats: ToolStats = {
        bytesRead,
        bytesDropped,
        linesRead,
        elapsedMs: Date.now() - start,
        captureLimitHit,
      };
      const trimmedTail = tail.toString().trim();
      const trimmedHead = head.trim();
      const inMemory = head.length + tail.size();
      let combined: string;
      if (bytesRead === 0) {
        combined = "";
      } else if (inMemory >= bytesRead) {
        combined = (head + tail.toString()).trimEnd();
      } else {
        const omittedBytes = bytesRead - inMemory;
        combined =
          `${trimmedHead}\n... (${omittedBytes.toLocaleString()} bytes / ~${linesRead.toLocaleString()} lines truncated — full output in artifact) ...\n${trimmedTail}`.trim();
      }
      const output = redactSecrets(`$ ${display}\n${combined}`.trimEnd());
      const finalize = (result: ToolResult): void => {
        if (artifact) {
          const onFlushed = (): void => {
            void redactArtifactInPlace(artifact.path).then(() =>
              resolve(result),
            );
          };
          if ((artifact.stream as WriteStream).writableFinished) {
            onFlushed();
          } else {
            artifact.stream.once("finish", onFlushed);
            artifact.stream.once("error", onFlushed);
          }
        } else {
          resolve(result);
        }
      };
      if (aborted || args.signal?.aborted) {
        finalize({
          ok: false,
          output: output ? `${output}\nCommand aborted.` : "Command aborted.",
          exitCode: 130,
          ...(artifact ? { outputPath: artifact.path } : {}),
          truncated: bytesRead > inMemory,
          stats,
        });
        return;
      }
      if (timedOut) {
        finalize({
          ok: false,
          output: output
            ? `${output}\nCommand timed out.`
            : "Command timed out.",
          exitCode: 124,
          ...(artifact ? { outputPath: artifact.path } : {}),
          truncated: bytesRead > inMemory,
          stats,
        });
        return;
      }
      if (captureLimitHit) {
        finalize({
          ok: false,
          output: output
            ? `${output}\nCommand killed after exceeding capture cap of ${maxCaptureBytes.toLocaleString()} bytes.`
            : "Command exceeded capture cap.",
          exitCode: 137,
          ...(artifact ? { outputPath: artifact.path } : {}),
          truncated: true,
          stats,
        });
        return;
      }
      const noMatchTool = benignNoMatchTool(args.command, code);
      const benignNote2 = (() => {
        if (!noMatchTool) return undefined;
        if (["diff", "diff3", "cmp", "comm"].includes(noMatchTool))
          return `files differ`;
        if (["test", "["].includes(noMatchTool)) return `condition false`;
        return `no matching lines`;
      })();
      finalize({
        ok: code === 0 || noMatchTool !== undefined,
        output: noMatchTool
          ? `${output ? `${output}\n` : ""}[note: exit=1 from ${noMatchTool} (${benignNote2}) — not an error]`
          : output,
        exitCode: code ?? undefined,
        ...(artifact ? { outputPath: artifact.path } : {}),
        truncated: bytesRead > inMemory,
        stats,
      });
    });

    args.signal?.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(
      () => terminate("timeout"),
      args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  });
}
