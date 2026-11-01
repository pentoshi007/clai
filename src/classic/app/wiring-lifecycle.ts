import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { safeCwd } from "../../os/cwd.js";
import { composerActionPort } from "../../ui-core/composer/composer-action-port.js";
import { promptPlanApprovalIfNeeded } from "../../ui-core/plan/plan-lifecycle.js";
import { readTerminalSize, RESIZE_DEBOUNCE_MS } from "../chrome/use-terminal-size.js";
import { ESC_CANCEL_WINDOW_MS } from "../input/terminal-sequences.js";
import { readBranchFromGitDir } from "./git-branch.js";
import { stepWheelFeed } from "./wiring-feed-scroll.js";
import { nextPaintPacing, paintIntervalMs } from "./paint-pacing.js";
import type { ClassicAppSnapshot, WiringHost } from "./wiring-types.js";

const ANIMATION_INTERVAL_MS = 250;
const TICK_INTERVAL_MS = 1000;
const BRANCH_REFRESH_INTERVAL_MS = 5000;
const execFile = promisify(execFileCallback);

async function refreshBranch(host: WiringHost): Promise<void> {
  if (host.disposed) return;
  const cwd = safeCwd();
  const request = ++host.branchRefreshRequest;
  const cwdChanged = host.cwdValue !== cwd;
  if (cwdChanged) {
    host.cwdValue = cwd;
    host.branchValue = undefined;
    host.schedulePaint();
  }

  let branch = await readBranchFromGitDir(cwd);
  if (branch === undefined) {
    try {
      const result = await execFile(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd, timeout: 1500, encoding: "utf8" },
      );
      branch = result.stdout.trim() || undefined;
    } catch {
      branch = undefined;
    }
  }

  if (host.disposed || request !== host.branchRefreshRequest) return;
  if (safeCwd() !== cwd || host.cwdValue !== cwd) return;
  if (host.branchValue !== branch) {
    host.branchValue = branch;
    host.schedulePaint();
  }
}

export function disposeWiring(host: WiringHost): void {
  if (host.disposed) return;
  host.disposed = true;
  if (host.paintTimer) clearTimeout(host.paintTimer);
  if (host.resizeTimer) clearTimeout(host.resizeTimer);
  if (host.decoderTimer) clearTimeout(host.decoderTimer);
  if (host.escapeTimer) clearTimeout(host.escapeTimer);
  if (host.tickTimer) clearInterval(host.tickTimer);
  if (host.animationTimer) clearInterval(host.animationTimer);
  if (host.selectionAutoScrollTimer) clearInterval(host.selectionAutoScrollTimer);
  host.selectionAutoScrollTimer = undefined;
  if (host.branchRefreshTimer) clearInterval(host.branchRefreshTimer);
  host.branchRefreshRequest += 1;
  host.searchFocusRelease?.();
  host.searchFocusRelease = undefined;
  for (const dispose of host.disposers.splice(0)) dispose();
  host.panels.dispose();
  host.listeners.clear();
}

