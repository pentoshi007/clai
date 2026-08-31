import type { CommandInvocation } from "../../../app/commands/command.js";
import { getConfig, updateConfig } from "../../../store/config.js";
import type { AppServices } from "../../bootstrap/composition-root.js";
import { openToolOutputPager } from "../../rendering/open-tool-output.js";

export function handlePermissions(services: AppServices, invocation: CommandInvocation): void {
  const apply = (value: "default" | "allow-all") => {
    updateConfig({ permissions: value });
    services.session.notice("info", `permissions → ${value}`);
  };
  if (invocation.args) {
    const value = invocation.args.trim().toLowerCase();
    if (value === "default" || value === "allow-all") apply(value);
    return;
  }
  const current = getConfig().permissions ?? "default";
  services.overlay.openPicker(
    {
      title: "Permissions",
      options: [
        {
          value: "default",
          label: "default",
          description: "confirm risky tool calls",
          active: current === "default",
        },
        {
          value: "allow-all",
          label: "allow-all",
          description: "skip confirmation prompts",
          active: current === "allow-all",
        },
      ],
    },
    (value) => {
      apply(value as "default" | "allow-all");
      services.overlay.close();
    },
  );
}

export async function handleOutput(
  services: AppServices,
  invocation: CommandInvocation,
): Promise<void> {
  const state = services.transcript.getState();
  const toolItems = [...state.byId.values()].filter((item) => item.kind === "tool");
  if (toolItems.length === 0) {
    services.session.notice("info", "no tool output yet");
    return;
  }

  const arg = invocation.args.trim().toLowerCase();
  if (!arg) {
    services.transcript.toggleOutputGlobal();
    const on = services.transcript.getState().expandOutputGlobal;
    services.toast.show(
      on ? "Tool output expanded · ^O" : "Tool output collapsed · ^O",
      { key: "output", durationMs: 1500 },
    );
    return;
  }
  if (arg === "list" || arg === "ls") {
    services.overlay.openPicker(
      {
        title: "Tool output",
        options: toolItems.map((item) => ({
          value: item.id,
          label: item.name,
          description: item.argsDisplay,
        })),
      },
      (value) => {
        services.overlay.close();
        const item = toolItems.find((t) => t.id === value);
        if (item) void openToolOutputPager(services, item);
      },
    );
    return;
  }
  const target =
    arg !== "last"
      ? toolItems.find((t) => t.toolCallId === arg || t.id === arg)
      : toolItems.at(-1);
  if (target) await openToolOutputPager(services, target);
  else services.session.notice("info", arg ? `no tool output: ${arg}` : "no tool output yet");
}

export function handlePlanPager(services: AppServices): void {
  void (async () => {
    let plan = services.plan.current();
    if (!plan) {
      plan = await services.plan
        .load(services.session.sessionId)
        .catch(() => undefined);
    }
    if (!plan) {
      services.session.notice("info", "no active plan yet");
      return;
    }
    const { formatPlanPagerDocument } = await import(
      "../../rendering/plan-view.js"
    );
    services.overlay.openPager(
      `Plan · ${plan.goal}`,
      formatPlanPagerDocument(plan),
      undefined,
      undefined,
      "force",
    );
  })();
}
