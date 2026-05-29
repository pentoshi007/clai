export const destructiveCommandPatterns = [
  /\brm\s+-[rfRf]*\s+\//,
  /\brm\s+-[rfRf]*\s+~\b/,
  /\bdel\s+\/f\s+\/s\s+\/q\s+[A-Z]:\\/i,
  /\bformat\s+[A-Z]:/i,
  /\bdd\s+if=.*\s+of=\/dev\//,
  /mkfs\.[a-z0-9]+\s+\/dev\//i,
  /:\(\)\s*\{\s*:\|:\s*&\s*}\s*;/,
  /\bshutdown\b.*\b(now|\/s|\/r)\b/i,
];

export const exfiltrationPatterns = [
  /curl\s+.*\|\s*sh/i,
  /wget\s+.*\|\s*sh/i,
  /tar\s+.*\|\s*(curl|nc|netcat)/i,
  /\bscp\b.*(~\/|\.ssh|\.env)/i,
  /curl\s+.*-d\s+@\/(etc\/passwd|etc\/shadow)/i,
  /base64\s+.*\|\s*(curl|wget|nc)/i,
];

export const networkScanTools = ['nmap', 'masscan', 'nikto', 'sqlmap', 'gobuster', 'ffuf', 'hydra', 'dirb', 'wfuzz', 'nuclei'];

/**
 * Commands that never mutate state and never expose secrets through their
 * default arguments. Powerful commands whose arguments can leak data
 * (cat, env, python, node, git, npm, pip, tee, xargs, curl, wget) are
 * intentionally NOT here — they fall through to `subcommandSafeMap` or
 * to the metacharacter-aware confirm path in classifier.ts.
 */
export const readOnlyShellCommands = new Set([
  // system info
  'whoami', 'hostname', 'uname', 'uptime', 'date', 'id', 'arch', 'sw_vers',
  'lsb_release', 'hostnamectl', 'locale', 'ulimit',
  'pwd', 'cd', 'test', 'true', 'false', 'basename', 'dirname',
  // file inspection (read-only listings; cat/head/tail can leak secrets so they
  // are subcommand-checked separately for known-safe paths)
  'ls', 'dir', 'wc', 'file', 'stat',
  'find', 'which', 'where', 'whereis', 'type', 'readlink', 'realpath',
  'tree', 'du', 'df', 'lsof', 'md5', 'md5sum', 'sha256sum', 'shasum',
  // networking info
  'ifconfig', 'ipconfig', 'ip', 'ping', 'traceroute', 'tracert', 'dig',
  'nslookup', 'host', 'whois', 'netstat', 'ss', 'route',
  'arp', 'iwconfig', 'nmcli',
  // process info
  'ps', 'top', 'htop', 'pgrep', 'lscpu', 'free', 'vmstat', 'iostat',
  // text processing (operate on stdin/files — safe by themselves)
  'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'awk', 'sed',
  'sort', 'uniq', 'cut', 'tr', 'diff', 'comm', 'jq',
  // recon / scanning that classifier already gates separately
  'whatweb', 'wpscan',
  'sublist3r', 'amass', 'subfinder', 'httpx',
]);

/**
 * Subcommand allowlist for powerful CLIs. The classifier treats
 * `<cmd> <subcmd> …` as safe iff `subcommandSafeMap[cmd]` contains
 * `subcmd`. Anything else falls through to confirm.
 *
 * `config` is intentionally NOT here for git/npm/pnpm/yarn — `git config
 * --global ...` and `npm config set ...` mutate user-level state and
 * should always confirm. Read-only forms (`git config --get foo`,
 * `npm config get registry`) are caught by `mutatingArgPatterns` below
 * so they can still auto-execute when the args are clearly read-only.
 */
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
  brew: new Set(['list', 'info', 'search', 'outdated', 'help', 'doctor', 'deps']),
  apt: new Set(['list', 'search', 'show', 'help']),
  dpkg: new Set(['-l', '-s', '-L', '--list', '--status', '--listfiles']),
  rpm: new Set(['-q', '-qa', '-qi', '-ql', '--query']),
  docker: new Set(['ps', 'images', 'inspect', 'logs', 'version', 'info', 'history']),
  kubectl: new Set(['get', 'describe', 'logs', 'version', 'cluster-info', 'api-resources', 'api-versions']),
};

