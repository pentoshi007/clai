/**
 * Config/toggles/scope/privacy/help/exit/update (V2-080).
 */

import { getConfig, updateConfig } from "../../store/config.js";
import { installUpdate } from "../../commands/update.js";
import { clearAllHistory } from "../../store/history.js";
import { clearAuditLogs, clearArtifacts } from "../../store/logs.js";
import {
  addSessionScopeTargets,
  clearSessionScope,
  loadScopeForSession,
  normalizeScopeTarget,
  replaceSessionScopeTargets,
  saveSessionScope,
} from "../../store/scope.js";
import { formatShortcutsReference } from "../actions/format-shortcuts.js";
import { formatCommandHelpMarkdown } from "../rendering/format-help.js";
import type { CommandInvocation } from "../../app/commands/command.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import type { PickerOption } from "../rendering/picker-filter.js";

function notice(services: AppServices, level: "info" | "warn", text: string): void {
  services.session.notice(level, text);
}

function parseOnOff(arg: string): boolean | undefined {
  if (/^(on|true|1|enable)$/i.test(arg)) return true;
  if (/^(off|false|0|disable)$/i.test(arg)) return false;
  return undefined;
}

export function handleFreeOnly(services: AppServices, invocation: CommandInvocation): void {
  const arg = invocation.args.trim();
  const flag = parseOnOff(arg);
  if (flag === undefined) {
    notice(services, "info", `freeOnly=${getConfig().freeOnly}`);
    return;
  }
  updateConfig({ freeOnly: flag });
  notice(services, "info", `freeOnly=${flag}`);
}

export function handleFallback(services: AppServices, invocation: CommandInvocation): void {
  const arg = invocation.args.trim();
  const flag = parseOnOff(arg);
  if (flag !== undefined) {
    updateConfig({ providerFallback: flag });
    notice(services, "info", `providerFallback=${flag}`);
    return;
  }
  if (arg) {
    notice(services, "warn", "usage: /fallback [on|off]");
    return;
  }
  const current = getConfig().providerFallback;
  const options: PickerOption[] = [
    {
      value: "on",
      label: "on",
      description: "switch the whole provider when the active one fails",
      active: current,
    },
    {
      value: "off",
      label: "off",
      description: "retry the same provider, then show the error — never auto-switch",
      active: !current,
    },
  ];
  services.overlay.openPicker({ title: "Provider fallback", options }, (value) => {
    updateConfig({ providerFallback: value === "on" });
    notice(services, "info", `providerFallback=${value === "on"}`);
    services.overlay.close();
  });
}

export async function handleScope(
  services: AppServices,
  invocation: CommandInvocation,
): Promise<void> {
  const trimmed = invocation.args.trim();
  const [sub = "", ...parts] = trimmed.split(/\s+/).filter(Boolean);
  const sessionId = services.session.sessionId;

  // Bare `/scope` or `/scope edit` → multi-input modal.
  const openEditor =
    !sub ||
    sub === "edit" ||
    sub === "ui" ||
    (sub === "show" && parts.length === 0) ||
    (sub === "list" && parts.length === 0) ||
    (sub === "ls" && parts.length === 0);

  try {
    if (["clear", "reset", "off"].includes(sub)) {
      await clearSessionScope(sessionId);
      notice(services, "info", "engagement scope cleared for this session · scoping disabled");
      return;
    }
    if (sub === "add") {
      const targets = parts.join(" ").split(/[\s,]+/).filter(Boolean);
      if (!targets.length) {
        notice(services, "warn", "usage: /scope add <target1,target2>");
        return;
      }
      const scope = await addSessionScopeTargets(sessionId, targets);
      notice(
        services,
        "info",
        `scope updated for this session · ${scope.authorizedTargets.join(", ")}`,
      );
      return;
    }
    if (sub === "new" || sub === "set") {
      const targets = parts.join(" ").split(/[\s,]+/).filter(Boolean);
      if (!targets.length) {
        notice(services, "warn", "usage: /scope new <target1,target2>");
        return;
      }
      const scope = await saveSessionScope(sessionId, {
        authorizedTargets: targets.map(normalizeScopeTarget).filter(Boolean),
        createdAt: new Date().toISOString(),
      });
      notice(
        services,
        "info",
        scope
          ? `scope created for this session · ${scope.authorizedTargets.join(", ")}`
          : "no valid targets · scoping still disabled for this session",
      );
      return;
    }

    if (openEditor) {
      const current = await loadScopeForSession(sessionId);
      const initial = current?.authorizedTargets ?? [];
      const result = await services.overlay.openScopeEditor({
        initialTargets: initial,
      });
      if (result === undefined) {
        // Cancelled or another overlay was open.
        return;
      }
      if (result.length === 0) {
        await clearSessionScope(sessionId);
        notice(services, "info", "engagement scope cleared for this session · scoping disabled");
        return;
      }
      // Full replace (not merge) so removed rows stay gone.
      const scope = await replaceSessionScopeTargets(sessionId, result, {
        name: current?.name,
        createdAt: current?.createdAt,
      });
      notice(
        services,
        "info",
        scope
          ? `scope saved for this session · ${scope.authorizedTargets.join(", ")}`
          : "engagement scope cleared for this session · scoping disabled",
      );
      return;
    }

    notice(
      services,
      "warn",
      "usage: /scope  ·  /scope add <targets>  ·  /scope new <targets>  ·  /scope clear",
    );
  } catch (error) {
    notice(services, "warn", error instanceof Error ? error.message : String(error));
  }
}

