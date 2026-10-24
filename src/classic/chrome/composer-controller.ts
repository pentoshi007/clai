import type { CommandRegistry } from "../../app/commands/registry.js";
import type { ClipboardPort } from "../../app/ports/clipboard-port.js";
import type { ClipboardImageCapture } from "../../attachments/clipboard-image.js";
import type { ActionId } from "../../ui-core/actions/action-id.js";
import {
  ARROW_BURST_WINDOW_MS,
  resolveArrowIntent,
} from "../../ui-core/composer/arrow-intent.js";
import {
  activateSlashCompletion,
  completionSelection,
  resolveCompletionMenu,
  sameCompletionMenu,
  type CompletionMenu,
} from "../../ui-core/composer/completion.js";
import { cutDraft, cutDraftMessage } from "../../ui-core/composer/draft-actions.js";
import { tokenInsertion } from "../../ui-core/composer/insert-token.js";
import { shouldStoreInPromptHistory } from "../../ui-core/composer/input-history.js";
import {
  PasteRegistry,
  type PastePlaceholderEntry,
} from "../../ui-core/composer/paste-placeholder.js";
import { PromptHistory, recallPromptHistory } from "../../ui-core/composer/prompt-history.js";
import {
  acceptCompletion,
  completeCommonPrefix,
} from "../panels/completion-accept.js";
import { completionItemValues } from "../panels/completion-rows.js";
import { skillNamesSnapshot } from "../../skills/registry.js";
import { composerMentionSpans } from "./composer-mentions.js";
import { ComposerPaste } from "./composer-paste.js";
import { editorEditFor } from "./composer-keys.js";
import type { EditorSpan } from "./editor-view.js";
import { EMPTY_EDITOR, boundaries, caretPosition, insert, logicalLines, type EditorState } from "./editor-model.js";

const NO_MENU: CompletionMenu = { kind: "none" };
const EMPTY_SPANS: readonly EditorSpan[] = [];

export interface McpMentionTarget {
  serverNames(): ReadonlySet<string>;
  applyMentionSelection(text: string): unknown;
}

export interface ComposerSnapshot {
  readonly mentionSpans: readonly EditorSpan[];
  readonly state: EditorState;
  readonly menu: CompletionMenu;
  readonly active: number;
  readonly pastes: readonly PastePlaceholderEntry[];
  readonly acceptedSlash: string | undefined;
}

export interface ComposerControllerDeps {
  readonly commands: CommandRegistry;
  readonly clipboard: ClipboardPort;
  readonly baseDir?: string | undefined;
  readonly mcp?: McpMentionTarget | undefined;
  readonly onSubmit: (prompt: string) => void;
  readonly onToast: (text: string) => void;
  readonly onScrollChat: (delta: number) => void;
  readonly onJumpTop: () => void;
  readonly captureClipboardImage?: (() => ClipboardImageCapture | Promise<ClipboardImageCapture>) | undefined;
  readonly now?: (() => number) | undefined;
  readonly promptHistory?: PromptHistory | undefined;
}

export class ComposerController {
  private snapshot: ComposerSnapshot = {
    state: EMPTY_EDITOR,
    menu: NO_MENU,
    active: 0,
    pastes: [],
    acceptedSlash: undefined,
    mentionSpans: EMPTY_SPANS,
  };

  private readonly listeners = new Set<() => void>();
  private readonly history: PromptHistory;
  private readonly pastes = new PasteRegistry();
  private arrowBurst = { count: 0, lastAt: 0 };
  private textWidth = 80;
  private readonly pasteInput: ComposerPaste;

  constructor(private readonly deps: ComposerControllerDeps) {
    this.history = deps.promptHistory ?? new PromptHistory();
    this.pasteInput = new ComposerPaste(deps, this.pastes, () => this.snapshot.state, (text) => this.insertText(text));
  }

  getSnapshot = (): ComposerSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setTextWidth(width: number): void {
    this.textWidth = Math.max(1, Math.floor(width));
  }

  get text(): string {
    return this.snapshot.state.text;
  }

  setCursor(offset: number): void {
    const state = this.snapshot.state;
    const target = Number.isFinite(offset) ? Math.max(0, Math.min(Math.floor(offset), state.text.length)) : state.cursor;
    const cursor = boundaries(state.text).reduce((previous, boundary) => boundary <= target ? boundary : previous, 0);
    this.arrowBurst = { count: 0, lastAt: 0 };
    if (cursor !== state.cursor) this.commit({ text: state.text, cursor }, { resetHistory: true });
  }

  expand(value: string): string {
    return this.pastes.expand(value);
  }

  menuOpen(): boolean {
    return this.snapshot.menu.kind !== "none";
  }

  menuItemCount(): number {
    return completionItemValues(this.snapshot.menu).length;
  }

  insertText(text: string): void {
    if (text.length === 0) return;
    this.commit(insert(this.snapshot.state, text), { resetHistory: true });
  }

