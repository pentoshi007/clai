/**
 * 64 KiB metadata budget enforcement for `web.fetch`.
 *
 * Requirement 2.35 caps the combined serialized size of the
 * {@link HeaderMap}, {@link TlsInfo}, {@link TimingInfo},
 * {@link RedirectChain}, and `cookies` array at
 * {@link METADATA_BUDGET_BYTES} (64 KiB). When the assembled metadata
 * exceeds the cap, this module reduces it deterministically using the
 * order documented in `.kiro/specs/web-search-and-fetch/design.md`,
 * "Truncation order at the 64 KiB cap":
 *
 * 1. Drop trailing cookies (last entry first) — Requirement 2.35.
 * 2. Halve the longest header value (with the literal
 *    {@link TRUNCATION_MARKER} appended) until every header value's
 *    "content" portion is ≤ 1024 characters. Header keys are never
 *    removed so the agent always sees which headers were present.
 * 3. Drop trailing redirect hops one at a time.
 *
 * `tls` and `timing` are well under 1 KiB combined and are never touched
 * by this loop. The function is pure: caller inputs are not mutated; the
 * returned object holds fresh copies of any arrays/maps that were
 * shortened.
 *
 * The implementation is bounded to a fixed iteration count so a
 * pathological input (for example, hundreds of header values that are
 * all ≤ 1024 chars yet collectively still exceed the cap) cannot wedge
 * the agent. In that edge case the returned `metadataBytes` may exceed
 * {@link METADATA_BUDGET_BYTES} — the caller can decide whether to
 * surface the overflow or treat it as a soft warning.
 */

import {
  type CookieInfo,
  type HeaderMap,
  type RedirectChain,
  type TimingInfo,
  type TlsInfo,
  METADATA_BUDGET_BYTES,
  TRUNCATION_MARKER,
} from "./types.js";

/**
 * Per-header-value floor below which the budget loop will not halve any
 * further. Once every header value's "content" portion (length excluding
 * the trailing {@link TRUNCATION_MARKER}, when present) is at or below
 * this number of characters, the loop moves on to dropping redirect
 * hops.
 *
 * Matches the design pseudocode "any header value not yet truncated to
 * 1024".
 */
const HEADER_VALUE_FLOOR = 1024;

/**
 * Hard upper bound on the number of reduction steps the budget loop will
 * perform per invocation. Each step either drops one cookie, halves one
 * header value, or drops one redirect hop. With realistic inputs the
 * loop terminates within a few dozen iterations; the cap exists purely
 * to defend against pathological inputs that would otherwise loop
 * forever.
 */
const MAX_ITERATIONS = 10_000;

/**
 * Inputs accepted by {@link enforce}.
 *
 * Each field corresponds to one slice of {@link WebFetchMetadata}.
 * Fields that the caller chose not to include (for example because the
 * user passed `includeHeaders=false`) may be omitted or set to
 * `undefined`; they are passed through to the result unchanged.
 */
export interface BudgetInput {
  headers?: HeaderMap | undefined;
  tls?: TlsInfo | undefined;
  timing?: TimingInfo | undefined;
  redirectChain?: RedirectChain | undefined;
  cookies?: CookieInfo[] | undefined;
}

/**
 * Result returned by {@link enforce}. Optional fields are present iff
 * the corresponding input field was present (an empty array is still
 * "present"). `metadataBytes` is the UTF-8 byte length of
 * `JSON.stringify({headers, tls, timing, redirectChain, cookies})` after
 * the truncation loop has finished. `cap` mirrors the constant from
 * `types.ts` so consumers can render `metadataBytes / cap` without
 * importing it themselves.
 */
export interface BudgetResult {
  headers?: HeaderMap;
  tls?: TlsInfo;
  timing?: TimingInfo;
  redirectChain?: RedirectChain;
  cookies?: CookieInfo[];
  metadataBytes: number;
  cap: typeof METADATA_BUDGET_BYTES;
}

/**
 * Enforce the 64 KiB metadata budget on the supplied fields.
 *
 * Returns a fresh {@link BudgetResult} containing (possibly shortened)
 * copies of `headers`, `redirectChain`, and `cookies`, alongside `tls`
 * and `timing` passed through unchanged, plus the final
 * `metadataBytes` count.
 *
 * The returned arrays/maps are independent of the caller's inputs — the
 * function does not mutate `input`.
 */
