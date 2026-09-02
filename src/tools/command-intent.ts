
const LONG_RUNNING_PATTERNS: RegExp[] = [
  /\bnc(?:at)?\b[^|&;\n]*\s-[a-z]*l/i,
  /\bsocat\b.*\bLISTEN\b/i,

  /\bpython3?\s+(-m\s+)?http\.server\b/i,
  /\bpython3?\s+(-m\s+)?SimpleHTTPServer\b/i,

  /\bnpm\s+run\s+dev\b/i,
  /\byarn\s+dev\b/i,
  /\bpnpm\s+dev\b/i,
  /\bbun\s+dev\b/i,
  /\bnpm\s+start\s*$/i,
  /\bnode\s+server\b/i,
  /\bnodemon\b/i,
  /^(?:(?:command|exec)\s+)?(?:(?:npx|bunx|pnpm\s+exec|yarn\s+exec|npm\s+exec)(?:\s+--yes)?\s+)?(?:\S*\/)?vite(?:@\S+)?(?:\s+(?!build\b|--help\b|--version\b).*)?$/i,
  /\bnext\s+dev\b/i,
  /\bnuxt\s+dev\b/i,

  /\btail\s+.*-[fF]\b/i,
  /\bjournalctl\s+.*-f\b/i,
  /\bwatch\s+/i,
  /\bcargo\s+watch\b/i,

  /\bdocker\s+logs\s+.*-f\b/i,
  /\bdocker\s+compose\s+up\b/i,
  /\bdocker-compose\s+up\b/i,

  /\buvicorn\b/i,
  /\bgunicorn\b/i,
  /\bflask\s+run\b/i,
  /\brails\s+(?:server|s)\b/i,
  /\bsinatra\b/i,

  /\bphp\s+-S\b/i,
  /\bnginx\s*$/i,
  /\bapache2?\s*$/i,

  /\bngrok\s+http\b/i,
  /\bssh\s+.*-[DLRN]\b/i,
  /\bchisel\s+(server|client)\b/i,

  /\btcpdump\b/i,
  /\bwireshark\b/i,
  /\btshark\b.*-i\b/i,

  /\bneo4j\s+console\b/i,
  /\bmongod\b/i,
  /\bredis-server\b/i,
  /\bmysqld\b/i,
  /\bpostgres\b/i,
  /\belasticsearch\b/i,
  /\bjava\s+-jar\b/i,
];

function backgroundsAProcess(command: string): boolean {
  return /(?:^|[^&\d>])\s&(?:\s|$)/.test(command);
}

const SCAFFOLD_FOREGROUND_PATTERNS: RegExp[] = [
  /\bnpm\s+create\b/i,
  /\bnpm\s+init\b/i,
  /\byarn\s+create\b/i,
  /\bpnpm\s+create\b/i,
  /\bbun\s+create\b/i,
  /\bnpx\s+(?:--yes\s+)?create-[\w-]+/i,
  /\bnpmx?\s+create-[\w-]+/i,
  /\bdeno\s+run\b.*\bcreate\b/i,
  /\bcargo\s+new\b/i,
  /\bcargo\s+init\b/i,
  /\bgo\s+mod\s+init\b/i,
  /\bpoetry\s+new\b/i,
  /\bdjango-admin\s+startproject\b/i,
  /\brails\s+new\b/i,
  /\bcomposer\s+create-project\b/i,
  /\bmix\s+new\b/i,
  /\bflutter\s+create\b/i,
  /\bdotnet\s+new\b/i,
];

export function looksLikeOneShotScaffolder(command: string): boolean {
  return SCAFFOLD_FOREGROUND_PATTERNS.some((p) => p.test(command));
}

const PACKAGE_OPERATIONS: Record<string, ReadonlySet<string>> = {
  npm: new Set(["i", "install", "add", "ci", "uninstall", "remove", "view", "info", "list", "ls", "pack", "publish", "audit", "outdated", "update"]),
  yarn: new Set(["add", "install", "remove", "info", "list", "pack", "publish", "audit", "outdated", "upgrade"]),
  pnpm: new Set(["add", "install", "i", "remove", "rm", "view", "info", "list", "ls", "pack", "publish", "audit", "outdated", "update"]),
  bun: new Set(["add", "install", "remove", "rm", "update", "outdated"]),
};

const OPTIONS_WITH_VALUE = new Set([
  "--workspace", "-w", "--prefix", "--cwd", "--config", "--userconfig",
  "--registry", "--cache", "--user", "-u", "--group", "-g",
]);

function baseCommand(token: string | undefined): string {
  return (token ?? "").replace(/^.*[\\/]/, "").toLowerCase();
}