/**
 * Patterns that move an otherwise-safe-looking command into the
 * confirm bucket because their arguments mutate state, exfiltrate
 * data, or escape into another shell:
 *   - `sed -i …`            in-place file rewrite
 *   - `awk … system(...)`   shell-out via awk's system()
 *   - `awk … |getline …`    arbitrary command via getline
 *   - `find … -exec …`      run arbitrary commands
 *   - `find … -delete`      delete matched files
 *   - `git config --global` / `git config --system` write user/system git config
 *   - `npm config set …`    persist npm/yarn/pnpm config
 *   - `<cmd> --output-document=…` / `-o …` for fetchers (curl/wget) when
 *     not GET — handled separately, but pattern caught here for safety
 */
export const mutatingArgPatterns: RegExp[] = [
  /\bsed\b[^|]*\s-i(?:[^a-z]|$)/i,
  /\bawk\b[^|]*\bsystem\s*\(/i,
  /\bawk\b[^|]*\|\s*getline\b/i,
  /\bfind\b[^|]*\s-(?:exec|execdir|delete|ok|okdir)\b/i,
  /\bgit\s+config\s+(?:--global|--system|--add|--unset|--replace-all|[^-\s]+\s+\S)/i,
  /\bnpm\s+config\s+(?:set|delete|edit)\b/i,
  /\bpnpm\s+config\s+(?:set|delete|edit)\b/i,
  /\byarn\s+config\s+(?:set|delete)\b/i,
  /\bbrew\s+(?:install|uninstall|upgrade|reinstall|cask|services\s+(?:start|stop|restart|run))\b/i,
  /\bdocker\s+(?:run|exec|build|push|pull|rm|rmi|stop|kill|start|restart|cp|commit|login)\b/i,
  /\bkubectl\s+(?:apply|create|delete|edit|patch|replace|exec|cp|drain|rollout|scale|attach|run|label|annotate|cordon|uncordon)\b/i,
];

export function commandHasMutatingArg(command: string): boolean {
  return mutatingArgPatterns.some((pattern) => pattern.test(command));
}

/**
 * Base commands whose whole job is to MUTATE state — create/copy/move/delete
 * files, change ownership/permissions, write to disk, install packages, build
 * artifacts, or control services/processes. These always require confirmation
 * even when they appear without any obviously dangerous flag.
 *
 * The policy this powers is: benign/read-only commands auto-run, but anything
 * that installs, deletes, modifies, moves, or copies (or needs elevation) must
 * be confirmed first. Package managers and build tools are included because
 * they write to disk and pull remote code.
 */
export const mutatingCommandBases = new Set([
  // file mutation
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
  // archives that write to disk
  "unzip",
  "gunzip",
  "bunzip2",
  "unxz",
  "7z",
  // transfer / sync that writes
  "rsync",
  "scp",
  "sftp",
  // process / service / system control
  "kill",
  "pkill",
  "killall",
  "mount",
  "umount",
  "systemctl",
  "service",
  "launchctl",
  "crontab",
  "reboot",
  "halt",
  "poweroff",
  "useradd",
  "userdel",
  "usermod",
  "groupadd",
  "passwd",
  // package managers / installers
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
  // build systems (write artifacts)
  "make",
  "cmake",
  "ninja",
  "gradle",
  "mvn",
  "msbuild",
  // VCS / containers / orchestration whose mutating subcommands are not on
  // the read-only allowlist (status/log/diff/ps/images/etc. are checked and
  // allowed *before* this set, so only the mutating subcommands land here).
  "git",
  "docker",
  "kubectl",
  "podman",
]);

/**
 * Metacharacters that WRITE to disk or escape into another command:
 *   - `>` / `>>` output redirection (overwrites/appends a file)
 *   - command substitution `$(...)` / backticks
 *   - process substitution `<(...)` / `>(...)`
 *   - `sudo` / `doas` (privilege escalation)
 *
 * Note: plain pipes (`|`) and command chaining (`&&`, `||`, `;`) are
 * intentionally NOT here — chaining read-only commands is benign and is
 * handled per-segment by {@link commandIsMutating}.
 */
const WRITE_OR_ESCALATE_RE =
  /(?:>>|>|`|\$\(|<\(|>\(|\bsudo\b|\bdoas\b)/;

export function commandWritesOrEscalates(command: string): boolean {
  return WRITE_OR_ESCALATE_RE.test(command);
}

/**
 * Split a command line on pipes / chaining operators and report whether ANY
 * segment is a mutating command. A segment is mutating when its base command
 * is in {@link mutatingCommandBases} AND it is not a known read-only
 * subcommand of that base (so `git status` / `docker ps` / `npm list` are NOT
 * flagged, while `git push` / `docker run` / `npm install` are). In-place /
 * state-mutating ARGUMENTS (sed -i, find -exec, …) are handled separately by
 * {@link commandHasMutatingArg}, which callers check first.
 *
 * This lets a chain of purely read-only commands (`grep x foo | sort | head`)
 * auto-run, while a chain that includes a mutator (`cat a | tee b`) is flagged.
 */
export function commandIsMutating(command: string): boolean {
  const segments = command
    .split(/(?:\|\||&&|;|\|)/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
  for (const segment of segments) {
    const tokens = segment.split(/\s+/);
    let i = 0;
    // Skip env-var assignment prefixes ("FOO=bar cmd ...") and exec/command.
    while (i < tokens.length && /^[A-Za-z_][\w]*=.*$/.test(tokens[i]!)) i += 1;
    if (
      i < tokens.length &&
      (tokens[i] === "command" || tokens[i] === "exec" || tokens[i] === "time")
    ) {
      i += 1;
    }
    const head = tokens[i];
    if (!head) continue;
    const base = head.replace(/^.*[\\/]/, "").toLowerCase();
    if (!mutatingCommandBases.has(base)) continue;
    // A read-only subcommand of an otherwise-mutating CLI (git status,
    // docker ps, npm list) is NOT a mutation.
    const sub = tokens[i + 1];
    const allow = subcommandSafeMap[base];
    if (allow && sub && (allow.has(sub) || allow.has(sub.replace(/^--/, "")))) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Paths that should never be read by an agent without explicit confirmation.
 * Matched against the resolved (tilde-expanded) absolute path of any tool
 * that takes a `path` argument, AND against shell command strings for
 * `cat`/`less`/`more`/`head`/`tail`/`view`/`bat`.
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

/**
 * Returns true if `path` (already resolved to an absolute path) points at
 * a known secret location.
 */
export function isSecretPath(path: string): boolean {
  // Normalize backslashes so Windows paths match the unix-style patterns too.
  const normalized = path.replace(/\\/g, '/');
  return secretPathPatterns.some((pattern) => pattern.test(normalized));
}

/**
 * Shell metacharacters that change the semantics of a command. When any of
 * these appear, even a base command on the read-only allowlist falls
 * through to confirm, because the arguments could mutate state or exfil
 * data. Inside single/double quotes we still treat the command as
 * compound — better to over-confirm than under-confirm.
 */
const SHELL_METACHAR_RE = /(?:\|\||&&|\||;|`|\$\(|<\(|>\(|>>|>|<<|<|\bsudo\b)/;

export function containsShellMetacharacter(command: string): boolean {
  return SHELL_METACHAR_RE.test(command);
}
