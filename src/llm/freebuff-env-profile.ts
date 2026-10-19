import { readFileSync } from "node:fs";

export interface FreebuffProcInfo {
  readonly ppid: number | null;
  readonly name: string;
}

export interface FreebuffParentInfo {
  readonly launcher: boolean;
  readonly parent: string;
  readonly grandparent: string;
}

interface ProfileSource {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly ppid: number;
  readonly launcherPid: string | undefined;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly columns: number | undefined;
  readonly rows: number | undefined;
  readonly osc: "yes" | "no" | undefined;
  readonly timeZone: string | null;
}

export interface FreebuffEnvProfileDeps {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly ppid?: number | undefined;
  readonly stdinIsTTY?: boolean | undefined;
  readonly stdoutIsTTY?: boolean | undefined;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  readonly osc?: "yes" | "no" | undefined;
  readonly timeZone?: string | null | undefined;
  readonly readProc?: ((pid: number) => FreebuffProcInfo | null) | undefined;
}

const SHELL_NAMES = new Set([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu",
  "elvish", "xonsh", "pwsh", "powershell", "cmd", "login",
]);

const MUX_NAMES = new Set(["tmux", "screen", "zellij", "byobu", "abduco"]);

const TERMINAL_NAMES = new Set([
  "terminal", "iterm2", "ghostty", "wezterm", "wezterm-gui", "alacritty", "kitty",
  "warp", "stable", "hyper", "tabby", "konsole", "gnome-terminal",
  "gnome-terminal-server", "gnome-terminal-", "xfce4-terminal", "mate-terminal",
  "lxterminal", "tilix", "terminator", "xterm", "urxvt", "rxvt", "st", "foot",
  "rio", "mintty", "windowsterminal", "openconsole", "conhost", "contour",
  "blackbox", "ptyxis", "ptyxis-agent",
]);

const EDITOR_NAMES = new Set([
  "code", "code-insiders", "cursor", "windsurf", "zed", "idea", "pycharm",
  "webstorm", "goland", "clion", "rider", "phpstorm", "rubymine", "datagrip",
  "fleet", "nvim", "vim", "emacs", "helix", "hx", "sublime_text",
]);

const TERM_PROGRAM_NAMES: Readonly<Record<string, string>> = {
  apple_terminal: "apple_terminal",
  "iterm.app": "iterm",
  iterm2: "iterm",
  vscode: "vscode",
  ghostty: "ghostty",
  wezterm: "wezterm",
  warpterminal: "warp",
  hyper: "hyper",
  tmux: "tmux",
  zed: "zed",
  tabby: "tabby",
  rio: "rio",
  mintty: "mintty",
  "jetbrains-jediterm": "jetbrains",
  kitty: "kitty",
  alacritty: "alacritty",
};

const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0)$/i;
const TIMEZONE_SHAPE = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/;

function zeroOne(value: unknown): string {
  return value ? "1" : "0";
}

function clampTerminalSize(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(9999, Math.floor(value)));
}

export function normalizeFreebuffProcessName(raw: string | undefined): string {
  if (!raw) return "unknown";
  let name = raw.trim();
  const slash = name.lastIndexOf("/");
  if (slash >= 0) name = name.slice(slash + 1);
  name = name.replace(/^-+/, "").replace(/\.exe$/i, "").toLowerCase();
  if (!name) return "unknown";
  if (SHELL_NAMES.has(name)) return "shell";
  if (MUX_NAMES.has(name) || name.startsWith("tmux")) return "mux";
  if (name === "sshd" || name.startsWith("sshd-")) return "sshd";
  if (name === "node" || name === "nodejs") return "node";
  if (/^python[0-9.]*$/.test(name) || name === "pypy" || name === "pypy3") return "python";
  if (name === "bun") return "bun";
  if (TERMINAL_NAMES.has(name)) return "terminal";
  if (EDITOR_NAMES.has(name)) return "editor";
  if (/^(code|cursor|windsurf|zed|electron)( helper|$)/.test(name)) return "editor";
  return "other";
}

export function freebuffTerminalProgramKind(value: string | undefined): string {
  const program = value?.trim().toLowerCase();
  if (!program) return "none";
  return TERM_PROGRAM_NAMES[program] ?? "other";
}

function readProcDefault(pid: number): FreebuffProcInfo | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const open = stat.indexOf("(");
    const close = stat.lastIndexOf(")");
    if (open < 0 || close <= open) return null;
    const fields = stat.slice(close + 2).split(" ");
    const ppid = Number(fields[1]);
    return {
      ppid: Number.isSafeInteger(ppid) ? ppid : null,
      name: stat.slice(open + 1, close),
    };
  } catch {
    return null;
  }
}

