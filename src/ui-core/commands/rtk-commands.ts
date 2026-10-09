import type { CommandInvocation } from "../../app/commands/command.js";
import { formatTokenCount } from "../../llm/token-usage.js";
import { updateConfig } from "../../store/config.js";
import { detectRtk, readRtkGain, type RtkGain, type RtkStatus } from "../../tools/rtk/binary.js";
import {
  rtkMaintenance,
  runRtkMaintenance,
  setRtkMaintenanceListener,
  type RtkMaintenanceAction,
  type RtkMaintenanceResult,
  type RtkMaintenanceState,
  type RtkProgress,
} from "../../tools/rtk/install.js";
import { rtkEnabled, rtkExecutionCount } from "../../tools/rtk/rewrite.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import type { PickerOption } from "../rendering/picker-filter.js";

const USAGE = "usage: /rtk [on|off|status|install|update]";

interface RtkView {
  readonly sessionId: string;
  readonly enabled: boolean;
  readonly status?: RtkStatus | undefined;
  readonly gain?: RtkGain | undefined;
  readonly maintenance?: RtkMaintenanceState | undefined;
}

const plural = (count: number, noun: string): string =>
  `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;

const progressive = (action: RtkMaintenanceAction): string =>
  action === "install" ? "Installing" : "Updating";

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};

const statusLine = (status: RtkStatus): string => {
  switch (status.state) {
    case "ready":
      return `rtk ${status.version} ready`;
    case "incompatible":
      return `${status.path} is not rtk-ai/rtk ≥ 0.23 (needs \`rtk rewrite\`) — run /rtk install`;
    case "missing":
      return "rtk not found — run /rtk install";
  }
};

const rtkTitle = ({ enabled, status }: RtkView): string => {
  const inactive = enabled && status !== undefined && status.state !== "ready";
  return `RTK · ${enabled ? "on" : "off"}${inactive ? " · inactive" : ""}`;
};

const gainLine = (gain: RtkGain | undefined): string => {
  if (!gain) return "RTK savings unavailable";
  if (gain.commands === 0) return "no RTK savings recorded for this session yet";
  return `${formatTokenCount(gain.savedTokens, true)} estimated tokens saved this session (${Math.round(gain.savingsPct)}%)`;
};

const executionLine = (sessionId: string): string => {
  const count = rtkExecutionCount(sessionId);
  return count === undefined
    ? "RTK session count unavailable"
    : `${plural(count, "automatic RTK run")} this session`;
};

const statusOption = ({ sessionId, status, gain, maintenance }: RtkView): PickerOption => {
  if (maintenance) {
    const pct =
      maintenance.totalBytes && maintenance.totalBytes > 0 && maintenance.receivedBytes !== undefined
        ? ` ${Math.min(100, Math.round((maintenance.receivedBytes / maintenance.totalBytes) * 100))}%`
        : "";
    return {
      value: "refresh",
      label: `${progressive(maintenance.action)} rtk${pct}…`,
      icon: "⟳",
      tone: "warn",
      description: `${maintenance.installer ? `via ${maintenance.installer} · ` : ""}shell commands run unmodified until it finishes · select to refresh`,
    };
  }
  if (!status) {
    return {
      value: "refresh",
      label: "Detecting rtk…",
      icon: "◌",
      tone: "muted",
      description: "looking for the rtk binary",
    };
  }
  switch (status.state) {
    case "ready":
      return {
        value: "refresh",
        label: `rtk ${status.version}`,
        icon: "◇",
        tone: gain === undefined ? "warn" : "accent",
        description: `${executionLine(sessionId)} · ${gainLine(gain)} · select to refresh`,
      };
    case "incompatible":
      return {
        value: "refresh",
        label: `rtk ${status.version ?? ""} unsupported`.replace(/\s+/g, " "),
        icon: "✗",
        tone: "error",
        description: `${status.path} is not rtk-ai/rtk ≥ 0.23 · select to re-check`,
      };
    case "missing":
      return {
        value: "refresh",
        label: "rtk not installed",
        icon: "!",
        tone: "warn",
        description: "select to re-check after installing it yourself",
      };
  }
};

