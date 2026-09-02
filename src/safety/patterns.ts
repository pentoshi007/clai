export const destructiveCommandPatterns = [
  /\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*r[a-zA-Z]*\s+(?:["']?)(?:\/|\/\*|~\/?|\$HOME\/?|\/(?:etc|usr|bin|sbin|var|lib|lib64|boot|dev|sys|proc|root|opt|private|home|System|Library|Applications|Users)(?:\/\*?)?)(?:["'\s;|&]|$)/i,
  /\bdel\s+\/f\s+\/s\s+\/q\s+[A-Z]:\\/i,
  /\bformat\s+[A-Z]:/i,
  /\bdd\s+if=.*\s+of=\/dev\//,
  />>?\s*\/dev\/(?:[sh]d[a-z]\d*|nvme\d+n\d+(?:p\d+)?|disk\d+|mmcblk\d+)\b/i,
  /mkfs\.[a-z0-9]+\s+\/dev\//i,
  /\b(?:chmod|chown|chgrp)\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*R[a-zA-Z]*\s+\S+\s+\/(?:\s|$)/,
  /\bchmod\s+(?:-[a-zA-Z]*\s+)*777\s+\/(?:\s|$)/,
  /\bfind\s+\/\s+[^|;&]*-(?:delete|exec\s+rm)\b/i,
  /\btruncate\s+(?:-[a-zA-Z]*\s+)*-s\s*0\s+\/(?:etc|boot|var\/lib)\//i,
  /:\(\)\s*\{\s*:\|:\s*&\s*}\s*;/,
  /\bshutdown\b.*\b(now|\/s|\/r)\b/i,
];

export const exfiltrationPatterns = [
  /curl\s+.*\|\s*sh/i,
  /wget\s+.*\|\s*sh/i,
  /tar\s+.*\|\s*(curl|nc|netcat)/i,
  /curl\s+.*-d\s+@\/(etc\/passwd|etc\/shadow)/i,
  /base64\s+.*\|\s*(curl|wget|nc)/i,
];

export const networkScanTools = ['nmap', 'masscan', 'nikto', 'sqlmap', 'gobuster', 'ffuf', 'hydra', 'dirb', 'wfuzz', 'nuclei'];

const networkScanToolSet = new Set(networkScanTools);

export interface CommandSegment {
  raw: string;
  tokens: string[];
  base: string;
  sub: string | undefined;
  elevated: boolean;
}

const SEGMENT_SPLIT_RE = /(?:\|\||&&|;|\||\n)/g;

export function splitCommandSegments(command: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  for (const raw of command.split(SEGMENT_SPLIT_RE)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    let i = 0;
    let elevated = false;
    while (i < tokens.length && /^[A-Za-z_][\w]*=.*$/.test(tokens[i]!)) i += 1;
    while (
      i < tokens.length &&
      (tokens[i] === "command" || tokens[i] === "exec" || tokens[i] === "time")
    ) {
      i += 1;
    }
    if (i < tokens.length && (tokens[i] === "sudo" || tokens[i] === "doas")) {
      elevated = true;
      i += 1;
      while (i < tokens.length && tokens[i]!.startsWith("-")) {
        const flag = tokens[i]!;
        i += 1;
        if (/^-(?:u|g|p|C|h|U|r|t|T)$/.test(flag) && i < tokens.length) i += 1;
      }
    }
    const head = tokens[i];
    if (!head) continue;
    segments.push({
      raw: trimmed,
      tokens: tokens.slice(i),
      base: head.replace(/^.*[\\/]/, "").toLowerCase(),
      sub: tokens[i + 1],
      elevated,
    });
  }
  return segments;
}

export function isApprovedScannerSegment(segment: CommandSegment): boolean {
  return networkScanToolSet.has(segment.base);
}

export const readOnlyShellCommands = new Set([
  'whoami', 'hostname', 'uname', 'uptime', 'date', 'id', 'arch', 'sw_vers',
  'lsb_release', 'hostnamectl', 'locale', 'ulimit',
  'pwd', 'cd', 'test', 'true', 'false', 'basename', 'dirname',
  'ls', 'dir', 'wc', 'file', 'stat',
  'find', 'which', 'where', 'whereis', 'type', 'readlink', 'realpath',
  'tree', 'du', 'df', 'lsof', 'md5', 'md5sum', 'sha256sum', 'shasum',
  'ifconfig', 'ipconfig', 'ping', 'traceroute', 'tracert', 'dig',
  'nslookup', 'host', 'whois', 'netstat', 'ss',
  'iwconfig',
  'ps', 'top', 'htop', 'pgrep', 'lscpu', 'free', 'vmstat', 'iostat',
  'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'awk', 'sed',
  'sort', 'uniq', 'cut', 'tr', 'diff', 'comm', 'jq',
  'whatweb', 'wpscan',
  'sublist3r', 'amass', 'subfinder', 'httpx',
]);

export const subcommandSafeMap: Record<string, Set<string>> = {
  git: new Set([
    'status', 'log', 'diff', 'show', 'branch', 'tag',
    'remote', 'rev-parse', 'describe', 'blame',
    'shortlog', 'reflog', 'stash', 'ls-files', 'ls-tree',
  ]),
  npm: new Set([
    'view', 'list', 'ls', 'outdated', 'audit', 'info',
    'search', 'whoami', 'help', 'ping',
  ]),
  pnpm: new Set([
    'list', 'ls', 'outdated', 'why', 'view', 'info', 'help',
  ]),
  yarn: new Set([
    'list', 'why', 'outdated', 'info', 'help',
  ]),
  pip: new Set(['show', 'list', 'freeze', 'check', 'help']),
  pip3: new Set(['show', 'list', 'freeze', 'check', 'help']),
  brew: new Set(['list', 'info', 'search', 'outdated', 'help', 'doctor', 'deps', 'services']),
  apt: new Set(['list', 'search', 'show', 'help']),
  dpkg: new Set(['-l', '-s', '-L', '--list', '--status', '--listfiles']),
  rpm: new Set(['-q', '-qa', '-qi', '-ql', '--query']),
  docker: new Set(['ps', 'images', 'inspect', 'logs', 'version', 'info', 'history']),
  kubectl: new Set(['get', 'describe', 'logs', 'version', 'cluster-info', 'api-resources', 'api-versions']),
  ip: new Set(['show', 'list', 'sh', 'l', 'monitor', 'help']),
  nmcli: new Set(['show', 'list', 'status', 'help']),
  route: new Set(['show', 'list', 'get', 'print', '-n']),
  arp: new Set(['-a', '-n', '-e', '-v', 'show', 'list']),
};

const NETWORK_OBJECT_WORDS: Record<string, Set<string>> = {
  ip: new Set([
    'addr', 'a', 'address', 'link', 'l', 'route', 'r', 'neigh', 'n',
    'neighbour', 'neighbor', 'rule', 'maddr', 'tunnel', 'netns', 'monitor',
  ]),
  nmcli: new Set([
    'device', 'dev', 'd', 'connection', 'con', 'c', 'general', 'g',
    'networking', 'n', 'radio', 'r', 'monitor', 'agent',
  ]),
};

const NETWORK_READ_VERBS = new Set([
  'show', 'list', 'sh', 'ls', 'l', 'status', 'get', 'print', 'monitor', 'help',
]);

export function commandHasStatefulSysadminArg(command: string): boolean {
  for (const segment of splitCommandSegments(command)) {
    const objects = NETWORK_OBJECT_WORDS[segment.base];
    if (segment.base === 'route' || segment.base === 'arp') {
      const words = segment.tokens
        .slice(1)
        .filter((token) => !token.startsWith('-'));
      const verb = words[0]?.toLowerCase();
      if (verb === undefined) continue;
      if (NETWORK_READ_VERBS.has(verb)) continue;
      return true;
    }
    if (!objects) continue;
    const words = segment.tokens
      .slice(1)
      .filter((token) => !token.startsWith('-'));
    const object = words[0]?.toLowerCase();
    if (object === undefined) continue;
    if (!objects.has(object)) {
      return true;
    }
    const verb = words[1]?.toLowerCase();
    if (verb === undefined) continue;
    if (NETWORK_READ_VERBS.has(verb)) continue;
    return true;
  }
  return false;
}

export const mutatingArgPatterns: RegExp[] = [
  /\bsed\b[^|]*\s-i(?:[^a-z]|$)/i,
  /\bawk\b[^|]*\bsystem\s*\(/i,
  /\bawk\b[^|]*\|\s*getline\b/i,
  /\bfind\b[^|]*\s-(?:exec|execdir|delete|ok|okdir)\b/i,
  /\bgit\s+config\s+(?:--global|--system|--add|--unset|--replace-all|[^-\s]+\s+\S)/i,
  /\bnpm\s+config\s+(?:set|delete|edit)\b/i,
  /\bpnpm\s+config\s+(?:set|delete|edit)\b/i,
  /\byarn\s+config\s+(?:set|delete)\b/i,
  /\bbrew\s+(?:install|uninstall|remove|upgrade|reinstall|cask|tap|untap|link|unlink|pin|unpin|cleanup)\b/i,
  /\bdocker\s+(?:run|exec|build|push|pull|rm|rmi|stop|kill|start|restart|cp|commit|login)\b/i,
  /\bkubectl\s+(?:apply|create|delete|edit|patch|replace|exec|cp|drain|rollout|scale|attach|run|label|annotate|cordon|uncordon)\b/i,
];

export function commandHasMutatingArg(command: string): boolean {
  return mutatingArgPatterns.some((pattern) => pattern.test(command));
}

export const mutatingCommandBases = new Set([
  "mv",
  "cp",
  "rm",
  "rmdir",
  "mkdir",
  "touch",
  "ln",
  "link",
  "rename",
  "dd",
  "tee",
  "truncate",
  "shred",
  "install",
  "patch",
  "chmod",
  "chown",
  "chgrp",
  "chattr",
  "setfacl",
  "mkfs",
  "mkswap",
  "fallocate",
  "split",
  "unzip",
  "gunzip",
  "bunzip2",
  "unxz",
  "7z",
  "rsync",
  "scp",
  "sftp",
  "mount",
  "umount",
  "crontab",
  "reboot",
  "halt",
  "poweroff",
  "useradd",
  "userdel",
  "usermod",
  "groupadd",
  "passwd",
  "apt",
  "apt-get",
  "dpkg",
  "dnf",
  "yum",
  "rpm",
  "pacman",
  "zypper",
  "apk",
  "snap",
  "flatpak",
  "brew",
  "port",
  "choco",
  "winget",
  "scoop",
  "gem",
  "cargo",
  "go",
  "pip",
  "pip3",
  "pipx",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "make",
  "cmake",
  "ninja",
  "gradle",
  "mvn",
  "msbuild",
  "git",
  "docker",
  "kubectl",
  "podman",
]);

export function commandWritesOrEscalates(command: string): boolean {
  const withoutDup = command.replace(/\d*>&\d+|&>&\d+/g, " ");
  const re = /(?:&?>>?)\s*('[^']*'|"[^"]*"|[^\s;|&<>()]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(withoutDup)) !== null) {
    const target = (match[1] ?? "").replace(/^['"]|['"]$/g, "");
    if (!target) continue;
    if (/^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(target)) continue;
    return true;
  }
  return false;
}

const VERSION_HELP_TOKEN_RE =
  /^(?:--version|-version|-v|-V|--versions|version|--help|-help|-h|help|--usage)$/i;

export function isVersionOrHelpProbe(command: string): boolean {
  if (/[<>`$()]/.test(command)) return false;
  const segments = command
    .split(/(?:\|\||&&|;|\|)/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    const tokens = segment.split(/\s+/);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][\w]*=.*$/.test(tokens[i]!)) i += 1;
    if (
      i < tokens.length &&
      (tokens[i] === "sudo" ||
        tokens[i] === "doas" ||
        tokens[i] === "command" ||
        tokens[i] === "exec" ||
        tokens[i] === "time")
    ) {
      i += 1;
    }
    const args = tokens.slice(i + 1);
    return args.length === 1 && VERSION_HELP_TOKEN_RE.test(args[0]!);
  });
}

export function commandIsMutating(command: string): boolean {
  for (const segment of splitCommandSegments(command)) {
    const { base, sub } = segment;
    if (!mutatingCommandBases.has(base)) continue;
    const allow = subcommandSafeMap[base];
    if (allow && sub && (allow.has(sub) || allow.has(sub.replace(/^--/, "")))) {
      continue;
    }
    return true;
  }
  return false;
}

export function commandIsScannerOnly(command: string): boolean {
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return false;
  let sawScanner = false;
  for (const segment of segments) {
    if (isApprovedScannerSegment(segment)) {
      sawScanner = true;
      continue;
    }
    if (readOnlyShellCommands.has(segment.base)) continue;
    const allow = subcommandSafeMap[segment.base];
    const sub = segment.sub;
    if (allow && sub && (allow.has(sub) || allow.has(sub.replace(/^--/, "")))) {
      continue;
    }
    return false;
  }
  return sawScanner;
}

/**
 * @deprecated Secret-path hard blocks were removed. Patterns retained only
 * for diagnostics / legacy tests — {@link isSecretPath} always returns false
 * so pentest reads of .ssh/.env on targets are never gated by the agent.
 */
export const secretPathPatterns: RegExp[] = [
  /\/\.ssh(\/|$)/,
  /\/\.gnupg(\/|$)/,
  /\/\.aws(\/|$)/,
  /\/\.kube(\/|$)/,
  /\/\.docker\/config\.json$/,
  /\/\.npmrc$/,
  /\/\.pypirc$/,
  /\/\.netrc$/,
  /\/\.env(\.[\w.-]+)?$/,
  /\/\.git-credentials$/,
  /\/\.clai\/keys\.json$/,
  /\/id_rsa(\.|$)/,
  /\/id_ed25519(\.|$)/,
  /\/id_ecdsa(\.|$)/,
  /\.pem$/,
  /\.p12$/,
  /\.pfx$/,
  /\/etc\/shadow$/,
  /\/etc\/gshadow$/,
];

export function isSecretPath(_path: string): boolean {
  return false;
}

const SHELL_METACHAR_RE = /(?:\|\||&&|\||;|`|\$\(|<\(|>\(|>>|>|<<|<|\bsudo\b)/;

export function containsShellMetacharacter(command: string): boolean {
  return SHELL_METACHAR_RE.test(command);
}
