import type { BackgroundJob, JobsPort } from "../../app/ports/jobs-port.js";
import type { OverlayState } from "../../ui-core/controllers/overlay-controller.js";
import { confirmKey, confirmRowsWanted } from "./confirm-panel.js";
import { jobsKey, JOBS_INITIAL_STATE } from "./jobs-panel.js";
import { keysInitialState, keysKey } from "./keys-panel.js";
import {
  pagerKey,
  pagerViewModel,
  PAGER_INITIAL_STATE,
  resolvePagerMarkdownMode,
} from "./pager-panel.js";
import type { PanelEffect } from "./panel-effect.js";
import { applyPanelEffects, openPanelJobTail } from "./panel-effects.js";
import { planKey } from "./plan-panel.js";
import { pickerInitialState, pickerKey } from "./picker-panel.js";
import {
  promptActionsKey,
  promptLines,
  PROMPT_ACTIONS_INITIAL_STATE,
} from "./prompt-actions-panel.js";
import { EMPTY_SNAPSHOT_BASE } from "./panel-initial-states.js";
import type {
  PanelControllerDeps,
  PanelSnapshot,
} from "./panel-types.js";
import { panelWheelMove } from "./panel-wheel.js";
import { scopeInitialState, scopeKey } from "./scope-panel.js";
import { searchKey, SEARCH_INITIAL_STATE } from "./search-panel.js";
import { secretInitialState, secretKey, secretPaste } from "./secret-panel.js";
import { OVERLAY_MIN_ROWS } from "../chrome/row-budget.js";

export type { PanelControllerDeps, PanelKind, PanelSnapshot } from "./panel-types.js";