const maintenanceOption = ({ status, maintenance }: RtkView): PickerOption[] => {
  if (maintenance || !status) return [];
  return status.state === "ready"
    ? [
        {
          value: "update",
          label: "Update rtk",
          icon: "↻",
          tone: "accent",
          description: "upgrade through the tool that installed it · clai stays usable meanwhile",
        },
      ]
    : [
        {
          value: "install",
          label: "Install rtk",
          icon: "↓",
          tone: "accent",
          description: `${process.platform === "win32" ? "winget, then a checksum-verified binary, then cargo" : "Homebrew, then a checksum-verified release binary, then cargo"} · clai stays usable meanwhile`,
        },
      ];
};

const rtkOptions = (view: RtkView): PickerOption[] => [
  {
    value: "on",
    label: "On",
    icon: "●",
    tone: "success",
    active: view.enabled,
    description: "compress shell output through rtk · history and prompt cache stay untouched",
  },
  {
    value: "off",
    label: "Off",
    icon: "○",
    tone: "muted",
    active: !view.enabled,
    description: "run shell commands exactly as written",
  },
  statusOption(view),
  ...maintenanceOption(view),
];

const loadView = async (sessionId: string): Promise<RtkView> => {
  const maintenance = rtkMaintenance();
  const status = await detectRtk(true);
  const gain = status.state === "ready" ? await readRtkGain(status.path, sessionId) : undefined;
  return { sessionId, enabled: rtkEnabled(), status, gain, ...(maintenance ? { maintenance } : {}) };
};

const compressionHint = (): string => (rtkEnabled() ? "" : " · turn compression on with /rtk on");

const maintenanceMessage = (result: RtkMaintenanceResult): string => {
  if (!result.ok) {
    return `rtk ${result.action} failed · ${result.reason}\n  ${result.manual.replace(/\n/g, "\n  ")}`;
  }
  const { status, installer, previousVersion, latestVersion, action, pathWarning } = result;
  if (!installer) return `rtk ${status.version} is already installed${compressionHint()}`;
  const base =
    action === "install"
      ? `rtk ${status.version} installed via ${installer}${compressionHint()}`
      : previousVersion === status.version || latestVersion === status.version
        ? `rtk ${status.version} is already the latest (${installer})`
        : `rtk updated ${previousVersion ?? "?"} → ${status.version} via ${installer}`;
  return pathWarning ? `${base}\n  ${pathWarning}` : base;
};

const PHASE_LABEL: Record<RtkProgress["phase"], string> = {
  preparing: "checking rtk",
  resolving: "resolving the latest release",
  downloading: "downloading",
  verifying: "verifying the checksum",
  extracting: "extracting",
  running: "installing",
};

const progressLine = (progress: RtkProgress): string => {
  const method = progress.method ? ` via ${progress.method}` : "";
  if (progress.phase === "downloading") {
    const { receivedBytes = 0, totalBytes } = progress;
    if (totalBytes && totalBytes > 0) {
      const pct = Math.min(100, Math.round((receivedBytes / totalBytes) * 100));
      return `downloading rtk ${pct}% (${formatBytes(receivedBytes)}/${formatBytes(totalBytes)})${method}…`;
    }
    return receivedBytes > 0 ? `downloading rtk (${formatBytes(receivedBytes)})…` : `downloading rtk…`;
  }
  return `${PHASE_LABEL[progress.phase]}${method}…`;
};

const MAINTENANCE_TOAST_KEY = "rtk-maintenance";

