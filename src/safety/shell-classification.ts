import type { SessionInput, SessionTransportKind } from "../interactive-session/types.js";
import type { EngagementScope } from "../store/scope.js";
import type { RiskLevel } from "../types.js";
import { commandHasMutatingArg, commandHasStatefulSysadminArg, commandIsMutating, commandIsScannerOnly, commandWritesOrEscalates, destructiveCommandPatterns, exfiltrationPatterns, isApprovedScannerSegment, isVersionOrHelpProbe, readOnlyShellCommands, splitCommandSegments, subcommandSafeMap } from "./patterns.js";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface RiskDecision {
  level: RiskLevel;
  reason: string;
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
