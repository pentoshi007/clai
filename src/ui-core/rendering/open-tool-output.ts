/**
 * Open full tool output in the pager modal (scroll + search + Esc/q).
 * Prefers the on-disk artifact, then the unbounded spool. Never re-truncates.
 *
 * Bodies that are pure JSON get pretty-printed so web.search dumps aren't
 * one messy minified blob.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import {
  createArtifactPagerSource,
  createTextPagerSource,
  type ArtifactPagerSource,
} from "./artifact-pager-source.js";
import { asToolCallId } from "../../app/events/app-event.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import type { ToolItem } from "../state/transcript-types.js";
import type { FileChange } from "../../tools/file-diff.js";
import { formatModalPlainText } from "./file-diff-view.js";
import { defaultPagerMarkdownMode } from "./pager-view-policy.js";
import { extractFsReadFileBody, stripPagerLineGutters } from "./pager-source.js";

interface SearchHit {
  readonly title?: string | undefined;
  readonly url?: string | undefined;
  readonly snippet?: string | undefined;
}

/**
 * Prefer a human-readable hit list for web.search-style payloads.
 * Falls back to pretty JSON, then the raw text.
 */
export function formatToolPagerBody(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  // Optional one-line summary above a JSON block:
  //   duckduckgo: 5 results
  //   { "results": [ ... ] }
  let prefix = "";
  let jsonText = trimmed;
  const firstBrace = trimmed.search(/[{\[]/);
  if (firstBrace > 0) {
    prefix = trimmed.slice(0, firstBrace).trimEnd();
    jsonText = trimmed.slice(firstBrace).trim();
  }

  if (jsonText[0] !== "{" && jsonText[0] !== "[") return raw;

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    const hits = extractSearchHits(parsed);
    if (hits && hits.length > 0) {
      const head = prefix || `${hits.length} result${hits.length === 1 ? "" : "s"}`;
      const blocks = hits.map((hit, i) => {
        const title = (hit.title || "(no title)").trim();
        const url = (hit.url || "").trim();
        const snippet = (hit.snippet || "").trim().replace(/\s+/g, " ");
        const lines = [`${i + 1}. ${title}`];
        if (url) lines.push(`   ${url}`);
        if (snippet) lines.push(`   ${snippet}`);
        return lines.join("\n");
      });
      return `${head}\n\n${blocks.join("\n\n")}`;
    }
    // Generic JSON — pretty-print only.
    const pretty = JSON.stringify(parsed, null, 2);
    return prefix ? `${prefix}\n\n${pretty}` : pretty;
  } catch {
    return raw;
  }
}

function extractSearchHits(parsed: unknown): SearchHit[] | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as { results?: unknown };
  if (!Array.isArray(obj.results)) return undefined;
  const hits: SearchHit[] = [];
  for (const entry of obj.results) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.title !== "string" && typeof e.url !== "string") continue;
    hits.push({
      title: typeof e.title === "string" ? e.title : undefined,
      url: typeof e.url === "string" ? e.url : undefined,
      snippet: typeof e.snippet === "string" ? e.snippet : undefined,
    });
  }
  return hits.length > 0 ? hits : undefined;
}

/**
 * Human path/command label for pager titles and headers.
 * Never dump raw tool-arg JSON (history rows often store that).
 *
 * @param maxLen Cap for short titles only. Omit for full body headers so the
 *   pager shows the complete command (card already has it untruncated).
 */
export function cleanArgsLabel(
  name: string,
  argsDisplay: string | undefined,
  options: { maxLen?: number } = {},
): string {
  const maxLen = options.maxLen;
  const clip = (s: string): string => {
    if (maxLen === undefined || maxLen <= 0 || s.length <= maxLen) return s;
    if (maxLen <= 1) return "…";
    return `${s.slice(0, Math.max(0, maxLen - 1))}…`;
  };
  const raw = (argsDisplay ?? "").trim();
  if (!raw) return "";
  if (!raw.startsWith("{")) {
    return clip(raw);
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.path === "string" && parsed.path) return clip(parsed.path);
    if (typeof parsed.command === "string" && parsed.command) {
      return clip(parsed.command);
    }
    if (typeof parsed.url === "string" && parsed.url) return clip(parsed.url);
    if (typeof parsed.pattern === "string" && parsed.pattern) {
      return clip(parsed.pattern);
    }
    if (Array.isArray(parsed.files)) return clip(`${parsed.files.length} file(s)`);
  } catch {
    /* fall through */
  }
  // Truncated JSON (common in history) — pull a path-looking substring.
  const pathHit = raw.match(/"path"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (pathHit?.[1]) {
    try {
      return clip(JSON.parse(`"${pathHit[1]}"`) as string);
    } catch {
      return clip(pathHit[1]);
    }
  }
  void name;
  return clip(raw);
}