function startMaintenance(services: AppServices, action: RtkMaintenanceAction): void {
  const running = rtkMaintenance();
  if (running) {
    services.session.notice(
      "info",
      `${progressive(running.action)} rtk is already in progress${running.installer ? ` via ${running.installer}` : ""}`,
    );
    return;
  }
  let toastId = services.toast.info(`${progressive(action)} rtk…`, { key: MAINTENANCE_TOAST_KEY, sticky: true });
  setRtkMaintenanceListener((progress) => {
    toastId = services.toast.info(progressLine(progress), { key: MAINTENANCE_TOAST_KEY, sticky: true });
  });
  const settle = (level: "info" | "warn", text: string): void => {
    setRtkMaintenanceListener(undefined);
    services.toast.dismiss(toastId);
    services.session.notice(level, text);
  };
  void runRtkMaintenance(action)
    .then((result) => settle(result.ok ? "info" : "warn", maintenanceMessage(result)))
    .catch((error: unknown) =>
      settle("warn", `rtk ${action} failed · ${error instanceof Error ? error.message : String(error)}`),
    );
}

async function announce(services: AppServices, enabled: boolean): Promise<void> {
  if (!enabled) {
    services.session.notice("info", "RTK off · shell commands run unmodified");
    return;
  }
  const status = await detectRtk(true);
  if (status.state === "ready") {
    services.session.notice(
      "info",
      `RTK on · shell output is compressed by rtk ${status.version}; history and prompt cache stay untouched`,
    );
    return;
  }
  services.session.notice("warn", `RTK on · inactive: ${statusLine(status)}`);
}

function applyRtk(services: AppServices, enabled: boolean): Promise<void> {
  updateConfig({ rtk: enabled });
  return announce(services, enabled);
}

async function reportStatus(services: AppServices): Promise<void> {
  const view = await loadView(services.session.sessionId);
  if (services.session.sessionId !== view.sessionId) return;
  const status = view.status!;
  const detail = view.maintenance
    ? `${progressive(view.maintenance.action)} rtk${view.maintenance.installer ? ` via ${view.maintenance.installer}` : ""}…`
    : status.state === "ready"
      ? `${statusLine(status)} · ${executionLine(view.sessionId)} · ${gainLine(view.gain)}`
      : statusLine(status);
  const statisticsUnavailable = status.state === "ready" && view.gain === undefined;
  const inactiveEnabled = view.enabled && status.state !== "ready";
  services.session.notice(
    statisticsUnavailable || inactiveEnabled ? "warn" : "info",
    `${rtkTitle(view)} · ${detail}`,
  );
}

function openRtkScreen(services: AppServices): void {
  const sessionId = services.session.sessionId;
  let refreshGeneration = 0;
  const pending = (): RtkView => {
    const maintenance = rtkMaintenance();
    return { sessionId, enabled: rtkEnabled(), ...(maintenance ? { maintenance } : {}) };
  };
  const isOpen = (): boolean => {
    const state = services.overlay.getState();
    return services.session.sessionId === sessionId && state.kind === "picker" && state.onSelect === onSelect;
  };
  const refresh = (): void => {
    const generation = ++refreshGeneration;
    void loadView(sessionId).then((view) => {
      if (generation === refreshGeneration && isOpen()) {
        services.overlay.replacePickerOptions(rtkOptions(view), rtkTitle(view));
      }
    });
  };
  const onSelect = (value: string): void => {
    if (value === "refresh") {
      const view = pending();
      services.overlay.replacePickerOptions(rtkOptions(view), rtkTitle(view));
      refresh();
      return;
    }
    services.overlay.close();
    if (value === "install" || value === "update") startMaintenance(services, value);
    else void applyRtk(services, value === "on");
  };
  const view = pending();
  services.overlay.openPicker(
    {
      title: rtkTitle(view),
      twoLine: true,
      searchDescription: true,
      preserveSelection: true,
      options: rtkOptions(view),
    },
    onSelect,
  );
  refresh();
}

export function handleRtk(services: AppServices, invocation: CommandInvocation): Promise<void> | void {
  const action = invocation.args.trim().toLowerCase();
  if (action === "on" || action === "off") return applyRtk(services, action === "on");
  if (action === "status") return reportStatus(services);
  if (action === "install" || action === "update") {
    startMaintenance(services, action);
    return;
  }
  if (action !== "") {
    services.session.notice("warn", USAGE);
    return;
  }
  openRtkScreen(services);
}
