import type { JobStatus } from "../../tools/jobs/types.js";
import type { ToolStatus } from "../state/transcript-types.js";

export type PagerCommandTone = "running" | "success" | "failed";

export function pagerCommandTone(status: ToolStatus | JobStatus | undefined, exitCode?: number): PagerCommandTone {
  if (status === "ok" || status === "exited" && exitCode === 0) return "success";
  if (status === "failed" || status === "blocked" || status === "killed" || status === "lost" || status === "exited") return "failed";
  return "running";
}

export function pagerCommandColor(tone: PagerCommandTone): "success" | "userBorder" | "diffDel" {
  if (tone === "success") return "success";
  return tone === "failed" ? "diffDel" : "userBorder";
}

export interface PagerBodyRegions {
  readonly inputEnd?: number | undefined;
  readonly inputTone?: PagerCommandTone | undefined;
  readonly codeStart?: number | undefined;
  readonly codeEnd?: number | undefined;
  readonly codeOnEveryPage?: boolean | undefined;
}

export function pagerRegionsForPage(
  regions: PagerBodyRegions | undefined,
  pageOffset: number | undefined,
): PagerBodyRegions | undefined {
  if (!regions) return undefined;
  if (!pageOffset) return regions;
  return regions.codeOnEveryPage ? { codeStart: 0 } : undefined;
}
