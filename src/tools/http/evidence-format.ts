import type { ResponsePart } from "../output-selection.js";
import { toReadableText } from "../web/readable.js";

export interface RedirectHop {
  status: number;
  statusText: string;
  method: string;
  url: string;
  location: string;
  headers: Array<readonly [string, string]>;
}

function multiHeader(headers: Headers, name: string): string[] {
  const out: string[] = [];
  headers.forEach((value, key) => {
    if (key.toLowerCase() === name.toLowerCase()) out.push(value);
  });
  return out;
}

export function snapshotHeaders(headers: Headers): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") out.push([key, value]);
  });
  const setCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : multiHeader(headers, "set-cookie");
  for (const value of setCookies) out.push(["set-cookie", value]);
  return out;
}

const PRIORITY_HEADER_RE =
  /^(set-cookie|server|x-powered-by|x-aspnet|x-generator|x-frame-options|x-content-type-options|x-xss-protection|content-security-policy|content-type|location|www-authenticate|access-control-|strict-transport|referrer-policy|permissions-policy|cross-origin-|cache-control|via|cf-ray|x-request-id|x-amz-|x-served|link|allow|retry-after)$/i;

export function formatHttpEvidence(input: {
  requestedMethod: string;
  finalMethod: string;
  requestedUrl: string;
  usedUrl: string;
  finalUrl: string;
  status: number;
  statusText: string;
  attempts: number;
  bytesRead: number;
  bodySha256: string;
  bodyCharset: string;
  charsetSource: string;
  unsupportedCharset?: string | undefined;
  truncated: boolean;
  limit: number;
  contentType: string;
  headers: Headers;
  body: string;
  isBinary: boolean;
  redirectHops: RedirectHop[];
  lastNetworkError: unknown;
  insecureTls?: boolean | undefined;
  forwardSensitiveHeaders: boolean;
  responseMode: "readable" | "raw";
  responsePart: ResponsePart;
}): string {
  const lines: string[] = [];
  lines.push(
    `${input.status} ${input.statusText} ${input.finalMethod} ${input.finalUrl}`,
  );
  if (input.insecureTls) {
    lines.push(
      "TLS: verification DISABLED (insecureTls=true) — hostname/cert not validated; authorized-test only.",
    );
  }

  if (input.redirectHops.length > 0) {
    const chain = [
      ...input.redirectHops.map(
        (h) => `${h.status} ${h.method} ${h.url} → ${h.location}`,
      ),
      `${input.status} ${input.finalMethod} ${input.finalUrl}`,
    ];
    lines.push(`redirects: ${chain.join(" → ")}`);
    const crossedOrigin = input.redirectHops.some((hop) => {
      try {
        return new URL(hop.url).origin !== new URL(hop.location, hop.url).origin;
      } catch {
        return false;
      }
    });
    if (crossedOrigin) {
      lines.push(
        input.forwardSensitiveHeaders
          ? "redirect credentials: explicitly forwarded across origin change"
          : "redirect credentials: Authorization, Proxy-Authorization, and Cookie stripped across origin change",
      );
    }
    lines.push("");
    lines.push("Redirect responses (headers runtime-normalized):");
    for (const hop of input.redirectHops) {
      lines.push(
        `  ${hop.status} ${hop.statusText} ${hop.method} ${hop.url}`,
        `  location: ${hop.location}`,
      );
      for (const [key, value] of hop.headers) {
        lines.push(`  ${key}: ${value}`);
      }
      lines.push("");
    }
  }

  const metaBits = [`attempts=${input.attempts}`];
  if (input.responsePart === "headers") {
    metaBits.push("bodyCapture=skipped(responsePart=headers)");
  } else {
    metaBits.push(
      `bodyBytes=${input.bytesRead}`,
      `bodySha256=${input.bodySha256}`,
      `charset=${input.bodyCharset}(${input.charsetSource})`,
    );
    if (input.unsupportedCharset) {
      metaBits.push(`unsupportedCharset=${input.unsupportedCharset}`);
    }
    if (input.truncated) metaBits.push(`truncated@${input.limit}`);
  }
  if (input.usedUrl !== input.requestedUrl) metaBits.push(`via=${input.usedUrl}`);
  if (
    input.requestedMethod !== input.finalMethod ||
    (input.requestedUrl !== input.finalUrl && input.redirectHops.length === 0)
  ) {
    metaBits.push(`requested=${input.requestedMethod} ${input.requestedUrl}`);
  }
  lines.push(metaBits.join(" "));
  if (input.responsePart !== "headers") {
    lines.push(
      "capture: response-body bytes after Fetch transfer/content decoding; SHA-256 covers exactly the captured bytes",
    );
  }

  if (input.finalUrl.startsWith("https:") && !input.insecureTls) {
    lines.push(
      "TLS: leaf cert not captured by http.fetch — use web.fetch with includeTls=true for fingerprint/SAN.",
    );
  }

  const allHeaders = snapshotHeaders(input.headers);
  const priority: string[] = [];
  const rest: string[] = [];
  for (const [key, value] of allHeaders) {
    const line = `${key}: ${value}`;
    if (PRIORITY_HEADER_RE.test(key)) priority.push(line);
    else rest.push(line);
  }
  lines.push("");
  lines.push("Final response headers (runtime-normalized; Set-Cookie preserved separately):");
  for (const line of priority) lines.push(line);
  for (const line of rest) lines.push(line);

  const tech = deriveTechHints(input.headers, input.body, input.contentType);
  if (tech) {
    lines.push("");
    lines.push(`Tech hints: ${tech}`);
  }

  if (input.finalMethod !== "HEAD") {
    lines.push("");
    lines.push("Body:");
    if (input.isBinary) {
      lines.push(
        `[Binary content (${input.contentType || "unknown content type"}) — textual rendering suppressed; use bodySha256 and headers as evidence]`,
      );
    } else {
      const isHtml = input.contentType.toLowerCase().includes("html");
      const bodyText =
        isHtml && input.responseMode === "readable"
          ? toReadableText(input.body, input.finalUrl) || input.body
          : input.body;
      if (input.truncated) {
        lines.push(
          `${bodyText || "(empty)"}\n... (capture stopped at ${input.limit.toLocaleString()} decoded response-body bytes — raise maxBytes for more body)`,
        );
      } else {
        lines.push(bodyText || "(empty)");
      }
    }
  }

  if (input.lastNetworkError) {
    const err =
      input.lastNetworkError instanceof Error
        ? input.lastNetworkError.message
        : String(input.lastNetworkError);
    if (err) {
      lines.push("");
      lines.push(`note: earlier network error during retries: ${err}`);
    }
  }

  const bodyMarker = lines.indexOf("Body:");
  if (input.responsePart === "body") {
    return bodyMarker >= 0 ? lines.slice(bodyMarker + 1).join("\n") : "";
  }
  if (input.responsePart === "headers" && bodyMarker >= 0) {
    return lines.slice(0, Math.max(0, bodyMarker - 1)).join("\n");
  }
  return lines.join("\n");
}

