import { getConfig, updateConfig, type ClaiConfig } from "../../store/config.js";
import type { CommandInvocation } from "../../app/commands/command.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import type { PickerOption } from "../rendering/picker-filter.js";

interface ToggleSetting {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly read: (config: ClaiConfig) => boolean;
  readonly patch: (enabled: boolean) => Partial<ClaiConfig>;
}

const SETTINGS: readonly ToggleSetting[] = [
  {
    id: "save-tool-outputs",
    label: "Save command outputs",
    description: "Automatically save full tool output to files. Off by default; explicit files and background-job logs are unchanged.",
    read: (config) => config.saveToolOutputs,
    patch: (enabled) => ({ saveToolOutputs: enabled }),
  },
];

function settingOptions(): PickerOption[] {
  const config = getConfig();
  return SETTINGS.map((setting) => ({
    value: setting.id,
    label: `${setting.label} · ${setting.read(config) ? "On" : "Off"}`,
    description: setting.description,
  }));
}

export function handleSettings(services: AppServices, invocation: CommandInvocation): void {
  if (invocation.args.trim()) {
    services.session.notice("warn", "usage: /settings");
    return;
  }

  const apply = (value: string, enabled?: boolean): void => {
    const setting = SETTINGS.find((entry) => entry.id === value);
    if (!setting) return;
    try {
      const next = enabled ?? !setting.read(getConfig());
      updateConfig(setting.patch(next));
      services.overlay.replacePickerOptions(settingOptions());
    } catch (error) {
      services.toast.error(`Setting not saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const toggle = (value: string): void => apply(value);
  services.overlay.openPicker(
    {
      title: getConfig().privateMode ? "Settings · saving paused by private mode" : "Settings",
      options: settingOptions(),
      twoLine: true,
      preserveSelection: true,
      searchDescription: true,
      selectLabel: "toggle",
      rowAction: { chord: "space", hint: "space toggle" },
      adjustment: { hint: "← off → on" },
    },
    toggle,
    toggle,
    (value, direction) => apply(value, direction === 1),
  );
}
