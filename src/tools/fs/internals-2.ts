import {
  remapAgentCwdWrite,
  resolveToolPath,
} from "../../agent/project-root.js";

/** Resolve path with tilde expansion + sticky plan project root for relatives. */
export function resolvePath(path: string): string {
  const resolved = resolveToolPath(path);
  return remapAgentCwdWrite(resolved, path);
}
