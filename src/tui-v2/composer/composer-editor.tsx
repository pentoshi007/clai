/** @jsxImportSource @opentui/react */
/**
 * Composer: completion menu above input; provider/model/permissions on the
 * top border. Focus is region-aware so transcript scroll is not stolen.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  decodePasteBytes,
  stripAnsiSequences,
  type KeyEvent,
  type MouseEvent,
  type TextareaRenderable,
} from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import { shouldStoreInPromptHistory } from "../../ui-core/composer/input-history.js";
import { formatAttachmentReference } from "../../ui/mentions.js";
import { getConfig } from "../../store/config.js";
import { effectiveThinkingEffort } from "../../llm/capabilities.js";
import type { AppServices } from "../../ui-core/bootstrap/composition-root.js";
import type { Theme } from "../../ui-core/rendering/theme.js";
import { chordFromKeyEvent } from "../input/chord-from-opentui-key.js";
import { PromptHistory } from "../../ui-core/composer/prompt-history.js";
import {
  ARROW_BURST_WINDOW_MS,
  resolveArrowIntent,
} from "../../ui-core/composer/arrow-intent.js";
import {
  isLargePaste,
  PasteRegistry,
  samePastePlaceholderEntries,
  type PastePlaceholderEntry,
} from "../../ui-core/composer/paste-placeholder.js";
import {
  activateSlashCompletion,
  resolveCompletionMenu,
  sameCompletionMenu,
  type CompletionMenu,
} from "../../ui-core/composer/completion.js";
import { buildComposerTextareaOverrides } from "./textarea-keybindings.js";
import { composerActionPort } from "../../ui-core/composer/composer-action-port.js";
import { useDraftActions } from "./use-draft-actions.js";
import { createComposerImagePaste } from "./composer-image-paste.js";
import { notify } from "../../ui-core/notify.js";
import { CompletionMenuView } from "../components/completion/completion-menu.js";
import { ComposerInputBox } from "../components/composer/composer-input-box.js";
import { PasteChipRow } from "../components/composer/paste-chip.js";
import { paintSkillMentions } from "./skill-highlight.js";
import { skillNamesSnapshot } from "../../skills/registry.js";
import { useOverlayState } from "../../ui-core/react/use-overlay.js";
import { useSessionState } from "../../ui-core/react/use-session-state.js";
import { clipComposerMeta, formatComposerMeta } from "../../ui-core/composer/composer-meta.js";
import { transcriptScrollPort } from "../components/transcript/transcript-scroll-port.js";
import { consumePlanSuggestionInput } from "../../ui-core/plan/plan-lifecycle.js";
import {
  countComposerVisualLines,
  resolveComposerTextRows,
} from "../../ui-core/composer/composer-height.js";
import {
  composerDraftOverflows,
  composerOwnsWheel,
  measureComposerLines,
  wheelChatDelta,
} from "./composer-wheel.js";
import { disableNativeTextareaScroll } from "./disable-native-textarea-scroll.js";

export interface ComposerEditorProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly width: number;
  /**
   * Maximum editable text rows (not including the rounded border).
   * The box starts at 1 row and grows with content up to this cap.
   */
  readonly height: number;
  /** The command window gets denser on tall terminals, never a one-row list. */
  readonly maxSuggestions?: number | undefined;
  /** Mirrors the legacy composer hint while a turn is active. */
  readonly running?: boolean | undefined;
  readonly inputSuspended?: boolean | undefined;
  /** Visual region focus from the shell (Tab cycle). */
  readonly focused: boolean;
  /**
   * Esc while a turn runs: arm/cancel via the shared double-Esc handler
   * (shows "Esc again to cancel", second press cancels turn + queue + jobs).
   * Owned by App so the double-press window is shared with the global handler.
   */
  readonly onEscapeCancel?: (() => void) | undefined;
  /**
   * When set (e.g. Edit on a queued prompt), replace the input with this
   * draft. `token` must change each time so the same text can be re-applied.
   */
  readonly seedDraft?: { readonly token: number; readonly text: string } | undefined;
}
const textareaKeyBindings = buildComposerTextareaOverrides() as never;

