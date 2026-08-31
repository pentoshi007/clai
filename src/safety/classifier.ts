import net from "node:net";
import type { ToolCall } from "../types.js";
import { networkScanTools } from "./patterns.js";
import { normalizeScopeTarget } from "../store/scope.js";
import { ClassifyOptions, RiskDecision, classifyInteractiveInput, classifyShellCommand } from "./shell-classification.js";
import { stringArg } from "./tool-classification.js";
export { classifyToolCall } from "./tool-classification.js";
export { classifyInteractiveInput, classifyShellCommand };
export type { ClassifyOptions, InteractiveInputPolicyContext, RiskDecision } from "./shell-classification.js";

export function isPrivateIpv4(value: string): boolean {
  const candidate = value.split("/")[0] ?? value;
  if (net.isIP(candidate) === 0) return false;
  if (net.isIP(candidate) === 6) {
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
const BARE_HOSTNAME_RE =
  /(?:^|[\s'"=(,])((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63})\b/g;

function extractHostnameTokens(command: string): string[] {
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  URL_HOSTNAME_RE.lastIndex = 0;
  while ((match = URL_HOSTNAME_RE.exec(command)) !== null) {
    if (match[1]) tokens.push(match[1].replace(/\[|\]/g, "").split(":")[0]!);
  }
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
  const tld = lower.split(".").pop() ?? "";
  if (FILEY_TLDS.has(tld)) return false;
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

