/**
 * SSRF guard — classifies an address (or hostname literal) as
 * private/loopback/link-local/cloud-metadata/CGNAT. Single source of truth
 * for address classification: `web.fetch` (classifier branch + per-hop
 * resolution check), `src/safety/classifier.ts`, and the legacy
 * `http.fetch` check (via {@link isBlockedAddress}) all delegate here.
 */

import net from "node:net";

export type AddressClass =
  | "loopback"
  | "rfc1918"
  | "ipv4-link-local"
  | "ipv6-link-local"
  | "cloud-metadata"
  | "cgnat";

export interface AddressClassification {
  class: AddressClass;
}

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

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

const IPV4_CLOUD_METADATA = "169.254.169.254";

export function classify(ip: string): AddressClassification | null {
  if (typeof ip !== "string" || ip.length === 0) return null;
  if (net.isIPv4(ip)) return classifyIpv4(ip);
  if (net.isIPv6(ip)) return classifyIpv6(ip);
  return null;
}

export function classifyHost(hostname: string): AddressClassification | null {
  if (typeof hostname !== "string" || hostname.length === 0) return null;
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
  const stripped = host.replace(/^\[|\]$/g, "");
  if (net.isIPv4(stripped)) {
    const first = Number(stripped.split(".")[0]);
    if (Number.isInteger(first) && first === 0) return true;
  }
  if (net.isIPv6(stripped)) {
    const hextets = ipv6Hextets(stripped);
    if (hextets) {
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


function classifyIpv4(ip: string): AddressClassification | null {
  const parts = ip.split(".").map((p) => Number(p));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return null;
  }
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

  if ((hextets[0]! & 0xffc0) === 0xfe80) {
    return { class: "ipv6-link-local" };
  }

  if ((hextets[0]! & 0xfe00) === 0xfc00) {
    return { class: "rfc1918" };
  }

  return null;
}

function ipv6Hextets(addr: string): number[] | null {
  if (!net.isIPv6(addr)) return null;
  let normalized = addr.toLowerCase();

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
