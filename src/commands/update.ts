import chalk from "chalk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getConfig, updateConfig } from "../store/config.js";
import { VERSION as GENERATED_VERSION } from "../version.generated.js";
import {
  detectInstallMethod,
  performUpdate,
  resolveInstallEnv,
  type InstallMethod,
  type SecretRequester,
  type UpdateProgress,
  type UpdateInstallResult,
} from "./update-install.js";

import { fetchLatestRelease } from "./update/metadata.js";
import { compareVersions, releaseVersion } from "./update/verification.js";

/**
 * Version resolution order:
 * 1. package.json (dev / npm install) — always matches the checkout
 * 2. src/version.generated.ts — baked into bun --compile binaries
 *
 * Humans only edit package.json; run `npm run sync-version` (also via
 * build/pretest) to refresh the generated constant and install manifests.
 */
function resolvePackageVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i += 1) {
      try {
        const pkg: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (pkg && typeof pkg === "object" && "name" in pkg && pkg.name === "@pentoshi/clai" && "version" in pkg) {
          const version = releaseVersion(pkg.version);
          if (version) return version;
        }
      } catch {
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
  }
  return GENERATED_VERSION;
}

const CURRENT_VERSION = resolvePackageVersion();
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = UPDATE_CHECK_INTERVAL_MS;

function isNewer(remote: string, local: string): boolean {
  return compareVersions(remote, local) > 0;
}

export function getCurrentVersion(): string {
  return CURRENT_VERSION;
}

export async function fetchLatestVersion(signal?: AbortSignal): Promise<string | undefined> {
  const release = await fetchLatestRelease(signal);
  const tag = release?.tag_name?.replace(/^v/, "").trim();
  return tag ? tag : undefined;
}

export function updateCheckDisabledReason(): string | undefined {
  if (process.env.CLAI_OFFLINE === "1") return "offline mode";
  if (process.env.CLAI_NO_UPDATE_CHECK === "1") return "update checks disabled";
  return getConfig().offline ? "offline mode" : undefined;
}

function isUpdateCheckDisabled(): boolean {
  if (
    process.env.CLAI_OFFLINE === "1" ||
    process.env.CLAI_NO_UPDATE_CHECK === "1"
  )
    return true;
  return Boolean(getConfig().offline);
}

export function checkForUpdateSilent(): void {
  if (isUpdateCheckDisabled()) return;
  const config = getConfig();
  if (
    config.lastUpdateCheck &&
    Date.now() - config.lastUpdateCheck < CHECK_INTERVAL_MS
  )
    return;

  fetchLatestRelease()
    .then((release) => {
      if (!release) return;
      updateConfig({ lastUpdateCheck: Date.now() });
      if (isNewer(release.tag_name, CURRENT_VERSION)) {
        const ver = release.tag_name.replace(/^v/, "");
        console.log(
          chalk.yellow(`\n  ⬆ Update available: ${CURRENT_VERSION} → ${ver}`) +
            chalk.dim("  Run: /update or clai update\n"),
        );
      }
    })
    .catch(() => {});
}

export async function detectInstallMethodOrDev(signal?: AbortSignal): Promise<InstallMethod> {
  try {
    return detectInstallMethod(await resolveInstallEnv(signal));
  } catch {
    return { type: "unknown", detail: "detection failed" };
  }
}

export async function installUpdate(
  version: string,
  log?: (line: string) => void,
  stdio: "inherit" | "pipe" = "inherit",
  onProgress?: (progress: UpdateProgress) => void,
  signal?: AbortSignal,
  requestSecret?: SecretRequester,
): Promise<UpdateInstallResult> {
  const method = await detectInstallMethodOrDev(signal);
  const result = await performUpdate({
    version,
    method,
    stdio,
    ...(log ? { log } : {}),
    ...(onProgress ? { onProgress } : {}),
    ...(signal ? { signal } : {}),
    ...(requestSecret ? { requestSecret } : {}),
  });
  return result;
}

export async function runUpdate(): Promise<void> {
  console.log(chalk.dim("  Checking for updates..."));
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const release = await fetchLatestRelease(controller.signal);
    if (!release) {
      process.exitCode = 1;
      console.log(chalk.red("  ✗ Could not retrieve valid update metadata from GitHub or the mirror. Check your connection and retry."));
      return;
    }
    const remoteVer = release.tag_name.replace(/^v/, "");
    if (!isNewer(release.tag_name, CURRENT_VERSION)) {
      console.log(chalk.green(`  ✓ Already on latest version (${CURRENT_VERSION})`));
      updateConfig({ lastUpdateCheck: Date.now() });
      return;
    }
    console.log(chalk.yellow(`  ⬆ New version available: ${CURRENT_VERSION} → ${remoteVer}`));
    if (release.published_at) console.log(chalk.dim(`  Released: ${release.published_at}`));
    const result = await installUpdate(remoteVer, (line) => console.log(line), "inherit", undefined, controller.signal);
    if (result.ok) {
      if (result.outcome === "staged") console.log(chalk.yellow(`  Update staged: ${result.message}`));
      else console.log(chalk.green(`  ✓ Updated to ${result.installedVersion ?? remoteVer} (${result.message})`));
      if (result.needsRestart) console.log(chalk.dim("  Close this installation and reopen clai to use the update."));
      if (result.outcome !== "staged") updateConfig({ lastUpdateCheck: Date.now() });
      return;
    }
    process.exitCode = 1;
    console.log(chalk.yellow(`  ${result.message}`));
    console.log(chalk.dim(`  Manual: ${release.html_url}`));
  } catch (error) {
    process.exitCode = 1;
    console.log(chalk.red(`  ✗ Update failed: ${error instanceof Error ? error.message : String(error)}`));
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}