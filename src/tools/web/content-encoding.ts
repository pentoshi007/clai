import { Buffer } from "node:buffer";
import {
  brotliDecompressSync,
  constants as zlibConstants,
  inflateSync,
  unzipSync,
} from "node:zlib";

export type ContentEncoding = "gzip" | "deflate" | "br";

const TOLERANT_TRUNCATION = {
  finishFlush: zlibConstants.Z_SYNC_FLUSH,
} as const;

function parseEncodings(header: string | undefined): ContentEncoding[] {
  if (!header) return [];
  const parsed: ContentEncoding[] = [];
  for (const token of header.split(",")) {
    const name = token.trim().toLowerCase();
    if (name === "gzip" || name === "x-gzip") parsed.push("gzip");
    else if (name === "deflate") parsed.push("deflate");
    else if (name === "br") parsed.push("br");
    else if (name === "identity" || name === "") continue;
    else return [];
  }
  return parsed;
}

function decodeOnce(body: Buffer, encoding: ContentEncoding): Buffer {
  if (encoding === "br") {
    return brotliDecompressSync(body, {
      finishFlush: zlibConstants.BROTLI_OPERATION_FLUSH,
    });
  }
  try {
    return unzipSync(body, TOLERANT_TRUNCATION);
  } catch {
    return inflateSync(body, TOLERANT_TRUNCATION);
  }
}

export function decodeContentEncoding(
  body: Buffer,
  contentEncoding: string | undefined,
): { body: Buffer; applied: readonly ContentEncoding[] } {
  const encodings = parseEncodings(contentEncoding);
  if (encodings.length === 0 || body.byteLength === 0) {
    return { body, applied: [] };
  }
  const applied: ContentEncoding[] = [];
  let current = body;
  for (const encoding of [...encodings].reverse()) {
    try {
      current = decodeOnce(current, encoding);
      applied.push(encoding);
    } catch {
      return applied.length > 0
        ? { body: current, applied }
        : { body, applied: [] };
    }
  }
  return { body: current, applied };
}
