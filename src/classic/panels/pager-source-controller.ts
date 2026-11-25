import type { ArtifactPage } from "../../ui-core/rendering/artifact-pager-source.js";
import { canExtend, refreshReadingWindow, shiftReadingWindow, type ReadingWindow, type ScrollDirection } from "../../ui-core/rendering/pager-reading-window.js";
import { findPagerMatches } from "../../ui-core/state/pager-search.js";
import type { OverlayState } from "../../ui-core/controllers/overlay-controller.js";
import type { PanelControllerDeps, PanelSnapshot } from "./panel-types.js";
import type { PagerViewModel } from "./pager-panel.js";
import { panelBodyHeight } from "./panel-frame.js";

type PagerSourceControllerDeps = Pick<
  PanelControllerDeps,
  "overlay" | "clipboard" | "rows" | "onToast"
> & {
  readonly snapshot: () => PanelSnapshot;
  readonly publish: (snapshot: PanelSnapshot) => void;
  readonly pagerView: (body: string, overlay: OverlayState) => PagerViewModel;
};

export class PagerSourceController {
  private unwatch: (() => void) | undefined;
  private pull: (() => void) | undefined;
  private shifting = false;
  private page: ReadingWindow | undefined;
  private generation = 0;

  constructor(private readonly deps: PagerSourceControllerDeps) {}

  dispose(): void {
    this.deactivate();
  }

  deactivate(): void {
    this.unwatch?.();
    this.unwatch = undefined;
    this.pull = undefined;
    this.generation += 1;
  }

  activate(state: Extract<OverlayState, { kind: "pager" }>): void {
    this.shifting = false;
    this.page = undefined;
    if (state.source?.watch) {
      this.watch(state);
      return;
    }
    if (state.source) void this.load(state, 0);
  }

  handleKey(
    chord: string,
    state: Extract<OverlayState, { kind: "pager" }>,
    view: PagerViewModel,
  ): boolean {
    const page = this.page;
    const source = state.source;
    const pager = this.deps.snapshot().pager;
    if (!source || !page || pager.finding) return false;
    if (chord === "c") {
      void source.readAll().then((body) => {
        if (this.deps.overlay.getState() !== state) return;
        void this.deps.clipboard.writeText(body);
        this.deps.onToast("copied");
      }).catch((error) => this.deps.onToast(error instanceof Error ? error.message : "could not read full prompt history"));
      return true;
    }
    if (["home", "g", "ctrl+u"].includes(chord) && page.offset > 0) {
      this.load(state, 0);
      return true;
    }
    if (["end", "shift+g", "ctrl+d"].includes(chord) && canExtend(page, 1)) {
      this.load(state, Math.max(0, page.totalBytes - source.pageBytes), true);
      return true;
    }
    if (["up", "k", "pageup"].includes(chord)) this.prefetch(-1, state, view);
    if (["down", "j", "pagedown", "space"].includes(chord)) this.prefetch(1, state, view);
    return false;
  }

  prefetch(direction: ScrollDirection, state: Extract<OverlayState, { kind: "pager" }>, view: PagerViewModel): void {
    const { source } = state;
    const page = this.page;
    if (!source || !page || this.shifting || !canExtend(page, direction)) return;
    const { caret } = this.deps.snapshot().pager;
    const remaining = direction < 0 ? caret : view.lines.length - caret;
    if (remaining > this.deps.rows() * 2) return;
    this.shifting = true;
    const generation = ++this.generation;
    void shiftReadingWindow(source, page, direction).then(result => {
      if (generation !== this.generation) return;
      const next = result.window;
      const delta = result.changedAtTop ? this.deps.pagerView(next.body, state).lines.length - view.lines.length : 0;
      const snapshot = this.deps.snapshot();
      this.page = next;
      this.deps.publish({ ...snapshot, pagerBody: next.body, pagerPageOffset: next.offset, pager: {
        ...snapshot.pager, top: Math.max(0, snapshot.pager.top + delta), caret: Math.max(0, snapshot.pager.caret + delta), follow: false,
      } });
    }).catch(() => this.deps.onToast("could not read more output")).finally(() => { this.shifting = false; });
  }

