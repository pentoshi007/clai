import type { CommandInvocation } from "../../app/commands/command.js";
import { formatTokenCount } from "../../llm/token-usage.js";
import { updateConfig } from "../../store/config.js";
import { detectRtk, readRtkGain, type RtkGain, type RtkStatus } from "../../tools/rtk/binary.js";
import {
  RTK_INSTALL_HINT,
  rtkMaintenance,
  runRtkMaintenance,
  type RtkMaintenanceAction,
  type RtkMaintenanceResult,
  type RtkMaintenanceState,
} from "../../tools/rtk/install.js";
import { rtkEnabled, rtkRewriteCount } from "../../tools/rtk/rewrite.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import type { PickerOption } from "../rendering/picker-filter.js";

const USAGE = "usage: /rtk [on|off|status|install|update]";

interface RtkView {
  readonly enabled: boolean;
  readonly status?: RtkStatus | undefined;
  readonly gain?: RtkGain | undefined;
  readonly maintenance?: RtkMaintenanceState | undefined;
}

const plural = (count: number, noun: string): string =>
  `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;

const progressive = (action: RtkMaintenanceAction): string =>
  action === "install" ? "Installing" : "Updating";

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

const gainLine = (gain: RtkGain | undefined): string =>
  gain && gain.commands > 0
    ? `${formatTokenCount(gain.savedTokens, true)} tokens saved overall (${Math.round(gain.savingsPct)}%)`
    : "no savings recorded yet";

const statusOption = ({ status, gain, maintenance }: RtkView): PickerOption => {
  if (maintenance) {
    return {
      value: "refresh",
      label: `${progressive(maintenance.action)} rtk…`,
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
        tone: "accent",
        description: `${plural(rtkRewriteCount(), "command")} compressed this session · ${gainLine(gain)} · select to refresh`,
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
          description: `${process.platform === "win32" ? "winget, else cargo" : "Homebrew, else the checksum-verified rtk installer, else cargo"} · clai stays usable meanwhile`,
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

const loadView = async (): Promise<RtkView> => {
  const maintenance = rtkMaintenance();
  const status = await detectRtk(true);
  const gain = status.state === "ready" ? await readRtkGain(status.path) : undefined;
  return { enabled: rtkEnabled(), status, gain, ...(maintenance ? { maintenance } : {}) };
};

const compressionHint = (): string => (rtkEnabled() ? "" : " · turn compression on with /rtk on");

const maintenanceMessage = (result: RtkMaintenanceResult): string => {
  if (!result.ok) {
    const manual = result.status.state === "ready" ? "" : ` · install manually: ${RTK_INSTALL_HINT}`;
    return `rtk ${result.action} failed · ${result.reason}${manual}`;
  }
  const { status, installer, previousVersion, action } = result;
  if (!installer) return `rtk ${status.version} is already installed${compressionHint()}`;
  if (action === "install") return `rtk ${status.version} installed via ${installer}${compressionHint()}`;
  return previousVersion === status.version
    ? `rtk ${status.version} is already the latest (${installer})`
    : `rtk updated ${previousVersion ?? "?"} → ${status.version} via ${installer}`;
};

function startMaintenance(services: AppServices, action: RtkMaintenanceAction): void {
  const running = rtkMaintenance();
  if (running) {
    services.session.notice(
      "info",
      `${progressive(running.action)} rtk is already in progress${running.installer ? ` via ${running.installer}` : ""}`,
    );
    return;
  }
  services.session.notice("info", `${progressive(action)} rtk… clai stays usable meanwhile`);
  void runRtkMaintenance(action)
    .then((result) => services.session.notice(result.ok ? "info" : "warn", maintenanceMessage(result)))
    .catch(() => undefined);
}

async function announce(services: AppServices, enabled: boolean): Promise<void> {
  if (!enabled) {
    services.session.notice("info", "RTK off · shell commands run unmodified");
    return;
  }
  const status = await detectRtk();
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
  const view = await loadView();
  const status = view.status!;
  const detail = view.maintenance
    ? `${progressive(view.maintenance.action)} rtk${view.maintenance.installer ? ` via ${view.maintenance.installer}` : ""}…`
    : status.state === "ready"
      ? `${statusLine(status)} · ${plural(rtkRewriteCount(), "command")} compressed this session · ${gainLine(view.gain)}`
      : statusLine(status);
  services.session.notice(
    status.state === "ready" || !view.enabled ? "info" : "warn",
    `${rtkTitle(view)} · ${detail}`,
  );
}

function openRtkScreen(services: AppServices): void {
  const pending = (): RtkView => {
    const maintenance = rtkMaintenance();
    return { enabled: rtkEnabled(), ...(maintenance ? { maintenance } : {}) };
  };
  const isOpen = (): boolean => {
    const state = services.overlay.getState();
    return state.kind === "picker" && state.onSelect === onSelect;
  };
  const refresh = (): void => {
    void loadView().then((view) => {
      if (isOpen()) services.overlay.replacePickerOptions(rtkOptions(view), rtkTitle(view));
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