export function freebuffParentInfo(
  source: Pick<ProfileSource, "platform" | "ppid" | "launcherPid">,
  readProc: (pid: number) => FreebuffProcInfo | null = readProcDefault,
): FreebuffParentInfo {
  if (source.platform === "win32") return { launcher: false, parent: "na", grandparent: "na" };
  const fallback: FreebuffParentInfo = { launcher: false, parent: "unknown", grandparent: "unknown" };
  try {
    const launcher = Boolean(source.launcherPid) && source.launcherPid === String(source.ppid);
    let target: number | null = source.ppid;
    if (launcher) target = readProc(source.ppid)?.ppid ?? null;
    if (target === null) return { ...fallback, launcher };
    const parent = readProc(target);
    const grandparent = parent?.ppid !== null && parent?.ppid !== undefined ? readProc(parent.ppid) : null;
    return {
      launcher,
      parent: normalizeFreebuffProcessName(parent?.name),
      grandparent: normalizeFreebuffProcessName(grandparent?.name),
    };
  } catch {
    return fallback;
  }
}

function proxyKind(value: string | undefined): "none" | "loopback" | "remote" {
  const raw = value?.trim();
  if (!raw) return "none";
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return LOOPBACK_HOST.test(url.hostname) ? "loopback" : "remote";
  } catch {
    return "remote";
  }
}

export function freebuffProxyKind(env: NodeJS.ProcessEnv): "none" | "loopback" | "remote" {
  const kinds = [env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy]
    .map(proxyKind);
  if (kinds.includes("loopback")) return "loopback";
  if (kinds.includes("remote")) return "remote";
  return "none";
}

export function freebuffCloudDevEnv(env: NodeJS.ProcessEnv): string {
  if (env.CODESPACES?.trim().toLowerCase() === "true") return "codespaces";
  if (env.GITPOD_WORKSPACE_ID?.trim()) return "gitpod";
  if (env.CLOUD_SHELL?.trim().toLowerCase() === "true") return "cloudshell";
  if (env.CODER?.trim().toLowerCase() === "true") return "coder";
  return "none";
}

export function freebuffTimezoneProfile(timeZone: string | null | undefined): string | null {
  const raw = timeZone?.trim();
  if (!raw) return null;
  const marker = raw.lastIndexOf("zoneinfo/");
  const candidate = marker >= 0 ? raw.slice(marker + "zoneinfo/".length) : raw;
  return TIMEZONE_SHAPE.test(candidate) && candidate.length <= 64 ? candidate : null;
}

function resolvedTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

export function freebuffEnvProfile(deps: FreebuffEnvProfileDeps = {}): string {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const ppid = deps.ppid ?? process.ppid;
  const launcherPid = env.CODEBUFF_LAUNCHER_PID;
  const parent = freebuffParentInfo({ platform, ppid, launcherPid }, deps.readProc);
  const ci = env.CI === "true" || env.CI === "1" || env.GITHUB_ACTIONS === "true";
  const timezoneSet = Boolean(env.TZ?.trim());
  const timezone = timezoneSet ? freebuffTimezoneProfile(deps.timeZone ?? resolvedTimeZone()) : null;
  const entries: Array<[string, string]> = [
    ["in", zeroOne(deps.stdinIsTTY ?? process.stdin?.isTTY)],
    ["out", zeroOne(deps.stdoutIsTTY ?? process.stdout?.isTTY)],
    ["tp", freebuffTerminalProgramKind(env.TERM_PROGRAM)],
    ["term", zeroOne(env.TERM)],
    ["ct", zeroOne(env.COLORTERM)],
    ["sz", `${clampTerminalSize(deps.columns ?? process.stdout?.columns)}x${clampTerminalSize(deps.rows ?? process.stdout?.rows)}`],
    ["ci", zeroOne(ci)],
    ["ssh", zeroOne(env.SSH_TTY || env.SSH_CONNECTION)],
    ["l", zeroOne(parent.launcher)],
    ["p", parent.parent],
    ["g", parent.grandparent],
    ["osc", deps.osc === "yes" ? "1" : deps.osc === "no" ? "0" : "na"],
    ["tzo", zeroOne(timezoneSet)],
    ["px", freebuffProxyKind(env)],
    ["tls", env.NODE_TLS_REJECT_UNAUTHORIZED?.trim() === "0" ? "0" : "1"],
    ["ca", zeroOne(env.NODE_EXTRA_CA_CERTS?.trim())],
    ["cde", freebuffCloudDevEnv(env)],
  ];
  if (timezone) entries.push(["stz", timezone]);
  return ["v1", ...entries.map(([key, value]) => `${key}=${value}`)].join(";");
}