export function attachWiring(host: WiringHost): void {
  host.disposers.push(
    composerActionPort.registerInsert((text) => {
      host.services.focus.focusRegion("composer");
      host.composer.insertToken(text);
      host.schedulePaint();
    }),
    host.composer.subscribe(() => host.schedulePaint(true)),
    host.panels.subscribe(() => {
      host.syncSearchFocus();
      host.schedulePaint(true);
    }),
    host.services.session.subscribe(() => host.onSessionChange()),
    host.services.transcript.subscribe(() => host.onTranscriptChange()),
    host.services.plan.subscribe(() => host.onPlanChange()),
    host.services.toast.subscribe(() => host.schedulePaint()),
    host.services.focus.onChange(() => host.schedulePaint(true)),
    host.services.selection.subscribe(() => host.schedulePaint(true)),
    host.services.ports.jobs.subscribe(() => {
      host.disarmEscapeIfIdle();
      host.schedulePaint();
    }),
    host.services.session.onTurnEnd((result) => {
      host.ladder.disarmEscape();
      host.turnStartedAtValue = undefined;
      host.cwdValue = safeCwd();
      host.branchValue = undefined;
      host.schedulePaint();
      void refreshBranch(host);
      if (result.status === "completed") void promptPlanApprovalIfNeeded(host.services);
    }),
  );

  const onResize = (): void => {
    if (host.resizeTimer) clearTimeout(host.resizeTimer);
    host.resizeTimer = setTimeout(() => {
      host.resizeTimer = undefined;
      const size = readTerminalSize(host.resizeSource);
      if (size.columns === host.columns && size.rows === host.rows) return;
      host.columns = size.columns;
      host.rows = size.rows;
      host.feedNowValue = host.now();
      host.schedulePaint();
    }, RESIZE_DEBOUNCE_MS);
    host.resizeTimer.unref?.();
  };
  host.resizeSource.on("resize", onResize);
  host.disposers.push(() => host.resizeSource.off("resize", onResize));

  host.tickTimer = setInterval(() => {
    if (!host.needsCadence()) return;
    host.feedNowValue = host.now();
    host.tickValue += 1;
    host.schedulePaint();
  }, TICK_INTERVAL_MS);
  host.tickTimer.unref?.();

  host.animationTimer = setInterval(() => {
    const demand = host.animationDemand();
    if (demand === "none") {
      if (host.animationTickValue % 4 < 2) return;
      host.animationTickValue += 4 - (host.animationTickValue % 4);
      host.schedulePaint();
      return;
    }
    host.animationTickValue += 1;
    if (demand === "caret" && host.animationTickValue % 2 !== 0) return;
    host.schedulePaint();
  }, ANIMATION_INTERVAL_MS);
  host.animationTimer.unref?.();

  void refreshBranch(host);
  host.branchRefreshTimer = setInterval(() => void refreshBranch(host), BRANCH_REFRESH_INTERVAL_MS);
  host.branchRefreshTimer.unref?.();
}

export function onSessionChange(host: WiringHost): void {
  const state = host.services.session.getState();
  host.sessionStateValue = state;
  if (state.sessionId !== host.previousSessionId) {
    host.previousSessionId = state.sessionId;
    host.bumpFeedGeneration();
    host.cwdValue = safeCwd();
    host.branchValue = undefined;
    void refreshBranch(host);
    void host.services.plan.load(state.sessionId).catch(() => undefined);
  }
  if (state.running && host.turnStartedAtValue === undefined) host.turnStartedAtValue = host.now();
  if (!state.running && !state.compacting) host.disarmEscapeIfIdle();
  host.queueSelectedValue = state.queued.length === 0 ? 0 : Math.min(host.queueSelectedValue, state.queued.length - 1);
  host.schedulePaint();
}

export function onTranscriptChange(host: WiringHost): void {
  host.sessionStateValue = undefined;
  const state = host.services.transcript.getState();
  if (state.order !== host.previousOrder) {
    const prefixPreserved = host.previousOrder.every((id, index) => state.order[index] === id);
    if (state.order.length < host.previousOrder.length || !prefixPreserved) host.bumpFeedGeneration();
    host.previousOrder = state.order;
    let latestTurnId: string | undefined;
    for (let index = state.order.length - 1; index >= 0; index -= 1) {
      const turnId = state.byId.get(state.order[index]!)?.turnId;
      if (turnId !== undefined) {
        latestTurnId = turnId;
        break;
      }
    }
    if (latestTurnId && latestTurnId !== host.activeTurnId) {
      host.activeTurnId = latestTurnId;
      host.wheel.stop();
      host.liveOffsetValue = 0;
      host.feedNavigationVersion += 1;
      host.turnStartedAtValue ??= host.now();
    }
  }
  host.feedNowValue = host.now();
  host.schedulePaint();
}

