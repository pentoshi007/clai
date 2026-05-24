import type { Reducer, ReducerOutput } from "./types.js";

interface NmapPort {
  port: number;
  protocol: string;
  state: string;
  service?: string | undefined;
  version?: string | undefined;
}

interface NmapHost {
  host: string;
  status?: string | undefined;
  ports: NmapPort[];
  os?: string | undefined;
}

const PORT_LINE_RE = /^\s*(\d+)\/(tcp|udp)\s+(open|closed|filtered|open\|filtered)\s+(\S+)(?:\s+(.*))?$/i;
const HOST_LINE_RE = /^Nmap scan report for\s+(.+)$/i;
const STATUS_LINE_RE = /^Host is\s+(.+?)(?:\s+\(.*\))?\.?$/i;
const OS_LINE_RE = /^(?:OS details|Running):\s+(.+)$/i;
const SUMMARY_RE = /Nmap done:.+/i;

/**
 * Parse plain "nmap -sV" text output into structured findings. We avoid
 * forcing -oX here so the agent can still pass any flags it wants — but if
 * the output looks like XML we just include it verbatim.
 */
export const nmapReducer: Reducer = (raw): ReducerOutput => {
  if (raw.trim().startsWith("<?xml")) {
    return { summary: raw.slice(0, 8_000) };
  }
  const hosts: NmapHost[] = [];
  let current: NmapHost | undefined;
  let summaryLine = "";
  for (const line of raw.split(/\r?\n/)) {
    const hostMatch = HOST_LINE_RE.exec(line);
    if (hostMatch) {
      current = { host: hostMatch[1]!.trim(), ports: [] };
      hosts.push(current);
      continue;
    }
    if (!current) continue;
    const statusMatch = STATUS_LINE_RE.exec(line);
    if (statusMatch) {
      current.status = statusMatch[1];
      continue;
    }
    const osMatch = OS_LINE_RE.exec(line);
    if (osMatch) {
      current.os = osMatch[1];
      continue;
    }
    const portMatch = PORT_LINE_RE.exec(line);
    if (portMatch) {
      current.ports.push({
        port: Number(portMatch[1]),
        protocol: portMatch[2]!.toLowerCase(),
        state: portMatch[3]!.toLowerCase(),
        service: portMatch[4],
        version: portMatch[5]?.trim() || undefined,
      });
      continue;
    }
    if (SUMMARY_RE.test(line)) {
      summaryLine = line.trim();
    }
  }
  const totalHosts = hosts.length;
  const totalOpen = hosts.reduce(
    (n, host) => n + host.ports.filter((p) => p.state === "open").length,
    0,
  );
  const lines: string[] = [];
  lines.push(`# nmap reduced summary — ${totalHosts} host(s), ${totalOpen} open port(s)`);
  if (summaryLine) lines.push(summaryLine);
  for (const host of hosts) {
    lines.push("");
    lines.push(`## ${host.host}${host.status ? ` (${host.status})` : ""}`);
    if (host.os) lines.push(`OS: ${host.os}`);
    if (host.ports.length === 0) {
      lines.push("(no ports parsed)");
      continue;
    }
    for (const port of host.ports) {
      const parts = [
        `${port.port}/${port.protocol}`,
        port.state,
        port.service ?? "",
        port.version ?? "",
      ];
      lines.push(parts.filter(Boolean).join(" — "));
    }
  }
  return {
    summary: lines.join("\n"),
    findings: { hosts, totalHosts, totalOpen },
  };
};
