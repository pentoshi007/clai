import { resolve, relative } from "node:path";

export interface PathGrant {
  path: string;
  mode: "read" | "write" | "readwrite";
  recursive: boolean;
  createdAt: string;
}

/**
 * Check if a resolved absolute path is covered by any existing grant.
 */
export function hasPathGrant(
  grants: PathGrant[],
  targetPath: string,
  mode: "read" | "write",
): boolean {
  const resolved = resolve(targetPath);

  for (const grant of grants) {
    // Check mode compatibility
    if (mode === "write" && grant.mode === "read") continue;
    if (mode === "read" && grant.mode === "write") continue;

    const grantPath = resolve(grant.path);

    // Exact match
    if (resolved === grantPath) return true;

    // Recursive: check if target is under grant path
    if (grant.recursive) {
      const rel = relative(grantPath, resolved);
      if (rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith(".."))) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Add a new path grant to the grants array (mutates in place).
 */
export function addPathGrant(
  grants: PathGrant[],
  path: string,
  mode: "read" | "write" | "readwrite",
  recursive: boolean,
): void {
  const resolved = resolve(path);
  // Don't add duplicates
  const exists = grants.some(
    (g) => resolve(g.path) === resolved && g.mode === mode && g.recursive === recursive,
  );
  if (!exists) {
    grants.push({
      path: resolved,
      mode,
      recursive,
      createdAt: new Date().toISOString(),
    });
  }
}
