/**
 * Header / cookie redaction and audit-log stripping for `web.fetch`.
 *
 * This module is the single source of truth for the
 * {@link HeaderMap} format described in Requirement 2.21 (lower-cased keys,
 * repeat values joined with `", "`, per-value 4096-char cap with the
 * literal `[...truncated]` marker). It also implements the redaction rules
 * required by 2.22 / 2.32 and the audit-log strip required by 5.11–5.13.
 *
 * See `.kiro/specs/web-search-and-fetch/design.md` "Redaction strategy"
 * for the broader picture.
 */

import {
  type CookieInfo,
  type CookieSameSite,
  type HeaderMap,
  MAX_HEADER_VALUE_LENGTH,
  REDACTED_PLACEHOLDER,
  TRUNCATION_MARKER,
} from "./types.js";

/**
 * Case-insensitive set of header names whose values are considered
 * sensitive. Stored lower-cased so callers can match them against
 * already-normalized {@link HeaderMap} keys without re-casing.
 *
 * Mirrors Requirement 5.12 / design "Redaction strategy".
 */
export const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
]);

/**
 * Ordered list of `[name, value]` pairs, the most general header input
 * shape. Repeats of the same name are preserved in the order observed and
 * are joined by {@link applyToHeaders} per RFC 7230.
 *
 * Callers that have a Node `http.IncomingMessage.rawHeaders` array (a flat
 * `string[]` of alternating name/value entries) can convert it with
 *
 * ```ts
 * const pairs: HeaderEntries = [];
 * for (let i = 0; i < raw.length; i += 2) pairs.push([raw[i]!, raw[i + 1]!]);
 * ```
 */
export type HeaderEntries = ReadonlyArray<readonly [string, string]>;

/**
 * Reduced cookie shape produced by {@link stripForAudit}: only the
 * non-secret public attributes named by Requirement 5.11 are kept. The
 * cookie's `value`, `expires`, and `maxAge` fields are intentionally
 * absent — the audit log never carries cookie values nor any field that
 * could leak session lifetime back to a third party.
 */
export interface AuditSafeCookie {
  name: string;
  domain?: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: CookieSameSite;
}

/**
 * Output shape of {@link stripForAudit}: a header map with every
 * sensitive header dropped and a cookies list with every value-bearing
 * field removed. Both fields are always present (possibly empty) so the
 * caller can spread them into an audit payload without `undefined` checks.
 */
export interface AuditSafePayload {
  headers: HeaderMap;
  cookies: AuditSafeCookie[];
}

/**
 * Normalize a set of HTTP response headers into the canonical
 * {@link HeaderMap} format documented in Requirement 2.21.
 *
 * Steps applied, in order:
 * 1. Lower-case every header name.
 * 2. Join repeated values for the same name with `", "` (RFC 7230).
 * 3. If `redactSensitive=true` and the lower-cased name is in
 *    {@link SENSITIVE_HEADERS}, replace the joined value with the literal
 *    {@link REDACTED_PLACEHOLDER}.
 * 4. Otherwise, if the joined value's character length exceeds
 *    {@link MAX_HEADER_VALUE_LENGTH}, slice it to the cap and append
 *    {@link TRUNCATION_MARKER}.
 *
 * Accepts either a flat {@link HeaderMap} (already deduplicated by the
 * caller) or a list of `[name, value]` pairs ({@link HeaderEntries}). The
 * pair form preserves repeats — a `Set-Cookie` header that appears three
 * times will produce three entries that this function joins. The flat-map
 * form is convenient for callers that already have a `Record<string,
 * string>`; in that case there are no repeats to join.
 *
 * The function is the single source of truth for the
 * {@link HeaderMap} format. Both the user-facing fetch result and the
 * audit-log path go through it (the audit path additionally calls
 * {@link stripForAudit} to drop sensitive entries entirely).
 */
