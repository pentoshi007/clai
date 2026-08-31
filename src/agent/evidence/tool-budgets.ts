

/** One-shot scaffolders — must NEVER be treated as "start the dev server". Stack-agnostic. */
export function isScaffoldCreateCommand(cmd: string): boolean {
  return /\b(?:npm\s+create|npm\s+init|yarn\s+create|pnpm\s+create|bun\s+create|npx\s+(?:--yes\s+)?create-[\w-]+|create-vite|create-next-app|create-react-app|cargo\s+new|cargo\s+init|go\s+mod\s+init|poetry\s+new|django-admin\s+startproject|rails\s+new|composer\s+create-project|mix\s+new|flutter\s+create|dotnet\s+new)\b/i.test(
    cmd,
  );
}

/**
 * Commands that legitimately sit quiet for minutes (npm install, create-next-app).
 * Must not be killed by the short "no output" stall watchdog.
 */
export function isLongQuietInstallOrScaffoldCommand(cmd: string): boolean {
  if (!cmd.trim()) return false;
  if (isScaffoldCreateCommand(cmd)) return true;
  return (
    /\b(?:npm|pnpm|yarn|bun)\s+i(?:nstall)?\b/i.test(cmd) ||
    /\b(?:npm|pnpm|yarn|bun)\s+(?:ci|update)\b/i.test(cmd) ||
    /\bpip(?:3)?\s+install\b/i.test(cmd) ||
    /\bpoetry\s+install\b/i.test(cmd) ||
    /\bcomposer\s+install\b/i.test(cmd) ||
    /\bbundle\s+install\b/i.test(cmd) ||
    /\bcargo\s+(?:build|fetch|install)\b/i.test(cmd) ||
    /\bgo\s+mod\s+(?:download|tidy)\b/i.test(cmd) ||
    /\bdotnet\s+restore\b/i.test(cmd)
  );
}

/**
 * Commands that are long-running but produce output (tests, builds, lint).
 * These need a longer hard timeout than the 40s default, but should still
 * be killed by the stall watchdog if they go quiet.
 */
export function isLongRunningTestOrBuildCommand(cmd: string): boolean {
  if (!cmd.trim()) return false;
  return (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+test|run\s+build|build|lint)\b/i.test(cmd) ||
    /\bvitest\b/i.test(cmd) ||
    /\bjest\b/i.test(cmd) ||
    /\bmocha\b/i.test(cmd) ||
    /\bplaywright\s+test\b/i.test(cmd) ||
    /\bcypress\s+run\b/i.test(cmd) ||
    /\btsc\b.*--noEmit/i.test(cmd) ||
    /\bnpx\s+tsc\b/i.test(cmd)
  );
}

/** Default wall-clock budget for every tool unless the model overrides it. */
export const DEFAULT_TOOL_TIMEOUT_MS = 40_000;

const MIN_TOOL_TIMEOUT_MS = 1_000;

const MAX_TOOL_TIMEOUT_MS = 30 * 60_000;

function requestedToolTimeoutMs(call: {
  name: string;
  args: Record<string, unknown>;
}): number {
  let requested: number | undefined;
  const raw = call.args.timeoutMs;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    requested = raw;
  } else if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) requested = parsed;
  }
  if (requested !== undefined) {
    // Heuristic: if value is small (< 1000) and looks like seconds (e.g. 300 for 300s),
    // treat it as seconds and convert to ms. This handles models that confuse units.
    // Values >= 1000 are treated as ms (e.g. 300000 for 300s).
    // We only apply this for values that would otherwise be clamped to 1s but
    // the command is long-running - otherwise respect the ms value.
    let ms = Math.floor(requested);
    // If value is between 1 and 1000, it could be seconds (e.g. 300 = 300s) or ms (300ms)
    // For long-running commands, treat small values as seconds to avoid 0.3s timeout for 300s intent
    const cmd = typeof call.args.command === "string" ? call.args.command : "";
    const isLongRunning = isLongRunningTestOrBuildCommand(cmd) || isLongQuietInstallOrScaffoldCommand(cmd);
    if (isLongRunning && ms > 0 && ms < 1000) {
      // Likely seconds - convert to ms (e.g. 300 -> 300000ms = 300s)
      // But if it's 60, that would be 60s = 60000ms, which is reasonable
      // If it's 300, that would be 300s = 300000ms
      ms = ms * 1000;
    }
    return Math.max(
      MIN_TOOL_TIMEOUT_MS,
      Math.min(MAX_TOOL_TIMEOUT_MS, ms),
    );
  }

  const cmd = typeof call.args.command === "string" ? call.args.command : "";
  if (
    call.name === "pkg.install" ||
    (call.name === "shell.exec" && isLongQuietInstallOrScaffoldCommand(cmd))
  ) {
    return 15 * 60_000;
  }
  if (call.name === "net.scan" || call.name === "pentest.recon") {
    return 15 * 60_000;
  }
  if (call.name === "pentest.webDiscover") return 8 * 60_000;
  if (call.name === "pentest.apiEnumerate") return 2 * 60_000;
  if (call.name === "pentest.authCompare") return 3 * 60_000;
  if (call.name === "shell.exec" && isLongRunningTestOrBuildCommand(cmd)) {
    return 120_000;
  }
  if (call.name.startsWith("mcp.")) return 60_000;
  return DEFAULT_TOOL_TIMEOUT_MS;
}

const OUTER_STALL_SETTLE_MARGIN_MS = 2_500;

/**
 * Silence cancellation leaves a short margin for a tool's own timeout handler
 * to return its richer result. The hard wall-clock watchdog still enforces the
 * exact model-selected deadline.
 */
export function toolStallBudgetMs(call: {
  name: string;
  args: Record<string, unknown>;
}): number {
  return requestedToolTimeoutMs(call) + OUTER_STALL_SETTLE_MARGIN_MS;
}

/**
 * Hard wall-clock watchdog for every tool call. Local implementations enforce
 * the selected deadline; this outer fallback waits through the same short
 * settlement margin so their timeout/abort handlers can return a rich result
 * before the runner force-settles an ignored AbortSignal.
 */
export function toolHardBudgetMs(call: {
  name: string;
  args: Record<string, unknown>;
}): number {
  return requestedToolTimeoutMs(call) + OUTER_STALL_SETTLE_MARGIN_MS;
}
