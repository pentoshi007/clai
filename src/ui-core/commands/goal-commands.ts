import type { CommandInvocation } from "../../app/commands/command.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import { notify } from "../notify.js";
import { formatGoalStatus } from "../rendering/goal-format.js";

const CLEAR_WORDS: ReadonlySet<string> = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

function showGoalStatus(services: AppServices): void {
  const report = services.session.goalReport();
  if (!report) {
    services.session.notice("info", "No goal set. Usage: /goal <condition>");
    return;
  }
  services.overlay.openPager("Goal", formatGoalStatus(report), undefined, undefined, "force");
}

export function handleGoal(services: AppServices, invocation: CommandInvocation): void {
  const args = invocation.args.trim();
  const word = args.toLowerCase();
  if (!args || word === "status") {
    showGoalStatus(services);
    return;
  }
  if (CLEAR_WORDS.has(word)) {
    if (!services.session.clearGoal()) services.session.notice("info", "No goal set");
    return;
  }
  if (word === "pause") {
    if (!services.session.pauseGoal()) services.session.notice("info", "No goal set");
    return;
  }
  if (word === "resume") {
    const wasPaused = services.session.getState().goal?.status === "paused";
    if (!services.session.resumeGoal()) services.session.notice("info", "No goal set");
    else if (!wasPaused) notify(services, "Goal active · checking progress", { level: "info", key: "goal", durationMs: 1600 });
    return;
  }
  const result = services.session.setGoal(args);
  if (!result.ok) {
    services.session.notice("warn", result.error);
    return;
  }
  notify(services, result.deferred ? "Goal set · starts after the current work" : "Goal set", {
    level: "success",
    key: "goal",
    durationMs: 1600,
  });
}
