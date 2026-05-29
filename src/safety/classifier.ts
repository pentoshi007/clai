import net from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { RiskLevel, ToolCall } from "../types.js";
import {
  containsShellMetacharacter,
  destructiveCommandPatterns,
  exfiltrationPatterns,
  isSecretPath,
  networkScanTools,
  readOnlyShellCommands,
  subcommandSafeMap,
  commandHasMutatingArg,
} from "./patterns.js";
import {
  isScopeActive,
  normalizeScopeTarget,
  targetInScope,
  type EngagementScope,
} from "../store/scope.js";
import { classifyHost } from "../tools/web/ssrf-guard.js";

export interface RiskDecision {
  level: RiskLevel;
  reason: string;
}

function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

function resolveForSecretCheck(path: string): string {
  return resolve(expandTilde(path));
}

export function isPrivateIpv4(value: string): boolean {
  const candidate = value.split("/")[0] ?? value;
  // Handle hostnames — if it's not an IP, treat it as non-private (domain)
  if (net.isIP(candidate) === 0) return false;
  if (net.isIP(candidate) === 6) {
    // IPv6 link-local (fe80::), loopback (::1), ULA (fc00::/7)
    const lower = candidate.toLowerCase();
    return (
      lower === "::1" ||
      lower.startsWith("fe80:") ||
      lower.startsWith("fc") ||
      lower.startsWith("fd")
    );
  }
  const parts = candidate.split(".").map((part) => Number(part));
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function commandContainsNetworkScanner(command: string): boolean {
  return networkScanTools.some((tool) =>
    new RegExp(`(^|\\s)${tool}(\\s|$)`, "i").test(command),
  );
}

const PRIVATE_TLD_RE = /\.(?:local|internal|lan|home|corp|intranet|test|localdomain)$/i;
const URL_HOSTNAME_RE = /\bhttps?:\/\/([^\/\s:?#]+)/gi;
// A bareword domain anchored at a whitespace boundary on the left so we
// don't pick up file paths like `wordlists/common.txt`. The right side
// stays at \b so trailing punctuation doesn't trip us up.
const BARE_HOSTNAME_RE =
  /(?:^|\s)((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63})\b/g;

function extractHostnameTokens(command: string): string[] {
  const tokens: string[] = [];
  // First pull host parts out of any URL so https://example.com/FUZZ contributes "example.com"
  let match: RegExpExecArray | null;
  URL_HOSTNAME_RE.lastIndex = 0;
  while ((match = URL_HOSTNAME_RE.exec(command)) !== null) {
    if (match[1]) tokens.push(match[1].replace(/\[|\]/g, "").split(":")[0]!);
  }
  // Then capture bare-hostname tokens (eg `nmap example.com`). The leading
  // boundary stops us picking up `path/to/common.txt` (which would
  // otherwise look like a domain because of the `.txt` suffix).
  BARE_HOSTNAME_RE.lastIndex = 0;
  while ((match = BARE_HOSTNAME_RE.exec(command)) !== null) {
    if (match[1]) tokens.push(match[1]);
  }
  return tokens;
}

const FILEY_TLDS = new Set([
  "txt", "log", "json", "yaml", "yml", "md", "html", "htm", "xml", "csv",
  "sh", "py", "rb", "rs", "go", "js", "ts", "tsx", "jsx", "css", "scss",
  "tar", "gz", "zip", "tgz", "pdf", "png", "jpg", "jpeg", "gif", "svg",
  "exe", "dll", "so", "dylib", "ini", "conf", "lock", "toml", "env",
]);

function isPublicHostname(host: string): boolean {
  const lower = host.toLowerCase();
  if (!lower.includes(".")) return false;
  if (lower === "localhost" || lower === "localhost.localdomain") return false;
  if (PRIVATE_TLD_RE.test(lower)) return false;
  // Reject things that look like filenames (common.txt, package.json, etc.)
  // even when they syntactically resemble a domain.
  const tld = lower.split(".").pop() ?? "";
  if (FILEY_TLDS.has(tld)) return false;
  // Must contain at least one alphabetic TLD-like segment to count as a domain
  return /\.[a-z]{2,63}$/i.test(lower);
}

function containsPublicTarget(command: string): boolean {
  const ips = command.match(/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/g) ?? [];
  if (ips.some((ip) => !isPrivateIpv4(ip))) return true;
  return extractHostnameTokens(command).some((host) => isPublicHostname(host));
}

export function isPentestToolCall(call: ToolCall): boolean {
  if (call.name === "net.scan" || call.name === "pentest.recon") return true;
  if (call.name !== "shell.exec") return false;
  const command = stringArg(call.args, "command") ?? "";
  return commandContainsNetworkScanner(command);
}

/**
 * Pull rough "path-looking" tokens out of a command string. Used so we can
 * refuse to auto-execute commands that touch known secret paths even when
 * the base command (cat, head, tail, less, etc.) is otherwise safe.
 */
function extractPathLikeTokens(command: string): string[] {
  // Match tilde paths, absolute paths, and dotted relative paths.
  const matches = command.match(/(?:~|\.{1,2}|\/)?[\w./~-]+/g) ?? [];
  return matches.filter((token) => /[\\/~]/.test(token));
}

function commandTouchesSecretPath(command: string): boolean {
  return extractPathLikeTokens(command).some((token) => {
    try {
      return isSecretPath(resolveForSecretCheck(token));
    } catch {
      return false;
    }
  });
}

/**
 * Split a command line into [base, subcommand] respecting quotes minimally.
 * We only need the first two whitespace-delimited tokens.
 */
function baseAndSub(command: string): {
  base: string;
  sub: string | undefined;
} {
  const tokens = command.trim().split(/\s+/);
  const baseRaw = tokens[0] ?? "";
  const base = baseRaw.replace(/^.*\//, "");
  const sub = tokens[1];
  return { base, sub };
}

function isReadOnlyBase(base: string): boolean {
  return readOnlyShellCommands.has(base);
}

function isSafeSubcommand(base: string, sub: string | undefined): boolean {
  if (!sub) return false;
  const allow = subcommandSafeMap[base];
  if (!allow) return false;
  // Strip leading `--` so `--list` and `list` both work.
  return allow.has(sub) || allow.has(sub.replace(/^--/, ""));
}

export interface ClassifyOptions {
  scope?: EngagementScope | undefined;
}

/**
 * Extract the apparent target from a shell command that contains a scanner.
 * Used to decide whether the target is covered by the active engagement
 * scope. Falls back to the trailing token of the command if no obvious
 * target argument is found.
 */
function extractScanTarget(command: string): string | undefined {
  // URL-style targets first (eg `ffuf -u https://example.com/FUZZ`,
  // `nuclei -u https://example.com`). The hostname is what scope cares about.
  const urlMatch = /\bhttps?:\/\/([^\/\s:?#]+)/i.exec(command);
  if (urlMatch?.[1]) {
    return urlMatch[1].replace(/[\[\]]/g, "").split(":")[0];
  }
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  // Drop the first token (binary) and any leading flags.
  const args = tokens.slice(1).filter((token) => !token.startsWith("-"));
  // Many scanners take target as the trailing positional.
  for (let i = args.length - 1; i >= 0; i -= 1) {
    const arg = args[i]!;
    if (
      /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(arg) ||
      net.isIP(arg) ||
      /^[0-9./]+$/.test(arg)
    ) {
      return arg;
    }
  }
  return undefined;
}

function isPublicTarget(target: string): boolean {
  const normalized = normalizeScopeTarget(target);
  if (!normalized) return false;
  const host = normalized.split("/")[0] ?? normalized;
  if (net.isIP(host)) return !isPrivateIpv4(normalized);
  if (host === "localhost" || PRIVATE_TLD_RE.test(host)) return false;
  return true;
}

export function scopeTargetForToolCall(call: ToolCall): string | undefined {
  if (call.name === "shell.exec") {
    const command = stringArg(call.args, "command") ?? "";
    if (!commandContainsNetworkScanner(command) || !containsPublicTarget(command)) {
      return undefined;
    }
    const target = extractScanTarget(command);
    return target && isPublicTarget(target) ? normalizeScopeTarget(target) : undefined;
  }

  if (call.name === "net.scan" || call.name === "pentest.recon") {
    const target = stringArg(call.args, "target") ?? "";
    return target && isPublicTarget(target)
      ? normalizeScopeTarget(target)
      : undefined;
  }

  return undefined;
}

export function scopeHint(target: string | undefined): string {
  return target
    ? `Run \`/scope add ${target}\` or \`clai scope add --targets ${target}\` to authorize it.`
    : "Run `/scope add <target>` or `clai scope add --targets <target>` to authorize it.";
}

export function classifyToolCall(
  call: ToolCall,
  options: ClassifyOptions = {},
): RiskDecision {
  if (
    call.name === "fs.read" ||
    call.name === "fs.list" ||
    call.name === "fs.search"
  ) {
    const pathArg = stringArg(call.args, "path");
    if (pathArg) {
      try {
        if (isSecretPath(resolveForSecretCheck(pathArg))) {
          return {
            level: "block",
            reason:
              "Path is a known secret location and cannot be read by the agent",
          };
        }
      } catch {
        // resolve failed — fall through to safe
      }
    }
    return { level: "safe", reason: "Read-only operation" };
  }

  if (call.name === "sysinfo") {
    return { level: "safe", reason: "Read-only operation" };
  }

  if (call.name === "dns.lookup" || call.name === "whois.lookup") {
    // Single-shot DNS / whois queries are passive lookups. They never
    // touch the target's network stack, so we don't gate them behind
    // pentest authorization or scope confirmation. The underlying
    // spawnArgv call still validates the target via parseHost.
    return { level: "safe", reason: "Passive lookup against public registries" };
  }

  if (call.name === "tool.batch") {
    // The batch handler enforces a hard allowlist of read-only tools and a
    // capped concurrency. Treat it as safe so batched recon can run without
    // a per-call confirmation. If the caller smuggles in a non-safe tool,
    // the handler rejects it.
    return { level: "safe", reason: "Read-only batch dispatch" };
  }

  if (call.name === "http.fetch") {
    const method = (stringArg(call.args, "method") ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return {
        level: "confirm",
        reason: `HTTP ${method} is mutating and requires confirmation`,
      };
    }
    return {
      level: "safe",
      reason: "HTTP GET/HEAD is read-only",
    };
  }

  if (call.name === "shell.exec") {
    const command = stringArg(call.args, "command") ?? "";
    if (destructiveCommandPatterns.some((pattern) => pattern.test(command))) {
      return {
        level: "block",
        reason: "Command matches destructive safety pattern",
      };
    }
    if (exfiltrationPatterns.some((pattern) => pattern.test(command))) {
      return {
        level: "block",
        reason: "Command resembles secret or data exfiltration",
      };
    }
    if (commandTouchesSecretPath(command)) {
      return {
        level: "block",
        reason:
          "Command references a known secret path (e.g. ~/.ssh, ~/.clai/keys.json, .env)",
      };
    }
    // Pentest scan tools always require confirmation even against private targets
    if (commandContainsNetworkScanner(command)) {
      const target = scopeTargetForToolCall(call);
      if (
        target &&
        (!isScopeActive(options.scope) || !targetInScope(target, options.scope))
      ) {
        return {
          level: "confirm",
          reason: `Public target scan; scope is optional. ${scopeHint(target)}`,
        };
      }
      return {
        level: "confirm",
        reason: "Security scan tool requires confirmation",
      };
    }
    // Compound commands (pipes, redirects, &&, ||, sudo, command substitution)
    // always require confirmation because the arguments can mutate state or
    // exfiltrate data even when the base command is otherwise safe.
    if (containsShellMetacharacter(command)) {
      return {
        level: "confirm",
        reason:
          "Compound command (pipes, redirects, &&, ||, sudo, or command substitution) requires confirmation",
      };
    }
    // Mutating-argument patterns (sed -i, awk system(...), find -exec/-delete,
    // git config --global, npm config set, docker run, kubectl apply, ...).
    // These bypass the read-only base check because their *arguments* mutate
    // state or escape into another shell.
    if (commandHasMutatingArg(command)) {
      return {
        level: "confirm",
        reason:
          "Command argument mutates state or escapes into another shell (sed -i, awk system(), find -exec/-delete, git config --global, npm config set, docker/kubectl mutators)",
      };
    }
    // Read-only / info commands are safe to auto-execute
    const { base, sub } = baseAndSub(command);
    if (isReadOnlyBase(base)) {
      return { level: "safe", reason: "Read-only command" };
    }
    if (isSafeSubcommand(base, sub)) {
      return { level: "safe", reason: `Read-only ${base} subcommand` };
    }
    return { level: "confirm", reason: "Shell commands require confirmation" };
  }

  if (call.name === "net.scan") {
    const scopeTarget = scopeTargetForToolCall(call);
    if (
      scopeTarget &&
      (!isScopeActive(options.scope) || !targetInScope(scopeTarget, options.scope))
    ) {
      return {
        level: "confirm",
        reason: `Public target scan; scope is optional. ${scopeHint(scopeTarget)}`,
      };
    }
    return { level: "confirm", reason: "Network scans require confirmation" };
  }

  if (call.name === "pentest.recon") {
    const scopeTarget = scopeTargetForToolCall(call);
    if (
      scopeTarget &&
      (!isScopeActive(options.scope) || !targetInScope(scopeTarget, options.scope))
    ) {
      return {
        level: "confirm",
        reason: `Public target recon; scope is optional. ${scopeHint(scopeTarget)}`,
      };
    }
    return {
      level: "confirm",
      reason:
        "Pentest recon requires confirmation and authorization acknowledgement",
    };
  }

  if (call.name === "fs.write" || call.name === "pkg.install") {
    if (call.name === "fs.write") {
      const pathArg = stringArg(call.args, "path");
      if (pathArg) {
        try {
          if (isSecretPath(resolveForSecretCheck(pathArg))) {
            return {
              level: "block",
              reason: "Refusing to write to a known secret path",
            };
          }
        } catch {
          // fall through
        }
      }
    }
    return {
      level: "confirm",
      reason: "Mutating operation requires confirmation",
    };
  }

  if (call.name === "fs.writeMany") {
    // Block the whole batch if ANY target is a known secret path.
    const files = Array.isArray(call.args.files) ? call.args.files : [];
    for (const entry of files) {
      const pathArg =
        entry && typeof entry === "object"
          ? (entry as { path?: unknown }).path
          : undefined;
      if (typeof pathArg === "string") {
        try {
          if (isSecretPath(resolveForSecretCheck(pathArg))) {
            return {
              level: "block",
              reason: `Refusing to write to a known secret path: ${pathArg}`,
            };
          }
        } catch {
          // fall through
        }
      }
    }
    return {
      level: "confirm",
      reason: "Mutating operation requires confirmation",
    };
  }

  // ── New tools ──────────────────────────────────────────────────────

  if (call.name === "net.context") {
    return { level: "safe", reason: "Read-only local network info" };
  }

  if (call.name === "tool.check") {
    return { level: "safe", reason: "Read-only tool availability check" };
  }

  if (call.name === "net.pingSweep") {
    return {
      level: "confirm",
      reason: "Network sweep requires confirmation",
    };
  }

  if (call.name === "shell.start") {
    return {
      level: "confirm",
      reason: "Background job requires confirmation",
    };
  }

  if (
    call.name === "shell.jobs" ||
    call.name === "shell.tail" ||
    call.name === "shell.stop"
  ) {
    return { level: "safe", reason: "Read-only job management" };
  }

  if (call.name === "fs.edit") {
    const pathArg = stringArg(call.args, "path");
    if (pathArg) {
      try {
        if (isSecretPath(resolveForSecretCheck(pathArg))) {
          return {
            level: "block",
            reason: "Refusing to edit a known secret path",
          };
        }
      } catch {
        // fall through
      }
    }
    return {
      level: "confirm",
      reason: "File edit requires confirmation",
    };
  }

  if (call.name === "fs.delete") {
    const pathArg = stringArg(call.args, "path");
    if (pathArg) {
      try {
        if (isSecretPath(resolveForSecretCheck(pathArg))) {
          return {
            level: "block",
            reason: "Refusing to delete a known secret path",
          };
        }
      } catch {
        // fall through
      }
    }
    return {
      level: "confirm",
      reason: "File deletion requires manual confirmation (never auto-confirmed)",
    };
  }

  if (call.name === "web.search") {
    const query = stringArg(call.args, "query") ?? "";
    if (query.length === 0 || query.length > 2048) {
      return {
        level: "block",
        reason: "web.search query length out of bounds (must be 1..2048 chars)",
      };
    }
    return { level: "safe", reason: "Public search engine query" };
  }

  if (call.name === "web.fetch") {
    const url = stringArg(call.args, "url") ?? "";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        level: "block",
        reason: "web.fetch url is not parseable",
      };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        level: "block",
        reason: `web.fetch refuses scheme ${parsed.protocol}`,
      };
    }
    // Strip surrounding `[]` from IPv6 hostname literals before classifying.
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    const blocked = classifyHost(hostname);
    if (blocked) {
      return {
        level: "block",
        reason: `web.fetch refuses ${blocked.class} address ${parsed.hostname}`,
      };
    }
    return { level: "safe", reason: "Public web read" };
  }

  return { level: "confirm", reason: "Unknown tool requires confirmation" };
}