/** Absolute path for on-disk open (fs.read / similar) when recoverable. */
export function pathFromArgsDisplay(argsDisplay: string | undefined): string | undefined {
  const label = cleanArgsLabel("fs.read", argsDisplay);
  if (!label || label.includes("\0") || /[\r\n]/.test(label) || label.includes("://")) {
    return undefined;
  }
  if (label.startsWith("~/")) return join(homedir(), label.slice(2));
  if (isAbsolute(label) || /^[A-Za-z]:[\\/]/.test(label)) return label;
  if (/(?:&&|\|\||[;<>`])/.test(label)) return undefined;
  if (!/[\\/]/.test(label) && !/^[^\s]+\.[A-Za-z0-9]{1,12}$/.test(label)) {
    return undefined;
  }
  return resolve(label);
}

/** Short, stable title: `web.search · output` (args live in the body header). */
export function toolPagerTitle(
  name: string,
  argsDisplay: string | undefined,
): string {
  // Border title only — full command/path is in the pager body header.
  const label = cleanArgsLabel(name, argsDisplay, { maxLen: 48 });
  if (!label) return `${name} · output`;
  return `${name} · ${label}`;
}

const INLINE_ARTIFACT_MAX_BYTES = 128 * 1024;
const FULL_SOURCE_FILE_MAX_BYTES = 128 * 1024;
const INLINE_PAGER_MAX_LINES = 2_000;

function exceedsInlinePagerBudget(body: string): boolean {
  if (Buffer.byteLength(body, "utf8") > INLINE_ARTIFACT_MAX_BYTES) return true;
  let lines = 1;
  let index = -1;
  while ((index = body.indexOf("\n", index + 1)) >= 0) {
    lines += 1;
    if (lines > INLINE_PAGER_MAX_LINES) return true;
  }
  return false;
}

async function pageTextBody(
  body: string,
  path?: string,
): Promise<{ body: string; source: ArtifactPagerSource }> {
  const source = createTextPagerSource(body, path);
  try {
    const page = await source.readPage(0);
    return { body: page.body || "(no output)", source };
  } catch (error) {
    source.dispose();
    throw error;
  }
}

export interface OpenToolOutputOptions {
  /**
   * When set, use this body instead of spool/artifact (e.g. one tool.batch
   * sub-section). Title still comes from `item`.
   */
  readonly bodyOverride?: string;
  /** Override the pager title (defaults to toolPagerTitle). */
  readonly titleOverride?: string;
  /** Skip artifact lookup even if item.artifactPath is set. */
  readonly skipArtifact?: boolean;
  /**
   * Open a single file-change snapshot (full file + green/red markers).
   * Prefer this over the raw tool receipt when the tool card has fileChanges.
   */
  readonly fileChange?: FileChange;
}

interface ResolvedFileChangeBody {
  readonly change: FileChange;
  readonly body: string;
  readonly source?: ArtifactPagerSource | undefined;
}

async function resolveFileChangeBody(
  change: FileChange,
): Promise<ResolvedFileChangeBody> {
  let full: FileChange = change;
  if (!change.afterText && change.snapshotPath) {
    try {
      const raw = await readFile(change.snapshotPath, "utf8");
      const parsed = JSON.parse(raw) as FileChange;
      if (parsed && typeof parsed === "object") {
        full = { ...change, ...parsed, afterText: parsed.afterText ?? change.afterText };
      }
    } catch {}
  }
  if (!full.afterText && full.kind !== "delete") {
    try {
      const info = await stat(full.path);
      if (info.isFile() && info.size > FULL_SOURCE_FILE_MAX_BYTES) {
        const source = createArtifactPagerSource(full.path);
        const page = await source.readPage(0);
        return { change: full, body: page.body || "(empty file)", source };
      }
      if (info.isFile()) {
        full = { ...full, afterText: await readFile(full.path, "utf8") };
      }
    } catch {}
  }
  const body = formatModalPlainText(full);
  if (!exceedsInlinePagerBudget(body)) return { change: full, body };
  const paged = await pageTextBody(body, full.path);
  return { change: full, ...paged };
}

export async function openToolOutputPager(
  services: AppServices,
  item: Pick<ToolItem, "toolCallId" | "name" | "argsDisplay" | "artifactPath"> & {
    readonly fileChanges?: ToolItem["fileChanges"];
  },
  options: OpenToolOutputOptions = {},
): Promise<void> {
  try {
    // Prefer structured file-diff modal when available.
    const fileChange =
      options.fileChange ??
      (item.fileChanges && item.fileChanges.length === 1
        ? item.fileChanges[0]
        : undefined);

    if (fileChange && options.bodyOverride === undefined) {
      const resolved = await resolveFileChangeBody(fileChange);
      const fullChange = resolved.change;
      const title =
        options.titleOverride ??
        `${fullChange.kind === "create" ? "Created" : fullChange.kind === "delete" ? "Deleted" : fullChange.kind === "append" ? "Appended" : fullChange.kind === "overwrite" ? "Wrote" : "Edited"} · ${fullChange.basename}`;
      const mdMode = defaultPagerMarkdownMode({
        kind: "file-change",
        fileChange: fullChange,
        path: fullChange.path,
        body: fullChange.afterText,
      });
      const body =
        mdMode === "force" && !resolved.source
          ? stripPagerLineGutters(resolved.body) ||
            fullChange.afterText ||
            resolved.body ||
            "(empty file)"
          : resolved.body || "(empty file)";
      const opened = services.overlay.openPager(
        title,
        body,
        resolved.source,
        mdMode === "force" ? undefined : fullChange.path,
        mdMode,
      );
      if (!opened) {
        services.session.notice(
          "warn",
          "could not open output pager (another overlay is open)",
        );
      }
      return;
    }

    // Multi-file: concatenate all snapshots when opening the parent card.
    if (
      item.fileChanges &&
      item.fileChanges.length > 1 &&
      options.bodyOverride === undefined &&
      !options.fileChange
    ) {
      const parts: string[] = [];
      for (const change of item.fileChanges) {
        const resolved = await resolveFileChangeBody(change);
        if (resolved.source) {
          resolved.source.dispose();
          parts.push(
            `${change.kind} · ${change.path}\n+${change.stats.added} −${change.stats.removed} lines\nOpen this file's diff card for the complete paged content.`,
          );
        } else {
          parts.push(resolved.body);
        }
        parts.push("\n────────\n");
      }
      const title =
        options.titleOverride ??
        toolPagerTitle(item.name, item.argsDisplay);
      const combined = parts.join("\n").trim() || "(no output)";
      const paged = exceedsInlinePagerBudget(combined)
        ? await pageTextBody(combined, item.fileChanges[0]?.path)
        : { body: combined, source: undefined };
      const opened = services.overlay.openPager(
        title,
        paged.body,
        paged.source,
        item.fileChanges[0]?.path,
        "plain",
      );
      if (!opened) {
        services.session.notice(
          "warn",
          "could not open output pager (another overlay is open)",
        );
      }
      return;
    }

    let body: string;
    let artifactSource: ArtifactPagerSource | undefined;
    let highlightPath: string | undefined;
    let openedSourceFile = false;

    if (options.bodyOverride !== undefined) {
      body = options.bodyOverride;
    } else {
      body = services.session.spool.tail(asToolCallId(item.toolCallId));

      // fs.read (and similar) often return a line-range slice to the model.
      // When the user opens the card, prefer the full on-disk file so the pager
      // is not stuck on "[lines 55-66 of 168] … call fs.read with offset=…".
      if (
        (item.name === "fs.read" || item.name === "fs.cat") &&
        options.bodyOverride === undefined
      ) {
        const sourcePath = pathFromArgsDisplay(item.argsDisplay);
        if (sourcePath) {
          try {
            const info = await stat(sourcePath);
            if (info.isFile() && info.size <= FULL_SOURCE_FILE_MAX_BYTES) {
              body = await readFile(sourcePath, "utf8");
              highlightPath = sourcePath;
              openedSourceFile = true;
            } else if (info.isFile()) {
              artifactSource = createArtifactPagerSource(sourcePath);
              const firstPage = await artifactSource.readPage(0);
              body = firstPage.body;
              highlightPath = sourcePath;
              openedSourceFile = true;
            }
          } catch {
            /* keep spool body */
          }
        }
      }

      if (
        !openedSourceFile &&
        item.artifactPath &&
        !options.skipArtifact
      ) {
        try {
          const info = await stat(item.artifactPath);
          if (info.isFile() && info.size >= Buffer.byteLength(body, "utf8")) {
            if (info.size <= INLINE_ARTIFACT_MAX_BYTES) {
              // Full body up front — no artificial first-page truncation.
              body = await readFile(item.artifactPath, "utf8");
            } else {
              artifactSource = createArtifactPagerSource(item.artifactPath);
              const firstPage = await artifactSource.readPage(0);
              body = firstPage.body;
            }
          }
        } catch {
          artifactSource?.dispose();
          artifactSource = undefined;
        }
      }
    }

    body = body
      .replace(/^(ok|failed)\n/gm, "")
      .replace(/^Tool\s+\S+\s+result\s*\([^)]*\)\s*:?\s*\n?/gim, "")
      .replace(/^full output saved to .+\n?/gim, "")
      .replace(/^artifact: .+\n?/gim, "")
      .trimEnd();

    if (!artifactSource) body = formatToolPagerBody(body);

    // Full command/path header in the body (never ellipsize — title is short).
    let header = "";
    if (options.bodyOverride === undefined) {
      const label = cleanArgsLabel(item.name, item.argsDisplay);
      if (label) {
        const kind =
          item.name === "shell.exec"
            ? "command"
            : openedSourceFile
              ? "file"
              : item.name.startsWith("fs.")
                ? "path"
                : "query";
        header = `${kind}: ${label}\n\n`;
      }
    }

    let note = "";
    if (openedSourceFile && highlightPath) {
      note = `\n\n── full file ──\n${highlightPath}`;
    } else if (item.artifactPath && options.bodyOverride === undefined) {
      note =
        `\n\n── full output saved at ──\n${item.artifactPath}` +
        (artifactSource
          ? "\n(paged from disk — PageDown / ^U·^D for more)"
          : "\n(full body)");
    }

    const title =
      options.titleOverride ?? toolPagerTitle(item.name, item.argsDisplay);
    // When paging an artifact, pass body alone as fallback; pager swaps to pages.
    // Include header only for in-memory full bodies so path context stays visible.
    const pagerBody = artifactSource
      ? body || "(no output)"
      : `${header}${body || "(no output)"}${note}`;
    const mdMode = defaultPagerMarkdownMode({
      kind: "tool",
      toolName: item.name,
      path: highlightPath ?? pathFromArgsDisplay(item.argsDisplay),
      body: body,
    });
    // Formatted md reads: pure file markdown (no `N: ` gutters / # fs.read chrome).
    // Prefer on-disk file when available; otherwise strip the spool dump.
    let finalBody =
      mdMode === "force"
        ? openedSourceFile
          ? body || "(no output)"
          : extractFsReadFileBody(body) || body || "(no output)"
        : pagerBody;
    if (!artifactSource && exceedsInlinePagerBudget(finalBody)) {
      const paged = await pageTextBody(
        finalBody,
        highlightPath ?? item.artifactPath,
      );
      finalBody = paged.body;
      artifactSource = paged.source;
    }
    const opened = services.overlay.openPager(
      title,
      finalBody,
      artifactSource,
      mdMode === "force" ? undefined : highlightPath,
      mdMode,
    );
    if (!opened) {
      services.session.notice("warn", "could not open output pager (another overlay is open)");
    }
  } catch (err) {
    services.session.notice(
      "warn",
      `failed to open tool output: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
