import chalk from "chalk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getConfig, updateConfig } from "../store/config.js";
import { VERSION as GENERATED_VERSION } from "../version.generated.js";
import {
  detectInstallMethod,
  mirrorBaseUrl,
  performUpdate,
  resolveInstallEnv,
  type InstallMethod,
  type SecretRequester,
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
        if (pkg.version && (!pkg.name || pkg.name === "@pentoshi/clai")) {
          return pkg.version;
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

async function fetchLatestReleaseFromGitHub(): Promise<GitHubRelease | null> {
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

async function fetchLatestReleaseFromMirror(): Promise<GitHubRelease | null> {
  if (process.env.CLAI_NO_MIRROR === "1") return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${mirrorBaseUrl()}/version.json`, {
      headers: { "User-Agent": "clai-updater" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    const version = data.version?.trim();
    if (!version) return null;
    return {
      tag_name: `v${version.replace(/^v/, "")}`,
      html_url: `https://github.com/${REPO}/releases/latest`,
      published_at: "",
      assets: [],
    };
  } catch {
    return null;
  }
}

async function fetchLatestRelease(): Promise<GitHubRelease | null> {
  const release = await fetchLatestReleaseFromGitHub();
  return release ?? fetchLatestReleaseFromMirror();
}

export async function fetchLatestVersion(): Promise<string | undefined> {
  const release = await fetchLatestRelease();
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

export async function detectInstallMethodOrDev(): Promise<InstallMethod> {
  try {
    return detectInstallMethod(await resolveInstallEnv());
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
): Promise<{ ok: boolean; message: string; method: string; needsRestart: boolean }> {
  const method = await detectInstallMethodOrDev();
  const result = await performUpdate({
    version,
    method,
    stdio,
    ...(log ? { log } : {}),
    ...(onProgress ? { onProgress } : {}),
    ...(signal ? { signal } : {}),
    ...(requestSecret ? { requestSecret } : {}),
  });
  return {
    ok: result.ok,
    message: result.message,
    method: result.method,
    needsRestart: result.needsRestart,
  };
}

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