export function enforce(input: BudgetInput): BudgetResult {
  // Shallow-copy any mutable structures so the caller's data is left
  // untouched even when the loop pops or halves entries.
  const headers: HeaderMap | undefined =
    input.headers !== undefined ? { ...input.headers } : undefined;
  const cookies: CookieInfo[] | undefined =
    input.cookies !== undefined ? [...input.cookies] : undefined;
  const redirectChain: RedirectChain | undefined =
    input.redirectChain !== undefined ? [...input.redirectChain] : undefined;
  const { tls, timing } = input;

  const measure = (): number =>
    Buffer.byteLength(
      JSON.stringify({ headers, tls, timing, redirectChain, cookies }),
      "utf8",
    );

  let metadataBytes = measure();

  for (
    let i = 0;
    i < MAX_ITERATIONS && metadataBytes > METADATA_BUDGET_BYTES;
    i++
  ) {
    let progress = false;

    if (cookies !== undefined && cookies.length > 0) {
      // Step 1: drop trailing cookies first (Requirement 2.35).
      cookies.pop();
      progress = true;
    } else if (headers !== undefined && hasHalveableHeader(headers)) {
      // Step 2: halve the longest header value with content > 1024 chars.
      halveLongestHeaderValue(headers);
      progress = true;
    } else if (redirectChain !== undefined && redirectChain.length > 0) {
      // Step 3: drop trailing redirect hops as the last resort.
      redirectChain.pop();
      progress = true;
    }

    if (!progress) break;
    metadataBytes = measure();
  }

  return assemble({
    headers,
    tls,
    timing,
    redirectChain,
    cookies,
    metadataBytes,
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Return `true` iff at least one header value's content portion (length
 * excluding the trailing {@link TRUNCATION_MARKER}, when present)
 * exceeds {@link HEADER_VALUE_FLOOR}.
 */
function hasHalveableHeader(headers: HeaderMap): boolean {
  for (const value of Object.values(headers)) {
    if (contentLength(value) > HEADER_VALUE_FLOOR) return true;
  }
  return false;
}

/**
 * Find the header whose content portion is currently longest (ties
 * resolved by iteration order, which is stable in V8 for string keys),
 * halve that content in place, and append the
 * {@link TRUNCATION_MARKER}. Header values whose content is already
 * ≤ {@link HEADER_VALUE_FLOOR} are skipped; the function is a no-op when
 * no such value exists.
 */
function halveLongestHeaderValue(headers: HeaderMap): void {
  let bestKey: string | undefined;
  let bestLen = -1;
  for (const [key, value] of Object.entries(headers)) {
    const len = contentLength(value);
    if (len > HEADER_VALUE_FLOOR && len > bestLen) {
      bestKey = key;
      bestLen = len;
    }
  }
  if (bestKey === undefined) return;

  const current = headers[bestKey];
  if (current === undefined) return;

  const content = stripMarker(current);
  const halved = content.slice(0, Math.floor(content.length / 2));
  headers[bestKey] = `${halved}${TRUNCATION_MARKER}`;
}

/**
 * Length of `value`'s "content" portion in characters: the full string
 * length minus the {@link TRUNCATION_MARKER} suffix when one is
 * present. Used so repeated halving of the same header value reduces
 * the underlying content rather than treating the marker itself as
 * shrinkable text.
 */
function contentLength(value: string): number {
  return stripMarker(value).length;
}

/**
 * Strip a single trailing {@link TRUNCATION_MARKER} from `value` if one
 * is present. Returns `value` unchanged otherwise. Used by the halving
 * step so the marker is not duplicated when a header is truncated more
 * than once across loop iterations.
 */
function stripMarker(value: string): string {
  return value.endsWith(TRUNCATION_MARKER)
    ? value.slice(0, value.length - TRUNCATION_MARKER.length)
    : value;
}

/**
 * Build the {@link BudgetResult} from the working state. Optional input
 * fields that were not supplied are left absent on the result (rather
 * than set to `undefined`) to satisfy `exactOptionalPropertyTypes`.
 */
function assemble(state: {
  headers: HeaderMap | undefined;
  tls: TlsInfo | undefined;
  timing: TimingInfo | undefined;
  redirectChain: RedirectChain | undefined;
  cookies: CookieInfo[] | undefined;
  metadataBytes: number;
}): BudgetResult {
  const result: BudgetResult = {
    metadataBytes: state.metadataBytes,
    cap: METADATA_BUDGET_BYTES,
  };
  if (state.headers !== undefined) result.headers = state.headers;
  if (state.tls !== undefined) result.tls = state.tls;
  if (state.timing !== undefined) result.timing = state.timing;
  if (state.redirectChain !== undefined)
    result.redirectChain = state.redirectChain;
  if (state.cookies !== undefined) result.cookies = state.cookies;
  return result;
}