export function applyToHeaders(
  input: HeaderMap | HeaderEntries,
  redactSensitive: boolean,
): HeaderMap {
  // Group repeated header names. Ordering is preserved by the Map.
  const grouped = new Map<string, string[]>();
  const entries: Iterable<readonly [string, string]> = Array.isArray(input)
    ? (input as HeaderEntries)
    : Object.entries(input as HeaderMap);

  for (const [name, value] of entries) {
    if (typeof name !== "string" || typeof value !== "string") continue;
    const key = name.toLowerCase();
    const existing = grouped.get(key);
    if (existing) {
      existing.push(value);
    } else {
      grouped.set(key, [value]);
    }
  }

  const out: HeaderMap = {};
  for (const [key, values] of grouped) {
    if (redactSensitive && SENSITIVE_HEADERS.has(key)) {
      // The redacted placeholder is shorter than the cap and is a fixed
      // marker; do not run it through the truncator.
      out[key] = REDACTED_PLACEHOLDER;
      continue;
    }
    const joined = values.join(", ");
    out[key] =
      joined.length > MAX_HEADER_VALUE_LENGTH
        ? joined.slice(0, MAX_HEADER_VALUE_LENGTH) + TRUNCATION_MARKER
        : joined;
  }

  return out;
}

/**
 * Apply the cookie-value redaction rule from Requirement 2.32.
 *
 * Returns a fresh array of fresh {@link CookieInfo} objects so the caller
 * can mutate the result without aliasing the inputs:
 * - When `redactSensitive=true`: every entry's `value` is replaced with
 *   the literal {@link REDACTED_PLACEHOLDER}; all other attributes
 *   (`name`, `domain`, `path`, `expires`, `maxAge`, `httpOnly`, `secure`,
 *   `sameSite`) are preserved unchanged.
 * - When `redactSensitive=false`: every entry is shallow-copied verbatim.
 */
export function applyToCookies(
  cookies: readonly CookieInfo[],
  redactSensitive: boolean,
): CookieInfo[] {
  if (!redactSensitive) {
    return cookies.map((c) => ({ ...c }));
  }
  return cookies.map((c) => ({ ...c, value: REDACTED_PLACEHOLDER }));
}

/**
 * Build the audit-log-safe view of a fetch's headers and cookies.
 *
 * Always-on guarantees, regardless of `redactSensitive`:
 * - Every {@link SENSITIVE_HEADERS} entry is removed from the returned
 *   header map (key and value both gone). The value never appears in any
 *   form, including as `[REDACTED]` — the audit log simply does not
 *   advertise that the header was present (Requirement 5.12).
 * - Every cookie is reduced to the {@link AuditSafeCookie} shape:
 *   `{name, domain, path, httpOnly, secure, sameSite}`. Cookie values,
 *   `expires`, and `maxAge` are dropped (Requirements 5.11, 5.12).
 *
 * The remaining (non-sensitive) headers are passed through with their
 * keys lower-cased so the caller does not need to re-normalize. Header
 * values are not re-truncated here — they have already been processed by
 * {@link applyToHeaders} on the way into `metadata.headers`.
 *
 * Both arguments are tolerant of `undefined` so the caller can hand off
 * an optional `metadata.headers` / `metadata.cookies` directly.
 */
export function stripForAudit(
  headers: HeaderMap | undefined,
  cookies: readonly CookieInfo[] | undefined,
): AuditSafePayload {
  const safeHeaders: HeaderMap = {};
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (typeof key !== "string" || typeof value !== "string") continue;
      const lower = key.toLowerCase();
      if (SENSITIVE_HEADERS.has(lower)) continue;
      safeHeaders[lower] = value;
    }
  }

  const safeCookies: AuditSafeCookie[] = [];
  if (cookies) {
    for (const c of cookies) {
      const entry: AuditSafeCookie = { name: c.name };
      if (c.domain !== undefined) entry.domain = c.domain;
      if (c.path !== undefined) entry.path = c.path;
      if (c.httpOnly !== undefined) entry.httpOnly = c.httpOnly;
      if (c.secure !== undefined) entry.secure = c.secure;
      if (c.sameSite !== undefined) entry.sameSite = c.sameSite;
      safeCookies.push(entry);
    }
  }

  return { headers: safeHeaders, cookies: safeCookies };
}
