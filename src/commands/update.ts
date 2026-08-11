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
  type UpdateProgress,
} from "./update-install.js";

const REPO = "pentoshi007/clai";

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
        const pkg = JSON.parse(
          readFileSync(join(dir, "package.json"), "utf8"),
        ) as { name?: string; version?: string };
        // Only accept our own package.json, not a dependency's.
        if (pkg.version && (!pkg.name || pkg.name === "@pentoshi/clai")) {
          return pkg.version;
        }
      } catch {
        // not here — walk up
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // compiled binary — no package.json nearby
  }
  return GENERATED_VERSION;
}

const CURRENT_VERSION = resolvePackageVersion();
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const CHECK_INTERVAL_MS = UPDATE_CHECK_INTERVAL_MS;

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  published_at: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

function parseVersion(v: string): number[] {
  return v.replace(/^v/, "").split(".").map(Number);
}

function isNewer(remote: string, local: string): boolean {
  const r = parseVersion(remote);
  const l = parseVersion(local);
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) > (l[i] ?? 0)) return true;
    if ((r[i] ?? 0) < (l[i] ?? 0)) return false;
  }
  return false;
}

export function getCurrentVersion(): string {
  return CURRENT_VERSION;
}

/** Fetch the latest release from GitHub (5s timeout, swallows errors) */
async function fetchLatestRelease(): Promise<GitHubRelease | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "clai-updater",
        },
        signal: controller.signal,
      },
    );
    clearTimeout(timeout);
    if (!res.ok) return null;
    return (await res.json()) as GitHubRelease;
  } catch {
    return null;
  }
}

/** Latest published version without the leading `v`, or undefined if unknown. */
export async function fetchLatestVersion(): Promise<string | undefined> {
  const release = await fetchLatestRelease();
  const tag = release?.tag_name?.replace(/^v/, "").trim();
  return tag ? tag : undefined;
}

/** Why an update check cannot run right now, if it cannot. */
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

/** Non-blocking startup check — prints a notice if a new version exists */
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

/** Resolve how this installation was put on the machine (npm/bun/brew/…). */
export async function detectInstallMethodOrDev(): Promise<InstallMethod> {
  try {
    return detectInstallMethod(await resolveInstallEnv());
  } catch {
    return { type: "unknown", detail: "detection failed" };
  }
}

/** Download and install the given version using the detected method. */
export async function installUpdate(
  version: string,
  log?: (line: string) => void,
  stdio: "inherit" | "pipe" = "inherit",
  onProgress?: (progress: UpdateProgress) => void,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message: string; method: string; needsRestart: boolean }> {
  const method = await detectInstallMethodOrDev();
  const result = await performUpdate({
    version,
    method,
    stdio,
    ...(log ? { log } : {}),
    ...(onProgress ? { onProgress } : {}),
    ...(signal ? { signal } : {}),
  });
  return {
    ok: result.ok,
    message: result.message,
    method: result.method,
    needsRestart: result.needsRestart,
  };
}

/** Interactive `clai update` command — performs the upgrade in-process. */
export async function runUpdate(): Promise<void> {
  console.log(chalk.dim("  Checking for updates..."));
  const release = await fetchLatestRelease();

  if (!release) {
    console.log(
      chalk.red("  ✗ Could not reach GitHub. Check your connection."),
    );
    return;
  }

  const remoteVer = release.tag_name.replace(/^v/, "");
  if (!isNewer(release.tag_name, CURRENT_VERSION)) {
    console.log(
      chalk.green(`  ✓ Already on latest version (${CURRENT_VERSION})`),
    );
    updateConfig({ lastUpdateCheck: Date.now() });
    return;
  }

  console.log(
    chalk.yellow(
      `  ⬆ New version available: ${CURRENT_VERSION} → ${remoteVer}`,
    ),
  );
  console.log(chalk.dim(`  Released: ${release.published_at}`));

  try {
    const result = await installUpdate(remoteVer, (line) => console.log(line));
    if (result.ok) {
      console.log(chalk.green(`  ✓ Updated to ${remoteVer} (${result.message})`));
      if (result.needsRestart) {
        console.log(
          chalk.dim("  Restart clai to use the new version."),
        );
      }
    } else {
      console.log(chalk.yellow(`  ${result.message}`));
      console.log(
        chalk.dim(`  Manual: ${release.html_url}`),
      );
    }
    updateConfig({ lastUpdateCheck: Date.now() });
  } catch (error) {
    console.log(
      chalk.red(
        `  ✗ Update failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    console.log(
      chalk.dim(`  Manual: ${release.html_url}`),
    );
  }
}