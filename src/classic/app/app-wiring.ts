import { safeCwd } from "../../os/cwd.js";
import type { AppServices } from "../../ui-core/bootstrap/composition-root.js";
import { maybeShowUpdateToast } from "../../ui-core/commands/startup-update.js";
import { notify } from "../../ui-core/notify.js";
import { ComposerController } from "../chrome/composer-controller.js";
import { readTerminalSize } from "../chrome/use-terminal-size.js";
import { gutterShellWidth } from "../render/shell-width.js";
import type { FeedSnapshot } from "./use-feed.js";
import { CancelLadder } from "../input/cancel-ladder.js";
import { InputRouter } from "../input/input-router.js";
import { RawDecoder } from "../input/raw-decoder.js";
import type { KeyEvent } from "../input/key-event.js";
import { PanelController, type PanelSnapshot } from "../panels/panel-controller.js";
import { ClassicActionHandlers, panelContextFor } from "./action-handlers.js";
import * as interactions from "./wiring-interactions.js";
import * as lifecycle from "./wiring-lifecycle.js";
import type {
  ClassicAppSnapshot,
  ResizeSource,
  WiringHost,
} from "./wiring-types.js";

export type { ClassicAppSnapshot } from "./wiring-types.js";

export interface ClassicAppWiringOptions {
  readonly services: AppServices;
  readonly mouse: boolean;
  readonly resizeSource?: ResizeSource | undefined;
  readonly now?: (() => number) | undefined;
}

export class ClassicAppWiring implements WiringHost {
  readonly composer: ComposerController;
  readonly panels: PanelController;
  readonly ladder: CancelLadder;
  readonly decoder: RawDecoder;
  readonly router: InputRouter;

  readonly services: AppServices;
  readonly now: () => number;
  readonly resizeSource: ResizeSource;
  readonly actions: ClassicActionHandlers;

  readonly listeners = new Set<() => void>();
  readonly disposers: Array<() => void> = [];
  snapshot: ClassicAppSnapshot;
  columns: number;
  rows: number;
  planVisibleValue = false;
  planKnown = false;
  queueSelectedValue = 0;
  feedGenerationValue = 0;
  feedNowValue: number;
  liveOffsetValue = 0;
  maxLiveOffset = 0;
  feedViewportRows = 0;
  feedWindowAnchor: WiringHost["feedWindowAnchor"] = undefined;
  selectedFeedItemId: string | undefined;
  scrollAboveValue = 0;
  scrollBelowValue = 0;
  turnStartedAtValue: number | undefined;
  activeTurnId: string | undefined;
  previousSessionId: string;
  previousOrder: readonly string[] = [];
  tickValue = 0;
  animationTickValue = 0;
  cwdValue = safeCwd();
  branchValue: string | undefined;
  contextLimitEditingValue = false;
  contextLimitDraftValue = "";
  branchRefreshTimer: ReturnType<typeof setInterval> | undefined;
  branchRefreshRequest = 0;
  lastPaintAt = 0;
  paintTimer: ReturnType<typeof setTimeout> | undefined;
  resizeTimer: ReturnType<typeof setTimeout> | undefined;
  decoderTimer: ReturnType<typeof setTimeout> | undefined;
  escapeTimer: ReturnType<typeof setTimeout> | undefined;
  tickTimer: ReturnType<typeof setInterval> | undefined;
  animationTimer: ReturnType<typeof setInterval> | undefined;
  searchFocusRelease: (() => void) | undefined;
  scrollToastShown = false;
  disposed = false;

