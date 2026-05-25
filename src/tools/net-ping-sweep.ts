import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { platform } from "node:os";
import type { ToolResult } from "../types.js";

export interface PingSweepArgs {
  target: string;
  method?: "auto" | "nmap" | "arp" | "native" | undefined;
  timeoutMs?: number | undefined;
}

export interface ActiveDevice {
  ip: string;
  hostname?: string | undefined;
  mac?: string | undefined;
  vendor?: string | undefined;
  source: "nmap" | "arp-scan" | "arp" | "ip-neigh";
}

const PRIVATE_CIDR_RE =
  /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})(?:\/\d{1,2})?$/;

function isPrivateCidr(target: string): boolean {
  return PRIVATE_CIDR_RE.test(target);
}

function commandAvailable(command: string): boolean {
  try {
    const cmd = platform() === "win32" ? `where.exe ${command}` : `command -v ${command}`;
    execSync(cmd, { timeout: 3_000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runCommand(
  command: string,
  argv: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;

    const timeout = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve({ ok: false, stdout, stderr, exitCode: 1 });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        ok: !killed && code === 0,
        stdout,
        stderr,
        exitCode: killed ? 124 : code,
      });
    });
  });
}

/**
 * Parse nmap -sn output to extract active devices.
 * Exported for testing.
 */
export function parseNmapPingSweep(output: string): ActiveDevice[] {
  const devices: ActiveDevice[] = [];
  const blocks = output.split(/(?=Nmap scan report for )/);

  for (const block of blocks) {
    const hostMatch = /Nmap scan report for\s+(?:(\S+)\s+\()?(\d+\.\d+\.\d+\.\d+)\)?/i.exec(block);
    if (!hostMatch) continue;
    const ip = hostMatch[2]!;
    const hostname = hostMatch[1] || undefined;

    if (!/Host is up/i.test(block)) continue;

    const macMatch = /MAC Address:\s+([0-9A-Fa-f:]+)(?:\s+\(([^)]+)\))?/i.exec(block);
    devices.push({
      ip,
      hostname,
      mac: macMatch?.[1],
      vendor: macMatch?.[2],
      source: "nmap",
    });
  }

  return devices;
}

/**
 * Parse arp -a output to extract devices from the ARP table.
 * Exported for testing.
 */
export function parseArpTable(output: string): ActiveDevice[] {
  const devices: ActiveDevice[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    // macOS: ? (192.168.1.1) at aa:bb:cc:dd:ee:ff on en0 [ethernet]
    // Linux: ? (192.168.1.1) at aa:bb:cc:dd:ee:ff [ether] on eth0
    const match = /\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-fA-F:]+)/i.exec(line);
    if (match && match[2] !== "(incomplete)") {
      devices.push({
        ip: match[1]!,
        mac: match[2]!,
        source: "arp",
      });
    }
  }

  return devices;
}

function parseArpScanOutput(output: string): ActiveDevice[] {
  const devices: ActiveDevice[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    // 192.168.1.1	aa:bb:cc:dd:ee:ff	Vendor Corp
    const match = /^(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F:]+)\s*(.*)/i.exec(line);
    if (match) {
      devices.push({
        ip: match[1]!,
        mac: match[2]!,
        vendor: match[3]?.trim() || undefined,
        source: "arp-scan",
      });
    }
  }

  return devices;
}

function parseIpNeigh(output: string): ActiveDevice[] {
  const devices: ActiveDevice[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    // 192.168.1.1 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE
    const match = /^(\d+\.\d+\.\d+\.\d+)\s+.*?lladdr\s+([0-9a-fA-F:]+)/i.exec(line);
    if (match) {
      devices.push({
        ip: match[1]!,
        mac: match[2]!,
        source: "ip-neigh",
      });
    }
  }

  return devices;
}

function formatDevices(devices: ActiveDevice[]): string {
  if (devices.length === 0) return "No active devices found.";
  const lines = [`Found ${devices.length} active device(s):\n`];
  for (const dev of devices) {
    const parts = [dev.ip];
    if (dev.hostname) parts.push(`(${dev.hostname})`);
    if (dev.mac) parts.push(`MAC: ${dev.mac}`);
    if (dev.vendor) parts.push(`[${dev.vendor}]`);
    lines.push(`  ${parts.join("  ")}`);
  }
  return lines.join("\n");
}

export async function pingSweep(args: PingSweepArgs): Promise<ToolResult> {
  const target = args.target.trim();
  const timeoutMs = args.timeoutMs ?? 120_000;
  const method = args.method ?? "auto";

  if (!isPrivateCidr(target)) {
    return {
      ok: false,
      output: `net.pingSweep is restricted to local/private networks. Target "${target}" does not appear to be a private CIDR. Use net.scan for individual host scanning.`,
      exitCode: 1,
    };
  }

  // Method selection
  if (method === "nmap" || (method === "auto" && commandAvailable("nmap"))) {
    const result = await runCommand("nmap", ["-sn", target], timeoutMs);
    const devices = parseNmapPingSweep(result.stdout);
    return {
      ok: result.ok,
      output: formatDevices(devices) + (result.ok ? "" : `\n\nStderr: ${result.stderr}`),
    };
  }

  if (method === "arp" || method === "auto") {
    // Try arp-scan first (gives richer data)
    if (commandAvailable("arp-scan")) {
      const result = await runCommand("arp-scan", ["--localnet"], timeoutMs);
      const devices = parseArpScanOutput(result.stdout);
      if (devices.length > 0) {
        return {
          ok: true,
          output: formatDevices(devices),
        };
      }
    }

    // Linux: try ip neigh
    if (platform() === "linux" && commandAvailable("ip")) {
      const result = await runCommand("ip", ["neigh", "show"], timeoutMs);
      const devices = parseIpNeigh(result.stdout);
      return {
        ok: true,
        output: formatDevices(devices) +
          "\n\nNote: ARP cache only shows recently-seen devices. For comprehensive discovery, install nmap: `pkg.install nmap`",
      };
    }

    // Fallback: arp -a (available everywhere)
    const result = await runCommand("arp", ["-a"], timeoutMs);
    const devices = parseArpTable(result.stdout);
    return {
      ok: true,
      output: formatDevices(devices) +
        "\n\nNote: ARP cache only shows recently-seen devices. For comprehensive discovery, install nmap: `pkg.install nmap`",
    };
  }

  return {
    ok: false,
    output: `No suitable method for ping sweep. Install nmap for best results: pkg.install nmap`,
    exitCode: 1,
  };
}
