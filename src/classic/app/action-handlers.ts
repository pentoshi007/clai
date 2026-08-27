import { setDefaultMode } from "../../store/config.js";
import type { ActionId } from "../../ui-core/actions/action-id.js";
import type { OverlayContext } from "../../ui-core/controllers/focus-controller.js";
import { modeSwitchSummary, nextMode } from "../../ui-core/actions/mode-cycle.js";
import type { AppServices } from "../../ui-core/bootstrap/composition-root.js";
import { notify } from "../../ui-core/notify.js";
import { formatCommandHelpMarkdown } from "../../ui-core/rendering/format-help.js";
import type { ComposerController } from "../chrome/composer-controller.js";
import type { CancelLadder } from "../input/cancel-ladder.js";
import type { KeyEvent } from "../input/key-event.js";
import type { PanelController } from "../panels/panel-controller.js";

export interface ClassicActionHost {
  readonly planVisible: () => boolean;
  readonly togglePlan: () => void;
  readonly openPlanDetail: () => void;
  readonly scrollFeed: (delta: number) => void;
  readonly pageFeed: (delta: number) => void;
  readonly showTranscriptTopHint: () => void;
  readonly openSearch: () => void;
  readonly toggleSelectedItem: () => void;
  readonly toggleThinking: () => void;
  readonly toggleOutput: () => void;
  readonly copyTranscript: () => void;
  readonly selectAllTranscript: () => void;
  readonly closePanel: () => boolean;
  readonly moveQueueSelection: (delta: number) => void;
  readonly sendQueuedNow: () => void;
  readonly editQueued: () => void;
  readonly removeQueued: () => void;
  readonly repaint: () => void;
}

export interface ClassicActionHandlerDeps {
  readonly services: AppServices;
  readonly composer: ComposerController;
  readonly panels: PanelController;
  readonly ladder: CancelLadder;
  readonly host: ClassicActionHost;
}

export class ClassicActionHandlers {
  constructor(private readonly deps: ClassicActionHandlerDeps) {}

  handle(action: ActionId, chord: string, key: KeyEvent): void {
    // The composer keymap resolves arrows as history actions before the
    // generic panel fallback gets a chance to see them. Completion menus own
    // those arrows, so preserve ComposerController's menu semantics here.
    if (
      (chord === "up" || chord === "down") &&
      this.deps.services.focus.activeContext() === "composer" &&
      this.deps.composer.menuOpen()
    ) {
      this.deps.composer.handleChord(chord);
      return;
    }
    switch (action) {
      case "app.quit":
      case "app.cancel":
      case "app.interrupt":
      case "app.help":
      case "app.toggle-plan":
      case "app.jobs":
      case "app.cycle-mode":
      case "focus.next-region":
      case "focus.composer":
      case "focus.transcript":
        this.handleApp(action);
        return;
      case "editor.submit":
      case "editor.newline":
      case "editor.history-prev":
      case "editor.history-next":
      case "editor.clear":
      case "editor.cut-draft":
        this.deps.composer.handleAction(action);
        return;
      case "transcript.scroll-up":
      case "transcript.scroll-down":
      case "transcript.page-up":
      case "transcript.page-down":
      case "transcript.top":
      case "transcript.bottom":
      case "transcript.search":
      case "transcript.expand-toggle":
      case "transcript.toggle-thinking":
      case "transcript.toggle-output":
        this.handleTranscript(action);
        return;
      case "selection.copy":
      case "selection.clear":
      case "selection.select-all":
      case "selection.extend-left":
      case "selection.extend-right":
      case "selection.extend-up":
      case "selection.extend-down":
      case "selection.extend-word-left":
      case "selection.extend-word-right":
      case "selection.extend-line-start":
      case "selection.extend-line-end":
        this.handleSelection(action, chord, key);
        return;
      case "plan.next-task":
      case "plan.prev-task":
      case "plan.toggle-detail":
        this.handlePlan(chord);
        return;
      case "queue.select-prev":
      case "queue.select-next":
      case "queue.send-now":
      case "queue.edit":
      case "queue.remove":
        this.handleQueue(action);
        return;
      case "picker.up":
      case "picker.down":
      case "picker.accept":
      case "picker.dismiss":
      case "picker.filter":
      case "modal.confirm":
      case "modal.deny":
      case "modal.dismiss":
      case "pager.line-up":
      case "pager.line-down":
      case "pager.page-up":
      case "pager.page-down":
      case "pager.half-page-up":
      case "pager.half-page-down":
      case "pager.top":
      case "pager.bottom":
      case "pager.search":
      case "pager.next-match":
      case "pager.prev-match":
      case "pager.export-scrollback":
      case "pager.export-editor":
      case "pager.copy":
      case "pager.toggle-follow":
      case "pager.format":
      case "pager.raw":
      case "pager.close":
      case "jobs.up":
      case "jobs.down":
      case "jobs.tail":
      case "jobs.view-live":
      case "jobs.stop":
      case "jobs.close":
        this.deps.panels.handleKey(chord, key.text);
        return;
      // OpenTUI-only: classic has no focusable thinking card to copy from.
      case "transcript.copy-thinking":
        return;
      default: {
        const exhaustive: never = action;
        void exhaustive;
      }
    }
  }

