import { resolveToolPath } from "../../agent/project-root.js";
import { getConfig } from "../../store/config.js";
import { pathInsideSandbox } from "../fs.js";
import { resolvePath } from "./internals-2.js";

export const BINARY_SAMPLE_BYTES = 8192;

export function resolveReadPath(path: string): string {
  return resolveToolPath(path);
}

export function ensureReadAllowed(
  resolved: string,
  original: string,
  confirmed?: boolean,
): void {
  if (confirmed) return;
  if (getConfig().sandboxReads === false) return;
  if (!pathInsideSandbox(resolved, "read")) {
    throw new Error(
      `Read blocked — "${original}" resolves outside the approved sandbox roots. Add the path with /cwd or sandboxRoots, or set sandboxReads=false.`,
    );
  }
}

export function ensureWriteAllowed(path: string, confirmed?: boolean): string {
  const resolved = resolvePath(path);
  void confirmed;
  return resolved;
}