export function onPlanChange(host: WiringHost): void {
  const plan = host.services.plan.current();
  if (!plan) host.planVisibleValue = false;
  host.planKnown = plan !== undefined;
  host.schedulePaint();
}

export function sessionSnapshot(host: WiringHost): ClassicAppSnapshot["session"] {
  return host.sessionStateValue ??= host.services.session.getState();
}

export function buildSnapshot(host: WiringHost): ClassicAppSnapshot {
  const session = sessionSnapshot(host);
  const jobs = host.services.ports.jobs.recent?.(20, session.sessionId) ?? host.services.ports.jobs.running(session.sessionId);
  return {
    session,
    transcript: host.services.transcript.getState(),
    composer: host.composer.getSnapshot(),
    panel: host.panels.getSnapshot(),
    plan: host.services.plan.current(),
    toasts: host.services.toast.getToasts(),
    jobs,
    columns: host.columns,
    rows: host.rows,
    now: host.now(),
    feedNow: host.feedNowValue,
    tick: host.tickValue,
    animationTick: host.animationTickValue,
    feedGeneration: host.feedGenerationValue,
    liveOffset: host.liveOffsetValue,
    feedNavigationVersion: host.feedNavigationVersion,
    planVisible: host.planVisibleValue,
    queueVisible: host.queueVisibleValue,
    queueSelected: host.queueSelectedValue,
    cancelArmed: host.ladder.escapeArmed,
    turnStartedAt: host.turnStartedAtValue,
    cwd: host.cwdValue,
    branch: host.branchValue,
    contextLimitEditing: host.contextLimitEditingValue,
    contextLimitDraft: host.contextLimitDraftValue,
    scrollAbove: host.scrollAboveValue,
    scrollBelow: host.scrollBelowValue,
  };
}

export function schedulePaint(host: WiringHost, interactive = false): void {
  if (host.disposed) return;
  const now = host.now();
  const deadline = Math.max(now, host.lastPaintAt + paintIntervalMs(host.paintPacing, interactive));
  if (host.paintDeadline !== undefined && host.paintDeadline <= deadline) return;
  if (host.paintTimer) clearTimeout(host.paintTimer);
  host.paintDeadline = deadline;
  host.paintTimer = setTimeout(() => {
    host.paintTimer = undefined;
    host.paintDeadline = undefined;
    if (host.disposed) return;
    const startedAt = host.now();
    host.lastPaintAt = startedAt;
    const gliding = stepWheelFeed(host);
    host.snapshot = buildSnapshot(host);
    for (const listener of host.listeners) listener();
    if (gliding) host.schedulePaint(true);
    setImmediate(() => {
      if (!host.disposed) host.paintPacing = nextPaintPacing(host.paintPacing, host.now() - startedAt);
    });
  }, Math.max(0, deadline - now));
  host.paintTimer.unref?.();
}

export function scheduleDecoderFlush(host: WiringHost): void {
  if (host.decoderTimer) clearTimeout(host.decoderTimer);
  host.decoderTimer = undefined;
  const deadline = host.input.pendingDeadline;
  if (deadline === undefined) return;
  host.decoderTimer = setTimeout(() => {
    host.decoderTimer = undefined;
    setImmediate(() => flushWhenSettled(host));
  }, Math.max(0, deadline - host.now()));
  host.decoderTimer.unref?.();
}

function flushWhenSettled(host: WiringHost): void {
  if (host.disposed) return;
  const deadline = host.input.pendingDeadline;
  if (deadline !== undefined && deadline <= host.now()) {
    host.router.handleAll(host.input.flush());
    host.schedulePaint(true);
  }
  host.scheduleDecoderFlush();
}

export function scheduleEscapeExpiry(host: WiringHost): void {
  if (host.escapeTimer) clearTimeout(host.escapeTimer);
  host.escapeTimer = setTimeout(() => {
    host.escapeTimer = undefined;
    host.schedulePaint();
  }, ESC_CANCEL_WINDOW_MS + 1);
  host.escapeTimer.unref?.();
}
