import { commandAvailable } from "../../os/pkgmgr.js";
import type { ToolResult } from "../../types.js";
import { LANG_PATTERN, meaningfulCharCount, runOcr, stripCommandEcho, tesseractUnavailableReason } from "../ocr.js";
import { spawnArgv } from "../shell.js";
import { mkdir, mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface PdfToolRunOptions {
  signal?: AbortSignal | undefined;
  onOutput?: ((chunk: string, stream: "stdout" | "stderr") => void) | undefined;
}

const MIN_PAGE_MEANINGFUL_CHARS = 12;

const DEFAULT_DPI = 300;

const DEFAULT_PSM = 3;

const DEFAULT_MAX_CHARS = 200_000;

const MAX_MAX_CHARS = 1_000_000;

const TEXT_LAYER_TIMEOUT_MS = 120_000;

const RENDER_TIMEOUT_MS = 300_000;

const PAGE_OCR_TIMEOUT_MS = 120_000;

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

function integerArg(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): { value?: number | undefined; error?: string } {
  const raw = optionalNumber(args, key);
  if (raw === undefined) return {};
  const value = Math.floor(raw);
  if (!Number.isFinite(raw) || value < min || value > max) {
    return { error: `pdf.read: ${key} must be an integer from ${min} to ${max}` };
  }
  return { value };
}

interface PdfMetadata {
  readonly pageCount?: number | undefined;
  readonly encrypted: boolean;
  readonly title?: string | undefined;
}

async function readPdfMetadata(
  path: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<PdfMetadata> {
  if (!(await commandAvailable("pdfinfo"))) return { encrypted: false };
  const result = await spawnArgv({
    command: "pdfinfo",
    argv: [path],
    timeoutMs,
    signal,
    noArtifact: true,
    maxModelBytes: 16_000,
  });
  const body = stripCommandEcho(result.output);
  const pages = /^Pages:\s+(\d+)/m.exec(body)?.[1];
  const encrypted = /^Encrypted:\s+yes/im.test(body);
  const title = /^Title:\s+(.+)$/m.exec(body)?.[1]?.trim();
  return {
    ...(pages ? { pageCount: Number(pages) } : {}),
    encrypted,
    ...(title ? { title } : {}),
  };
}

function encryptionError(path: string): ToolResult {
  return {
    ok: false,
    output:
      `pdf.read: ${path} is password-protected, so its text cannot be extracted. ` +
      "Decrypt it first (qpdf --decrypt --password=<pw> in.pdf out.pdf) and read the decrypted copy.",
    exitCode: 1,
  };
}

async function looksLikePdf(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return header.subarray(0, bytesRead).includes("%PDF-");
  } finally {
    await handle.close();
  }
}

interface TextLayer {
  readonly pages: string[];
  readonly extractor: string | undefined;
  readonly failure?: string | undefined;
  readonly encrypted?: boolean | undefined;
}

async function extractTextLayer(
  path: string,
  first: number,
  last: number | undefined,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<TextLayer> {
  if (await commandAvailable("pdftotext")) {
    const argv = ["-layout", "-enc", "UTF-8", "-f", String(first)];
    if (last !== undefined) argv.push("-l", String(last));
    argv.push(path, "-");
    const result = await spawnArgv({
      command: "pdftotext",
      argv,
      timeoutMs,
      signal,
      noArtifact: true,
      maxModelBytes: 2_000_000,
    });
    const body = stripCommandEcho(result.output);
    if (/incorrect password|encrypted/i.test(body)) {
      return { pages: [], extractor: "pdftotext", encrypted: true };
    }
    if (!result.ok && meaningfulCharCount(body) === 0) {
      return {
        pages: [],
        extractor: "pdftotext",
        failure: body.trim() || `pdftotext exited with code ${result.exitCode ?? 1}`,
      };
    }
    return { pages: splitPages(body), extractor: "pdftotext" };
  }

  if (await commandAvailable("mutool")) {
    const argv = ["draw", "-F", "txt", "-o", "-", path];
    if (last !== undefined) argv.push(`${first}-${last}`);
    else argv.push(`${first}-`);
    const result = await spawnArgv({
      command: "mutool",
      argv,
      timeoutMs,
      signal,
      noArtifact: true,
      maxModelBytes: 2_000_000,
    });
    const body = stripCommandEcho(result.output);
    if (/password/i.test(body)) {
      return { pages: [], extractor: "mutool", encrypted: true };
    }
    if (!result.ok && meaningfulCharCount(body) === 0) {
      return {
        pages: [],
        extractor: "mutool",
        failure: body.trim() || `mutool exited with code ${result.exitCode ?? 1}`,
      };
    }
    return { pages: splitPages(body), extractor: "mutool" };
  }

  return { pages: [], extractor: undefined };
}

function splitPages(body: string): string[] {
  const pages = body.split("\f");
  if (pages.length > 1 && pages[pages.length - 1] === "") pages.pop();
  return pages.map((page) => page.replace(/[ \t]+$/gm, "").trim());
}

function groupConsecutive(pages: readonly number[]): Array<[number, number]> {
  const groups: Array<[number, number]> = [];
  for (const page of pages) {
    const current = groups[groups.length - 1];
    if (current && page === current[1] + 1) {
      current[1] = page;
      continue;
    }
    groups.push([page, page]);
  }
  return groups;
}

interface RenderedPage {
  readonly pageNumber: number;
  readonly imagePath: string;
}

async function renderPageRange(
  path: string,
  from: number,
  to: number,
  dpi: number,
  outputDir: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<RenderedPage[]> {
  await mkdir(outputDir, { recursive: true });
  if (await commandAvailable("pdftoppm")) {
    const result = await spawnArgv({
      command: "pdftoppm",
      argv: [
        "-png",
        "-gray",
        "-r",
        String(dpi),
        "-f",
        String(from),
        "-l",
        String(to),
        path,
        join(outputDir, "page"),
      ],
      timeoutMs,
      signal,
      noArtifact: true,
      maxModelBytes: 8_000,
    });
    const rendered = await listRenderedPages(outputDir, from, to, true);
    if (rendered.length > 0) return rendered;
    if (!result.ok) return [];
  }
  if (await commandAvailable("mutool")) {
    await spawnArgv({
      command: "mutool",
      argv: [
        "draw",
        "-F",
        "png",
        "-r",
        String(dpi),
        "-o",
        join(outputDir, "page-%d.png"),
        path,
        `${from}-${to}`,
      ],
      timeoutMs,
      signal,
      noArtifact: true,
      maxModelBytes: 8_000,
    });
    return listRenderedPages(outputDir, from, to, false);
  }
  return [];
}

async function listRenderedPages(
  directory: string,
  from: number,
  to: number,
  namesArePageNumbers: boolean,
): Promise<RenderedPage[]> {
  let names: string[];
  try {
    names = (await readdir(directory))
      .filter((name) => name.toLowerCase().endsWith(".png"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return [];
  }
  return names.flatMap((name, index): RenderedPage[] => {
    const parsed = namesArePageNumbers
      ? Number(/(\d+)\.png$/i.exec(name)?.[1])
      : Number.NaN;
    const pageNumber =
      Number.isFinite(parsed) && parsed >= from && parsed <= to
        ? parsed
        : from + index;
    if (pageNumber > to) return [];
    return [{ pageNumber, imagePath: join(directory, name) }];
  });
}

async function missingOcrTooling(): Promise<string[]> {
  const missing: string[] = [];
  const hasRenderer =
    (await commandAvailable("pdftoppm")) || (await commandAvailable("mutool"));
  if (!hasRenderer) missing.push("pdftoppm (poppler) or mutool (mupdf)");
  const tesseract = await tesseractUnavailableReason();
  if (tesseract) missing.push("tesseract");
  return missing;
}

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
  if (!LANG_PATTERN.test(lang)) {
    return {
      ok: false,
      output: "pdf.read: lang may contain only letters, digits, _, +, or -",
      exitCode: 1,
    };
  }

  const dpiArg = integerArg(args, "dpi", 72, 600);
  if (dpiArg.error) return { ok: false, output: dpiArg.error, exitCode: 1 };
  const dpi = dpiArg.value ?? DEFAULT_DPI;

  const psmArg = integerArg(args, "psm", 0, 13);
  if (psmArg.error) return { ok: false, output: psmArg.error, exitCode: 1 };
  const psm = psmArg.value ?? DEFAULT_PSM;

  const maxPagesArg = integerArg(args, "maxPages", 1, 500);
  if (maxPagesArg.error) {
    return { ok: false, output: maxPagesArg.error, exitCode: 1 };
  }

  const firstPageArg = integerArg(args, "firstPage", 1, 100_000);
  if (firstPageArg.error) {
    return { ok: false, output: firstPageArg.error, exitCode: 1 };
  }

  const lastPageArg = integerArg(args, "lastPage", 1, 100_000);
  if (lastPageArg.error) {
    return { ok: false, output: lastPageArg.error, exitCode: 1 };
  }

  const maxCharsArg = integerArg(args, "maxChars", 1_000, MAX_MAX_CHARS);
  if (maxCharsArg.error) {
    return { ok: false, output: maxCharsArg.error, exitCode: 1 };
  }
  const maxChars = maxCharsArg.value ?? DEFAULT_MAX_CHARS;

  const ocrMode = optionalString(args, "ocr") ?? "auto";
  if (!["auto", "never", "always"].includes(ocrMode)) {
    return {
      ok: false,
      output: 'pdf.read: ocr must be "auto", "never" or "always"',
      exitCode: 1,
    };
  }

  const firstPage = firstPageArg.value ?? 1;
  if (lastPageArg.value !== undefined && lastPageArg.value < firstPage) {
    return {
      ok: false,
      output: "pdf.read: lastPage must be greater than or equal to firstPage",
      exitCode: 1,
    };
  }

  const totalTimeoutMs = optionalNumber(args, "timeoutMs");
  const deadline =
    totalTimeoutMs !== undefined ? Date.now() + totalTimeoutMs : undefined;
  const remainingMs = (fallback: number): number => {
    if (deadline === undefined) return fallback;
    return Math.max(1_000, Math.min(fallback, deadline - Date.now()));
  };
  const outOfTime = (): boolean =>
    deadline !== undefined && Date.now() >= deadline;

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
    if (info.size === 0) {
      return { ok: false, output: `pdf.read: ${path} is empty`, exitCode: 1 };
    }
    if (!(await looksLikePdf(path))) {
      return {
        ok: false,
        output: `pdf.read: ${path} does not start with a %PDF- header, so it is not a PDF. For images use image.ocr; for office documents convert them first (e.g. libreoffice --convert-to pdf).`,
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

  const metadata = await readPdfMetadata(path, remainingMs(15_000), options.signal);
  if (metadata.encrypted) return encryptionError(path);

  let rangeEnd = lastPageArg.value ?? metadata.pageCount;
  if (maxPagesArg.value !== undefined) {
    const capped = firstPage + maxPagesArg.value - 1;
    rangeEnd = rangeEnd === undefined ? capped : Math.min(rangeEnd, capped);
  }
  if (
    metadata.pageCount !== undefined &&
    firstPage > metadata.pageCount
  ) {
    return {
      ok: false,
      output: `pdf.read: firstPage ${firstPage} is beyond the document, which has ${metadata.pageCount} page(s).`,
      exitCode: 1,
    };
  }

  const textLayer = await extractTextLayer(
    path,
    firstPage,
    rangeEnd,
    remainingMs(TEXT_LAYER_TIMEOUT_MS),
    options.signal,
  );
  if (textLayer.encrypted) return encryptionError(path);
  if (options.signal?.aborted) {
    return { ok: false, output: "pdf.read aborted.", exitCode: 130 };
  }

  let pages = textLayer.pages;
  if (rangeEnd !== undefined) {
    pages = pages.slice(0, Math.max(0, rangeEnd - firstPage + 1));
  }

  const knownPageCount = metadata.pageCount;
  if (pages.length === 0 && rangeEnd === undefined && knownPageCount === undefined) {
    if (textLayer.extractor === undefined) {
      const missing = await missingOcrTooling();
      return {
        ok: false,
        output:
          "pdf.read: no PDF text extractor is installed. Install poppler (pdftotext/pdftoppm) or mupdf (mutool) — e.g. `brew install poppler`, `apt install poppler-utils`" +
          (missing.length > 0
            ? `. OCR of scanned pages additionally needs: ${missing.join(", ")}.`
            : "."),
        exitCode: 1,
      };
    }
    return {
      ok: false,
      output: `pdf.read: could not determine the page count of ${path}${textLayer.failure ? ` (${textLayer.failure})` : ""}. Install poppler so pdfinfo can report it, or pass maxPages.`,
      exitCode: 1,
    };
  }

  const authoritativeEnd = rangeEnd ?? knownPageCount;
  const textLayerEnd =
    pages.length > 0 ? firstPage + pages.length - 1 : undefined;
  const resolvedEnd =
    authoritativeEnd !== undefined
      ? textLayerEnd !== undefined
        ? Math.max(authoritativeEnd, textLayerEnd)
        : authoritativeEnd
      : textLayerEnd;
  const pageCountForRange =
    resolvedEnd !== undefined ? resolvedEnd - firstPage + 1 : 0;
  if (pageCountForRange <= 0) {
    return {
      ok: false,
      output: `pdf.read: the requested page range is empty for ${path}.`,
      exitCode: 1,
    };
  }
  const boundedPageCount = Math.min(pageCountForRange, 500);
  const pageNumbers = Array.from(
    { length: boundedPageCount },
    (_, index) => firstPage + index,
  );
  const pageText = new Map<number, string>();
  for (const [index, number] of pageNumbers.entries()) {
    pageText.set(number, pages[index] ?? "");
  }

  const needsOcr =
    ocrMode === "never"
      ? []
      : pageNumbers.filter(
          (number) =>
            ocrMode === "always" ||
            meaningfulCharCount(pageText.get(number) ?? "") <
              MIN_PAGE_MEANINGFUL_CHARS,
        );

  const ocredPages: number[] = [];
  const lowConfidencePages: number[] = [];
  let ocrNotice: string | undefined;
  let timedOut = false;

  if (needsOcr.length > 0) {
    const missing = await missingOcrTooling();
    if (missing.length > 0) {
      ocrNotice =
        `${needsOcr.length} page(s) have no text layer and could not be OCR-ed because these tools are missing: ${missing.join(", ")}. ` +
        "Install them (e.g. `brew install poppler tesseract` or `apt install poppler-utils tesseract-ocr`) and retry.";
    } else {
      const workDir = await mkdtemp(join(tmpdir(), "clai-pdfocr-"));
      try {
        options.onOutput?.(
          `\n  ${needsOcr.length} page(s) without a text layer — rendering at ${dpi} dpi for OCR…\n`,
          "stdout",
        );
        for (const [from, to] of groupConsecutive(needsOcr)) {
          if (options.signal?.aborted) {
            return { ok: false, output: "pdf.read aborted.", exitCode: 130 };
          }
          if (outOfTime()) {
            timedOut = true;
            break;
          }
          const groupDir = join(workDir, `range-${from}-${to}`);
          const rendered = await renderPageRange(
            path,
            from,
            to,
            dpi,
            groupDir,
            remainingMs(RENDER_TIMEOUT_MS),
            options.signal,
          );
          if (rendered.length === 0) {
            ocrNotice =
              ocrNotice ??
              `pages ${from}-${to} could not be rendered for OCR — the PDF may be damaged or use an unsupported filter.`;
            continue;
          }
          for (const { pageNumber, imagePath } of rendered) {
            if (options.signal?.aborted) {
              return { ok: false, output: "pdf.read aborted.", exitCode: 130 };
            }
            if (outOfTime()) {
              timedOut = true;
              break;
            }
            options.onOutput?.(`  OCR page ${pageNumber}…\n`, "stdout");
            const ocr = await runOcr({
              path: imagePath,
              lang,
              psmCandidates: psmArg.value !== undefined ? [psm] : [psm, 6, 11],
              timeoutMs: remainingMs(PAGE_OCR_TIMEOUT_MS),
              dpi,
              preprocess: false,
              signal: options.signal,
            });
            if (!ocr.ok) {
              ocrNotice = ocrNotice ?? `OCR failed on page ${pageNumber}: ${ocr.error ?? "unknown error"}`;
              continue;
            }
            if (meaningfulCharCount(ocr.text) === 0) continue;
            if (!ocr.reliable) {
              lowConfidencePages.push(pageNumber);
              continue;
            }
            pageText.set(pageNumber, ocr.text);
            ocredPages.push(pageNumber);
          }
          if (timedOut) break;
        }
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
  }

  const sections: string[] = [];
  let extractedChars = 0;
  for (const number of pageNumbers) {
    const body = pageText.get(number)?.trim() ?? "";
    extractedChars += meaningfulCharCount(body);
    sections.push(
      `----- page ${number} -----\n${body || "(no text on this page)"}`,
    );
  }
  let combined = sections.join("\n\n").trim();

  if (extractedChars === 0) {
    const reason =
      ocrNotice ??
      (ocrMode === "never"
        ? "the PDF has no text layer and ocr was set to \"never\""
        : "OCR ran but recognized no text — the scan may be too low quality, so retry with a higher dpi (e.g. 400) or a different psm");
    return {
      ok: false,
      output: `pdf.read: no text could be extracted from ${path}. ${reason}`,
      exitCode: 1,
    };
  }

  let truncated = false;
  if (combined.length > maxChars) {
    combined = combined.slice(0, maxChars);
    truncated = true;
  }

  const rangeLabel =
    pageNumbers.length === 1
      ? `page ${pageNumbers[0]}`
      : `pages ${pageNumbers[0]}-${pageNumbers[pageNumbers.length - 1]}`;
  const headerParts = [
    `${rangeLabel}${knownPageCount ? ` of ${knownPageCount}` : ""}`,
  ];
  if (ocredPages.length > 0) {
    const shown = ocredPages.slice(0, 12).join(", ");
    headerParts.push(
      `OCR used on ${ocredPages.length} page(s)${ocredPages.length <= 12 ? ` (${shown})` : ""} at ${dpi} dpi`,
    );
  } else if (needsOcr.length === 0) {
    headerParts.push("embedded text layer");
  }
  if (lowConfidencePages.length > 0) {
    headerParts.push(
      `${lowConfidencePages.length} page(s) produced only OCR noise and were left blank rather than guessed (${lowConfidencePages.slice(0, 12).join(", ")}) — retry with a higher dpi if those pages matter`,
    );
  }
  if (metadata.title) headerParts.push(`title: ${metadata.title}`);
  if (timedOut) {
    headerParts.push(
      "stopped early: timeoutMs budget exhausted — raise timeoutMs or lower maxPages",
    );
  }
  if (truncated) {
    headerParts.push(
      `truncated at maxChars=${maxChars} — read a narrower firstPage/lastPage range for the rest`,
    );
  }
  if (ocrNotice) headerParts.push(ocrNotice);

  return {
    ok: true,
    output: `[pdf.read ${path} — ${headerParts.join(" · ")}]\n\n${combined}`,
  };
}