export class PanelController {
  private snapshot: PanelSnapshot;
  private readonly listeners = new Set<() => void>();
  private tracked: OverlayState;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: PanelControllerDeps) {
    this.tracked = deps.overlay.getState();
    this.snapshot = {
      ...EMPTY_SNAPSHOT_BASE,
      overlay: this.tracked,
      kind: this.tracked.kind,
      secret: secretInitialState(),
      search: undefined,
    };
    this.unsubscribe = deps.overlay.subscribe(() => this.onOverlayChange());
    this.syncOverlay(this.tracked);
  }

  getSnapshot = (): PanelSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.listeners.clear();
  }

  isOpen(): boolean {
    return this.snapshot.kind !== "none";
  }

  openSearch(): void {
    this.publish({ ...this.snapshot, search: SEARCH_INITIAL_STATE });
  }

  closeSearch(): void {
    if (this.snapshot.search === undefined) return;
    this.publish({ ...this.snapshot, search: undefined });
  }

  /** Rows the panel asks the allocator for, before it is clamped. */
  rowsWanted(): number {
    const snapshot = this.snapshot;
    const columns = this.deps.columns();
    const terminalRows = this.deps.rows();
    const generous = Math.max(OVERLAY_MIN_ROWS, Math.floor(terminalRows * 0.92));
    switch (snapshot.overlay.kind) {
      case "none":
        return snapshot.search === undefined ? 0 : generous;
      case "confirm":
        return confirmRowsWanted(snapshot.overlay.request, columns);
      case "secret":
        return OVERLAY_MIN_ROWS;
      case "prompt-actions":
        return Math.min(
          generous,
          promptLines(snapshot.overlay.request.prompt, columns).length + 2,
        );
      default:
        return generous;
    }
  }

  handlePaste(text: string): boolean {
    if (this.snapshot.overlay.kind === "secret") {
      this.publish({ ...this.snapshot, secret: secretPaste(this.snapshot.secret, text) });
      return true;
    }
    return this.handleKey("", text);
  }

  handlePlanKey(chord: string, focused: boolean): boolean {
    const plan = this.deps.plan();
    if (!plan) return false;
    const result = planKey({
      state: this.snapshot.plan,
      chord,
      plan,
      rows: this.deps.rows(),
      focused,
    });
    if (!result.handled) return false;
    this.publish({ ...this.snapshot, plan: result.state });
    this.apply(result.effects);
    return true;
  }

  handleKey(chord: string, text?: string): boolean {
    const snapshot = this.snapshot;
    const rows = this.deps.rows();

    switch (snapshot.overlay.kind) {
      case "picker": {
        const result = pickerKey({
          request: snapshot.overlay.request,
          state: snapshot.picker,
          chord,
          text,
          rows,
        });
        if (!result.handled) return false;
        this.publish({ ...snapshot, picker: result.state });
        this.apply(result.effects);
        return true;
      }
      case "pager": {
        const view = pagerViewModel(
          snapshot.pagerBody,
          this.deps.columns(),
          rows,
          snapshot.pager.format,
        );
        const result = pagerKey({
          state: snapshot.pager,
          chord,
          text,
          lines: view.lines,
          searchLines: view.searchLines,
          rows,
          live: snapshot.pagerLive,
          body: snapshot.pagerBody,
        });
        if (!result.handled) return false;
        this.publish({ ...snapshot, pager: result.state });
        this.apply(result.effects);
        return true;
      }
      case "jobs": {
        const result = jobsKey({
          state: snapshot.jobs,
          chord,
          jobs: this.jobList(),
          rows,
        });
        if (!result.handled) return false;
        this.publish({ ...snapshot, jobs: result.state });
        this.apply(result.effects);
        return true;
      }
      case "confirm": {
        const result = confirmKey({ request: snapshot.overlay.request, chord });
        this.apply(result.effects);
        return result.handled;
      }
      case "secret": {
        const result = secretKey({ state: snapshot.secret, chord, text });
        this.publish({ ...snapshot, secret: result.state });
        this.apply(result.effects);
        return result.handled;
      }
      case "scope-editor": {
        const result = scopeKey({ state: snapshot.scope, chord, text, rows });
        if (!result.handled) return false;
        this.publish({ ...snapshot, scope: result.state });
        this.apply(result.effects);
        return true;
      }
      case "keys-editor": {
        const result = keysKey({
          state: snapshot.keys,
          request: snapshot.overlay.request,
          chord,
          text,
          rows,
        });
        if (!result.handled) return false;
        this.publish({ ...snapshot, keys: result.state });
        this.apply(result.effects);
        return true;
      }
      case "prompt-actions": {
        const result = promptActionsKey({
          state: snapshot.promptActions,
          chord,
          request: snapshot.overlay.request,
          lineCount: promptLines(snapshot.overlay.request.prompt, this.deps.columns()).length,
          rows,
        });
        if (!result.handled) return false;
        this.publish({ ...snapshot, promptActions: result.state });
        this.apply(result.effects);
        return true;
      }
      default:
        break;
    }

    if (snapshot.search !== undefined) {
      const result = searchKey({
        state: snapshot.search,
        chord,
        text,
        transcript: this.deps.transcript(),
        rows,
      });
      if (!result.handled) return false;
      this.publish({ ...snapshot, search: result.state });
      this.apply(result.effects);
      return true;
    }
    return false;
  }
  /** Trackpad / mouse-wheel scrolling on whichever overlay owns the screen. */
  handleWheel(direction: 1 | -1, steps = 3): boolean {
    const moved = panelWheelMove(
      this.snapshot,
      {
        rows: this.deps.rows(),
        columns: this.deps.columns(),
        transcript: this.deps.transcript,
        jobs: this.jobList(),
      },
      direction,
      steps,
    );
    if (!moved) return false;
    this.publish({ ...this.snapshot, ...moved.patch });
    this.apply(moved.effects);
    return true;
  }

  private jobList(): readonly BackgroundJob[] {
    const jobs = this.deps.jobs;
    if (!jobs) return [];
    return jobs.recent?.(20) ?? jobs.running();
  }

  private onOverlayChange(): void {
    const next = this.deps.overlay.getState();
    if (next === this.tracked) return;
    this.tracked = next;
    this.syncOverlay(next);
  }

  private syncOverlay(state: OverlayState): void {
    const base: PanelSnapshot = {
      ...this.snapshot,
      overlay: state,
      kind: state.kind === "none" && this.snapshot.search !== undefined ? "search" : state.kind,
    };
    switch (state.kind) {
      case "picker":
        this.publish({ ...base, picker: pickerInitialState(state.request) });
        return;
      case "pager": {
        const pagerMarkdown = resolvePagerMarkdownMode(state.body, state.markdown);
        this.publish({
          ...base,
          pager: {
            ...PAGER_INITIAL_STATE,
            format: pagerMarkdown === "force" ? "formatted" : "raw",
          },
          pagerBody: state.body,
          pagerMarkdown,
          pagerLive: state.source?.watch !== undefined,
        });
        if (state.source) void this.loadPagerPage(state, 0);
        return;
      }
      case "jobs":
        this.publish({ ...base, jobs: JOBS_INITIAL_STATE });
        return;
      case "secret":
        this.publish({ ...base, secret: secretInitialState() });
        return;
      case "scope-editor":
        this.publish({ ...base, scope: scopeInitialState(state.request) });
        return;
      case "keys-editor":
        this.publish({ ...base, keys: keysInitialState(state.request) });
        return;
      case "prompt-actions":
        this.publish({ ...base, promptActions: PROMPT_ACTIONS_INITIAL_STATE });
        return;
      default:
        this.publish(base);
    }
  }

  private async loadPagerPage(state: OverlayState, offset: number): Promise<void> {
    if (state.kind !== "pager" || !state.source) return;
    try {
      const page = await state.source.readPage(offset);
      if (this.deps.overlay.getState() !== state) return;
      this.publish({ ...this.snapshot, pagerBody: page.body });
    } catch {
      this.deps.onToast("could not read artifact page");
    }
  }

  private apply(effects: readonly PanelEffect[]): void {
    applyPanelEffects(effects, {
      deps: this.deps,
      snapshot: this.snapshot,
      closeSearch: () => this.closeSearch(),
      openJobTail: (jobId) => openPanelJobTail(this.deps, jobId),
      loadPagerPage: (offset) => void this.loadPagerPage(this.snapshot.overlay, offset),
    });
  }

  private publish(snapshot: PanelSnapshot): void {
    this.snapshot = {
      ...snapshot,
      kind:
        snapshot.overlay.kind === "none" && snapshot.search !== undefined
          ? "search"
          : snapshot.overlay.kind,
    };
    for (const listener of this.listeners) listener();
  }
}
