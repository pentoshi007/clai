import type { CommandRegistry } from "../../app/commands/registry.js";
import type { ClipboardPort } from "../../app/ports/clipboard-port.js";
import {
  captureClipboardImage as captureSystemClipboardImage,
  type ClipboardImageCapture,
} from "../../attachments/clipboard-image.js";
import {
  formatAttachmentReference,
  stabilizeDroppedFilesInText,
} from "../../ui/mentions.js";
import type { ActionId } from "../../ui-core/actions/action-id.js";
import {
  ARROW_BURST_WINDOW_MS,
  resolveArrowIntent,
} from "../../ui-core/composer/arrow-intent.js";
import {
  activateSlashCompletion,
  resolveCompletionMenu,
  sameCompletionMenu,
  type CompletionMenu,
} from "../../ui-core/composer/completion.js";
import { cutDraft, cutDraftMessage } from "../../ui-core/composer/draft-actions.js";
import { tokenInsertion } from "../../ui-core/composer/insert-token.js";
import { shouldStoreInPromptHistory } from "../../ui-core/composer/input-history.js";
import {
  isLargePaste,
  PasteRegistry,
  type PastePlaceholderEntry,
} from "../../ui-core/composer/paste-placeholder.js";
import { PromptHistory } from "../../ui-core/composer/prompt-history.js";
import {
  acceptCompletion,
  completeCommonPrefix,
} from "../panels/completion-accept.js";
import { completionItemValues } from "../panels/completion-rows.js";
import { findSkillMentions } from "../../skills/mentions.js";
import { skillNamesSnapshot } from "../../skills/registry.js";
import { findMcpMentions } from "../../mcp/mentions.js";
import { editorEditFor } from "./composer-keys.js";
import type { EditorSpan } from "./editor-view.js";
import { EMPTY_EDITOR, caretPosition, insert, logicalLines, type EditorState } from "./editor-model.js";

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
  readonly captureClipboardImage?: (() => ClipboardImageCapture) | undefined;
  readonly now?: (() => number) | undefined;
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
  private readonly history = new PromptHistory();
  private readonly pastes = new PasteRegistry();
  private arrowBurst = { count: 0, lastAt: 0 };
  private textWidth = 80;

  constructor(private readonly deps: ComposerControllerDeps) {}

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
    if (text.length === 0) {
      this.pasteClipboardImage();
      return;
    }
    const normalized = text.replace(/\r\n?/g, "\n");
    const dropped = stabilizeDroppedFilesInText(
      normalized,
      this.deps.baseDir ?? process.cwd(),
    );
    const value = dropped.files.length > 0 ? dropped.text : normalized;
    if (dropped.files.length > 0) {
      this.insertAttachmentText(value);
      this.deps.onToast(
        dropped.files.length === 1
          ? dropped.images.length === 1
            ? "Image attached"
            : "File attached"
          : `${dropped.files.length} files attached`,
      );
      return;
    }
    if (!isLargePaste(value)) {
      this.insertText(value);
      return;
    }
    const entry = this.pastes.register(value);
    this.commit(insert(this.snapshot.state, entry.token), { resetHistory: true });
  }

  private insertAttachmentText(text: string): void {
    const before = this.snapshot.state.text[this.snapshot.state.cursor - 1] ?? "";
    const leadingSpace = before && !/\s/.test(before) ? " " : "";
    this.insertText(`${leadingSpace}${text.trim()} `);
  }

  private pasteClipboardImage(): void {
    const capture = this.deps.captureClipboardImage ?? captureSystemClipboardImage;
    setImmediate(() => {
      const result = capture();
      if (!result.ok) {
        this.deps.onToast(result.reason);
        return;
      }
      this.insertAttachmentText(
        formatAttachmentReference(result.path, this.deps.baseDir ?? process.cwd()),
      );
      this.deps.onToast("Image attached from clipboard");
    });
  }

  setText(text: string): void {
    this.commit({ text, cursor: text.length }, { resetHistory: true });
  }

  clear(): void {
    this.history.reset();
    this.arrowBurst = { count: 0, lastAt: 0 };
    this.commit(EMPTY_EDITOR, { menu: NO_MENU, acceptedSlash: undefined });
  }

  handleAction(action: ActionId): boolean {
    switch (action) {
      case "editor.submit": {
        // Classic cross-OS fallback: trailing "\" + Enter means newline, not submit.
        // Works everywhere (backslash is just a character) and mirrors shell continuation.
        // Check " \" first so "foo \" removes the space+backslash pair, not just "\"
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
      const readText = this.deps.clipboard.readText;
      if (!readText) {
        this.paste("");
        return true;
      }
      void readText.call(this.deps.clipboard)
        .then((text) => this.paste(text ?? ""))
        .catch(() => this.paste(""));
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
      const activated = activateSlashCompletion(
        menu,
        this.snapshot.state.text,
        this.snapshot.active,
      );
      if (!activated) return true;
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
      this.deps.onSubmit(activated.command);
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

    const recalled =
      direction === "up" ? this.history.prev(state.text) : this.history.next();
    if (recalled === undefined) {
      // No history to recall — scroll the transcript instead of swallowing the key.
      this.deps.onScrollChat(direction === "up" ? -1 : 1);
      return true;
    }
    this.commit({ text: recalled, cursor: recalled.length }, { resetHistory: false });
    return true;
  }

  private submit(): void {
    const menu = this.snapshot.menu;
    if (menu.kind !== "none" && this.snapshot.acceptedSlash === undefined) {
      this.handleMenuChord("enter");
      return;
    }
    const prompt = this.pastes.expand(this.snapshot.state.text).trim();
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
    const acceptedSlash =
      "acceptedSlash" in options
        ? options.acceptedSlash
        : state.text.startsWith(this.snapshot.acceptedSlash ?? "\u0000")
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
    const spans: EditorSpan[] = [
      ...findSkillMentions(text, skills).map((mention) => ({
        start: mention.start,
        end: mention.end,
      })),
      ...findMcpMentions(text, servers).map((mention) => ({
        start: mention.start,
        end: mention.end,
        color: "aqua" as const,
      })),
    ];
    this.snapshot = {
      ...snapshot,
      mentionSpans: spans.length === 0 ? EMPTY_SPANS : spans,
    };
    this.deps.mcp?.applyMentionSelection(text);
    for (const listener of this.listeners) listener();
  }
}
