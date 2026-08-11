import type { BackgroundJob } from "../../app/ports/jobs-port.js";
import type { TranscriptState } from "../../ui-core/state/transcript-types.js";
import { jobsKey } from "./jobs-panel.js";
import { keysKey } from "./keys-panel.js";
import { pagerKey, pagerViewModel } from "./pager-panel.js";
import type { PanelEffect } from "./panel-effect.js";
import type { PanelSnapshot } from "./panel-controller.js";
import { pickerKey } from "./picker-panel.js";
import { promptActionsKey, promptLines } from "./prompt-actions-panel.js";
import { scopeKey } from "./scope-panel.js";
import { searchKey } from "./search-panel.js";

export interface PanelWheelDeps {
  readonly rows: number;
  readonly columns: number;
  readonly transcript: () => TranscriptState;
  readonly jobs: readonly BackgroundJob[];
}

export interface PanelWheelMove {
  readonly patch: Partial<PanelSnapshot>;
  readonly effects: readonly PanelEffect[];
}

/**
 * Trackpad / mouse-wheel scrolling. Replays the panel's own cursor-motion
 * keys so wrapping, centering, and follow rules stay identical to arrows —
 * one controller repaint per gesture, not one per synthetic key.
 */
export function panelWheelMove(
  snapshot: PanelSnapshot,
  deps: PanelWheelDeps,
  direction: 1 | -1,
  steps: number,
): PanelWheelMove | undefined {
  const rows = deps.rows;
  const chord = direction === 1 ? "down" : "up";

  const run = <T>(
    initial: T,
    step: (state: T) => { handled: boolean; state: T; effects: readonly PanelEffect[] },
  ): { state: T; effects: PanelEffect[] } | undefined => {
    let state = initial;
    const effects: PanelEffect[] = [];
    for (let index = 0; index < steps; index += 1) {
      const result = step(state);
      if (!result.handled) return undefined;
      state = result.state;
      effects.push(...result.effects);
    }
    return state === initial ? undefined : { state, effects };
  };

  switch (snapshot.overlay.kind) {
    case "pager": {
      const view = pagerViewModel(snapshot.pagerBody, deps.columns, rows, snapshot.pager.format);
      const moved = run(snapshot.pager, (state) =>
        pagerKey({
          state,
          chord,
          lines: view.lines,
          searchLines: view.searchLines,
          rows,
          live: snapshot.pagerLive,
          body: snapshot.pagerBody,
        }),
      );
      return moved ? { patch: { pager: moved.state }, effects: moved.effects } : undefined;
    }
    case "picker": {
      const request = snapshot.overlay.request;
      const moved = run(snapshot.picker, (state) => pickerKey({ request, state, chord, rows }));
      return moved ? { patch: { picker: moved.state }, effects: moved.effects } : undefined;
    }
    case "jobs": {
      const moved = run(snapshot.jobs, (state) => jobsKey({ state, chord, jobs: deps.jobs, rows }));
      return moved ? { patch: { jobs: moved.state }, effects: moved.effects } : undefined;
    }
    case "scope-editor": {
      const moved = run(snapshot.scope, (state) => scopeKey({ state, chord, rows }));
      return moved ? { patch: { scope: moved.state }, effects: moved.effects } : undefined;
    }
    case "keys-editor": {
      const request = snapshot.overlay.request;
      const moved = run(snapshot.keys, (state) => keysKey({ state, request, chord, rows }));
      return moved ? { patch: { keys: moved.state }, effects: moved.effects } : undefined;
    }
    case "prompt-actions": {
      const request = snapshot.overlay.request;
      const moved = run(snapshot.promptActions, (state) =>
        promptActionsKey({
          state,
          chord,
          request,
          lineCount: promptLines(request.prompt, deps.columns).length,
          rows,
        }),
      );
      return moved
        ? { patch: { promptActions: moved.state }, effects: moved.effects }
        : undefined;
    }
    default:
      break;
  }

  if (snapshot.search !== undefined) {
    const moved = run(snapshot.search, (state) =>
      searchKey({ state, chord, transcript: deps.transcript(), rows }),
    );
    return moved ? { patch: { search: moved.state }, effects: moved.effects } : undefined;
  }
  return undefined;
}
