import chalk from "chalk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getConfig, updateConfig } from "../store/config.js";

const REPO = "pentoshi007/clai";

/**
 * Resolve the running version from the installed package.json so the banner,
 * `--version`, and the update checker always report the ACTUAL installed
 * build — never a hardcoded constant that drifts after `npm i -g`. Walks up
 * from this module to find the nearest package.json (works in dev via tsx and
 * in the compiled dist layout). Falls back to a baked constant only if the
 * file can't be read.
 */
const FALLBACK_VERSION = "2.0.5";

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
    // ignore — use fallback
  }
  return FALLBACK_VERSION;
}

const CURRENT_VERSION = resolvePackageVersion();
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

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

/** Interactive update command */
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
  console.log(chalk.dim(`  Released: ${release.published_at}\n`));

  // Detect install method and give specific instructions
  const methods = detectInstallMethod();

  if (methods.includes("npm")) {
    console.log(chalk.cyan("  npm:"));
    console.log(chalk.white("    npm update -g clai\n"));
  }
  if (methods.includes("brew")) {
    console.log(chalk.cyan("  Homebrew:"));
    console.log(chalk.white("    brew upgrade clai\n"));
  }

  // Always show binary download for the current platform
  const platform =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "windows"
        : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const suffix = platform === "windows" ? ".exe" : "";
  const assetName = `clai-bun-${platform}-${arch}${suffix}`;
  const asset = release.assets.find((a) => a.name === assetName);
  if (asset) {
    console.log(chalk.cyan("  Direct download:"));
    if (platform === "windows") {
      console.log(
        chalk.white(
          `    curl -fsSL ${asset.browser_download_url} -o %LOCALAPPDATA%\\\\clai\\\\clai.exe\n`,
        ),
      );
    } else {
      console.log(
        chalk.white(
          `    curl -fsSL ${asset.browser_download_url} -o /usr/local/bin/clai && chmod +x /usr/local/bin/clai\n`,
        ),
      );
    }
  }

  console.log(chalk.cyan("  GitHub release:"));
  console.log(chalk.white(`    ${release.html_url}\n`));
  console.log(
    chalk.dim("  After updating, restart clai to use the new version."),
  );
  updateConfig({ lastUpdateCheck: Date.now() });
}

function detectInstallMethod(): string[] {
  const methods: string[] = [];
  const argv1 = process.argv[1] ?? "";
  // npm global install paths
  if (argv1.includes("node_modules") || argv1.includes("npm"))
    methods.push("npm");
  if (process.platform === "darwin") methods.push("brew");
  methods.push("binary");
  return methods;
}
