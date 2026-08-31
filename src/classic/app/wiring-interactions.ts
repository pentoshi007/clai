import { consumePlanSuggestionInput } from "../../ui-core/plan/plan-lifecycle.js";
import { notify } from "../../ui-core/notify.js";
import { contextLimitInput } from "../chrome/context-limit-editor.js";
import { formatPlanPagerDocument } from "../../ui-core/rendering/plan-view.js";
import { openToolOutputPager } from "../../ui-core/rendering/open-tool-output.js";
import {
  itemSearchText,
  transcriptItems,
  type TranscriptItem,
} from "../../ui-core/state/transcript-types.js";
import { extractTranscriptSemanticDocument } from "../../ui-core/rendering/transcript-semantic.js";
import type { FeedSnapshot } from "./use-feed.js";
import type { MouseEvent } from "../input/key-event.js";
import { handleTranscriptMouse } from "./wiring-selection.js";
import type { WiringHost } from "./wiring-types.js";

export function observeFeed(host: WiringHost, feed: FeedSnapshot): void {
  const window = feed.window;
  const anchor = host.feedWindowAnchor;
  if (
    host.liveOffsetValue > 0 &&
    anchor !== undefined &&
    anchor.columns === feed.columns &&
    anchor.generation === feed.generation &&
    window.totalRows > anchor.totalRows
  ) {
    host.liveOffsetValue += window.totalRows - anchor.totalRows;
  }
  host.feedWindowAnchor = {
    totalRows: window.totalRows,
    columns: feed.columns,
    generation: feed.generation,
  };
  host.maxLiveOffset = window.maxOffset;
  if (host.liveOffsetValue > host.maxLiveOffset) host.liveOffsetValue = host.maxLiveOffset;
  host.feedViewportRows = window.viewportRows;
  host.scrollAboveValue = window.scrollAbove;
  host.scrollBelowValue = window.offset;
  host.selectedFeedItemId = window.lastItemId ?? feed.blocks.at(-1)?.itemId;
}

export function setComposerTextWidth(host: WiringHost, width: number): void {
  host.composer.setTextWidth(width);
}

export function startContextLimitEditing(host: WiringHost): void {
  if (host.contextLimitEditingValue) return;
  const limit = host.services.session.getState().contextUsage?.contextLimit ?? 0;
  host.contextLimitDraftValue = limit > 0 ? String(limit) : "";
  host.contextLimitEditingValue = true;
  host.services.focus.setInputCaptured(true);
  host.services.focus.focusRegion("composer");
  host.schedulePaint();
}

function finishContextLimitEditing(host: WiringHost): void {
  host.contextLimitEditingValue = false;
  host.contextLimitDraftValue = "";
  host.services.focus.setInputCaptured(false);
  host.services.focus.focusRegion("composer");
  host.schedulePaint();
}

export function handleContextLimitKey(
  host: WiringHost,
  key: import("../input/key-event.js").KeyEvent,
  chord: string,
): void {
  if (!host.contextLimitEditingValue) return;
  if (chord === "escape") {
    finishContextLimitEditing(host);
    return;
  }
  if (chord === "enter") {
    const parsed = contextLimitInput(host.contextLimitDraftValue);
    if (parsed === null) {
      notify(host.services, "context limit must be at least 20k (for example 253k)", {
        level: "warn",
        key: "context-limit",
      });
      return;
    }
    host.services.session.setContextLimitTokens(parsed);
    notify(
      host.services,
      parsed === undefined ? "context limit reset" : `context limit · ${host.contextLimitDraftValue.trim()}`,
      { key: "context-limit", level: "success", durationMs: 1600 },
    );
    finishContextLimitEditing(host);
    return;
  }
  if (chord === "ctrl+u") {
    host.contextLimitDraftValue = "";
    host.schedulePaint();
    return;
  }
  if (chord === "backspace" || chord === "delete") {
    host.contextLimitDraftValue = host.contextLimitDraftValue.slice(0, -1);
    host.schedulePaint();
    return;
  }
  if (
    key.text.length > 0 &&
    !key.ctrl &&
    !key.alt &&
    !key.meta &&
    [...key.text].every((char) => char >= " " && char !== "\x7f")
  ) {
    host.contextLimitDraftValue += key.text;
    host.schedulePaint();
  }
}