function openPrivacyOptions(services: AppServices): void {
  const privateMode = Boolean(getConfig().privateMode);
  services.overlay.openPicker(
    {
      title: `Privacy · private mode ${privateMode ? "on" : "off"}`,
      twoLine: true,
      options: [
        {
          value: privateMode ? "off" : "on",
          label: privateMode ? "private mode → off" : "private mode → on",
          description: privateMode
            ? "resume normal history, audit logs and artifact retention"
            : "stop writing prompts and outputs to history, logs and artifacts",
          active: true,
        },
        {
          value: "clear-history",
          label: "clear history",
          description: "drop sessions from the active list (archived, recoverable)",
        },
        {
          value: "clear-logs",
          label: "clear audit logs",
          description: "delete audit log files from disk",
        },
        {
          value: "clear-artifacts",
          label: "clear artifacts",
          description: "delete saved tool-output artifacts from disk",
        },
        {
          value: "clear-all",
          label: "clear everything",
          description: "history, audit logs and artifacts in one pass",
        },
      ],
    },
    (value) => {
      services.overlay.close();
      void applyPrivacy(services, value);
    },
  );
}

export async function handlePrivacy(
  services: AppServices,
  invocation: CommandInvocation,
): Promise<void> {
  const raw = invocation.args.trim();
  if (!raw) {
    openPrivacyOptions(services);
    return;
  }
  await applyPrivacy(services, raw);
}

async function applyPrivacy(services: AppServices, raw: string): Promise<void> {
  const sub = raw.trim().toLowerCase();
  if (["on", "enable"].includes(sub)) {
    updateConfig({ privateMode: true });
    notice(services, "info", "private mode → on");
    return;
  }
  if (["off", "disable"].includes(sub)) {
    updateConfig({ privateMode: false });
    notice(services, "info", "private mode → off");
    return;
  }
  if (sub === "status") {
    notice(services, "info", `private mode: ${getConfig().privateMode ? "on" : "off"}`);
    return;
  }
  if (sub === "clear-history") {
    const result = await clearAllHistory();
    notice(
      services,
      "info",
      `history cleared from active list · ${result.detail || "ok"} (archived — not permanently destroyed)`,
    );
    return;
  }
  if (sub === "clear-logs") {
    const result = await clearAuditLogs();
    notice(services, "info", `audit logs cleared · ${result.removed} files`);
    return;
  }
  if (sub === "clear-artifacts") {
    const result = await clearArtifacts();
    notice(services, "info", `artifacts cleared · ${result.removed} files`);
    return;
  }
  if (sub === "clear-all") {
    const [historyResult, logResult, artifactResult] = await Promise.all([
      clearAllHistory(),
      clearAuditLogs(),
      clearArtifacts(),
    ]);
    notice(
      services,
      "info",
      `cleared history (${historyResult.detail || "ok"}), logs (${logResult.removed}), artifacts (${artifactResult.removed})`,
    );
    return;
  }
  notice(
    services,
    "warn",
    "usage: /privacy  ·  /privacy [status|on|off|clear-history|clear-logs|clear-artifacts|clear-all]",
  );
}

