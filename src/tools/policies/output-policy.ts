
import { ffufReducer } from "../reducers/ffuf.js";
import { gobusterReducer } from "../reducers/gobuster.js";
import { httpxReducer } from "../reducers/httpx.js";
import { nmapReducer } from "../reducers/nmap.js";
import { nucleiReducer } from "../reducers/nuclei.js";
import { sqlmapReducer } from "../reducers/sqlmap.js";
import { subdomainsReducer } from "../reducers/subdomains.js";
import type { Reducer, ReducerOutput } from "../reducers/types.js";

interface PolicyContext {
  toolName: string;
  command?: string | undefined;
  argv?: string[] | undefined;
}

function commandHead(command: string): string {
  return command.trim().split(/\s+/)[0]?.replace(/^.*\//, "") ?? "";
}

export function pickReducer(context: PolicyContext): Reducer | null {
  if (context.toolName === "net.scan" || context.toolName === "pentest.recon") {
    return nmapReducer;
  }
  const head = context.command ? commandHead(context.command) : "";
  switch (head) {
    case "nmap":
      return nmapReducer;
    case "ffuf":
      return ffufReducer;
    case "gobuster":
    case "feroxbuster":
    case "dirb":
    case "dirsearch":
      return gobusterReducer;
    case "subfinder":
    case "amass":
    case "sublist3r":
    case "assetfinder":
      return subdomainsReducer;
    case "httpx":
    case "httprobe":
      return httpxReducer;
    case "nuclei":
      return nucleiReducer;
    case "sqlmap":
      return sqlmapReducer;
    default:
      return null;
  }
}

export function reduceToolOutput(
  raw: string,
  context: PolicyContext,
): ReducerOutput {
  const reducer = pickReducer(context);
  if (!reducer) {
    return { summary: raw };
  }
  return reducer(raw, {
    command: context.command ?? context.toolName,
    argv: context.argv,
  });
}

export function hasStructuredReducer(context: PolicyContext): boolean {
  return pickReducer(context) !== null;
}
