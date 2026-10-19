import { dirname, relative, resolve, isAbsolute } from "node:path";
import { repairOwnership, type OwnershipRepairResult } from "../os/ownership-repair.js";
import { getInvokingUser } from "../os/user-identity.js";
import { getConfigPath } from "./config.js";
import { getDataDir, getGlobalArtifactDir, getHistoryDir, getJobsDir, getLogsDirRoot, getPlanDir } from "./paths.js";

function inside(home: string, path: string): boolean {
  const rel = relative(resolve(home), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function claiStorageRoots(): string[] {
  const user = getInvokingUser();
  if (!user) return [];
  const roots = [getDataDir(), getHistoryDir(), getPlanDir(), getLogsDirRoot(), getGlobalArtifactDir(), getJobsDir(), dirname(getConfigPath())];
  return [...new Set(roots.map((root) => resolve(root)))].filter((root) => inside(user.home, root));
}

export function repairClaiOwnership(budgetMs: number): Promise<OwnershipRepairResult> {
  const roots = claiStorageRoots();
  if (roots.length === 0) return Promise.resolve({ repaired: 0, complete: true });
  return repairOwnership(roots, Date.now() + budgetMs);
}
