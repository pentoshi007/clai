import { networkInterfaces, hostname, platform } from "node:os";
import { execSync } from "node:child_process";
import type { ToolResult } from "../types.js";

export interface NetworkInterfaceInfo {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  netmask?: string | undefined;
  cidr?: string | undefined;
  mac?: string | undefined;
  internal: boolean;
  defaultRoute?: boolean | undefined;
  gateway?: string | undefined;
}

export interface NetworkContextResult {
  hostname: string;
  platform: NodeJS.Platform;
  interfaces: NetworkInterfaceInfo[];
  candidates: NetworkInterfaceInfo[];
  selected?: NetworkInterfaceInfo | undefined;
  warnings?: string[] | undefined;
}

/**
 * Convert a dotted-quad IPv4 netmask (e.g. "255.255.255.0") to CIDR prefix
 * length (e.g. 24). Returns undefined if the mask is not valid.
 */
export function netmaskToCidr(netmask: string): number | undefined {
  const parts = netmask.split(".");
  if (parts.length !== 4) return undefined;
  let bits = 0;
  for (const part of parts) {
    const n = Number(part);
    if (Number.isNaN(n) || n < 0 || n > 255) return undefined;
    bits += n.toString(2).split("1").length - 1;
  }
  return bits;
}

function isPrivateV4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function detectGateway(): string | undefined {
  const os = platform();
  try {
    if (os === "darwin") {
      const out = execSync("route -n get default 2>/dev/null", {
        timeout: 5_000,
        encoding: "utf8",
      });
      const match = /gateway:\s+(\S+)/i.exec(out);
      return match?.[1];
    }
    if (os === "linux") {
      const out = execSync("ip route show default 2>/dev/null", {
        timeout: 5_000,
        encoding: "utf8",
      });
      const match = /via\s+(\S+)/i.exec(out);
      return match?.[1];
    }
    if (os === "win32") {
      const out = execSync(
        'powershell -Command "(Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Select-Object -First 1).NextHop"',
        { timeout: 5_000, encoding: "utf8" },
      );
      const trimmed = out.trim();
      return trimmed || undefined;
    }
  } catch {
    // gateway detection failed — non-fatal
  }
  return undefined;
}

function sameSubnet(
  addr: string,
  gateway: string,
  prefix: number,
): boolean {
  const toBits = (ip: string): number => {
    const parts = ip.split(".").map(Number);
    return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
  };
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (toBits(addr) & mask) === (toBits(gateway) & mask);
}

export async function getNetworkContext(): Promise<ToolResult> {
  const ifaces = networkInterfaces();
  const all: NetworkInterfaceInfo[] = [];
  const warnings: string[] = [];
  const gateway = detectGateway();

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      all.push({
        name,
        address: addr.address,
        family: addr.family as "IPv4" | "IPv6",
        netmask: addr.netmask,
        cidr: addr.cidr ?? undefined,
        mac: addr.mac,
        internal: addr.internal,
      });
    }
  }

  // Filter to active private IPv4 interfaces
  const candidates = all.filter(
    (iface) =>
      iface.family === "IPv4" &&
      !iface.internal &&
      isPrivateV4(iface.address),
  );

  let selected: NetworkInterfaceInfo | undefined;

  if (gateway && candidates.length > 0) {
    // Find the interface whose subnet contains the gateway
    for (const candidate of candidates) {
      const prefix = candidate.netmask
        ? netmaskToCidr(candidate.netmask)
        : undefined;
      if (prefix !== undefined && sameSubnet(candidate.address, gateway, prefix)) {
        selected = {
          ...candidate,
          defaultRoute: true,
          gateway,
        };
        break;
      }
    }
    // If no subnet match, just take the first candidate
    if (!selected && candidates.length > 0) {
      selected = { ...candidates[0]!, gateway };
    }
  } else if (candidates.length === 1) {
    selected = candidates[0]!;
  } else if (candidates.length > 1) {
    warnings.push(
      `Multiple network interfaces found (${candidates.map((c) => `${c.name}:${c.address}`).join(", ")}). Could not determine default route.`,
    );
  } else {
    warnings.push("No active private IPv4 interfaces detected.");
  }

  const result: NetworkContextResult = {
    hostname: hostname(),
    platform: platform(),
    interfaces: all,
    candidates,
    selected,
    warnings: warnings.length > 0 ? warnings : undefined,
  };

  return {
    ok: candidates.length > 0,
    output: JSON.stringify(result, null, 2),
  };
}
