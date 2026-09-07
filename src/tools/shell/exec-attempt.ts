import { redactSecrets } from "../../llm/provider.js";
import { augmentedPathEnv } from "../../os/command.js";
import { safeCwd } from "../../os/cwd.js";
import { terminateProcessTree } from "../../os/process-tree.js";
import type { ToolResult, ToolStats } from "../../types.js";
import { resolveShell } from "../shell.js";
import {
  benignNoMatchTool,
  binarySuppressionNotice,
  DEFAULT_TIMEOUT_MS,
  launchErrorOutput,
  redactArtifactInPlace,
} from "./internals.js";
import type { ShellExecArgs } from "../shell.js";
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
import { stat } from "node:fs/promises";

export interface ShellExecAttemptResult extends ToolResult {
  launchFailure?:
    | {
        code?: string | undefined;
        shell: string;
        cwd: string;
      }
    | undefined;
}

export async function shellExecAttempt(
  args: ShellExecArgs,
): Promise<ShellExecAttemptResult> {
  if (args.signal?.aborted) {
    return { ok: false, output: "Command aborted.", exitCode: 130, runFailure: true };
  }

  const cwd = args.cwd ?? safeCwd();
  try {
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) {
      return {
        ok: false,
        output:
          `Command launch error [INVALID_CWD]: working directory is not a directory.\n` +
          `cwd=${JSON.stringify(cwd)}\nThe command did not start; correct the shell.exec cwd instead of changing command syntax.`,
        exitCode: 127,
        runFailure: true,
      };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      output:
        `Command launch error [INVALID_CWD]: ${detail}\n` +
        `cwd=${JSON.stringify(cwd)}\nThe command did not start; correct the shell.exec cwd instead of changing command syntax.`,
      exitCode: 127,
      runFailure: true,
    };
  }

  const maxModelBytes = args.maxModelBytes ?? DEFAULT_MAX_MODEL_BYTES;
  const maxCaptureBytes = args.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
  const onLimit = args.onLimit ?? "continue";
  const halfModel = Math.max(512, Math.floor(maxModelBytes / 2));

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
    const stdio = chooseStdio(args.command, args.interactiveStdin);
    const usingInteractiveStdin = stdio[0] === "inherit";
    const restoreStdin = usingInteractiveStdin
      ? takeOverCookedStdin()
      : () => {};
    const shell = resolveShell();
    if (!shell) {
      restoreStdin();
      if (artifact) artifact.stream.end();
      resolve({
        ok: false,
        exitCode: 127,
        output:
          "No usable command shell was found. shell.exec requires /bin/sh (or $SHELL); use a purpose-built tool where available.",
        runFailure: true,
      });
      return;
    }
    const child = spawn(args.command, {
      cwd,
      detached: detached && !usingInteractiveStdin,
      shell,
      stdio,
      env: { ...process.env, PATH: augmentedPathEnv() },
    });
    let aborted = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      args.signal?.removeEventListener("abort", abort);
      restoreStdin();
      if (artifact) {
        artifact.stream.end();
      }
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
      if (captureLimitHit && onLimit === "terminate") {
        terminate("cap");
      }
    };

    const killChild = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      const useGroup = detached && !usingInteractiveStdin;
      if (!useGroup && process.platform !== "win32") {
        try {
          child.kill(signal);
        } catch {
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
        resolve({
          ok: false,
          output: "Command aborted.",
          exitCode: 130,
          runFailure: true,
        });
      } else {
        resolve({
          ok: false,
          exitCode: 127,
          output: launchErrorOutput(error as NodeJS.ErrnoException, {
            shell,
            cwd,
          }),
          launchFailure: {
            code: (error as NodeJS.ErrnoException).code,
            shell,
            cwd,
          },
          runFailure: true,
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

      // Always redact before exposing the bounded text to callers.
      const output = decoder.isBinary
        ? binarySuppressionNotice(bytesRead, artifact?.path)
        : redactSecrets(combined);

      // Redact the on-disk artifact too so `/output last` and any later
      const finalize = (result: ToolResult): void => {
        if (artifact) {
          // Wait for the artifact write stream to flush, then redact in
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
          runFailure: true,
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
          runFailure: true,
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
          runFailure: true,
          ...(artifact ? { outputPath: artifact.path } : {}),
          truncated: true,
          stats,
        });
        return;
      }
      const noMatchTool = benignNoMatchTool(args.command, code);
      const benignNote = (() => {
        if (!noMatchTool) return undefined;
        if (["diff", "diff3", "cmp", "comm"].includes(noMatchTool))
          return `files differ`;
        if (["test", "["].includes(noMatchTool)) return `condition false`;
        return `no matching lines`;
      })();
      finalize({
        ok: code === 0 || noMatchTool !== undefined,
        output: noMatchTool
          ? `${output ? `${output}\n` : ""}[note: exit=1 from ${noMatchTool} (${benignNote}) — not an error]`
          : output,
        exitCode: code ?? undefined,
        runFailure: false,
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