function looksLikeForegroundPackageOperation(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (/^[A-Za-z_][\w]*=.*/.test(tokens[index] ?? "")) index += 1;

  if (baseCommand(tokens[index]) === "env") {
    index += 1;
    while (tokens[index]?.startsWith("-") || /^[A-Za-z_][\w]*=.*/.test(tokens[index] ?? "")) {
      const option = tokens[index++]!;
      if (OPTIONS_WITH_VALUE.has(option)) index += 1;
    }
  }
  if (baseCommand(tokens[index]) === "sudo") {
    index += 1;
    while (tokens[index]?.startsWith("-")) {
      const option = tokens[index++]!;
      if (OPTIONS_WITH_VALUE.has(option)) index += 1;
    }
  }
  if (baseCommand(tokens[index]) === "corepack") index += 1;

  const manager = baseCommand(tokens[index]);
  const operations = PACKAGE_OPERATIONS[manager];
  if (!operations) return false;
  index += 1;
  while (tokens[index]?.startsWith("-")) {
    const option = tokens[index++]!;
    const optionName = option.split("=", 1)[0]!;
    if (OPTIONS_WITH_VALUE.has(optionName) && !option.includes("=")) index += 1;
  }
  return operations.has((tokens[index] ?? "").toLowerCase());
}

function commandSegments(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||;|\n|\|)\s*/g)
    .map((segment) => segment.replace(/^\\\s*/, "").trim())
    .filter(Boolean);
}

export function looksLongRunning(command: string): boolean {
  if (backgroundsAProcess(command)) return true;

  return commandSegments(command).some((segment) => {
    if (looksLikeOneShotScaffolder(segment)) return false;
    if (looksLikeForegroundPackageOperation(segment)) return false;
    return LONG_RUNNING_PATTERNS.some((pattern) => pattern.test(segment));
  });
}

const LONG_FINITE_JOB_BINARIES: readonly RegExp[] = [
  /^(?:\S*\/)?(?:nmap|masscan)\b/i,
  /^(?:\S*\/)?(?:ffuf|feroxbuster|gobuster|dirsearch|wfuzz|nikto|nuclei|sqlmap)\b/i,
  /^(?:\S*\/)?find\s+/i,
];

function namesFiniteJobBinary(executable: string): boolean {
  return LONG_FINITE_JOB_BINARIES.some((pattern) => pattern.test(executable));
}

const ENV_OPTIONS_WITH_VALUE = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);
const SUDO_OPTIONS_WITH_VALUE = new Set(["-C", "--close-from", "-D", "--chdir", "-g", "--group", "-h", "--host", "-p", "--prompt", "-R", "--chroot", "-T", "--command-timeout", "-u", "--user"]);
const TIMEOUT_OPTIONS_WITH_VALUE = new Set(["-k", "--kill-after", "-s", "--signal"]);

function skipWrapperOptions(
  tokens: string[],
  index: number,
  optionsWithValue: ReadonlySet<string>,
): number {
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--") return index + 1;
    if (!token.startsWith("-") || token === "-") break;
    index += 1;
    const optionName = token.split("=", 1)[0]!;
    if (optionsWithValue.has(optionName) && !token.includes("=")) index += 1;
  }
  return index;
}

function unwrapFiniteCommand(segment: string): string {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  for (let pass = 0; pass < 12 && index < tokens.length; pass += 1) {
    while (/^[A-Za-z_][\w]*=.*/.test(tokens[index] ?? "")) index += 1;
    const wrapper = baseCommand(tokens[index]);
    if (wrapper === "env") {
      index = skipWrapperOptions(tokens, index + 1, ENV_OPTIONS_WITH_VALUE);
      continue;
    }
    if (wrapper === "sudo") {
      index = skipWrapperOptions(tokens, index + 1, SUDO_OPTIONS_WITH_VALUE);
      continue;
    }
    if (wrapper === "command" || wrapper === "exec") {
      index = skipWrapperOptions(tokens, index + 1, new Set());
      continue;
    }
    if (wrapper === "timeout" || wrapper === "gtimeout") {
      index = skipWrapperOptions(tokens, index + 1, TIMEOUT_OPTIONS_WITH_VALUE);
      if (index < tokens.length) index += 1;
      continue;
    }
    break;
  }
  return tokens.slice(index).join(" ");
}

export function looksLikeLongFiniteCommand(command: string): boolean {
  return Boolean(longFiniteCommandCost(command).reason);
}

