import net from "node:net";
import { execSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { resolve } from "node:path";
import type { RiskLevel, ToolCall } from "../types.js";
import {
  destructiveCommandPatterns,
  exfiltrationPatterns,
  isSecretPath,
  isVersionOrHelpProbe,
  networkScanTools,
  readOnlyShellCommands,
  subcommandSafeMap,
  commandHasMutatingArg,
  commandIsMutating,
  commandWritesOrEscalates,
} from "./patterns.js";
import { normalizeScopeTarget, type EngagementScope } from "../store/scope.js";
import { classifyHost } from "../tools/web/ssrf-guard.js";
import { pathInsideSandbox } from "../tools/fs.js";
import { packageBinaryName } from "../tools/package-binary.js";

/**
 * Sync PATH probe so the classifier can tell whether pkg.install is about to
 * be a real install or the no-op "already on PATH — skipping" branch it runs
 * itself. Mirrors the same `command -v` / `where.exe` pattern already used by
 * net-ping-sweep's own sync availability check.
 */
function isBinaryOnPath(binary: string): boolean {
  try {
    const probe =
      platform() === "win32" ? `where.exe ${binary}` : `command -v ${binary}`;
    execSync(probe, { timeout: 3_000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

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

const PRIVATE_TLD_RE =
  /\.(?:local|internal|lan|home|corp|intranet|test|localdomain)$/i;
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
  "txt",
  "log",
  "json",
  "yaml",
  "yml",
  "md",
  "html",
  "htm",
  "xml",
  "csv",
  "sh",
  "py",
  "rb",
  "rs",
  "go",
  "js",
  "ts",
  "tsx",
  "jsx",
  "css",
  "scss",
  "tar",
  "gz",
  "zip",
  "tgz",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "exe",
  "dll",
  "so",
  "dylib",
  "ini",
  "conf",
  "lock",
  "toml",
  "env",
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
  // Match tilde paths, absolute paths, and dotted relative paths. URL paths
  // are intentionally stripped first: this check protects LOCAL secrets
  // (~/.ssh, ~/.clai/keys.json, project .env). A remote URL like
  // https://example.com/.env must not be resolved as if it were a local
  // filesystem path (that false-positive blocked normal pentest verification
  // probes against scoped external targets).
  const withoutUrls = command.replace(/\bhttps?:\/\/[^\s'"`<>]+/gi, " ");
  const matches = withoutUrls.match(/(?:~|\.{1,2}|\/)?[\w./~-]+/g) ?? [];
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

// Absolute roots whose contents are part of the OS / shared system. A
// redirect that writes into one of these is worth a confirmation; a redirect
// into the project dir, a relative path, or a temp dir is ordinary output
// capture. Paths are normalized to forward slashes before matching so the
// same patterns work on macOS, Linux, and Windows.
const SENSITIVE_WRITE_ROOTS_UNIX =
  /^\/(?:etc|usr|bin|sbin|var|lib|lib64|boot|dev|sys|proc|root|opt|System|Library|Applications)(?:\/|$)/i;
// Windows system locations: <drive>:/Windows, /Program Files, /ProgramData.
const SENSITIVE_WRITE_ROOTS_WIN =
  /^[A-Za-z]:\/(?:Windows|Program Files(?: \(x86\))?|ProgramData)(?:\/|$)/i;

/**
 * Inspect the redirection targets in a command and report whether any writes
 * into a sensitive system directory or a home dotfile. Discards / fd-dups are
 * already stripped by {@link commandWritesOrEscalates}; here we just look at
 * the resolved target paths so ordinary `> out.json` style captures stay
 * frictionless while `> /etc/hosts`, `> C:\Windows\...`, or `> ~/.bashrc`
 * ask first. Works across macOS, Linux, and Windows.
 */
function redirectTargetIsSensitive(command: string): boolean {
  const withoutDup = command.replace(/\d*>&\d+|&>&\d+/g, " ");
  const re = /(?:&?>>?)\s*('[^']*'|"[^"]*"|[^\s;|&<>()]+)/g;
  let match: RegExpExecArray | null;
  const home = homedir().replace(/\\/g, "/").replace(/\/+$/, "");
  while ((match = re.exec(withoutDup)) !== null) {
    const raw = (match[1] ?? "").replace(/^['"]|['"]$/g, "");
    if (!raw) continue;
    // Unix discards / device sinks are never real writes.
    if (/^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(raw)) continue;
    // Windows null/console sinks (NUL, CON, $null) are not real writes either.
    if (/^(?:nul|con|\$null)$/i.test(raw)) continue;
    // Normalize backslashes so Windows paths match the same way isSecretPath
    // normalizes (the classifier already treats both styles uniformly).
    const resolved = resolveForSecretCheck(raw).replace(/\\/g, "/");
    if (
      SENSITIVE_WRITE_ROOTS_UNIX.test(resolved) ||
      SENSITIVE_WRITE_ROOTS_WIN.test(resolved)
    ) {
      return true;
    }
    // Home dotfiles (~/.bashrc, ~/.zshrc, ~/.config/..., ~/.ssh/...) are
    // sensitive. Path comparison is case-insensitive so Windows (where the
    // filesystem and drive letter case do not matter) is handled too.
    if (home && resolved.toLowerCase().startsWith(home.toLowerCase())) {
      const rest = resolved.slice(home.length);
      if (/^\/+\.[^/]/.test(rest)) return true;
    }
  }
  return false;
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
    if (
      !commandContainsNetworkScanner(command) ||
      !containsPublicTarget(command)
    ) {
      return undefined;
    }
    const target = extractScanTarget(command);
    return target && isPublicTarget(target)
      ? normalizeScopeTarget(target)
      : undefined;
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

/**
 * Classify a raw shell command line into safe / confirm / block. Shared by
 * shell.exec and shell.start so starting a service/server is as frictionless
 * as running it inline, while genuinely mutating/destructive commands still
 * gate behind a confirmation.
 */
export function classifyShellCommand(
  command: string,
  options: ClassifyOptions = {},
): RiskDecision {
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
  // A bare version/help probe (node --version, npm -v, go version, docker
  // --help, even nmap --version) is read-only — auto-run it.
  if (isVersionOrHelpProbe(command)) {
    return { level: "safe", reason: "Version/help probe is read-only" };
  }
  // Scanner/recon commands are read-only from the local filesystem point of
  // view. They may touch the network, but they should not trigger the generic
  // y/n prompt; engagement authorization is handled as session policy instead.
  if (commandContainsNetworkScanner(command)) {
    return { level: "safe", reason: "Read-only network/security command" };
  }
  // Run mutation checks BEFORE the read-only base check: sed/find are
  // read-only bases yet `sed -i` / `find -exec` mutate, and a pipe can hide a
  // writer like `ls | tee file`.
  const { base, sub } = baseAndSub(command);
  const readOnlyBase = isReadOnlyBase(base);
  const safeSub = isSafeSubcommand(base, sub);

  // Confirm for in-place / state-mutating ARGUMENTS.
  if (commandHasMutatingArg(command)) {
    return {
      level: "confirm",
      reason:
        "Command argument mutates state or escapes into another shell (sed -i, awk system(), find -exec/-delete, git config --global, npm config set, docker/kubectl mutators)",
    };
  }
  // A plain output redirection (`curl ... > out.json`, `python x.py > log`)
  // is benign output capture — the same kind of write fs.write does without a
  // prompt — so it auto-runs. We only confirm when the redirect target is a
  // SENSITIVE location (a system directory or a home dotfile), where an
  // accidental clobber would be hard to undo. Discards (2>/dev/null) and
  // fd-dups (2>&1) were already excluded by commandWritesOrEscalates.
  if (commandWritesOrEscalates(command) && redirectTargetIsSensitive(command)) {
    return {
      level: "confirm",
      reason: "Command redirects output into a system or sensitive path",
    };
  }
  // Confirm for a base whose job is to install / delete / modify / move / copy
  // (mv, cp, rm, chmod, package managers, build tools …; sees through sudo).
  if (commandIsMutating(command)) {
    return {
      level: "confirm",
      reason:
        "Command installs, deletes, moves, copies, or otherwise modifies state and requires confirmation",
    };
  }
  if (readOnlyBase) {
    return { level: "safe", reason: "Read-only command" };
  }
  if (safeSub) {
    return { level: "safe", reason: `Read-only ${base} subcommand` };
  }
  // Benign read/inspect/run/service-start command — auto-runs. Destructive,
  // secret-touching, and exfiltration cases were blocked above; mutating
  // cases were confirmed.
  return { level: "safe", reason: "Non-mutating command" };
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
    return {
      level: "safe",
      reason: "Passive lookup against public registries",
    };
  }

  if (call.name === "tool.batch") {
    // The batch handler enforces a hard allowlist of read-only tools and a
    // capped concurrency. Treat it as safe so batched recon can run without
    // a per-call confirmation. If the caller smuggles in a non-safe tool,
    // the handler rejects it.
    return { level: "safe", reason: "Read-only batch dispatch" };
  }

  if (call.name === "http.fetch") {
    return {
      level: "safe",
      reason:
        "HTTP fetch is a network request, not a local filesystem mutation",
    };
  }

  if (call.name === "shell.exec") {
    const command = stringArg(call.args, "command") ?? "";
    return classifyShellCommand(command, options);
  }

  if (call.name === "net.scan") {
    return { level: "safe", reason: "Read-only network scan" };
  }

  if (call.name === "pentest.recon") {
    return { level: "safe", reason: "Read-only pentest recon" };
  }

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
    return {
      level: "confirm",
      reason: "Mutating operation requires confirmation",
    };
  }

  if (call.name === "pkg.install") {
    // pkg.install already no-ops when the binary is on PATH — checking
    // "is X installed" this way is a read, not a mutation. Probe the same
    // way the tool itself will, so that check-then-skip never prompts; only
    // an actual install (binary genuinely missing) requires confirmation.
    const tool = stringArg(call.args, "tool");
    const checkBinary = stringArg(call.args, "checkBinary");
    if (tool) {
      const binary = checkBinary ?? packageBinaryName(tool);
      if (isBinaryOnPath(binary)) {
        return {
          level: "safe",
          reason: `${binary} is already installed — pkg.install will no-op`,
        };
      }
    }
    return {
      level: "confirm",
      reason: "Package install requires confirmation",
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

  // New tools

  if (call.name === "net.context") {
    return { level: "safe", reason: "Read-only local network info" };
  }

  if (call.name === "tool.check") {
    return { level: "safe", reason: "Read-only tool availability check" };
  }

  if (call.name === "wordlist.find") {
    return { level: "safe", reason: "Read-only local wordlist lookup" };
  }

  if (call.name === "image.ocr") {
    const pathArg = stringArg(call.args, "path");
    if (pathArg) {
      try {
        if (isSecretPath(resolveForSecretCheck(pathArg))) {
          return {
            level: "block",
            reason:
              "Path is a known secret location and cannot be OCR-read by the agent",
          };
        }
      } catch {
        // resolve failed — let the tool return a normal file error
      }
    }
    return { level: "safe", reason: "Read-only local image OCR" };
  }

  if (call.name === "pdf.read") {
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
        // resolve failed — let the tool return a normal file error
      }
    }
    return {
      level: "safe",
      reason: "Read-only local PDF text extraction (with OCR fallback)",
    };
  }

  if (call.name === "net.pingSweep") {
    return {
      level: "safe",
      reason: "Read-only local network sweep",
    };
  }

  if (call.name === "shell.start") {
    // Starting a background program/service should be as frictionless as
    // running it inline — classify by the command itself (a destructive or
    // mutating background command still confirms).
    const command = stringArg(call.args, "command") ?? "";
    return classifyShellCommand(command, options);
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
      reason:
        "File deletion requires manual confirmation (never auto-confirmed)",
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
