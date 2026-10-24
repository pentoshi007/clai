import { mkdir, open, rm, stat } from "node:fs/promises";
import { platform } from "node:os";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { safeCwd } from "../os/cwd.js";
import { scratchDirFor } from "../prompts/index.js";
import {
  detectConvertibleImageFormat,
  detectModelImageMediaType,
  formatByteSize,
  imageBudgetFor,
  readImageDimensions,
  type ImageBudget,
  type ImageDimensions,
  type ModelImageMediaType,
} from "./image-content.js";
import { availableTranscoders, externalDimensions, transcodeImage, type TranscodeTarget } from "./image-transcoder.js";

export { imageBudgetFor };
export type { ImageBudget };

const HEADER_PROBE_BYTES = 262_144;
const ABSOLUTE_MAX_SOURCE_BYTES = 268_435_456;
const MIN_TARGET_DIMENSION = 320;
const MAX_CACHED_PREPARATIONS = 64;

export interface PreparedImage {
  readonly ok: true;
  readonly path: string;
  readonly sourcePath: string;
  readonly mediaType: ModelImageMediaType;
  readonly byteLength: number;
  readonly dimensions?: ImageDimensions | undefined;
  readonly transcoded: boolean;
  readonly resized?: boolean | undefined;
}

export interface RejectedImage {
  readonly ok: false;
  readonly sourcePath: string;
  readonly reason: string;
  readonly recoverable: boolean;
}

export type ImagePreparation = PreparedImage | RejectedImage;

interface ImageProbe {
  readonly byteLength: number;
  readonly mediaType: ModelImageMediaType | undefined;
  readonly format: ReturnType<typeof detectConvertibleImageFormat>;
  readonly dimensions: ImageDimensions | undefined;
}

async function probeImage(path: string, byteLength: number, signal?: AbortSignal): Promise<ImageProbe> {
  signal?.throwIfAborted();
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(byteLength, HEADER_PROBE_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);
    return { byteLength, mediaType: detectModelImageMediaType(head), format: detectConvertibleImageFormat(head), dimensions: readImageDimensions(head) };
  } finally {
    await handle.close();
  }
}

export async function hasImageTranscoder(): Promise<boolean> {
  return (await availableTranscoders()).length > 0;
}

export function imageTranscoderHint(): string {
  return platform() === "darwin"
    ? "install ImageMagick (brew install imagemagick) or resize it with sips"
    : platform() === "win32"
      ? "install ImageMagick (scoop install imagemagick) and retry"
      : "install ImageMagick (apt install imagemagick / dnf install ImageMagick) and retry";
}

function scale(dimension: number, factor: number): number {
  return Math.max(MIN_TARGET_DIMENSION, Math.round(dimension * factor));
}

