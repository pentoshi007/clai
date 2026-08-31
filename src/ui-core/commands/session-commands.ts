
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setDefaultMode, getConfig, getProviderModel } from "../../store/config.js";
import { seedSessionModel } from "../../store/session-model.js";
import {
  clearAllHistory,
  getSession,
  purgeSession,
  upsertSession,
} from "../../store/history.js";
import {
  getActiveSessionWorkspace,
  removeSessionWorkspaceFolder,
} from "../../store/session-workspace.js";
import { safeCwd } from "../../os/cwd.js";
import { clearActiveProjectRoot } from "../../agent/project-root.js";
import { mintSessionId } from "../../app/controllers/session-persistence.js";
import type { CommandInvocation } from "../../app/commands/command.js";
import type { Mode } from "../../types.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import { usageCacheHitRate } from "../../app/controllers/session-usage-ledger.js";
import { formatSessionUsage } from "../rendering/format-usage.js";
import { serializeTranscriptForCompaction } from "../state/transcript-compaction.js";
import { conversationItemCount } from "../state/transcript-types.js";

import { notify } from "../notify.js";

function notice(services: AppServices, level: "info" | "warn", text: string): void {
  services.session.notice(level, text);
}

function flash(
  services: AppServices,
  text: string,
  opts: {
    key?: string;
    level?: "info" | "success" | "warn";
    durationMs?: number;
  } = {},
): void {
  notify(services, text, {
    level: opts.level ?? "info",
    durationMs: opts.durationMs ?? 1600,
    ...(opts.key ? { key: opts.key } : {}),
  });
}

export function handleMode(services: AppServices, mode: Mode): void {
  services.session.setMode(mode);
  setDefaultMode(mode);
  flash(services, `Mode · ${mode}`, { key: "mode", level: "success" });
}

export async function handleClear(services: AppServices): Promise<void> {
  const purgedId = services.session.sessionId;
  const purgedWorkspace = getActiveSessionWorkspace()?.folderName;

  clearActiveProjectRoot();
  services.plan.clear();
  services.session.reset({ mintNewId: true });
  services.transcript.reset();
  services.session.setPlanApproved(false);
  flash(services, "Session cleared", { key: "session", level: "success" });
  await services.plan.load(services.session.sessionId).catch(() => undefined);

  const outcome = await purgeCurrentSession(purgedId, purgedWorkspace);
  if (outcome === "failed") {
    notice(
      services,
      "warn",
      "cleared this session in memory, but some of its saved copy could not be deleted",
    );
  }
  await inheritLastUsedModel(services);
}

async function purgeCurrentSession(
  sessionId: string,
  workspaceFolder: string | undefined,
): Promise<"purged" | "nothing-to-purge" | "failed"> {
  let removedWorkspace = false;
  let failed = false;
  let purged = false;
  try {
    const first = await purgeSession(sessionId);
    purged = first.deleted;
    removedWorkspace = first.removedWorkspace;
    if (first.deleted && (await getSession(sessionId))) {
      const second = await purgeSession(sessionId);
      removedWorkspace = removedWorkspace || second.removedWorkspace;
      if (await getSession(sessionId)) failed = true;
    } else if (!first.deleted && (await getSession(sessionId))) {
      failed = true;
    }
  } catch {
    failed = true;
  }
  if (!removedWorkspace && workspaceFolder) {
    removeSessionWorkspaceFolder(workspaceFolder);
  }
  if (failed) return "failed";
  return purged ? "purged" : "nothing-to-purge";
}

function sessionIsBusy(services: AppServices): boolean {
  const state = services.session.getState();
  return state.running || state.compacting;
}

function forkFreshSession(services: AppServices): boolean {
  const freshId = mintSessionId();
  if (!services.requestSessionSwitch(freshId, false, true)) return false;
  flash(services, "Fresh session · previous kept running", {
    key: "session",
    level: "success",
  });
  return true;
}

async function inheritLastUsedModel(services: AppServices): Promise<void> {
  const seeded = await seedSessionModel(services.session.sessionId, {
    provider: undefined,
    model: undefined,
    inheritLastUsed: true,
  }).catch(() => undefined);
  if (!seeded?.provider) return;
  services.session.setProvider(seeded.provider);
  services.session.setModel(seeded.model ?? getProviderModel(seeded.provider));
}

