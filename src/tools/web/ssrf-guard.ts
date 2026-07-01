/**
 * SSRF guard — classifies an address (or hostname literal) as
 * private/loopback/link-local/cloud-metadata/CGNAT. Single source of truth
 * for address classification: `web.fetch` (classifier branch + per-hop
 * resolution check), `src/safety/classifier.ts`, and the legacy
 * `http.fetch` check (via {@link isBlockedAddress}) all delegate here.
 */

import net from "node:net";

/**
 * Categorical address class returned by {@link classify} and
 * {@link classifyHost} when the input belongs to a non-public range.
 *
 * Mappings:
 * - `loopback`         — 127.0.0.0/8, IPv6 `::1`, and the
 *                         `localhost` / `ip6-localhost` hostname literals.
 * - `rfc1918`          — 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, and
 *                         IPv6 ULA `fc00::/7` (the IPv6 private-use range,
 *                         grouped here as RFC1918's IPv6 cousin).
 * - `ipv4-link-local`  — 169.254.0.0/16 except the cloud-metadata literal.
 * - `ipv6-link-local`  — `fe80::/10`.
 * - `cloud-metadata`   — `169.254.169.254` (IPv4 EC2/AWS, GCP, Azure
 *                         metadata) and `fd00:ec2::254` (IPv6 EC2 metadata).
 * - `cgnat`            — 100.64.0.0/10 (RFC 6598 carrier-grade NAT).
 */
export type AddressClass =
  | "loopback"
  | "rfc1918"
  | "ipv4-link-local"
  | "ipv6-link-local"
  | "cloud-metadata"
  | "cgnat";

/** Result shape returned by {@link classify} and {@link classifyHost}. */
export interface AddressClassification {
  class: AddressClass;
}

/**
 * `true` iff `url` parses as an absolute URL with scheme `http:`/`https:`.
 * Single source of truth for the scheme allow-list so the safety classifier
 * and the fetch-core argument validator stay in sync.
 */
export function isAllowedScheme(url: string): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * Hostname literals that are known to refer to the local host without any
 * DNS lookup. Lower-cased for case-insensitive comparison.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

/** IPv4 cloud-metadata address (AWS EC2, GCP, Azure all share this). */
const IPV4_CLOUD_METADATA = "169.254.169.254";

/**
 * Classify a literal IP address (IPv4 or IPv6).
 *
 * Returns `{ class }` when the address falls into one of the
 * {@link AddressClass} buckets, or `null` when the input is a
 * globally-routable address (or fails to parse as either family).
 *
 * The check is fully synchronous and never performs DNS.
 */
export function classify(ip: string): AddressClassification | null {
  if (typeof ip !== "string" || ip.length === 0) return null;
  if (net.isIPv4(ip)) return classifyIpv4(ip);
  if (net.isIPv6(ip)) return classifyIpv6(ip);
  return null;
}

/**
 * Classify a hostname or IP literal without performing DNS resolution.
 *
 * - For literal IPv4/IPv6 addresses (with or without surrounding `[…]`
 *   brackets), this delegates to {@link classify}.
 * - For known-bad hostname literals (`localhost`, `localhost.localdomain`,
 *   `ip6-localhost`, `ip6-loopback`), this returns `{ class: "loopback" }`.
 * - For every other hostname, this returns `null` (the caller is
 *   responsible for the DNS-resolved second pass; see
 *   `src/tools/web/fetch-core.ts`).
 */
export function classifyHost(hostname: string): AddressClassification | null {
  if (typeof hostname !== "string" || hostname.length === 0) return null;
  // Strip IPv6 brackets if the caller passed `[::1]` style.
  const stripped = hostname.replace(/^\[|\]$/g, "");
  const lower = stripped.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(lower)) return { class: "loopback" };
  return classify(stripped);
}

/**
 * Legacy boolean shape preserved for the existing `http.fetch` SSRF check.
 *
 * Returns `true` whenever {@link classifyHost} would return a non-null
 * classification, plus a small additional set of historically-blocked
 * ranges (currently `0.0.0.0/8`, the "this network" range) that are kept
 * for backward compatibility with the previous `http.ts` implementation
 * but are not enumerated in the public {@link AddressClass} list.
 */