export function handleContextLimitPaste(host: WiringHost, text: string): void {
  if (!host.contextLimitEditingValue || text.length === 0) return;
  host.contextLimitDraftValue += text.replace(/[\r\n]/g, "");
  host.schedulePaint();
}

export function setQueueSelected(host: WiringHost, index: number): void {
  const count = host.services.session.getState().queued.length;
  host.queueSelectedValue = count === 0 ? 0 : Math.max(0, Math.min(index, count - 1));
  host.schedulePaint();
}

export function moveQueueSelection(host: WiringHost, delta: number): void {
  const count = host.services.session.getState().queued.length;
  if (count === 0) return;
  const next = (host.queueSelectedValue + delta + count) % count;
  setQueueSelected(host, next);
}

function queueTarget(host: WiringHost): number | undefined {
  const count = host.services.session.getState().queued.length;
  if (count === 0) {
    notify(host.services, "no queued prompts", { level: "info" });
    return undefined;
  }
  return Math.max(0, Math.min(host.queueSelectedValue, count - 1));
}

export function sendQueuedNow(host: WiringHost): void {
  const index = queueTarget(host);
  if (index === undefined) return;
  host.services.session.sendQueuedNow(index);
  notify(host.services, "queued prompt promoted to next", { level: "success" });
  setQueueSelected(host, 0);
}

export function editQueued(host: WiringHost): void {
  const index = queueTarget(host);
  if (index === undefined) return;
  const text = host.services.session.takeQueued(index);
  if (text === undefined) return;
  host.composer.setText(text);
  notify(host.services, "queued prompt moved into the composer", { level: "info" });
  setQueueSelected(host, index);
}

export function removeQueued(host: WiringHost): void {
  const index = queueTarget(host);
  if (index === undefined) return;
  host.services.session.removeQueued(index);
  notify(host.services, "queued prompt dropped", { level: "info" });
  setQueueSelected(host, index);
}

export function handlePanelKey(
  host: WiringHost,
  text: string,
  chord: string,
  context: string,
): void {
  if (context === "composer" && host.composer.handleChord(chord)) return;
  if (context === "plan" && host.panels.handlePlanKey(chord, true)) return;
  host.panels.handleKey(chord, text);
}

export function handleMouse(host: WiringHost, event: MouseEvent): void {
  handleTranscriptMouse(host, event);
}

export function submit(host: WiringHost, prompt: string): void {
  const trimmed = prompt.trim();
  if (!trimmed) return;
  if (host.services.commands.looksLikeCommand(trimmed)) {
    const invocation = host.services.commands.parse(trimmed, "composer");
    if (!invocation) {
      host.services.session.notice("warn", `unknown or ambiguous command: ${trimmed.split(/\s/)[0]}`);
      return;
    }
    void host.services.commands
      .dispatch(invocation)
      .then((handled) => {
        if (!handled) {
          host.services.session.notice("warn", `command unavailable: /${invocation.name}`);
        }
      })
      .catch((error: unknown) => {
        host.services.session.notice("warn", error instanceof Error ? error.message : String(error));
      });
    return;
  }
  const suggestion = consumePlanSuggestionInput(host.services, trimmed);
  const modelPrompt = suggestion?.modelPrompt ?? trimmed;
  const displayPrompt = suggestion?.displayPrompt;
  if (host.services.session.getState().running) {
    host.services.session.enqueue(modelPrompt, displayPrompt === undefined ? undefined : { displayPrompt });
  } else {
    void host.services.session.submit(modelPrompt, displayPrompt === undefined ? undefined : { displayPrompt });
  }
}

export function togglePlan(host: WiringHost): void {
  if (!host.services.plan.current()) {
    void host.openPlanDetail();
    return;
  }
  setPlanVisible(host, !host.planVisibleValue);
}

export function setPlanVisible(host: WiringHost, visible: boolean): void {
  if (visible && host.services.overlay.isOpen()) {
    host.services.overlay.close();
  }
  const hasPlan = host.services.plan.current() !== undefined;
  host.planVisibleValue = visible && hasPlan;
  if (hasPlan) host.planKnown = true;
  if (!host.planVisibleValue && host.services.focus.region() === "plan") {
    host.services.focus.focusRegion("transcript");
  }
  host.schedulePaint();
}

