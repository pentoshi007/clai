import type { PerformUpdateOptions, UpdateInstallResult } from "./update/installers.js";
import { installDirectBinary, installViaPackageManager } from "./update/installers.js";
import { acquireUpdateLock } from "./update/lock.js";
import { throwIfCancelled } from "./update/process.js";
import { installSourceUpdate } from "./update/source.js";
import { releaseVersion } from "./update/verification.js";
export { detectInstallMethod, resolveInstallEnv } from "./update/detection.js";
export type { DetectEnv } from "./update/detection.js";
export { DEFAULT_MIRROR_BASE, ELEVATION_TIMEOUT_MS, PACKAGE_NAME, REPO, currentPlatformTarget, downloadBinary, mirrorBaseUrl } from "./update/installers.js";
export { installDirectBinary, installViaPackageManager };
export type { DownloadProgress, InstallMethod, InstallMethodType, PerformUpdateOptions, PlatformTarget, SecretRequester, UpdateElevation, UpdateInstallResult, UpdateProgress } from "./update/installers.js";

export async function performUpdate(options: PerformUpdateOptions): Promise<UpdateInstallResult> {
  throwIfCancelled(options.signal);
  if (releaseVersion(options.version) !== options.version) throw new Error("invalid update version");
  const type = options.method.type;
  if (type === "unknown") return { ok: false, method: type, message: "could not identify the active installation safely; rerun its original installer", needsRestart: false };
  const lock = acquireUpdateLock(options.method);
  let pending = false;
  try {
    const operation = { ...options, lockFile: lock.file, lockToken: lock.token };
    const result = await (type === "binary" ? installDirectBinary(operation) : type === "dev" ? installSourceUpdate(operation) : installViaPackageManager(operation));
    pending = result.outcome === "staged";
    return result;
  } finally { if (!pending) lock.release(); }
}
