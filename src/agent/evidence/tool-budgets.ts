

export function isScaffoldCreateCommand(cmd: string): boolean {
  return /\b(?:npm\s+create|npm\s+init|yarn\s+create|pnpm\s+create|bun\s+create|npx\s+(?:--yes\s+)?create-[\w-]+|create-vite|create-next-app|create-react-app|cargo\s+new|cargo\s+init|go\s+mod\s+init|poetry\s+new|django-admin\s+startproject|rails\s+new|composer\s+create-project|mix\s+new|flutter\s+create|dotnet\s+new)\b/i.test(
    cmd,
  );
}

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
    let ms = Math.floor(requested);
    const cmd = typeof call.args.command === "string" ? call.args.command : "";
    const isLongRunning = isLongRunningTestOrBuildCommand(cmd) || isLongQuietInstallOrScaffoldCommand(cmd);
    if (isLongRunning && ms > 0 && ms < 1000) {
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

export function toolStallBudgetMs(call: {
  name: string;
  args: Record<string, unknown>;
}): number {
  return requestedToolTimeoutMs(call) + OUTER_STALL_SETTLE_MARGIN_MS;
}

export function toolHardBudgetMs(call: {
  name: string;
  args: Record<string, unknown>;
}): number {
  return requestedToolTimeoutMs(call) + OUTER_STALL_SETTLE_MARGIN_MS;
}
