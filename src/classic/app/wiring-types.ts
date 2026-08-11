import type { BackgroundJob } from "../../app/ports/jobs-port.js";
import type { SessionState } from "../../app/controllers/session-controller.js";
import type { SessionPlan } from "../../store/plan.js";
import type { AppServices } from "../../ui-core/bootstrap/composition-root.js";
import type { ToastItem } from "../../ui-core/controllers/toast-controller.js";
import type {
  TranscriptItem,
  TranscriptState,
} from "../../ui-core/state/transcript-types.js";
import type { ComposerController, ComposerSnapshot } from "../chrome/composer-controller.js";
import type { CancelLadder } from "../input/cancel-ladder.js";
import type { InputRouter } from "../input/input-router.js";
import type { RawDecoder } from "../input/raw-decoder.js";
import type { KeyEvent } from "../input/key-event.js";
import type { PanelController, PanelSnapshot } from "../panels/panel-controller.js";
import type { FeedSnapshot } from "./use-feed.js";

export interface ResizeSource {
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
}

export interface FeedWindowAnchor {
  readonly totalRows: number;
  readonly columns: number;
  readonly generation: number;
}

export interface ClassicAppSnapshot {
  readonly session: SessionState;
  readonly transcript: TranscriptState;
  readonly composer: ComposerSnapshot;
  readonly panel: PanelSnapshot;
  readonly plan: SessionPlan | undefined;
  readonly toasts: readonly ToastItem[];
  readonly jobs: readonly BackgroundJob[];
  readonly columns: number;
  readonly rows: number;
  readonly now: number;
  readonly feedNow: number;
  readonly tick: number;
  readonly animationTick: number;
  readonly feedGeneration: number;
  readonly liveOffset: number;
  readonly planVisible: boolean;
  readonly queueSelected: number;
  readonly cancelArmed: boolean;
  readonly turnStartedAt: number | undefined;
  readonly cwd: string;
  readonly branch: string | undefined;
  readonly contextLimitEditing: boolean;
  readonly contextLimitDraft: string;
  readonly scrollAbove: number;
  readonly scrollBelow: number;
}

export interface WiringHost {
  readonly services: AppServices;
  readonly now: () => number;
  readonly resizeSource: ResizeSource;
  readonly composer: ComposerController;
  readonly panels: PanelController;
  readonly ladder: CancelLadder;
  readonly decoder: RawDecoder;
  readonly router: InputRouter;
  readonly listeners: Set<() => void>;
  readonly disposers: Array<() => void>;
  snapshot: ClassicAppSnapshot;
  columns: number;
  rows: number;
  planVisibleValue: boolean;
  planKnown: boolean;
  queueSelectedValue: number;
  feedGenerationValue: number;
  feedNowValue: number;
  liveOffsetValue: number;
  maxLiveOffset: number;
  feedViewportRows: number;
  feedWindowAnchor: FeedWindowAnchor | undefined;
  selectedFeedItemId: string | undefined;
  scrollAboveValue: number;
  scrollBelowValue: number;
  turnStartedAtValue: number | undefined;
  activeTurnId: string | undefined;
  previousSessionId: string;
  previousOrder: readonly string[];
  tickValue: number;
  animationTickValue: number;
  cwdValue: string;
  branchValue: string | undefined;
  contextLimitEditingValue: boolean;
  contextLimitDraftValue: string;
  branchRefreshTimer: ReturnType<typeof setInterval> | undefined;
  branchRefreshRequest: number;
  lastPaintAt: number;
  paintTimer: ReturnType<typeof setTimeout> | undefined;
  resizeTimer: ReturnType<typeof setTimeout> | undefined;
  decoderTimer: ReturnType<typeof setTimeout> | undefined;
  escapeTimer: ReturnType<typeof setTimeout> | undefined;
  tickTimer: ReturnType<typeof setInterval> | undefined;
  animationTimer: ReturnType<typeof setInterval> | undefined;
  searchFocusRelease: (() => void) | undefined;
  scrollToastShown: boolean;
  disposed: boolean;
  schedulePaint(): void;
  scheduleEscapeExpiry(): void;
  syncSearchFocus(): void;
  closePanel(): boolean;
  setPlanVisible(visible: boolean): void;
  openPlanDetail(): Promise<void>;
  openSearch(): void;
  revealItem(itemId: string): void;
  toggleSelectedItem(): void;
  toggleThinking(): void;
  toggleOutput(): Promise<void>;
  showTranscriptTopHint(): void;
  scrollFeed(delta: number): void;
  updateTranscriptDocument(): void;
  selectAllTranscript(): void;
  copyTranscript(): Promise<void>;
  exportScrollback(body: string): void;
  exportEditor(body: string): Promise<void>;
  bumpFeedGeneration(): void;
  disarmEscapeIfIdle(): void;
  needsCadence(): boolean;
  needsAnimation(): boolean;
  itemTitle(item: TranscriptItem): string;
  submit(prompt: string): void;
  moveQueueSelection(delta: number): void;
  sendQueuedNow(): void;
  editQueued(): void;
  removeQueued(): void;
  handlePanelKey(text: string, chord: string, context: string): void;
  handleMouse(event: import("../input/key-event.js").MouseEvent): void;
  onSessionChange(): void;
  onTranscriptChange(): void;
  onPlanChange(): void;
  buildSnapshot(): ClassicAppSnapshot;
  scheduleDecoderFlush(): void;
  dispose(): void;
  observeFeed(feed: FeedSnapshot): void;
  setComposerTextWidth(width: number): void;
  setQueueSelected(index: number): void;
  startContextLimitEditing(): void;
  handleContextLimitKey(key: KeyEvent, chord: string): void;
  handleContextLimitPaste(text: string): void;
}
