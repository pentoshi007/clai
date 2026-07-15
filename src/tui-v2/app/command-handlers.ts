/**
 * Attaches UI-coupled handlers to the shared command registry (V2-072, V2-080).
 *
 * Registry metadata lives in Phase 2; each frontend attaches handler bodies.
 * Implementations are split by surface under `./commands/*`.
 */

import type { AppServices } from "../bootstrap/composition-root.js";
import { discardPlan, implementPlan } from "./plan-lifecycle.js";
import {
  handleAllow,
  handleClean,
  handleClear,
  handleCompact,
  handleContext,
  handleCwd,
  handleDisallow,
  handleMode,
  handleNew,
  handleReset,
  handleSave,
  handleThink,
} from "./commands/session-commands.js";
import {
  handleExit,
  handleFallback,
  handleFreeOnly,
  handleHelp,
  handleJobs,
  handleMouse,
  handlePrivacy,
  handleScope,
  handleUpdate,
} from "./commands/config-commands.js";
import { handleInfo, handleKeys, handleSet, handleUnset } from "./commands/key-commands.js";
import {
  handleHistory,
  handleModel,
  handleOutput,
  handlePermissions,
  handlePlanPager,
  handleProvider,
  handleReasoning,
  handleSearch,
} from "./commands/picker-commands.js";

export function attachCommandHandlers(services: AppServices): void {
  const c = services.commands;
  c.setHandler("ask", () => handleMode(services, "ask"));
  c.setHandler("agent", () => handleMode(services, "agent"));
  c.setHandler("model", (i) => handleModel(services, i));
  c.setHandler("provider", (i) => handleProvider(services, i));
  c.setHandler("search", (i) => handleSearch(services, i));
  c.setHandler("variants", (i) => handleReasoning(services, i));
  c.setHandler("history", () => void handleHistory(services));
  c.setHandler("permissions", (i) => handlePermissions(services, i));
  c.setHandler("output", (i) => handleOutput(services, i));
  c.setHandler("plan", () => handlePlanPager(services));
  c.setHandler("implement", () => {
    if (services.session.getState().running) {
      services.session.notice("warn", "a turn is already running");
      return;
    }
    void implementPlan(services);
  });
  c.setHandler("discard", () =>
    void (async () => {
      const before = services.plan.current();
      if (!before) {
        services.session.notice("info", "no active plan to discard");
        return;
      }
      await discardPlan(services);
      services.session.notice("info", `plan discarded · ${before.goal}`);
    })(),
  );
  c.setHandler("clear", () => handleClear(services));
  c.setHandler("new", () => void handleNew(services));
  c.setHandler("clean", () => handleClean(services));
  c.setHandler("think", () => handleThink(services));
  c.setHandler("context", () => handleContext(services));
  c.setHandler("compact", () => void handleCompact(services));
  c.setHandler("save", (i) => void handleSave(services, i));
  c.setHandler("reset", () => void handleReset(services));
  c.setHandler("allow", (i) => handleAllow(services, i));
  c.setHandler("disallow", (i) => handleDisallow(services, i));
  c.setHandler("cwd", (i) => handleCwd(services, i));
  c.setHandler("freeonly", (i) => handleFreeOnly(services, i));
  c.setHandler("fallback", (i) => handleFallback(services, i));
  c.setHandler("mouse", (i) => handleMouse(services, i));
  c.setHandler("scope", (i) => void handleScope(services, i));
  c.setHandler("privacy", (i) => void handlePrivacy(services, i));
  c.setHandler("update", () => void handleUpdate(services));
  c.setHandler("help", () => handleHelp(services));
  c.setHandler("exit", () => handleExit(services));
  c.setHandler("set", (i) => void handleSet(services, i));
  c.setHandler("unset", (i) => void handleUnset(services, i));
  c.setHandler("keys", () => void handleKeys(services));
  c.setHandler("info", (i) => void handleInfo(services, i));
  if (c.has("jobs")) c.setHandler("jobs", () => handleJobs(services));
}
