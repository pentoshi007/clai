import net from "node:net";

/** Flatten error + nested cause(s) for TLS code matching. */
function errorText(error: unknown, depth = 0): string {
  if (depth > 4 || error == null) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const cause = error.cause !== undefined ? errorText(error.cause, depth + 1) : "";
    const code =
      "code" in error && typeof (error as { code?: unknown }).code === "string"
        ? String((error as { code: string }).code)
        : "";
    return `${error.message} ${code} ${cause}`;
  }
  if (typeof error === "object") {
    const rec = error as Record<string, unknown>;
    const code = typeof rec.code === "string" ? rec.code : "";
    const message = typeof rec.message === "string" ? rec.message : "";
    const cause = rec.cause !== undefined ? errorText(rec.cause, depth + 1) : "";
    try {
      return `${message} ${code} ${cause} ${JSON.stringify(error)}`;
    } catch {
      return `${message} ${code} ${cause}`;
    }
  }
  return String(error);
}

/** True when the error is a TLS hostname/cert mismatch (common for https://IP). */
export function isTlsCertNameError(error: unknown): boolean {
  const text = errorText(error);
  return (
    /ERR_TLS_CERT_ALTNAME_INVALID/i.test(text) ||
    /Hostname\/IP does not match certificate/i.test(text) ||
    /certificate.*altname/i.test(text) ||
    /UNABLE_TO_VERIFY_LEAF_SIGNATURE/i.test(text) ||
    /DEPTH_ZERO_SELF_SIGNED_CERT/i.test(text) ||
    /SELF_SIGNED_CERT/i.test(text) ||
    /unable to verify the first certificate/i.test(text)
  );
}

export function formatTlsNetworkError(error: unknown, url: string): string {
  const base = error instanceof Error ? error.message : String(error);
  if (!isTlsCertNameError(error)) return base;
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* keep raw */
  }
  const byIp = net.isIP(host.replace(/^\[|\]$/g, "")) !== 0;
  return (
    `${base}\n\n` +
    `TLS certificate did not validate for this URL` +
    (byIp
      ? ` (you connected by IP ${host}; the cert is almost always issued for a hostname, not the IP).`
      : `.`) +
    `\nAuthorized testing options:\n` +
    `  1. Retry with the hostname that matches the cert (from SAN/CN), or\n` +
    `  2. http.fetch with insecureTls=true (or tlsInsecure=true) to skip verification and still capture evidence, or\n` +
    `  3. shell: curl -k -i ${url}\n` +
    `Evidence taken with insecureTls is still valid for recon; record that TLS verification was disabled.`
  );
}

/** Capture budget for decoded response-body bytes (artifact + evidence build). */
const DEFAULT_MAX_BYTES = 128 * 1024;

/** Hard memory ceiling for one response capture; raise maxBytes up to this cap. */
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

/**
 * Default retries for remote evidence: 0 so intentional 5xx/probe responses are
 * not silently rewritten. Callers may pass retries; owned loopback still soft-
 * retries connection refused.
 */
export const DEFAULT_RETRIES = 0;

export const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const DEFAULT_TIMEOUT_MS = 40_000;

const MIN_TIMEOUT_MS = 1_000;

const MAX_TIMEOUT_MS = 1_800_000;

export function isConnectionRefusedError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    /\bECONNREFUSED\b/i.test(msg) ||
    /\bconnect\s+ECONNREFUSED\b/i.test(msg) ||
    /\bfetch failed\b/i.test(msg) ||
    /\bother side closed\b/i.test(msg) ||
    /\bsocket hang up\b/i.test(msg)
  );
}

export function clampTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.floor(value)));
}

export function clampCaptureBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_BYTES;
  return Math.max(0, Math.min(MAX_CAPTURE_BYTES, Math.floor(value)));
}

export function clampRetries(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RETRIES;
  return Math.max(0, Math.min(5, Math.floor(value)));
}

export function retryDelayMs(attempt: number): number {
  return Math.min(250 * 2 ** Math.max(0, attempt - 1), 1000);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function drainResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort only; redirect/retry can proceed after a socket-close race.
  }
}

export function isBinaryContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase().trim();
  if (ct.includes("image/svg+xml")) return false; // SVGs are xml text
  if (
    ct.startsWith("image/") ||
    ct.startsWith("video/") ||
    ct.startsWith("audio/") ||
    ct.startsWith("application/octet-stream") ||
    ct.startsWith("application/zip") ||
    ct.startsWith("application/pdf") ||
    ct.startsWith("application/x-")
  ) {
    return true;
  }
  return false;
}

export function isTextualContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return (
    ct.startsWith("text/") ||
    ct === "image/svg+xml" ||
    ct === "application/json" ||
    ct.endsWith("+json") ||
    ct === "application/xml" ||
    ct.endsWith("+xml") ||
    ct === "application/javascript" ||
    ct === "application/x-javascript" ||
    ct === "application/x-www-form-urlencoded"
  );
}

export function isBinaryContent(body: Buffer): boolean {
  const sample = body.subarray(0, 2_048);
  let nonPrintableCount = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    // Control bytes other than tab (9), lf (10), cr (13).
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      nonPrintableCount += 1;
      if (nonPrintableCount > 5) return true;
    }
  }
  return false;
}