  constructor(options: ClassicAppWiringOptions) {
    this.services = options.services;
    this.now = options.now ?? Date.now;
    this.resizeSource = options.resizeSource ?? (process.stdout as unknown as ResizeSource);
    const size = readTerminalSize(this.resizeSource);
    this.columns = size.columns;
    this.rows = size.rows;
    this.feedNowValue = this.now();
    this.previousSessionId = this.services.session.sessionId;

    this.composer = new ComposerController({
      commands: this.services.commands,
      clipboard: this.services.ports.clipboard,
      baseDir: this.cwdValue,
      onSubmit: (prompt) => this.submit(prompt),
      onToast: (text) => notify(this.services, text),
      onScrollChat: (delta) => this.scrollFeed(-delta),
      onJumpTop: () => this.showTranscriptTopHint(),
      now: this.now,
    });

    this.panels = new PanelController({
      overlay: this.services.overlay,
      clipboard: this.services.ports.clipboard,
      jobs: this.services.ports.jobs,
      transcript: () => this.services.transcript.getState(),
      plan: () => this.services.plan.current(),
      columns: () => gutterShellWidth(this.columns),
      rows: () => this.rows,
      onToast: (text) => notify(this.services, text),
      onEditPrompt: (text) => {
        this.composer.setText(text);
        this.services.focus.focusRegion("composer");
      },
      onHidePlan: () => this.setPlanVisible(false),
      onRevealItem: (itemId) => this.revealItem(itemId),
      exportScrollback: (body) => this.exportScrollback(body),
      exportEditor: (body) => void this.exportEditor(body),
      now: this.now,
    });

    this.ladder = new CancelLadder({
      session: this.services.session,
      overlay: this.services.overlay,
      jobs: this.services.ports.jobs,
      notify: (notice) => {
        this.services.toast.show(notice.text, {
          level: notice.level,
          key: notice.key,
          durationMs: notice.durationMs,
        });
        if (notice.key === "escape-arm") this.scheduleEscapeExpiry();
        this.schedulePaint();
      },
      requestExit: this.services.requestExit,
      now: this.now,
    });

    this.actions = new ClassicActionHandlers({
      services: this.services,
      composer: this.composer,
      panels: this.panels,
      ladder: this.ladder,
      host: {
        planVisible: () => this.planVisibleValue,
        togglePlan: () => this.togglePlan(),
        openPlanDetail: () => void this.openPlanDetail(),
        scrollFeed: (delta) => this.scrollFeed(delta),
        pageFeed: (delta) =>
          this.scrollFeed(delta * Math.max(2, this.feedViewportRows || Math.floor(this.rows / 4))),
        showTranscriptTopHint: () => this.showTranscriptTopHint(),
        openSearch: () => this.openSearch(),
        toggleSelectedItem: () => this.toggleSelectedItem(),
        toggleThinking: () => this.toggleThinking(),
        toggleOutput: () => void this.toggleOutput(),
        copyTranscript: () => void this.copyTranscript(),
        selectAllTranscript: () => this.selectAllTranscript(),
        closePanel: () => this.closePanel(),
        moveQueueSelection: (delta) => this.moveQueueSelection(delta),
        sendQueuedNow: () => this.sendQueuedNow(),
        editQueued: () => this.editQueued(),
        removeQueued: () => this.removeQueued(),
        repaint: () => this.schedulePaint(),
      },
    });

    this.decoder = new RawDecoder({
      now: this.now,
      mouse: options.mouse,
      onWarn: (message) => notify(this.services, message, { level: "warn" }),
    });

    this.router = new InputRouter({
      focus: this.services.focus,
      router: this.services.router,
      ladder: this.ladder,
      onAction: (action, chord, key) => {
        this.actions.handle(action, chord, key);
        this.schedulePaint();
      },
      onPanelKey: (key, chord, context) => this.handlePanelKey(key.text, chord, context),
      onText: (text) => this.composer.insertText(text),
      onPaste: (text) => {
        if (this.panels.isOpen()) {
          this.panels.handlePaste(text);
          return;
        }
        this.composer.paste(text);
      },
      onMouse: (event) => this.handleMouse(event),
      onToast: (text) => notify(this.services, text),
      closeOverlay: () => {
        this.closePanel();
      },
      dismissBlockingPrompt: () => this.services.overlay.cancelBlockingPrompt(),
      acceptsPaste: () => this.panels.isOpen() || this.services.focus.activeContext() === "composer",
      acceptsText: () => this.services.focus.activeContext() === "composer",
      hasSelection: () => this.services.selection.hasSelection(),
      contextLimitEditing: () => this.contextLimitEditingValue,
      onContextLimitStart: () => this.startContextLimitEditing(),
      onContextLimitKey: (key, chord) => this.handleContextLimitKey(key, chord),
      onContextLimitPaste: (text) => this.handleContextLimitPaste(text),
    });

    this.snapshot = this.buildSnapshot();
    this.attach();
    this.updateTranscriptDocument();
    void this.services.plan.load(this.services.session.sessionId).catch(() => undefined);
    void maybeShowUpdateToast(this.services, () => this.disposed).catch(() => undefined);
  }

  getSnapshot = (): ClassicAppSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  handleData = (chunk: string): void => {
    if (this.disposed) return;
    this.router.handleAll(this.decoder.push(chunk));
    this.scheduleDecoderFlush();
  };