async function resetToFreshSession(services: AppServices): Promise<void> {
  clearActiveProjectRoot();
  services.plan.clear();
  services.session.reset({ mintNewId: true });
  services.transcript.reset();
  await services.plan.load(services.session.sessionId).catch(() => undefined);
  services.session.setPlanApproved(false);
  flash(services, "Fresh session", { key: "session", level: "success" });
  await inheritLastUsedModel(services);
}

export async function handleNew(services: AppServices): Promise<void> {
  const messages = services.session.messages;
  if (!getConfig().privateMode && messages.some((m) => m.role === "user")) {
    await services.session.persistNow().catch(() => undefined);
  }
  if (sessionIsBusy(services) && forkFreshSession(services)) {
    return;
  }
  await resetToFreshSession(services);
}


export function handleThink(services: AppServices): void {
  services.transcript.toggleThinkingGlobal();
  const on = services.transcript.getState().expandThinkingGlobal;
  flash(services, on ? "Thinking expanded · ^T" : "Thinking collapsed · ^T", {
    key: "thinking",
  });
}

export function handleContext(services: AppServices): void {
  const { messages, tokens } = services.session.estimateContext();
  const state = services.session.getState();
  const legacy = state.contextUsage;
  const snapshot = state.contextSnapshot;
  const exact = legacy?.exact === true;
  const usedLabel = exact
    ? `${tokens.toLocaleString()} tokens`
    : `~${tokens.toLocaleString()} tokens (estimate)`;
  const sessionBits =
    legacy && (legacy.sessionPromptTokens > 0 || legacy.sessionCompletionTokens > 0)
      ? ` · session in ${legacy.sessionPromptTokens.toLocaleString()} / out ${legacy.sessionCompletionTokens.toLocaleString()}`
      : "";
  const details: string[] = [];
  if (snapshot?.cache.kind === "reported") {
    const cache = [
      snapshot.cache.readTokens !== undefined
        ? `read ${snapshot.cache.readTokens.toLocaleString()}`
        : undefined,
      snapshot.cache.creationTokens !== undefined
        ? `write ${snapshot.cache.creationTokens.toLocaleString()}`
        : undefined,
      snapshot.cache.uncachedTokens !== undefined
        ? `uncached ${snapshot.cache.uncachedTokens.toLocaleString()}`
        : undefined,
    ].filter((value): value is string => value !== undefined);
    details.push(cache.length > 0 ? `cache ${cache.join(" / ")}` : "cache unavailable");
  } else {
    details.push("cache unavailable");
  }
  if (snapshot?.reasoning.kind === "reported") {
    const reasoning = [
      snapshot.reasoning.outputTokens !== undefined
        ? `output ${snapshot.reasoning.outputTokens.toLocaleString()}`
        : undefined,
      snapshot.reasoning.inputArtifactTokens !== undefined
        ? `input ${snapshot.reasoning.inputArtifactTokens.toLocaleString()}`
        : undefined,
    ].filter((value): value is string => value !== undefined);
    details.push(
      reasoning.length > 0 ? `reasoning ${reasoning.join(" / ")}` : "reasoning unavailable",
    );
  } else {
    details.push("reasoning unavailable");
  }
  if (snapshot) details.push(`scope ${snapshot.scope}`);
  const text = `context: ${messages} messages · ${usedLabel}${sessionBits} · ${details.join(" · ")}`;
  notice(services, "info", text);
}

export function handleUsage(services: AppServices): void {
  const state = services.session.getState();
  const report = services.session.usageReport();
  const body = formatSessionUsage(report, {
    sessionId: state.sessionId,
    ...(state.title ? { title: state.title } : {}),
  });
  const opened = services.overlay.openPager(
    "Session usage",
    body,
    undefined,
    undefined,
    "force",
  );
  if (opened) return;
  const { totals } = report;
  if (totals.requests === 0) {
    notice(services, "info", "usage: no provider token usage recorded yet in this session");
    return;
  }
  const rate = usageCacheHitRate(totals);
  notice(
    services,
    "info",
    `usage: ${totals.routes} route${totals.routes === 1 ? "" : "s"} · ${totals.requests} request${totals.requests === 1 ? "" : "s"} · in ${totals.promptTokens.toLocaleString()} / out ${totals.completionTokens.toLocaleString()} · total ${totals.totalTokens.toLocaleString()}${rate === undefined ? "" : ` · cache ${(rate * 100).toFixed(1)}%`}`,
  );
}

