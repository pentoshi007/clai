import net from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { RiskLevel, ToolCall } from "../types.js";
import type {
  SessionInput,
  SessionTransportKind,
} from "../interactive-session/types.js";
import {
  destructiveCommandPatterns,
  exfiltrationPatterns,
  isVersionOrHelpProbe,
  networkScanTools,
  readOnlyShellCommands,
  subcommandSafeMap,
  commandHasMutatingArg,
  commandHasStatefulSysadminArg,
  commandIsMutating,
  commandIsScannerOnly,
  commandWritesOrEscalates,
  splitCommandSegments,
  isApprovedScannerSegment,
} from "./patterns.js";
import { normalizeScopeTarget, type EngagementScope } from "../store/scope.js";
import { classifyHost } from "../tools/web/ssrf-guard.js";
import { pathInsideSandbox } from "../tools/fs.js";
import { packageBinaryName } from "../tools/package-binary.js";
import { findExecutableSync } from "../os/command.js";

/**
 * Plain executable name: letters, digits and the punctuation real binaries
 * use. Anything with a path separator, whitespace, or a shell metacharacter
 * is rejected outright — classification must never interpret model text.
 */
const PLAIN_BINARY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/**
 * Side-effect-free PATH probe. No shell, no child process: `findExecutableSync`
 * only stats candidate paths, so a model-supplied `checkBinary` can never be
 * interpreted as a command during safety classification.
 */
