import { createWriteStream, type WriteStream } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getArtifactDir } from "../../store/paths.js";
import { formatRuntimeError } from "../../os/runtime-error.js";
import type { ToolResult } from "../../types.js";
import { safeArtifactName } from "./artifact-name.js";
import { redactArtifactInPlace } from "./internals.js";

export interface ShellArtifact {
  write(text: string): void;
  end(): void;
  finalize(result: ToolResult): Promise<ToolResult>;
}

export async function openArtifact(
  command: string,
  override?: string,
): Promise<ShellArtifact> {
  const path = override ?? join(
    getArtifactDir(),
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeArtifactName(command)}.txt`,
  );
  let stream: WriteStream | undefined;
  let fileOpened = false;
  let failure: unknown;
  let ended = false;
  let completed = Promise.resolve();

  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const opened = createWriteStream(path, { flags: "w", mode: 0o600 });
    stream = opened;
    opened.once("open", () => { fileOpened = true; });
    completed = new Promise<void>((resolve) => {
      opened.on("error", (error) => { failure ??= error; });
      opened.once("close", () => {
        if (!opened.writableFinished) {
          failure ??= new Error("Output artifact closed before flushing");
        }
        resolve();
      });
    });
  } catch (error) {
    failure = error;
  }

  const end = (): void => {
    if (ended) return;
    ended = true;
    if (!stream || stream.destroyed) return;
    try {
      stream.end();
    } catch (error) {
      failure ??= error;
      stream.destroy();
    }
  };

  return {
    write(text) {
      if (!stream || ended || failure !== undefined) return;
      try {
        stream.write(text);
      } catch (error) {
        failure ??= error;
        stream.destroy();
      }
    },
    end,
    async finalize(result) {
      end();
      await completed;
      if (failure === undefined) {
        await redactArtifactInPlace(path);
        return { ...result, outputPath: path };
      }
      if (fileOpened) {
        const info = await lstat(path).catch(() => undefined);
        if (info?.isFile()) await rm(path, { force: true }).catch(() => undefined);
      }
      const code = failure && typeof failure === "object" && "code" in failure
        ? String(failure.code)
        : "UNKNOWN";
      const safeCode = /^[A-Z0-9_]+$/.test(code) ? code : "UNKNOWN";
      const warning = `Full output could not be saved. ${formatRuntimeError(failure)} Only the bounded preview is available.`;
      return {
        ...result,
        warning,
        output: `${result.output}${result.output ? "\n" : ""}[Full output could not be saved (${safeCode}). Only the bounded preview is available.]`,
      };
    },
  };
}
