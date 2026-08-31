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

const SENSITIVE_WRITE_ROOTS_UNIX =
  /^\/(?:etc|usr|bin|sbin|var|lib|lib64|boot|dev|sys|proc|root|opt|System|Library|Applications)(?:\/|$)/i;

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
  return allow.has(sub) || allow.has(sub.replace(/^--/, ""));
}

export interface ClassifyOptions {
  scope?: EngagementScope | undefined;
}

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
  if (isVersionOrHelpProbe(command)) {
    return { level: "safe", reason: "Version/help probe is read-only" };
  }
  const { base, sub } = baseAndSub(command);
  const readOnlyBase = isReadOnlyBase(base);
  const safeSub = isSafeSubcommand(base, sub);

  if (commandHasMutatingArg(command)) {
    return {
      level: "confirm",
      reason:
        "Command argument mutates state or escapes into another shell (sed -i, awk system(), find -exec/-delete, git config --global, npm config set, docker/kubectl mutators)",
    };
  }
  if (commandWritesOrEscalates(command) && redirectTargetIsSensitive(command)) {
    return {
      level: "confirm",
      reason: "Command redirects output into a system or sensitive path",
    };
  }
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