export async function handleCompact(services: AppServices): Promise<void> {  if (services.session.getState().running) {
    notice(services, "warn", "wait for the current operation to finish");
    return;
  }
  if (services.session.getState().compacting) {
    notice(services, "info", "compaction already in progress…");
    return;
  }
  const historyLen = services.session.messages.length;
  const visualCount = conversationItemCount(services.transcript.getState());
  if (historyLen === 0 && visualCount === 0) {
    notice(services, "info", "nothing to compact yet — more conversation is needed");
    return;
  }

  try {
    const transcript = serializeTranscriptForCompaction(
      services.transcript.getState(),
      (toolCallId) => services.session.spool.tail(toolCallId),
    );
    const result = await services.session.compact(transcript || undefined, 2);
    if (!result.summarized || result.after === result.before) {
      notice(services, "info", "nothing to compact yet — more conversation is needed");
      return;
    }
    const freed = Math.max(0, result.beforeTokens - result.afterTokens);
    const pct =
      result.beforeTokens > 0 ? Math.round((freed / result.beforeTokens) * 100) : 0;
    flash(
      services,
      `compacted · −${pct}% · ~${result.beforeTokens.toLocaleString()}→~${result.afterTokens.toLocaleString()} (−${freed.toLocaleString()} tok)`,
      { key: "compact", durationMs: 2200 },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      notice(services, "info", "compaction cancelled");
      return;
    }
    notice(
      services,
      "warn",
      `compaction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function handleSave(
  services: AppServices,
  invocation: CommandInvocation,
): Promise<void> {
  const messages = services.session.messages;
  if (messages.length === 0) {
    notice(services, "info", "nothing to save yet");
    return;
  }
  try {
    await services.session.persistNow(invocation.args.trim() || undefined);
    notice(services, "info", `saved session ${services.session.sessionId}`);
  } catch {
    const rec = await upsertSession(
      services.session.sessionId,
      [...messages],
      invocation.args.trim() || undefined,
    ).catch(() => undefined);
    notice(services, "info", rec ? `saved session ${rec.id}` : "save failed");
  }
}

export async function handleReset(services: AppServices): Promise<void> {
  const result = await clearAllHistory();
  notice(services, "info", `history cleared · ${result.detail || "ok"}`);
}

export function handleAllow(services: AppServices, invocation: CommandInvocation): void {
  const arg = invocation.args.trim();
  if (!arg || arg === "list" || arg === "ls") {
    const list = services.session.allowedTools();
    notice(
      services,
      "info",
      list.length ? `allowed: ${list.join(", ")}` : "no session allowances",
    );
    return;
  }
  services.session.allowTool(arg);
  notice(services, "info", `allowed for session: ${arg}`);
}

export function handleDisallow(services: AppServices, invocation: CommandInvocation): void {
  const arg = invocation.args.trim();
  if (!arg) {
    notice(services, "info", "usage: /disallow <tool>");
    return;
  }
  services.session.disallowTool(arg);
  notice(services, "info", `disallowed: ${arg}`);
}

export function handleCwd(services: AppServices, invocation: CommandInvocation): void {
  const arg = invocation.args.trim();
  if (!arg) {
    notice(services, "info", `cwd: ${safeCwd()}`);
    return;
  }
  const target = resolve(safeCwd(), arg);
  if (!existsSync(target)) {
    notice(services, "warn", `no such directory: ${target}`);
    return;
  }
  try {
    process.chdir(target);
    notice(services, "info", `cwd → ${target}`);
    void services.mcp.refresh().catch(() => undefined);
  } catch (error) {
    notice(
      services,
      "warn",
      `could not chdir: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
