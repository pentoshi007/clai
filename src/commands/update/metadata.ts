import { downloadBinary } from "./download.js";
import { mirrorBaseUrl, REPO } from "./installers.js";
import { throwIfCancelled } from "./process.js";
import { releaseVersion } from "./verification.js";

export interface ReleaseMetadata {
  readonly tag_name: string;
  readonly html_url: string;
  readonly published_at: string;
}

async function metadata(url: string, signal?: AbortSignal): Promise<unknown> {
  const bytes = await downloadBinary(url, 5000, undefined, signal, 256 * 1024);
  return JSON.parse(bytes.toString("utf8"));
}

async function releaseFrom(url: string, mirror: boolean, signal?: AbortSignal): Promise<ReleaseMetadata | null> {
  try {
    const value = await metadata(url, signal);
    if (!value || typeof value !== "object") return null;
    const tag = mirror ? ("version" in value ? value.version : undefined) : ("tag_name" in value ? value.tag_name : undefined);
    const version = releaseVersion(tag);
    if (!version) return null;
    const date = "published_at" in value && typeof value.published_at === "string" ? Date.parse(value.published_at) : NaN;
    return {
      tag_name: `v${version}`,
      html_url: `https://github.com/${REPO}/releases/tag/v${version}`,
      published_at: Number.isFinite(date) ? new Date(date).toISOString() : "",
    };
  } catch {
    throwIfCancelled(signal);
    return null;
  }
}

export async function fetchLatestRelease(signal?: AbortSignal): Promise<ReleaseMetadata | null> {
  const release = await releaseFrom(`https://api.github.com/repos/${REPO}/releases/latest`, false, signal);
  if (release || process.env.CLAI_NO_MIRROR === "1") return release;
  return releaseFrom(`${mirrorBaseUrl()}/version.json`, true, signal);
}