export async function openPlanDetail(host: WiringHost): Promise<void> {
  const plan =
    host.services.plan.current() ??
    (await host.services.plan.load(host.services.session.sessionId).catch(() => undefined));
  if (!plan) {
    notify(host.services, "No active plan", { key: "plan" });
    return;
  }
  host.services.overlay.openPager(
    `Plan · ${plan.goal}`,
    formatPlanPagerDocument(plan),
    undefined,
    undefined,
    "force",
  );
  setPlanVisible(host, false);
}

export function openSearch(host: WiringHost): void {
  if (host.services.overlay.isOpen() || host.panels.getSnapshot().search !== undefined) return;
  try {
    host.searchFocusRelease = host.services.focus.pushOverlay("transcript-search");
    host.panels.openSearch();
  } catch {
    host.searchFocusRelease?.();
    host.searchFocusRelease = undefined;
  }
}

export function syncSearchFocus(host: WiringHost): void {
  const open = host.panels.getSnapshot().search !== undefined;
  if (!open && host.searchFocusRelease) {
    host.searchFocusRelease();
    host.searchFocusRelease = undefined;
  }
}

export function closePanel(host: WiringHost): boolean {
  if (host.services.overlay.isOpen()) {
    host.services.overlay.close();
    return true;
  }
  if (host.panels.getSnapshot().search !== undefined) {
    host.panels.closeSearch();
    syncSearchFocus(host);
    return true;
  }
  return false;
}

export const WHEEL_SCROLL_ROWS = 3;

export function scrollFeed(host: WiringHost, delta: number): void {
  const next = Math.max(0, Math.min(host.maxLiveOffset, host.liveOffsetValue + delta));
  if (next === host.liveOffsetValue) {
    if (delta > 0 && !host.scrollToastShown) {
      host.scrollToastShown = true;
      notify(host.services, "transcript is already at the top · Ctrl+R to search", {
        key: "transcript-scroll",
        durationMs: 3200,
      });
    }
    return;
  }
  host.liveOffsetValue = next;
  host.schedulePaint();
}

export function showTranscriptTopHint(host: WiringHost): void {
  host.liveOffsetValue = host.maxLiveOffset;
  host.schedulePaint();
  notify(
    host.services,
    "transcript top · Ctrl+D returns to the latest response",
    { key: "transcript-top", durationMs: 2200 },
  );
}

export function toggleSelectedItem(host: WiringHost): void {
  const itemId = host.selectedFeedItemId;
  if (!itemId || itemId === "intro") return;
  const state = host.services.transcript.getState();
  const item = state.byId.get(itemId);
  if (!item) return;
  if (item.kind === "thinking" || item.kind === "tool" || item.kind === "compacted") {
    const fallback =
      item.kind === "thinking"
        ? state.expandThinkingGlobal
        : state.expandOutputGlobal;
    host.services.transcript.toggleItemOverride(itemId, fallback);
    return;
  }
  host.revealItem(itemId);
}

export function toggleThinking(host: WiringHost): void {
  host.services.transcript.toggleThinkingGlobal();
  const state = host.services.transcript.getState();
  notify(
    host.services,
    state.expandThinkingGlobal ? "Thinking expanded · ^T" : "Thinking collapsed · ^T",
    { key: "thinking", durationMs: 1800 },
  );
  const latest = [...transcriptItems(state)].reverse().find((item) => item.kind === "thinking");
  if (!latest) return;
}

export async function toggleOutput(host: WiringHost): Promise<void> {
  const state = host.services.transcript.getState();
  const latest = [...transcriptItems(state)].reverse().find(
    (item) => item.kind === "tool" || item.kind === "compacted",
  );
  if (!latest) {
    const inv = host.services.commands.parse("/output", "composer");
    if (inv) void host.services.commands.dispatch(inv);
    else
      notify(host.services, "No output to expand · ^O", {
        key: "output",
        durationMs: 1800,
      });
    return;
  }
  host.services.transcript.toggleOutputGlobal();
  const expanded = host.services.transcript.getState().expandOutputGlobal;
  notify(host.services, expanded ? "Output expanded · ^O" : "Output collapsed · ^O", {
    key: "output",
    durationMs: 1800,
  });
}

