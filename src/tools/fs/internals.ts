import { resolveToolPath } from "../../agent/project-root.js";
import { getConfig } from "../../store/config.js";
import { pathInsideSandbox } from "../fs.js";
import { resolvePath } from "./internals-2.js";

export const BINARY_SAMPLE_BYTES = 8192;

/** Resolve path for reads: tilde expansion + project root for relatives.
 *  Reads should never apply the write-only agent→project remap. */
export function resolveReadPath(path: string): string {
  return resolveToolPath(path);
}

/** Throw with a useful message when a read/list/search escapes the sandbox. */
export function ensureReadAllowed(
  resolved: string,
  original: string,
  confirmed?: boolean,
): void {
  if (confirmed) return;
  // Unrestricted reads by default (sandboxReads=false). When enabled, still
  // allow after user confirmation.
  if (getConfig().sandboxReads === false) return;
  if (!pathInsideSandbox(resolved, "read")) {
    throw new Error(
      `Read blocked — "${original}" resolves outside the approved sandbox roots. Add the path with /cwd or sandboxRoots, or set sandboxReads=false.`,
    );
  }
}

/**
 * Resolve path for writes. Outside-cwd is not hard-blocked — the runner
 * confirms such writes under default permissions and honors allow-all. No
 * secret-path gate (pentest must be free to touch .ssh/.env-like paths on
 * targets).
 */
export function ensureWriteAllowed(path: string, confirmed?: boolean): string {
  const resolved = resolvePath(path);
  void confirmed;
  return resolved;
}
