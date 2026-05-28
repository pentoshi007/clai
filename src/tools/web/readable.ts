/**
 * HTML-to-readable-text conversion and a permissive `Set-Cookie` parser.
 *
 * Two helpers live here so both `web.fetch` (via `capture.ts`) and the
 * DuckDuckGo provider's lite-HTML adapter share one implementation:
 *
 * - {@link toReadableText} strips obvious chrome and non-rendering content
 *   from an HTML document and returns the visible prose with whitespace
 *   collapsed. It satisfies Requirements 2.4, 2.5, and 2.28 and follows
 *   the design's "HTML-to-readable-text strategy" (cheerio-based, no
 *   browser/jsdom dependency).
 * - {@link parseSetCookie} parses one `Set-Cookie` header value into a
 *   {@link CookieInfo}, supporting only the public attributes the
 *   `web.fetch` tool surfaces. It is regex-driven and intentionally
 *   permissive: missing or malformed attributes are simply absent in the
 *   returned object instead of producing a hard error.
 */

import * as cheerio from "cheerio";

import type { CookieInfo, CookieSameSite } from "./types.js";

// ---------------------------------------------------------------------------
// HTML → readable text
// ---------------------------------------------------------------------------

/**
 * Selectors for elements whose text content should never appear in the
 * readable view. `script`/`style`/`noscript` carry executable or styling
 * payloads (Requirement 2.4); `nav`/`header`/`footer`/`aside` are the
 * obvious chrome regions called out in the design's
 * "HTML-to-readable-text strategy".
 */
const STRIPPED_SELECTORS = [
  "script",
  "style",
  "noscript",
  "nav",
  "header",
  "footer",
  "aside",
].join(", ");

/**
 * Convert an HTML document into a single readable text string.
 *
 * The conversion:
 * 1. Parses `html` with cheerio (no DOM/browser dependency).
 * 2. Removes `<script>`, `<style>`, `<noscript>`, `<nav>`, `<header>`,
 *    `<footer>`, and `<aside>` subtrees outright.
 * 3. Removes every HTML comment node anywhere in the tree.
 * 4. Extracts the remaining text via `$.root().text()`.
 * 5. Collapses every run of ASCII/Unicode whitespace (including newlines,
 *    tabs, NBSPs) into a single space and trims the result so the agent
 *    receives compact prose.
 *
 * Empty input, whitespace-only input, and input that contains only
 * stripped elements all yield the empty string.
 */
export function toReadableText(html: string): string {
  if (typeof html !== "string" || html.length === 0) return "";

  const $ = cheerio.load(html);

  // 1. Remove non-content elements outright.
  $(STRIPPED_SELECTORS).remove();

  // 2. Remove every comment node still attached to the tree. cheerio
  //    represents comments with `type === "comment"`; we walk the full
  //    contents of `*` so nested comments inside any remaining element
  //    are caught.
  $("*")
    .contents()
    .filter(function (this: { type?: string }) {
      return this.type === "comment";
    })
    .remove();

  const raw = $.root().text();
  return collapseWhitespace(raw);
}

/**
 * Collapse every contiguous run of whitespace characters into a single
 * ASCII space and trim leading/trailing whitespace.
 *
 * Treated as whitespace: the standard `\s` set (space, tab, CR, LF, FF,
 * VT) plus the most common non-breaking and zero-width characters that
 * show up in real-world web HTML — `\u00a0` (NBSP), `\u200b` (zero-width
 * space), `\u200c`/`\u200d` (zero-width joiner/non-joiner), `\ufeff`
 * (BOM/zero-width no-break space), and the assorted `\u2000-\u200a` set
 * of Unicode spaces.
 */
