import type { ToolResult } from "../../types.js";
import { preparePrivilegedBackgroundArgv } from "../elevated-shell.js";
import type { BackgroundSpawnSpec } from "../jobs.js";
import type { ToolRunOptions } from "../tool-types.js";
import {
  nmapScanNeedsPrivilege,
  parsePortSpec,
  toConnectScanArgv,
  withNmapSkipDiscovery,
} from "../validate.js";

type PreparedNmapJob =
  | { prepared: true; spec: BackgroundSpawnSpec }
  | { prepared: false; result: ToolResult };

export async function prepareDurableNmapJob(
  argv: string[],
  options: ToolRunOptions | undefined,
  prompt: string,
): Promise<PreparedNmapJob> {
  if (!nmapScanNeedsPrivilege(argv)) {
    return { prepared: true, spec: { command: "nmap", argv: [...argv] } };
  }
  const elevated = await preparePrivilegedBackgroundArgv("nmap", argv, {
    signal: options?.signal,
    onOutput: options?.onOutput,
    requestSecret: options?.requestSecret,
    title: "Administrator access for nmap",
    prompt,
  });
  if (elevated.prepared || options?.signal?.aborted) return elevated;
  if (argv.includes("-sU") || argv.includes("-sO")) {
    return {
      prepared: false,
      result: {
        ...elevated.result,
        output:
          `${elevated.result.output}\n` +
          "The requested UDP/protocol scan has no equivalent unprivileged fallback. Authentication will not be reopened automatically; choose a TCP connect scan explicitly to continue without elevation.",
      },
    };
  }
  const fallbackArgv = withNmapSkipDiscovery(toConnectScanArgv(argv));
  options?.onOutput?.(
    "\nAdministrator scan was cancelled or unavailable. Starting one unprivileged TCP connect fallback (-sT -Pn); authentication will not be requested again.\n",
    "stderr",
  );
  return {
    prepared: true,
    spec: { command: "nmap", argv: fallbackArgv },
  };
}

/** nmap argv for pentest.recon — ports configurable (default top-100). */
export function buildPentestReconNmapArgv(
  args: Record<string, unknown>,
  host: string,
): string[] {
  const argv = ["-sS", "-sV"];
  const full = args.full === true || args.full === "true";
  const portsRaw =
    typeof args.ports === "string" && args.ports.trim()
      ? args.ports.trim()
      : undefined;
  // "top-1000" / "top ports 1000" style specs map to --top-ports, not -p.
  const topPortsSpec = portsRaw
    ? /^top[\s_-]*(?:ports?[\s_-]*)?(\d{1,5})$/i.exec(portsRaw)
    : null;
  const ports = portsRaw && !topPortsSpec ? portsRaw : undefined;
  let topPorts: number | undefined;
  if (typeof args.topPorts === "number" && Number.isFinite(args.topPorts)) {
    topPorts = Math.max(1, Math.min(65535, Math.floor(args.topPorts)));
  } else if (typeof args.topPorts === "string" && /^\d+$/.test(args.topPorts)) {
    topPorts = Math.max(1, Math.min(65535, Number(args.topPorts)));
  }
  if (topPortsSpec && topPorts === undefined) {
    topPorts = Math.max(1, Math.min(65535, Number(topPortsSpec[1])));
  }
  if (full) {
    argv.push("-p-");
  } else if (ports) {
    const spec = parsePortSpec(ports);
    argv.push("-p", spec);
  } else {
    argv.push("--top-ports", String(topPorts ?? 100));
  }
  argv.push(host);
  return argv;
}
