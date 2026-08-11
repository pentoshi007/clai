import type { PanelEffect } from "./panel-effect.js";
import type {
  PanelControllerDeps,
  PanelSnapshot,
} from "./panel-controller.js";
import {
  createJobTailPagerSource,
  isLiveJobStatus,
  jobTailTitle,
} from "../../ui-core/rendering/job-tail-source.js";

export interface PanelEffectContext {
  readonly deps: PanelControllerDeps;
  readonly snapshot: PanelSnapshot;
  readonly closeSearch: () => void;
  readonly openJobTail: (jobId: string) => void;
  readonly loadPagerPage: (offset: number) => void;
}

export function applyPanelEffects(
  effects: readonly PanelEffect[],
  context: PanelEffectContext,
): void {
  for (const effect of effects) applyPanelEffect(effect, context);
}

function applyPanelEffect(effect: PanelEffect, context: PanelEffectContext): void {
  const { deps, snapshot } = context;
  const overlay = deps.overlay;
  switch (effect.kind) {
    case "close":
      if (snapshot.overlay.kind === "none") context.closeSearch();
      else overlay.close();
      return;
    case "picker-select":
      overlay.selectPicker(effect.value);
      return;
    case "picker-row-action":
      overlay.actOnPickerRow(effect.value);
      return;
    case "confirm":
      overlay.answerConfirm(effect.ok);
      return;
    case "confirm-plan":
      overlay.answerPlanConfirm(effect.result);
      return;
    case "view-plan":
      if (snapshot.overlay.kind === "confirm") snapshot.overlay.onViewPlan?.();
      return;
    case "view-file":
      if (snapshot.overlay.kind === "confirm") snapshot.overlay.onViewFile?.();
      return;
    case "secret":
      overlay.answerSecret(effect.value);
      return;
    case "scope":
      overlay.answerScope(effect.targets);
      return;
    case "keys":
      overlay.answerKeys(effect.answer);
      return;
    case "copy":
      void deps.clipboard.writeText(effect.text);
      deps.onToast("copied");
      return;
    case "resend":
      if (snapshot.overlay.kind === "prompt-actions") {
        snapshot.overlay.request.onResend();
      }
      return;
    case "edit-prompt":
      deps.onEditPrompt(effect.text);
      return;
    case "open-pager":
      overlay.openPager(effect.title, effect.body, undefined, undefined, effect.markdown);
      return;
    case "job-tail":
      context.openJobTail(effect.jobId);
      return;
    case "job-stop":
      void deps.jobs?.stop(effect.jobId);
      deps.onToast(`stopping ${effect.jobId}`);
      return;
    case "pager-page":
      context.loadPagerPage(effect.offset);
      return;
    case "pager-search":
      return;
    case "pager-export-scrollback":
      deps.exportScrollback?.(snapshot.pagerBody);
      return;
    case "pager-export-editor":
      deps.exportEditor?.(snapshot.pagerBody);
      return;
    case "search-open":
      context.closeSearch();
      deps.onRevealItem(effect.itemId);
      return;
    case "plan-hide":
      deps.onHidePlan();
      return;
    case "toast":
      deps.onToast(effect.text);
      return;
    default:
      return;
  }
}

export function openPanelJobTail(
  deps: PanelControllerDeps,
  jobId: string,
): void {
  const jobs = deps.jobs;
  if (!jobs) return;
  const job = jobs.get(jobId);
  if (!job) return;
  const source = createJobTailPagerSource({ jobs, jobId });
  const title = jobTailTitle(job.commandDisplay, isLiveJobStatus(job.status));
  if (!deps.overlay.openPager(title, "", source)) {
    deps.onToast("could not open job output");
  }
}
