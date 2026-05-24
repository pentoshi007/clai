import { ffufReducer } from "../reducers/ffuf.js";
import { genericReducer } from "../reducers/generic.js";
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

/**
 * Pick a reducer based on (a) the tool name and (b) what binary is being
 * invoked. Falls back to the generic line-ranking reducer.
 */
export function pickReducer(context: PolicyContext): Reducer {
  if (context.toolName === "net.scan" || context.toolName === "pentest.recon") {
    // Both produce nmap-style text; for recon we still want nmap-shaped parsing
    // for the nmap sub-step.
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
      return genericReducer;
  }
}

export function reduceToolOutput(
  raw: string,
  context: PolicyContext,
): ReducerOutput {
  const reducer = pickReducer(context);
  return reducer(raw, {
    command: context.command ?? context.toolName,
    argv: context.argv,
  });
}
