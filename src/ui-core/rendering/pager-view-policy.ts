/**
 * Decide whether the pager / chat preview should open in formatted markdown
 * (force) or raw (plain) by default. User can still toggle with f / r.
 *
 * Formatted by default:
 *  - compacted context, help / shortcuts / system docs
 *  - markdown **reads** (fs.read of .md)
 *
 * Raw by default (green/red editor view):
 *  - all file mutations (create / append / edit / write / writeMany) —
 *    including pure-green .md appends/creates so the user sees the real
 *    hunks, not a formatted doc preview
 *  - mixed red+green file edits
 *  - shell / http / web / net / scans / other tools
 */

import type { FileChange } from "../../tools/file-diff.js";
import { looksLikeMarkdown } from "./pager-source.js";

const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;

/** True for paths we treat as markdown sources. */
export function isMarkdownPath(path: string | undefined | null): boolean {
  if (!path) return false;
  return MARKDOWN_EXT.test(path.split(/[?#]/)[0] ?? path);
}

/**
 * Pure create / green-only write: no deleted lines (stats.removed === 0).
 * Mixed edits (red + green) stay raw so the user sees the real diff.
 */
export function isPureAddFileChange(change: FileChange): boolean {
  if (change.kind === "delete") return false;
  if (change.kind === "create") return true;
  // overwrite / edit / append with no removals = only green lines
  return change.stats.removed === 0 && change.stats.added >= 0;
}

export type PagerDefaultKind =
  | "compacted"
  | "help"
  | "system"
  | "tool"
  | "file-change"
  | "generic";

export interface PagerDefaultViewInput {
  readonly kind?: PagerDefaultKind | undefined;
  readonly toolName?: string | undefined;
  readonly path?: string | undefined;
  readonly body?: string | undefined;
  readonly fileChange?: FileChange | undefined;
}

/**
 * Whether the pager should start in formatted (`force`) vs raw (`plain`).
 */
export function shouldDefaultFormattedView(
  input: PagerDefaultViewInput,
): boolean {
  const kind = input.kind ?? "generic";

  if (kind === "compacted" || kind === "help" || kind === "system") {
    return true;
  }

  // File mutations always open raw (green/red editor). Press `f` for
  // formatted markdown if desired — never auto-format appends/creates of .md.
  if (input.fileChange || kind === "file-change") {
    return false;
  }

  const tool = (input.toolName ?? "").toLowerCase();
  const path = input.path;
  const body = input.body ?? "";

  // Reads of markdown — formatted.
  if (
    tool === "fs.read" ||
    tool === "fs.cat" ||
    tool === "read" ||
    tool.endsWith(".read")
  ) {
    return (
      isMarkdownPath(path) ||
      (body.length > 0 && looksLikeMarkdown(stripToolChrome(body)))
    );
  }

  // Active / side-effect tools stay raw even if body looks a bit like md.
  if (
    tool.startsWith("shell.") ||
    tool.startsWith("http.") ||
    tool.startsWith("web.") ||
    tool.startsWith("net.") ||
    tool.startsWith("pentest.") ||
    tool.startsWith("dns.") ||
    tool.startsWith("whois.") ||
    tool === "pkg.install" ||
    tool === "tool.batch" ||
    tool === "tool.check"
  ) {
    return false;
  }

  // fs.edit / write with mixed content is handled via fileChange above.
  if (
    tool === "fs.edit" ||
    tool === "fs.write" ||
    tool === "fs.append" ||
    tool === "fs.writeMany" ||
    tool === "fs.delete"
  ) {
    return false;
  }

  // Generic: markdown path or clear markdown body.
  if (isMarkdownPath(path)) return true;
  return body.length > 0 && looksLikeMarkdown(stripToolChrome(body));
}

/** Map decision → openPager markdown arg. */
export function defaultPagerMarkdownMode(
  input: PagerDefaultViewInput,
): "force" | "plain" {
  return shouldDefaultFormattedView(input) ? "force" : "plain";
}

function stripToolChrome(body: string): string {
  return body
    .replace(/^(ok|failed)\n/gm, "")
    .replace(/^Tool\s+\S+\s+result\s*\([^)]*\)\s*:?\s*\n?/gim, "")
    .replace(/^file:\s+.+\n?/gim, "")
    .replace(/^path:\s+.+\n?/gim, "")
    .trim();
}
