import type { CommandInvocation } from "../../app/commands/command.js";
import { detectRea, reaMaintenance, reaRoot, subscribeReaProgress } from "../../rea/install.js";
import { manageRea, type ReaAction } from "../../rea/runtime.js";
import { REA_SERVER, REA_TOKEN } from "../../rea/workflow.js";
import type { ReaStatus } from "../../rea/types.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import { composerActionPort } from "../composer/composer-action-port.js";
import type { PickerOption } from "../rendering/picker-filter.js";

const ACTIONS: Readonly<Record<string, ReaAction>> = {
  install: "install", setup: "setup", update: "update", use: "enable", on: "enable", enable: "enable",
  off: "disable", disable: "disable", reconnect: "reconnect", status: "status", guide: "guide", help: "guide",
};

function attach(services: AppServices): void {
  if (composerActionPort.insert(`${REA_TOKEN} `)) services.focus.focusRegion("composer");
  else services.session.notice("info", "REA enabled · include /rea in a prompt or let the agent choose it when relevant");
}

async function runAction(services: AppServices, command: string, action: ReaAction): Promise<void> {
  const sessionId = services.session.sessionId;
  if ((action === "disable" || action === "reconnect") && services.session.getState().running) {
    services.session.notice("warn", "wait for the running turn to finish before stopping or reconnecting REA");
    return;
  }
  if (action === "guide") {
    const result = await manageRea(services.mcp, action);
    if (services.session.sessionId === sessionId) services.overlay.openPager("REA · workflow", result.output, undefined, undefined, "plain");
    return;
  }
  const maintenance = action === "install" || action === "setup" || action === "update";
  if (maintenance && reaMaintenance()) {
    services.session.notice("info", "REA installation/update is already running · /rea status shows its state");
    return;
  }
  const toastKey = `rea-${action}`;
  let toastId = action === "status" ? undefined : services.toast.info(maintenance ? "Preparing REA…" : "Connecting REA…", { key: toastKey, sticky: true });
  const unsubscribe = maintenance ? subscribeReaProgress((root, progress) => {
    if (root !== reaRoot()) return;
    const percent = progress.totalBytes ? ` ${Math.round((progress.receivedBytes ?? 0) / progress.totalBytes * 100)}%` : "";
    toastId = services.toast.info(`${progress.message}${percent}…`, { key: toastKey, sticky: true });
  }) : () => undefined;
  try {
    let result = await manageRea(services.mcp, action === "setup" ? "install" : action);
    if (services.session.sessionId !== sessionId) return;
    if (action === "setup" && result.ok) result = await manageRea(services.mcp, "enable");
    if (services.session.sessionId !== sessionId) return;
    if (result.ok && action === "enable") {
      if (command === "use") attach(services);
      else services.session.notice("info", "REA enabled · agent can now use its tools · /rea use attaches it to your draft");
    } else if (result.ok && (action === "setup" || action === "reconnect")) {
      services.session.notice("info", "REA connected · /rea use attaches it to a prompt · the agent can also select it automatically");
    } else services.session.notice(result.ok ? "info" : "warn", result.output);
  } catch (error) {
    services.session.notice("warn", `REA failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    unsubscribe();
    if (toastId !== undefined) services.toast.dismiss(toastId);
  }
}

function options(services: AppServices, status?: ReaStatus): PickerOption[] {
  const maintenance = reaMaintenance();
  const state = services.mcp.getState();
  const server = state.snapshot.statuses.find((entry) => entry.name === REA_SERVER);
  const enabled = server?.status === "ready" && (state.selection.mode === "all" || (state.selection.mode === "servers" && state.selection.serverNames.includes(REA_SERVER)));
  const ready = status?.state === "ready";
  const description = maintenance ? maintenance.progress?.message ?? `${maintenance.action} in progress` : !status ? "checking the private installation" : ready ? `REA ${status.installation.version} · ${server?.status ?? "not started (lazy)"}${server ? ` · ${server.toolCount} tools` : ""}` : status.state === "broken" ? status.reason : "no Node/npm/npx required · installs privately for clai";
  return [
    { value: "refresh", label: maintenance ? "REA maintenance in progress…" : ready ? `REA ${status.installation.version}` : status?.state === "broken" ? "REA needs repair" : "REA not installed", icon: "◇", tone: ready ? "accent" : "warn", description },
    ...(maintenance || !status ? [] : [
      { value: "setup", label: ready ? "Set up / connect REA" : "Install & set up REA", icon: "↓", tone: "accent" as const, description: "verified official release · private runtime fallback · no other agents changed" },
      ...(ready ? [
        { value: "use", label: "Use REA in composer", icon: "●", tone: "success" as const, active: enabled, description: "attach /rea to your draft · keep the current analysis if already connected" },
        { value: "update", label: "Update to latest version", icon: "↻", tone: "accent" as const, description: "stage and verify the latest release · active analysis is not interrupted" },
        { value: "reconnect", label: "Reconnect REA", icon: "⟳", description: "repair an observed connection error or adopt an update · resets the current analysis" },
      ] : []),
    ]),
    { value: "off", label: "Disable REA", icon: "○", active: !enabled, description: "stop its managed server for this session · leave other MCP servers alone" },
    { value: "guide", label: "How and when to use REA", icon: "?", description: "focused schemas, compact Evidence, prerequisites and recovery" },
  ];
}

function openPicker(services: AppServices): void {
  const sessionId = services.session.sessionId;
  let generation = 0;
  const refresh = (): void => {
    const current = ++generation;
    void detectRea().then((status) => {
      const overlay = services.overlay.getState();
      if (services.session.sessionId === sessionId && current === generation && overlay.kind === "picker" && overlay.onSelect === onSelect) {
        services.overlay.replacePickerOptions(options(services, status), "REA · Reverse Engineer Anything");
      }
    }).catch((error: unknown) => {
      if (services.session.sessionId === sessionId) services.session.notice("warn", `REA detection failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const onSelect = (value: string): void => {
    if (value === "refresh") { refresh(); return; }
    services.overlay.close();
    const action = ACTIONS[value];
    if (action) void runAction(services, value, action);
  };
  services.overlay.openPicker({
    title: "REA · Reverse Engineer Anything", twoLine: true, searchDescription: true, preserveSelection: true,
    options: options(services),
  }, onSelect);
  refresh();
}

export async function handleRea(services: AppServices, invocation: CommandInvocation): Promise<void> {
  const args = invocation.args.trim();
  if (!args) { openPicker(services); return; }
  const action = ACTIONS[args.toLowerCase()];
  if (action) { void runAction(services, args.toLowerCase(), action); return; }
  const prompt = `${REA_TOKEN} ${args}`;
  if (services.session.getState().running) services.session.enqueue(prompt);
  else await services.session.submit(prompt);
}
