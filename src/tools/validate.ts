import net from "node:net";

export type HostKind = "ip" | "cidr" | "hostname";

export interface ParsedHost {
  kind: HostKind;
  value: string;
}

const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const SHORT_HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const SHELL_METACHAR_RE = /[\s;`$<>|&"'\\]/;

/**
 * Parse a network target as IP, CIDR, or hostname. Throws on shell-injection
 * attempts. The output is safe to pass to spawn() with `shell: false`.
 */
export function parseHost(raw: string): ParsedHost {
  const value = raw.trim();
  if (!value) {
    throw new Error(`Invalid host: empty value`);
  }
  if (SHELL_METACHAR_RE.test(value)) {
    throw new Error(`Invalid host "${value}": contains shell metacharacters`);
  }
  // CIDR: <ip>/<bits>
  if (value.includes("/")) {
    const [addr, maskRaw] = value.split("/");
    if (!addr || !maskRaw) {
      throw new Error(`Invalid CIDR: ${value}`);
    }
    const mask = Number(maskRaw);
    if (!Number.isInteger(mask)) {
      throw new Error(`Invalid CIDR mask: ${maskRaw}`);
    }
    const family = net.isIP(addr);
    if (family === 4) {
      if (mask < 0 || mask > 32) {
        throw new Error(`Invalid IPv4 CIDR mask: ${maskRaw}`);
      }
      return { kind: "cidr", value };
    }
    if (family === 6) {
      if (mask < 0 || mask > 128) {
        throw new Error(`Invalid IPv6 CIDR mask: ${maskRaw}`);
      }
      return { kind: "cidr", value };
    }
    throw new Error(`Invalid CIDR address: ${addr}`);
  }
  if (net.isIP(value)) {
    return { kind: "ip", value };
  }
  if (HOSTNAME_RE.test(value) || SHORT_HOSTNAME_RE.test(value)) {
    return { kind: "hostname", value: value.toLowerCase() };
  }
  throw new Error(`Invalid host: ${value}`);
}

/**
 * Validate an nmap-compatible port specification. Accepts:
 *   - single port: "80"
 *   - csv: "80,443,8080"
 *   - ranges: "1-1000"
 *   - mixed: "22,80,443,8000-9000"
 */
export function parsePortSpec(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("Invalid port spec: empty");
  if (SHELL_METACHAR_RE.test(value)) {
    throw new Error(`Invalid port spec "${value}": shell metacharacters`);
  }
  if (!/^[\d,\-]+$/.test(value)) {
    throw new Error(`Invalid port spec: ${value}`);
  }
  for (const part of value.split(",")) {
    if (part.includes("-")) {
      const [lo, hi] = part.split("-").map((n) => Number(n));
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
        throw new Error(`Invalid port range: ${part}`);
      }
      if (lo === undefined || hi === undefined) {
        throw new Error(`Invalid port range: ${part}`);
      }
      if (lo < 1 || lo > 65535 || hi < 1 || hi > 65535 || lo > hi) {
        throw new Error(`Invalid port range: ${part}`);
      }
    } else {
      const n = Number(part);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`Invalid port: ${part}`);
      }
    }
  }
  return value;
}

export type ScanType = "syn" | "tcp" | "udp" | "ping";
export type TimingTemplate = "T0" | "T1" | "T2" | "T3" | "T4" | "T5";

export interface ScanProfile {
  scanType?: ScanType | undefined;
  topPorts?: number | undefined;
  serviceDetect?: boolean | undefined;
  scripts?: string[] | undefined;
  timing?: TimingTemplate | undefined;
  udp?: boolean | undefined;
}

const SAFE_SCRIPT_RE = /^[a-z0-9_-]+(?:,[a-z0-9_-]+)*$/i;

/** Convert a structured scan profile into safe argv for nmap. */
export function profileToNmapArgs(profile: ScanProfile = {}): string[] {
  const args: string[] = [];
  if (profile.scanType === "syn") args.push("-sS");
  else if (profile.scanType === "tcp") args.push("-sT");
  else if (profile.scanType === "ping") args.push("-sn");
  if (profile.udp || profile.scanType === "udp") args.push("-sU");
  if (profile.serviceDetect) args.push("-sV");
  if (profile.timing) {
    if (!/^T[0-5]$/.test(profile.timing)) {
      throw new Error(`Invalid timing template: ${profile.timing}`);
    }
    args.push(`-${profile.timing}`);
  }
  if (typeof profile.topPorts === "number") {
    if (profile.topPorts <= 0) {
      // Model sent 0 or negative — treat as "not specified", don't crash
    } else if (!Number.isInteger(profile.topPorts) || profile.topPorts > 65535) {
      throw new Error(`Invalid topPorts: ${profile.topPorts}`);
    } else {
      args.push("--top-ports", String(profile.topPorts));
    }
  }
  if (profile.scripts && profile.scripts.length > 0) {
    const joined = profile.scripts.join(",");
    if (!SAFE_SCRIPT_RE.test(joined)) {
      throw new Error(`Invalid scripts list: ${joined}`);
    }
    args.push("--script", joined);
  }
  return args;
}

/**
 * For backwards compatibility with the legacy `flags` string. We accept a
 * whitespace-delimited list, but only if every token matches a strict
 * safe pattern (no shell metacharacters, no leading `-` followed by anything
 * we don't recognize as a benign flag).
 */
export function parseLegacyFlags(raw: string): string[] {
  const value = raw.trim();
  if (!value) return [];
  const tokens = value.split(/\s+/);
  for (const token of tokens) {
    if (!/^[A-Za-z0-9_./@:=,-]+$/.test(token)) {
      throw new Error(`Invalid flag token: ${token}`);
    }
  }
  return tokens;
}