  insertToken(token: string): void {
    if (token.length === 0) return;
    const { text, cursor } = this.snapshot.state;
    this.insertText(tokenInsertion(text.slice(0, cursor), token));
  }

  paste(text: string): void {
    this.pasteInput.paste(text);
  }

  setText(text: string): void {
    this.pasteInput.invalidate();
    const compact = this.pastes.compactAttachments(text);
    this.commit({ text: compact, cursor: compact.length }, { resetHistory: true });
  }

  clear(): void {
    this.pasteInput.invalidate();
    this.pastes.clear();
    this.history.reset();
    this.arrowBurst = { count: 0, lastAt: 0 };
    this.commit(EMPTY_EDITOR, { menu: NO_MENU, acceptedSlash: undefined });
  }

  handleAction(action: ActionId, chord?: string): boolean {
    switch (action) {
      case "editor.submit": {
        const { text, cursor } = this.snapshot.state;
        const atEnd = cursor === text.length;
        if (atEnd && text.endsWith(" \\") && text.trim().length > 0) {
          const without = text.slice(0, -2);
          this.commit(insert({ text: without, cursor: without.length }, "\n"), {
            resetHistory: true,
          });
          return true;
        }
        if (atEnd && text.endsWith("\\") && text.trim().length > 1) {
          const without = text.slice(0, -1);
          this.commit(insert({ text: without, cursor: without.length }, "\n"), {
            resetHistory: true,
          });
          return true;
        }
        this.submit();
        return true;
      }
      case "editor.newline":
        this.commit(insert(this.snapshot.state, "\n"), { resetHistory: true });
        return true;
      case "editor.clear":
        if (this.snapshot.state.text.length === 0) return false;
        this.clear();
        this.deps.onToast("Draft cleared · ^Q");
        return true;
      case "editor.cut-draft":
        if (this.snapshot.state.text.trim().length === 0) {
          this.deps.onToast("Nothing to cut · draft is empty");
          return true;
        }
        void this.cut();
        return true;
      case "editor.expand-paste": {
        const { text, cursor } = this.snapshot.state;
        const next = this.pastes.expandNearest(text, cursor);
        if (next) this.commit(next, { resetHistory: true });
        else if (chord === "ctrl+e") this.handleChord(chord);
        return true;
      }
      case "editor.history-prev":
        return this.walkHistory("up");
      case "editor.history-next":
        return this.walkHistory("down");
      default:
        return false;
    }
  }

  handleChord(chord: string): boolean {
    if (this.menuOpen() && this.handleMenuChord(chord)) return true;
    if (chord === "ctrl+v") {
      this.pasteInput.pasteClipboard();
      return true;
    }
    if (
      chord === "shift+enter" ||
      chord === "alt+enter" ||
      chord === "ctrl+enter" ||
      chord === "meta+enter" ||
      chord === "super+enter" ||
      chord === "ctrl+n"
    ) {
      this.commit(insert(this.snapshot.state, "\n"), { resetHistory: true });
      return true;
    }
    if ((chord === "ctrl+u" || chord === "super+backspace" || chord === "meta+u") && this.snapshot.state.text.length === 0) {
      this.deps.onJumpTop();
      return true;
    }
    const edit = editorEditFor(chord);
    if (!edit) return false;
    const next = edit(this.snapshot.state, this.textWidth);
    if (next === this.snapshot.state) return true;
    this.commit(next, { resetHistory: true });
    return true;
  }

  private handleMenuChord(chord: string): boolean {
    const count = this.menuItemCount();
    if (chord === "up" || chord === "down") {
      if (count === 0) return true;
      const delta = chord === "up" ? -1 : 1;
      const active = (this.snapshot.active + delta + count) % count;
      this.publish({ ...this.snapshot, active });
      return true;
    }
    if (chord === "escape") {
      this.publish({ ...this.snapshot, menu: NO_MENU, active: 0 });
      return true;
    }
    if (chord !== "tab" && chord !== "enter") return false;

    const menu = this.snapshot.menu;
    if (chord === "enter" && menu.kind === "slash") {
      this.submit();
      return true;
    }
    if (
      chord === "tab" &&
      menu.kind === "slash" &&
      this.snapshot.acceptedSlash !== undefined
    ) {
      return true;
    }
    if (chord === "tab") {
      const prefix = completeCommonPrefix(menu, this.snapshot.state);
      if (prefix) {
        this.commit(prefix, { resetHistory: true });
        return true;
      }
    }

    const accepted = acceptCompletion({
      menu,
      state: this.snapshot.state,
      active: this.snapshot.active,
      intent: chord === "tab" ? "complete" : "accept",
      baseDir: this.deps.baseDir,
    });
    if (!accepted) return true;
    this.history.reset();
    const resolved = this.resolveMenu(accepted.state);
    this.publish({
      state: accepted.state,
      menu: accepted.keepMenuOpen ? resolved : NO_MENU,
      active: 0,
      pastes: this.pastes.activeIn(accepted.state.text),
      acceptedSlash: accepted.acceptedSlash,
    });
    return true;
  }