function isBinaryOnPath(binary: string): boolean {
  if (!PLAIN_BINARY_NAME_RE.test(binary)) return false;
  return Boolean(findExecutableSync(binary));
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
  /(?:^|[\s'"=(,])((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63})\b/g;

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
  if (call.name === "net.scan" || call.name.startsWith("pentest.")) return true;
  if (call.name === "http.fetch") {
    const method = (stringArg(call.args, "method") ?? "GET").toUpperCase();
    return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  }
  if (
    call.name !== "shell.exec" &&
    call.name !== "shell.start" &&
    call.name !== "terminal.start" &&
    call.name !== "terminal.send"
  ) {
    return false;
  }
  const command =
    call.name === "terminal.send"
      ? stringArg(call.args, "text") ?? ""
      : stringArg(call.args, "command") ?? "";
  return (
    commandContainsNetworkScanner(command) ||
    (call.name === "terminal.send" && containsPublicTarget(command))
  );
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

function pathIsSensitiveWriteTarget(raw: string): boolean {
  if (!raw) return false;
  if (/^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(raw)) return false;
  if (/^(?:nul|con|\$null|-)$/i.test(raw)) return false;
  const resolved = resolveForSecretCheck(raw).replace(/\\/g, "/");
  if (
    SENSITIVE_WRITE_ROOTS_UNIX.test(resolved) ||
    SENSITIVE_WRITE_ROOTS_WIN.test(resolved)
  ) {
    return true;
  }
  const home = homedir().replace(/\\/g, "/").replace(/\/+$/, "");
  if (home && resolved.toLowerCase().startsWith(home.toLowerCase())) {
    const rest = resolved.slice(home.length);
    if (/^\/+\.[^/]/.test(rest)) return true;
  }
  return false;
}

/**
 * Flags used by the approved scanners to write results to a file. A scanner is
 * only "read-only" with respect to the local filesystem when its output flags
 * do not point at a sensitive location, so these are inspected explicitly
 * instead of being covered by shell-redirect parsing.
 */
const SCANNER_OUTPUT_FLAG_RE =
  /^(?:-o[ANXGSJ]?|-oJ|--output|--output-file|--out|-of|--report|--json-export|--csv-export|--markdown-export|--sarif-export|--log|--save|--report-file)$/i;

function scannerWritesSensitiveFile(command: string): boolean {
  for (const segment of splitCommandSegments(command)) {
    if (!isApprovedScannerSegment(segment)) continue;
    const tokens = segment.tokens;
    for (let i = 1; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      const eq = token.indexOf("=");
      if (eq > 0) {
        const name = token.slice(0, eq);
        if (SCANNER_OUTPUT_FLAG_RE.test(name)) {
          const value = token.slice(eq + 1).replace(/^['"]|['"]$/g, "");
          if (pathIsSensitiveWriteTarget(value)) return true;
        }
        continue;
      }
      if (!SCANNER_OUTPUT_FLAG_RE.test(token)) continue;
      const value = (tokens[i + 1] ?? "").replace(/^['"]|['"]$/g, "");
      if (!value || value.startsWith("-")) continue;
      if (pathIsSensitiveWriteTarget(value)) return true;
    }
  }
  return false;
}

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
  while ((match = re.exec(withoutDup)) !== null) {
    const raw = (match[1] ?? "").replace(/^['"]|['"]$/g, "");
    if (pathIsSensitiveWriteTarget(raw)) return true;
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
function extractScanTarget(
  command: string,
  includeFirstToken = false,
): string | undefined {
  const urlMatch = /\bhttps?:\/\/([^\/\s:?#]+)/i.exec(command);
  if (urlMatch?.[1]) {
    return urlMatch[1].replace(/[\[\]]/g, "").split(":")[0];
  }
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const args = tokens
    .slice(includeFirstToken ? 0 : 1)
    .filter((token) => !token.startsWith("-"));
  for (let i = args.length - 1; i >= 0; i -= 1) {
    const arg = args[i]!;
    const hostPort = /^([^\[\]:]+|\[[^\]]+\]):\d{1,5}$/.exec(arg);
    const candidate = hostPort?.[1]?.replace(/^\[|\]$/g, "") ?? arg;
    if (
      /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(candidate) ||
      net.isIP(candidate) ||
      /^[0-9./]+$/.test(candidate)
    ) {
      return candidate;
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
  if (call.name === "http.fetch") {
    const raw = stringArg(call.args, "url") ?? "";
    try {
      const target = new URL(raw).hostname;
      return target && isPublicTarget(target) ? normalizeScopeTarget(target) : undefined;
    } catch {
      return undefined;
    }
  }

  if (
    call.name === "shell.exec" ||
    call.name === "shell.start" ||
    call.name === "terminal.start" ||
    call.name === "terminal.send"
  ) {
    const command =
      call.name === "terminal.send"
        ? stringArg(call.args, "text") ?? ""
        : stringArg(call.args, "command") ?? "";
    const targetsInteractiveHost = call.name === "terminal.send";
    if (
      (!commandContainsNetworkScanner(command) && !targetsInteractiveHost) ||
      !containsPublicTarget(command)
    ) {
      return undefined;
    }
    const target = extractScanTarget(command, call.name === "terminal.send");
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
      level: "confirm",
      reason:
        "Command pipes remote content into a shell or sends local data to a network sink — confirm that this is intended and authorized",
    };
  }
  // A bare version/help probe (node --version, npm -v, go version, docker
  // --help, even nmap --version) is read-only — auto-run it.
  if (isVersionOrHelpProbe(command)) {
    return { level: "safe", reason: "Version/help probe is read-only" };
  }
  // Mutation checks run BEFORE any exemption (including the scanner
  // exemption) so risk is monotonic: adding a scanner name, another segment,
  // or a redirect can never lower a command's risk level.
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
  if (commandHasStatefulSysadminArg(command)) {
    return {
      level: "confirm",
      reason:
        "Command changes host network configuration (ip/nmcli/route/arp mutation) and requires confirmation",
    };
  }
  // Scanner/recon commands are read-only from the local filesystem point of
  // view. They may touch the network, but they should not trigger the generic
  // y/n prompt; engagement authorization is handled as session policy instead.
  // The exemption only applies when EVERY executable segment is a scanner or
  // an already-read-only command, so a scanner word cannot whitelist a
  // compound mutating command.
  if (commandIsScannerOnly(command)) {
    if (scannerWritesSensitiveFile(command)) {
      return {
        level: "confirm",
        reason: "Scanner writes its output into a system or sensitive path",
      };
    }
    return { level: "safe", reason: "Read-only network/security command" };
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

export interface InteractiveInputPolicyContext {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly transport: SessionTransportKind;
  readonly input: SessionInput;
  readonly scope?: EngagementScope | undefined;
}

const RECOGNIZED_INTERACTIVE_ANSWER =
  /^(y|n|yes|no|q|quit|exit|:q|:q!|help|\?|\d+(\.\d+)?|true|false|none|null)$/i;
const DESTRUCTIVE_INTERACTIVE_INPUT = [
  /\bshutil\s*\.\s*rmtree\b/i,
  /\bos\s*\.\s*(remove|unlink|rmdir)\b/i,
  /\bfs\s*\.\s*(unlink|rm|rmdir)Sync?\b/i,
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bDELETE\s+FROM\b(?![\s\S]*\bWHERE\b)/i,
  /\bRemove-Item\b[\s\S]*-Recurse/i,
] as const;
const MUTATING_INTERACTIVE_INPUT = [
  /\bos\s*\.\s*system\b/i,
  /\bsubprocess\s*\.\s*(run|call|Popen|check_output)\b/i,
  /\bchild_process\b/i,
  /\brequire\s*\(\s*['"]fs['"]\s*\)/i,
  /\b(eval|exec)\s*\(/i,
  /\bopen\s*\([^)]*['"][wa]\+?['"]/i,
  /\bInvoke-(Expression|WebRequest|RestMethod)\b/i,
  /\b(UPDATE|INSERT\s+INTO|ALTER\s+TABLE|GRANT|REVOKE)\b/i,
  /\bpip\s+install\b|\bnpm\s+(install|i)\b/i,
] as const;
const EXFILTRATING_INTERACTIVE_INPUT = [
  /\b(curl|wget)\b[\s\S]*\|\s*(sh|bash|zsh|python)/i,
  /\bbase64\b[\s\S]*\|\s*(curl|wget|nc)\b/i,
] as const;

export function classifyInteractiveInput(
  context: InteractiveInputPolicyContext,
): RiskDecision {
  const { input } = context;
  if (input.kind === "eof") {
    return { level: "safe", reason: "Closing session input has no command effect" };
  }
  if (input.kind === "control") {
    return { level: "safe", reason: "Terminal control input" };
  }
  if (input.kind === "secret") {
    return { level: "safe", reason: "Secret terminal input" };
  }
  const text = input.text;
  if (text.trim().length === 0) {
    return { level: "safe", reason: "Whitespace-only input has no command effect" };
  }
  if (EXFILTRATING_INTERACTIVE_INPUT.some((pattern) => pattern.test(text))) {
    return {
      level: "block",
      reason: "Input pipes remote content into an interpreter or exports local data",
    };
  }
  if (DESTRUCTIVE_INTERACTIVE_INPUT.some((pattern) => pattern.test(text))) {
    return { level: "block", reason: "Input matches a destructive REPL pattern" };
  }
  const shellDecision = classifyShellCommand(
    text,
    context.scope ? { scope: context.scope } : {},
  );
  if (shellDecision.level !== "safe") return shellDecision;
  if (MUTATING_INTERACTIVE_INPUT.some((pattern) => pattern.test(text))) {
    return { level: "confirm", reason: "Input mutates state through an interpreter" };
  }
  if (RECOGNIZED_INTERACTIVE_ANSWER.test(text.trim())) {
    return { level: "safe", reason: "Recognized prompt answer" };
  }
  return { level: "safe", reason: "Non-mutating interactive input" };
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
    // Inspect children: all-safe batches stay auto-run; any confirm-level
    // child elevates the whole batch so shell/fs mutates cannot hide behind
    // a "safe batch" label. Block-level children block the batch. Nested
    // tool.batch / plan tools are rejected in the handler.
    const rawCalls = call.args?.calls;
    if (!Array.isArray(rawCalls) || rawCalls.length === 0) {
      return { level: "safe", reason: "Empty or invalid batch (handler will reject)" };
    }
    let elevates = false;
    for (const entry of rawCalls) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const childName =
        typeof (entry as { name?: unknown }).name === "string"
          ? String((entry as { name: string }).name).trim()
          : "";
      if (!childName) continue;
      // Wire form (tool_check) → canonical (tool.check) for classification.
      const dotted = childName.includes(".")
        ? childName
        : childName.includes("_")
          ? childName.replace(/_/g, ".")
          : childName;
      // Nested batches would recurse forever and are forbidden in the handler.
      if (dotted === "tool.batch") {
        return {
          level: "block",
          reason: "Nested tool.batch is not allowed",
        };
      }
      const childArgs =
        typeof (entry as { args?: unknown }).args === "object" &&
        (entry as { args?: unknown }).args !== null &&
        !Array.isArray((entry as { args?: unknown }).args)
          ? ((entry as { args: Record<string, unknown> }).args)
          : {};
      const child = classifyToolCall(
        { name: dotted, args: childArgs },
        options,
      );
      if (child.level === "block") {
        return {
          level: "block",
          reason: `Batch child ${dotted}: ${child.reason}`,
        };
      }
      if (child.level === "confirm") elevates = true;
    }
    if (elevates) {
      return {
        level: "confirm",
        reason: "Batch includes tools that require confirmation",
      };
    }
    return { level: "safe", reason: "Batch of read-only / auto-safe tools" };
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

  if (call.name === "terminal.start") {
    const command = stringArg(call.args, "command") ?? "";
    return classifyShellCommand(command, options);
  }

  if (call.name === "terminal.send") {
    const kind = stringArg(call.args, "kind");
    if (kind === "text") {
      return classifyInteractiveInput({
        ownerId: "tool",
        sessionId: stringArg(call.args, "id") ?? "unknown",
        transport: "pipe",
        input: {
          kind: "text",
          text: stringArg(call.args, "text") ?? "",
          submit: call.args.submit === "none" ? "none" : "enter",
        },
        ...(options.scope ? { scope: options.scope } : {}),
      });
    }
    return { level: "safe", reason: "Terminal control input" };
  }

  if (
    call.name === "terminal.read" ||
    call.name === "terminal.status" ||
    call.name === "terminal.list" ||
    call.name === "terminal.resize" ||
    call.name === "terminal.close"
  ) {
    return { level: "safe", reason: "Interactive session management" };
  }

  if (call.name === "net.scan") {
    return { level: "safe", reason: "Read-only network scan" };
  }

  if (call.name === "pentest.recon") {
    return { level: "safe", reason: "Read-only pentest recon" };
  }

  if (call.name === "fs.write") {
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
    return { level: "safe", reason: "Read-only local image OCR" };
  }

  if (call.name === "image.view") {
    return { level: "safe", reason: "Read-only local image read" };
  }

  if (call.name === "pdf.read") {
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
    call.name === "shell.wait" ||
    call.name === "shell.stop"
  ) {
    return { level: "safe", reason: "Read-only job management" };
  }

  if (
    call.name === "fs.edit" ||
    call.name === "fs.replaceLines" ||
    call.name === "fs.append"
  ) {
    return {
      level: "confirm",
      reason: "File edit requires confirmation",
    };
  }

  if (call.name === "fs.delete") {
    return {
      level: "confirm",
      reason:
        "File deletion requires manual confirmation (never auto-confirmed, even under allow-all)",
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
