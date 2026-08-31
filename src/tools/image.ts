import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ChatImage, ProviderId, ToolResult } from "../types.js";
import {
  detectConvertibleImageFormat,
  detectModelImageMediaType,
  formatByteSize,
} from "../attachments/image-content.js";
import {
  describePreparedImage,
  imageBudgetFor,
  prepareImageForModel,
} from "../attachments/image-prepare.js";
import { modelSupportsVision } from "../llm/capabilities.js";
import {
  LANG_PATTERN,
  MIN_RELIABLE_CONFIDENCE,
  meaningfulCharCount,
  runOcr,
} from "./ocr.js";

export interface ImageToolRunOptions {
  signal?: AbortSignal | undefined;
  onOutput?: ((chunk: string, stream: "stdout" | "stderr") => void) | undefined;
  llmProvider?: ProviderId | undefined;
  llmModel?: string | undefined;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  return typeof value === "number" ? value : undefined;
}

function optionalBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

async function isDecodableImage(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(64);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return detectConvertibleImageFormat(header.subarray(0, bytesRead)) !== undefined;
  } finally {
    await handle.close();
  }
}

export async function imageOcr(
  args: Record<string, unknown>,
  options: ImageToolRunOptions = {},
): Promise<ToolResult> {
  const rawPath = optionalString(args, "path");
  if (!rawPath) {
    return {
      ok: false,
      output: 'image.ocr expects { "path": "/path/to/image.png" }',
      exitCode: 1,
    };
  }

  const lang = optionalString(args, "lang") ?? "eng";
  if (!LANG_PATTERN.test(lang)) {
    return {
      ok: false,
      output: "image.ocr: lang may contain only letters, digits, _, +, or -",
      exitCode: 1,
    };
  }

  const psmRaw = optionalNumber(args, "psm");
  let psmCandidates = [6, 3, 11];
  if (psmRaw !== undefined) {
    const psm = Math.floor(psmRaw);
    if (!Number.isFinite(psmRaw) || psm < 0 || psm > 13) {
      return {
        ok: false,
        output: "image.ocr: psm must be an integer from 0 to 13",
        exitCode: 1,
      };
    }
    psmCandidates = [psm];
  }

  const path = resolve(expandHome(rawPath));
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return {
        ok: false,
        output: `image.ocr: not a regular file: ${path}`,
        exitCode: 1,
      };
    }
    if (info.size === 0) {
      return {
        ok: false,
        output: `image.ocr: ${path} is empty (0 bytes)`,
        exitCode: 1,
      };
    }
    if (!(await isDecodableImage(path))) {
      return {
        ok: false,
        output: `image.ocr: ${path} is not a decodable image (expected PNG, JPEG, GIF, WebP, BMP, TIFF, HEIC or AVIF). For PDFs use pdf.read instead.`,
        exitCode: 1,
      };
    }
  } catch (error) {
    return {
      ok: false,
      output: `image.ocr: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: 1,
    };
  }

  const result = await runOcr({
    path,
    lang,
    psmCandidates,
    timeoutMs: optionalNumber(args, "timeoutMs") ?? 60_000,
    preprocess: optionalBoolean(args, "preprocess") ?? true,
    signal: options.signal,
    onOutput: options.onOutput,
  });

  if (!result.ok) {
    return {
      ok: false,
      output: `image.ocr failed on ${path}: ${result.error ?? "unknown error"}`,
      exitCode: 1,
    };
  }

  if (meaningfulCharCount(result.text) === 0) {
    return {
      ok: true,
      output: `image.ocr: no text was recognized in ${path}. The image may contain no text, or the text may be too small or low-contrast for OCR — if the active model supports vision, inspect the image directly instead.`,
    };
  }

  if (!result.reliable) {
    return {
      ok: true,
      output:
        `image.ocr: no reliable text in ${path} (mean confidence ${result.confidence}%, below the ${MIN_RELIABLE_CONFIDENCE}% threshold). ` +
        "The candidate output was discarded because it is OCR noise, not text — do NOT guess at the image contents from it. " +
        "This usually means the image is a photo, diagram or UI capture without clean machine-readable text. " +
        "If the active model supports vision, inspect the attached image directly instead.",
    };
  }

  const header =
    `[image.ocr ${path} — psm ${result.psm}, confidence ${result.confidence}%` +
    (result.preprocessed ? ", upscaled for OCR" : "") +
    "]";
  return { ok: true, output: `${header}\n\n${result.text}` };
}

const MAX_VIEW_IMAGES = 4;

function viewPaths(args: Record<string, unknown>): string[] | string {
  const raw = args.paths ?? args.path;
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const paths: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return "image.view: every path must be a non-empty string";
    }
    const resolved = resolve(expandHome(entry.trim()));
    if (!paths.includes(resolved)) paths.push(resolved);
  }
  if (paths.length === 0) {
    return 'image.view expects { "path": "/path/to/image.png" } or { "paths": [...] }';
  }
  if (paths.length > MAX_VIEW_IMAGES) {
    return `image.view accepts at most ${MAX_VIEW_IMAGES} images per call (got ${paths.length})`;
  }
  return paths;
}

export async function imageView(
  args: Record<string, unknown>,
  options: ImageToolRunOptions = {},
): Promise<ToolResult> {
  const paths = viewPaths(args);
  if (typeof paths === "string") {
    return { ok: false, output: paths, exitCode: 1 };
  }

  const provider = options.llmProvider;
  const model = options.llmModel ?? "";
  if (!provider || !model || !modelSupportsVision(provider, model)) {
    return {
      ok: false,
      output:
        `image.view: ${model || "the active model"} is not known to accept image input, so it cannot look at ` +
        `${paths.length === 1 ? "this image" : "these images"}. ` +
        "Use image.ocr to extract any text instead, or switch to a proven vision model with /model.",
      exitCode: 1,
    };
  }

  const budget = imageBudgetFor(provider, model);
  const images: ChatImage[] = [];
  const notes: string[] = [];
  const failures: string[] = [];
  let totalBytes = 0;

  for (const path of paths) {
    options.signal?.throwIfAborted();
    const prepared = prepareImageForModel(path, budget);
    if (!prepared.ok) {
      failures.push(`${path} — ${prepared.reason}`);
      continue;
    }
    if (totalBytes + prepared.byteLength > budget.maxTotalBytes) {
      failures.push(
        `${path} — skipped, this call already carries ${formatByteSize(totalBytes)} and the ` +
          `${budget.label} request limit is ${formatByteSize(budget.maxTotalBytes)}`,
      );
      continue;
    }
    let bytes: Buffer;
    try {
      const handle = await open(prepared.path, "r");
      try {
        const current = await handle.stat();
        if (!current.isFile()) {
          failures.push(`${path} — prepared path is no longer a regular file`);
          continue;
        }
        if (current.size > budget.hardMaxBytes) {
          failures.push(
            `${path} — changed to ${formatByteSize(current.size)}, above the ` +
              `${formatByteSize(budget.hardMaxBytes)} per-image limit for ${budget.label} models`,
          );
          continue;
        }
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (error) {
      failures.push(
        `${path} — could not be read (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    if (bytes.byteLength > budget.hardMaxBytes) {
      failures.push(
        `${path} — changed to ${formatByteSize(bytes.byteLength)}, above the ` +
          `${formatByteSize(budget.hardMaxBytes)} per-image limit for ${budget.label} models`,
      );
      continue;
    }
    if (totalBytes + bytes.byteLength > budget.maxTotalBytes) {
      failures.push(
        `${path} — skipped, the actual bytes would bring this call to ` +
          `${formatByteSize(totalBytes + bytes.byteLength)}, above the ${budget.label} ` +
          `request limit of ${formatByteSize(budget.maxTotalBytes)}`,
      );
      continue;
    }
    const actualMediaType = detectModelImageMediaType(bytes);
    if (!actualMediaType || actualMediaType !== prepared.mediaType) {
      failures.push(`${path} — image bytes changed after preparation; inspect the file and try again`);
      continue;
    }
    totalBytes += bytes.byteLength;
    images.push({
      mediaType: actualMediaType,
      dataBase64: bytes.toString("base64"),
      path: prepared.sourcePath,
    });
    notes.push(
      `${prepared.sourcePath} — ${describePreparedImage({ ...prepared, byteLength: bytes.byteLength })}`,
    );
  }

  if (images.length === 0) {
    return {
      ok: false,
      output:
        `image.view could not attach ${paths.length === 1 ? "the image" : "any image"}:\n` +
        failures.map((line) => `  - ${line}`).join("\n"),
      exitCode: 1,
    };
  }

  const header =
    images.length === 1
      ? "1 image is attached to the next message — look at it directly."
      : `${images.length} images are attached to the next message, in this order — look at them directly.`;
  const output = [
    `[image.view] ${header}`,
    ...notes.map((line, index) => `  ${index + 1}. ${line}`),
    ...(failures.length
      ? ["", "Not attached:", ...failures.map((line) => `  - ${line}`)]
      : []),
    "",
    "Do not OCR these and do not describe them from memory or from the filenames: " +
      "answer from what the pixels actually show.",
  ].join("\n");

  return { ok: true, output, images };
}