export function isBlockedAddress(host: string): boolean {
  if (classifyHost(host) !== null) return true;
  // Preserve legacy semantics: `0.0.0.0/8` was blocked by the previous
  // implementation in `src/tools/http.ts`. It is not exposed via the
  // public `classify` enum because it is rarely useful as a fetch target
  // and is not called out by Requirement 5.3, but we keep blocking it.
  const stripped = host.replace(/^\[|\]$/g, "");
  if (net.isIPv4(stripped)) {
    const first = Number(stripped.split(".")[0]);
    if (Number.isInteger(first) && first === 0) return true;
  }
  if (net.isIPv6(stripped)) {
    const hextets = ipv6Hextets(stripped);
    if (hextets) {
      // ::ffff:<v4> with embedded `0.x.x.x` legacy block.
      if (
        hextets[0] === 0 &&
        hextets[1] === 0 &&
        hextets[2] === 0 &&
        hextets[3] === 0 &&
        hextets[4] === 0 &&
        hextets[5] === 0xffff
      ) {
        const embeddedFirstOctet = (hextets[6]! >> 8) & 0xff;
        if (embeddedFirstOctet === 0) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function classifyIpv4(ip: string): AddressClassification | null {
  const parts = ip.split(".").map((p) => Number(p));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return null;
  }
  // Cloud-metadata literal must win over the broader 169.254.0.0/16
  // link-local range so the class returned is the most specific one.
  if (ip === IPV4_CLOUD_METADATA) return { class: "cloud-metadata" };
  const [a, b] = parts as [number, number, number, number];
  if (a === 127) return { class: "loopback" };
  if (a === 10) return { class: "rfc1918" };
  if (a === 172 && b >= 16 && b <= 31) return { class: "rfc1918" };
  if (a === 192 && b === 168) return { class: "rfc1918" };
  if (a === 169 && b === 254) return { class: "ipv4-link-local" };
  if (a === 100 && b >= 64 && b <= 127) return { class: "cgnat" };
  return null;
}

function classifyIpv6(ip: string): AddressClassification | null {
  const hextets = ipv6Hextets(ip);
  if (!hextets) return null;

  // ::1 (loopback): all-zero except last hextet === 1.
  if (
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0 &&
    hextets[6] === 0 &&
    hextets[7] === 1
  ) {
    return { class: "loopback" };
  }

  // IPv4-mapped IPv6 (::ffff:0:0/96): recurse on the embedded v4 address
  // so the embedded address gets the most specific class.
  if (
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0xffff
  ) {
    const a = (hextets[6]! >> 8) & 0xff;
    const b = hextets[6]! & 0xff;
    const c = (hextets[7]! >> 8) & 0xff;
    const d = hextets[7]! & 0xff;
    return classifyIpv4(`${a}.${b}.${c}.${d}`);
  }

  // IPv6 cloud-metadata literal `fd00:ec2::254` must be checked before the
  // generic ULA match, otherwise it would be classified as rfc1918.
  if (
    hextets[0] === 0xfd00 &&
    hextets[1] === 0x0ec2 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0 &&
    hextets[6] === 0 &&
    hextets[7] === 0x0254
  ) {
    return { class: "cloud-metadata" };
  }

  // fe80::/10 (IPv6 link-local): top 10 bits == 1111 1110 10.
  if ((hextets[0]! & 0xffc0) === 0xfe80) {
    return { class: "ipv6-link-local" };
  }

  // fc00::/7 (Unique Local Addresses, the IPv6 cousin of RFC1918).
  if ((hextets[0]! & 0xfe00) === 0xfc00) {
    return { class: "rfc1918" };
  }

  return null;
}

/**
 * Expand an IPv6 address (string form) into its 8 hextets as integers.
 *
 * Supports `::` compression and the IPv4-in-last-32-bits form
 * (e.g. `::ffff:127.0.0.1`). Returns `null` if the input does not parse
 * as a valid IPv6 address.
 */
function ipv6Hextets(addr: string): number[] | null {
  if (!net.isIPv6(addr)) return null;
  let normalized = addr.toLowerCase();

  // Translate any embedded IPv4 dotted-quad in the last 32 bits into two
  // hextets so the rest of the parser can deal with a uniform format.
  const v4Match = normalized.match(
    /^(.*:)([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})$/,
  );
  if (v4Match) {
    const prefix = v4Match[1]!;
    const v4Parts = v4Match[2]!.split(".").map((p) => Number(p));
    if (
      v4Parts.length !== 4 ||
      v4Parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    ) {
      return null;
    }
    const hex1 = ((v4Parts[0]! << 8) | v4Parts[1]!).toString(16);
    const hex2 = ((v4Parts[2]! << 8) | v4Parts[3]!).toString(16);
    normalized = `${prefix}${hex1}:${hex2}`;
  }

  const parts = normalized.split("::");
  if (parts.length > 2) return null;

  const head = parts[0]!.length > 0 ? parts[0]!.split(":") : [];
  const tail =
    parts.length === 2 && parts[1]!.length > 0 ? parts[1]!.split(":") : [];
  const hasCompression = parts.length === 2;

  if (!hasCompression && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  if (hasCompression && missing < 1) return null;

  const middle = hasCompression ? Array<string>(missing).fill("0") : [];
  const all = [...head, ...middle, ...tail];
  if (all.length !== 8) return null;

  const hextets: number[] = [];
  for (const h of all) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    hextets.push(parseInt(h, 16));
  }
  return hextets;
}
