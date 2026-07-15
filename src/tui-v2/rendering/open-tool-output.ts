/**
 * Open full tool output in the pager modal (scroll + search + Esc/q).
 * Prefers the on-disk artifact, then the unbounded spool. Never re-truncates.
 *
 * Bodies that are pure JSON get pretty-printed so web.search dumps aren't
 * one messy minified blob.
 */

import { readFile } from "node:fs/promises";
import { asToolCallId } from "../../app/events/app-event.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import type { ToolItem } from "../state/transcript-types.js";

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

/** Short, stable title: `web.search · output` (args live in the body header). */
export function toolPagerTitle(
  name: string,
  argsDisplay: string | undefined,
): string {
  if (!argsDisplay) return `${name} · output`;
  // Keep the query readable but don't let it double as a second title line.
  const short =
    argsDisplay.length > 48 ? `${argsDisplay.slice(0, 45)}…` : argsDisplay;
  return `${name} · ${short}`;
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
}

export async function openToolOutputPager(
  services: AppServices,
  item: Pick<ToolItem, "toolCallId" | "name" | "argsDisplay" | "artifactPath">,
  options: OpenToolOutputOptions = {},
): Promise<void> {
  try {
    let body: string;
    let fromArtifact = false;

    if (options.bodyOverride !== undefined) {
      body = options.bodyOverride;
    } else {
      const spoolTail = services.session.spool.tail(asToolCallId(item.toolCallId));
      body = spoolTail;

      if (item.artifactPath && !options.skipArtifact) {
        try {
          const full = await readFile(item.artifactPath, "utf8");
          if (full.length >= body.length) {
            body = full;
            fromArtifact = true;
          }
        } catch {
          // Fall back to spool.
        }
      }
    }

    body = body
      .replace(/^(ok|failed)\n/gm, "")
      .replace(/^full output saved to .+\n?/gim, "")
      .replace(/^artifact: .+\n?/gim, "")
      .trimEnd();

    body = formatToolPagerBody(body);

    // Optional one-line query header so the border title can stay short.
    let header = "";
    if (
      options.bodyOverride === undefined &&
      item.argsDisplay &&
      item.argsDisplay.length > 0
    ) {
      const label = item.name === "shell.exec" ? "command" : "query";
      header = `${label}: ${item.argsDisplay}\n\n`;
    }

    let note = "";
    if (item.artifactPath && options.bodyOverride === undefined) {
      note =
        `\n\n── full output saved at ──\n${item.artifactPath}` +
        (fromArtifact ? "" : "\n(spool body; artifact unreadable)");
    }

    const title =
      options.titleOverride ?? toolPagerTitle(item.name, item.argsDisplay);
    const opened = services.overlay.openPager(
      title,
      `${header}${body || "(no output)"}${note}`,
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