  private runSlashCompletion(menu: CompletionMenu, selected: number): void {
    const activated = activateSlashCompletion(
      menu,
      this.snapshot.state.text,
      selected,
    );
    if (!activated) return;
    this.history.reset();
    this.publish({
      state: {
        text: activated.value,
        cursor: activated.cursorOffset,
      },
      menu: NO_MENU,
      active: 0,
      pastes: this.pastes.activeIn(activated.value),
      acceptedSlash: undefined,
    });
    this.deps.onSubmit(this.pastes.expand(activated.command));
  }

  private walkHistory(direction: "up" | "down"): boolean {
    const now = this.deps.now?.() ?? Date.now();
    this.arrowBurst =
      now - this.arrowBurst.lastAt <= ARROW_BURST_WINDOW_MS
        ? { count: this.arrowBurst.count + 1, lastAt: now }
        : { count: 0, lastAt: now };

    const { state, menu } = this.snapshot;
    const intent = resolveArrowIntent({
      chord: direction,
      plainText: state.text,
      line: caretPosition(state).line,
      lineCount: logicalLines(state.text).length,
      menuOpen: menu.kind !== "none",
      isBrowsingHistory: this.history.isBrowsing(),
      burstCount: this.arrowBurst.count,
    });

    if (intent === "scroll-chat") {
      this.deps.onScrollChat(direction === "up" ? -3 : 3);
      return true;
    }
    if (intent === "ignore") {
      const edit = editorEditFor(direction === "up" ? "shift+up" : "shift+down");
      if (!edit) return false;
      this.commit(edit(state, this.textWidth), { resetHistory: false });
      return true;
    }

    recallPromptHistory(this.history, direction, state.text,
      (text) => this.commit({ text, cursor: text.length }, { resetHistory: false }),
      () => this.deps.onToast("could not load saved prompts"),
      () => this.deps.onScrollChat(direction === "up" ? -1 : 1),
    );
    return true;
  }

  private submit(): void {
    const menu = this.snapshot.menu;
    const current = this.resolveMenu(this.snapshot.state);
    if (current.kind === "slash") {
      this.runSlashCompletion(current, completionSelection(menu, current, this.snapshot.active));
      return;
    }
    if (menu.kind === "mention" && current.kind === "mention") {
      this.handleMenuChord("enter");
      return;
    }
    const prompt = this.pastes.expand(this.snapshot.state.text).trim();
    this.pasteInput.invalidate();
    this.pastes.clear();
    this.history.reset();
    this.arrowBurst = { count: 0, lastAt: 0 };
    this.publish({
      state: EMPTY_EDITOR,
      menu: NO_MENU,
      active: 0,
      pastes: [],
      acceptedSlash: undefined,
    });
    if (prompt.length === 0) return;
    if (shouldStoreInPromptHistory(prompt)) this.history.push(prompt);
    this.deps.onSubmit(prompt);
  }

  private async cut(): Promise<void> {
    const outcome = await cutDraft({
      editor: {
        plainText: this.snapshot.state.text,
        setText: (value) => this.setText(value),
        gotoBufferEnd: () => undefined,
      },
      clipboard: this.deps.clipboard,
      expand: (value) => this.pastes.expand(value),
      clearDraft: () => this.clear(),
      focus: () => undefined,
    });
    this.deps.onToast(cutDraftMessage(outcome));
  }

  private resolveMenu(state: EditorState): CompletionMenu {
    return resolveCompletionMenu(
      this.deps.commands,
      state.text,
      state.cursor,
      this.deps.baseDir,
    );
  }

  private commit(
    state: EditorState,
    options: {
      readonly resetHistory?: boolean;
      readonly menu?: CompletionMenu;
      readonly acceptedSlash?: string | undefined;
    },
  ): void {
    if (options.resetHistory === true && this.history.isBrowsing()) this.history.reset();
    const menu = options.menu ?? this.resolveMenu(state);
    const same = sameCompletionMenu(this.snapshot.menu, menu);
    const acceptedSlash = "acceptedSlash" in options
      ? options.acceptedSlash
      : menu.kind === "slash" && state.text.slice(menu.start, menu.end) === this.snapshot.acceptedSlash
        ? this.snapshot.acceptedSlash
        : undefined;
    this.publish({
      state,
      menu,
      active: same && menu.kind !== "none" ? this.snapshot.active : 0,
      pastes: this.pastes.activeIn(state.text),
      acceptedSlash,
    });
  }

  private publish(snapshot: Omit<ComposerSnapshot, "mentionSpans">): void {
    const text = snapshot.state.text;
    const skills = skillNamesSnapshot();
    const servers = this.deps.mcp?.serverNames() ?? new Set<string>();
    const spans = composerMentionSpans(text, skills, servers);
    this.snapshot = {
      ...snapshot,
      mentionSpans: spans.length === 0 ? EMPTY_SPANS : spans,
    };
    this.deps.mcp?.applyMentionSelection(text);
    for (const listener of this.listeners) listener();
  }
}
