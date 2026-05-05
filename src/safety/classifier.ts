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
  if (net.isIP(candidate) !== 4) return false;
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

function containsPublicTarget(command: string): boolean {
  const ips = command.match(/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/g) ?? [];
  return ips.some((ip) => !isPrivateIpv4(ip));
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
    if (
      commandContainsNetworkScanner(command) &&
      containsPublicTarget(command) &&
      !command.includes("--i-own-this")
    ) {
      return {
        level: "block",
        reason:
          "Public target scanning requires explicit --i-own-this authorization flag",
      };
    }
    // Read-only / info commands are safe to auto-execute
    const base = command.trim().split(/\s+/)[0]?.replace(/^.*\//, "") ?? "";
    if (readOnlyShellCommands.has(base)) {
      return { level: "safe", reason: "Read-only command" };
    }
    return { level: "confirm", reason: "Shell commands require confirmation" };
  }

  if (call.name === "net.scan") {
    const target = stringArg(call.args, "target") ?? "";
    const ownsTarget = call.args.iOwnThis === true || call.args.own === true;
    if (target && !isPrivateIpv4(target) && !ownsTarget) {
      return {
        level: "block",
        reason: "Public IP scan requires ownership confirmation",
      };
    }
    return { level: "confirm", reason: "Network scans require confirmation" };
  }

  if (call.name === "pentest.recon") {
    const target = stringArg(call.args, "target") ?? "";
    const ownsTarget = call.args.iOwnThis === true || call.args.own === true;
    if (
      target &&
      net.isIP(target.split("/")[0] ?? target) &&
      !isPrivateIpv4(target) &&
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
