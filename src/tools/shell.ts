import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { ToolResult } from "../types.js";
import { redactSecrets } from "../llm/provider.js";
import { createArtifactStream } from "./artifacts.js";

export interface ShellExecArgs {
  command: string;
  argv?: string[] | undefined;
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  maxOutputBytes?: number | undefined;
  maxArtifactBytes?: number | undefined;
  shell?: boolean | undefined;
  signal?: AbortSignal | undefined;
  onOutput?: ((chunk: string, stream: "stdout" | "stderr") => void) | undefined;
}

export async function shellExec(args: ShellExecArgs): Promise<ToolResult> {
  if (args.signal?.aborted) {
    return { ok: false, output: "Command aborted.", exitCode: 130 };
  }

  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const spawnOptions: SpawnOptions = {
      cwd: args.cwd ?? process.cwd(),
      detached,
      shell: args.shell ?? !args.argv,
      stdio: ["ignore", "pipe", "pipe"],
    };
    const child: ChildProcess = args.argv
      ? spawn(args.command, args.argv, spawnOptions)
      : spawn(args.command, spawnOptions);
    let output = "";
    let aborted = false;
    let timedOut = false;
    let outputTruncated = false;
    let bytesRead = 0;
    let bytesShown = 0;
    let bytesDropped = 0;
    let linesRead = 0;
    let artifactBytes = 0;
    let artifactLimitNoted = false;
    const started = Date.now();
    const maxOutputBytes = args.maxOutputBytes ?? 64_000;
    const maxArtifactBytes = args.maxArtifactBytes ?? 10 * 1024 * 1024;
    const artifact = createArtifactStream("shell.exec");
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      args.signal?.removeEventListener("abort", abort);
    };

    const closeArtifact = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        artifact.stream.end(resolve);
      });
    };

    const writeArtifact = (text: string): void => {
      const bytes = Buffer.byteLength(text);
      const remaining = maxArtifactBytes - artifactBytes;
      if (remaining <= 0) {
        bytesDropped += bytes;
        if (!artifactLimitNoted) {
          artifactLimitNoted = true;
          artifact.stream.write(
            `\n... full output artifact capped at ${maxArtifactBytes} bytes ...\n`,
          );
        }
        return;
      }
      const chunk = bytes > remaining ? text.slice(0, remaining) : text;
      artifact.stream.write(chunk);
      artifactBytes += Buffer.byteLength(chunk);
      if (bytes > remaining) {
        bytesDropped += bytes - remaining;
        artifactLimitNoted = true;
        artifact.stream.write(
          `\n... full output artifact capped at ${maxArtifactBytes} bytes ...\n`,
        );
      }
    };

    const appendModelOutput = (text: string): void => {
      const bytes = Buffer.byteLength(text);
      const remaining = maxOutputBytes - bytesShown;
      if (remaining <= 0) {
        outputTruncated = true;
        return;
      }
      const chunk = bytes > remaining ? text.slice(0, remaining) : text;
      output += chunk;
      bytesShown += Buffer.byteLength(chunk);
      if (bytes > remaining) outputTruncated = true;
    };

    const append = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
      const text = redactSecrets(chunk.toString());
      bytesRead += Buffer.byteLength(text);
      linesRead += text.split(/\r?\n/).length - 1;
      writeArtifact(text);
      appendModelOutput(text);
      args.onOutput?.(text, stream);
    };

    const killChild = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        if (detached) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // Process may have already exited.
      }
    };

    const terminate = (reason: "abort" | "timeout"): void => {
      if (reason === "abort") aborted = true;
      if (reason === "timeout") timedOut = true;
      killChild("SIGTERM");
      forceKill = setTimeout(() => killChild("SIGKILL"), 1_000);
    };

    const abort = (): void => terminate("abort");

    child.stdout?.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk, "stderr"));
    child.on("error", (error: Error) => {
      cleanup();
      if (aborted || args.signal?.aborted) {
        resolve({ ok: false, output: "Command aborted.", exitCode: 130 });
      } else {
        reject(error);
      }
    });
    child.on("close", async (code: number | null) => {
      cleanup();
      await closeArtifact();
      const artifactPath = outputTruncated || bytesDropped > 0 ? artifact.path : undefined;
      if (!artifactPath) artifact.remove();
      const truncationNote = outputTruncated
        ? `\n... model-facing output truncated at ${maxOutputBytes} bytes; full output saved to ${artifact.path} ...`
        : "";
      const trimmed = `${output.trim()}${truncationNote}`.trim();
      const stats = {
        bytesRead,
        bytesShown,
        bytesDropped,
        linesRead,
        elapsedMs: Date.now() - started,
      };
      if (aborted || args.signal?.aborted) {
        resolve({
          ok: false,
          output: trimmed ? `${trimmed}\nCommand aborted.` : "Command aborted.",
          exitCode: 130,
          outputPath: artifactPath,
          truncated: outputTruncated || bytesDropped > 0,
          artifacts: artifactPath
            ? [{ path: artifactPath, kind: "raw", redacted: true }]
            : undefined,
          stats,
        });
        return;
      }
      if (timedOut) {
        resolve({
          ok: false,
          output: trimmed ? `${trimmed}\nCommand timed out.` : "Command timed out.",
          exitCode: 124,
          outputPath: artifactPath,
          truncated: outputTruncated || bytesDropped > 0,
          artifacts: artifactPath
            ? [{ path: artifactPath, kind: "raw", redacted: true }]
            : undefined,
          stats,
        });
        return;
      }
      resolve({
        ok: code === 0,
        output: trimmed,
        exitCode: code ?? undefined,
        outputPath: artifactPath,
        truncated: outputTruncated || bytesDropped > 0,
        artifacts: artifactPath
          ? [{ path: artifactPath, kind: "raw", redacted: true }]
          : undefined,
        stats,
      });
    });

    args.signal?.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => terminate("timeout"), args.timeoutMs ?? 180_000);
  });
}