function deriveTechHints(
  headers: Headers,
  body: string,
  contentType: string,
): string {
  const bits: string[] = [];
  const server = headers.get("server");
  if (server) bits.push(`server=${server}`);
  const powered = headers.get("x-powered-by");
  if (powered) bits.push(`x-powered-by=${powered}`);
  const gen = headers.get("x-generator");
  if (gen) bits.push(`x-generator=${gen}`);
  const cookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : multiHeader(headers, "set-cookie");
  if (cookies.length) {
    const names = cookies
      .map((c) => c.split("=")[0]?.trim())
      .filter(Boolean)
      .slice(0, 8);
    if (names.length) bits.push(`cookies=${names.join(",")}`);
  }
  if (contentType) bits.push(`content-type=${contentType.split(";")[0]?.trim()}`);
  const sample = body.slice(0, 8_000);
  if (/\/_next\//i.test(sample) || /__NEXT_DATA__/i.test(sample)) {
    bits.push("marker=next.js");
  } else if (/wp-content|wordpress/i.test(sample)) {
    bits.push("marker=wordpress");
  } else if (/csrfmiddlewaretoken|django/i.test(sample)) {
    bits.push("marker=django");
  } else if (/react/i.test(sample) && /data-reactroot|__REACT/i.test(sample)) {
    bits.push("marker=react");
  }
  return bits.join("; ");
}