  private handleQueue(action: ActionId): void {
    const { host } = this.deps;
    switch (action) {
      case "queue.select-prev":
        host.moveQueueSelection(-1);
        return;
      case "queue.select-next":
        host.moveQueueSelection(1);
        return;
      case "queue.send-now":
        host.sendQueuedNow();
        return;
      case "queue.edit":
        host.editQueued();
        return;
      case "queue.remove":
        host.removeQueued();
        return;
      default:
        return;
    }
  }

  private handleApp(action: ActionId): void {
    const { services, host, ladder } = this.deps;
    switch (action) {
      case "app.quit":
        services.requestExit();
        return;
      case "app.cancel":
        ladder.escape(services.overlay.cancelBlockingPrompt());
        return;
      case "app.interrupt":
        ladder.interrupt();
        return;
      case "app.help":
        services.overlay.openPager(
          "Commands",
          formatCommandHelpMarkdown(services.commands.help()),
          undefined,
          undefined,
          "force",
        );
        return;
      case "app.toggle-plan":
        host.togglePlan();
        return;
      case "app.jobs":
        services.overlay.openJobs();
        return;
      case "app.cycle-mode": {
        const mode = nextMode(services.session.getState().mode);
        services.session.setMode(mode);
        setDefaultMode(mode);
        notify(services, `Mode · ${mode.toUpperCase()} — ${modeSwitchSummary(mode)} · ⇧⇥`, {
          key: "mode",
          level: "success",
          durationMs: 1800,
        });
        return;
      }
      case "focus.next-region":
        services.focus.cycleRegion(
          host.planVisible()
            ? ["composer", "transcript", "plan"]
            : ["composer", "transcript"],
        );
        return;
      case "focus.composer":
        services.focus.focusRegion("composer");
        return;
      case "focus.transcript":
        services.focus.focusRegion("transcript");
        return;
      default:
        return;
    }
  }

  private handleTranscript(action: ActionId): void {
    const host = this.deps.host;
    switch (action) {
      case "transcript.scroll-up":
        host.scrollFeed(1);
        return;
      case "transcript.scroll-down":
        host.scrollFeed(-1);
        return;
      case "transcript.page-up":
        host.pageFeed(1);
        return;
      case "transcript.page-down":
        host.pageFeed(-1);
        return;
      case "transcript.top":
        host.showTranscriptTopHint();
        return;
      case "transcript.bottom":
        host.scrollFeed(-Number.MAX_SAFE_INTEGER);
        return;
      case "transcript.search":
        host.openSearch();
        return;
      case "transcript.expand-toggle":
        host.toggleSelectedItem();
        return;
      case "transcript.toggle-thinking":
        host.toggleThinking();
        return;
      case "transcript.toggle-output":
        host.toggleOutput();
        return;
      default:
        return;
    }
  }

  private handleSelection(action: ActionId, chord: string, key: KeyEvent): void {
    const { services, host, ladder, panels } = this.deps;
    switch (action) {
      case "selection.copy":
        host.copyTranscript();
        return;
      case "selection.clear":
        services.selection.clear();
        ladder.escape(false);
        return;
      case "selection.select-all":
        host.selectAllTranscript();
        return;
      case "selection.extend-left":
      case "selection.extend-right":
      case "selection.extend-up":
      case "selection.extend-down":
      case "selection.extend-word-left":
      case "selection.extend-word-right":
      case "selection.extend-line-start":
      case "selection.extend-line-end":
        if (services.focus.activeContext() === "pager") panels.handleKey(chord, key.text);
        return;
      default:
        return;
    }
  }

  private handlePlan(chord: string): void {
    const focused = this.deps.services.focus.activeContext() === "plan";
    if (!this.deps.panels.handlePlanKey(chord, focused) && chord === "ctrl+p") {
      this.deps.host.openPlanDetail();
    }
  }
}

export function panelContextFor(kind: string): OverlayContext | undefined {
  switch (kind) {
    case "picker":
      return "picker";
    case "confirm":
    case "scope-editor":
    case "keys-editor":
    case "prompt-actions":
      return "modal";
    case "secret":
      return "secret";
    case "pager":
      return "pager";
    case "jobs":
      return "jobs";
    case "search":
      return "transcript-search";
    default:
      return undefined;
  }
}
