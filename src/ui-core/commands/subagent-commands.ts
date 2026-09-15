import type { CommandInvocation } from "../../app/commands/command.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import { getSubagentModelChain } from "../../store/config.js";
import { openSubagentModelEditor } from "./subagent-models-editor.js";
import type { PickerOption, PickerOptionTone } from "../rendering/picker-filter.js";
import {
  createSubagentPagerSource,
  formatSubagentRun,
  watchSubagents,
} from "../rendering/subagent-source.js";

export const SUBAGENT_STATUS_ICON: Record<string, { icon: string; tone: PickerOptionTone }> = {
  running: { icon: "⟳", tone: "warn" },
  stopping: { icon: "⊗", tone: "warn" },
  completed: { icon: "✓", tone: "success" },
  partial: { icon: "◐", tone: "warn" },
  stopped: { icon: "■", tone: "muted" },
  error: { icon: "✗", tone: "error" },
};

type OrchestrationManager = AppServices["session"]["subagents"];

const ORCHESTRATION_EFFECT = {
  on: "the main agent may delegate independent read-only research; /agents inspects live output",
  off: "subagent tools are disabled; active children stop and new starts or restarts are blocked",
} as const;

const orchestrationNotice = (enabled: boolean): string =>
  `Orchestration ${enabled ? "on" : "off"} · ${ORCHESTRATION_EFFECT[enabled ? "on" : "off"]}`;

const orchestrationOptions = (enabled: boolean): PickerOption[] => {
  const chain = getSubagentModelChain();
  return [
    {
      value: "on",
      label: "On",
      icon: "●",
      tone: "success",
      active: enabled,
      description: "let the main agent delegate independent read-only research",
    },
    {
      value: "off",
      label: "Off",
      icon: "○",
      tone: "muted",
      active: !enabled,
      description: "stop active children and block new starts and restarts",
    },
    {
      value: "models",
      label: "Models…",
      icon: "◇",
      tone: "accent",
      description: chain?.entries.length
        ? `${chain.entries[chain.activeIndex]?.provider ?? chain.entries[0]!.provider}/${chain.entries[chain.activeIndex]?.model ?? chain.entries[0]!.model} · ${chain.entries.length - 1} fallback${chain.entries.length === 2 ? "" : "s"}`
        : "not set · subagents follow the session route",
    },
  ];
};

function applyOrchestration(
  services: AppServices,
  manager: OrchestrationManager,
  enabled: boolean,
): void {
  if (services.session.subagents !== manager) return;
  services.session.setOrchestrationEnabled(enabled);
  services.session.notice("info", orchestrationNotice(enabled));
}

export function openSubagentRun(
  services: AppServices,
  manager: OrchestrationManager,
  id: string,
): boolean {
  const run = manager.get(id);
  if (!run) {
    services.session.notice("warn", `Unknown subagent: ${id}`);
    return false;
  }
  return services.overlay.openPager(
    `${run.title} · ${id}`,
    formatSubagentRun(run),
    createSubagentPagerSource(manager, id),
    undefined,
    "force",
  );
}

export function handleOrchestration(services: AppServices, invocation: CommandInvocation): void {
  const manager = services.session.subagents;
  const action = invocation.args.trim().toLowerCase();
  if (action === "on" || action === "off") {
    applyOrchestration(services, manager, action === "on");
    return;
  }
  if (action === "status") {
    services.session.notice("info", orchestrationNotice(manager.enabled));
    return;
  }
  if (action === "models") {
    void openSubagentModelEditor(services);
    return;
  }
  if (action !== "") {
    services.session.notice("warn", "usage: /orchestrator [on|off|status|models]");
    return;
  }
  services.overlay.openPicker(
    {
      title: `Orchestration · ${manager.enabled ? "on" : "off"}`,
      twoLine: true,
      searchDescription: true,
      options: orchestrationOptions(manager.enabled),
    },
    (value) => {
      services.overlay.close();
      if (value === "models") void openSubagentModelEditor(services);
      else applyOrchestration(services, manager, value === "on");
    },
  );
}

export function handleAgents(services: AppServices, invocation: CommandInvocation): void {
  const manager = services.session.subagents;
  const args = invocation.args.trim().split(/\s+/).filter(Boolean);
  if (args[0] === "stop" || args[0] === "restart") {
    if (args.length !== 2) {
      services.session.notice("warn", "usage: /agents [id|stop id|restart id]");
      return;
    }
    try {
      if (args[0] === "restart" && !manager.enabled) {
        services.session.notice("warn", "Orchestration is off. Use /orchestrator on before restarting an agent.");
        return;
      }
      if (!manager.get(args[1]!)) throw new Error(`Unknown subagent: ${args[1]}`);
      if (args[0] === "stop") manager.stop(args[1]!);
      else services.session.restartSubagent(args[1]!);
      services.session.notice("info", `${args[0]} requested · ${args[1]}`);
    } catch (error) {
      services.session.notice("warn", error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (args.length > 1) {
    services.session.notice("warn", "usage: /agents [id|stop id|restart id]");
    return;
  }

  if (args[0] === "main") return;
  let selectedId = "main";
  const options = (): PickerOption[] => [
    { value: "main", label: "Main agent", active: selectedId === "main", icon: "◆", tone: "accent", description: "Return to the conversation; all running work continues" },
    ...manager.list().map((run) => {
      const status = SUBAGENT_STATUS_ICON[run.status] ?? { icon: "•", tone: "muted" as const };
      return {
        value: run.id,
        active: selectedId === run.id,
        icon: status.icon,
        tone: status.tone,
        label: run.title,
        description: `${run.status} · ${run.id} · attempt ${run.attempt} · ${run.provider}/${run.model}`,
      };
    }),
  ];
  const select = (id: string): void => {
    if (services.session.subagents !== manager) return;
    if (id === "main") services.overlay.close();
    else {
      selectedId = id;
      services.overlay.replacePickerOptions(options());
      openSubagentRun(services, manager, id);
    }
  };
  const opened = args[0]
    ? openSubagentRun(services, manager, args[0])
    : services.overlay.openPicker({ title: "Agents", twoLine: true, searchDescription: true, options: options() }, select);
  if (!opened) return;

  let signature = JSON.stringify(options());
  const refresh = (): void => {
    const state = services.overlay.getState();
    if (state.kind !== "picker" || state.onSelect !== select) return;
    const next = options();
    const nextSignature = JSON.stringify(next);
    if (nextSignature === signature) return;
    signature = nextSignature;
    services.overlay.replacePickerOptions(next);
  };
  const stopWatching = watchSubagents(manager, refresh);
  const stopSession = services.session.subscribe(() => {
    if (services.session.subagents === manager) return;
    services.overlay.close();
    if (services.overlay.getState().kind === "picker") services.overlay.close();
    cleanup();
  });
  const stopOverlay = services.overlay.subscribe(() => {
    if (services.overlay.getState().kind === "none") cleanup();
    else refresh();
  });
  function cleanup(): void {
    stopWatching();
    stopSession();
    stopOverlay();
  }
}
