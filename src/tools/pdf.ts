import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ToolResult } from "../types.js";
import { commandAvailable } from "../os/pkgmgr.js";
import { spawnArgv } from "./shell.js";

export interface PdfToolRunOptions {
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

/**
 * Count the "meaningful" characters in extracted text — letters and digits
 * only. A text PDF returns hundreds; a scanned (image-only) PDF returns a
 * handful of stray glyphs or nothing. We use this to decide whether to fall
 * back to rendering pages and OCR-ing them.
 */
function meaningfulCharCount(text: string): number {
  const matches = text.match(/[A-Za-z0-9]/g);
  return matches ? matches.length : 0;
}

// Below this many meaningful characters we treat pdftotext's output as
// "empty" and switch to the render-then-OCR fallback. Tuned low so a PDF
// with a tiny bit of real text (a cover page) still triggers OCR when the
// body is scanned.
const MIN_MEANINGFUL_CHARS = 16;

/**
 * Read a PDF as text.
 *
 * Strategy (mirrors what a human would do):
 *   1. Run `pdftotext -layout <pdf> -` — fast and exact for born-digital PDFs.
 *   2. If that yields little/no real text the PDF is scanned (image-only), so
 *      render every page to a PNG with `pdftoppm` and OCR each one with
 *      `tesseract`, concatenating the results page by page.
 *
 * Auto-executes (read-only). Returns a helpful error naming the missing
 * binary so the agent can pkg.install it and retry.
 */
export async function pdfRead(
  args: Record<string, unknown>,
  options: PdfToolRunOptions = {},
): Promise<ToolResult> {
  const rawPath = optionalString(args, "path");
  if (!rawPath) {
    return {
      ok: false,
      output: 'pdf.read expects { "path": "/path/to/file.pdf" }',
      exitCode: 1,
    };
  }

  const lang = optionalString(args, "lang") ?? "eng";
  if (!/^[A-Za-z0-9_+-]+$/.test(lang)) {
    return {
      ok: false,
      output: "pdf.read: lang may contain only letters, digits, _, +, or -",
      exitCode: 1,
    };
  }

  const dpiRaw = optionalNumber(args, "dpi") ?? 200;
  const dpi = Math.floor(dpiRaw);
  if (!Number.isFinite(dpiRaw) || dpi < 72 || dpi > 600) {
    return {
      ok: false,
      output: "pdf.read: dpi must be an integer from 72 to 600",
      exitCode: 1,
    };
  }

  const path = resolve(expandHome(rawPath));
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return {
        ok: false,
        output: `pdf.read: not a regular file: ${path}`,
        exitCode: 1,
      };
    }
  } catch (error) {
    return {
      ok: false,
      output: `pdf.read: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: 1,
    };
  }

  // Step 1: fast text extraction for born-digital PDFs
  let textLayerOutput = "";
  if (await commandAvailable("pdftotext")) {
    const direct = await spawnArgv({
      command: "pdftotext",
      argv: ["-layout", path, "-"],
      timeoutMs: 120_000,
      signal: options.signal,
      onOutput: options.onOutput,
      noArtifact: true,
      maxModelBytes: 200_000,
    });
    // spawnArgv prefixes the output with a "$ pdftotext …" command echo; strip
    // that first line so the meaningful-char heuristic sees only PDF content.
    textLayerOutput = direct.output.replace(/^\$ pdftotext[^\n]*\n?/, "");
    if (meaningfulCharCount(textLayerOutput) >= MIN_MEANINGFUL_CHARS) {
      return {
        ok: true,
        output: textLayerOutput.trim(),
      };
    }
  }

  if (options.signal?.aborted) {
    return { ok: false, output: "pdf.read aborted.", exitCode: 130 };
  }

  // Step 2: scanned PDF → render pages then OCR each one
  const missing: string[] = [];
  if (!(await commandAvailable("pdftoppm"))) missing.push("pdftoppm (poppler)");
  if (!(await commandAvailable("tesseract"))) missing.push("tesseract");
  if (missing.length > 0) {
    const hint =
      textLayerOutput.trim().length > 0
        ? `\n\nPartial text-layer extraction:\n${textLayerOutput.trim()}`
        : "";
    return {
      ok: false,
      output:
        `pdf.read: the PDF has no extractable text layer (it is scanned), and OCR fallback needs: ${missing.join(", ")}. ` +
        `Install the missing tool(s) (e.g. poppler for pdftoppm, tesseract for OCR) and retry.${hint}`,
      exitCode: 1,
    };
  }

  const workDir = await mkdtemp(join(tmpdir(), "clai-pdfocr-"));
  try {
    const prefix = join(workDir, "page");
    options.onOutput?.(
      "\n  text layer empty — rendering pages for OCR…\n",
      "stdout",
    );
    const render = await spawnArgv({
      command: "pdftoppm",
      argv: ["-png", "-r", String(dpi), path, prefix],
      timeoutMs: 300_000,
      signal: options.signal,
      onOutput: options.onOutput,
      noArtifact: true,
    });
    if (!render.ok && !options.signal?.aborted) {
      return {
        ok: false,
        output: `pdf.read: failed to render PDF pages with pdftoppm.\n${render.output}`,
        exitCode: render.exitCode ?? 1,
      };
    }

    const entries = (await readdir(workDir))
      .filter((name) => name.toLowerCase().endsWith(".png"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (entries.length === 0) {
      return {
        ok: false,
        output:
          "pdf.read: no pages were rendered from the PDF — it may be empty or corrupt.",
        exitCode: 1,
      };
    }

    const pageTexts: string[] = [];
    for (let i = 0; i < entries.length; i += 1) {
      if (options.signal?.aborted) {
        return { ok: false, output: "pdf.read aborted.", exitCode: 130 };
      }
      const imagePath = join(workDir, entries[i]!);
      options.onOutput?.(
        `  OCR page ${i + 1}/${entries.length}…\n`,
        "stdout",
      );
      const ocr = await spawnArgv({
        command: "tesseract",
        argv: [imagePath, "stdout", "-l", lang, "--psm", "6"],
        timeoutMs: 120_000,
        signal: options.signal,
        noArtifact: true,
        maxModelBytes: 200_000,
      });
      // Strip spawnArgv's "$ tesseract …" command echo from each page.
      const body = ocr.output.replace(/^\$ tesseract[^\n]*\n?/, "").trim();
      pageTexts.push(
        `----- page ${i + 1} -----\n${body || "(no text recognized on this page)"}`,
      );
    }

    const combined = pageTexts.join("\n\n").trim();
    if (meaningfulCharCount(combined) === 0) {
      return {
        ok: false,
        output:
          "pdf.read: OCR ran on all pages but recognized no text. The scan may be too low quality — try a higher dpi.",
        exitCode: 1,
      };
    }
    return {
      ok: true,
      output: `[scanned PDF — text recovered via OCR of ${entries.length} page(s)]\n\n${combined}`,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
