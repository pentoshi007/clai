

import { DEFAULT_SHELL_TIMEOUT_MS } from "../../tools/shell/timeout.js";

export function isScaffoldCreateCommand(cmd: string): boolean {
  return /\b(?:npm\s+create|npm\s+init|yarn\s+create|pnpm\s+create|bun\s+create|npx\s+(?:--yes\s+)?create-[\w-]+|create-vite|create-next-app|create-react-app|cargo\s+new|cargo\s+init|go\s+mod\s+init|poetry\s+new|django-admin\s+startproject|rails\s+new|composer\s+create-project|mix\s+new|flutter\s+create|dotnet\s+new)\b/i.test(
    cmd,
  );
}

export function isOsPackageInstallCommand(cmd: string): boolean {
  return /\b(?:brew\s+(?:install|upgrade|reinstall)|(?:apt|apt-get|dnf|yum|zypper)\s+(?:-\S+\s+)*install|pacman\s+(?:-\S*S\S*)|apk\s+add|port\s+install|winget\s+(?:install|upgrade)|choco\s+(?:install|upgrade)|scoop\s+install|snap\s+install)\b/i.test(
    cmd,
  );
}

export function isLongQuietInstallOrScaffoldCommand(cmd: string): boolean {
  if (!cmd.trim()) return false;
  if (isScaffoldCreateCommand(cmd)) return true;
  if (isOsPackageInstallCommand(cmd)) return true;
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
    return Math.max(
      MIN_TOOL_TIMEOUT_MS,
      Math.min(MAX_TOOL_TIMEOUT_MS, Math.floor(requested)),
    );
  }

  if (call.name.startsWith("mcp.")) return 60_000;
  if (call.name === "shell.exec") return DEFAULT_SHELL_TIMEOUT_MS;
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
