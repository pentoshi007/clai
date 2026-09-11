import type { CommandInvocation } from "../../app/commands/command.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import {
  createSubagentPagerSource,
  formatSubagentRun,
  watchSubagents,
} from "../rendering/subagent-source.js";

export function handleOrchestration(services: AppServices, invocation: CommandInvocation): void {
  const action = invocation.args.trim().toLowerCase();
  if (!["", "status", "on", "off"].includes(action)) {
    services.session.notice("warn", "usage: /orchestration [on|off|status]");
    return;
  }
  const manager = services.session.subagents;
  const apply = (value: string): void => {
    if (services.session.subagents !== manager) return;
    if (value === "on" || value === "off") services.session.setOrchestrationEnabled(value === "on");
    services.session.notice(
      "info",
      `Orchestration ${manager.enabled ? "on" : "off"} · session-only, default off. When enabled, the main agent can delegate independent assignments to background subagents. /agents inspects their live output. Turning off stops active children and prevents new starts/restarts.`,
    );
  };
  if (action === "") {
    services.overlay.openPicker({
      title: `Orchestration · ${manager.enabled ? "on" : "off"}`,
      twoLine: true,
      searchDescription: true,
      options: [
        { value: "status", label: "Status", description: "Show the current session setting without changing it" },
        { value: "on", label: "On", description: "Allow the main agent to delegate independent read-only research for this session" },
        { value: "off", label: "Off", description: "Stop active subagents and prevent new starts or restarts" },
      ],
    }, (value) => {
      services.overlay.close();
      apply(value);
    });
    return;
  }
  apply(action);
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
        services.session.notice("warn", "Orchestration is off. Use /orchestration on before restarting an agent.");
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

  const openRun = (id: string): boolean => {
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
  };
  if (args[0] === "main") return;
  let selectedId = "main";
  const options = () => [
    { value: "main", label: "Main agent", active: selectedId === "main", description: "Return to the conversation; all running work continues" },
    ...manager.list().map((run) => ({
      value: run.id,
      active: selectedId === run.id,
      label: `${run.title} · ${run.status}`,
      description: `${run.id} · attempt ${run.attempt} · ${run.provider}/${run.model}`,
    })),
  ];
  const select = (id: string): void => {
    if (services.session.subagents !== manager) return;
    if (id === "main") services.overlay.close();
    else {
      selectedId = id;
      services.overlay.replacePickerOptions(options());
      openRun(id);
    }
  };
  const opened = args[0]
    ? openRun(args[0])
    : services.overlay.openPicker({ title: "Agents", options: options() }, select);
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