const UPDATE_TOAST_KEY = "update";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function progressBar(fraction: number, width = 14): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

export async function handleUpdate(services: AppServices): Promise<void> {
  const sticky = (message: string): void => {
    services.toast.info(message, { key: UPDATE_TOAST_KEY, sticky: true });
  };
  const settle = (
    level: "success" | "warn" | "error",
    message: string,
  ): void => {
    services.toast[level](message, {
      key: UPDATE_TOAST_KEY,
      durationMs: level === "success" ? 6000 : 14_000,
    });
  };

  if (services.interruptible.hasWork()) {
    settle("warn", "an update is already in progress");
    return;
  }
  const controller = services.interruptible.begin();
  sticky("checking for updates…");
  try {
    const status = await services.ports.updates.check();
    if (controller.signal.aborted) {
      settle("warn", "update cancelled");
      return;
    }
    if (status.state !== "update-available" || !status.latestVersion) {
      if (status.state === "current") {
        settle("success", `up to date · v${status.currentVersion}`);
      } else {
        settle(
          "warn",
          `update status unknown · v${status.currentVersion}${status.detail ? ` (${status.detail})` : ""}`,
        );
      }
      return;
    }

    const target = status.latestVersion;
    const route = `v${status.currentVersion} → v${target}`;
    services.toast.success(`new version available · v${target}`, {
      key: "update-found",
    });
    sticky(`${route} · downloading…`);

    let lastPaint = 0;
    let downloadAnnounced = false;
    const result = await installUpdate(
      target,
      (line) => {
        const clean = line
          // eslint-disable-next-line no-control-regex
          .replace(/\x1b\[[0-9;]*m/g, "")
          .replace(/\s+/g, " ")
          .trim();
        if (clean && !/^[⬇🔐✓]/u.test(clean)) sticky(`${route} · ${clean}`);
      },
      "pipe",
      (progress) => {
        if (progress.phase === "verifying") {
          sticky(`${route} · verifying checksum…`);
          return;
        }
        if (progress.phase === "installing") {
          sticky(`${route} · installing v${target}…`);
          return;
        }
        const now = Date.now();
        const complete =
          progress.totalBytes !== undefined &&
          progress.receivedBytes >= progress.totalBytes;
        if (!complete && now - lastPaint < 120) return;
        lastPaint = now;
        if (progress.totalBytes === undefined) {
          sticky(
            `${route} · downloading ${formatBytes(progress.receivedBytes)}…`,
          );
          return;
        }
        const fraction = progress.receivedBytes / progress.totalBytes;
        sticky(
          `${route} · downloading ${progressBar(fraction)} ${Math.round(fraction * 100)}% · ${formatBytes(progress.receivedBytes)}/${formatBytes(progress.totalBytes)}`,
        );
        if (complete && !downloadAnnounced) {
          downloadAnnounced = true;
          services.toast.success(
            `downloaded v${target} · ${formatBytes(progress.receivedBytes)}`,
            { key: "update-downloaded" },
          );
        }
      },
      controller.signal,
      services.ports.requestSecret ?? undefined,
    );

    if (!result.ok) {
      settle("warn", `update not applied · ${result.message}`);
      return;
    }
    updateConfig({ lastUpdateCheck: Date.now() });
    settle("success", `updated to v${target} · restarting…`);
    // Let the success toast paint before the renderer tears down.
    setTimeout(() => services.requestExit(), 1200);
  } catch (error) {
    if (controller.signal.aborted) {
      settle("warn", "update cancelled");
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("update cancelled")) {
      settle("warn", message);
      return;
    }
    settle("error", `update failed · ${message}`);
  } finally {
    services.interruptible.end(controller);
  }
}

export function handleHelp(services: AppServices): void {
  services.overlay.openPager(
    "Commands",
    formatCommandHelpMarkdown(services.commands.help()),
    undefined,
    undefined,
    "force",
  );
}

export function handleShortcuts(services: AppServices): void {
  services.overlay.openPager(
    "Keyboard shortcuts",
    formatShortcutsReference(),
    undefined,
    undefined,
    "force",
  );
}

export function handleExit(services: AppServices): void {
  services.requestExit();
}

export function handleJobs(services: AppServices): void {
  services.overlay.openJobs();
}
