/**
 * Config/toggles/scope/privacy/help/exit/update/mouse (V2-080).
 */

import { getConfig, updateConfig } from "../../../store/config.js";
import { clearAllHistory } from "../../../store/history.js";
import { clearAuditLogs, clearArtifacts } from "../../../store/logs.js";
import {
  addScopeTargets,
  clearScope,
  loadScope,
  saveScope,
} from "../../../store/scope.js";
import { slashCommands } from "../../../repl/slash-commands.js";
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

export function handleMouse(services: AppServices, invocation: CommandInvocation): void {
  const arg = invocation.args.trim().toLowerCase();
  // v2 is fullscreen with pane-scoped selection — there is no broken dual mode
  // (FEATURE_PARITY /mouse). Report status; on/off is informational only.
  if (!arg || parseOnOff(arg) !== undefined) {
    notice(
      services,
      "info",
      "mouse=on · touch/click scroll + open tools/prompts (drag-select disabled so interactions work)",
    );
    return;
  }
  notice(services, "warn", "usage: /mouse [on|off]");
}

export async function handleScope(
  services: AppServices,
  invocation: CommandInvocation,
): Promise<void> {
  const [sub = "show", ...parts] = invocation.args.split(/\s+/).filter(Boolean);
  try {
    if (["clear", "reset", "off"].includes(sub)) {
      await clearScope();
      notice(services, "info", "engagement scope cleared");
      return;
    }
    if (sub === "show" || sub === "list" || sub === "ls") {
      const scope = await loadScope();
      notice(
        services,
        "info",
        scope
          ? `scope: ${scope.name ?? "unnamed"} · ${scope.authorizedTargets.join(", ")}`
          : "no engagement scope configured",
      );
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
    notice(services, "warn", "usage: /scope [show|clear|new <targets>|add <targets>]");
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
    if (status.updateAvailable && status.latestVersion) {
      notice(
        services,
        "info",
        `update available: ${status.currentVersion} → ${status.latestVersion} · run \`clai update\` outside the TUI`,
      );
    } else {
      notice(services, "info", `up to date · ${status.currentVersion}`);
    }
  } catch (error) {
    notice(
      services,
      "warn",
      `update check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function handleHelp(services: AppServices): void {
  const body = slashCommands
    .map(
      (item) =>
        `${item.command}${item.usage ? ` ${item.usage}` : ""}  —  ${item.description}`,
    )
    .join("\n");
  services.overlay.openPager("Command reference", body);
}

export function handleExit(services: AppServices): void {
  services.requestExit();
}

export function handleJobs(services: AppServices): void {
  services.overlay.openJobs();
}
