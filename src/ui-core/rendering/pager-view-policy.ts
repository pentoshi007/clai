
import type { FileChange } from "../../tools/file-diff.js";
import { looksLikeMarkdown } from "./pager-source.js";

const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;

export function isMarkdownPath(path: string | undefined | null): boolean {
  if (!path) return false;
  return MARKDOWN_EXT.test(path.split(/[?#]/)[0] ?? path);
}

export function isPureAddFileChange(change: FileChange): boolean {
  if (change.kind === "delete") return false;
  if (change.kind === "create") return true;
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

export function shouldDefaultFormattedView(
  input: PagerDefaultViewInput,
): boolean {
  const kind = input.kind ?? "generic";

  if (kind === "compacted" || kind === "help" || kind === "system") {
    return true;
  }

  if (input.fileChange || kind === "file-change") {
    return false;
  }

  const tool = (input.toolName ?? "").toLowerCase();
  const path = input.path;
  const body = input.body ?? "";

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

  if (
    tool === "fs.edit" ||
    tool === "fs.write" ||
    tool === "fs.append" ||
    tool === "fs.writeMany" ||
    tool === "fs.delete"
  ) {
    return false;
  }

  if (isMarkdownPath(path)) return true;
  return body.length > 0 && looksLikeMarkdown(stripToolChrome(body));
}

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