function collapseWhitespace(text: string): string {
  return text
    .replace(/[\s\u00a0\u2000-\u200a\u200b\u200c\u200d\u2028\u2029\ufeff]+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Set-Cookie parser
// ---------------------------------------------------------------------------

/**
 * Allowed values for `SameSite`, lower-cased for case-insensitive lookup.
 * The map preserves the canonical capitalisation used in the
 * {@link CookieInfo.sameSite} field.
 */
const SAME_SITE_VALUES: ReadonlyMap<string, CookieSameSite> = new Map([
  ["strict", "Strict"],
  ["lax", "Lax"],
  ["none", "None"],
]);

/**
 * Parse a single `Set-Cookie` header value into a {@link CookieInfo}.
 *
 * The parser is intentionally permissive: it never throws for malformed
 * input. The first `;`-separated attribute is treated as the
 * `name=value` pair (with everything after the first `=` taken verbatim
 * as the value, matching common server practice). Subsequent attributes
 * are matched case-insensitively against the public RFC 6265 set the
 * `web.fetch` tool surfaces:
 *
 * - `Domain`        → {@link CookieInfo.domain}
 * - `Path`          → {@link CookieInfo.path}
 * - `Expires`       → {@link CookieInfo.expires} as an ISO 8601 string
 *                     (omitted if the date string fails to parse)
 * - `Max-Age`       → {@link CookieInfo.maxAge} as a finite integer
 *                     (omitted if not a finite integer)
 * - `HttpOnly`      → {@link CookieInfo.httpOnly} = `true`
 * - `Secure`        → {@link CookieInfo.secure}   = `true`
 * - `SameSite=…`    → {@link CookieInfo.sameSite} normalized to
 *                     `"Strict"`/`"Lax"`/`"None"` (omitted if value is
 *                     unknown)
 *
 * Unknown attributes (e.g. `Priority`, `Partitioned`) are ignored. When
 * an attribute is missing, malformed, or unrecognised, the corresponding
 * field is simply absent from the returned object.
 *
 * The header value is expected to be a single cookie. Callers that
 * receive multiple cookies in a single header (which servers must not
 * do, but a few do) should split on the appropriate boundary before
 * calling this function.
 */
export function parseSetCookie(value: string): CookieInfo {
  if (typeof value !== "string") {
    return { name: "", value: "" };
  }

  // Split on `;` to peel attributes off the name=value pair. We do not
  // split on `,` because RFC 6265 §4.1 forbids commas in cookie values
  // unrelated to date attributes, and Node/undici always hand us one
  // header value per Set-Cookie line.
  const parts = value.split(";");
  const head = (parts[0] ?? "").trim();

  const eqIdx = head.indexOf("=");
  let name: string;
  let cookieValue: string;
  if (eqIdx === -1) {
    // No `=` at all: treat the whole token as the name, value empty.
    name = head;
    cookieValue = "";
  } else {
    name = head.slice(0, eqIdx).trim();
    // Per RFC 6265 the value runs to end-of-attribute; trim outer
    // whitespace but keep internal characters verbatim.
    cookieValue = head.slice(eqIdx + 1).trim();
  }

  // Build the result one field at a time so `exactOptionalPropertyTypes`
  // sees an absent key for any attribute we did not observe.
  const result: CookieInfo = { name, value: cookieValue };

  for (let i = 1; i < parts.length; i++) {
    const attr = parts[i];
    if (typeof attr !== "string") continue;
    const trimmed = attr.trim();
    if (trimmed.length === 0) continue;

    const attrEq = trimmed.indexOf("=");
    const attrName =
      attrEq === -1 ? trimmed : trimmed.slice(0, attrEq).trim();
    const attrValue = attrEq === -1 ? "" : trimmed.slice(attrEq + 1).trim();
    const lowerName = attrName.toLowerCase();

    switch (lowerName) {
      case "domain": {
        if (attrValue.length > 0) result.domain = attrValue;
        break;
      }
      case "path": {
        if (attrValue.length > 0) result.path = attrValue;
        break;
      }
      case "expires": {
        const iso = parseHttpDate(attrValue);
        if (iso !== undefined) result.expires = iso;
        break;
      }
      case "max-age": {
        const n = parseMaxAge(attrValue);
        if (n !== undefined) result.maxAge = n;
        break;
      }
      case "httponly": {
        result.httpOnly = true;
        break;
      }
      case "secure": {
        result.secure = true;
        break;
      }
      case "samesite": {
        const canonical = SAME_SITE_VALUES.get(attrValue.toLowerCase());
        if (canonical !== undefined) result.sameSite = canonical;
        break;
      }
      default:
        // Ignore unknown attributes (Priority, Partitioned, etc.).
        break;
    }
  }

  return result;
}

/**
 * Parse an HTTP-date string (RFC 7231 §7.1.1.1, including the legacy
 * RFC 850 and asctime forms) into an ISO 8601 timestamp. Returns
 * `undefined` when the value does not parse to a finite, valid date.
 */
function parseHttpDate(value: string): string | undefined {
  if (value.length === 0) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

/**
 * Parse a `Max-Age` attribute value into a finite integer. Returns
 * `undefined` for empty input, non-numeric input, fractional values, or
 * values outside the safe-integer range.
 */
function parseMaxAge(value: string): number | undefined {
  if (value.length === 0) return undefined;
  // RFC 6265 §5.2.2 specifies the value as DIGIT *DIGIT (optionally
  // preceded by `-` for delete-now semantics). Reject anything that
  // does not match that shape.
  if (!/^-?\d+$/.test(value)) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  if (!Number.isSafeInteger(n)) return undefined;
  return n;
}
