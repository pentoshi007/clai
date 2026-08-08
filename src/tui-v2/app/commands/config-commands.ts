/**
 * Config/toggles/scope/privacy/help/exit/update (V2-080).
 */

import { getConfig, updateConfig } from "../../../store/config.js";
import { installUpdate } from "../../../commands/update.js";
import { clearAllHistory } from "../../../store/history.js";
import { clearAuditLogs, clearArtifacts } from "../../../store/logs.js";
import {
  addScopeTargets,
  clearScope,
  loadScope,
  replaceScopeTargets,
  saveScope,
} from "../../../store/scope.js";
import { formatShortcutsReference } from "../../actions/format-shortcuts.js";
import { formatCommandHelpMarkdown } from "../../rendering/format-help.js";
import type { CommandInvocation } from "../../../app/commands/command.js";
import type { AppServices } from "../../bootstrap/composition-root.js";

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
  if (flag === undefined) {
    notice(services, "info", `providerFallback=${getConfig().providerFallback}`);
    return;
  }
  updateConfig({ providerFallback: flag });
  notice(services, "info", `providerFallback=${flag}`);
}

export async function handleScope(
  services: AppServices,
  invocation: CommandInvocation,
): Promise<void> {
  const trimmed = invocation.args.trim();
  const [sub = "", ...parts] = trimmed.split(/\s+/).filter(Boolean);

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
      await clearScope();
      notice(services, "info", "engagement scope cleared · scoping disabled");
      return;
    }
    if (sub === "add") {
      const targets = parts.join(" ").split(/[\s,]+/).filter(Boolean);
      if (!targets.length) {
        notice(services, "warn", "usage: /scope add <target1,target2>");
        return;
      }
      const scope = await addScopeTargets(targets);
      notice(services, "info", `scope updated · ${scope.authorizedTargets.join(", ")}`);
      return;
    }
    if (sub === "new" || sub === "set") {
      const targets = parts.join(" ").split(/[\s,]+/).filter(Boolean);
      if (!targets.length) {
        notice(services, "warn", "usage: /scope new <target1,target2>");
        return;
      }
      await saveScope({
        authorizedTargets: targets,
        createdAt: new Date().toISOString(),
      });
      notice(services, "info", `scope created · ${targets.join(", ")}`);
      return;
    }

    if (openEditor) {
      const current = await loadScope();
      const initial = current?.authorizedTargets ?? [];
      const result = await services.overlay.openScopeEditor({
        initialTargets: initial,
      });
      if (result === undefined) {
        // Cancelled or another overlay was open.
        return;
      }
      if (result.length === 0) {
        await clearScope();
        notice(services, "info", "engagement scope cleared · scoping disabled");
        return;
      }
      // Full replace (not merge) so removed rows stay gone.
      const scope = await replaceScopeTargets(result, {
        name: current?.name,
        createdAt: current?.createdAt,
      });
      notice(
        services,
        "info",
        scope
          ? `scope saved · ${scope.authorizedTargets.join(", ")}`
          : "engagement scope cleared · scoping disabled",
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

export async function handlePrivacy(
  services: AppServices,
  invocation: CommandInvocation,
): Promise<void> {
  const sub = (invocation.args.trim() || "status").toLowerCase();
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
    "usage: /privacy [status|on|off|clear-history|clear-logs|clear-artifacts|clear-all]",
  );
}

export async function handleUpdate(services: AppServices): Promise<void> {
  try {
    const status = await services.ports.updates.check();
    if (status.state !== "update-available" || !status.latestVersion) {
      if (status.state === "current") {
        notice(services, "info", `up to date · ${status.currentVersion}`);
      } else {
        notice(
          services,
          "warn",
          `update status unknown · ${status.currentVersion}${status.detail ? ` (${status.detail})` : ""}`,
        );
      }
      return;
    }

    const target = status.latestVersion;
    notice(services, "info", `updating ${status.currentVersion} → ${target}…`);
    const result = await installUpdate(target, (line) => {
      const clean = line
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;]*m/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (clean) notice(services, "info", `update: ${clean}`);
    }, "pipe");

    if (!result.ok) {
      notice(services, "warn", `update not applied · ${result.message}`);
      return;
    }
    notice(services, "info", `updated to ${target} · restarting…`);
    updateConfig({ lastUpdateCheck: Date.now() });
    // Let the success toast paint before the renderer tears down.
    setTimeout(() => services.requestExit(), 900);
  } catch (error) {
    notice(
      services,
      "warn",
      `update failed: ${error instanceof Error ? error.message : String(error)}`,
    );
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
