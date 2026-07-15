/**
 * Session lifecycle slash commands (V2-080): mode, clear/new/clean, save/reset,
 * allow/disallow, think, context, compact.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setDefaultMode, getConfig } from "../../../store/config.js";
import { upsertSession, clearAllHistory } from "../../../store/history.js";
import { safeCwd } from "../../../os/cwd.js";
import { AUTO_COMPACT_TOKEN_BUDGET } from "../../../agent/context-manager.js";
import type { CommandInvocation } from "../../../app/commands/command.js";
import type { Mode } from "../../../types.js";
import type { AppServices } from "../../bootstrap/composition-root.js";
import { serializeTranscriptForCompaction } from "../../state/transcript-compaction.js";

function notice(services: AppServices, level: "info" | "warn", text: string): void {
  services.session.notice(level, text);
}

export function handleMode(services: AppServices, mode: Mode): void {
  services.session.setMode(mode);
  setDefaultMode(mode);
  notice(services, "info", `mode → ${mode}`);
}

export function handleClear(services: AppServices): void {
  services.session.reset();
  services.transcript.reset();
  // Drop in-memory plan; session id is unchanged so the on-disk plan remains
  // for this session, but the UI should not show a stale card after clear.
  void services.plan.load(services.session.sessionId).catch(() => undefined);
  notice(services, "info", "context cleared");
}

export async function handleNew(services: AppServices): Promise<void> {
  const messages = services.session.messages;
  if (!getConfig().privateMode && messages.some((m) => m.role === "user")) {
    // Save messages + visual transcript so /history can restore the old chat.
    await services.session.persistNow().catch(() => undefined);
  }
  services.session.reset({ mintNewId: true });
  services.transcript.reset();
  // New session id → no plan until the agent creates one.
  await services.plan.load(services.session.sessionId).catch(() => undefined);
  services.session.setPlanApproved(false);
  notice(services, "info", "fresh session started");
}

export function handleClean(services: AppServices): void {
  services.session.reset({ mintNewId: true });
  services.transcript.reset();
  void services.plan.load(services.session.sessionId).catch(() => undefined);
  services.session.setPlanApproved(false);
  notice(services, "info", "fresh session started");
}

export function handleThink(services: AppServices): void {
  services.transcript.toggleThinkingGlobal();
  const on = services.transcript.getState().expandThinkingGlobal;
  notice(services, "info", `thinking view → ${on ? "expanded" : "collapsed"}`);
}

export function handleContext(services: AppServices): void {
  const { messages, tokens } = services.session.estimateContext();
  // Same chars/3.3 heuristic + budget the agent loop uses for auto-compact.
  const budget = AUTO_COMPACT_TOKEN_BUDGET;
  const pct = budget > 0 ? Math.min(100, Math.round((tokens / budget) * 100)) : 0;
  notice(
    services,
    "info",
    `context: ${messages} messages · ~${tokens.toLocaleString()} tokens` +
      ` (~${pct}% of auto-compact budget ${budget.toLocaleString()})`,
  );
}

export async function handleCompact(services: AppServices): Promise<void> {
  if (services.session.getState().running) {
    notice(services, "warn", "wait for the current operation to finish");
    return;
  }
  if (services.session.getState().compacting) {
    notice(services, "info", "compaction already in progress…");
    return;
  }
  // Need either model history or a visual transcript to compact.
  const historyLen = services.session.messages.length;
  const visualCount = services.transcript.getState().order.length;
  if (historyLen === 0 && visualCount === 0) {
    notice(services, "info", "nothing to compact yet — more conversation is needed");
    return;
  }

  notice(services, "info", "compacting conversation…");
  try {
    // Classic-style structured transcript (prompts, tools+outputs, answers,
    // prior compacted memory from the last card onward). Combined with model
    // history inside compactMessagesWithSummary so /history resume + new turns
    // all feed the summary.
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
    // The `compacted` AppEvent already appends the ✦ Compacted context card.
    notice(
      services,
      "info",
      `context compacted — earlier turns summarized into a memory · ` +
        `freed ~${freed.toLocaleString()} tokens (${pct}% smaller, ` +
        `~${result.beforeTokens.toLocaleString()} → ~${result.afterTokens.toLocaleString()} est.)`,
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
    // Fall back to direct upsert if persistNow fails for any reason.
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
  } catch (error) {
    notice(
      services,
      "warn",
      `could not chdir: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