export function longFiniteCommandCost(command: string): {
  reason: string | undefined;
} {
  for (const segment of commandSegments(command)) {
    const executable = unwrapFiniteCommand(segment);
    const tokens = executable.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const base = baseCommand(tokens[0]).toLowerCase();
    if (!namesFiniteJobBinary(executable)) continue;
    const args = tokens.slice(1);
    if (args.some((token) => /^(?:--version|-V|--help|-h|-hh)$/i.test(token))) {
      continue;
    }
    if (base === "nmap" || base === "masscan") {
      const reason = nmapCostReason(args);
      if (reason) return { reason };
      continue;
    }
    if (
      base === "ffuf" ||
      base === "feroxbuster" ||
      base === "gobuster" ||
      base === "dirsearch" ||
      base === "wfuzz" ||
      base === "nikto" ||
      base === "nuclei" ||
      base === "sqlmap"
    ) {
      const reason = webScannerCostReason(base, args);
      if (reason) return { reason };
      continue;
    }
    if (base === "find") {
      const reason = findCostReason(args);
      if (reason) return { reason };
      continue;
    }
  }
  return { reason: undefined };
}

export interface ShellExecBackgroundPolicy {
  readonly backgroundMode: "auto" | "never" | "always";
  readonly costReason: string | undefined;
  readonly persistent: boolean;
  readonly wantsBackground: boolean;
  readonly responder: boolean;
}

export function resolveShellExecBackgroundPolicy(input: {
  command: string;
  background?: unknown;
  responder?: unknown;
}): ShellExecBackgroundPolicy {
  const backgroundMode =
    input.background === "never" || input.background === "always"
      ? input.background
      : "auto";
  const responderPreference =
    typeof input.responder === "boolean" ? input.responder : undefined;
  const costReason = longFiniteCommandCost(input.command).reason;
  const persistent = looksLongRunning(input.command);
  const wantsBackground =
    backgroundMode === "always"
      ? true
      : backgroundMode === "never"
        ? false
        : persistent || responderPreference === true;
  const responder =
    wantsBackground &&
    !persistent &&
    responderPreference === true;
  return {
    backgroundMode,
    costReason,
    persistent,
    wantsBackground,
    responder,
  };
}

function portSpecIsBroad(spec: string): boolean {
  if (spec === "-" || spec.includes("-")) return true;
  const parts = spec.split(",").filter(Boolean);
  return parts.length > 32;
}

function nmapCostReason(args: string[]): string | undefined {
  let sawPortLimit = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (/^-(?:A|sV|sC|sU|sO)$/.test(token)) return `${token} scan is expensive`;
    if (token === "--script" || token.startsWith("--script=")) {
      return "NSE scripts are expensive";
    }
    if (token === "-p" || token === "--ports") {
      const spec = args[i + 1] ?? "";
      if (portSpecIsBroad(spec)) return `broad port spec ${spec}`;
      sawPortLimit = true;
      continue;
    }
    if (token.startsWith("-p")) {
      const spec = token.slice(2);
      if (spec === "" || portSpecIsBroad(spec)) return "broad port spec";
      sawPortLimit = true;
      continue;
    }
    if (token === "--top-ports") {
      const n = Number(args[i + 1]);
      if (!Number.isFinite(n) || n >= 100) return "top-ports sweep";
      sawPortLimit = true;
      continue;
    }
    if (!token.startsWith("-") && (token.includes("/") || /\d-\d/.test(token))) {
      return `multi-host target ${token}`;
    }
  }
  if (!sawPortLimit) return "default 1000-port scan";
  return undefined;
}

function webScannerCostReason(base: string, args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (/^(?:-w|--wordlist|--wordlists)$/i.test(token) || token.startsWith("-w=")) {
      return "wordlist-driven fuzzing";
    }
    if (/^(?:-u|--url|-r|--request)$/i.test(token) && base === "sqlmap") {
      return "sqlmap against a live target";
    }
    if (/FUZZ/.test(token)) return "fuzz placeholder";
  }
  if (base === "nikto" || base === "nuclei" || base === "dirsearch") {
    return args.some((token) => !token.startsWith("-"))
      ? `${base} against a target`
      : undefined;
  }
  return undefined;
}

const EXPENSIVE_FIND_ROOTS = /^(?:\/|~\/?|\/Users\/?$|\/home\/?$|\/var\b|\/usr\b|\/opt\b|\/etc\b|[A-Za-z]:[\\/])/;

function findCostReason(args: string[]): string | undefined {
  for (const token of args) {
    if (/^-(?:exec|execdir|ok|okdir)$/.test(token)) {
      return "find -exec runs a command per match";
    }
  }
  const start = args.find((token) => !token.startsWith("-"));
  if (start && EXPENSIVE_FIND_ROOTS.test(start)) {
    return `filesystem-wide search from ${start}`;
  }
  return undefined;
}
