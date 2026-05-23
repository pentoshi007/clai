import net from "node:net";
import type { RiskLevel, ToolCall } from "../types.js";
import {
  destructiveCommandPatterns,
  exfiltrationPatterns,
  networkScanTools,
  readOnlyShellCommands,
} from "./patterns.js";

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

export function isPrivateIpv4(value: string): boolean {
  const candidate = value.split("/")[0] ?? value;
  // Handle hostnames — if it's not an IP, treat it as non-private (domain)
  if (net.isIP(candidate) === 0) return false;
  if (net.isIP(candidate) === 6) {
    // IPv6 link-local (fe80::), loopback (::1), ULA (fc00::/7)
    const lower = candidate.toLowerCase();
    return lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd");
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

function isPrivateTarget(value: string): boolean {
  const trimmed = value.trim().replace(/^https?:\/\//i, "");
  const host = trimmed.split(/[/:?#]/)[0] ?? trimmed;
  if (!host || host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0") return true;
  return isPrivateIpv4(host);
}

function shellTokens(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) =>
    token.replace(/^["']|["']$/g, ""),
  ) ?? [];
}

function commandHasOwnershipFlag(command: string): boolean {
  return shellTokens(command).includes("--i-own-this");
}

function extractNetworkTargets(command: string): string[] {
  const targets = new Set<string>();
  for (const match of command.matchAll(/https?:\/\/[^\s"'`<>]+/gi)) {
    targets.add(match[0]);
  }
  for (const match of command.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/g)) {
    targets.add(match[0]);
  }
  for (const token of shellTokens(command)) {
    if (token.startsWith("-") || token.includes("/") || token.includes("=")) continue;
    if (/\.(?:txt|lst|list|json|xml|csv|log|html)$/i.test(token)) continue;
    if (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(token)) targets.add(token);
  }
  return [...targets];
}

function containsPublicTarget(command: string): boolean {
  const targets = extractNetworkTargets(command);
  if (targets.length === 0) return false;
  return targets.some((target) => !isPrivateTarget(target));
}

function hasShellControlSyntax(command: string): boolean {
  return /(?:[;&|`<>]|\$\(|\${)/.test(command);
}

function referencesSecretPath(command: string): boolean {
  return /(?:^|\s)(?:~\/)?(?:\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.env\b|id_rsa|id_ed25519|\.npmrc|\.pypirc|\.clai\/keys\.json)/i.test(
    command,
  );
}

export function isPentestToolCall(call: ToolCall): boolean {
  if (call.name === "net.scan" || call.name === "pentest.recon") return true;
  if (call.name !== "shell.exec") return false;
  const command = stringArg(call.args, "command") ?? "";
  return commandContainsNetworkScanner(command);
}

export function classifyToolCall(call: ToolCall): RiskDecision {
  if (
    call.name === "sysinfo" ||
    call.name === "fs.read" ||
    call.name === "fs.list" ||
    call.name === "fs.search"
  ) {
    return { level: "safe", reason: "Read-only operation" };
  }

  if (call.name === "http.fetch") {
    const method = (stringArg(call.args, "method") ?? "GET").toUpperCase();
    const url = stringArg(call.args, "url") ?? "";
    if (method !== "GET" && method !== "HEAD") {
      return {
        level: "confirm",
        reason: "Non-GET HTTP requests can mutate remote systems",
      };
    }
    if (/169\.254\.169\.254|metadata\.google\.internal/i.test(url)) {
      return {
        level: "block",
        reason: "Cloud metadata endpoints are blocked",
      };
    }
    if (url && isPrivateTarget(url)) {
      return {
        level: "confirm",
        reason: "Fetching local or private network URLs requires confirmation",
      };
    }
    return {
      level: "safe",
      reason: "HTTP fetch is read-only with response size limits",
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
    if (referencesSecretPath(command)) {
      return {
        level: "confirm",
        reason: "Command references a path that may contain secrets",
      };
    }
    if (
      commandContainsNetworkScanner(command) &&
      containsPublicTarget(command) &&
      !commandHasOwnershipFlag(command)
    ) {
      return {
        level: "block",
        reason:
          "Public target scanning requires explicit --i-own-this authorization flag",
      };
    }
    // Pentest scan tools always require confirmation even against private targets
    if (commandContainsNetworkScanner(command)) {
      return { level: "confirm", reason: "Security scan tool requires confirmation" };
    }
    // Read-only / info commands are safe to auto-execute
    const base = command.trim().split(/\s+/)[0]?.replace(/^.*\//, "") ?? "";
    if (hasShellControlSyntax(command)) {
      return { level: "confirm", reason: "Shell control syntax requires confirmation" };
    }
    if (readOnlyShellCommands.has(base)) {
      return { level: "safe", reason: "Read-only command" };
    }
    return { level: "confirm", reason: "Shell commands require confirmation" };
  }

  if (call.name === "net.scan") {
    const target = stringArg(call.args, "target") ?? "";
    const ownsTarget = call.args.iOwnThis === true || call.args.own === true;
    if (target && !isPrivateTarget(target) && !ownsTarget) {
      return {
        level: "block",
        reason: "Public target scan requires ownership confirmation",
      };
    }
    return { level: "confirm", reason: "Network scans require confirmation" };
  }

  if (call.name === "pentest.recon") {
    const target = stringArg(call.args, "target") ?? "";
    const ownsTarget = call.args.iOwnThis === true || call.args.own === true;
    if (
      target &&
      !isPrivateTarget(target) &&
      !ownsTarget
    ) {
      return {
        level: "block",
        reason: "Public target recon requires ownership confirmation",
      };
    }
    return {
      level: "confirm",
      reason:
        "Pentest recon requires confirmation and authorization acknowledgement",
    };
  }

  if (call.name === "fs.write" || call.name === "pkg.install") {
    return {
      level: "confirm",
      reason: "Mutating operation requires confirmation",
    };
  }

  return { level: "confirm", reason: "Unknown tool requires confirmation" };
}
