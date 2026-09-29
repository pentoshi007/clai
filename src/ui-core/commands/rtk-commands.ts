import type { CommandInvocation } from "../../app/commands/command.js";
import { formatTokenCount } from "../../llm/token-usage.js";
import { updateConfig } from "../../store/config.js";
import { detectRtk, readRtkGain, type RtkGain, type RtkStatus } from "../../tools/rtk/binary.js";
import { rtkEnabled, rtkRewriteCount } from "../../tools/rtk/rewrite.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import type { PickerOption } from "../rendering/picker-filter.js";

const USAGE = "usage: /rtk [on|off|status]";
const INSTALL_HINT = "install with `brew install rtk` or `cargo install --git https://github.com/rtk-ai/rtk`";

interface RtkView {
  readonly enabled: boolean;
  readonly status?: RtkStatus | undefined;
  readonly gain?: RtkGain | undefined;
}

const plural = (count: number, noun: string): string =>
  `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;

const statusLine = (status: RtkStatus): string => {
  switch (status.state) {
    case "ready":
      return `rtk ${status.version} ready`;
    case "incompatible":
      return `${status.path} is not rtk-ai/rtk ≥ 0.23 (needs \`rtk rewrite\`)`;
    case "missing":
      return `rtk not found on PATH — ${INSTALL_HINT}`;
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

const statusOption = ({ status, gain }: RtkView): PickerOption => {
  if (!status) {
    return {
      value: "refresh",
      label: "Detecting rtk…",
      icon: "◌",
      tone: "muted",
      description: "looking for the rtk binary on PATH",
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
        description: `${statusLine(status)} · select to re-check`,
      };
    case "missing":
      return {
        value: "refresh",
        label: "rtk not installed",
        icon: "!",
        tone: "warn",
        description: `${INSTALL_HINT}, then select to re-check`,
      };
  }
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
];

const loadView = async (): Promise<RtkView> => {
  const status = await detectRtk(true);
  const gain = status.state === "ready" ? await readRtkGain(status.path) : undefined;
  return { enabled: rtkEnabled(), status, gain };
};

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
  const detail =
    status.state === "ready"
      ? `${statusLine(status)} · ${plural(rtkRewriteCount(), "command")} compressed this session · ${gainLine(view.gain)}`
      : statusLine(status);
  services.session.notice(
    status.state === "ready" || !view.enabled ? "info" : "warn",
    `${rtkTitle(view)} · ${detail}`,
  );
}

function openRtkScreen(services: AppServices): void {
  const pending = (): RtkView => ({ enabled: rtkEnabled() });
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
    void applyRtk(services, value === "on");
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
  if (action !== "") {
    services.session.notice("warn", USAGE);
    return;
  }
  openRtkScreen(services);
}