export function revealItem(host: WiringHost, itemId: string): void {
  if (itemId === "intro") return;
  const item = host.services.transcript.getState().byId.get(itemId);
  if (!item) return;
  if (item.kind === "thinking" || item.kind === "tool" || item.kind === "compacted") {
    const fallback =
      item.kind === "thinking"
        ? host.services.transcript.getState().expandThinkingGlobal
        : host.services.transcript.getState().expandOutputGlobal;
    host.services.transcript.toggleItemOverride(itemId, fallback);
    return;
  }
  host.services.overlay.openPager(
    host.itemTitle(item),
    itemSearchText(item),
    undefined,
    undefined,
    item.kind === "assistant" ? "auto" : "plain",
  );
}

export function itemTitle(item: TranscriptItem): string {
  switch (item.kind) {
    case "user":
      return "Prompt";
    case "assistant":
      return "Response";
    case "thinking":
      return "Thinking";
    case "tool":
      return `${item.name} · output`;
    case "compacted":
      return "Compacted context";
    case "notice": return "Notice";
    case "turn-summary": return "Turn summary";
  }
}

export function updateTranscriptDocument(host: WiringHost): void {
  const state = host.services.transcript.getState();
  host.services.selection.setDocument(
    "transcript",
    extractTranscriptSemanticDocument(state, {
      thinking: "all",
      toolOutput: (item) => host.services.session.spool.tail(item.toolCallId),
    }),
  );
}

export function selectAllTranscript(host: WiringHost): void {
  host.updateTranscriptDocument();
  if (!host.services.selection.selectAll("transcript")) {
    notify(host.services, "Transcript is empty", { key: "selection" });
  }
}

async function copyActiveSelection(host: WiringHost): Promise<void> {
  const result = await host.services.selection.copy();
  if (result.status === "copied") {
    notify(host.services, "Copied selection", { level: "success", key: "copy", durationMs: 1800 });
  } else if (result.status === "empty") {
    notify(host.services, "Nothing to copy", { key: "copy", durationMs: 1800 });
  } else {
    notify(host.services, "Copy failed", { level: "warn", key: "copy", durationMs: 1800 });
  }
}

export async function copyTranscript(host: WiringHost): Promise<void> {
  if (!host.services.selection.hasSelection()) {
    host.updateTranscriptDocument();
    host.services.selection.selectAll("transcript");
  }
  const result = await host.services.selection.copy();
  if (result.status === "copied") {
    notify(host.services, "Copied transcript", { level: "success", key: "copy" });
  } else if (result.status === "empty") {
    notify(host.services, "Nothing to copy", { key: "copy" });
  } else {
    notify(host.services, "Copy failed", { level: "warn", key: "copy" });
  }
}

export function exportScrollback(host: WiringHost, body: string): void {
  const overlay = host.services.overlay.getState();
  const title = overlay.kind === "pager" ? overlay.title : "Pager";
  const result = host.services.pagerExport.exportToScrollback(title, body);
  if (!result.ok) notify(host.services, result.error ?? "Scrollback export failed", { level: "warn" });
}

export async function exportEditor(host: WiringHost, body: string): Promise<void> {
  const result = await host.services.pagerExport.exportToEditor(body);
  if (!result.ok) notify(host.services, result.error ?? "Editor export failed", { level: "warn" });
}

export function bumpFeedGeneration(host: WiringHost): void {
  host.feedGenerationValue += 1;
  host.activeTurnId = undefined;
  host.liveOffsetValue = 0;
  host.maxLiveOffset = 0;
  host.feedWindowAnchor = undefined;
  host.feedNowValue = host.now();
}

export function disarmEscapeIfIdle(host: WiringHost): void {
  const busy =
    host.services.session.getState().queued.length > 0 ||
    host.services.cancel.hasCancelableWork();
  if (!busy) host.ladder.disarmEscape();
}

export function needsCadence(host: WiringHost): boolean {
  const state = host.services.session.getState();
  return (
    state.running ||
    state.compacting ||
    host.panels.getSnapshot().kind === "jobs" ||
    host.services.ports.jobs.running(state.sessionId).length > 0
  );
}

export function needsAnimation(host: WiringHost): boolean {
  const state = host.services.session.getState();
  return (
    state.running ||
    state.compacting ||
    host.services.toast.getToasts().length > 0 ||
    host.services.focus.activeContext() === "composer"
  );
}
