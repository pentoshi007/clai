import type { SudoAuthOutcome } from "../../tools/sudo-session.js";
export { downloadBinary } from "./download.js";
export { installDirectBinary } from "./native.js";
export { installViaPackageManager } from "./package-managers.js";

export const REPO = "pentoshi007/clai";
export const PACKAGE_NAME = "@pentoshi/clai";
export const DEFAULT_MIRROR_BASE = "https://downloads.clai.aniketpandey.website";
export const ELEVATION_TIMEOUT_MS = 20_000;

export function mirrorBaseUrl(): string {
  return (process.env.CLAI_DOWNLOAD_BASE?.trim() || DEFAULT_MIRROR_BASE).replace(/\/+$/, "");
}

export type InstallMethodType = "npm" | "bun" | "pnpm" | "yarn" | "brew" | "scoop" | "binary" | "dev" | "unknown";

export interface InstallMethod {
  readonly type: InstallMethodType;
  readonly detail: string;
  readonly executablePath?: string;
  readonly packageRoot?: string;
  readonly prefix?: string;
  readonly scope?: "global" | "local";
  readonly managerPath?: string;
  readonly runtimePath?: string;
}

export interface PlatformTarget {
  readonly platform: "darwin" | "linux" | "windows";
  readonly arch: "arm64" | "x64";
  readonly asset: string;
  readonly file: string;
}

export function currentPlatformTarget(platform = process.platform, arch = process.arch): PlatformTarget {
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") throw new Error(`unsupported update OS: ${platform}`);
  if (arch !== "arm64" && arch !== "x64") throw new Error(`unsupported update architecture: ${arch}`);
  const p = platform === "win32" ? "windows" : platform;
  const asset = `clai-bun-${p}-${arch}`;
  return { platform: p, arch, asset, file: `${asset}${p === "windows" ? ".exe" : ""}` };
}

export interface DownloadProgress {
  readonly receivedBytes: number;
  readonly totalBytes?: number | undefined;
}

export interface UpdateInstallResult {
  readonly ok: boolean;
  readonly method: InstallMethodType;
  readonly message: string;
  readonly needsRestart: boolean;
  readonly outcome?: "applied" | "staged";
  readonly installedVersion?: string;
  readonly statusFile?: string;
}

export interface PerformUpdateOptions {
  readonly version: string;
  readonly method: InstallMethod;
  readonly target?: PlatformTarget;
  readonly repo?: string;
  readonly execPath?: string;
  readonly log?: (line: string) => void;
  readonly stdio?: "inherit" | "pipe";
  readonly onProgress?: ((progress: UpdateProgress) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly requestSecret?: SecretRequester | undefined;
  readonly elevation?: UpdateElevation | undefined;
  readonly lockFile?: string;
  readonly lockToken?: string;
}

export type UpdateProgress =
  | { readonly phase: "downloading"; readonly receivedBytes: number; readonly totalBytes?: number | undefined }
  | { readonly phase: "verifying" }
  | { readonly phase: "installing"; readonly detail?: string | undefined };

export interface UpdateElevation {
  readonly auth: SudoAuthOutcome;
}

export type SecretRequester = (request: { title: string; prompt: string }) => Promise<string | undefined>;