  observeFeed(feed: FeedSnapshot): void {
    interactions.observeFeed(this, feed);
  }

  setComposerTextWidth(width: number): void {
    interactions.setComposerTextWidth(this, width);
  }

  setQueueSelected(index: number): void {
    interactions.setQueueSelected(this, index);
  }

  startContextLimitEditing(): void {
    interactions.startContextLimitEditing(this);
  }

  handleContextLimitKey(key: KeyEvent, chord: string): void {
    interactions.handleContextLimitKey(this, key, chord);
  }

  handleContextLimitPaste(text: string): void {
    interactions.handleContextLimitPaste(this, text);
  }

  moveQueueSelection(delta: number): void {
    interactions.moveQueueSelection(this, delta);
  }

  sendQueuedNow(): void {
    interactions.sendQueuedNow(this);
  }

  editQueued(): void {
    interactions.editQueued(this);
  }

  removeQueued(): void {
    interactions.removeQueued(this);
  }

  handlePanelKey(text: string, chord: string, context: string): void {
    interactions.handlePanelKey(this, text, chord, context);
  }

  handleMouse(event: Parameters<WiringHost["handleMouse"]>[0]): void {
    interactions.handleMouse(this, event);
  }

  submit(prompt: string): void {
    interactions.submit(this, prompt);
  }

  togglePlan(): void {
    interactions.togglePlan(this);
  }

  setPlanVisible(visible: boolean): void {
    interactions.setPlanVisible(this, visible);
  }

  openPlanDetail(): Promise<void> {
    return interactions.openPlanDetail(this);
  }

  openSearch(): void {
    interactions.openSearch(this);
  }

  syncSearchFocus(): void {
    interactions.syncSearchFocus(this);
  }

  closePanel(): boolean {
    return interactions.closePanel(this);
  }

  scrollFeed(delta: number): void {
    interactions.scrollFeed(this, delta);
  }

  showTranscriptTopHint(): void {
    interactions.showTranscriptTopHint(this);
  }

  toggleSelectedItem(): void {
    interactions.toggleSelectedItem(this);
  }

  toggleThinking(): void {
    interactions.toggleThinking(this);
  }

  toggleOutput(): Promise<void> {
    return interactions.toggleOutput(this);
  }

  revealItem(itemId: string): void {
    interactions.revealItem(this, itemId);
  }

  itemTitle(item: Parameters<typeof interactions.itemTitle>[0]): string {
    return interactions.itemTitle(item);
  }

  updateTranscriptDocument(): void {
    interactions.updateTranscriptDocument(this);
  }

  selectAllTranscript(): void {
    interactions.selectAllTranscript(this);
  }

  copyTranscript(): Promise<void> {
    return interactions.copyTranscript(this);
  }

  exportScrollback(body: string): void {
    interactions.exportScrollback(this, body);
  }

  exportEditor(body: string): Promise<void> {
    return interactions.exportEditor(this, body);
  }

  bumpFeedGeneration(): void {
    interactions.bumpFeedGeneration(this);
  }

  disarmEscapeIfIdle(): void {
    interactions.disarmEscapeIfIdle(this);
  }

  needsCadence(): boolean {
    return interactions.needsCadence(this);
  }

  needsAnimation(): boolean {
    return interactions.needsAnimation(this);
  }

  dispose(): void {
    lifecycle.disposeWiring(this);
  }

  attach(): void {
    lifecycle.attachWiring(this);
  }

  onSessionChange(): void {
    lifecycle.onSessionChange(this);
  }

  onTranscriptChange(): void {
    lifecycle.onTranscriptChange(this);
  }

  onPlanChange(): void {
    lifecycle.onPlanChange(this);
  }

  buildSnapshot(): ClassicAppSnapshot {
    return lifecycle.buildSnapshot(this);
  }

  schedulePaint(): void {
    lifecycle.schedulePaint(this);
  }

  scheduleDecoderFlush(): void {
    lifecycle.scheduleDecoderFlush(this);
  }

  scheduleEscapeExpiry(): void {
    lifecycle.scheduleEscapeExpiry(this);
  }
}

export function createClassicAppWiring(options: ClassicAppWiringOptions): ClassicAppWiring {
  return new ClassicAppWiring(options);
}

export function overlayDemandContext(snapshot: PanelSnapshot): ReturnType<typeof panelContextFor> {
  return panelContextFor(snapshot.kind);
}
