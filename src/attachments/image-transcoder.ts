import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import { findExecutable } from "../os/command.js";
import type { ImageDimensions } from "./image-content.js";

const execute = promisify(execFile);
const TRANSCODE_TIMEOUT_MS = 30_000;

export interface TranscodeTarget {
  readonly format: "png" | "jpeg";
  readonly maxDimension: number;
  readonly quality: number;
  readonly shrinks: boolean;
}

export interface ImageTranscoder {
  readonly command: string;
  readonly executable: string;
}

export async function availableTranscoders(): Promise<ImageTranscoder[]> {
  const commands = platform() === "darwin"
    ? ["magick", "convert", "sips", "ffmpeg"]
    : platform() === "win32" ? ["magick", "ffmpeg"] : ["magick", "convert", "ffmpeg"];
  const tools = await Promise.all(commands.map(async (command) => {
    const executable = await findExecutable(command);
    return executable ? { command, executable } : undefined;
  }));
  return tools.filter((tool): tool is ImageTranscoder => tool !== undefined);
}

function transcodeArguments(source: string, destination: string, target: TranscodeTarget, command: string): string[] | undefined {
  if (command === "sips") {
    const argv = ["-s", "format", target.format];
    if (target.format === "jpeg") argv.push("-s", "formatOptions", String(target.quality));
    if (target.shrinks) argv.push("-Z", String(target.maxDimension));
    return [...argv, source, "--out", destination];
  }
  if (command === "ffmpeg") {
    if (target.format !== "png") return undefined;
    return ["-y", "-loglevel", "error", "-i", source, "-vf",
      `scale=w=min(iw\\,${target.maxDimension}):h=min(ih\\,${target.maxDimension}):force_original_aspect_ratio=decrease`,
      "-frames:v", "1", destination];
  }
  const argv = [`${source}[0]`, "-auto-orient", "-strip"];
  if (target.shrinks) argv.push("-resize", `${target.maxDimension}x${target.maxDimension}>`);
  if (target.format === "jpeg") {
    argv.push("-background", "white", "-alpha", "remove", "-alpha", "off", "-quality", String(target.quality));
  } else {
    argv.push("-define", "png:compression-level=6");
  }
  return [...argv, destination];
}

export async function transcodeImage(tool: ImageTranscoder, source: string, destination: string, target: TranscodeTarget, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const args = transcodeArguments(source, destination, target, tool.command);
  if (!args) return false;
  try {
    await execute(tool.executable, args, { timeout: TRANSCODE_TIMEOUT_MS, maxBuffer: 4096, signal, windowsHide: true });
    return true;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

export async function externalDimensions(path: string, signal?: AbortSignal): Promise<ImageDimensions | undefined> {
  const attempts: Array<[string, string[]]> = [["magick", ["identify", "-format", "%w %h", `${path}[0]`]]];
  if (platform() !== "win32") attempts.push(["identify", ["-format", "%w %h", `${path}[0]`]]);
  if (platform() === "darwin") attempts.push(["sips", ["-g", "pixelWidth", "-g", "pixelHeight", path]]);
  for (const [command, args] of attempts) {
    signal?.throwIfAborted();
    const executable = await findExecutable(command);
    if (!executable) continue;
    try {
      const { stdout } = await execute(executable, args, { encoding: "utf8", timeout: 10_000, maxBuffer: 4096, signal, windowsHide: true });
      const width = /pixelWidth:\s*(\d+)/.exec(stdout)?.[1];
      const height = /pixelHeight:\s*(\d+)/.exec(stdout)?.[1];
      const pair = /^(\d+)\s+(\d+)/.exec(stdout.trim());
      const dimensions = width && height ? { width: Number(width), height: Number(height) }
        : pair ? { width: Number(pair[1]), height: Number(pair[2]) } : undefined;
      if (dimensions && dimensions.width > 0 && dimensions.height > 0) return dimensions;
    } catch {
      signal?.throwIfAborted();
    }
  }
  return undefined;
}