function ladderFor(budget: ImageBudget, probe: ImageProbe): TranscodeTarget[] {
  const longestEdge = probe.dimensions ? Math.max(probe.dimensions.width, probe.dimensions.height) : undefined;
  const base = longestEdge === undefined ? budget.maxDimension : Math.max(MIN_TARGET_DIMENSION, Math.min(budget.maxDimension, longestEdge));
  const photographic = probe.format === "image/jpeg" || probe.format === "image/heic" || probe.format === "image/avif";
  const plan: Array<[TranscodeTarget["format"], number, number]> = photographic
    ? [["jpeg", base, 88], ["jpeg", scale(base, 0.75), 84], ["jpeg", scale(base, 0.5), 78]]
    : [["png", base, 100], ["jpeg", base, 92], ["jpeg", base, 80], ["png", scale(base, 0.75), 100], ["jpeg", scale(base, 0.75), 85]];
  plan.push(["jpeg", Math.min(base, 1280), 78], ["jpeg", Math.min(base, 1024), 70], ["jpeg", Math.min(base, 800), 58]);
  const seen = new Set<string>();
  return plan.flatMap(([format, maxDimension, quality]) => {
    const key = `${format}:${maxDimension}:${quality}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ format, maxDimension, quality, shrinks: longestEdge === undefined || longestEdge > maxDimension }];
  });
}

async function transcodeToBudget(source: string, probe: ImageProbe, budget: ImageBudget, baseDir: string, signal?: AbortSignal): Promise<PreparedImage | undefined> {
  const tools = await availableTranscoders();
  if (tools.length === 0) return undefined;
  const directory = join(scratchDirFor(baseDir), "attachments", "fitted");
  await mkdir(directory, { recursive: true });
  const stem = basename(source, extname(source)).replace(/[^\w.-]+/g, "_").slice(0, 60) || "image";
  const prefix = `${randomUUID()}-${stem}`;
  const outputs = new Set<string>();
  let best: PreparedImage | undefined;
  let selected: PreparedImage | undefined;
  try {
    for (const target of ladderFor(budget, probe)) {
      const destination = join(directory, `${prefix}-${target.maxDimension}q${target.quality}.${target.format === "png" ? "png" : "jpg"}`);
      outputs.add(destination);
      for (const tool of tools) {
        signal?.throwIfAborted();
        await rm(destination, { force: true });
        if (!(await transcodeImage(tool, source, destination, target, signal))) continue;
        const byteLength = await stat(destination).then((info) => info.isFile() ? info.size : 0, () => 0);
        if (byteLength === 0) continue;
        const output = await probeImage(destination, byteLength, signal);
        if (!output.mediaType) continue;
        const sourceEdge = probe.dimensions ? Math.max(probe.dimensions.width, probe.dimensions.height) : undefined;
        const outputEdge = output.dimensions ? Math.max(output.dimensions.width, output.dimensions.height) : undefined;
        const candidate: PreparedImage = {
          ok: true, path: destination, sourcePath: source, mediaType: output.mediaType,
          byteLength, dimensions: output.dimensions, transcoded: true,
          resized: sourceEdge === undefined || outputEdge === undefined || outputEdge < sourceEdge,
        };
        if (byteLength <= budget.maxBytes) {
          selected = candidate;
          return selected;
        }
        if (!best || byteLength < best.byteLength) best = candidate;
        break;
      }
    }
    selected = best && best.byteLength <= budget.hardMaxBytes ? best : undefined;
    return selected;
  } finally {
    await Promise.all([...outputs].filter((path) => path !== selected?.path).map((path) => rm(path, { force: true }).catch(() => undefined)));
  }
}

const preparationCache = new Map<string, PreparedImage>();

export function clearImagePreparationCache(): void {
  preparationCache.clear();
}

function reject(sourcePath: string, reason: string, recoverable = false): RejectedImage {
  return { ok: false, sourcePath, reason, recoverable };
}

export async function prepareImageForModel(sourcePath: string, budget: ImageBudget, baseDir: string = safeCwd(), signal?: AbortSignal): Promise<ImagePreparation> {
  signal?.throwIfAborted();
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(sourcePath);
  } catch (error) {
    return reject(sourcePath, `could not be read (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!info.isFile()) return reject(sourcePath, "is not a regular file");
  if (info.size === 0) return reject(sourcePath, "is empty (0 bytes)");
  if (info.size > ABSOLUTE_MAX_SOURCE_BYTES) return reject(sourcePath, `is ${formatByteSize(info.size)}, far beyond any model image limit`);
  const key = `${baseDir}|${sourcePath}|${info.mtimeMs}|${info.ctimeMs}|${info.size}|${budget.maxBytes}|${budget.hardMaxBytes}|${budget.maxDimension}`;
  const cached = preparationCache.get(key);
  if (cached && await stat(cached.path).then((current) => current.isFile() && current.size === cached.byteLength, () => false)) {
    signal?.throwIfAborted();
    preparationCache.delete(key);
    preparationCache.set(key, cached);
    return cached;
  }
  const outcome = await prepare(sourcePath, info.size, budget, baseDir, signal);
  signal?.throwIfAborted();
  if (outcome.ok) {
    preparationCache.set(key, outcome);
    if (preparationCache.size > MAX_CACHED_PREPARATIONS) preparationCache.delete(preparationCache.keys().next().value!);
  }
  return outcome;
}

async function prepare(sourcePath: string, size: number, budget: ImageBudget, baseDir: string, signal?: AbortSignal): Promise<ImagePreparation> {
  let probe: ImageProbe;
  try {
    probe = await probeImage(sourcePath, size, signal);
  } catch (error) {
    signal?.throwIfAborted();
    return reject(sourcePath, `could not be read (${error instanceof Error ? error.message : String(error)})`);
  }
  const format = probe.format;
  if (!format) return reject(sourcePath, "its bytes are not a supported image (expected PNG, JPEG, GIF, WebP, BMP, TIFF, HEIC or AVIF)");
  if (!probe.dimensions && (probe.mediaType === undefined || size > budget.maxBytes)) {
    const dimensions = await externalDimensions(sourcePath, signal);
    if (dimensions) probe = { ...probe, dimensions };
  }
  const oversizedDimensions = probe.dimensions ? Math.max(probe.dimensions.width, probe.dimensions.height) > budget.maxDimension : false;
  const native: PreparedImage | undefined = probe.mediaType ? {
    ok: true, path: sourcePath, sourcePath, mediaType: probe.mediaType, byteLength: size, dimensions: probe.dimensions, transcoded: false,
  } : undefined;
  if (native && size <= budget.maxBytes && !oversizedDimensions) return native;
  const fitted = await transcodeToBudget(sourcePath, probe, budget, baseDir, signal);
  if (fitted) return fitted;
  if (native && size <= budget.hardMaxBytes) return native;
  if (!probe.mediaType) {
    return reject(sourcePath, `is ${format.replace("image/", "").toUpperCase()}, which models cannot read, and no converter is installed — ${imageTranscoderHint()}`, true);
  }
  return reject(sourcePath,
    `is ${formatByteSize(size)}, above the ${formatByteSize(budget.hardMaxBytes)} per-image limit for ${budget.label} models` +
    (await hasImageTranscoder() ? " and could not be downscaled far enough" : ` and no downscaler is installed — ${imageTranscoderHint()}`), true);
}

export function describePreparedImage(prepared: PreparedImage): string {
  const size = formatByteSize(prepared.byteLength);
  const dimensions = prepared.dimensions ? `${prepared.dimensions.width}x${prepared.dimensions.height}` : "unknown size";
  const format = prepared.mediaType.replace("image/", "").toUpperCase();
  if (!prepared.transcoded) return `${dimensions} ${format} (${size})`;
  return prepared.resized
    ? `resized to ${dimensions} ${format} (${size}) to fit the model input limit`
    : `converted to ${dimensions} ${format} (${size}) so the model can read it`;
}
