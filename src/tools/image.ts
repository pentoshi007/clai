import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ToolResult } from "../types.js";
import { spawnArgv } from "./shell.js";

export interface ImageToolRunOptions {
  signal?: AbortSignal | undefined;
  onOutput?: ((chunk: string, stream: "stdout" | "stderr") => void) | undefined;
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

/** Fast, safe OCR wrapper for image text extraction.
 *
 * This intentionally uses argv (not shell parsing) so paths with spaces or
 * macOS narrow no-break-space screenshot names cannot corrupt the tesseract
 * argument order. It is a fallback for non-vision models only; vision models
 * should inspect images directly for colors/layout/style.
 */
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
  if (!/^[A-Za-z0-9_+-]+$/.test(lang)) {
    return {
      ok: false,
      output: "image.ocr: lang may contain only letters, digits, _, +, or -",
      exitCode: 1,
    };
  }

  const psmRaw = optionalNumber(args, "psm") ?? 6;
  const psm = Math.floor(psmRaw);
  if (!Number.isFinite(psmRaw) || psm < 0 || psm > 13) {
    return {
      ok: false,
      output: "image.ocr: psm must be an integer from 0 to 13",
      exitCode: 1,
    };
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
  } catch (error) {
    return {
      ok: false,
      output: `image.ocr: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: 1,
    };
  }

  return spawnArgv({
    command: "tesseract",
    argv: [path, "stdout", "-l", lang, "--psm", String(psm)],
    timeoutMs: 60_000,
    signal: options.signal,
    onOutput: options.onOutput,
    maxModelBytes: 32_000,
  });
}
