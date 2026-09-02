import { Buffer } from "node:buffer";

export type CharsetSource =
  | "content-type"
  | "html-meta"
  | "default"
  | "fallback";

export interface DecodedText {
  text: string;
  charset: string;
  charsetSource: CharsetSource;
  unsupportedCharset?: string;
}

const HTML_CONTENT_TYPE_RE = /^(?:text\/html|application\/xhtml\+xml)\b/i;
const CONTENT_TYPE_CHARSET_RE = /(?:^|;)\s*charset\s*=\s*["']?([^;\s"']+)/i;
const META_CHARSET_RE = /<meta\b[^>]*\bcharset\s*=\s*["']?([^\s"'/>;]+)/i;
const META_HTTP_EQUIV_RE = /<meta\b[^>]*\bcontent\s*=\s*["'][^"']*charset\s*=\s*([^\s;"']+)/i;

export function decodeTextBody(
  body: Buffer | Uint8Array,
  contentType?: string,
): DecodedText {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const declared = charsetFromContentType(contentType);
  const fromMeta =
    declared === undefined && looksLikeHtml(bytes, contentType)
      ? charsetFromHtmlMeta(bytes)
      : undefined;
  const requested = declared ?? fromMeta ?? "utf-8";
  const source: CharsetSource = declared
    ? "content-type"
    : fromMeta
      ? "html-meta"
      : "default";

  try {
    const decoder = new TextDecoder(requested, { fatal: false });
    return {
      text: decoder.decode(bytes),
      charset: decoder.encoding,
      charsetSource: source,
    };
  } catch {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    return {
      text: decoder.decode(bytes),
      charset: decoder.encoding,
      charsetSource: "fallback",
      unsupportedCharset: requested,
    };
  }
}

function charsetFromContentType(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const match = contentType.match(CONTENT_TYPE_CHARSET_RE);
  return match?.[1]?.trim();
}

function looksLikeHtml(body: Buffer, contentType: string | undefined): boolean {
  if (contentType && HTML_CONTENT_TYPE_RE.test(contentType)) return true;
  if (contentType && !/^(?:text\/plain|application\/octet-stream)\b/i.test(contentType)) {
    return false;
  }
  const probe = body.subarray(0, 512).toString("latin1");
  return /<!doctype\s+html|<html\b|<head\b|<meta\b/i.test(probe);
}

function charsetFromHtmlMeta(body: Buffer): string | undefined {
  const probe = body.subarray(0, 8_192).toString("latin1");
  return probe.match(META_CHARSET_RE)?.[1]?.trim()
    ?? probe.match(META_HTTP_EQUIV_RE)?.[1]?.trim();
}
