import {
  remapAgentCwdWrite,
  resolveToolPath,
} from "../../agent/project-root.js";

export function resolvePath(path: string): string {
  const resolved = resolveToolPath(path);
  return remapAgentCwdWrite(resolved, path);
}