  searchOnKey(
    state: Extract<OverlayState, { kind: "pager" }>,
    previous: PanelSnapshot["pager"],
    chord: string,
    next: PanelSnapshot["pager"],
    searchLines: readonly string[],
  ): void {
    const query = next.query;
    const source = state.source;
    if (!source || source.layout === "continuous" || !query) return;
    const matches = findPagerMatches(searchLines, query);
    const nextPageSearch = chord === "n" && previous.matchIndex >= matches.length - 1;
    const previousPageSearch = chord === "shift+n" && previous.matchIndex <= 0;
    const needsPageSearch =
      (previous.finding && chord === "enter" && matches.length === 0) ||
      (!previous.finding && (nextPageSearch || previousPageSearch));
    if (!needsPageSearch) return;
    const reverse = previousPageSearch;
    const from = previous.finding
      ? 0
      : reverse
        ? this.page?.offset ?? 0
        : this.page?.nextOffset ?? 0;
    if (!reverse || from > 0) void this.search(state, query, from, reverse);
  }

  follow(): void {
    this.pull?.();
  }

  load(state: OverlayState, offset: number, bottom = false): void {
    if (state.kind !== "pager" || !state.source) return;
    const generation = ++this.generation;
    void state.source.readPage(offset).then((page) => {
      if (generation !== this.generation || this.deps.overlay.getState() !== state) return;
      this.showPage(state, page, bottom);
    }).catch(() => {
      this.deps.onToast("could not read artifact page");
    });
  }

  private showPage(
    state: Extract<OverlayState, { kind: "pager" }>,
    page: ArtifactPage,
    bottom: boolean,
  ): void {
    const view = this.deps.pagerView(page.body, state);
    const caret = bottom ? Math.max(0, view.lines.length - 1) : 0;
    this.page = page;
    const snapshot = this.deps.snapshot();
    this.deps.publish({
      ...snapshot,
      pagerBody: page.body,
      pagerPageOffset: page.offset,
      pager: {
        ...snapshot.pager,
        caret,
        top: bottom ? Math.max(0, caret - panelBodyHeight(this.deps.rows()) + 1) : 0,
        follow: false,
      },
    });
  }

  private async search(
    state: Extract<OverlayState, { kind: "pager" }>,
    query: string,
    from: number,
    reverse: boolean,
  ): Promise<void> {
    const source = state.source;
    if (!source) return;
    const generation = ++this.generation;
    try {
      const page = await source.search(query, from, reverse);
      if (!page || generation !== this.generation || this.deps.overlay.getState() !== state || this.deps.snapshot().pager.query !== query) return;
      this.showPage(state, page, reverse);
      const matches = findPagerMatches(this.deps.pagerView(page.body, state).searchLines, query);
      const matchIndex = reverse ? Math.max(0, matches.length - 1) : 0;
      const caret = matches[matchIndex]?.line ?? 0;
      const snapshot = this.deps.snapshot();
      this.deps.publish({ ...snapshot, pager: {
        ...snapshot.pager,
        matchIndex,
        caret,
        top: Math.max(0, caret - Math.floor(panelBodyHeight(this.deps.rows()) / 2)),
      } });
    } catch {
      if (this.deps.overlay.getState() === state) this.deps.onToast("could not search saved prompts");
    }
  }

  private watch(state: Extract<OverlayState, { kind: "pager" }>): void {
    const source = state.source;
    if (!source?.watch) return;
    let active = true;
    let reading = false;
    let pending = false;
    const pull = (): void => {
      if (!active) return;
      if (reading) {
        pending = true;
        return;
      }
      reading = true;
      const follow = this.deps.snapshot().pager.follow;
      const growing = source.isGrowing?.() ?? true;
      const generation = ++this.generation;
      const pageRead = follow && source.readTail
        ? source.readTail()
        : refreshReadingWindow(source, this.page);
      void pageRead.then((page) => {
        if (!active || generation !== this.generation || this.deps.overlay.getState() !== state) return;
        const snapshot = this.deps.snapshot();
        if (follow !== snapshot.pager.follow) {
          pending = true;
          return;
        }
        const lines = this.deps.pagerView(page.body, state).lines;
        const maxCaret = Math.max(0, lines.length - 1);
        const maxTop = Math.max(0, lines.length - this.deps.rows());
        this.page = page;
        this.deps.publish({
          ...snapshot,
          pagerBody: page.body,
          pagerPageOffset: page.offset,
          pager: {
            ...snapshot.pager,
            caret: follow ? maxCaret : Math.min(snapshot.pager.caret, maxCaret),
            top: follow ? maxTop : Math.min(snapshot.pager.top, maxTop),
            follow: follow && growing,
          },
        });
      }).catch(() => undefined).finally(() => {
        reading = false;
        if (pending) {
          pending = false;
          pull();
        }
      });
    };
    const unwatch = source.watch(pull);
    this.pull = pull;
    this.unwatch = () => {
      active = false;
      unwatch();
    };
    pull();
  }
}
