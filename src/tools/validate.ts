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

export function parseHost(raw: string): ParsedHost {
  const value = raw.trim();
  if (!value) {
    throw new Error(`Invalid host: empty value`);
  }
  if (SHELL_METACHAR_RE.test(value)) {
    throw new Error(`Invalid host "${value}": contains shell metacharacters`);
  }
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

const SCAN_PROFILE_KEYS = new Set([
  "scanType",
  "topPorts",
  "serviceDetect",
  "scripts",
  "timing",
  "udp",
]);

export function normalizeScanProfile(raw: unknown): ScanProfile | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid profile: expected an object");
  }
  const input = raw as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !SCAN_PROFILE_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`Invalid profile field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
  const profile: ScanProfile = {};

  if (input.scanType !== undefined) {
    if (typeof input.scanType !== "string") {
      throw new Error("Invalid profile.scanType: expected syn, tcp, udp, or ping");
    }
    const scanType = input.scanType.toLowerCase();
    if (scanType !== "syn" && scanType !== "tcp" && scanType !== "udp" && scanType !== "ping") {
      throw new Error(`Invalid profile.scanType: ${input.scanType}`);
    }
    profile.scanType = scanType;
  }
  if (input.topPorts !== undefined) {
    const topPorts =
      typeof input.topPorts === "string" && /^\d+$/.test(input.topPorts.trim())
        ? Number(input.topPorts)
        : input.topPorts;
    if (
      typeof topPorts !== "number" ||
      !Number.isInteger(topPorts) ||
      topPorts < 1 ||
      topPorts > 65535
    ) {
      throw new Error("Invalid profile.topPorts: expected an integer from 1 to 65535");
    }
    profile.topPorts = topPorts;
  }
  for (const key of ["serviceDetect", "udp"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      throw new Error(`Invalid profile.${key}: expected a boolean`);
    }
    profile[key] = value;
  }
  if (input.timing !== undefined) {
    if (typeof input.timing !== "string") {
      throw new Error("Invalid profile.timing: expected T0 through T5");
    }
    const timing = input.timing.toUpperCase();
    if (!/^T[0-5]$/.test(timing)) {
      throw new Error(`Invalid profile.timing: ${input.timing}`);
    }
    profile.timing = timing as TimingTemplate;
  }
  if (input.scripts !== undefined) {
    const scripts = Array.isArray(input.scripts)
      ? input.scripts
      : typeof input.scripts === "string"
        ? input.scripts.split(",")
        : input.scripts === true
          ? ["default"]
          : input.scripts === false
            ? []
            : undefined;
    if (!scripts || scripts.some((script) => typeof script !== "string")) {
      throw new Error(
        "Invalid profile.scripts: expected an array of safe script names",
      );
    }
    profile.scripts = scripts
      .map((script) => script.trim())
      .filter((script) => script.length > 0);
  }
  return profile;
}

const SAFE_SCRIPT_RE = /^[a-z0-9_-]+(?:,[a-z0-9_-]+)*$/i;

const ROOT_SCAN_FLAGS = new Set([
  "-sS",
  "-sU",
  "-sO",
  "-sN",
  "-sF",
  "-sX",
  "-sA",
  "-sW",
  "-sM",
  "-sY",
  "-sZ",
  "-O",
]);

export function nmapScanNeedsPrivilege(argv: readonly string[]): boolean {
  return argv.some((token) => ROOT_SCAN_FLAGS.has(token));
}

export function toConnectScanArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  let haveConnect = false;
  for (const token of argv) {
    if (ROOT_SCAN_FLAGS.has(token)) {
      if (token === "-O" || token === "-sU" || token === "-sO") continue;
      if (!haveConnect) {
        out.push("-sT");
        haveConnect = true;
      }
      continue;
    }
    out.push(token);
  }
  if (!haveConnect && !out.includes("-sT") && !out.includes("-sn")) {
    out.unshift("-sT");
  }
  return out;
}

export function nmapArgvHasPn(argv: readonly string[]): boolean {
  return argv.some((t) => t === "-Pn" || t === "-P0" || t === "-PN");
}

export function isNmapSingleHostTarget(argv: readonly string[]): boolean {
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    const token = argv[i]!;
    if (!token || token.startsWith("-")) continue;
    const prev = argv[i - 1];
    if (
      prev &&
      (prev === "-p" ||
        prev === "--top-ports" ||
        prev === "-T" ||
        prev === "--max-retries" ||
        prev === "--host-timeout" ||
        prev === "-oN" ||
        prev === "-oX" ||
        prev === "-oG" ||
        prev === "-iL" ||
        prev === "--script" ||
        prev === "--script-args")
    ) {
      continue;
    }
    if (token.includes("/")) return false;
    if (/,/.test(token)) return false;
    if (/^\d+\.\d+\.\d+\.\d+-\d+/.test(token)) return false;
    return true;
  }
  return false;
}

export function withNmapSkipDiscovery(argv: readonly string[]): string[] {
  if (nmapArgvHasPn(argv)) return [...argv];
  if (argv.includes("-sn") || argv.includes("-sL")) return [...argv];
  return ["-Pn", ...argv];
}

export function looksLikeNmapNoHostsUp(output: string): boolean {
  return /(?:0 hosts? up|host seems down|note:\s*host seems down|all \d+ scanned (?:ports|hosts) on .* are in ignored states)/i.test(
    output,
  );
}

export function profileToNmapArgs(rawProfile: ScanProfile = {}): string[] {
  const profile = normalizeScanProfile(rawProfile) ?? {};
  const args: string[] = [];
  if (profile.scanType === "tcp") args.push("-sT");
  else if (profile.scanType === "ping") args.push("-sn");
  else if (profile.scanType !== "udp") args.push("-sS");
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
    } else if (
      !Number.isInteger(profile.topPorts) ||
      profile.topPorts > 65535
    ) {
      throw new Error(`Invalid topPorts: ${profile.topPorts}`);
    } else {
      args.push("--top-ports", String(profile.topPorts));
    }
  }
  if (profile.scripts && profile.scripts.length > 0) {
    const PLACEHOLDER_SCRIPTS = new Set([
      "safe-script-name",
      "script-name",
      "safe_script_name",
    ]);
    const filtered = profile.scripts.filter(
      (s) => !PLACEHOLDER_SCRIPTS.has(s),
    );
    if (filtered.length > 0) {
      const joined = filtered.join(",");
      if (!SAFE_SCRIPT_RE.test(joined)) {
        throw new Error(`Invalid scripts list: ${joined}`);
      }
      args.push("--script", joined);
    }
  }
  return args;
}

const LEGACY_NMAP_FLAGS: Record<string, "none" | "value" | "script"> = {
  "-sS": "none", "-sT": "none", "-sU": "none", "-sV": "none", "-sn": "none",
  "-sL": "none", "-sA": "none", "-sW": "none", "-sF": "none", "-sX": "none",
  "-sN": "none", "-sM": "none", "-sY": "none", "-sZ": "none", "-sO": "none",
  "-Pn": "none", "-P0": "none", "-PN": "none", "-PE": "none", "-PP": "none",
  "-PM": "none", "-PR": "none", "-PS": "value", "-PA": "value", "-PU": "value",
  "-O": "none", "-A": "none", "-n": "none", "-R": "none", "-6": "none",
  "-F": "none", "-r": "none", "-v": "none", "-vv": "none", "-vvv": "none",
  "-d": "none", "-dd": "none",
  "--open": "none", "--reason": "none", "--traceroute": "none",
  "--osscan-guess": "none", "--osscan-limit": "none",
  "--version-all": "none", "--version-light": "none", "--version-trace": "none",
  "--defeat-rst-ratelimit": "none", "--defeat-icmp-ratelimit": "none",
  "--disable-arp-ping": "none", "--system-dns": "none",
  "--privileged": "none", "--unprivileged": "none", "--resolve-all": "none",
  "--badsum": "none", "--packet-trace": "none", "--fuzzy": "none",
  "-p": "value", "--exclude-ports": "value", "--top-ports": "value",
  "--port-ratio": "value", "--min-rate": "value", "--max-rate": "value",
  "--min-parallelism": "value", "--max-parallelism": "value",
  "--min-hostgroup": "value", "--max-hostgroup": "value",
  "--max-retries": "value", "--host-timeout": "value",
  "--scan-delay": "value", "--max-scan-delay": "value",
  "--initial-rtt-timeout": "value", "--min-rtt-timeout": "value",
  "--max-rtt-timeout": "value", "--version-intensity": "value",
  "--mtu": "value", "--data-length": "value", "--ttl": "value",
  "--source-port": "value", "-g": "value", "-e": "value",
  "--dns-servers": "value", "--exclude": "value",
  "--script": "script",
};

const LEGACY_TIMING_RE = /^-T[0-5]$/;
const LEGACY_FLAG_VALUE_RE = /^[A-Za-z0-9_.,:@/+-]+$/;

function legacyFlagArity(flag: string): "none" | "value" | "script" | undefined {
  if (LEGACY_TIMING_RE.test(flag)) return "none";
  return LEGACY_NMAP_FLAGS[flag];
}

export function parseLegacyFlags(raw: string): string[] {
  const value = raw.trim();
  if (!value) return [];
  const tokens = value.split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (!/^[A-Za-z0-9_./@:=,-]+$/.test(token)) {
      throw new Error(`Invalid flag token: ${token}`);
    }
    if (!token.startsWith("-")) {
      throw new Error(
        `Invalid flag token: ${token}. The legacy flags string accepts nmap flags only — pass the target in "target" and ports in "ports".`,
      );
    }
    const eq = token.indexOf("=");
    const name = eq > 0 ? token.slice(0, eq) : token;
    const inlineValue = eq > 0 ? token.slice(eq + 1) : undefined;
    const arity = legacyFlagArity(name);
    if (!arity) {
      throw new Error(
        `Rejected nmap flag "${name}": not on the net.scan allow-list. Use the structured "profile" (scanType/topPorts/serviceDetect/scripts/timing) instead; output, input-file, script, and datadir flags are never allowed here.`,
      );
    }
    if (arity === "none") {
      if (inlineValue !== undefined) {
        throw new Error(`Flag ${name} does not take a value`);
      }
      out.push(name);
      continue;
    }
    const flagValue = inlineValue ?? tokens[i + 1];
    if (flagValue === undefined || flagValue.startsWith("-")) {
      throw new Error(`Flag ${name} requires a value`);
    }
    if (arity === "script") {
      if (!SAFE_SCRIPT_RE.test(flagValue)) {
        throw new Error(
          `Invalid --script value "${flagValue}": use comma-separated script or category names (no paths, globs, or .nse files).`,
        );
      }
      if (inlineValue === undefined) i += 1;
      out.push(inlineValue === undefined ? name : token);
      if (inlineValue === undefined) out.push(flagValue);
      continue;
    }
    if (!LEGACY_FLAG_VALUE_RE.test(flagValue)) {
      throw new Error(`Invalid value for ${name}: ${flagValue}`);
    }
    if (inlineValue === undefined) i += 1;
    out.push(name, flagValue);
  }
  return out;
}
