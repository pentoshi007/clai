/**
 * Session lifecycle slash commands (V2-080): mode, clear/new/clean, save/reset,
 * allow/disallow, think, context, compact.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setDefaultMode, getConfig } from "../../store/config.js";
import { upsertSession, clearAllHistory } from "../../store/history.js";
import { safeCwd } from "../../os/cwd.js";
import { clearActiveProjectRoot } from "../../agent/project-root.js";
import type { CommandInvocation } from "../../app/commands/command.js";
import type { Mode } from "../../types.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import { serializeTranscriptForCompaction } from "../state/transcript-compaction.js";
import { conversationItemCount } from "../state/transcript-types.js";

import { notify } from "../notify.js";

function notice(services: AppServices, level: "info" | "warn", text: string): void {
  services.session.notice(level, text);
}

/** Short chrome feedback — toast only (no transcript clutter). */
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

export function handleClear(services: AppServices): void {
  services.session.reset();
  services.transcript.reset();
  // Drop in-memory plan; session id is unchanged so the on-disk plan remains
  // for this session, but the UI should not show a stale card after clear.
  void services.plan.load(services.session.sessionId).catch(() => undefined);
  flash(services, "Context cleared", { key: "session", level: "success" });
}

export async function handleNew(services: AppServices): Promise<void> {
  const messages = services.session.messages;
  if (!getConfig().privateMode && messages.some((m) => m.role === "user")) {
    // Save messages + visual transcript so /history can restore the old chat.
    await services.session.persistNow().catch(() => undefined);
  }
  clearActiveProjectRoot();
  services.plan.clear();
  services.session.reset({ mintNewId: true });
  services.transcript.reset();
  // New session id → no plan until the agent creates one.
  await services.plan.load(services.session.sessionId).catch(() => undefined);
  services.session.setPlanApproved(false);
  flash(services, "Fresh session", { key: "session", level: "success" });
}

export function handleClean(services: AppServices): void {
  clearActiveProjectRoot();
  services.plan.clear();
  services.session.reset({ mintNewId: true });
  services.transcript.reset();
  void services.plan.load(services.session.sessionId).catch(() => undefined);
  services.session.setPlanApproved(false);
  flash(services, "Fresh session", { key: "session", level: "success" });
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
  const snap = services.session.getState().contextUsage;
  const exact = snap?.exact === true;
  // Used tokens only — do not invent a model window (limits vary / are unknown).
  const usedLabel = exact
    ? `${tokens.toLocaleString()} tokens`
    : `~${tokens.toLocaleString()} tokens (estimate)`;
  const sessionBits =
    snap && (snap.sessionPromptTokens > 0 || snap.sessionCompletionTokens > 0)
      ? ` · session in ${snap.sessionPromptTokens.toLocaleString()} / out ${snap.sessionCompletionTokens.toLocaleString()}`
      : "";
  const text = `context: ${messages} messages · ${usedLabel}${sessionBits}`;
  notice(services, "info", text);
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
  // Notices are UI-only and do not count as conversation material.
  const historyLen = services.session.messages.length;
  const visualCount = conversationItemCount(services.transcript.getState());
  if (historyLen === 0 && visualCount === 0) {
    notice(services, "info", "nothing to compact yet — more conversation is needed");
    return;
  }

  // Status line already shows "compacting · Ns" — no transcript notice spam.
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
    // Compacted card is already in the transcript; short toast only (no notice row).
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