export function ComposerEditor(props: ComposerEditorProps): ReactNode {
  const { services, theme } = props;
  const editorRef = useRef<TextareaRenderable>(null);
  const promptHistory = useRef(new PromptHistory());
  const pasteRegistry = useRef(new PasteRegistry());
  const imagePaste = createComposerImagePaste(services, editorRef, () => {
    syncContentRows();
    refreshMenu();
  });
  /** Trackpad-as-arrows: count rapid ↑/↓ so we scroll chat instead of history. */
  const arrowBurst = useRef({ count: 0, lastAt: 0 });
  const [menu, setMenu] = useState<CompletionMenu>({ kind: "none" });
  const [selected, setSelected] = useState(0);
  const [acceptedSlash, setAcceptedSlash] = useState<string | undefined>(undefined);
  /** Visual rows of current prompt — drives grow-with-content height. */
  const [contentRows, setContentRows] = useState(1);
  const [pasteChips, setPasteChips] = useState<PastePlaceholderEntry[]>([]);
  // Refs mirror React state so OpenTUI key handlers never see a stale menu
  // after @ completion or focus reclaim (the intermittent "arrows dead / /
  // menu missing" failure mode).
  const menuRef = useRef(menu);
  const selectedRef = useRef(selected);
  const acceptedSlashRef = useRef(acceptedSlash);
  menuRef.current = menu;
  selectedRef.current = selected;
  acceptedSlashRef.current = acceptedSlash;
  const menuKindRef = useRef(menu.kind);
  menuKindRef.current = menu.kind;
  const overlay = useOverlayState(services.overlay);
  const session = useSessionState(services.session);
  // Prefer live session selection; fall back to config so the border always
  // shows provider · model · permissions (never empty of provider).
  const cfg = getConfig();
  const metaLabel = formatComposerMeta(
    session.provider ?? cfg.defaultProvider,
    session.model ?? cfg.defaultModel,
    cfg.permissions ?? "default",
    effectiveThinkingEffort(
      session.provider ?? cfg.defaultProvider,
      session.model ?? cfg.defaultModel,
      cfg.thinking,
    ),
  );

  const shouldOwnKeyboard =
    overlay.kind === "none" && props.focused && !props.inputSuspended;
  useEffect(() => {
    if (shouldOwnKeyboard) editorRef.current?.focus();
    else editorRef.current?.blur();
  }, [shouldOwnKeyboard, props.running]);

  // Dim only: suppress native draft wheel so chat scrolls alone under pointer.
  useEffect(() => {
    if (shouldOwnKeyboard) return;
    let restore = disableNativeTextareaScroll(editorRef.current);
    const frame = requestAnimationFrame(() => {
      restore();
      restore = disableNativeTextareaScroll(editorRef.current);
    });
    return () => {
      cancelAnimationFrame(frame);
      restore();
    };
  }, [shouldOwnKeyboard]);

  const lastSeedToken = useRef<number | undefined>(undefined);
  useEffect(() => {
    const seed = props.seedDraft;
    if (
      !seed ||
      seed.token === lastSeedToken.current ||
      props.inputSuspended
    ) {
      return;
    }
    lastSeedToken.current = seed.token;
    const editor = editorRef.current;
    if (!editor) return;
    editor.setText(seed.text);
    editor.gotoBufferEnd();
    services.focus.focusRegion("composer");
    editor.focus();
    resetMenuState();
    queueMicrotask(() => {
      refreshMenu();
      syncContentRows();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed token is the trigger
  }, [props.seedDraft?.token, props.inputSuspended]);

  // Global keyboard: (1) keep completion menus navigable even if the textarea
  // briefly loses focus after @/click, (2) reclaim the composer on printable
  // keys so typing never feels dead.
  useKeyboard((key) => {
    if (key.eventType === "release") return;
    if (props.inputSuspended) return;
    const chord = chordFromKeyEvent(key);

    // Escape and Ctrl+C are owned by App so double-press cancellation and
    // abort-then-quit semantics remain consistent across every focus region.
    if (imagePaste.handleChord(chord, overlay.kind, key)) return;

    if (overlay.kind !== "none") return;

    // Completion menu wins over transcript scroll / history when the
    // textarea has lost focus (post-@ / click glitch). When the composer
    // already owns input, onKeyDown handles menu keys — avoid double-step.
    if (menuKindRef.current !== "none" && !shouldOwnKeyboard) {
      if (
        chord === "up" ||
        chord === "down" ||
        chord === "tab" ||
        chord === "enter" ||
        chord === "escape"
      ) {
        services.focus.focusRegion("composer");
        editorRef.current?.focus();
        handleMenuOrComposerKey(key);
        return;
      }
    }

    if (shouldOwnKeyboard) return;

    const activeContext = services.focus.activeContext();
    if (activeContext === "transcript-search") return;
    // Don't steal navigation keys from transcript/plan scroll.
    if (
      chord === "up" ||
      chord === "down" ||
      chord === "pageup" ||
      chord === "pagedown" ||
      chord === "home" ||
      chord === "end" ||
      key.name === "up" ||
      key.name === "down"
    ) {
      return;
    }
    if (key.ctrl || key.meta || key.option || key.super) return;
    const text = key.sequence;
    if (!text || text.length !== 1 || text < " " || key.name === "tab") return;
    key.preventDefault();
    services.focus.focusRegion("composer");
    editorRef.current?.focus();
    editorRef.current?.insertText(text);
    queueMicrotask(() => {
      refreshMenu();
      syncContentRows();
    });
  });

  usePaste((event) => {
    if (props.inputSuspended || overlay.kind !== "none") return;
    if (!props.focused) {
      services.focus.focusRegion("composer");
      editorRef.current?.focus();
    }
    const text = stripAnsiSequences(decodePasteBytes(event.bytes));
    if (imagePaste.handlePaste(text, event)) return;
    if (imagePaste.handleDroppedImages(text, event)) return;
    if (!isLargePaste(text)) return;
    event.preventDefault();
    const entry = pasteRegistry.current.register(text);
    editorRef.current?.insertText(entry.token);
    queueMicrotask(syncContentRows);
  });

  function expandPasteChip(id: number): void {
    const editor = editorRef.current;
    if (!editor) return;
    editor.setText(pasteRegistry.current.expandOne(editor.plainText, id));
    editor.gotoBufferEnd();
    queueMicrotask(() => {
      syncContentRows();
      refreshMenu();
    });
  }

  /** Grow/shrink the input box with newlines and soft-wrap (classic parity). */
  function syncSkillMentions(): void {
    const editor = editorRef.current;
    const known = skillNamesSnapshot();
    if (!editor || known.size === 0) return;
    paintSkillMentions(editor, known, theme.activity);
  }

  function syncContentRows(): void {
    const editor = editorRef.current;
    if (!editor) {
      setContentRows(1);
      setPasteChips([]);
      return;
    }
    syncSkillMentions();
    // Prompt (2) + borders (2) + horizontal padding (2) leave this for text.
    const wrapWidth = Math.max(10, props.width - 6);
    const estimatedRows = countComposerVisualLines(editor.plainText, wrapWidth);
    const nextRows = measureComposerLines(editor, estimatedRows);
    setContentRows((current) => (current === nextRows ? current : nextRows));
    const nextChips = pasteRegistry.current.activeIn(editor.plainText);
    setPasteChips((current) =>
      samePastePlaceholderEntries(current, nextChips) ? current : nextChips,
    );
    // Gates the draft-only ^X / ⇧^X chips in the status row.
    composerActionPort.setHasDraft(editor.plainText.trim().length > 0);
  }

  function refreshMenu(): void {
    const editor = editorRef.current;
    if (!editor) return;
    const next = resolveCompletionMenu(
      services.commands,
      editor.plainText,
      editor.cursorOffset,
    );
    setAcceptedSlash((accepted) => {
      if (!accepted || next.kind !== "slash") return undefined;
      const token = editor.plainText.slice(next.start, next.end);
      const suffix = editor.plainText.slice(next.end);
      const kept =
        token === accepted && !/\S/.test(suffix) ? accepted : undefined;
      acceptedSlashRef.current = kept;
      return kept;
    });
    setMenu((prev) => {
      // Cursor moves and native textarea notifications often arrive without
      // changing completion content. Reusing the prior object prevents a full
      // command-menu/transcript render for those no-op input events.
      if (sameCompletionMenu(prev, next)) {
        menuRef.current = prev;
        menuKindRef.current = prev.kind;
        return prev;
      }
      // Keep selection stable when the filtered list only shrinks/grows.
      if (prev.kind === next.kind && next.kind !== "none" && prev.kind !== "none") {
        const sel = selectedRef.current;
        const prevName =
          prev.kind === "slash"
            ? prev.items[sel]?.name
            : prev.items[sel]?.value;
        if (prevName) {
          const idx =
            next.kind === "slash"
              ? next.items.findIndex((i) => i.name === prevName)
              : next.items.findIndex((i) => i.value === prevName);
          const nextSel = idx >= 0 ? idx : 0;
          selectedRef.current = nextSel;
          setSelected(nextSel);
        } else {
          selectedRef.current = 0;
          setSelected(0);
        }
      } else {
        selectedRef.current = 0;
        setSelected(0);
        // Opening a menu resets trackpad burst so ↑/↓ navigate options
        // instead of immediately scrolling the transcript.
        if (next.kind !== "none") {
          arrowBurst.current = { count: 0, lastAt: 0 };
        }
      }
      menuRef.current = next;
      menuKindRef.current = next.kind;
      return next;
    });
  }

  function acceptSuggestion(opts?: {
    readonly index?: number;
    readonly drillDir?: boolean;
    readonly attachDir?: boolean;
  }): void {
    const editor = editorRef.current;
    const current = menuRef.current;
    const sel = opts?.index ?? selectedRef.current;
    if (opts?.index !== undefined) {
      selectedRef.current = opts.index;
      setSelected(opts.index);
    }
    if (!editor || current.kind === "none") return;
    const cursor = editor.cursorOffset;
    const value = editor.plainText;
    let replacement: string;
    let start: number;
    let replacementEnd: number;
    let keepMentionOpen = false;
    if (current.kind === "slash") {
      const item = current.items[sel];
      if (!item) return;
      replacement = `/${item.name} `;
      start = current.start;
      replacementEnd = /^\s*$/.test(value.slice(current.end))
        ? value.length
        : current.end;
      const accepted = `/${item.name}`;
      acceptedSlashRef.current = accepted;
      setAcceptedSlash(accepted);
    } else {
      const item = current.items[sel];
      if (!item) return;
      start = current.start;
      replacementEnd = cursor;
      acceptedSlashRef.current = undefined;
      setAcceptedSlash(undefined);
      if (item.isDir) {
        // `../` to project root uses empty value — back to `@` listing.
        if (item.value === "") {
          replacement = opts?.attachDir ? `@. ` : `@`;
          keepMentionOpen = !opts?.attachDir;
        } else {
          const dirValue = item.value.endsWith("/")
            ? item.value
            : `${item.value}/`;
          if (opts?.attachDir) {
            // Whole directory as an attachment token (space closes the mention).
            replacement = `@${dirValue.replace(/\/$/, "")} `;
            keepMentionOpen = false;
          } else {
            // Drill into the directory (Tab).
            replacement = `@${dirValue}`;
            keepMentionOpen = true;
          }
        }
      } else {
        replacement = `${formatAttachmentReference(item.value)} `;
        keepMentionOpen = false;
      }
    }
    const next = value.slice(0, start) + replacement + value.slice(replacementEnd);
    editor.setText(next);
    // Place cursor after the inserted token.
    try {
      editor.editBuffer.setCursorByOffset?.(start + replacement.length);
    } catch {
      try {
        editor.setCursor(0, start + replacement.length);
      } catch {
        editor.gotoBufferEnd();
      }
    }
    selectedRef.current = 0;
    setSelected(0);
    // `setText` can move native focus in OpenTUI. Keep the cursor live after
    // a Tab/Enter completion rather than leaving the user in a dead region.
    services.focus.focusRegion("composer");
    editor.focus();
    if (current.kind === "mention" && !keepMentionOpen) {
      menuRef.current = { kind: "none" };
      menuKindRef.current = "none";
      setMenu({ kind: "none" });
    }
    queueMicrotask(() => {
      refreshMenu();
      syncContentRows();
    });
  }

  function runSlashCompletion(index: number): void {
    const editor = editorRef.current;
    if (!editor) return;
    const activated = activateSlashCompletion(
      menuRef.current,
      editor.plainText,
      index,
    );
    if (!activated) return;
    editor.setText(activated.value);
    try {
      editor.editBuffer.setCursorByOffset?.(activated.cursorOffset);
    } catch {
      try {
        editor.setCursor(0, activated.cursorOffset);
      } catch {
        editor.gotoBufferEnd();
      }
    }
    menuRef.current = { kind: "none" };
    menuKindRef.current = "none";
    acceptedSlashRef.current = undefined;
    setMenu({ kind: "none" });
    setAcceptedSlash(undefined);
    selectedRef.current = 0;
    setSelected(0);
    services.focus.focusRegion("composer");
    editor.focus();
    syncContentRows();
    void dispatchOrRunTurn(activated.command);
  }

  function submit(): void {
    const editor = editorRef.current;
    if (!editor) return;
    const current = menuRef.current;
    if (current.kind === "slash") {
      runSlashCompletion(selectedRef.current);
      return;
    }
    if (current.kind === "mention") {
      const item = current.items[selectedRef.current];
      if (item?.isDir) {
        acceptSuggestion({ attachDir: true });
        return;
      }
      acceptSuggestion();
      return;
    }
    const expanded = pasteRegistry.current.expand(editor.plainText).trim();
    clearDraftState(editor);
    if (!expanded) return;
    if (shouldStoreInPromptHistory(expanded)) promptHistory.current.push(expanded);
    void dispatchOrRunTurn(expanded);
  }

  async function dispatchOrRunTurn(prompt: string): Promise<void> {
    const trimmed = prompt.trim();
    // Never send slash-shaped input as an agent prompt — that was the
    // intermittent "typed /help and it became a chat message" bug when the
    // completion menu failed to accept first.
    if (services.commands.looksLikeCommand(trimmed)) {
      const invocation = services.commands.parse(trimmed);
      if (!invocation) {
        const token = trimmed.split(/\s/, 1)[0] ?? trimmed;
        services.session.notice(
          "warn",
          `unknown command: ${token}. Try /help`,
        );
        return;
      }
      const handled = await services.commands.dispatch(invocation);
      if (!handled) {
        services.session.notice(
          "warn",
          `command /${invocation.name} is not available right now`,
        );
      }
      return;
    }
    // After plan-ready `s`, free-text is revision feedback (stay in plan mode).
    const revision = consumePlanSuggestionInput(services, prompt);
    if (revision) {
      if (services.session.getState().running) {
        services.session.enqueue(revision.modelPrompt, {
          displayPrompt: revision.displayPrompt,
        });
      } else {
        await services.session.submit(revision.modelPrompt, {
          displayPrompt: revision.displayPrompt,
        });
      }
      return;
    }
    if (services.session.getState().running) {
      services.session.enqueue(prompt);
    } else {
      await services.session.submit(prompt);
    }
  }

  /** Focused multi-line → native draft; else chat (never dual-scroll). */
  function onComposerWheel(event: MouseEvent): void {
    if (props.inputSuspended || !event.scroll || overlay.kind !== "none") return;
    const editor = editorRef.current;
    const visible = resolveComposerTextRows(contentRows, props.height);
    if (shouldOwnKeyboard && editor) {
      const lines = measureComposerLines(editor, contentRows);
      if (composerOwnsWheel(lines) || composerDraftOverflows(lines, visible)) {
        event.stopPropagation();
        return;
      }
    }
    event.preventDefault();
    event.stopPropagation();
    services.focus.focusRegion("transcript");
    editor?.blur();
    const dy = wheelChatDelta(event.scroll.direction, event.scroll.delta);
    if (dy !== 0) transcriptScrollPort.scrollBy(dy);
  }

  function handleMenuOrComposerKey(key: KeyEvent): void {
    const editor = editorRef.current;
    if (!editor) return;
    const chord = chordFromKeyEvent(key);
    const current = menuRef.current;

    // Esc while a turn runs (or a compaction is in progress): arm the
    // double-Esc cancel via App's shared handler (first press shows "Esc again
    // to cancel", second cancels turn + queue + Responder jobs + compaction).
    // Handled here because OpenTUI can swallow ESC before App's global handler
    // when the textarea owns focus. Ctrl+C stays owned by App.interrupt. Menu
    // open still wins for dismiss-menu.
    if (
      current.kind === "none" &&
      chord === "escape" &&
      (services.session.getState().running ||
        services.session.getState().compacting)
    ) {
      key.preventDefault();
      props.onEscapeCancel?.();
      return;
    }

    if (current.kind !== "none") {
      const itemCount = current.items.length;
      if (chord === "up" && itemCount > 0) {
        const next = (selectedRef.current - 1 + itemCount) % itemCount;
        selectedRef.current = next;
        setSelected(next);
        key.preventDefault();
        return;
      }
      if (chord === "down" && itemCount > 0) {
        const next = (selectedRef.current + 1) % itemCount;
        selectedRef.current = next;
        setSelected(next);
        key.preventDefault();
        return;
      }
      if (chord === "enter" && current.kind === "slash") {
        runSlashCompletion(selectedRef.current);
        key.preventDefault();
        return;
      }
      if (
        chord === "tab" &&
        current.kind === "slash" &&
        acceptedSlashRef.current
      ) {
        key.preventDefault();
        return;
      }
      if (chord === "tab" || chord === "enter") {
        if (current.kind === "mention") {
          const item = current.items[selectedRef.current];
          if (item?.isDir) {
            // Tab drills into the folder; Enter attaches the whole folder.
            acceptSuggestion(
              chord === "tab" ? { drillDir: true } : { attachDir: true },
            );
          } else {
            acceptSuggestion();
          }
        } else {
          acceptSuggestion();
        }
        key.preventDefault();
        return;
      }
      if (chord === "escape") {
        resetMenuState();
        key.preventDefault();
        return;
      }
    }

    if (chord === "ctrl+j") {
      key.preventDefault();
      services.overlay.openJobs();
      return;
    }
    // Clear draft: ^Q. Ctrl+U deletes the line in the textarea (Cmd+Backspace
    // often arrives as Ctrl+U). Empty draft → jump chat to top.
    if (chord === "ctrl+u") {
      if (editor.plainText.length === 0) {
        key.preventDefault();
        transcriptScrollPort.scrollToTop();
        notify(services, "Chat · top · ^U", { key: "scroll", durationMs: 1200 });
      }
      // Non-empty: let OpenTUI handle line kill (do not preventDefault).
      return;
    }
    if (chord === "ctrl+x") {
      key.preventDefault();
      void draftActions.cut();
      return;
    }
    if (chord === "ctrl+q") {
      key.preventDefault();
      if (editor.plainText.length > 0) {
        draftActions.clear(editor);
        notify(services, "Draft cleared · ^Q", { key: "draft", durationMs: 1400 });
      }
      return;
    }
    // Page keys always scroll the chat (classic parity) — never history.
    // ^D scroll-to-bottom is global; ^U is line-delete here (empty → top).
    if (chord === "pageup" || chord === "pagedown") {
      key.preventDefault();
      services.focus.focusRegion("transcript");
      editor.blur();
      const page = 10;
      transcriptScrollPort.scrollBy(chord === "pageup" ? -page : page);
      return;
    }

    // ↑/↓ at line boundary → prompt history (classic). Rapid trackpad bursts
    // still scroll chat; wheel uses onComposerWheel. PageUp/Down scroll chat.
    // Never when a completion menu is open (ref-checked above).
    if (chord === "up" || chord === "down") {
      const now = Date.now();
      if (now - arrowBurst.current.lastAt <= ARROW_BURST_WINDOW_MS) {
        arrowBurst.current.count += 1;
      } else {
        arrowBurst.current.count = 0;
      }
      arrowBurst.current.lastAt = now;

      const intent = resolveArrowIntent({
        chord,
        plainText: editor.plainText,
        line: editor.logicalCursor.row,
        lineCount: editor.lineCount,
        menuOpen: menuKindRef.current !== "none",
        isBrowsingHistory: promptHistory.current.isBrowsing(),
        burstCount: arrowBurst.current.count,
      });

      if (intent === "scroll-chat") {
        key.preventDefault();
        services.focus.focusRegion("transcript");
        editor.blur();
        transcriptScrollPort.scrollBy(chord === "up" ? -3 : 3);
        return;
      }

      if (intent === "history") {
        const recalled =
          chord === "up"
            ? promptHistory.current.prev(editor.plainText)
            : promptHistory.current.next();
        if (recalled !== undefined) {
          key.preventDefault();
          editor.setText(recalled);
          editor.gotoBufferEnd();
          refreshMenu();
          syncContentRows();
        }
      }
    }
  }

  function onKeyDown(key: KeyEvent): void {
    if (props.inputSuspended) return;
    // Only handle when the composer actually owns input — never steal from
    // transcript scroll by force-focusing on every key event. (Menu keys are
    // also routed from the global useKeyboard when focus glitches.)
    if (!shouldOwnKeyboard && menuKindRef.current === "none") return;
    handleMenuOrComposerKey(key);
  }

  // Re-measure once immediately and once after native layout on resize.
  useEffect(() => {
    syncContentRows();
    const frame = requestAnimationFrame(syncContentRows);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- width-only reflow
  }, [props.width]);

  const inputWidth = Math.max(20, props.width);
  const textRows = resolveComposerTextRows(contentRows, props.height);
  const boxHeight = textRows + 2;
  const metaShown = clipComposerMeta(metaLabel, inputWidth);
  // Focused: bright aqua. Blurred: muted so focus shift is obvious.
  const chromeFg = shouldOwnKeyboard ? theme.inputBorder : theme.muted;

  function focusComposer(): boolean {
    if (props.inputSuspended) return false;
    services.focus.focusRegion("composer");
    editorRef.current?.focus();
    return true;
  }

  const resetMenuState = (): void => {
    menuRef.current = { kind: "none" };
    menuKindRef.current = "none";
    acceptedSlashRef.current = undefined;
    setMenu({ kind: "none" });
    setAcceptedSlash(undefined);
  };

  const draftActions = useDraftActions({
    editorRef,
    services,
    expandPastes: (text) => pasteRegistry.current.expand(text),
    resetRegistries: () => {
      pasteRegistry.current.clear();
      promptHistory.current.reset();
    },
    resetMenuState,
    setContentRows,
    clearPasteChips: () => setPasteChips([]),
    focusComposer,
    refreshMenu,
    syncContentRows,
    notify: (message, durationMs) =>
      notify(services, message, { key: "draft", durationMs }),
  });
  const clearDraftState = draftActions.clear;

  function hoverCompletion(index: number): void {
    selectedRef.current = index;
    setSelected(index);
    focusComposer();
  }

  function activateCompletion(index: number): void {
    focusComposer();
    const current = menuRef.current;
    if (current.kind === "none") return;
    if (current.kind === "slash") {
      runSlashCompletion(index);
      return;
    }
    if (current.items[index]?.isDir) {
      acceptSuggestion({ index, drillDir: true });
      return;
    }
    acceptSuggestion({ index });
  }

  return (
    <box
      style={{ flexDirection: "column", width: "100%", flexShrink: 0 }}
      onMouseScroll={onComposerWheel}
    >
      <CompletionMenuView
        menu={menu}
        selected={selected}
        theme={theme}
        width={inputWidth}
        maxRows={props.maxSuggestions ?? 10}
        onHoverIndex={hoverCompletion}
        onActivateIndex={activateCompletion}
      />
      <PasteChipRow
        entries={pasteChips}
        theme={theme}
        width={inputWidth}
        onExpand={expandPasteChip}
      />

      <ComposerInputBox
        theme={theme}
        editorRef={editorRef}
        focused={shouldOwnKeyboard}
        running={props.running}
        width={inputWidth}
        boxHeight={boxHeight}
        metaShown={metaShown}
        chromeFg={chromeFg}
        keyBindings={textareaKeyBindings}
        onMouseDown={focusComposer}
        onMouseScroll={onComposerWheel}
        onSubmit={submit}
        onContentChange={() => {
          refreshMenu();
          queueMicrotask(syncContentRows);
        }}
        onCursorChange={() => {
          refreshMenu();
          syncContentRows();
        }}
        onKeyDown={onKeyDown}
      />
    </box>
  );
}
